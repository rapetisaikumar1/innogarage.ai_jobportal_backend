/**
 * jobScoringService.js
 *
 * Pure in-memory scoring. No async, no external calls.
 *
 * Score formula (0–100):
 *   35 × Title Fit
 * + 30 × Skill Overlap
 * + 15 × Experience Fit
 * + 10 × Location Fit
 * + 10 × Resume-Summary Overlap
 * -  P  Penalty (max 20)
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

function tokenise(text) {
  if (!text) return new Set();
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s.#+-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1),
  );
}

function overlapRatio(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let matches = 0;
  for (const t of setA) if (setB.has(t)) matches++;
  return matches / Math.max(setA.size, setB.size);
}

function normaliseText(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
}

// ── Factor calculators ────────────────────────────────────────────────────────

/**
 * T — Title fit (0–1)
 * Checks how well job title matches the intended role and variants.
 */
function scoreTitleFit(jobTitle, intent) {
  const jt = normaliseText(jobTitle);
  const targets = [intent.normalizedRole, ...intent.titleVariants].map(normaliseText);

  // Exact or substring match
  for (const target of targets) {
    if (jt.includes(target) || target.includes(jt)) return 1.0;
  }

  // Token overlap with best-matching variant
  const jtTokens = tokenise(jt);
  let best = 0;
  for (const target of targets) {
    best = Math.max(best, overlapRatio(jtTokens, tokenise(target)));
  }
  return best;
}

/**
 * S — Skill overlap (0–1)
 * Fraction of the student's skill keywords that appear in the JD.
 */
function scoreSkillOverlap(jobDescription, jobTitle, skillKeywords) {
  if (!skillKeywords || skillKeywords.length === 0) return 0;
  const haystack = normaliseText(`${jobTitle} ${jobDescription}`);
  let hits = 0;
  const matched = [];
  const missing = [];
  for (const skill of skillKeywords) {
    const needle = normaliseText(skill);
    if (haystack.includes(needle)) {
      hits++;
      matched.push(skill);
    } else {
      missing.push(skill);
    }
  }
  return { ratio: hits / skillKeywords.length, matched, missing };
}

/**
 * X — Experience fit (0–1)
 * Compares student seniority range against years/level mentioned in JD.
 */
function scoreExperienceFit(jobDescription, seniorityRange) {
  const text = normaliseText(jobDescription || '');

  // Extract year mentions: "3+ years", "5 years experience", etc.
  const yearMatches = [...text.matchAll(/(\d+)\s*\+?\s*years?/g)].map((m) => parseInt(m[1], 10));
  if (yearMatches.length > 0) {
    const jdMinYears = Math.min(...yearMatches);
    const jdMaxYears = Math.max(...yearMatches);
    const { minYears = 0, maxYears = 20 } = seniorityRange || {};

    // Perfect overlap
    if (jdMinYears <= maxYears && jdMaxYears >= minYears) return 1.0;
    // One year off on either side — partial credit
    const diff = Math.min(Math.abs(jdMinYears - maxYears), Math.abs(jdMaxYears - minYears));
    return Math.max(0, 1 - diff * 0.25);
  }

  // Fallback: keyword-based seniority match
  const seniority = (seniorityRange?.seniority || '').toLowerCase();
  const juniorWords  = ['junior', 'entry', 'associate', 'graduate', 'trainee'];
  const midWords     = ['mid', 'intermediate', '2+', '3+', '4+'];
  const seniorWords  = ['senior', 'sr.', 'lead', 'principal', 'staff', '5+', '6+', '7+', '8+'];

  const hasJunior = juniorWords.some((w) => text.includes(w));
  const hasMid    = midWords.some((w) => text.includes(w));
  const hasSenior = seniorWords.some((w) => text.includes(w));

  if (seniority === 'junior') return hasJunior ? 1.0 : hasMid ? 0.5 : 0.2;
  if (seniority === 'mid')    return hasMid ? 1.0 : (hasJunior || hasSenior) ? 0.6 : 0.5;
  if (seniority === 'senior' || seniority === 'lead') return hasSenior ? 1.0 : hasMid ? 0.6 : 0.3;
  return 0.7; // 'any' — neutral
}

/**
 * L — Location fit (0–1)
 */
function scoreLocationFit(jobLocation, locationVariants, isRemote) {
  if (isRemote) return 1.0;
  const jl = normaliseText(jobLocation || '');
  if (!jl || jl === 'remote') return 0.8; // unknown — give benefit of doubt

  const remoteTerms = ['remote', 'hybrid', 'anywhere', 'worldwide'];
  if (remoteTerms.some((t) => jl.includes(t))) return 1.0;

  for (const variant of (locationVariants || [])) {
    const v = normaliseText(variant);
    if (jl.includes(v) || v.includes(jl)) return 1.0;
  }
  // Partial — country match
  const country = (locationVariants || []).slice(-1)[0] || '';
  if (country && jl.includes(normaliseText(country))) return 0.7;

  return 0.2; // location mismatch
}

/**
 * R — Resume summary overlap (0–1)
 * Rough TF-IDF-style word overlap between JD and resume opening summary.
 */
function scoreResumeSummaryFit(jobDescription, cleanedResumeSummary) {
  return overlapRatio(
    tokenise(cleanedResumeSummary || ''),
    tokenise(jobDescription || ''),
  );
}

/**
 * Penalty: deduct points for hard mismatches.
 */
function computePenalty(jobTitle, jobDescription, intent) {
  const title = normaliseText(jobTitle || '');
  const desc  = normaliseText(jobDescription || '');
  let penalty = 0;

  // Exclusion keywords in title (strong signal: wrong type of role)
  for (const ex of (intent.exclusionKeywords || [])) {
    if (title.includes(normaliseText(ex))) {
      penalty += 20;
      break;
    }
  }

  // Explicit seniority mismatch
  const seniority = intent.seniority || 'any';
  if (seniority === 'junior') {
    const seniorWords = ['senior', 'sr.', 'lead', 'principal', 'staff'];
    if (seniorWords.some((w) => title.includes(w))) penalty += 10;
  }
  if (seniority === 'senior' || seniority === 'lead') {
    const juniorWords = ['junior', 'entry level', 'graduate', 'trainee', 'intern'];
    if (juniorWords.some((w) => title.includes(w) || desc.includes(w))) penalty += 8;
  }

  return Math.min(penalty, 20); // cap at 20
}

// ── Main scorer ───────────────────────────────────────────────────────────────

/**
 * Score a normalised job against the search intent.
 *
 * @param {object} job     NormalizedJob from jobNormalizerService
 * @param {object} intent  structured intent from geminiIntentService
 * @returns {{ score: number, summary: string, strongMatches: string, skillGaps: string }}
 */
function scoreJob(job, intent) {
  const titleFit    = scoreTitleFit(job.title, intent);
  const skillResult = scoreSkillOverlap(job.description, job.title, intent.skillKeywords);
  const skillRatio  = typeof skillResult === 'object' ? skillResult.ratio : skillResult;
  const expFit      = scoreExperienceFit(job.description, intent.seniorityRange);
  const locFit      = scoreLocationFit(job.location, intent.locationVariants, job.isRemote);
  const resumeFit   = scoreResumeSummaryFit(job.description, intent.cleanedResumeSummary);
  const penalty     = computePenalty(job.title, job.description, intent);

  const raw = (
    35 * titleFit  +
    30 * skillRatio +
    15 * expFit    +
    10 * locFit    +
    10 * resumeFit
  ) - penalty;

  const score = Math.round(Math.max(0, Math.min(100, raw)));

  // Human-readable meta
  const matched = typeof skillResult === 'object' ? skillResult.matched : [];
  const missing = typeof skillResult === 'object' ? skillResult.missing : [];

  const summary = buildSummary(score, titleFit, skillRatio, locFit, expFit);

  return {
    score,
    summary,
    strongMatches: matched.slice(0, 8).join(', '),
    skillGaps:     missing.slice(0, 5).join(', '),
  };
}

function buildSummary(score, titleFit, skillRatio, locFit, expFit) {
  const parts = [];
  if (titleFit >= 0.8)        parts.push('Strong role match');
  else if (titleFit >= 0.5)   parts.push('Partial role match');
  if (skillRatio >= 0.6)      parts.push('good skill alignment');
  else if (skillRatio >= 0.3) parts.push('some skill overlap');
  else                        parts.push('limited skill overlap');
  if (locFit < 0.5)           parts.push('location may differ');
  if (expFit < 0.5)           parts.push('experience level varies');

  const prefix = score >= 80 ? 'Excellent match' : score >= 65 ? 'Good match' : 'Possible match';
  return `${prefix}. ${parts.join(', ')}.`;
}

module.exports = { scoreJob };
