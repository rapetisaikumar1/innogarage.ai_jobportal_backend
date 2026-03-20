/**
 * JS-based Job Search Service — replacement for n8n workflow
 * 
 * Flow: Takes student profile → searches free job APIs → scores matches → writes to Google Sheet
 * Toggle: Set JOB_SEARCH_MODE=js in .env (default: n8n)
 * 
 * Free APIs used (no API key):
 *   - Adzuna (via RSS/public endpoint)
 *   - Remotive (remote jobs)
 *   - Arbeitnow (EU + remote jobs)
 *   - JSearch (RapidAPI — if RAPIDAPI_KEY is set)
 */

const axios = require('axios');
const https = require('https');
const { google } = require('googleapis');

const httpClient = axios.create({
  timeout: 20000,
  httpsAgent: new https.Agent({ family: 4 }),
});

// ───── Google Sheets Write ─────

const GOOGLE_SHEET_ID = '1P1jruNXUrazTqZkKjf0y2mY7-ii8IkDJznjJSyS5R-w';

async function getSheetsClient() {
  // Method 1: Service Account (if configured)
  const saKeyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (saKeyJson) {
    try {
      const key = JSON.parse(saKeyJson);
      const auth = new google.auth.GoogleAuth({
        credentials: key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      return google.sheets({ version: 'v4', auth });
    } catch (err) {
      console.error('Sheets service account auth error:', err.message);
    }
  }

  // Method 2: OAuth2 (using existing Google Client ID/Secret + Sheets refresh token)
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_SHEETS_REFRESH_TOKEN;
  if (clientId && clientSecret && refreshToken) {
    try {
      const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
      oauth2.setCredentials({ refresh_token: refreshToken });
      return google.sheets({ version: 'v4', auth: oauth2 });
    } catch (err) {
      console.error('Sheets OAuth2 auth error:', err.message);
    }
  }

  return null;
}

async function appendToSheet(rows) {
  const sheets = await getSheetsClient();
  if (!sheets) {
    console.log('No Google Sheets service account configured — skipping sheet write (results returned via API)');
    return false;
  }
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'Sheet1!A1',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows },
    });
    return true;
  } catch (err) {
    console.error('Sheet append error:', err.message);
    return false;
  }
}

// ───── Free Job Search APIs ─────

/** Search Remotive (remote jobs, no key needed) */
async function searchRemotive(query, limit = 15) {
  try {
    const { data } = await httpClient.get('https://remotive.com/api/remote-jobs', {
      params: { search: query, limit },
    });
    return (data.jobs || []).map(j => ({
      employer_name: j.company_name || '',
      job_title: j.title || '',
      job_city: 'Remote',
      job_state: '',
      job_country: '',
      job_employment_type: j.job_type || '',
      job_apply_link: j.url || '',
      jd: (j.description || '').replace(/<[^>]*>/g, ' ').substring(0, 2000),
      source: 'Remotive',
      posted: j.publication_date || '',
    }));
  } catch (err) {
    console.warn('Remotive search error:', err.message);
    return [];
  }
}

/** Search Arbeitnow (EU + remote jobs, no key needed) */
async function searchArbeitnow(query, limit = 15) {
  try {
    const { data } = await httpClient.get('https://www.arbeitnow.com/api/job-board-api', {
      params: { search: query, per_page: limit },
    });
    return (data.data || []).map(j => ({
      employer_name: j.company_name || '',
      job_title: j.title || '',
      job_city: j.location || '',
      job_state: '',
      job_country: '',
      job_employment_type: j.remote ? 'Remote' : 'On-site',
      job_apply_link: j.url || '',
      jd: (j.description || '').replace(/<[^>]*>/g, ' ').substring(0, 2000),
      source: 'Arbeitnow',
      posted: j.created_at || '',
    }));
  } catch (err) {
    console.warn('Arbeitnow search error:', err.message);
    return [];
  }
}

/** Search JSearch (RapidAPI — only if RAPIDAPI_KEY is set) */
async function searchJSearch(query, location, days, limit = 15) {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) return [];
  try {
    const { data } = await httpClient.get('https://jsearch.p.rapidapi.com/search', {
      params: {
        query: `${query} in ${location || 'United States'}`,
        page: '1',
        num_pages: '1',
        date_posted: days <= 1 ? 'today' : days <= 3 ? '3days' : days <= 7 ? 'week' : 'month',
      },
      headers: {
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
      },
    });
    return (data.data || []).slice(0, limit).map(j => ({
      employer_name: j.employer_name || '',
      job_title: j.job_title || '',
      job_city: j.job_city || '',
      job_state: j.job_state || '',
      job_country: j.job_country || '',
      job_employment_type: j.job_employment_type || '',
      job_apply_link: j.job_apply_link || '',
      jd: (j.job_description || '').substring(0, 2000),
      source: 'JSearch',
      posted: j.job_posted_at_datetime_utc || '',
    }));
  } catch (err) {
    console.warn('JSearch error:', err.message);
    return [];
  }
}

// ───── Match Scoring ─────

function computeMatchScore(job, userSkills, userRole) {
  const jobText = `${job.job_title} ${job.jd} ${job.employer_name}`.toLowerCase();
  const skills = (userSkills || []).map(s => s.toLowerCase().trim()).filter(Boolean);
  const role = (userRole || '').toLowerCase();

  if (skills.length === 0 && !role) return { score: 50, strongMatches: [], missingSkills: [], summary: 'No skills provided for matching.' };

  // Score based on skill matches
  const strongMatches = skills.filter(skill => jobText.includes(skill));
  const missingSkills = skills.filter(skill => !jobText.includes(skill));

  // Role title match bonus
  let roleBonus = 0;
  if (role) {
    const roleWords = role.split(/\s+/).filter(w => w.length > 2);
    const titleLower = job.job_title.toLowerCase();
    const titleMatchCount = roleWords.filter(w => titleLower.includes(w)).length;
    roleBonus = roleWords.length > 0 ? (titleMatchCount / roleWords.length) * 20 : 0;
  }

  const skillScore = skills.length > 0 ? (strongMatches.length / skills.length) * 80 : 40;
  const score = Math.min(100, Math.round(skillScore + roleBonus));

  const summary = strongMatches.length > 0
    ? `Matches ${strongMatches.length}/${skills.length} skills. ${missingSkills.length > 0 ? `Missing: ${missingSkills.slice(0, 3).join(', ')}.` : 'Strong overall match.'}`
    : `Low skill overlap. Consider upskilling in: ${skills.slice(0, 3).join(', ')}.`;

  return { score, strongMatches, missingSkills, summary };
}

// ───── Main Search Function ─────

/**
 * Search for jobs using free APIs, score them, and optionally write to Google Sheet.
 * Returns the job results directly.
 *
 * @param {Object} student - { id, fullName, email, keySkills, resumeUrl, jobRole, location }
 * @param {number} days - how many days back to search
 * @returns {Array} job results with match scores
 */
async function searchJobs(student, days = 1) {
  const query = student.jobRole || (student.keySkills || []).slice(0, 3).join(' ') || 'Software Developer';
  const location = student.location || '';
  const skills = student.keySkills || [];

  console.log(`[JS Job Search] Query: "${query}", Location: "${location}", Skills: ${skills.length}, Days: ${days}`);

  // Search all APIs in parallel
  const [remotiveJobs, arbeitnowJobs, jsearchJobs] = await Promise.all([
    searchRemotive(query),
    searchArbeitnow(query),
    searchJSearch(query, location, days),
  ]);

  const allJobs = [...jsearchJobs, ...remotiveJobs, ...arbeitnowJobs];
  console.log(`[JS Job Search] Found: JSearch=${jsearchJobs.length}, Remotive=${remotiveJobs.length}, Arbeitnow=${arbeitnowJobs.length}, Total=${allJobs.length}`);

  if (allJobs.length === 0) {
    return [];
  }

  // Deduplicate by employer + title
  const seen = new Set();
  const unique = allJobs.filter(j => {
    const key = `${j.employer_name}|${j.job_title}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Score and sort
  const scored = unique.map(job => {
    const match = computeMatchScore(job, skills, student.jobRole);
    return {
      ...job,
      match_score: match.score,
      strong_matches: JSON.stringify(match.strongMatches),
      missing_skills: JSON.stringify(match.missingSkills),
      match_summary: match.summary,
      candidate_id: student.id,
      candidate_name: student.fullName || '',
      email: student.email || '',
      timestamp: new Date().toISOString(),
      pdf_link: student.resumeUrl || '',
      resume_text: '', // JS flow doesn't generate tailored resume text
    };
  }).sort((a, b) => b.match_score - a.match_score);

  // Take top results
  const results = scored.slice(0, 30);

  // Write to Google Sheet (same format as n8n) — fire and forget
  const sheetRows = results.map(r => [
    '', // col A (empty)
    '', // col B (empty)
    r.candidate_id,
    r.candidate_name,
    r.email,
    r.employer_name,
    String(r.match_score),
    r.strong_matches,
    r.missing_skills,
    r.job_apply_link,
    r.match_summary,
    r.timestamp,
    r.pdf_link,
    r.jd.substring(0, 500),
    r.resume_text,
  ]);

  appendToSheet(sheetRows).then(ok => {
    if (ok) console.log(`[JS Job Search] Wrote ${results.length} rows to Google Sheet`);
  });

  return results;
}

module.exports = { searchJobs, computeMatchScore };
