/**
 * geminiIntentService.js
 *
 * Converts a student's raw profile into a structured job-search intent
 * using Gemini. Called once per search run — result feeds RapidAPI queries
 * and the local scorer.
 *
 * Output is strict JSON (no prose) so it can be consumed directly in code.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * @param {object} profile
 * @param {string}   profile.jobRole            e.g. "AEP Developer"
 * @param {string}   profile.experience         e.g. "3 years" or "Senior"
 * @param {string}   profile.location           e.g. "London"
 * @param {string[]} profile.skills             e.g. ["AEP","Adobe Analytics","JS"]
 * @param {string}   profile.resumeIntroSummary first ~600 chars of resume summary
 * @returns {Promise<object>} structured search intent
 */
async function buildSearchIntent(profile) {
  const { jobRole, experience, location, skills, resumeIntroSummary } = profile;

  const prompt = `You are a technical job-search optimiser. Given the candidate profile below, 
produce ONLY a JSON object — no markdown, no explanation, no extra text.

CANDIDATE PROFILE:
- Job Role: ${jobRole || 'Not specified'}
- Experience: ${experience || 'Not specified'}
- Location: ${location || 'Not specified'}
- Skills: ${(skills || []).join(', ') || 'Not specified'}
- Resume Summary: ${resumeIntroSummary || 'Not provided'}

Produce exactly this JSON shape (all fields required):
{
  "normalizedRole": "<canonical job title>",
  "titleVariants": ["<variant1>", "<variant2>", "<variant3>"],
  "searchQueries": [
    "<query1 optimised for JSearch API>",
    "<query2 with location>",
    "<query3 alternative title>"
  ],
  "seniority": "<junior|mid|senior|lead|any>",
  "seniorityRange": { "minYears": <number>, "maxYears": <number> },
  "skillKeywords": ["<skill1>", "<skill2>", "...up to 15"],
  "locationVariants": ["<loc1>", "<loc2>", "remote", "hybrid"],
  "exclusionKeywords": ["Director", "VP", "Head of", "intern", "internship"],
  "cleanedResumeSummary": "<concise 2-3 sentence professional summary>"
}

Rules:
- searchQueries must be short, keyword-rich strings suitable for JSearch (max 8 words each)
- skillKeywords should include both acronyms and full forms where applicable
- Do not invent qualifications not present in the profile
- If location is empty use "remote"
- Return ONLY the JSON object, starting with { and ending with }`;

  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    generationConfig: {
      temperature: 0.1,       // low creativity — we want deterministic output
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
    },
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  // Strip accidental markdown fences if Gemini adds them despite instruction
  const jsonText = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  const intent = JSON.parse(jsonText);

  // Validate required fields, provide safe fallbacks
  return {
    normalizedRole:     intent.normalizedRole     || jobRole || 'Software Engineer',
    titleVariants:      Array.isArray(intent.titleVariants)     ? intent.titleVariants     : [],
    searchQueries:      Array.isArray(intent.searchQueries)     ? intent.searchQueries.slice(0, 3) : [`${jobRole} ${location}`],
    seniority:          intent.seniority          || 'any',
    seniorityRange:     intent.seniorityRange      || { minYears: 0, maxYears: 20 },
    skillKeywords:      Array.isArray(intent.skillKeywords)     ? intent.skillKeywords     : skills || [],
    locationVariants:   Array.isArray(intent.locationVariants)  ? intent.locationVariants  : [location, 'remote'].filter(Boolean),
    exclusionKeywords:  Array.isArray(intent.exclusionKeywords) ? intent.exclusionKeywords : [],
    cleanedResumeSummary: intent.cleanedResumeSummary || resumeIntroSummary || '',
  };
}

module.exports = { buildSearchIntent };
