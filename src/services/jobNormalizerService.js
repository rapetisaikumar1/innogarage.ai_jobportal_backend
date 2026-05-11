/**
 * jobNormalizerService.js
 *
 * Converts a raw JSearch API job object into the unified internal shape
 * that the scorer, SSE emitter, and DB model all consume.
 *
 * Also extracts implied skills from the job description for scoring.
 */

const COMMON_TECH_TERMS = [
  'JavaScript','TypeScript','Python','Java','SQL','NoSQL','React','Node.js',
  'Express','PostgreSQL','MongoDB','Redis','AWS','Azure','GCP','Docker','Kubernetes',
  'REST','GraphQL','AEP','Adobe Experience Platform','Adobe Analytics','Adobe Campaign',
  'SFMC','Salesforce','Marketo','AJO','CDP','CRM','Tableau','Power BI','Spark',
  'Hadoop','Airflow','dbt','Snowflake','Databricks','Terraform','Git','CI/CD',
  'Agile','Scrum','JIRA','Linux','Bash','C#','.NET','PHP','Ruby','Go','Rust',
  'VLSI','Embedded','MATLAB','Simulink','LabVIEW','Validation','Automation',
  'Selenium','Cypress','Playwright','Jest','PyTest','Ansible','Jenkins','GitHub Actions',
  'SAP','Oracle','Dynamics','UKG','Workday','ServiceNow','Smartsheet',
  'Palantir','KDB','EDI','EHR','HL7','FHIR','CyberArk','Splunk','Elasticsearch',
];

const TECH_REGEX = new RegExp(
  COMMON_TECH_TERMS.map((t) => `\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).join('|'),
  'gi'
);

/**
 * Extract technology/skill mentions from free text (JD, title).
 * @param {string} text
 * @returns {string[]} unique skill matches
 */
function extractSkillsFromText(text) {
  if (!text) return [];
  const matches = text.match(TECH_REGEX) || [];
  return [...new Set(matches.map((m) => m.trim()))];
}

/**
 * Parse a salary string out of various JSearch salary fields.
 * @param {object} job raw JSearch job
 * @returns {string|null}
 */
function parseSalary(job) {
  if (job.job_salary_currency && job.job_min_salary && job.job_max_salary) {
    return `${job.job_salary_currency} ${job.job_min_salary.toLocaleString()} – ${job.job_max_salary.toLocaleString()}`;
  }
  if (job.job_min_salary) return `${job.job_min_salary.toLocaleString()}`;
  return null;
}

/**
 * Map one raw JSearch job object → unified NormalizedJob.
 * @param {object} raw  JSearch job
 * @returns {object}    NormalizedJob
 */
function normalizeJob(raw) {
  const description = raw.job_description || '';
  const title       = raw.job_title        || 'Untitled';
  const company     = raw.employer_name    || 'Unknown Company';

  const location = [
    raw.job_city,
    raw.job_state,
    raw.job_country,
  ].filter(Boolean).join(', ') || 'Remote';

  const applyLink = raw.job_apply_link || raw.job_google_link || '';

  let postedAt = null;
  if (raw.job_posted_at_datetime_utc) {
    const d = new Date(raw.job_posted_at_datetime_utc);
    if (!isNaN(d.getTime())) postedAt = d;
  } else if (raw.job_posted_at_timestamp) {
    postedAt = new Date(raw.job_posted_at_timestamp * 1000);
  }

  return {
    externalId:     raw.job_id || null,
    title,
    company,
    location,
    employmentType: raw.job_employment_type || null,
    description,
    salary:         parseSalary(raw),
    applyLink,
    postedAt,
    isRemote:       !!(raw.job_is_remote),
    impliedSkills:  extractSkillsFromText(`${title} ${description}`),

    // Fields the frontend reads via SSE / /jobs/matched
    job_title:                   title,
    employer_name:                company,
    job_location:                 location,
    job_employment_type:          raw.job_employment_type || null,
    jd:                           description.substring(0, 4000), // cap for SSE payload
    job_apply_link:               applyLink,
    job_posted_at_datetime_utc:   postedAt ? postedAt.toISOString() : null,

    // Will be filled in by scorer
    match_score:    0,
    match_summary:  '',
    strong_matches: '',
    skill_gaps:     '',
    resume_text:    null,
    candidate_name: null,
  };
}

/**
 * Deduplicate a list of NormalizedJobs by apply link.
 * @param {object[]} jobs
 * @returns {object[]}
 */
function deduplicateJobs(jobs) {
  const seen = new Set();
  return jobs.filter((j) => {
    const key = j.applyLink || `${j.company}::${j.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { normalizeJob, deduplicateJobs, extractSkillsFromText };
