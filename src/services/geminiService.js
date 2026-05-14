const axios = require('axios');
const config = require('../config');

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_GEMINI_MODEL = config.gemini?.model || process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_FLASH_MODEL = 'gemini-2.5-flash';
const GEMINI_FLASH_LITE_MODEL = 'gemini-2.5-flash-lite';
// Job match scoring uses only these two models: primary → fallback.
const JOB_MATCH_GEMINI_MODELS = [GEMINI_FLASH_MODEL, GEMINI_FLASH_LITE_MODEL];
const FALLBACK_GEMINI_MODELS = [
  DEFAULT_GEMINI_MODEL,
  GEMINI_FLASH_MODEL,
  GEMINI_FLASH_LITE_MODEL,
  'gemini-2.0-flash',
  'gemini-flash-latest',
];
const RETRYABLE_GEMINI_STATUS_CODES = new Set([408, 409, 429, 500, 502, 503, 504]);

const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const clampNumber = (value, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(Math.max(Math.round(parsed), min), max);
};

const truncateText = (value, maxLength) => {
  const normalized = String(value || '').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(maxLength - 3, 0)).trim()}...`;
};

const toStringList = (value) => {
  if (!value) return [];
  const items = Array.isArray(value) ? value : String(value).split(/[,|\n]/);
  return [...new Set(items.map((item) => compact(item)).filter(Boolean))];
};

const normalizeModelName = (value) => compact(value).replace(/^models\//i, '');

const getGeminiModelCandidates = () => [...new Set(FALLBACK_GEMINI_MODELS.map(normalizeModelName).filter(Boolean))];

const getGeminiApiKey = () => compact(config.gemini?.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);

const hasGeminiApiKey = () => Boolean(getGeminiApiKey());

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableGeminiError = (error) => {
  if (RETRYABLE_GEMINI_STATUS_CODES.has(error.response?.status)) return true;
  return ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET'].includes(error.code);
};

const getGeminiErrorMessage = (error) => {
  const apiMessage = error.response?.data?.error?.message || error.response?.data?.message;
  if (apiMessage) return apiMessage;
  if (error.response?.status) return `Gemini request failed with status ${error.response.status}`;
  return error.message || 'Gemini request failed';
};

const extractCandidateText = (data) => {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('\n')
    .trim();

  if (!text) {
    const blockReason = data?.promptFeedback?.blockReason;
    throw new Error(blockReason ? `Gemini response blocked: ${blockReason}` : 'Gemini returned an empty response');
  }

  return text;
};

const parseJsonPayload = (text) => {
  const normalized = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(normalized);
  } catch (error) {
    const firstBrace = normalized.indexOf('{');
    const lastBrace = normalized.lastIndexOf('}');

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(normalized.slice(firstBrace, lastBrace + 1));
    }

    throw error;
  }
};

const normalizeBreakdown = (value = {}) => {
  const breakdown = {
    summary: clampNumber(value.summary, 0, 15),
    skills: clampNumber(value.skills, 0, 35),
    experience: clampNumber(value.experience, 0, 15),
    role: clampNumber(value.role, 0, 20),
    location: clampNumber(value.location, 0, 15),
  };

  const total = Object.values(breakdown).reduce((sum, item) => sum + item, 0);
  return { breakdown, total };
};

const getScoreLabel = (score) => {
  if (score >= 85) return 'Excellent match';
  if (score >= 75) return 'Strong match';
  if (score >= 60) return 'Good match';
  return 'Needs review';
};

const normalizeGeminiMatchResult = (value = {}) => {
  const { breakdown, total } = normalizeBreakdown(value.breakdown || {});
  const score = clampNumber(value.score ?? total, 0, 100);

  return {
    score,
    label: compact(value.label) || getScoreLabel(score),
    summary: truncateText(value.summary, 500),
    breakdown,
    strongMatches: toStringList(value.strongMatches).slice(0, 10),
    missingSkills: toStringList(value.missingSkills).slice(0, 10),
    provider: 'gemini',
    model: normalizeModelName(value.model || DEFAULT_GEMINI_MODEL),
  };
};

const buildGeminiPrompt = ({ resumeText, jobDescription, profileContext, jobContext }) => `
You are an expert recruiting assistant.
Compare the candidate resume against the job description and return only valid JSON.

Scoring rubric:
- summary: 0-15
- skills: 0-35
- experience: 0-15
- role: 0-20
- location: 0-15
- total score must equal the sum of the breakdown values and be between 0 and 100

Return JSON in exactly this shape:
{
  "score": 0,
  "label": "Good match",
  "summary": "1-2 sentence explanation of the fit",
  "breakdown": {
    "summary": 0,
    "skills": 0,
    "experience": 0,
    "role": 0,
    "location": 0
  },
  "strongMatches": ["item"],
  "missingSkills": ["item"]
}

Candidate profile:
${JSON.stringify(profileContext, null, 2)}

Job context:
${JSON.stringify(jobContext, null, 2)}

Resume text:
${truncateText(resumeText, 9000)}

Job description:
${truncateText(jobDescription, 9000)}
`;

const requestGeminiJson = async ({ prompt, modelCandidates, temperature = 0.2, timeout = 45000 }) => {
  if (!hasGeminiApiKey()) {
    throw new Error('Gemini API key is not configured');
  }

  const normalizedCandidates = [...new Set((modelCandidates || []).map(normalizeModelName).filter(Boolean))];
  if (!normalizedCandidates.length) {
    throw new Error('No Gemini model candidates were provided');
  }

  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: prompt,
          },
        ],
      },
    ],
    generationConfig: {
      temperature,
      responseMimeType: 'application/json',
    },
  };

  let lastError = null;

  for (let modelIndex = 0; modelIndex < normalizedCandidates.length; modelIndex += 1) {
    const model = normalizedCandidates[modelIndex];
    const hasNextModel = modelIndex < normalizedCandidates.length - 1;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await axios.post(
          `${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(getGeminiApiKey())}`,
          requestBody,
          {
            timeout,
          }
        );

        return {
          payload: parseJsonPayload(extractCandidateText(response.data)),
          model: normalizeModelName(model),
        };
      } catch (error) {
        lastError = error;
        const canRetrySameModel = isRetryableGeminiError(error) && attempt < 2;
        const canTryNextModel = hasNextModel;

        if (canRetrySameModel) {
          await wait(700 * attempt);
          continue;
        }

        if (canTryNextModel) break;

        throw new Error(getGeminiErrorMessage(error));
      }
    }
  }

  throw new Error(
    lastError && isRetryableGeminiError(lastError)
      ? 'Gemini is temporarily unavailable. Please try Resume again in a minute.'
      : getGeminiErrorMessage(lastError || new Error('No supported Gemini model was available'))
  );
};

const scoreResumeAgainstJob = async ({ resumeText, jobDescription, profileContext, jobContext }) => {
  const { payload, model } = await requestGeminiJson({
    prompt: buildGeminiPrompt({
      resumeText,
      jobDescription,
      profileContext,
      jobContext,
    }),
    modelCandidates: JOB_MATCH_GEMINI_MODELS,
  });

  return normalizeGeminiMatchResult({
    ...payload,
    model,
  });
};

const buildTailoredResumePrompt = ({ resumeText, jobDescription, profileContext, jobContext }) => `
You are an expert ATS resume writer.
Create a tailored resume from the candidate's uploaded resume and the job description.

Strict rules:
- Preserve all factual candidate content from the uploaded resume: employers, roles, dates, education, certifications, contact details, tools, and measurable achievements.
- Do not invent employers, degrees, certifications, dates, metrics, locations, clearance, or skills not supported by the resume.
- Lightly rewrite the summary, skills, and bullets so the resume is aligned with the job description.
- Keep the template simple, readable, ATS friendly, and plain text.
- Do not use markdown tables, code fences, decorative symbols, or commentary.
- Return only valid JSON.

Return JSON in exactly this shape:
{
  "headline": "Short target role headline",
  "resumeText": "Complete ATS tailored resume text with clear section headings",
  "changeSummary": ["brief change made"]
}

Candidate profile:
${JSON.stringify(profileContext, null, 2)}

Job context:
${JSON.stringify(jobContext, null, 2)}

Uploaded resume content:
${truncateText(resumeText, 16000)}

Job description:
${truncateText(jobDescription, 12000)}
`;

const normalizeTailoredResumeResult = (value = {}, model) => {
  const resumeText = String(value.resumeText || value.resume || '').trim();

  if (!resumeText) {
    throw new Error('Gemini did not return tailored resume text');
  }

  return {
    headline: truncateText(value.headline || '', 140),
    resumeText,
    changeSummary: toStringList(value.changeSummary).slice(0, 8),
    provider: 'gemini',
    model: normalizeModelName(model),
  };
};

const generateTailoredResume = async ({ resumeText, jobDescription, profileContext, jobContext }) => {
  const { payload, model } = await requestGeminiJson({
    prompt: buildTailoredResumePrompt({
      resumeText,
      jobDescription,
      profileContext,
      jobContext,
    }),
    modelCandidates: [GEMINI_FLASH_MODEL, GEMINI_FLASH_LITE_MODEL, DEFAULT_GEMINI_MODEL, 'gemini-2.0-flash', 'gemini-flash-latest'],
    temperature: 0.25,
    timeout: 60000,
  });

  return normalizeTailoredResumeResult(payload, model);
};

module.exports = {
  hasGeminiApiKey,
  generateTailoredResume,
  scoreResumeAgainstJob,
};