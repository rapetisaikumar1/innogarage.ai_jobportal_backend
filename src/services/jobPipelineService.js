/**
 * jobPipelineService.js
 *
 * Orchestrates the complete live job-search pipeline:
 *  1. Read student profile from Neon
 *  2. Extract resume opening summary
 *  3. Call Gemini to build search intent
 *  4. Fire parallel RapidAPI queries
 *  5. Normalize + deduplicate
 *  6. Score each job in memory
 *  7. Stream qualifying jobs (score ≥ 60) via SSE immediately
 *  8. Save top-50 matches + search run to Neon
 *
 * Usage limits:
 *   free  : 5 searches / day
 *   pro   : 30 searches / day
 *   ultra : unlimited
 */

const prisma                          = require('../config/database');
const { buildSearchIntent }           = require('./geminiIntentService');
const { fetchJobs }                   = require('./rapidApiService');
const { normalizeJob, deduplicateJobs } = require('./jobNormalizerService');
const { scoreJob }                    = require('./jobScoringService');

// ── Constants ─────────────────────────────────────────────────────────────────

const SCORE_THRESHOLD = 60;
const MAX_SAVED_MATCHES = 50;

const DAILY_LIMITS = {
  free:  5,
  pro:   30,
  ultra: Infinity,
};

// ── Resume intro extractor ────────────────────────────────────────────────────

const SUMMARY_HEADINGS = /^(summary|profile|objective|about|professional summary|career objective)/i;
const MAX_SUMMARY_CHARS = 700;

/**
 * Extract only the opening summary / profile section from full resume text.
 * Falls back to the first 700 characters when no heading is found.
 * @param {string} fullText  parsedResumeText from DB
 * @returns {string}
 */
function extractResumeIntro(fullText) {
  if (!fullText) return '';

  const lines = fullText.split('\n').map((l) => l.trim()).filter(Boolean);
  let startIdx = -1;

  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    if (SUMMARY_HEADINGS.test(lines[i])) {
      startIdx = i + 1;
      break;
    }
  }

  let chunk;
  if (startIdx >= 0) {
    // Take lines after the heading until next all-caps heading or 15 lines
    const summaryLines = [];
    for (let j = startIdx; j < lines.length && j < startIdx + 15; j++) {
      if (j > startIdx && /^[A-Z\s]{4,}$/.test(lines[j])) break; // next section heading
      summaryLines.push(lines[j]);
    }
    chunk = summaryLines.join(' ');
  } else {
    chunk = fullText.substring(0, MAX_SUMMARY_CHARS);
  }

  // Clean: collapse whitespace, strip stray email/phone patterns
  return chunk
    .replace(/[\w.-]+@[\w.-]+\.\w+/g, '')   // emails
    .replace(/\+?[\d\s\-().]{7,}/g, '')      // phone numbers
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, MAX_SUMMARY_CHARS);
}

// ── Usage check ────────────────────────────────────────────────────────────────

async function getDailyUsage(userId, plan) {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);

  const used = await prisma.jobSearchRun.count({
    where: {
      userId,
      status: { in: ['COMPLETED', 'RUNNING'] },
      createdAt: { gte: start },
    },
  });

  const planKey = (plan || 'free').toLowerCase();
  const max     = DAILY_LIMITS[planKey] ?? DAILY_LIMITS.free;

  return { used, max, plan: planKey };
}

// ── SSE helpers ───────────────────────────────────────────────────────────────

function sseWrite(res, payload) {
  try {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  } catch { /* client disconnected */ }
}

function sseStatus(res, message) {
  sseWrite(res, { type: 'status', message });
}

function sseJob(res, job) {
  sseWrite(res, { type: 'job', job });
}

function sseDone(res, count, message) {
  sseWrite(res, { type: 'done', count, message });
}

function sseError(res, message, limitReached = false) {
  sseWrite(res, { type: 'error', message, limitReached });
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

/**
 * Run the full live job-search pipeline and stream results via SSE.
 *
 * @param {object} opts
 * @param {string}  opts.userId    authenticated student / target student id
 * @param {object}  opts.res       Express Response object (SSE)
 * @param {number}  opts.days      look-back window (default 7)
 */
async function runJobSearchPipeline({ userId, res, days = 7 }) {
  const pipelineStart = Date.now();
  let searchRun = null;

  try {
    // ── 1. Read student profile ────────────────────────────────────────────
    sseStatus(res, 'Loading your profile…');

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        jobRole: true,
        experience: true,
        location: true,
        keySkills: true,
        parsedResumeText: true,
        subscriptionPlan: true,
        fullName: true,
      },
    });

    if (!user) {
      sseError(res, 'Student profile not found.');
      return;
    }

    // ── 2. Usage limit check ───────────────────────────────────────────────
    const usage = await getDailyUsage(userId, user.subscriptionPlan);
    if (usage.used >= usage.max) {
      sseError(
        res,
        `You've reached your daily search limit (${usage.max} searches). Upgrade your plan for more.`,
        true,
      );
      return;
    }

    // ── 3. Extract resume intro summary ───────────────────────────────────
    const resumeIntroSummary = extractResumeIntro(user.parsedResumeText);

    const profile = {
      jobRole:            user.jobRole      || '',
      experience:         user.experience   || '',
      location:           user.location     || '',
      skills:             user.keySkills    || [],
      resumeIntroSummary,
    };

    // ── 4. Gemini: build search intent ────────────────────────────────────
    sseStatus(res, 'Analysing your profile with AI…');

    let intent;
    try {
      intent = await buildSearchIntent(profile);
    } catch (geminiErr) {
      console.error('[pipeline] Gemini intent failed:', geminiErr.message);
      // Graceful fallback: build a simple intent from raw profile data
      intent = {
        normalizedRole:       profile.jobRole || 'Software Engineer',
        titleVariants:        [],
        searchQueries:        [
          `${profile.jobRole} ${profile.location}`.trim(),
          `${profile.jobRole} developer`.trim(),
        ].filter(Boolean),
        seniority:            'any',
        seniorityRange:       { minYears: 0, maxYears: 20 },
        skillKeywords:        profile.skills,
        locationVariants:     [profile.location, 'remote'].filter(Boolean),
        exclusionKeywords:    [],
        cleanedResumeSummary: resumeIntroSummary,
      };
    }

    // ── 5. Create search run record ───────────────────────────────────────
    searchRun = await prisma.jobSearchRun.create({
      data: {
        userId,
        queries: intent.searchQueries,
        status: 'RUNNING',
      },
    });

    // ── 6. RapidAPI: fetch jobs ────────────────────────────────────────────
    sseStatus(res, `Searching live jobs for "${intent.normalizedRole}"…`);

    const rawJobs = await fetchJobs(intent.searchQueries, days);

    if (rawJobs.length === 0) {
      sseStatus(res, 'No results from job sources — try broadening your search.');
      sseDone(res, 0, 'No jobs found for this search. Try updating your profile.');
      await prisma.jobSearchRun.update({
        where: { id: searchRun.id },
        data: { status: 'COMPLETED', jobsFound: 0, durationMs: Date.now() - pipelineStart, completedAt: new Date() },
      });
      return;
    }

    // ── 7. Normalize + deduplicate ─────────────────────────────────────────
    sseStatus(res, `Processing ${rawJobs.length} job listings…`);

    const normalized = deduplicateJobs(rawJobs.map(normalizeJob)).filter((j) => j.applyLink);

    // ── 8. Score + stream ─────────────────────────────────────────────────
    sseStatus(res, 'Scoring jobs against your profile…');

    const qualifyingJobs = [];

    for (const job of normalized) {
      const { score, summary, strongMatches, skillGaps } = scoreJob(job, intent);

      if (score < SCORE_THRESHOLD) continue;

      // Build the enriched job object (what frontend + DB both consume)
      const enriched = {
        ...job,
        match_score:    score,
        match_summary:  summary,
        strong_matches: strongMatches,
        skill_gaps:     skillGaps,
        matchScore:     score,
        matchSummary:   summary,
        strongMatches,
        skillGaps,
        saved_at:       new Date().toISOString(),
      };

      // Stream to frontend immediately
      sseJob(res, enriched);
      qualifyingJobs.push(enriched);
    }

    // ── 9. Persist top matches ─────────────────────────────────────────────
    const toSave = qualifyingJobs
      .sort((a, b) => b.match_score - a.match_score)
      .slice(0, MAX_SAVED_MATCHES);

    if (toSave.length > 0) {
      // Use individual upserts inside a transaction — handles the unique(userId,applyLink) constraint
      await prisma.$transaction(
        toSave.map((j) =>
          prisma.jobMatch.upsert({
            where: { userId_applyLink: { userId, applyLink: j.applyLink } },
            create: {
              userId,
              runId:         searchRun.id,
              externalId:    j.externalId,
              applyLink:     j.applyLink,
              title:         j.title,
              company:       j.company,
              location:      j.location   || null,
              employmentType:j.employmentType || null,
              description:   (j.description || '').substring(0, 8000),
              salary:        j.salary     || null,
              postedAt:      j.postedAt   || null,
              matchScore:    j.match_score,
              matchSummary:  j.match_summary,
              strongMatches: j.strong_matches,
              skillGaps:     j.skill_gaps,
              rawPayload:    j,
            },
            update: {
              runId:         searchRun.id,
              matchScore:    j.match_score,
              matchSummary:  j.match_summary,
              strongMatches: j.strong_matches,
              skillGaps:     j.skill_gaps,
              rawPayload:    j,
              savedAt:       new Date(),
            },
          }),
        ),
      );
    }

    // ── 10. Finalize search run ────────────────────────────────────────────
    const duration = Date.now() - pipelineStart;
    await prisma.jobSearchRun.update({
      where: { id: searchRun.id },
      data: {
        status:      'COMPLETED',
        jobsFound:   qualifyingJobs.length,
        durationMs:  duration,
        completedAt: new Date(),
      },
    });

    const doneMsg = qualifyingJobs.length > 0
      ? `Found ${qualifyingJobs.length} matching jobs in ${(duration / 1000).toFixed(1)}s!`
      : 'No jobs matched your profile threshold. Try updating your skills or role.';

    sseDone(res, qualifyingJobs.length, doneMsg);

  } catch (err) {
    console.error('[pipeline] Fatal error:', err);
    sseError(res, 'Job search failed. Please try again shortly.');

    if (searchRun) {
      await prisma.jobSearchRun.update({
        where: { id: searchRun.id },
        data: { status: 'FAILED', durationMs: Date.now() - pipelineStart, completedAt: new Date() },
      }).catch(() => {});
    }
  }
}

// ── Usage info (for frontend usage display) ────────────────────────────────────

async function getUsageInfo(userId, plan) {
  const { used, max, plan: planKey } = await getDailyUsage(userId, plan);
  const labels = { free: 'Free', pro: 'Pro', ultra: 'Ultra' };
  return {
    used,
    max: max === Infinity ? 9999 : max,
    plan: planKey,
    label: labels[planKey] || 'Free',
    remaining: max === Infinity ? 9999 : Math.max(0, max - used),
  };
}

module.exports = { runJobSearchPipeline, getUsageInfo, extractResumeIntro };
