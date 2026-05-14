const { createHash } = require('crypto');
const axios = require('axios');
const prisma = require('../config/database');
const { hasGeminiApiKey, generateTailoredResume, scoreResumeAgainstJob } = require('../services/geminiService');
const { uploadToCloudinary } = require('../services/cloudinaryService');

const JSEARCH_HOST = 'jsearch.p.rapidapi.com';
const JSEARCH_URL = `https://${JSEARCH_HOST}/search`;
const STOP_WORDS = new Set(['and', 'the', 'for', 'with', 'from', 'role', 'years', 'year']);
const GENERIC_ROLE_TOKENS = new Set([
  'developer',
  'engineer',
  'consultant',
  'specialist',
  'analyst',
  'architect',
  'manager',
  'lead',
  'senior',
  'junior',
  'software',
  'full',
  'stack',
  'backend',
  'frontend',
]);
const DEFAULT_SEARCH_DAYS = 1;
const MAX_SEARCH_DAYS = 365;
const INITIAL_STREAM_JOB_DELAY_MS = 120;
const STREAM_JOB_DELAY_MS = 35;
const SLOW_STREAM_JOB_COUNT = 6;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const MATCH_SCORE_THRESHOLD = 60;
const GEMINI_MATCH_PROVIDER = 'gemini';
const GEMINI_MATCH_CONCURRENCY = 2;
const LISTING_META_KEY = '__innogarageMeta';
const TAILORED_RESUME_META_KEY = '__innogarageTailoredResume';
const APPLIED_SOURCE_YOUR_JOBS = 'YOUR_JOBS';
const APPLICATION_STATUS_LEGACY_APPLIED = 'APPLIED';
const APPLICATION_STATUS_MENTOR_APPLIED = 'mentor applied';
const APPLICATION_STATUS_STUDENT_APPLIED = 'student applied';
const APPLICATION_STATUS_STUDENT_ACTION_REQUIRED = 'student action required';
const APPLICATION_VISIBLE_STATUSES = [
  APPLICATION_STATUS_MENTOR_APPLIED,
  APPLICATION_STATUS_STUDENT_APPLIED,
  APPLICATION_STATUS_LEGACY_APPLIED,
];
const APPLICATION_ADMIN_UPDATE_STATUSES = [
  APPLICATION_STATUS_MENTOR_APPLIED,
  APPLICATION_STATUS_STUDENT_ACTION_REQUIRED,
];
const MATCH_STOP_WORDS = new Set([
  ...STOP_WORDS,
  'this',
  'that',
  'will',
  'have',
  'your',
  'you',
  'our',
  'are',
  'job',
  'work',
  'team',
  'using',
  'ability',
  'required',
  'requirements',
  'responsibilities',
  'skills',
  'experience',
  'description',
  'candidate',
  'company',
  'position',
  'opportunity',
]);

const toArray = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value).split(/[,|\n]/).map((item) => item.trim()).filter(Boolean);
};

const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const normalizeApplicationStatus = (status, appliedById = null) => {
  const normalized = compact(status).replace(/[_-]+/g, ' ').toLowerCase();

  if (normalized === APPLICATION_STATUS_MENTOR_APPLIED) return APPLICATION_STATUS_MENTOR_APPLIED;
  if (normalized === APPLICATION_STATUS_STUDENT_APPLIED) return APPLICATION_STATUS_STUDENT_APPLIED;
  if (normalized === APPLICATION_STATUS_STUDENT_ACTION_REQUIRED) return APPLICATION_STATUS_STUDENT_ACTION_REQUIRED;
  if (normalized === 'applied') {
    return appliedById ? APPLICATION_STATUS_MENTOR_APPLIED : APPLICATION_STATUS_STUDENT_APPLIED;
  }

  return appliedById ? APPLICATION_STATUS_MENTOR_APPLIED : APPLICATION_STATUS_STUDENT_APPLIED;
};

const isStudentActionRequiredStatus = (status) => (
  normalizeApplicationStatus(status) === APPLICATION_STATUS_STUDENT_ACTION_REQUIRED
);

const buildVisibleApplicationsWhere = (userId, statusQuery = '') => {
  const hasStatusQuery = Boolean(compact(statusQuery));
  const statusKey = compact(statusQuery).replace(/[_-]+/g, ' ').toLowerCase();
  const normalizedStatus = hasStatusQuery && statusKey !== 'applied'
    ? normalizeApplicationStatus(statusQuery)
    : '';

  if (normalizedStatus === APPLICATION_STATUS_STUDENT_ACTION_REQUIRED) {
    return null;
  }

  if (normalizedStatus && APPLICATION_VISIBLE_STATUSES.includes(normalizedStatus)) {
    return { userId, status: normalizedStatus };
  }

  return {
    userId,
    status: { in: APPLICATION_VISIBLE_STATUSES },
  };
};

const parsePostedDateTime = (value) => {
  const normalized = compact(value).toLowerCase();
  if (!normalized) return null;

  const directTime = new Date(value).getTime();
  if (Number.isFinite(directTime)) return directTime;

  if (normalized === 'today' || normalized === 'just now' || normalized === 'just posted') {
    return Date.now();
  }

  if (normalized === 'yesterday') {
    return Date.now() - DAY_MS;
  }

  const relativeMatch = normalized.match(/(\d+)\s*\+?\s*(minute|min|hour|hr|day|week|month)s?\s*ago/);
  if (!relativeMatch) return null;

  const amount = Number(relativeMatch[1]);
  if (!Number.isFinite(amount)) return null;

  const unit = relativeMatch[2];
  const unitMs = unit === 'minute' || unit === 'min'
    ? MINUTE_MS
    : unit === 'hour' || unit === 'hr'
      ? HOUR_MS
      : unit === 'day'
        ? DAY_MS
        : unit === 'week'
          ? WEEK_MS
          : MONTH_MS;

  return Date.now() - (amount * unitMs);
};

const getRapidApiKey = () => compact(process.env.RAPIDAPI_KEY);

const createSearchError = (message, statusCode = 502) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const getRapidApiError = (error) => {
  const status = error.response?.status;
  const data = error.response?.data;
  const detail = typeof data === 'string'
    ? data
    : data?.message || data?.error || data?.detail || data?.errors?.[0]?.message || error.message;

  if (status === 401 || status === 403) {
    return {
      fatal: true,
      statusCode: 502,
      message: `Job search provider rejected the request. Check RapidAPI JSearch subscription/key. ${detail || ''}`.trim(),
      status,
      detail,
    };
  }

  if (status === 429) {
    return {
      fatal: true,
      statusCode: 429,
      message: `RapidAPI job search limit reached. ${detail || ''}`.trim(),
      status,
      detail,
    };
  }

  if (error.code === 'ECONNABORTED') {
    return {
      fatal: false,
      statusCode: 504,
      message: 'Job search provider timed out. Please try again.',
      status,
      detail,
    };
  }

  return {
    fatal: false,
    statusCode: 502,
    message: `Job search provider error${status ? ` (${status})` : ''}. ${detail || ''}`.trim(),
    status,
    detail,
  };
};

const buildQuery = (profile) => {
  const role = compact(profile.jobRole);
  const experience = compact(profile.experience);
  const location = compact(profile.location);
  const skills = toArray(profile.keySkills).slice(0, 5).join(' ');

  return [role, experience, skills, location]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const buildSearchQueries = (profile) => {
  const role = compact(profile.jobRole);
  const location = compact(profile.location);
  const skills = toArray(profile.keySkills).map(compact).filter(Boolean);
  const baseRole = role || skills.slice(0, 2).join(' ');
  const skillSnippet = skills.slice(0, 2).join(' ');

  return [...new Set([
    [baseRole, location].filter(Boolean).join(' '),
    [baseRole, skillSnippet, location].filter(Boolean).join(' '),
    [baseRole, skillSnippet].filter(Boolean).join(' '),
    baseRole,
  ].map(compact).filter(Boolean))];
};

const LOCATION_ALIASES = {
  usa: ['usa', 'us', 'united states', 'united states of america', 'america'],
  canada: ['canada'],
  india: ['india'],
};

const normalizePostedDate = (job) => {
  const preferredValue = compact(job.job_posted_human_readable || job.job_posted_at);
  if (preferredValue) return preferredValue;

  if (job.job_posted_at_datetime_utc) {
    const parsedTime = parsePostedDateTime(job.job_posted_at_datetime_utc);
    if (parsedTime !== null) return new Date(parsedTime).toISOString();
    return job.job_posted_at_datetime_utc;
  }

  if (job.job_posted_at_timestamp) {
    return new Date(job.job_posted_at_timestamp * 1000).toISOString();
  }

  return null;
};

const normalizeLocation = (job) => {
  const parts = [job.job_city, job.job_state, job.job_country].filter(Boolean);
  return parts.join(', ') || job.job_location || '';
};

const tokenize = (value) => compact(value)
  .toLowerCase()
  .split(/[^a-z0-9+#.]+/)
  .filter((token) => token && token.length > 1 && !STOP_WORDS.has(token));

const getLocationTerms = (location) => {
  const normalized = compact(location).toLowerCase();
  if (!normalized) return [];
  return [...new Set([normalized, ...(LOCATION_ALIASES[normalized] || [])])];
};

const getExperienceTerms = (experience) => {
  const normalized = compact(experience).toLowerCase();
  if (!normalized) return [];
  if (normalized.includes('10+')) return ['principal', 'architect', 'manager', 'director', 'head'];
  if (normalized.includes('7') || normalized.includes('10')) return ['lead', 'senior', 'principal', 'architect'];
  if (normalized.includes('5')) return ['senior', 'lead', 'consultant'];
  if (normalized.includes('3')) return ['mid', 'senior', 'developer'];
  if (normalized.includes('2')) return ['associate', 'junior', 'developer'];
  return ['intern', 'entry', 'junior', 'associate'];
};

const getAnchorRoleTokens = (jobRole) => {
  const roleTokens = tokenize(jobRole);
  const anchorTokens = roleTokens.filter((token) => !GENERIC_ROLE_TOKENS.has(token));
  return anchorTokens.length > 0 ? anchorTokens : roleTokens;
};

const buildSkillKeywords = (skills) => {
  const skillPhrases = [];
  const skillTokens = [];

  toArray(skills).slice(0, 5).forEach((skill) => {
    const phrase = compact(skill).toLowerCase();
    if (phrase) skillPhrases.push(phrase);

    tokenize(skill)
      .filter((token) => !GENERIC_ROLE_TOKENS.has(token))
      .forEach((token) => skillTokens.push(token));
  });

  return {
    skillPhrases: [...new Set(skillPhrases)],
    skillTokens: [...new Set(skillTokens)],
  };
};

const rankJobs = (rawJobs, profile) => {
  const rolePhrase = compact(profile.jobRole).toLowerCase();
  const roleTokens = tokenize(profile.jobRole);
  const anchorRoleTokens = getAnchorRoleTokens(profile.jobRole);
  const genericRoleTokens = roleTokens.filter((token) => GENERIC_ROLE_TOKENS.has(token));
  const { skillPhrases, skillTokens } = buildSkillKeywords(profile.keySkills);
  const locationTerms = getLocationTerms(profile.location);
  const experienceTerms = getExperienceTerms(profile.experience);

  const scoredJobs = rawJobs
    .map((job) => {
      const title = compact(job.job_title).toLowerCase();
      const searchText = compact([
        job.job_title,
        job.job_description,
        job.employer_name,
        normalizeLocation(job),
      ].join(' ')).toLowerCase();
      const titleTokens = new Set(tokenize(job.job_title));
      const searchTokens = new Set(tokenize(searchText));
      const exactRoleMatch = rolePhrase && (title.includes(rolePhrase) || searchText.includes(rolePhrase));
      const titleAnchorMatches = anchorRoleTokens.filter((token) => titleTokens.has(token)).length;
      const textAnchorMatches = anchorRoleTokens.filter((token) => searchTokens.has(token)).length;
      const titleGenericMatches = genericRoleTokens.filter((token) => titleTokens.has(token)).length;
      const skillPhraseMatches = skillPhrases.filter((skill) => searchText.includes(skill)).length;
      const skillTokenMatches = skillTokens.filter((token) => searchTokens.has(token)).length;
      const locationMatches = locationTerms.filter((term) => searchText.includes(term)).length;
      const experienceMatches = experienceTerms.filter((term) => searchTokens.has(term)).length;
      const relevanceScore = (exactRoleMatch ? 8 : 0)
        + (titleAnchorMatches * 4)
        + (textAnchorMatches * 2)
        + titleGenericMatches
        + (skillPhraseMatches * 3)
        + skillTokenMatches
        + (locationMatches ? 2 : 0)
        + (experienceMatches ? 1 : 0);

      return {
        job,
        relevanceScore,
        isRelevant: Boolean(
          exactRoleMatch
          || titleAnchorMatches > 0
          || textAnchorMatches >= 2
          || skillPhraseMatches > 0
          || skillTokenMatches >= 2
        ),
      };
    });

  const relevantJobs = scoredJobs
    .filter((item) => item.isRelevant)
    .sort((left, right) => right.relevanceScore - left.relevanceScore);

  if (relevantJobs.length > 0) {
    return relevantJobs.map((item) => item.job);
  }

  return scoredJobs
    .filter((item) => item.relevanceScore >= 3)
    .sort((left, right) => right.relevanceScore - left.relevanceScore)
    .map((item) => item.job);
};

const normalizeJob = (job) => {
  const applyLink = job.job_apply_link || job.job_google_link || '';
  return {
    id: job.job_id || applyLink || `${job.employer_name || 'company'}-${job.job_title || 'job'}`,
    externalId: job.job_id || null,
    title: job.job_title || 'Untitled role',
    company: job.employer_name || 'Unknown company',
    datePosted: normalizePostedDate(job),
    applyLink,
    location: normalizeLocation(job),
    jobDescription: job.job_description || '',
    employmentType: job.job_employment_type || '',
    publisher: job.job_publisher || '',
    rawPayload: job,
  };
};

const normalizeObject = (value) => (
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}
);

const getListingMeta = (rawPayload) => normalizeObject(normalizeObject(rawPayload)[LISTING_META_KEY]);

const getListingAppliedSource = (rawPayload) => compact(getListingMeta(rawPayload).appliedSource).toUpperCase();

const mergeListingPayload = (jobPayload, existingRawPayload, metaPatch = {}) => {
  const basePayload = normalizeObject(jobPayload);
  const existingMeta = getListingMeta(existingRawPayload);
  const nextMeta = Object.entries({ ...existingMeta, ...metaPatch }).reduce((accumulator, [key, value]) => {
    if (value !== undefined) accumulator[key] = value;
    return accumulator;
  }, {});

  if (Object.keys(nextMeta).length === 0) {
    return Object.keys(basePayload).length > 0 ? basePayload : null;
  }

  return {
    ...basePayload,
    [LISTING_META_KEY]: nextMeta,
  };
};

const isGeminiMatchProvider = (value) => compact(value).toLowerCase() === GEMINI_MATCH_PROVIDER;

const hasGeminiStoredYourJob = (listing) => isGeminiMatchProvider(listing?.yourJob?.matchProvider);

const buildPersistedYourJobsWhere = (userId) => ({
  userId,
  matchProvider: GEMINI_MATCH_PROVIDER,
});

const isYourJobsAppliedListing = (listing) => Boolean(listing?.isApplied)
  && getListingAppliedSource(listing.rawPayload) === APPLIED_SOURCE_YOUR_JOBS;

const toPostedAtDate = (value) => {
  const time = parsePostedDateTime(value);
  if (!Number.isFinite(time) || time <= 0) return null;
  return new Date(time);
};

const serializeListing = (listing) => {
  const datePosted = compact(listing.datePostedText || listing.postedAt?.toISOString() || '') || null;
  const savedAt = listing.lastSeenAt?.toISOString() || listing.updatedAt?.toISOString() || listing.createdAt?.toISOString() || null;
  const listingMeta = getListingMeta(listing.rawPayload);
  const viewedAt = compact(listingMeta.viewedAt) || null;

  return {
    id: listing.sourceJobId || listing.id,
    externalId: listing.sourceJobId || null,
    title: listing.title,
    company: listing.company,
    location: listing.location || '',
    datePosted,
    applyLink: listing.applyLink,
    isViewed: Boolean(viewedAt),
    viewedAt,
    isApplied: Boolean(listing.isApplied),
    appliedAt: listing.appliedAt?.toISOString() || null,
    savedAt,
    source: listing.source,
    job_id: listing.sourceJobId || listing.id,
    job_title: listing.title,
    employer_name: listing.company,
    job_location: listing.location || '',
    job_apply_link: listing.applyLink,
    job_posted_at: datePosted,
    saved_at: savedAt,
  };
};

const buildListingWriteData = (job, now = new Date(), existingRawPayload = null) => ({
  sourceJobId: compact(job.externalId || job.id) || null,
  title: compact(job.title) || 'Untitled role',
  company: compact(job.company) || 'Unknown company',
  location: compact(job.location) || null,
  datePostedText: compact(job.datePosted) || null,
  postedAt: toPostedAtDate(job.datePosted),
  applyLink: job.applyLink,
  source: 'JSEARCH',
  rawPayload: mergeListingPayload(job.rawPayload || job, existingRawPayload),
  lastSeenAt: now,
});

const persistJobListing = async (userId, job, now = new Date()) => {
  if (!job?.applyLink) return null;

  const existingListing = await prisma.userJobListing.findUnique({
    where: {
      userId_applyLink: {
        userId,
        applyLink: job.applyLink,
      },
    },
    select: {
      rawPayload: true,
    },
  });

  const listing = await prisma.userJobListing.upsert({
    where: {
      userId_applyLink: {
        userId,
        applyLink: job.applyLink,
      },
    },
    create: {
      userId,
      ...buildListingWriteData(job, now, existingListing?.rawPayload || null),
      firstSeenAt: now,
    },
    update: buildListingWriteData(job, now, existingListing?.rawPayload || null),
  });

  return listing;
};

const persistJobListings = async (userId, jobs = []) => {
  const validJobs = jobs.filter((job) => job?.applyLink);
  if (validJobs.length === 0) return [];

  const now = new Date();
  const existingListings = await prisma.userJobListing.findMany({
    where: {
      userId,
      applyLink: {
        in: validJobs.map((job) => job.applyLink),
      },
    },
    select: {
      applyLink: true,
      rawPayload: true,
    },
  });
  const existingPayloadByLink = new Map(existingListings.map((listing) => [listing.applyLink, listing.rawPayload]));

  const listings = await prisma.$transaction(
    validJobs.map((job) => prisma.userJobListing.upsert({
      where: {
        userId_applyLink: {
          userId,
          applyLink: job.applyLink,
        },
      },
      create: {
        userId,
        ...buildListingWriteData(job, now, existingPayloadByLink.get(job.applyLink) || null),
        firstSeenAt: now,
      },
      update: buildListingWriteData(job, now, existingPayloadByLink.get(job.applyLink) || null),
    }))
  );

  return listings;
};

const getPersistedJobListings = async (userId, { limit } = {}) => {
  const take = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(Number(limit), 200)
    : undefined;
  const listings = await prisma.userJobListing.findMany({
    where: { userId },
    orderBy: [
      { lastSeenAt: 'desc' },
      { postedAt: 'desc' },
      { createdAt: 'desc' },
    ],
    ...(take ? { take } : {}),
  });

  return listings.map(serializeListing);
};

const stringifyStructuredValue = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(stringifyStructuredValue).filter(Boolean).join(' ');
  if (typeof value === 'object') return Object.values(value).map(stringifyStructuredValue).filter(Boolean).join(' ');
  return String(value);
};

const tokenizeMatchText = (value) => compact(value)
  .toLowerCase()
  .split(/[^a-z0-9+#.]+/)
  .filter((token) => token.length > 2 && !MATCH_STOP_WORDS.has(token));

const uniqueValues = (items) => [...new Set(items.map(compact).filter(Boolean))];

const getRawPayload = (listing) => (
  listing.rawPayload && typeof listing.rawPayload === 'object' && !Array.isArray(listing.rawPayload)
    ? listing.rawPayload
    : {}
);

const getRawPayloadWithoutMeta = (listing) => {
  const rawPayload = getRawPayload(listing);
  if (!(LISTING_META_KEY in rawPayload)) return rawPayload;

  const { [LISTING_META_KEY]: _meta, ...payloadWithoutMeta } = rawPayload;
  return payloadWithoutMeta;
};

const buildResumeMatchText = (profile) => compact([
  profile.fullName,
  profile.jobRole,
  profile.experience,
  profile.location,
  profile.education,
  toArray(profile.keySkills).join(' '),
  profile.parsedResumeText,
].join(' '));

const buildJobMatchText = (listing) => {
  const raw = getRawPayload(listing);
  return compact([
    listing.title,
    listing.company,
    listing.location,
    listing.datePostedText,
    raw.job_title,
    raw.employer_name,
    raw.job_location,
    raw.job_city,
    raw.job_state,
    raw.job_country,
    raw.job_employment_type,
    raw.job_description,
    raw.job_required_skills,
    raw.job_highlights,
    raw.description,
    raw.jobDescription,
  ].map(stringifyStructuredValue).join(' '));
};

const getListingDescription = (listing) => {
  const raw = getRawPayload(listing);
  return compact([
    raw.job_description,
    raw.description,
    raw.jobDescription,
    raw.job_highlights,
  ].map(stringifyStructuredValue).join(' '));
};

const buildListingMatchSnapshotHash = (listing) => createHash('sha1')
  .update(JSON.stringify({
    sourceJobId: listing.sourceJobId || null,
    title: compact(listing.title),
    company: compact(listing.company),
    location: compact(listing.location),
    datePostedText: compact(listing.datePostedText),
    applyLink: compact(listing.applyLink),
    description: getListingDescription(listing),
    payload: getRawPayloadWithoutMeta(listing),
  }))
  .digest('hex');

const getListingLastSeenTime = (listing) => [listing.lastSeenAt, listing.updatedAt, listing.createdAt]
  .map((value) => new Date(value || 0).getTime())
  .find((value) => Number.isFinite(value) && value > 0) || 0;

const getTrackedMatchProcessedTime = (sourceListings) => sourceListings.reduce((latestTime, listing) => {
  const processedTime = new Date(getListingMeta(listing.rawPayload).matchProcessedAt || 0).getTime();
  if (!Number.isFinite(processedTime) || processedTime <= 0) return latestTime;
  return Math.max(latestTime, processedTime);
}, 0);

const backfillLegacyYourJobSnapshots = async (sourceListings, persistedJobs) => {
  const trackedProcessedTime = getTrackedMatchProcessedTime(sourceListings);
  const shouldBackfillAll = trackedProcessedTime === 0 && persistedJobs > 0;

  const legacyListings = sourceListings.filter((listing) => {
    const listingMeta = getListingMeta(listing.rawPayload);
    if (compact(listingMeta.matchSnapshotHash)) return false;
    if (shouldBackfillAll) return true;
    if (trackedProcessedTime === 0) return false;
    return getListingLastSeenTime(listing) <= trackedProcessedTime;
  });

  if (legacyListings.length === 0) {
    return sourceListings;
  }

  const processedAt = trackedProcessedTime > 0 ? new Date(trackedProcessedTime) : new Date();
  const updates = await prisma.$transaction(
    legacyListings.map((listing) => {
      const matchSnapshotHash = buildListingMatchSnapshotHash(listing);
      return prisma.userJobListing.update({
        where: { id: listing.id },
        data: {
          rawPayload: mergeListingPayload(
            listing.rawPayload || {},
            listing.rawPayload || null,
            {
              matchSnapshotHash,
              matchProcessedAt: processedAt.toISOString(),
            }
          ),
        },
      });
    })
  );

  const updatesById = new Map(updates.map((listing) => [listing.id, listing.rawPayload]));
  return sourceListings.map((listing) => (
    updatesById.has(listing.id)
      ? { ...listing, rawPayload: updatesById.get(listing.id) }
      : listing
  ));
};

const getPendingYourJobSourceListings = (sourceListings) => sourceListings.filter((listing) => {
  if (listing.yourJob && !hasGeminiStoredYourJob(listing)) {
    return true;
  }

  const listingMeta = getListingMeta(listing.rawPayload);
  return compact(listingMeta.matchSnapshotHash) !== buildListingMatchSnapshotHash(listing);
});

const buildYourJobsRefreshState = (sourceListings) => {
  const pendingSourceListings = getPendingYourJobSourceListings(sourceListings);
  return {
    pendingSourceListings,
    pendingSourceCount: pendingSourceListings.length,
    refreshNeeded: pendingSourceListings.length > 0,
  };
};

const markListingMatchSnapshotProcessed = async (sourceListing, snapshotHash, processedAt = new Date()) => prisma.userJobListing.update({
  where: { id: sourceListing.id },
  data: {
    rawPayload: mergeListingPayload(
      sourceListing.rawPayload || {},
      sourceListing.rawPayload || null,
      {
        matchSnapshotHash: snapshotHash,
        matchProcessedAt: processedAt.toISOString(),
      }
    ),
  },
});

const ensureYourJobsGeminiReady = (profile) => {
  if (!hasGeminiApiKey()) {
    throw createSearchError('Gemini API key is not configured on the backend.', 500);
  }
  if (!compact(profile.parsedResumeText)) {
    throw createSearchError(
      'Please upload your resume before using Your Jobs. Your resume is required for smart matching.',
      400
    );
  }
};

const getProfileYears = (profile) => {
  const values = [profile.experience, profile.parsedResumeText].filter(Boolean).join(' ');
  const matches = [...values.matchAll(/(\d+)\s*\+?\s*(?:years?|yrs?)\b/gi)].map((match) => Number(match[1]));
  return matches.length ? Math.max(...matches.filter(Number.isFinite)) : null;
};

const getJobRequiredYears = (jobText) => {
  const matches = [...jobText.matchAll(/(\d+)\s*\+?\s*(?:years?|yrs?)\b/gi)].map((match) => Number(match[1]));
  return matches.length ? Math.min(...matches.filter(Number.isFinite)) : null;
};

const scoreRoleMatch = ({ profile, jobText, jobTitle }) => {
  const rolePhrase = compact(profile.jobRole).toLowerCase();
  const roleTokens = getAnchorRoleTokens(profile.jobRole);
  const jobTokens = new Set(tokenizeMatchText(`${jobTitle} ${jobText}`));

  if (!rolePhrase && roleTokens.length === 0) return { score: 0, matches: [] };

  const matches = [];
  let score = 0;

  if (rolePhrase && jobText.includes(rolePhrase)) {
    score = 20;
    matches.push(profile.jobRole);
  } else if (roleTokens.length > 0) {
    const matchedTokens = roleTokens.filter((token) => jobTokens.has(token));
    score = Math.round((matchedTokens.length / roleTokens.length) * 18);
    if (matchedTokens.length > 0) matches.push(...matchedTokens);
  }

  return { score: Math.min(score, 20), matches: uniqueValues(matches) };
};

const scoreSkillsMatch = ({ profile, resumeText, jobText }) => {
  const profileSkills = uniqueValues(toArray(profile.keySkills).map((skill) => skill.toLowerCase()));
  const resumeTokens = uniqueValues(tokenizeMatchText(resumeText)).slice(0, 80);
  const fallbackSkills = resumeTokens.filter((token) => token.length >= 4).slice(0, 20);
  const skills = profileSkills.length ? profileSkills : fallbackSkills;

  if (skills.length === 0) return { score: 0, matches: [], missing: [] };

  const jobTokens = new Set(tokenizeMatchText(jobText));
  const matches = skills.filter((skill) => {
    const skillTokens = tokenizeMatchText(skill);
    return jobText.includes(skill) || skillTokens.some((token) => jobTokens.has(token));
  });
  const missing = skills.filter((skill) => !matches.includes(skill));

  return {
    score: Math.min(35, Math.round((matches.length / skills.length) * 35)),
    matches: uniqueValues(matches),
    missing: uniqueValues(missing).slice(0, 8),
  };
};

const scoreSummaryMatch = ({ resumeText, jobText }) => {
  const resumeKeywords = uniqueValues(tokenizeMatchText(resumeText)).slice(0, 60);
  if (resumeKeywords.length === 0) return { score: 0, matches: [] };

  const jobTokens = new Set(tokenizeMatchText(jobText));
  const matches = resumeKeywords.filter((token) => jobTokens.has(token));
  const denominator = Math.min(resumeKeywords.length, 35);

  return {
    score: Math.min(15, Math.round((matches.length / denominator) * 15)),
    matches: matches.slice(0, 10),
  };
};

const scoreExperienceMatch = ({ profile, jobText, jobTitle }) => {
  const profileYears = getProfileYears(profile);
  const requiredYears = getJobRequiredYears(jobText);
  const experienceTerms = getExperienceTerms(profile.experience);
  const jobTokens = new Set(tokenizeMatchText(`${jobTitle} ${jobText}`));
  const termMatches = experienceTerms.filter((term) => jobTokens.has(term));

  if (profileYears !== null && requiredYears !== null) {
    if (profileYears >= requiredYears) return { score: 15, matches: [`${profileYears}+ years`] };
    if (requiredYears - profileYears <= 1) return { score: 12, matches: [`${profileYears} years vs ${requiredYears} requested`] };
    return { score: 6, matches: [] };
  }

  if (termMatches.length > 0) return { score: 12, matches: termMatches };
  if (compact(profile.experience)) return { score: 9, matches: [profile.experience] };
  return { score: 0, matches: [] };
};

const scoreLocationMatch = ({ profile, listing, jobText }) => {
  const profileLocation = compact(profile.location).toLowerCase();
  const jobLocation = compact(listing.location).toLowerCase();
  const combinedJobText = compact(`${jobLocation} ${jobText}`).toLowerCase();

  if (combinedJobText.includes('remote')) return { score: 15, matches: ['Remote'] };
  if (!profileLocation) return { score: 8, matches: [] };
  if (!jobLocation) return { score: 8, matches: [] };

  const locationTerms = getLocationTerms(profileLocation);
  const matchedTerms = locationTerms.filter((term) => combinedJobText.includes(term));
  if (matchedTerms.length > 0) return { score: 15, matches: matchedTerms };

  const profileParts = profileLocation.split(/[,\s]+/).filter((part) => part.length > 2);
  const partialMatches = profileParts.filter((part) => combinedJobText.includes(part));
  if (partialMatches.length > 0) return { score: 10, matches: partialMatches };

  return { score: 4, matches: [] };
};

const getScoreLabel = (score) => {
  if (score >= 85) return 'Excellent match';
  if (score >= 75) return 'Strong match';
  if (score >= MATCH_SCORE_THRESHOLD) return 'Good match';
  return 'Below match threshold';
};

const calculateListingMatch = (profile, listing) => {
  const resumeText = buildResumeMatchText(profile);
  const jobTextRaw = buildJobMatchText(listing);
  const jobText = jobTextRaw.toLowerCase();
  const jobTitle = compact(listing.title).toLowerCase();

  const roleMatch = scoreRoleMatch({ profile, jobText, jobTitle });
  const skillsMatch = scoreSkillsMatch({ profile, resumeText, jobText });
  const summaryMatch = scoreSummaryMatch({ resumeText, jobText });
  const experienceMatch = scoreExperienceMatch({ profile, jobText, jobTitle });
  const locationMatch = scoreLocationMatch({ profile, listing, jobText });
  const score = Math.min(100, roleMatch.score + skillsMatch.score + summaryMatch.score + experienceMatch.score + locationMatch.score);

  return {
    score,
    label: getScoreLabel(score),
    breakdown: {
      summary: summaryMatch.score,
      skills: skillsMatch.score,
      experience: experienceMatch.score,
      role: roleMatch.score,
      location: locationMatch.score,
    },
    strongMatches: uniqueValues([
      ...roleMatch.matches,
      ...skillsMatch.matches,
      ...summaryMatch.matches.slice(0, 4),
      ...experienceMatch.matches,
      ...locationMatch.matches,
    ]).slice(0, 10),
    missingSkills: skillsMatch.missing,
    descriptionAvailable: Boolean(getListingDescription(listing)),
  };
};

const serializeYourJobListing = (listing, match) => {
  const raw = getRawPayload(listing);
  const postedAt = listing.postedAt?.toISOString() || null;
  const appliedAt = listing.appliedAt?.toISOString() || null;
  const firstSeenAt = listing.firstSeenAt?.toISOString() || null;
  const lastSeenAt = listing.lastSeenAt?.toISOString() || null;
  const createdAt = listing.createdAt?.toISOString() || null;
  const updatedAt = listing.updatedAt?.toISOString() || null;
  const jobDescription = getListingDescription(listing);

  return {
    id: listing.id,
    userId: listing.userId,
    sourceJobId: listing.sourceJobId,
    title: listing.title,
    company: listing.company,
    location: listing.location || '',
    datePostedText: listing.datePostedText,
    postedAt,
    applyLink: listing.applyLink,
    source: listing.source,
    rawPayload: listing.rawPayload,
    isApplied: Boolean(listing.isApplied),
    appliedAt,
    appliedById: listing.appliedById,
    firstSeenAt,
    lastSeenAt,
    createdAt,
    updatedAt,
    jobDescription,
    employmentType: raw.job_employment_type || raw.employmentType || null,
    publisher: raw.job_publisher || raw.publisher || null,
    matchingScore: match.score,
    matchScore: match.score,
    match_score: match.score,
    matchLabel: match.label,
    matchProvider: match.provider || 'fallback',
    matchModel: match.model || null,
    matchSummary: match.summary || null,
    matchWarning: match.warning || null,
    matchBreakdown: match.breakdown,
    strongMatches: match.strongMatches,
    missingSkills: match.missingSkills,
    descriptionAvailable: match.descriptionAvailable,
  };
};

const geminiMatchCache = new Map();

const hashText = (value) => createHash('sha1').update(String(value || '')).digest('hex');

const normalizeDocumentText = (value) => String(value || '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim();

const buildGeminiCacheKey = (profile, listing, resumeText, jobDescription) => [
  profile.id,
  listing.id,
  listing.updatedAt?.toISOString() || '',
  hashText(resumeText),
  hashText(jobDescription),
].join(':');

const buildFallbackSummary = (profile, listing, fallbackMatch, reason = '') => {
  const summaryParts = [];

  if (reason) {
    summaryParts.push(reason);
  }

  if (fallbackMatch.strongMatches.length > 0) {
    summaryParts.push(`Top overlap: ${fallbackMatch.strongMatches.slice(0, 4).join(', ')}.`);
  }

  if (fallbackMatch.missingSkills.length > 0) {
    summaryParts.push(`Missing focus areas: ${fallbackMatch.missingSkills.slice(0, 4).join(', ')}.`);
  }

  if (!summaryParts.length) {
    summaryParts.push(`Fallback score for ${compact(profile.jobRole || profile.fullName || 'candidate')} against ${compact(listing.title || 'this job')}.`);
  }

  return compact(summaryParts.join(' '));
};

const buildGeminiProfileContext = (profile) => ({
  fullName: profile.fullName || '',
  education: profile.education || '',
  experience: profile.experience || '',
  jobRole: profile.jobRole || '',
  location: profile.location || '',
  keySkills: toArray(profile.keySkills),
});

const buildGeminiJobContext = (listing) => {
  const raw = getRawPayload(listing);
  return {
    title: listing.title,
    company: listing.company,
    location: listing.location || '',
    datePostedText: listing.datePostedText || '',
    employmentType: raw.job_employment_type || raw.employmentType || '',
    source: listing.source,
    publisher: raw.job_publisher || raw.publisher || '',
  };
};

const createFallbackMatch = (profile, listing, reason = '') => {
  const fallbackMatch = calculateListingMatch(profile, listing);
  return {
    ...fallbackMatch,
    provider: 'fallback',
    model: null,
    summary: buildFallbackSummary(profile, listing, fallbackMatch, reason),
    warning: reason || null,
  };
};

const calculateListingMatchWithGemini = async (profile, listing) => {
  ensureYourJobsGeminiReady(profile);

  const resumeText = buildResumeMatchText(profile);
  const jobDescription = getListingDescription(listing) || buildJobMatchText(listing);

  if (!resumeText || !jobDescription) {
    throw createSearchError('Resume content and job content are required for Gemini smart matching.', 400);
  }

  const cacheKey = buildGeminiCacheKey(profile, listing, resumeText, jobDescription);
  const cachedMatch = geminiMatchCache.get(cacheKey);
  if (cachedMatch) {
    return cachedMatch;
  }

  try {
    const geminiMatch = await scoreResumeAgainstJob({
      resumeText,
      jobDescription,
      profileContext: buildGeminiProfileContext(profile),
      jobContext: buildGeminiJobContext(listing),
    });

    const resolvedMatch = {
      ...geminiMatch,
      descriptionAvailable: Boolean(getListingDescription(listing)),
      warning: null,
    };

    // Evict oldest entry when cache is full to prevent unbounded growth.
    if (geminiMatchCache.size >= 500) {
      geminiMatchCache.delete(geminiMatchCache.keys().next().value);
    }
    geminiMatchCache.set(cacheKey, resolvedMatch);
    return resolvedMatch;
  } catch (error) {
    console.error('Gemini job scoring failed', {
      listingId: listing.id,
      title: listing.title,
      message: error.message,
    });
    throw createSearchError(error.message || 'Gemini could not score this job right now.', 502);
  }
};

const normalizeJsonObject = (value) => (
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}
);

const getTailoredResumeMeta = (rawPayload) => normalizeJsonObject(normalizeJsonObject(rawPayload)[TAILORED_RESUME_META_KEY]);

const serializeTailoredResumeMeta = (meta = {}, includeText = false) => {
  const resumeText = String(meta.resumeText || '').trim();
  const payload = {
    generated: Boolean(resumeText),
    generatedAt: meta.generatedAt || null,
    cloudinaryUrl: meta.cloudinaryUrl || null,
    cloudinaryPublicId: meta.cloudinaryPublicId || null,
    headline: compact(meta.headline),
    candidateName: compact(meta.candidateName),
    jobTitle: compact(meta.jobTitle),
    company: compact(meta.company),
    provider: compact(meta.provider),
    model: compact(meta.model),
    changeSummary: Array.isArray(meta.changeSummary) ? meta.changeSummary.map(compact).filter(Boolean) : [],
    warning: compact(meta.warning) || null,
  };

  if (includeText) {
    payload.resumeText = resumeText;
  }

  return payload;
};

const mergeTailoredResumeMeta = (rawPayload, resumeMeta) => ({
  ...normalizeJsonObject(rawPayload),
  [TAILORED_RESUME_META_KEY]: resumeMeta,
});

const getPublicYourJobRawPayload = (rawPayload) => {
  const payload = normalizeJsonObject(rawPayload);
  const { [TAILORED_RESUME_META_KEY]: _tailoredResume, ...publicPayload } = payload;
  return Object.keys(publicPayload).length > 0 ? publicPayload : null;
};

const normalizeJsonStringArray = (value) => (
  Array.isArray(value)
    ? value.map((item) => compact(item)).filter(Boolean)
    : []
);

const buildYourJobWriteData = (sourceListing, match, now = new Date()) => ({
  sourceJobId: sourceListing.sourceJobId || null,
  title: sourceListing.title,
  company: sourceListing.company,
  location: sourceListing.location || null,
  datePostedText: sourceListing.datePostedText || null,
  postedAt: sourceListing.postedAt || null,
  applyLink: sourceListing.applyLink,
  source: sourceListing.source,
  rawPayload: sourceListing.rawPayload,
  matchingScore: match.score,
  matchLabel: match.label,
  matchProvider: match.provider || 'fallback',
  matchModel: match.model || null,
  matchSummary: match.summary || null,
  matchWarning: match.warning || null,
  matchBreakdown: match.breakdown || {},
  strongMatches: match.strongMatches || [],
  missingSkills: match.missingSkills || [],
  matchedAt: now,
});

const getYourJobInclude = () => ({
  sourceListing: {
    select: {
      id: true,
      userId: true,
      sourceJobId: true,
      title: true,
      company: true,
      location: true,
      datePostedText: true,
      postedAt: true,
      applyLink: true,
      source: true,
      rawPayload: true,
      isApplied: true,
      appliedAt: true,
      appliedById: true,
      firstSeenAt: true,
      lastSeenAt: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  application: {
    select: {
      id: true,
      status: true,
      appliedAt: true,
      appliedById: true,
    },
  },
});

const serializeStoredYourJob = (yourJob, { includeRawPayload = true, includeDescription = true } = {}) => {
  const sourceListing = yourJob.sourceListing || null;
  const application = yourJob.application || null;
  const applicationStatus = application
    ? normalizeApplicationStatus(application.status, application.appliedById)
    : sourceListing?.isApplied
      ? normalizeApplicationStatus(null, sourceListing?.appliedById)
      : null;
  const requiresStudentAction = applicationStatus === APPLICATION_STATUS_STUDENT_ACTION_REQUIRED;
  const appliedAt = application?.appliedAt || sourceListing?.appliedAt || null;
  const appliedById = application?.appliedById || sourceListing?.appliedById || null;
  const storedRawPayload = yourJob.rawPayload || sourceListing?.rawPayload || null;
  const rawPayload = includeRawPayload ? getPublicYourJobRawPayload(storedRawPayload) : null;
  const listingForDescription = sourceListing || {
    title: yourJob.title,
    company: yourJob.company,
    location: yourJob.location,
    datePostedText: yourJob.datePostedText,
    rawPayload: storedRawPayload,
  };
  const jobDescription = includeDescription ? getListingDescription(listingForDescription) : '';

  return {
    id: yourJob.id,
    userId: yourJob.userId,
    sourceListingId: yourJob.sourceListingId,
    sourceJobId: yourJob.sourceJobId || null,
    title: yourJob.title,
    company: yourJob.company,
    location: yourJob.location || '',
    datePostedText: yourJob.datePostedText || null,
    postedAt: yourJob.postedAt?.toISOString() || null,
    applyLink: yourJob.applyLink,
    source: yourJob.source,
    rawPayload,
    isApplied: Boolean(sourceListing?.isApplied) && !requiresStudentAction,
    appliedAt: appliedAt?.toISOString() || null,
    appliedById,
    applicationId: application?.id || null,
    applicationStatus,
    requiresStudentAction,
    firstSeenAt: sourceListing?.firstSeenAt?.toISOString() || null,
    lastSeenAt: sourceListing?.lastSeenAt?.toISOString() || null,
    createdAt: yourJob.createdAt?.toISOString() || null,
    updatedAt: yourJob.updatedAt?.toISOString() || null,
    matchedAt: yourJob.matchedAt?.toISOString() || null,
    jobDescription,
    matchingScore: yourJob.matchingScore,
    matchScore: yourJob.matchingScore,
    match_score: yourJob.matchingScore,
    matchLabel: yourJob.matchLabel,
    matchProvider: yourJob.matchProvider || 'fallback',
    matchModel: yourJob.matchModel || null,
    matchSummary: yourJob.matchSummary || null,
    matchWarning: yourJob.matchWarning || null,
    matchBreakdown: normalizeJsonObject(yourJob.matchBreakdown),
    strongMatches: normalizeJsonStringArray(yourJob.strongMatches),
    missingSkills: normalizeJsonStringArray(yourJob.missingSkills),
    tailoredResume: serializeTailoredResumeMeta(getTailoredResumeMeta(storedRawPayload), false),
    descriptionAvailable: Boolean(jobDescription),
  };
};

const getJobApplicationInclude = () => ({
  appliedBy: {
    select: {
      id: true,
      fullName: true,
      role: true,
    },
  },
  yourJob: {
    select: {
      id: true,
      applyLink: true,
      rawPayload: true,
    },
  },
});

const buildJobApplicationWriteData = ({ userId, yourJob, listing, appliedAt, appliedById, status }) => {
  const sourceListing = yourJob?.sourceListing || listing || null;
  const storedRawPayload = yourJob?.rawPayload || sourceListing?.rawPayload || listing?.rawPayload || null;

  return {
    userId,
    yourJobId: yourJob?.id || null,
    sourceListingId: yourJob?.sourceListingId || sourceListing?.id || listing?.id || null,
    sourceJobId: yourJob?.sourceJobId || sourceListing?.sourceJobId || listing?.sourceJobId || null,
    title: compact(yourJob?.title || sourceListing?.title || listing?.title) || 'Untitled role',
    company: compact(yourJob?.company || sourceListing?.company || listing?.company) || 'Unknown company',
    location: compact(yourJob?.location || sourceListing?.location || listing?.location) || null,
    datePostedText: compact(yourJob?.datePostedText || sourceListing?.datePostedText || listing?.datePostedText) || null,
    postedAt: yourJob?.postedAt || sourceListing?.postedAt || listing?.postedAt || null,
    applyLink: compact(yourJob?.applyLink || sourceListing?.applyLink || listing?.applyLink),
    source: compact(yourJob?.source || sourceListing?.source || listing?.source) || 'JSEARCH',
    rawPayload: getPublicYourJobRawPayload(storedRawPayload),
    matchingScore: Number.isFinite(Number(yourJob?.matchingScore)) ? Number(yourJob.matchingScore) : null,
    matchLabel: compact(yourJob?.matchLabel) || null,
    matchProvider: compact(yourJob?.matchProvider) || null,
    matchModel: compact(yourJob?.matchModel) || null,
    matchSummary: compact(yourJob?.matchSummary) || null,
    matchWarning: compact(yourJob?.matchWarning) || null,
    matchBreakdown: normalizeJsonObject(yourJob?.matchBreakdown),
    strongMatches: Array.isArray(yourJob?.strongMatches) ? yourJob.strongMatches : [],
    missingSkills: Array.isArray(yourJob?.missingSkills) ? yourJob.missingSkills : [],
    status: normalizeApplicationStatus(status, appliedById),
    appliedAt: appliedAt || new Date(),
    appliedById: appliedById || null,
  };
};

const findYourJobForApplication = async (userId, { yourJobId, sourceListingId, applyLink }) => {
  const orFilters = [];
  if (compact(yourJobId)) orFilters.push({ id: compact(yourJobId) });
  if (compact(sourceListingId)) orFilters.push({ sourceListingId: compact(sourceListingId) });
  if (compact(applyLink)) orFilters.push({ applyLink: compact(applyLink) });

  if (orFilters.length === 0) return null;

  return prisma.userYourJob.findFirst({
    where: {
      ...buildPersistedYourJobsWhere(userId),
      OR: orFilters,
    },
    include: getYourJobInclude(),
  });
};

const upsertJobApplication = async ({ userId, yourJob, listing, appliedAt, appliedById, status }) => {
  const writeData = buildJobApplicationWriteData({ userId, yourJob, listing, appliedAt, appliedById, status });

  if (!writeData.applyLink) {
    throw new Error('Application apply link is required');
  }

  return prisma.userJobApplication.upsert({
    where: {
      userId_applyLink: {
        userId,
        applyLink: writeData.applyLink,
      },
    },
    create: writeData,
    update: writeData,
    include: getJobApplicationInclude(),
  });
};

const serializeJobApplication = (application) => {
  const rawPayload = getPublicYourJobRawPayload(application.rawPayload);
  const linkedYourJob = application.yourJob || application.fallbackYourJob || null;
  const tailoredResumeSource = linkedYourJob?.rawPayload || application.rawPayload;
  const listingForDescription = {
    title: application.title,
    company: application.company,
    location: application.location,
    datePostedText: application.datePostedText,
    rawPayload: application.rawPayload,
  };
  const jobDescription = getListingDescription(listingForDescription);

  return {
    id: application.id,
    userId: application.userId,
    yourJobId: application.yourJobId || linkedYourJob?.id || null,
    sourceListingId: application.sourceListingId || null,
    sourceJobId: application.sourceJobId || null,
    title: application.title,
    company: application.company,
    location: application.location || '',
    datePostedText: application.datePostedText || null,
    postedAt: application.postedAt?.toISOString() || null,
    applyLink: application.applyLink,
    source: application.source,
    rawPayload,
    status: normalizeApplicationStatus(application.status, application.appliedById),
    appliedAt: application.appliedAt?.toISOString() || null,
    appliedBy: application.appliedBy || null,
    appliedById: application.appliedById || null,
    createdAt: application.createdAt?.toISOString() || null,
    updatedAt: application.updatedAt?.toISOString() || null,
    jobDescription,
    matchingScore: application.matchingScore || 0,
    matchScore: application.matchingScore || 0,
    match_score: application.matchingScore || 0,
    matchLabel: application.matchLabel || null,
    matchProvider: application.matchProvider || null,
    matchModel: application.matchModel || null,
    matchSummary: application.matchSummary || null,
    matchWarning: application.matchWarning || null,
    matchBreakdown: normalizeJsonObject(application.matchBreakdown),
    strongMatches: normalizeJsonStringArray(application.strongMatches),
    missingSkills: normalizeJsonStringArray(application.missingSkills),
    tailoredResume: serializeTailoredResumeMeta(getTailoredResumeMeta(tailoredResumeSource), false),
    descriptionAvailable: Boolean(jobDescription),
    job: {
      title: application.title,
      company: application.company,
      location: application.location || '',
      applyLink: application.applyLink,
    },
  };
};

const hydrateApplicationsWithYourJobs = async (userId, applications = []) => {
  const fallbackApplyLinks = [...new Set(applications
    .filter((application) => !application.yourJobId && !application.yourJob && compact(application.applyLink))
    .map((application) => compact(application.applyLink))
  )];

  if (fallbackApplyLinks.length === 0) return applications;

  const fallbackYourJobs = await prisma.userYourJob.findMany({
    where: {
      userId,
      applyLink: { in: fallbackApplyLinks },
    },
    select: {
      id: true,
      applyLink: true,
      rawPayload: true,
    },
  });

  const fallbackByApplyLink = new Map(fallbackYourJobs.map((yourJob) => [yourJob.applyLink, yourJob]));

  return applications.map((application) => {
    if (application.yourJobId || application.yourJob) return application;
    const fallbackYourJob = fallbackByApplyLink.get(application.applyLink);
    return fallbackYourJob ? { ...application, fallbackYourJob } : application;
  });
};

const getPersistedYourJobs = async (userId, options = {}) => {
  const rows = await prisma.userYourJob.findMany({
    where: buildPersistedYourJobsWhere(userId),
    include: getYourJobInclude(),
    orderBy: [
      { matchingScore: 'desc' },
      { updatedAt: 'desc' },
    ],
  });

  return rows.map((row) => serializeStoredYourJob(row, options));
};

const toIsoString = (value) => (value ? new Date(value).toISOString() : null);

const serializeCompactYourJobRow = (row) => {
  const applicationStatus = row.applicationStatus
    ? normalizeApplicationStatus(row.applicationStatus, row.applicationAppliedById)
    : row.isApplied
      ? normalizeApplicationStatus(null, row.appliedById)
      : null;
  const requiresStudentAction = applicationStatus === APPLICATION_STATUS_STUDENT_ACTION_REQUIRED;
  const appliedAt = row.applicationAppliedAt || row.appliedAt || null;
  const appliedById = row.applicationAppliedById || row.appliedById || null;

  return {
    id: row.id,
    userId: row.userId,
    sourceListingId: row.sourceListingId,
    sourceJobId: row.sourceJobId || null,
    title: row.title,
    company: row.company,
    location: row.location || '',
    datePostedText: row.datePostedText || null,
    postedAt: toIsoString(row.postedAt),
    applyLink: row.applyLink,
    source: row.source,
    rawPayload: null,
    isApplied: Boolean(row.isApplied) && !requiresStudentAction,
    appliedAt: toIsoString(appliedAt),
    appliedById,
    applicationId: row.applicationId || null,
    applicationStatus,
    requiresStudentAction,
    firstSeenAt: toIsoString(row.firstSeenAt),
    lastSeenAt: toIsoString(row.lastSeenAt),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
    matchedAt: toIsoString(row.matchedAt),
    jobDescription: '',
    matchingScore: row.matchingScore,
    matchScore: row.matchingScore,
    match_score: row.matchingScore,
    matchLabel: row.matchLabel,
    matchProvider: row.matchProvider || 'fallback',
    matchModel: row.matchModel || null,
    matchSummary: row.matchSummary || null,
    matchWarning: row.matchWarning || null,
    matchBreakdown: normalizeJsonObject(row.matchBreakdown),
    strongMatches: normalizeJsonStringArray(row.strongMatches),
    missingSkills: normalizeJsonStringArray(row.missingSkills),
    tailoredResume: serializeTailoredResumeMeta(normalizeJsonObject(row.tailoredResumeMeta), false),
    descriptionAvailable: false,
  };
};

const getPersistedYourJobsFast = async (userId) => {
  const rows = await prisma.$queryRaw`
    SELECT
      y.id,
      y."userId",
      y."sourceListingId",
      y."sourceJobId",
      y.title,
      y.company,
      y.location,
      y."datePostedText",
      y."postedAt",
      y."applyLink",
      y.source,
      y."matchingScore",
      y."matchLabel",
      y."matchProvider",
      y."matchModel",
      y."matchSummary",
      y."matchWarning",
      y."matchBreakdown",
      y."strongMatches",
      y."missingSkills",
      y."matchedAt",
      y."createdAt",
      y."updatedAt",
      y."rawPayload" -> ${TAILORED_RESUME_META_KEY} AS "tailoredResumeMeta",
      s."isApplied",
      s."appliedAt",
      s."appliedById",
      s."firstSeenAt",
      s."lastSeenAt",
      a.id AS "applicationId",
      a.status AS "applicationStatus",
      a."appliedAt" AS "applicationAppliedAt",
      a."appliedById" AS "applicationAppliedById"
    FROM user_your_jobs y
    LEFT JOIN user_job_listings s ON s.id = y."sourceListingId"
    LEFT JOIN user_job_applications a ON a."yourJobId" = y.id
    WHERE y."userId" = ${userId}
      AND LOWER(COALESCE(y."matchProvider", '')) = ${GEMINI_MATCH_PROVIDER}
    ORDER BY y."matchingScore" DESC, y."updatedAt" DESC
  `;

  return rows.map(serializeCompactYourJobRow);
};

const upsertYourJobRecord = async (userId, sourceListing, match, now = new Date()) => {
  return prisma.userYourJob.upsert({
    where: {
      sourceListingId: sourceListing.id,
    },
    create: {
      userId,
      sourceListingId: sourceListing.id,
      ...buildYourJobWriteData(sourceListing, match, now),
    },
    update: buildYourJobWriteData(sourceListing, match, now),
    include: getYourJobInclude(),
  });
};

const deleteYourJobRecord = async (sourceListingId) => prisma.userYourJob.deleteMany({
  where: { sourceListingId },
});

const getYourJobsContext = async (userId) => {
  const [profile, loadedSourceListings, persistedJobs] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        fullName: true,
        education: true,
        experience: true,
        keySkills: true,
        jobRole: true,
        location: true,
        parsedResumeText: true,
      },
    }),
    prisma.userJobListing.findMany({
      where: { userId },
      include: {
        yourJob: {
          select: {
            id: true,
            matchProvider: true,
          },
        },
      },
      orderBy: [
        { lastSeenAt: 'desc' },
        { postedAt: 'desc' },
        { createdAt: 'desc' },
      ],
    }),
    prisma.userYourJob.count({ where: buildPersistedYourJobsWhere(userId) }),
  ]);

  const sourceListings = await backfillLegacyYourJobSnapshots(loadedSourceListings, persistedJobs);

  return {
    profile,
    sourceListings,
    persistedJobs,
  };
};

const mapWithConcurrency = async (items, limit, mapper) => {
  if (items.length === 0) return [];

  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) return;

      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
};

const resolveTargetUserId = (req) => {
  const requestedStudentId = compact(req.query.studentId || req.params.studentId);
  return req.user.role === 'STUDENT'
    ? req.user.id
    : requestedStudentId || req.user.id;
};

const getJobDateTime = (job) => {
  const time = parsePostedDateTime(job?.datePosted);
  return Number.isFinite(time) ? time : 0;
};

const sortJobsByDate = (jobs) => [...jobs].sort((left, right) => getJobDateTime(right) - getJobDateTime(left));

const dedupeJobs = (jobs) => {
  const seen = new Set();
  return jobs.filter((job) => {
    const key = job.applyLink || `${job.company}:${job.title}:${job.location}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const normalizeSearchDays = (value) => {
  const parsedValue = parseInt(value, 10);
  if (!Number.isFinite(parsedValue)) return DEFAULT_SEARCH_DAYS;
  return Math.min(Math.max(parsedValue, 1), MAX_SEARCH_DAYS);
};

const getPostedFilter = (searchDays) => {
  if (searchDays <= 1) return 'today';
  if (searchDays <= 3) return '3days';
  if (searchDays <= 7) return 'week';
  if (searchDays <= 30) return 'month';
  return null;
};

const isRawJobWithinSearchDays = (job, searchDays) => {
  const jobTime = parsePostedDateTime(normalizePostedDate(job));
  if (!Number.isFinite(jobTime) || jobTime <= 0) return false;
  return jobTime >= (Date.now() - (searchDays * DAY_MS));
};

const filterJobsBySearchDays = (jobs, searchDays) => {
  const cutoffTime = Date.now() - (searchDays * DAY_MS);
  return jobs.filter((job) => {
    const jobTime = getJobDateTime(job);
    return Number.isFinite(jobTime) && jobTime > 0 && jobTime >= cutoffTime;
  });
};

const fetchRapidApiJobs = async ({ query, page, postedFilter }) => {
  const params = {
    query,
    page: String(page || 1),
    num_pages: '1',
  };

  if (postedFilter) params.date_posted = postedFilter;

  const response = await axios.get(JSEARCH_URL, {
    params,
    headers: {
      'X-RapidAPI-Key': getRapidApiKey(),
      'X-RapidAPI-Host': JSEARCH_HOST,
    },
    timeout: 25000,
  });

  return Array.isArray(response.data?.data) ? response.data.data : [];
};

const normalizeComparableText = (value) => compact(value).toLowerCase();

const buildJobDescriptionLookupQueries = (listing) => [...new Set([
  [listing.title, listing.company, listing.location].filter(Boolean).join(' '),
  [listing.title, listing.company].filter(Boolean).join(' '),
  listing.title,
].map(compact).filter(Boolean))];

const getRapidApiCandidateScore = (listing, rawJob) => {
  const listingTitle = normalizeComparableText(listing.title);
  const listingCompany = normalizeComparableText(listing.company);
  const listingLocation = normalizeComparableText(listing.location);
  const listingApplyLink = normalizeComparableText(listing.applyLink);
  const listingSourceJobId = normalizeComparableText(listing.sourceJobId || listing.externalId || '');

  const jobTitle = normalizeComparableText(rawJob.job_title);
  const jobCompany = normalizeComparableText(rawJob.employer_name);
  const jobLocation = normalizeComparableText(normalizeLocation(rawJob));
  const jobApplyLink = normalizeComparableText(rawJob.job_apply_link || rawJob.job_google_link || '');
  const jobId = normalizeComparableText(rawJob.job_id || '');

  let score = 0;

  if (listingSourceJobId && jobId && listingSourceJobId === jobId) score += 30;
  if (listingApplyLink && jobApplyLink && listingApplyLink === jobApplyLink) score += 26;

  if (listingTitle && jobTitle) {
    if (listingTitle === jobTitle) {
      score += 28;
    } else if (jobTitle.includes(listingTitle) || listingTitle.includes(jobTitle)) {
      score += 18;
    } else {
      const listingTokens = new Set(tokenize(listingTitle));
      const matchedTokens = tokenize(jobTitle).filter((token) => listingTokens.has(token));
      score += matchedTokens.length * 3;
    }
  }

  if (listingCompany && jobCompany) {
    if (listingCompany === jobCompany) {
      score += 18;
    } else if (jobCompany.includes(listingCompany) || listingCompany.includes(jobCompany)) {
      score += 10;
    }
  }

  if (listingLocation && jobLocation) {
    if (listingLocation === jobLocation) {
      score += 8;
    } else if (jobLocation.includes(listingLocation) || listingLocation.includes(jobLocation)) {
      score += 5;
    }
  }

  if (compact(rawJob.job_description)) score += 12;
  if (rawJob.job_highlights) score += 4;
  if (rawJob.job_required_skills) score += 4;

  return score;
};

const mergeListingRawPayload = (listing, rawJob) => {
  const currentRawPayload = getRawPayload(listing);
  return {
    ...currentRawPayload,
    ...rawJob,
    id: currentRawPayload.id || rawJob.job_id || currentRawPayload.externalId || null,
    title: currentRawPayload.title || rawJob.job_title || listing.title,
    company: currentRawPayload.company || rawJob.employer_name || listing.company,
    location: currentRawPayload.location || normalizeLocation(rawJob) || listing.location,
    applyLink: currentRawPayload.applyLink || rawJob.job_apply_link || rawJob.job_google_link || listing.applyLink,
    datePosted: currentRawPayload.datePosted || normalizePostedDate(rawJob) || listing.datePostedText || null,
    externalId: currentRawPayload.externalId || rawJob.job_id || listing.sourceJobId || null,
  };
};

const lookupRapidApiJobDescription = async (listing) => {
  if (!getRapidApiKey()) return null;

  const queries = buildJobDescriptionLookupQueries(listing);
  let bestMatch = null;
  let bestScore = -1;

  for (const query of queries) {
    let jobs = [];

    try {
      jobs = await fetchRapidApiJobs({ query, page: 1, postedFilter: null });
    } catch (error) {
      const providerError = getRapidApiError(error);
      console.error('RapidAPI JD lookup failed', {
        query,
        status: providerError.status,
        detail: providerError.detail,
      });
      continue;
    }

    for (const rawJob of jobs) {
      const score = getRapidApiCandidateScore(listing, rawJob);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = rawJob;
      }
    }

    if (bestScore >= 40 && compact(bestMatch?.job_description)) {
      break;
    }
  }

  if (!bestMatch || bestScore < 24) {
    return null;
  }

  const mergedRawPayload = mergeListingRawPayload(listing, bestMatch);
  const resolvedDescription = normalizeDocumentText(compact([
    bestMatch.job_description,
    stringifyStructuredValue(bestMatch.job_highlights),
    stringifyStructuredValue(bestMatch.job_required_skills),
  ].join(' ')));

  if (!resolvedDescription) {
    return null;
  }

  return {
    rawPayload: mergedRawPayload,
    description: resolvedDescription,
  };
};

const finalizeJobs = (rawJobs, profile, searchDays) => sortJobsByDate(
  filterJobsBySearchDays(
    dedupeJobs(rankJobs(rawJobs, profile).map(normalizeJob).filter((job) => job.applyLink)),
    searchDays
  )
);

const collectSearchJobs = async ({
  profile,
  searchDays,
  onProgress,
  shouldAbort,
}) => {
  const rawJobs = [];
  const seenKeys = new Set();
  const queries = buildSearchQueries(profile);
  let lastProviderError = null;
  const postedFilter = getPostedFilter(searchDays);
  let page = 1;

  while (!shouldAbort?.()) {
    let pageReturnedJobs = 0;
    let pageAddedJobs = 0;
    let rankedJobs = finalizeJobs(rawJobs, profile, searchDays);

    for (let index = 0; index < queries.length; index += 1) {
      const query = queries[index];
      let jobs = [];

      try {
        jobs = await fetchRapidApiJobs({
          query,
          page,
          postedFilter,
        });
      } catch (error) {
        const providerError = getRapidApiError(error);
        lastProviderError = providerError;
        console.error('JSearch request failed', {
          query,
          page,
          status: providerError.status,
          detail: providerError.detail,
        });

        if (providerError.fatal) {
          throw createSearchError(providerError.message, providerError.statusCode);
        }

        await onProgress?.({
          type: 'warning',
          query,
          page,
          jobs: rankedJobs,
          warning: providerError.message,
        });

        continue;
      }

      pageReturnedJobs += jobs.length;
      jobs.forEach((job) => {
        if (!isRawJobWithinSearchDays(job, searchDays)) return;

        const key = job.job_id || job.job_apply_link || job.job_google_link || `${job.employer_name}:${job.job_title}`;
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        rawJobs.push(job);
        pageAddedJobs += 1;
      });

      rankedJobs = finalizeJobs(rawJobs, profile, searchDays);
      await onProgress?.({
        type: 'progress',
        query,
        page,
        jobs: rankedJobs,
      });
    }

    if (pageReturnedJobs === 0 || pageAddedJobs === 0) {
      break;
    }

    page += 1;
  }

  if (rawJobs.length === 0 && lastProviderError) {
    throw createSearchError(lastProviderError.message, lastProviderError.statusCode);
  }

  return {
    jobs: finalizeJobs(rawJobs, profile, searchDays),
    hasMore: false,
  };
};

const searchRapidApiJobs = async ({ profile, searchDays }) => {
  return collectSearchJobs({ profile, searchDays });
};

const serializeProfile = (profile) => ({
  jobRole: profile.jobRole || '',
  experience: profile.experience || '',
  skills: toArray(profile.keySkills),
  location: profile.location || '',
});

const resolveSearchContext = async (req) => {
  const targetUserId = resolveTargetUserId(req);

  const profile = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: {
      id: true,
      jobRole: true,
      experience: true,
      keySkills: true,
      location: true,
    },
  });

  if (!profile) {
    throw createSearchError('Profile not found', 404);
  }

  const query = buildQuery(profile);
  if (!query) {
    throw createSearchError('Please add job role, experience, skills, or location to your profile first.', 400);
  }

  if (!getRapidApiKey()) {
    throw createSearchError('Job search API key is not configured on the backend.', 500);
  }

  return {
    profile,
    query,
    searchDays: normalizeSearchDays(req.query.days),
  };
};

const sendStreamEvent = (res, event, payload) => {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.flush?.();
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getStreamJobDelay = (emittedCount) => (
  emittedCount <= SLOW_STREAM_JOB_COUNT ? INITIAL_STREAM_JOB_DELAY_MS : STREAM_JOB_DELAY_MS
);

exports.searchJobsStream = async (req, res) => {
  let clientDisconnected = false;

  const markClientDisconnected = () => {
    clientDisconnected = true;
  };

  const canStreamToClient = () => !clientDisconnected && !res.writableEnded && !res.destroyed;

  req.on('close', markClientDisconnected);
  req.on('aborted', markClientDisconnected);

  try {
    const {
      profile,
      query,
      searchDays,
    } = await resolveSearchContext(req);

    if (canStreamToClient()) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
    }

    const emittedKeys = new Set();
    if (canStreamToClient()) {
      sendStreamEvent(res, 'meta', {
        query,
        profile: serializeProfile(profile),
        postedWindowDays: searchDays,
      });
      sendStreamEvent(res, 'status', {
        message: 'Searching...',
        count: 0,
      });
    }

    const { jobs, hasMore } = await collectSearchJobs({
      profile,
      searchDays,
      onProgress: async ({ jobs: currentJobs, warning }) => {
        if (canStreamToClient()) {
          sendStreamEvent(res, 'status', {
            message: 'Searching...',
            count: emittedKeys.size,
          });

          if (warning) {
            sendStreamEvent(res, 'warning', { message: warning });
          }
        }

        for (const job of currentJobs) {
          const key = job.applyLink || job.id;
          if (emittedKeys.has(key)) continue;

          const listing = await persistJobListing(profile.id, job);

          emittedKeys.add(key);
          if (canStreamToClient()) {
            sendStreamEvent(res, 'job', {
              job: listing ? serializeListing(listing) : job,
              count: emittedKeys.size,
            });
            await wait(getStreamJobDelay(emittedKeys.size));
          }
        }
      },
    });

    await persistJobListings(profile.id, jobs);

    if (!canStreamToClient()) return;

    sendStreamEvent(res, 'end', {
      count: jobs.length,
      hasMore,
      query,
    });
    res.end();
  } catch (error) {
    const statusCode = error.statusCode || 500;

    if (res.headersSent) {
      if (canStreamToClient()) {
        sendStreamEvent(res, 'error', { message: error.message });
        res.end();
      }
      return;
    }

    if (clientDisconnected || res.destroyed) {
      return;
    }

    res.status(statusCode).json({ message: 'Failed to search jobs', error: error.message });
  }
};

exports.searchJobs = async (req, res) => {
  try {
    const {
      profile,
      query,
      searchDays,
    } = await resolveSearchContext(req);
    const { jobs, hasMore } = await searchRapidApiJobs({ profile, searchDays });
    const persistedJobs = await persistJobListings(profile.id, jobs);

    return res.json({
      query,
      jobs: persistedJobs.map(serializeListing),
      hasMore,
      profile: serializeProfile(profile),
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({ message: 'Failed to search jobs', error: error.message });
  }
};

exports.getMatchedJobs = async (req, res) => {
  try {
    const userId = resolveTargetUserId(req);
    const jobs = await getPersistedJobListings(userId, { limit: req.query.limit });
    return res.json({ jobs });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to load saved jobs', error: error.message });
  }
};

const sanitizeCloudinaryId = (value) => compact(value)
  .replace(/[^a-zA-Z0-9_-]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 120) || `resume_${Date.now()}`;

const uploadTailoredResumeText = async ({ userId, yourJobId, resumeText }) => {
  const publicId = sanitizeCloudinaryId(`tailored_resume_${userId}_${yourJobId}_${hashText(resumeText).slice(0, 12)}`);
  return uploadToCloudinary(Buffer.from(resumeText, 'utf8'), {
    folder: 'tailored-resumes',
    resourceType: 'raw',
    publicId: `${publicId}.txt`,
  });
};

exports.generateYourJobResume = async (req, res) => {
  try {
    const userId = resolveTargetUserId(req);
    const yourJobId = compact(req.params.yourJobId || req.body.yourJobId);

    if (!yourJobId) {
      return res.status(400).json({ message: 'yourJobId is required' });
    }

    const [profile, yourJob] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          linkedinProfile: true,
          education: true,
          experience: true,
          keySkills: true,
          jobRole: true,
          location: true,
          parsedResumeText: true,
        },
      }),
      prisma.userYourJob.findFirst({
        where: {
          id: yourJobId,
          userId,
        },
        include: getYourJobInclude(),
      }),
    ]);

    if (!profile) {
      return res.status(404).json({ message: 'Profile not found' });
    }

    if (!yourJob) {
      return res.status(404).json({ message: 'Your Jobs record not found' });
    }

    const cachedResume = getTailoredResumeMeta(yourJob.rawPayload);
    if (compact(cachedResume.resumeText)) {
      return res.json({
        generated: false,
        cached: true,
        resume: serializeTailoredResumeMeta(cachedResume, true),
        job: serializeStoredYourJob(yourJob),
      });
    }

    const uploadedResumeText = String(profile.parsedResumeText || '').trim();
    if (!uploadedResumeText) {
      return res.status(400).json({ message: 'Uploaded resume content is not available for this user' });
    }

    const sourceListing = yourJob.sourceListing || yourJob;
    const jobDescription = getListingDescription(sourceListing) || buildJobMatchText(sourceListing);
    if (!jobDescription) {
      return res.status(400).json({ message: 'Job description is not available for this job' });
    }

    if (!hasGeminiApiKey()) {
      return res.status(500).json({ message: 'Gemini API key is not configured on the backend' });
    }

    const generatedResume = await generateTailoredResume({
      resumeText: uploadedResumeText,
      jobDescription,
      profileContext: {
        fullName: profile.fullName || '',
        email: profile.email || '',
        phone: profile.phone || '',
        linkedinProfile: profile.linkedinProfile || '',
        education: profile.education || '',
        experience: profile.experience || '',
        keySkills: toArray(profile.keySkills),
        jobRole: profile.jobRole || '',
        location: profile.location || '',
      },
      jobContext: buildGeminiJobContext(sourceListing),
    });

    let cloudinaryResult = null;
    let cloudinaryWarning = null;
    try {
      cloudinaryResult = await uploadTailoredResumeText({
        userId,
        yourJobId: yourJob.id,
        resumeText: generatedResume.resumeText,
      });
    } catch (uploadError) {
      cloudinaryWarning = 'Resume was generated and cached, but Cloudinary upload failed.';
      console.error('Tailored resume Cloudinary upload failed', {
        userId,
        yourJobId: yourJob.id,
        message: uploadError.message,
      });
    }

    const resumeMeta = {
      generatedAt: new Date().toISOString(),
      candidateName: profile.fullName || '',
      jobTitle: yourJob.title,
      company: yourJob.company,
      headline: generatedResume.headline || yourJob.title,
      resumeText: generatedResume.resumeText,
      changeSummary: generatedResume.changeSummary,
      provider: generatedResume.provider,
      model: generatedResume.model,
      cloudinaryUrl: cloudinaryResult?.url || null,
      cloudinaryPublicId: cloudinaryResult?.publicId || null,
      warning: cloudinaryWarning,
    };

    const updatedJob = await prisma.userYourJob.update({
      where: { id: yourJob.id },
      data: {
        rawPayload: mergeTailoredResumeMeta(yourJob.rawPayload || sourceListing.rawPayload || {}, resumeMeta),
      },
      include: getYourJobInclude(),
    });

    return res.json({
      generated: true,
      cached: false,
      resume: serializeTailoredResumeMeta(resumeMeta, true),
      job: serializeStoredYourJob(updatedJob),
    });
  } catch (error) {
    console.error('Tailored resume generation failed', {
      message: error.message,
    });
    return res.status(500).json({ message: error.message || 'Failed to generate tailored resume' });
  }
};

exports.getYourJobs = async (req, res) => {
  try {
    const userId = resolveTargetUserId(req);
    const fast = req.query.fast === '1' || req.query.fast === 'true';

    if (fast) {
      const [{ profile, sourceListings, persistedJobs }, jobs] = await Promise.all([
        getYourJobsContext(userId),
        getPersistedYourJobsFast(userId),
      ]);
      const refreshState = buildYourJobsRefreshState(sourceListings);

      if (!profile) {
        return res.status(404).json({ message: 'Profile not found' });
      }

      return res.json({
        jobs,
        threshold: MATCH_SCORE_THRESHOLD,
        totalSavedJobs: sourceListings.length,
        totalMatchedJobs: persistedJobs,
        refreshNeeded: refreshState.refreshNeeded,
        pendingSourceCount: refreshState.pendingSourceCount,
        scoringProvider: GEMINI_MATCH_PROVIDER,
        profile: {
          jobRole: profile.jobRole || '',
          experience: profile.experience || '',
          skills: toArray(profile.keySkills),
          location: profile.location || '',
          hasResumeText: Boolean(compact(profile.parsedResumeText)),
        },
      });
    }

    const { profile, sourceListings, persistedJobs } = await getYourJobsContext(userId);
    const refreshState = buildYourJobsRefreshState(sourceListings);

    if (!profile) {
      return res.status(404).json({ message: 'Profile not found' });
    }

    const jobs = await getPersistedYourJobs(userId);

    return res.json({
      jobs,
      threshold: MATCH_SCORE_THRESHOLD,
      totalSavedJobs: sourceListings.length,
      totalMatchedJobs: persistedJobs,
      refreshNeeded: refreshState.refreshNeeded,
      pendingSourceCount: refreshState.pendingSourceCount,
      scoringProvider: GEMINI_MATCH_PROVIDER,
      profile: {
        jobRole: profile.jobRole || '',
        experience: profile.experience || '',
        skills: toArray(profile.keySkills),
        location: profile.location || '',
        hasResumeText: Boolean(compact(profile.parsedResumeText)),
      },
    });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to load your matched jobs', error: error.message });
  }
};

exports.streamYourJobs = async (req, res) => {
  let closed = false;

  req.on('close', () => {
    closed = true;
  });

  try {
    const userId = resolveTargetUserId(req);
    const { profile, sourceListings, persistedJobs } = await getYourJobsContext(userId);
    const { pendingSourceListings, pendingSourceCount, refreshNeeded } = buildYourJobsRefreshState(sourceListings);

    if (!profile) {
      throw createSearchError('Profile not found', 404);
    }

    if (pendingSourceCount > 0) {
      ensureYourJobsGeminiReady(profile);
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let matchedCount = persistedJobs;
    let processedCount = 0;

    sendStreamEvent(res, 'meta', {
      profile: {
        jobRole: profile.jobRole || '',
        experience: profile.experience || '',
        skills: toArray(profile.keySkills),
        location: profile.location || '',
        hasResumeText: Boolean(compact(profile.parsedResumeText)),
      },
      threshold: MATCH_SCORE_THRESHOLD,
      sourceCount: sourceListings.length,
      persistedCount: persistedJobs,
      pendingSourceCount,
      refreshNeeded,
      scoringProvider: GEMINI_MATCH_PROVIDER,
    });

    sendStreamEvent(res, 'status', {
      message: pendingSourceCount
        ? `Scoring ${pendingSourceCount} new Find Jobs record${pendingSourceCount === 1 ? '' : 's'}...`
        : sourceListings.length
          ? 'Your matched jobs are already up to date.'
          : 'No Find Jobs records available yet.',
      processedCount,
      matchedCount,
      total: pendingSourceCount,
    });

    if (pendingSourceCount === 0) {
      sendStreamEvent(res, 'end', {
        count: matchedCount,
        processedCount,
        total: pendingSourceCount,
      });
      res.end();
      return;
    }

    const processOneListing = async (sourceListing) => {
      if (closed || res.writableEnded) return;

      processedCount += 1;
      const currentProcessed = processedCount;
      const snapshotHash = buildListingMatchSnapshotHash(sourceListing);

      if (!closed && !res.writableEnded) {
        sendStreamEvent(res, 'status', {
          message: `Scoring job ${currentProcessed} of ${pendingSourceCount}...`,
          processedCount: currentProcessed,
          matchedCount,
          total: pendingSourceCount,
        });
      }

      try {
        const match = await calculateListingMatchWithGemini(profile, sourceListing);

        if (match.score >= MATCH_SCORE_THRESHOLD) {
          const hadStoredMatch = hasGeminiStoredYourJob(sourceListing);
          const storedJob = await upsertYourJobRecord(userId, sourceListing, match);
          await markListingMatchSnapshotProcessed(sourceListing, snapshotHash);
          if (!hadStoredMatch) matchedCount += 1;

          if (!closed && !res.writableEnded) {
            sendStreamEvent(res, 'job', {
              job: serializeStoredYourJob(storedJob),
              processedCount: currentProcessed,
              matchedCount,
              total: pendingSourceCount,
            });
            await wait(getStreamJobDelay(matchedCount));
          }
        } else if (hasGeminiStoredYourJob(sourceListing)) {
          // Only hit the DB if a Gemini record actually exists for this listing.
          const removed = await deleteYourJobRecord(sourceListing.id);
          await markListingMatchSnapshotProcessed(sourceListing, snapshotHash);
          if (removed.count > 0) {
            matchedCount = Math.max(0, matchedCount - 1);
            if (!closed && !res.writableEnded) {
              sendStreamEvent(res, 'removed', {
                sourceListingId: sourceListing.id,
                applyLink: sourceListing.applyLink,
                processedCount: currentProcessed,
                matchedCount,
                total: pendingSourceCount,
              });
            }
          }
        } else {
          // Below threshold and never stored — just stamp as processed.
          await markListingMatchSnapshotProcessed(sourceListing, snapshotHash);
        }
      } catch (scoringError) {
        // Per-job error: log and skip — the stream continues for other listings.
        console.error('Gemini scoring failed for listing, skipping', {
          listingId: sourceListing.id,
          title: sourceListing.title,
          message: scoringError.message,
        });
        if (!closed && !res.writableEnded) {
          sendStreamEvent(res, 'status', {
            message: `Skipped job ${currentProcessed} of ${pendingSourceCount} (scoring error). Continuing...`,
            processedCount: currentProcessed,
            matchedCount,
            total: pendingSourceCount,
          });
        }
      }
    };

    await mapWithConcurrency(pendingSourceListings, GEMINI_MATCH_CONCURRENCY, processOneListing);

    if (closed || res.writableEnded) return;

    sendStreamEvent(res, 'end', {
      count: matchedCount,
      processedCount,
      total: pendingSourceCount,
    });
    res.end();
  } catch (error) {
    const statusCode = error.statusCode || 500;

    if (res.headersSent) {
      sendStreamEvent(res, 'error', { message: error.message });
      res.end();
      return;
    }

    res.status(statusCode).json({ message: 'Failed to stream your jobs', error: error.message });
  }
};

exports.markExternalApplied = async (req, res) => {
  try {
    const userId = resolveTargetUserId(req);
    const applyLink = compact(req.body.jobLink || req.body.applyLink);

    if (!applyLink) {
      return res.status(400).json({ message: 'jobLink is required' });
    }

    const [existingListing, existingApplication] = await Promise.all([
      prisma.userJobListing.findUnique({
        where: {
          userId_applyLink: {
            userId,
            applyLink,
          },
        },
      }),
      prisma.userJobApplication.findUnique({
        where: {
          userId_applyLink: {
            userId,
            applyLink,
          },
        },
        select: {
          id: true,
          status: true,
          appliedAt: true,
          appliedById: true,
        },
      }),
    ]);

    const now = new Date();
    const isStudentApply = req.user.role === 'STUDENT';
    const applicationStatus = isStudentApply
      ? APPLICATION_STATUS_STUDENT_APPLIED
      : APPLICATION_STATUS_MENTOR_APPLIED;
    const shouldRefreshAppliedAt = isStudentApply
      && existingApplication
      && isStudentActionRequiredStatus(existingApplication.status);
    const appliedAt = shouldRefreshAppliedAt
      ? now
      : existingApplication?.appliedAt || existingListing?.appliedAt || now;
    const appliedById = isStudentApply
      ? null
      : existingApplication?.appliedById || existingListing?.appliedById || req.user.id;
    const rawPayload = mergeListingPayload(
      req.body.rawPayload || existingListing?.rawPayload || {},
      existingListing?.rawPayload || null,
      {
        appliedSource: APPLIED_SOURCE_YOUR_JOBS,
      }
    );
    const listing = await prisma.userJobListing.upsert({
      where: {
        userId_applyLink: {
          userId,
          applyLink,
        },
      },
      create: {
        userId,
        sourceJobId: compact(req.body.externalId || req.body.jobId) || null,
        title: compact(req.body.jobTitle || req.body.title) || 'Untitled role',
        company: compact(req.body.employerName || req.body.company) || 'Unknown company',
        location: compact(req.body.location) || null,
        datePostedText: compact(req.body.datePosted) || null,
        postedAt: toPostedAtDate(req.body.datePosted),
        applyLink,
        source: 'JSEARCH',
        rawPayload,
        isApplied: true,
        appliedAt,
        appliedById,
        firstSeenAt: now,
        lastSeenAt: existingListing?.lastSeenAt || now,
      },
      update: {
        rawPayload,
        isApplied: true,
        appliedAt,
        appliedById,
        lastSeenAt: existingListing?.lastSeenAt || now,
      },
      include: {
        appliedBy: {
          select: {
            id: true,
            fullName: true,
            role: true,
          },
        },
      },
    });

    const yourJob = await findYourJobForApplication(userId, {
      yourJobId: req.body.yourJobId,
      sourceListingId: req.body.sourceListingId,
      applyLink,
    });
    const application = yourJob
      ? await upsertJobApplication({
        userId,
        yourJob,
        listing,
        appliedAt: listing.appliedAt || appliedAt,
        appliedById,
        status: applicationStatus,
      })
      : null;

    return res.json({
      message: 'Job marked as applied',
      application: application ? serializeJobApplication(application) : {
        jobLink: listing.applyLink,
        employerName: listing.company,
        jobTitle: listing.title,
        status: applicationStatus,
        createdAt: listing.appliedAt?.toISOString() || now.toISOString(),
        appliedById: listing.appliedById,
      },
      job: {
        ...serializeListing(listing),
        applicationId: application?.id || null,
        applicationStatus,
        requiresStudentAction: false,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to mark job as applied', error: error.message });
  }
};

exports.markExternalViewed = async (req, res) => {
  try {
    const userId = resolveTargetUserId(req);
    const applyLink = compact(req.body.jobLink || req.body.applyLink);

    if (!applyLink) {
      return res.status(400).json({ message: 'jobLink is required' });
    }

    const existingListing = await prisma.userJobListing.findUnique({
      where: {
        userId_applyLink: {
          userId,
          applyLink,
        },
      },
      include: {
        appliedBy: {
          select: {
            id: true,
            fullName: true,
            role: true,
          },
        },
      },
    });

    const now = new Date();
    const viewedAt = existingListing
      ? compact(getListingMeta(existingListing.rawPayload).viewedAt) || now.toISOString()
      : now.toISOString();
    const rawPayload = mergeListingPayload(
      req.body.rawPayload || existingListing?.rawPayload || {},
      existingListing?.rawPayload || null,
      { viewedAt }
    );

    const listing = await prisma.userJobListing.upsert({
      where: {
        userId_applyLink: {
          userId,
          applyLink,
        },
      },
      create: {
        userId,
        sourceJobId: compact(req.body.externalId || req.body.jobId) || null,
        title: compact(req.body.jobTitle || req.body.title) || 'Untitled role',
        company: compact(req.body.employerName || req.body.company) || 'Unknown company',
        location: compact(req.body.location) || null,
        datePostedText: compact(req.body.datePosted) || null,
        postedAt: toPostedAtDate(req.body.datePosted),
        applyLink,
        source: 'JSEARCH',
        rawPayload,
        firstSeenAt: now,
        lastSeenAt: existingListing?.lastSeenAt || now,
      },
      update: {
        rawPayload,
      },
      include: {
        appliedBy: {
          select: {
            id: true,
            fullName: true,
            role: true,
          },
        },
      },
    });

    return res.json({
      message: 'Job marked as viewed',
      job: serializeListing(listing),
    });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to mark job as viewed', error: error.message });
  }
};

exports.getExternalAppliedStatus = async (req, res) => {
  try {
    const userId = resolveTargetUserId(req);
    const where = buildVisibleApplicationsWhere(userId);
    const applications = await prisma.userJobApplication.findMany({
      where,
      orderBy: [
        { appliedAt: 'desc' },
        { updatedAt: 'desc' },
      ],
      include: getJobApplicationInclude(),
    });

    const hydratedApplications = await hydrateApplicationsWithYourJobs(userId, applications);

    return res.json({
      applications: hydratedApplications.map((application) => ({
        ...serializeJobApplication(application),
        jobLink: application.applyLink,
        employerName: application.company,
        jobTitle: application.title,
        appliedMethod: application.appliedById ? 'ADMIN' : 'MANUAL',
        createdAt: application.appliedAt?.toISOString() || null,
        matchScore: application.matchingScore || 0,
      })),
    });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to load applied jobs', error: error.message });
  }
};

exports.getMyApplications = async (req, res) => {
  try {
    const userId = resolveTargetUserId(req);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit, 10) || 20, 1);
    const where = buildVisibleApplicationsWhere(userId, req.query.status);

    if (!where) {
      return res.json({
        applications: [],
        pagination: {
          total: 0,
          page,
          totalPages: 0,
        },
      });
    }

    const [total, applications] = await Promise.all([
      prisma.userJobApplication.count({ where }),
      prisma.userJobApplication.findMany({
        where,
        orderBy: [
          { appliedAt: 'desc' },
          { updatedAt: 'desc' },
        ],
        skip: (page - 1) * limit,
        take: limit,
        include: getJobApplicationInclude(),
      }),
    ]);

    const hydratedApplications = await hydrateApplicationsWithYourJobs(userId, applications);

    return res.json({
      applications: hydratedApplications.map(serializeJobApplication),
      pagination: {
        total,
        page,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to load applications', error: error.message });
  }
};

exports.updateApplicationStatus = async (req, res) => {
  try {
    const userId = resolveTargetUserId(req);
    const applicationId = compact(req.params.applicationId || req.params.id);
    const nextStatus = normalizeApplicationStatus(req.body.status);

    if (!applicationId) {
      return res.status(400).json({ message: 'applicationId is required' });
    }

    if (!APPLICATION_ADMIN_UPDATE_STATUSES.includes(nextStatus)) {
      return res.status(400).json({ message: 'Invalid application status' });
    }

    const existingApplication = await prisma.userJobApplication.findFirst({
      where: {
        id: applicationId,
        userId,
      },
      select: {
        id: true,
        sourceListingId: true,
        appliedAt: true,
        appliedById: true,
      },
    });

    if (!existingApplication) {
      return res.status(404).json({ message: 'Application not found' });
    }

    const appliedById = existingApplication.appliedById || req.user.id;
    const appliedAt = existingApplication.appliedAt || new Date();

    const [updatedApplication] = await Promise.all([
      prisma.userJobApplication.update({
        where: { id: existingApplication.id },
        data: {
          status: nextStatus,
          appliedById,
          appliedAt,
        },
        include: getJobApplicationInclude(),
      }),
      existingApplication.sourceListingId
        ? prisma.userJobListing.updateMany({
          where: { id: existingApplication.sourceListingId },
          data: {
            isApplied: true,
            appliedById,
            appliedAt,
          },
        })
        : Promise.resolve(),
    ]);

    return res.json({
      message: 'Application status updated',
      application: serializeJobApplication(updatedApplication),
    });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to update application status', error: error.message });
  }
};

exports.getStats = async (req, res) => {
  try {
    const userId = resolveTargetUserId(req);
    const [totalJobs, totalApplied, adminAppliedCount] = await Promise.all([
      prisma.userYourJob.count({ where: { userId } }),
      prisma.userJobApplication.count({ where: buildVisibleApplicationsWhere(userId) }),
      prisma.userJobApplication.count({
        where: {
          userId,
          OR: [
            { status: APPLICATION_STATUS_MENTOR_APPLIED },
            { status: APPLICATION_STATUS_LEGACY_APPLIED, appliedById: { not: null } },
          ],
        },
      }),
    ]);

    return res.json({
      totalJobs,
      totalMatchedJobs: totalJobs,
      externalAppliedCount: totalApplied,
      totalApplications: totalApplied,
      adminApplyCount: adminAppliedCount,
      candidateApplyCount: Math.max(totalApplied - adminAppliedCount, 0),
      lastSearch: null,
    });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to load job stats', error: error.message });
  }
};
