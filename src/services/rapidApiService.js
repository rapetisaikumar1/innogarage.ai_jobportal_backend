/**
 * rapidApiService.js
 *
 * Executes parallel JSearch queries via RapidAPI.
 * Takes up to 3 query strings from the search intent and fires them
 * simultaneously. Uses Promise.allSettled so one failure does not abort
 * the whole pipeline.
 */

const axios = require('axios');

const RAPIDAPI_HOST = 'jsearch.p.rapidapi.com';
const RAPIDAPI_BASE = `https://${RAPIDAPI_HOST}`;

/**
 * Fetch jobs for a single query string.
 * @param {string} query
 * @param {string|number} days  posted within N days
 * @returns {Promise<object[]>} raw JSearch job objects
 */
async function fetchSingleQuery(query, days) {
  const params = {
    query,
    num_pages: '2',          // 2 pages × ~10 jobs = 20 results per query
    date_posted: days <= 1 ? 'today' : days <= 3 ? '3days' : days <= 7 ? 'week' : 'month',
    remote_jobs_only: 'false',
    employment_types: 'FULLTIME,PARTTIME,CONTRACTOR',
  };

  const response = await axios.get(`${RAPIDAPI_BASE}/search`, {
    params,
    headers: {
      'X-RapidAPI-Key':  process.env.RAPIDAPI_KEY,
      'X-RapidAPI-Host': RAPIDAPI_HOST,
    },
    timeout: 10000,  // 10-second hard timeout per query
  });

  return Array.isArray(response.data?.data) ? response.data.data : [];
}

/**
 * Run all search queries in parallel and return the merged flat list.
 * @param {string[]} queries   up to 3 query strings from Gemini intent
 * @param {number}   days      look-back window
 * @returns {Promise<object[]>} merged raw job list
 */
async function fetchJobs(queries, days = 7) {
  const effectiveQueries = (queries || []).slice(0, 3);
  if (effectiveQueries.length === 0) return [];

  const results = await Promise.allSettled(
    effectiveQueries.map((q) => fetchSingleQuery(q, days))
  );

  const merged = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      merged.push(...result.value);
    } else {
      console.warn('[rapidApiService] One query failed:', result.reason?.message);
    }
  }

  return merged;
}

module.exports = { fetchJobs };
