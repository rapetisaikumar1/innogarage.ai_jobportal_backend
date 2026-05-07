const prisma = require('../config/database');
const jobScraperService = require('../services/jobScraperService');
const resumeService = require('../services/resumeService');
const jsJobSearchService = require('../services/jsJobSearchService');
const aiService = require('../services/aiService');
const { PDFParse } = require('pdf-parse');
const axios = require('axios');

const crypto = require('crypto');
const dns = require('dns');
const https = require('https');
const config = require('../config');

// JOB_SEARCH_MODE: 'js' = JavaScript direct search, 'n8n' = n8n webhook (default: 'js')
const JOB_SEARCH_MODE = process.env.JOB_SEARCH_MODE || 'js';

// Force IPv4 to avoid AggregateError on Render/cloud platforms
const n8nAxios = axios.create({
  timeout: 20000,
  httpsAgent: new https.Agent({ family: 4, keepAlive: true }),
});

// Cache n8n form field discovery (avoids re-fetching HTML every trigger)
const n8nFormFieldsCache = { fields: null, expiry: 0 };

// Google Sheet config
const GOOGLE_SHEET_ID = '1oBInp6BCblszz6RWdmhok3tlsRUfKX8BoEYs5uB0j6g';
const GOOGLE_SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/export?format=csv&gid=0`;
const GOOGLE_SHEET_CACHE_TTL_MS = 2 * 60 * 1000;
const GOOGLE_SHEET_TIMEOUT_MS = 15000;
const DASHBOARD_STATS_CACHE_TTL_MS = 30 * 1000;

const googleSheetCache = {
  jobs: [],
  expiry: 0,
  pendingPromise: null,
};

const dashboardStatsCache = new Map();
const matchedJobsCache = new Map(); // userId -> { data, expiry }
const MATCHED_JOBS_TTL_MS = 5 * 60 * 1000; // 5 minutes

const invalidateGoogleSheetCache = () => {
  googleSheetCache.jobs = [];
  googleSheetCache.expiry = 0;
  googleSheetCache.pendingPromise = null;
};

const invalidateDashboardStatsCache = (userId) => {
  if (userId) {
    dashboardStatsCache.delete(userId);
    return;
  }

  dashboardStatsCache.clear();
};

const invalidateMatchedJobsCache = (userId) => {
  if (userId) { matchedJobsCache.delete(userId); return; }
  matchedJobsCache.clear();
};

const invalidateUserJobCaches = (userId) => {
  invalidateGoogleSheetCache();
  invalidateDashboardStatsCache(userId);
  invalidateMatchedJobsCache(userId);
};

const parseJsonField = (value, fallback = []) => {
  if (value == null) return fallback;
  if (Array.isArray(value) || typeof value === 'object') return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const RESUME_STOP_WORDS = new Set([
  'about', 'above', 'across', 'after', 'again', 'against', 'also', 'among', 'and', 'any', 'are', 'as', 'at', 'be', 'been',
  'being', 'but', 'by', 'can', 'company', 'could', 'day', 'description', 'do', 'does', 'during', 'each', 'for', 'from',
  'has', 'have', 'having', 'here', 'how', 'in', 'into', 'is', 'it', 'its', 'job', 'more', 'must', 'not', 'of', 'on', 'or',
  'our', 'position', 'required', 'requirements', 'role', 'should', 'team', 'than', 'that', 'the', 'their', 'this', 'to',
  'use', 'using', 'we', 'will', 'with', 'work', 'you', 'your'
]);

const RESUME_SKILL_TERMS = [
  'Adobe Experience Platform', 'AEP', 'Adobe Journey Optimizer', 'AJO', 'Real-Time CDP', 'RT-CDP', 'Customer Journey Analytics',
  'CJA', 'Adobe Analytics', 'Adobe Target', 'Adobe Launch', 'Data Collection', 'Adobe Campaign', 'XDM', 'Identity Resolution',
  'SQL', 'JavaScript', 'Python', 'React', 'Node.js', 'AWS', 'Azure', 'Git', 'Jenkins', 'Azure DevOps', 'Jira', 'Agile',
  'REST API', 'APIs', 'Data Governance', 'GDPR', 'CCPA', 'Tag Management', 'ETL', 'CI/CD', 'Dashboarding', 'Tableau',
  'A/B Testing', 'Segmentation', 'Attribution', 'Journey Orchestration', 'Marketing Automation', 'Stakeholder Management',
  'Program Governance', 'Delivery Leadership', 'Risk Management', 'Quarterly Business Review', 'QBR'
];

const ACTION_VERBS = [
  'Architected', 'Delivered', 'Optimized', 'Led', 'Implemented', 'Designed', 'Automated', 'Integrated', 'Analyzed', 'Improved',
  'Accelerated', 'Standardized', 'Orchestrated', 'Resolved', 'Launched', 'Enhanced', 'Governed', 'Collaborated', 'Streamlined'
];

const normalizeResumeToken = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9+#.\s-]/g, ' ').replace(/\s+/g, ' ').trim();

const extractResumeKeywords = (text, extraSkills = [], limit = 36) => {
  const source = normalizeResumeToken(text);
  const foundTerms = [];

  for (const term of RESUME_SKILL_TERMS.concat(extraSkills || [])) {
    const cleanTerm = String(term || '').trim();
    if (!cleanTerm) continue;
    const escaped = cleanTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(text || source)) foundTerms.push(cleanTerm);
  }

  const counts = new Map();
  source.split(/\s+/).forEach((word) => {
    if (!word || word.length < 3 || RESUME_STOP_WORDS.has(word) || /^\d+$/.test(word)) return;
    counts.set(word, (counts.get(word) || 0) + 1);
  });

  const rankedWords = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([word]) => word.replace(/\b\w/g, (char) => char.toUpperCase()));

  return [...new Set([...foundTerms, ...rankedWords])].slice(0, limit);
};

const calculateResumeIntelligence = ({ jd = '', resumeText = '', userSkills = [], existingScore = 0 }) => {
  const jdKeywords = extractResumeKeywords(jd, userSkills, 42);
  const resumeNormalized = normalizeResumeToken(resumeText);
  const matchedKeywords = jdKeywords.filter((keyword) => resumeNormalized.includes(normalizeResumeToken(keyword)));
  const missingKeywords = jdKeywords.filter((keyword) => !matchedKeywords.includes(keyword)).slice(0, 12);
  const coverage = jdKeywords.length ? Math.round((matchedKeywords.length / jdKeywords.length) * 100) : 0;
  const score = Math.max(parseInt(existingScore, 10) || 0, Math.min(98, Math.round((coverage * 0.7) + (matchedKeywords.length >= 12 ? 20 : matchedKeywords.length * 1.5))));

  return {
    score,
    coverage,
    jdKeywords,
    matchedKeywords: matchedKeywords.slice(0, 18),
    missingKeywords,
    actionVerbs: ACTION_VERBS.slice(0, 10),
    suggestions: [
      missingKeywords.length ? `Naturally include ${missingKeywords.slice(0, 4).join(', ')} where they match real experience.` : 'Keyword coverage is strong for this JD.',
      'Start experience bullets with direct action verbs and keep them impact-focused.',
      'Keep the resume single-column with standard headings for ATS parsing.',
      'Use the JD title in the resume header and align the summary to the selected role.',
    ],
  };
};

const isReusableGeneratedResume = (text) => {
  if (!text || typeof text !== 'string') return false;
  const clean = text.trim();
  if (clean.length < 1200) return false;
  // Skills section name varies by user's resume format — only require SUMMARY + EXPERIENCE
  return /PROFESSIONAL\s+SUMMARY/i.test(clean)
    && /(?:PROFESSIONAL\s+EXPERIENCE|WORK\s+EXPERIENCE|EXPERIENCE)/i.test(clean);
};

const parseResumePdfBuffer = async (buffer) => {
  const parser = new PDFParse({ data: buffer });
  try {
    const parsed = await parser.getText();
    return (parsed.text || '').trim();
  } finally {
    await parser.destroy();
  }
};

const getParsedResumeTextForUser = async (user) => {
  const existingText = (user.parsedResumeText || '').trim();
  if (existingText.length >= 800) return existingText;

  if (!user.resumeUrl) return existingText;

  try {
    const response = await axios.get(user.resumeUrl, {
      responseType: 'arraybuffer',
      timeout: 20000,
      maxContentLength: 15 * 1024 * 1024,
    });
    const parsedText = await parseResumePdfBuffer(Buffer.from(response.data));
    if (parsedText.length >= 800) {
      await prisma.user.update({
        where: { id: user.id },
        data: { parsedResumeText: parsedText.substring(0, 20000) },
      });
      return parsedText.substring(0, 20000);
    }
  } catch (error) {
    console.error('Uploaded resume parse error:', error.message || error);
  }

  return existingText;
};
// Export so admin controller can reuse without duplicating PDF-parse logic
exports._getParsedResumeTextForUser = getParsedResumeTextForUser;
exports._invalidateMatchedJobsCache = invalidateMatchedJobsCache;

const mapSavedJobToListing = (job, user = {}) => ({
  id: job.id,
  employer_name: job.employerName,
  job_title: job.jobTitle,
  job_city: job.jobCity,
  job_state: job.jobState,
  job_country: job.jobCountry,
  job_employment_type: job.employmentType,
  job_apply_link: job.applyLink?.startsWith('http') ? job.applyLink : null,
  employer_logo: job.employerLogo,
  source: job.source,
  posted: job.postedAt,
  jd: job.jd,
  match_score: job.matchScore,
  strong_matches: JSON.stringify(job.strongMatches),
  missing_skills: JSON.stringify(job.missingSkills),
  match_summary: job.matchSummary,
  resume_text: job.resumeText,
  original_resume: job.originalResume,
  job_min_salary: job.salaryMin,
  job_max_salary: job.salaryMax,
  job_salary_currency: job.salaryCurrency,
  saved_at: job.createdAt,
  candidate_id: user.id || job.userId || '',
  candidate_name: user.fullName || '',
  email: user.email || '',
});

const normalizeSavedJobDedupeKey = (job) => [job.employerName, job.jobTitle, job.jobCountry]
  .map(value => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim())
  .join('|');

const saveSearchResultsForUser = async (userId, results) => {
  const seenLinks = new Set();
  const topResults = (results || [])
    .filter((job) => job.job_apply_link && job.job_apply_link.startsWith('http'))
    .filter((job) => {
      const key = job.job_apply_link.toLowerCase();
      if (seenLinks.has(key)) return false;
      seenLinks.add(key);
      return true;
    })
    .sort((a, b) => (parseInt(b.match_score, 10) || 0) - (parseInt(a.match_score, 10) || 0))
    .slice(0, 30);

  const saved = [];

  for (const result of topResults) {
    const data = {
      userId,
      employerName: result.employer_name || null,
      jobTitle: result.job_title || null,
      jobCity: result.job_city || null,
      jobState: result.job_state || null,
      jobCountry: result.job_country || null,
      employmentType: result.job_employment_type || null,
      applyLink: result.job_apply_link || null,
      employerLogo: result.employer_logo || null,
      source: result.source || result.job_publisher || null,
      postedAt: result.posted || result.timestamp || null,
      jd: result.jd || null,
      matchScore: parseInt(result.match_score, 10) || 0,
      strongMatches: parseJsonField(result.strong_matches),
      missingSkills: parseJsonField(result.missing_skills),
      matchSummary: result.match_summary || null,
      resumeText: result.resume_text || null,
    };

    const existing = await prisma.savedJobResult.findFirst({
      where: {
        userId,
        OR: [
          { applyLink: data.applyLink },
          {
            employerName: data.employerName,
            jobTitle: data.jobTitle,
            jobCountry: data.jobCountry,
          },
        ],
      },
      select: { id: true, resumeText: true },
    });

    if (!data.resumeText && existing?.resumeText) {
      data.resumeText = existing.resumeText;
    }

    const savedJob = existing
      ? await prisma.savedJobResult.update({ where: { id: existing.id }, data })
      : await prisma.savedJobResult.create({ data });

    saved.push(savedJob);
  }

  return saved;
};

// Parse CSV text into array of objects
function parseCSV(text) {
  const lines = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      lines.push(current);
      current = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (current || lines.length) {
        lines.push(current);
        current = '';
      }
      if (lines.length) {
        // yield the row
        if (!parseCSV._rows) parseCSV._rows = [];
        parseCSV._rows.push([...lines]);
        lines.length = 0;
      }
    } else {
      current += ch;
    }
  }
  // last field / row
  if (current || lines.length) {
    lines.push(current);
    if (!parseCSV._rows) parseCSV._rows = [];
    parseCSV._rows.push([...lines]);
  }
  const rows = parseCSV._rows || [];
  parseCSV._rows = null;
  return rows;
}

const mapGoogleSheetRowsToJobs = (rows) => {
  if (rows.length < 2) return [];

  const headers = rows[0].map((header) => header.trim().toLowerCase());

  return rows.slice(1).map((row, idx) => {
    const obj = {};
    headers.forEach((header, i) => {
      obj[header] = (row[i] || '').trim();
    });

    return {
      id: idx + 1,
      candidate_id: obj['candidate_id'] || obj['candidate id'] || '',
      candidate_email: obj['email'] || obj['candidate_email'] || obj['candidate email'] || '',
      employer_name: obj['employer_name'] || obj['employer name'] || '',
      job_title: obj['job_title'] || obj['job title'] || '',
      job_city: obj['job_city'] || obj['job city'] || obj['location'] || '',
      job_state: obj['job_state'] || obj['job state'] || '',
      job_country: obj['job_country'] || obj['job country'] || '',
      job_employment_type: obj['job_employment_type'] || obj['job employment type'] || obj['employment_type'] || '',
      match_score: obj['match_score'] || obj['match score'] || '',
      job_apply_link: obj['job_apply_link'] || obj['job apply link'] || '',
      timestamp: obj['timestamp'] || '',
      candidate_name: obj['candidate_name'] || obj['candidate name'] || '',
      match_summary: obj['match_summary'] || obj['match summary'] || '',
      strong_matches: obj['strong_matches'] || obj['strong matches'] || '',
      partial_matches: obj['partial_matches'] || obj['partial matches'] || '',
      missing_skills: obj['missing_skills'] || obj['missing skills'] || '',
      pdf_link: obj['pdf_link'] || obj['pdf link'] || '',
      jd: obj['jd'] || obj['job_description'] || obj['job description'] || '',
      resume_text: obj['resume_text'] || obj['resume text'] || obj['resume'] || obj['tailored_resume'] || obj['tailored resume'] || '',
    };
  }).filter((job) => job.employer_name);
};

const filterJobsForUser = (jobs, userId, userEmail) => jobs.filter((job) => (
  job.candidate_id === userId || job.candidate_email === userEmail
));

const fetchGoogleSheetJobsFresh = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_SHEET_TIMEOUT_MS);

  try {
    const response = await fetch(GOOGLE_SHEET_CSV_URL, {
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error('Failed to fetch Google Sheet');
    }

    const csvText = await response.text();
    const jobs = mapGoogleSheetRowsToJobs(parseCSV(csvText));

    googleSheetCache.jobs = jobs;
    googleSheetCache.expiry = Date.now() + GOOGLE_SHEET_CACHE_TTL_MS;

    return jobs;
  } catch (error) {
    if (googleSheetCache.jobs.length > 0) {
      return googleSheetCache.jobs;
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const getGoogleSheetJobsCached = async ({ forceRefresh = false } = {}) => {
  const hasFreshCache = googleSheetCache.jobs.length > 0 && Date.now() < googleSheetCache.expiry;

  if (!forceRefresh && hasFreshCache) {
    return googleSheetCache.jobs;
  }

  if (!forceRefresh && googleSheetCache.pendingPromise) {
    return googleSheetCache.pendingPromise;
  }

  googleSheetCache.pendingPromise = fetchGoogleSheetJobsFresh()
    .finally(() => {
      googleSheetCache.pendingPromise = null;
    });

  return googleSheetCache.pendingPromise;
};

// Fetch Google Sheet data — filtered per logged-in user
exports.getGoogleSheetJobs = async (req, res) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;

    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const allJobs = await getGoogleSheetJobsCached({ forceRefresh });
    const jobs = filterJobsForUser(allJobs, userId, userEmail);

    res.json({ jobs });
  } catch (error) {
    console.error('Google Sheet fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch jobs from Google Sheet', error: error.message });
  }
};

// Build multipart/form-data body manually.
// Text fields must NOT have Content-Type headers (busboy requirement).
function buildMultipartBody(textFields, fileFields) {
  const boundary = '----FormBoundary' + crypto.randomBytes(8).toString('hex');
  const CRLF = '\r\n';
  const parts = [];

  for (const [name, value] of Object.entries(textFields)) {
    parts.push(Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`
    ));
  }

  for (const file of fileFields) {
    parts.push(Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"${CRLF}Content-Type: ${file.contentType}${CRLF}${CRLF}`
    ));
    parts.push(file.data);
    parts.push(Buffer.from(CRLF));
  }

  parts.push(Buffer.from(`--${boundary}--${CRLF}`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

// Plan limits for job searches
const PLAN_LIMITS = {
  free: { maxSearches: 5, label: 'Free' },
  basic: { maxSearches: 35, label: 'Basic' },
  pro: { maxSearches: 200, label: 'Pro' },
  ultra: { maxSearches: 999999, label: 'Ultra' },
};

const normalizePlan = (plan) => String(plan || 'free').toLowerCase();
const getPlanLimit = (plan) => PLAN_LIMITS[normalizePlan(plan)] || PLAN_LIMITS.free;

// Reset search count if a new day has started
const resetSearchCountIfNeeded = async (user) => {
  const now = new Date();
  const last = user.lastSearchReset ? new Date(user.lastSearchReset) : null;
  if (!last || last.toDateString() !== now.toDateString()) {
    await prisma.user.update({
      where: { id: user.id },
      data: { jobSearchCount: 0, lastSearchReset: now },
    });
    return 0;
  }
  return user.jobSearchCount || 0;
};

// Auto-verify Stripe session and update plan if payment completed but plan never saved
const autoVerifyStripeSession = async (user) => {
  try {
    if (user.subscriptionPlan && normalizePlan(user.subscriptionPlan) !== 'free') return normalizePlan(user.subscriptionPlan);
    if (!user.stripeSessionId) return user.subscriptionPlan || 'free';

    const config = require('../config');
    const secretKey = config.stripe.secretKey;
    if (!secretKey) return user.subscriptionPlan || 'free';

    const { data: session } = await axios.get(
      `https://api.stripe.com/v1/checkout/sessions/${user.stripeSessionId}`,
      { headers: { 'Authorization': `Bearer ${secretKey}` } }
    );

    if (session.payment_status === 'paid' && session.metadata?.plan) {
      const plan = normalizePlan(session.metadata.plan);
      await prisma.user.update({
        where: { id: user.id },
        data: {
          subscriptionPlan: plan,
          subscriptionStatus: 'active',
          subscriptionStart: new Date(),
        },
      });
      console.log(`Auto-verify: Updated user ${user.email} to plan: ${plan}`);
      return plan;
    }
    return user.subscriptionPlan || 'free';
  } catch (err) {
    console.error('Auto-verify Stripe session error:', err.message);
    return user.subscriptionPlan || 'free';
  }
};

// Get usage stats for the current user
exports.getUsage = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, subscriptionPlan: true, stripeSessionId: true, jobSearchCount: true, lastSearchReset: true },
    });
    // Self-healing: if plan is free but a Stripe session exists, auto-verify payment
    const plan = normalizePlan(await autoVerifyStripeSession(user));
    const limit = getPlanLimit(plan);
    const used = await resetSearchCountIfNeeded(user);
    res.json({ plan, used, max: limit.maxSearches, label: limit.label });
  } catch (err) {
    res.status(500).json({ message: 'Failed to get usage', error: err.message });
  }
};

// Trigger job search directly and save results for immediate frontend display.
exports.triggerN8nWorkflow = async (req, res) => {
  try {
    const userId = req.user.id;
    invalidateUserJobCaches(userId);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, fullName: true, email: true, keySkills: true,
        resumeUrl: true, parsedResumeText: true, jobRole: true, location: true, experience: true, education: true,
        subscriptionPlan: true, stripeSessionId: true, jobSearchCount: true, lastSearchReset: true,
      },
    });

    if (!user) return res.status(404).json({ message: 'User not found' });

    // Self-healing plan check
    const plan = normalizePlan(await autoVerifyStripeSession(user));
    const limit = getPlanLimit(plan);
    const used = await resetSearchCountIfNeeded(user);

    if (used >= limit.maxSearches) {
      return res.status(403).json({
        message: `You've reached your ${limit.label} plan limit of ${limit.maxSearches} searches today. Upgrade for more!`,
        limitReached: true,
        used,
        max: limit.maxSearches,
      });
    }

    const days = Math.min(30, Math.max(1, parseInt(req.body.days, 10) || 1));
    const results = await jsJobSearchService.searchJobs(user, days);
    const savedJobs = await saveSearchResultsForUser(userId, results);

    // Increment search count and update lastSearchReset
    try {
      await prisma.user.update({
        where: { id: userId },
        data: { jobSearchCount: { increment: 1 }, lastSearchReset: new Date() },
      });
    } catch (err) {
      console.error('Failed to increment search count:', err.message);
    }

    invalidateDashboardStatsCache(userId);
    invalidateMatchedJobsCache(userId);

    return res.json({
      message: savedJobs.length > 0
        ? `Found ${savedJobs.length} matching job${savedJobs.length === 1 ? '' : 's'}.`
        : 'No matching jobs found for this profile and time window.',
      jobs: savedJobs.map((job) => mapSavedJobToListing(job, user)),
      mode: 'js',
    });
  } catch (error) {
    console.error('Job search error:', error.message || error);
    console.error('Job search stack:', error.stack);
    res.status(500).json({ message: 'Failed to trigger job search', error: error.message || String(error) });
  }
};

// Get all jobs with filters
exports.getJobs = async (req, res) => {
  try {
    const { search, source, type, location, page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = { isActive: true };

    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { company: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (source) where.source = source;
    if (type) where.applicationType = type;
    if (location) where.location = { contains: location, mode: 'insensitive' };

    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where,
        orderBy: { datePosted: 'desc' },
        skip,
        take: parseInt(limit),
      }),
      prisma.job.count({ where }),
    ]);

    res.json({
      jobs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch jobs', error: error.message });
  }
};

// Get single job
exports.getJob = async (req, res) => {
  try {
    const job = await prisma.job.findUnique({
      where: { id: req.params.id },
    });

    if (!job) {
      return res.status(404).json({ message: 'Job not found' });
    }

    res.json(job);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch job', error: error.message });
  }
};

// Scrape jobs
exports.scrapeJobs = async (req, res) => {
  try {
    const { searchTerm, location } = req.body;
    const result = await jobScraperService.scrapeAllJobs(searchTerm, location);
    res.json({ message: 'Job scraping completed', ...result });
  } catch (error) {
    res.status(500).json({ message: 'Job scraping failed', error: error.message });
  }
};

// Add sample jobs
exports.addSampleJobs = async (req, res) => {
  try {
    const result = await jobScraperService.addSampleJobs();
    res.json({ message: 'Sample jobs added', ...result });
  } catch (error) {
    res.status(500).json({ message: 'Failed to add sample jobs', error: error.message });
  }
};

// Apply for a job
exports.applyForJob = async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.user.id;

    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) {
      return res.status(404).json({ message: 'Job not found' });
    }

    // Check if already applied
    const existing = await prisma.jobApplication.findUnique({
      where: { userId_jobId: { userId, jobId } },
    });

    if (existing) {
      return res.status(409).json({ message: 'Already applied for this job' });
    }

    // Get user profile for resume generation
    const user = await prisma.user.findUnique({ where: { id: userId } });

    // Generate tailored resume
    let tailoredResume = null;
    try {
      const resumeResult = await resumeService.generateTailoredResume(user, job);
      tailoredResume = await prisma.tailoredResume.create({
        data: {
          userId,
          jobId,
          resumeUrl: resumeResult.filePath,
          matchScore: resumeResult.matchScore,
          keywords: resumeResult.keywords,
        },
      });
    } catch (error) {
      console.error('Resume generation error:', error);
    }

    const application = await prisma.jobApplication.create({
      data: {
        userId,
        jobId,
        status: 'APPLIED',
        isAutoApplied: job.applicationType === 'EASY_APPLY',
        resumeUsed: tailoredResume?.resumeUrl || user.resumeUrl,
      },
      include: { job: true },
    });

    // Create notification
    await prisma.notification.create({
      data: {
        userId,
        title: 'Application Submitted',
        message: `You have applied for ${job.title} at ${job.company}`,
        type: 'application',
      },
    });

    invalidateDashboardStatsCache(userId);

    res.status(201).json({
      message: 'Application submitted successfully',
      application,
      tailoredResume,
    });
  } catch (error) {
    res.status(500).json({ message: 'Application failed', error: error.message });
  }
};

// Easy Apply - bulk apply for all easy apply jobs
exports.easyApplyAll = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    // Get all easy apply jobs not yet applied
    const appliedJobIds = await prisma.jobApplication.findMany({
      where: { userId },
      select: { jobId: true },
    });

    const appliedIds = appliedJobIds.map(a => a.jobId);

    const easyApplyJobs = await prisma.job.findMany({
      where: {
        applicationType: 'EASY_APPLY',
        isActive: true,
        id: { notIn: appliedIds },
      },
    });

    const results = [];
    for (const job of easyApplyJobs) {
      try {
        // Generate tailored resume
        let resumeUrl = user.resumeUrl;
        try {
          const resumeResult = await resumeService.generateTailoredResume(user, job);
          await prisma.tailoredResume.upsert({
            where: { userId_jobId: { userId, jobId: job.id } },
            update: { resumeUrl: resumeResult.filePath, matchScore: resumeResult.matchScore, keywords: resumeResult.keywords },
            create: { userId, jobId: job.id, resumeUrl: resumeResult.filePath, matchScore: resumeResult.matchScore, keywords: resumeResult.keywords },
          });
          resumeUrl = resumeResult.filePath;
        } catch (e) {
          console.error('Resume generation error for job:', job.id, e.message);
        }

        const application = await prisma.jobApplication.create({
          data: {
            userId,
            jobId: job.id,
            status: 'APPLIED',
            isAutoApplied: true,
            resumeUsed: resumeUrl,
          },
        });
        results.push({ jobId: job.id, status: 'applied', title: job.title });
      } catch (error) {
        results.push({ jobId: job.id, status: 'failed', error: error.message });
      }
    }

    if (results.filter(r => r.status === 'applied').length > 0) {
      await prisma.notification.create({
        data: {
          userId,
          title: 'Bulk Apply Complete',
          message: `Applied to ${results.filter(r => r.status === 'applied').length} jobs automatically`,
          type: 'application',
        },
      });
    }

    invalidateDashboardStatsCache(userId);

    res.json({
      message: 'Easy apply completed',
      totalProcessed: results.length,
      applied: results.filter(r => r.status === 'applied').length,
      failed: results.filter(r => r.status === 'failed').length,
      results,
    });
  } catch (error) {
    res.status(500).json({ message: 'Easy apply failed', error: error.message });
  }
};

// Get user's applications
exports.getMyApplications = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const where = { userId: req.user.id };
    if (status) where.status = status;

    const [applications, total] = await Promise.all([
      prisma.jobApplication.findMany({
        where,
        include: {
          job: true,
          user: { select: { id: true, fullName: true, email: true, phone: true, avatarUrl: true, education: true, jobRole: true } },
        },
        orderBy: { appliedAt: 'desc' },
        skip,
        take: parseInt(limit),
      }),
      prisma.jobApplication.count({ where }),
    ]);

    // Enrich with appliedBy info
    const appliedByIds = [...new Set(applications.filter(a => a.appliedById).map(a => a.appliedById))];
    let appliedByMap = {};
    if (appliedByIds.length > 0) {
      const users = await prisma.user.findMany({
        where: { id: { in: appliedByIds } },
        select: { id: true, fullName: true, role: true },
      });
      users.forEach(u => { appliedByMap[u.id] = u; });
    }
    const enriched = applications.map(a => ({
      ...a,
      appliedBy: a.appliedById ? (appliedByMap[a.appliedById] || null) : null,
    }));

    res.json({
      applications: enriched,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch applications', error: error.message });
  }
};

// Update application status
exports.updateApplicationStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes, interviewDate, interviewLocation, interviewNotes } = req.body;

    // Only ADMIN and SUPER_ADMIN can update application status
    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ message: 'Not authorized to update application status' });
    }

    const data = {};
    if (status) data.status = status;
    if (notes !== undefined) data.notes = notes;
    if (interviewDate !== undefined) data.interviewDate = interviewDate ? new Date(interviewDate) : null;
    if (interviewLocation !== undefined) data.interviewLocation = interviewLocation;
    if (interviewNotes !== undefined) data.interviewNotes = interviewNotes;

    const application = await prisma.jobApplication.update({
      where: { id },
      data,
      include: {
        job: true,
        user: { select: { id: true, fullName: true, email: true } },
      },
    });

    invalidateDashboardStatsCache(application.user.id);

    res.json(application);
  } catch (error) {
    res.status(500).json({ message: 'Failed to update application', error: error.message });
  }
};

// Get all applications (Admin/Super Admin) — includes applicant info
exports.getAllApplications = async (req, res) => {
  try {
    const { status, page = 1, limit = 20, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const where = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { user: { fullName: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
        { job: { title: { contains: search, mode: 'insensitive' } } },
        { job: { company: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [applications, total] = await Promise.all([
      prisma.jobApplication.findMany({
        where,
        include: {
          job: true,
          user: { select: { id: true, fullName: true, email: true, phone: true, avatarUrl: true, education: true, jobRole: true } },
        },
        orderBy: { appliedAt: 'desc' },
        skip,
        take: parseInt(limit),
      }),
      prisma.jobApplication.count({ where }),
    ]);

    res.json({
      applications,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch applications', error: error.message });
  }
};

// Get dashboard stats
exports.getDashboardStats = async (req, res) => {
  try {
    const userId = req.user.id;
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const cachedStats = dashboardStatsCache.get(userId);

    if (!forceRefresh && cachedStats && Date.now() < cachedStats.expiry) {
      return res.json(cachedStats.data);
    }

    const [totalApplied, interviewScheduled, rejected, offerReceived, totalMatchedJobs, totalInternalJobs, dbAdminApplied, sheetAdminApplied, sheetTotalApplied] = await Promise.all([
      prisma.jobApplication.count({ where: { userId, status: 'APPLIED' } }),
      prisma.jobApplication.count({ where: { userId, status: 'INTERVIEW_SCHEDULED' } }),
      prisma.jobApplication.count({ where: { userId, status: 'REJECTED' } }),
      prisma.jobApplication.count({ where: { userId, status: 'OFFER_RECEIVED' } }),
      prisma.savedJobResult.count({ where: { userId, matchScore: { gte: 60 } } }),
      prisma.job.count({ where: { isActive: true } }),
      prisma.jobApplication.count({ where: { userId, appliedById: { not: null } } }),
      prisma.sheetJobApplication.count({ where: { userId, appliedById: { not: null } } }),
      prisma.sheetJobApplication.count({ where: { userId } }),
    ]);

    const manualPending = await prisma.job.count({
      where: {
        isActive: true,
        applicationType: 'MANUAL_APPLY',
        NOT: {
          applications: {
            some: { userId },
          },
        },
      },
    });

    const allDbApplied = totalApplied + interviewScheduled + rejected + offerReceived;
    const adminApplyCount = dbAdminApplied + sheetAdminApplied;
    const candidateApplyCount = (allDbApplied - dbAdminApplied) + (sheetTotalApplied - sheetAdminApplied);

    const stats = {
      totalJobs: totalMatchedJobs,
      totalSheetJobs: totalMatchedJobs,
      totalInternalJobs,
      totalApplied: allDbApplied,
      totalApplications: allDbApplied + sheetTotalApplied,
      interviewScheduled,
      rejected,
      offerReceived,
      manualPending,
      adminApplyCount,
      candidateApplyCount,
      sheetAppliedCount: sheetTotalApplied,
    };

    dashboardStatsCache.set(userId, {
      data: stats,
      expiry: Date.now() + DASHBOARD_STATS_CACHE_TTL_MS,
    });

    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch stats', error: error.message });
  }
};

// Get tailored resume for a job
exports.getTailoredResume = async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.user.id;

    let resume = await prisma.tailoredResume.findUnique({
      where: { userId_jobId: { userId, jobId } },
    });

    if (!resume) {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      const job = await prisma.job.findUnique({ where: { id: jobId } });

      if (!job) return res.status(404).json({ message: 'Job not found' });

      const result = await resumeService.generateTailoredResume(user, job);
      resume = await prisma.tailoredResume.create({
        data: {
          userId,
          jobId,
          resumeUrl: result.filePath,
          matchScore: result.matchScore,
          keywords: result.keywords,
        },
      });
    }

    res.json(resume);
  } catch (error) {
    res.status(500).json({ message: 'Failed to generate resume', error: error.message });
  }
};

// ══════════════════════════════════════════════════════════════
// AUTO-APPLY BOT — applies to all Google Sheet jobs for the user
// ══════════════════════════════════════════════════════════════

// Apply All — marks all sheet jobs as applied and returns links for browser
exports.autoApplyAllSheetJobs = async (req, res) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;

    const allJobs = await getGoogleSheetJobsCached({ forceRefresh: true });
    const myJobs = filterJobsForUser(allJobs, userId, userEmail);

    if (myJobs.length === 0) {
      return res.json({ message: 'No jobs found for your account', summary: { total: 0, readyToApply: 0, alreadyApplied: 0, noLink: 0 }, results: [], applyLinks: [] });
    }

    // 2. Check already-applied (best-effort)
    let appliedLinks = new Set();
    try {
      const existingApps = await prisma.sheetJobApplication.findMany({
        where: { userId },
        select: { jobLink: true },
      });
      appliedLinks = new Set(existingApps.map(a => a.jobLink));
    } catch { /* table may not exist yet */ }

    // 3. Process each job
    const results = [];
    const linksToOpen = [];

    for (const job of myJobs) {
      const link = job.job_apply_link;

      if (!link) {
        results.push({ employer: job.employer_name, status: 'NO_LINK', message: 'No apply link' });
        continue;
      }

      if (appliedLinks.has(link)) {
        results.push({ employer: job.employer_name, status: 'ALREADY_APPLIED', message: 'Already applied', link });
        continue;
      }

      // Mark as applied and queue link for opening in browser
      linksToOpen.push(link);
      results.push({ employer: job.employer_name, status: 'APPLIED', message: 'Open in browser to apply', link });

      // Save to DB (best-effort)
      try {
        await prisma.sheetJobApplication.upsert({
          where: { userId_jobLink: { userId, jobLink: link } },
          update: { status: 'APPLIED', appliedMethod: 'MANUAL', employerName: job.employer_name, matchScore: job.match_score, pdfLink: job.pdf_link },
          create: { userId, jobLink: link, status: 'APPLIED', appliedMethod: 'MANUAL', employerName: job.employer_name, matchScore: job.match_score, pdfLink: job.pdf_link },
        });
      } catch { /* ignore */ }
    }

    const readyToApply = results.filter(r => r.status === 'APPLIED').length;
    const alreadyApplied = results.filter(r => r.status === 'ALREADY_APPLIED').length;
    const noLink = results.filter(r => r.status === 'NO_LINK').length;

    // Create notification (best-effort)
    try {
      await prisma.notification.create({
        data: {
          userId,
          title: 'Apply All Complete',
          message: `Ready to apply: ${readyToApply} | Already applied: ${alreadyApplied} | No link: ${noLink}`,
          type: 'application',
        },
      });
    } catch { /* ignore */ }

    invalidateDashboardStatsCache(userId);

    res.json({
      message: `${readyToApply} job${readyToApply !== 1 ? 's' : ''} ready — opening in your browser`,
      summary: { total: myJobs.length, readyToApply, alreadyApplied, noLink },
      results,
      applyLinks: linksToOpen,
    });
  } catch (error) {
    console.error('Apply all error:', error.message);
    res.status(500).json({ message: 'Apply all failed', error: error.message });
  }
};

// Get applied status for all sheet jobs
exports.getSheetAppliedStatus = async (req, res) => {
  try {
    const userId = req.user.id;
    const applications = await prisma.sheetJobApplication.findMany({
      where: { userId },
      select: { jobLink: true, status: true, appliedMethod: true, appliedById: true, employerName: true, jobTitle: true, matchScore: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ applications });
  } catch (error) {
    // Table might not exist yet — return empty
    res.json({ applications: [] });
  }
};

// Mark a single sheet job as applied
exports.markSheetJobApplied = async (req, res) => {
  try {
    const userId = req.user.id;
    const { jobLink, employerName, matchScore, jobTitle } = req.body;
    if (!jobLink) return res.status(400).json({ message: 'jobLink is required' });

    const scoreStr = matchScore != null ? String(matchScore) : null;
    const application = await prisma.sheetJobApplication.upsert({
      where: { userId_jobLink: { userId, jobLink } },
      update: { status: 'APPLIED', appliedMethod: 'MANUAL', employerName, matchScore: scoreStr, jobTitle },
      create: { userId, jobLink, status: 'APPLIED', appliedMethod: 'MANUAL', employerName, matchScore: scoreStr, jobTitle },
    });

    invalidateDashboardStatsCache(userId);

    res.json({ message: 'Marked as applied', application });
  } catch (error) {
    res.status(500).json({ message: 'Failed to mark applied', error: error.message });
  }
};

// ══════════════════════════════════════════════════════════════
// AUTO-APPLY (Single Job) — AI + Playwright, streams NDJSON progress
// ══════════════════════════════════════════════════════════════
exports.autoApplyToJob = async (req, res) => {
  // Extend timeouts for this long-running request
  req.setTimeout(300000);
  res.setTimeout(300000);

  const userId = req.user.id;
  const { applyUrl, employerName, matchScore } = req.body;

  if (!applyUrl) {
    return res.status(400).json({ message: 'Apply URL is required' });
  }

  // Fetch full user profile
  let user;
  try {
    user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, fullName: true, email: true, phone: true,
        keySkills: true, jobRole: true, location: true,
        resumeUrl: true, linkedinProfile: true,
        education: true, experience: true,
      },
    });
  } catch (err) {
    return res.status(500).json({ message: 'Database error', error: err.message });
  }

  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  // Set headers for NDJSON streaming
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Progress callback — writes NDJSON lines to the response stream
  const onProgress = (event) => {
    try { res.write(JSON.stringify(event) + '\n'); } catch {}
  };

  try {
    const autoApplyService = require('../services/autoApplyService');
    const result = await autoApplyService.applyToJob(
      { applyUrl, employerName, matchScore },
      user,
      onProgress
    );

    // Save to DB (best-effort)
    try {
      await prisma.sheetJobApplication.upsert({
        where: { userId_jobLink: { userId, jobLink: applyUrl } },
        update: {
          status: result.success ? 'APPLIED' : 'FAILED',
          appliedMethod: 'BOT',
          employerName,
          matchScore: String(result.matchScore || matchScore || ''),
          pdfLink: result.resumeUrl || null,
          reportUrl: result.reportUrl || null,
        },
        create: {
          userId,
          jobLink: applyUrl,
          status: result.success ? 'APPLIED' : 'FAILED',
          appliedMethod: 'BOT',
          employerName,
          matchScore: String(result.matchScore || matchScore || ''),
          pdfLink: result.resumeUrl || null,
          reportUrl: result.reportUrl || null,
        },
      });

      invalidateDashboardStatsCache(userId);
    } catch (err) {
      console.error('Failed to save auto-apply record:', err.message);
    }

    // Create notification (best-effort)
    try {
      await prisma.notification.create({
        data: {
          userId,
          title: result.success ? 'Auto-Apply Successful' : 'Auto-Apply Attempted',
          message: `${result.success ? 'Applied' : 'Attempted'} to ${employerName || 'job'}${result.reportUrl ? '. Report generated.' : ''}`,
          type: 'application',
        },
      });
    } catch {}

    // Send final "done" event and close the stream
    onProgress({
      type: 'done',
      data: {
        success: result.success,
        message: result.success
          ? `Successfully applied to ${employerName || 'this job'}!`
          : `Application attempted for ${employerName || 'this job'}. Check the report for details.`,
        reportUrl: result.reportUrl,
        resumeUrl: result.resumeUrl,
        matchScore: result.matchScore,
        steps: result.steps,
        error: result.error,
      },
    });
  } catch (error) {
    console.error('Auto-apply endpoint error:', error.message);
    onProgress({
      type: 'done',
      data: {
        success: false,
        message: 'Auto-apply failed',
        error: error.message,
        steps: [],
      },
    });
  }

  res.end();
};

exports.clearJobCaches = async (req, res) => {
  invalidateUserJobCaches(req.user.id);
  res.json({ message: 'Backend caches cleared' });
};

// ─── Get saved job results for a user ───
exports.getSavedJobs = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const skip = (page - 1) * limit;
    const forceRefresh = req.query.refresh === '1';

    // Serve from cache on page 1 (the common case) unless forced refresh
    if (!forceRefresh && page === 1) {
      const cached = matchedJobsCache.get(userId);
      if (cached && Date.now() < cached.expiry) {
        return res.json(cached.data);
      }
    }

    const STRICT_MATCH_SCORE = 60;
    const FALLBACK_MATCH_SCORE = 45;

    // Single query: fetch enough rows to determine threshold and deduplicate
    // Default order: newest first (createdAt desc) — frontend sort controls handle score ordering
    const allJobs = await prisma.savedJobResult.findMany({
      where: { userId, matchScore: { gte: FALLBACK_MATCH_SCORE } },
      orderBy: [{ createdAt: 'desc' }],
      take: 200,
      select: {
        id: true, userId: true, employerName: true, jobTitle: true,
        jobCity: true, jobState: true, jobCountry: true, employmentType: true,
        applyLink: true, employerLogo: true, source: true, postedAt: true,
        jd: true, matchScore: true, strongMatches: true, missingSkills: true,
        matchSummary: true, resumeText: true, originalResume: true, createdAt: true,
      },
    });

    // Determine threshold from fetched rows (no second DB round-trip)
    const strictCount = allJobs.filter(j => (j.matchScore || 0) >= STRICT_MATCH_SCORE).length;
    const minScore = strictCount >= 10 ? STRICT_MATCH_SCORE : FALLBACK_MATCH_SCORE;
    const filtered = minScore === STRICT_MATCH_SCORE
      ? allJobs.filter(j => (j.matchScore || 0) >= STRICT_MATCH_SCORE)
      : allJobs;

    const deduped = [];
    const seenJobKeys = new Set();
    for (const job of filtered) {
      const key = normalizeSavedJobDedupeKey(job) || job.applyLink || job.id;
      if (seenJobKeys.has(key)) continue;
      seenJobKeys.add(key);
      deduped.push(job);
    }

    const jobs = deduped.slice(skip, skip + limit);
    const total = deduped.length;
    const mapped = jobs.map((job) => mapSavedJobToListing(job, req.user || {}));
    const responseData = { jobs: mapped, total, page, limit, minScore };

    // Cache page 1 result per user for 5 minutes
    if (page === 1) {
      matchedJobsCache.set(userId, { data: responseData, expiry: Date.now() + MATCHED_JOBS_TTL_MS });
    }

    res.json(responseData);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve saved jobs' });
  }
};

exports.analyzeJobDescription = async (req, res) => {
  try {
    const jd = req.body?.jd || req.body?.job_description || '';
    const resumeText = req.body?.resume_text || '';
    const userSkills = Array.isArray(req.body?.skills) ? req.body.skills : [];

    if (!jd || jd.trim().length < 80) {
      return res.status(400).json({ message: 'A full job description is required for JD analysis.' });
    }

    const analysis = calculateResumeIntelligence({ jd, resumeText, userSkills, existingScore: req.body?.match_score });
    res.json({
      jobTitle: req.body?.job_title || 'Target Role',
      keywords: analysis.jdKeywords,
      matchedKeywords: analysis.matchedKeywords,
      missingSkills: analysis.missingKeywords,
      suggestedActionVerbs: analysis.actionVerbs,
      suggestions: analysis.suggestions,
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to analyze job description', error: error.message || String(error) });
  }
};

exports.calculateResumeMatchScore = async (req, res) => {
  try {
    const jd = req.body?.jd || '';
    const resumeText = req.body?.resume_text || '';
    const userSkills = Array.isArray(req.body?.skills) ? req.body.skills : [];

    if (!jd || !resumeText) {
      return res.status(400).json({ message: 'Job description and resume text are required.' });
    }

    res.json(calculateResumeIntelligence({ jd, resumeText, userSkills, existingScore: req.body?.match_score }));
  } catch (error) {
    res.status(500).json({ message: 'Failed to calculate resume match score', error: error.message || String(error) });
  }
};

exports.saveGeneratedResumeText = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id, job_apply_link, resume_text } = req.body || {};
    if (!userId) return res.status(401).json({ message: 'Not authenticated' });
    if (!resume_text || resume_text.trim().length < 800) return res.status(400).json({ message: 'Resume text is too short to save.' });

    const where = id
      ? { id, userId }
      : { userId, applyLink: job_apply_link || undefined };
    const existing = await prisma.savedJobResult.findFirst({ where });
    if (!existing) return res.status(404).json({ message: 'Saved job was not found.' });

    const savedJob = await prisma.savedJobResult.update({
      where: { id: existing.id },
      data: { resumeText: resume_text.trim() },
    });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, fullName: true, email: true } });
    res.json({ message: 'Resume edits saved.', job: mapSavedJobToListing(savedJob, user || {}) });
  } catch (error) {
    res.status(500).json({ message: 'Failed to save resume edits', error: error.message || String(error) });
  }
};

exports.exportPdfInstructions = async (_req, res) => {
  res.json({
    message: 'PDF export is handled in the browser with selectable text and print-safe ATS spacing.',
    engine: 'html2pdf.js',
    atsRules: ['single-column layout', 'standard headings', 'readable fonts', 'selectable text', 'multi-page support'],
  });
};

// Generate or regenerate an ATS resume for a saved/external job.
exports.generateSavedJobResume = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Not authenticated' });

    const {
      job_apply_link,
      employer_name,
      job_title,
      job_city,
      job_state,
      job_country,
      job_employment_type,
      employer_logo,
      source,
      posted,
      jd,
      match_score,
      strong_matches,
      missing_skills,
      match_summary,
    } = req.body || {};

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        linkedinProfile: true,
        keySkills: true,
        jobRole: true,
        location: true,
        education: true,
        experience: true,
        resumeUrl: true,
        parsedResumeText: true,
      },
    });

    if (!user) return res.status(404).json({ message: 'User not found' });

    const existing = job_apply_link
      ? await prisma.savedJobResult.findFirst({ where: { userId, applyLink: job_apply_link } })
      : await prisma.savedJobResult.findFirst({
          where: {
            userId,
            employerName: employer_name || undefined,
            jobTitle: job_title || undefined,
          },
        });

    if (existing && isReusableGeneratedResume(existing.resumeText) && !req.body?.forceRegenerate) {
      return res.json({
        message: 'Existing ATS resume loaded.',
        job: mapSavedJobToListing(existing, user),
        provider: 'cached',
      });
    }

    const jobData = {
      job_apply_link: job_apply_link || existing?.applyLink || null,
      employer_name: employer_name || existing?.employerName || '',
      job_title: job_title || existing?.jobTitle || '',
      job_city: job_city || existing?.jobCity || '',
      job_state: job_state || existing?.jobState || '',
      job_country: job_country || existing?.jobCountry || '',
      job_employment_type: job_employment_type || existing?.employmentType || '',
      employer_logo: employer_logo || existing?.employerLogo || '',
      source: source || existing?.source || '',
      posted: posted || existing?.postedAt || '',
      jd: jd || existing?.jd || '',
      match_score: parseInt(match_score, 10) || existing?.matchScore || 0,
      strong_matches: strong_matches ?? existing?.strongMatches ?? [],
      missing_skills: missing_skills ?? existing?.missingSkills ?? [],
      match_summary: match_summary || existing?.matchSummary || '',
    };

    if (!jobData.jd) {
      return res.status(400).json({ message: 'Job description is required to create an ATS resume.' });
    }

    const parsedResumeText = await getParsedResumeTextForUser(user);
    if (!parsedResumeText || parsedResumeText.length < 800) {
      return res.status(400).json({
        message: 'Please upload a readable PDF resume in your profile before creating an ATS resume.',
      });
    }

    const generatedResume = await aiService.generateATSResumeText({ ...user, parsedResumeText }, jobData);
    const resumeText = typeof generatedResume === 'string' ? generatedResume : generatedResume?.text;
    const provider = typeof generatedResume === 'string' ? 'gemini' : generatedResume?.provider || 'fallback';
    if (!resumeText || !resumeText.trim()) {
      return res.status(500).json({ message: 'Failed to generate ATS resume.' });
    }

    const savedData = {
      userId,
      employerName: jobData.employer_name || null,
      jobTitle: jobData.job_title || null,
      jobCity: jobData.job_city || null,
      jobState: jobData.job_state || null,
      jobCountry: jobData.job_country || null,
      employmentType: jobData.job_employment_type || null,
      applyLink: jobData.job_apply_link || null,
      employerLogo: jobData.employer_logo || null,
      source: jobData.source || null,
      postedAt: jobData.posted || null,
      jd: jobData.jd || null,
      matchScore: parseInt(jobData.match_score, 10) || 0,
      strongMatches: parseJsonField(jobData.strong_matches),
      missingSkills: parseJsonField(jobData.missing_skills),
      matchSummary: jobData.match_summary || null,
      resumeText,
    };

    const savedJob = existing
      ? await prisma.savedJobResult.update({ where: { id: existing.id }, data: savedData })
      : await prisma.savedJobResult.create({ data: savedData });

    res.json({
      message: 'ATS resume created successfully.',
      job: mapSavedJobToListing(savedJob, user),
      provider,
      analysis: calculateResumeIntelligence({
        jd: jobData.jd,
        resumeText,
        userSkills: user.keySkills || [],
        existingScore: jobData.match_score,
      }),
    });
  } catch (error) {
    console.error('Generate ATS resume error:', error.message || error);
    res.status(500).json({ message: 'Failed to generate ATS resume', error: error.message || String(error) });
  }
};
