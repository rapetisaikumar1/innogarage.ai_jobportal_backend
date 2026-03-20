/**
 * JS-based Job Search Service — full replacement for n8n workflow
 *
 * Flow: Student profile (name, role, skills, experience, education, location)
 *       → search JSearch + Remotive APIs
 *       → deep match scoring (skills, role fit, experience, education)
 *       → generate tailored resume per JD
 *       → write to Google Sheet
 *
 * Toggle: JOB_SEARCH_MODE=js in .env
 * Resume: Uses Gemini AI if GEMINI_API_KEY is set, otherwise template-based
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
    console.log('No Google Sheets credentials configured — skipping sheet write');
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

// ───── JD Analysis Helpers ─────

/** Extract structured requirements from a job description */
function analyzeJD(jdText) {
  const text = (jdText || '').toLowerCase();

  // Extract experience level from JD
  let requiredYears = 0;
  const yearPatterns = [
    /(\d+)\+?\s*(?:years?|yrs?)\s*(?:of)?\s*(?:experience|exp)/gi,
    /(?:experience|exp)\s*[:–\-]?\s*(\d+)\+?\s*(?:years?|yrs?)/gi,
    /(?:minimum|at least|min)\s*(\d+)\s*(?:years?|yrs?)/gi,
  ];
  for (const pat of yearPatterns) {
    const m = pat.exec(text);
    if (m) { requiredYears = Math.max(requiredYears, parseInt(m[1])); break; }
  }

  // Detect seniority level
  let seniorityLevel = 'mid';
  if (/\b(senior|sr\.|lead|principal|staff|architect)\b/i.test(jdText)) seniorityLevel = 'senior';
  else if (/\b(junior|jr\.|entry[ -]level|intern|graduate|fresher)\b/i.test(jdText)) seniorityLevel = 'junior';
  else if (/\b(manager|director|head of|vp\b|vice president)\b/i.test(jdText)) seniorityLevel = 'lead';

  // Extract required education
  let requiredEducation = '';
  if (/\b(ph\.?d|doctorate)\b/i.test(jdText)) requiredEducation = 'phd';
  else if (/\b(master'?s?|m\.?s\.?|m\.?tech|mba)\b/i.test(jdText)) requiredEducation = 'masters';
  else if (/\b(bachelor'?s?|b\.?s\.?|b\.?tech|b\.?e\.?|undergraduate|degree)\b/i.test(jdText)) requiredEducation = 'bachelors';

  // Extract tech skills mentioned in JD
  const techPatterns = /\b(Java|Python|JavaScript|TypeScript|React|Angular|Vue|Next\.?js|Nuxt|Node\.?js|Express|NestJS|Spring|Spring Boot|Django|Flask|FastAPI|AWS|Amazon Web Services|Azure|GCP|Google Cloud|Docker|Kubernetes|K8s|SQL|NoSQL|MongoDB|PostgreSQL|MySQL|Redis|Elasticsearch|GraphQL|REST|RESTful|API|Git|GitHub|GitLab|CI\/CD|Jenkins|Agile|Scrum|Kanban|HTML|CSS|SASS|SCSS|Tailwind|Bootstrap|Material UI|C\+\+|C#|\.NET|Go|Golang|Rust|Swift|Kotlin|PHP|Ruby|Rails|Laravel|TensorFlow|PyTorch|Keras|Machine Learning|ML|AI|Artificial Intelligence|Deep Learning|NLP|Data Science|Data Engineering|ETL|Spark|Hadoop|Airflow|Databricks|Snowflake|Tableau|Power BI|DevOps|SRE|Linux|Unix|Terraform|Ansible|Puppet|CloudFormation|Kafka|RabbitMQ|Celery|Microservices|Serverless|Lambda|S3|EC2|DynamoDB|Firebase|Supabase|Prisma|Sequelize|Hibernate|JPA|Figma|Sketch|Adobe XD|UI\/UX|Jira|Confluence|Slack|Salesforce|SAP|Oracle|Cypress|Selenium|Jest|Mocha|Pytest|JUnit|Webpack|Vite|Babel|Nginx|Apache|HAProxy|Prometheus|Grafana|Datadog|New Relic|Splunk|ELK|OAuth|JWT|SAML|SSO|RBAC|Blockchain|Web3|Solidity|Flutter|React Native|Ionic|Xamarin|SwiftUI|Jetpack Compose|Unity|Unreal|Three\.js|D3\.js|Pandas|NumPy|SciPy|Matplotlib|Scikit-learn|OpenCV|CUDA|dbt|Looker|Redshift|BigQuery|Cosmos\s?DB|Cassandra|Neo4j|InfluxDB|Grafana|Loki|ArgoCD|Helm|Istio|Envoy|gRPC|Protobuf|WebSocket|Socket\.io|RxJS|Redux|MobX|Zustand|Recoil|SWR|TanStack|Storybook|Playwright|Puppeteer|Cucumber|Gatling|k6|Locust|LoadRunner)\b/gi;
  const jdSkills = [...new Set((jdText || '').match(techPatterns) || [])].map(s => s.trim());

  // Separate required vs preferred skills
  const requiredSection = text.match(/(?:required|must have|requirements|qualifications|what you.?ll need|what we.?re looking for)[\s\S]{0,1500}?(?=\n\s*\n|\n(?:preferred|nice to have|bonus|about|benefits|what we offer)|$)/i);
  const preferredSection = text.match(/(?:preferred|nice to have|bonus|good to have|plus|desired)[\s\S]{0,800}?(?=\n\s*\n|$)/i);

  const requiredText = (requiredSection?.[0] || text).toLowerCase();
  const preferredText = (preferredSection?.[0] || '').toLowerCase();

  const requiredSkills = jdSkills.filter(s => requiredText.includes(s.toLowerCase()));
  const preferredSkills = jdSkills.filter(s => preferredText.includes(s.toLowerCase()) && !requiredSkills.includes(s));

  return {
    requiredYears,
    seniorityLevel,
    requiredEducation,
    jdSkills,
    requiredSkills: requiredSkills.length > 0 ? requiredSkills : jdSkills,
    preferredSkills,
  };
}

/** Parse student's experience string to extract years */
function parseExperienceYears(experienceStr) {
  if (!experienceStr) return 0;
  const match = experienceStr.match(/(\d+)\s*(?:\+?\s*(?:years?|yrs?))/i);
  if (match) return parseInt(match[1]);
  // Try to extract from text like "3 years at Google"
  const numMatch = experienceStr.match(/(\d+)/);
  return numMatch ? parseInt(numMatch[1]) : 0;
}

/** Parse student's education level */
function parseEducationLevel(educationStr) {
  if (!educationStr) return '';
  const lower = educationStr.toLowerCase();
  if (/ph\.?d|doctorate/.test(lower)) return 'phd';
  if (/master|m\.?s\b|m\.?tech|mba/.test(lower)) return 'masters';
  if (/bachelor|b\.?s\b|b\.?tech|b\.?e\b|undergraduate|degree/.test(lower)) return 'bachelors';
  if (/diploma|associate/.test(lower)) return 'diploma';
  return 'other';
}

// ───── Free Job Search APIs ─────

/** Resolve student location to search regions */
function resolveSearchRegions(location) {
  const loc = (location || '').toLowerCase().trim();
  // Map common location inputs to search-friendly regions
  const regionMap = {
    'us': ['United States'],
    'usa': ['United States'],
    'united states': ['United States'],
    'canada': ['Canada'],
    'ca': ['Canada'],
    'india': ['India'],
    'uk': ['United Kingdom'],
    'united kingdom': ['United Kingdom'],
    'australia': ['Australia'],
    'germany': ['Germany'],
    'remote': ['United States', 'Canada'],
  };

  // Check for exact match or state/city in US/Canada
  for (const [key, regions] of Object.entries(regionMap)) {
    if (loc === key || loc.includes(key)) return regions;
  }

  // US states
  const usStates = ['alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota','tennessee','texas','utah','vermont','virginia','washington','west virginia','wisconsin','wyoming'];
  if (usStates.some(s => loc.includes(s))) return ['United States'];

  // Canadian provinces
  const caProvinces = ['ontario','quebec','british columbia','alberta','manitoba','saskatchewan','nova scotia','new brunswick','newfoundland','prince edward island'];
  if (caProvinces.some(p => loc.includes(p))) return ['Canada'];

  // Default: US + Canada
  if (!loc) return ['United States', 'Canada'];

  // Use the location as-is for region-specific search
  return [location];
}

/** Get allowed country codes for filtering based on search regions */
function getAllowedCountryCodes(regions) {
  const codes = new Set();
  for (const r of regions) {
    const rl = r.toLowerCase();
    if (rl.includes('united states') || rl.includes('us')) { codes.add('US'); codes.add('UNITED STATES'); }
    if (rl.includes('canada')) { codes.add('CA'); codes.add('CANADA'); }
    if (rl.includes('india')) { codes.add('IN'); codes.add('INDIA'); }
    if (rl.includes('united kingdom') || rl.includes('uk')) { codes.add('GB'); codes.add('UK'); codes.add('UNITED KINGDOM'); }
    if (rl.includes('australia')) { codes.add('AU'); codes.add('AUSTRALIA'); }
    if (rl.includes('germany')) { codes.add('DE'); codes.add('GERMANY'); }
  }
  // If no standard codes matched, allow all (for custom locations)
  if (codes.size === 0) codes.add('');
  return codes;
}

/** Search JSearch (RapidAPI — PRIMARY source) */
async function searchJSearch(query, regions, days, experienceLevel, limit = 50) {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) return [];
  try {
    const datePosted = days <= 1 ? 'today' : days <= 3 ? '3days' : days <= 7 ? 'week' : 'month';

    // Build queries for each region
    const queries = regions.map(r => `${query} in ${r}`);

    // Add experience-level specific queries for better results
    if (experienceLevel === 'senior') {
      queries.push(...regions.map(r => `senior ${query} in ${r}`));
    } else if (experienceLevel === 'junior') {
      queries.push(...regions.map(r => `junior ${query} in ${r}`));
    }

    const fetchPage = (q, page) =>
      httpClient.get('https://jsearch.p.rapidapi.com/search', {
        params: {
          query: q,
          page: String(page),
          num_pages: '1',
          date_posted: datePosted,
          remote_jobs_only: false,
        },
        headers: {
          'X-RapidAPI-Key': apiKey,
          'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
        },
      }).then(res => res.data?.data || []).catch(() => []);

    // Fetch 3 pages per query
    const pagePromises = [];
    for (const q of queries) {
      for (let page = 1; page <= 3; page++) {
        pagePromises.push(fetchPage(q, page));
      }
    }
    const pageResults = await Promise.all(pagePromises);
    const allResults = pageResults.flat();

    // Filter by allowed countries
    const allowedCodes = getAllowedCountryCodes(regions);
    const filtered = allResults.filter(j => {
      const country = (j.job_country || '').toUpperCase();
      return allowedCodes.has(country) || allowedCodes.has('') || !j.job_country;
    });

    console.log(`[JSearch] Raw: ${allResults.length}, After region filter: ${filtered.length}`);

    return filtered.slice(0, limit).map(j => ({
      employer_name: j.employer_name || '',
      job_title: j.job_title || '',
      job_city: j.job_city || '',
      job_state: j.job_state || '',
      job_country: j.job_country || '',
      job_employment_type: j.job_employment_type || '',
      job_apply_link: j.job_apply_link || '',
      employer_logo: j.employer_logo || '',
      job_publisher: j.job_publisher || '',
      jd: (j.job_description || '').substring(0, 3000),
      source: j.job_publisher || 'JSearch',
      posted: j.job_posted_at_datetime_utc || '',
      job_min_salary: j.job_min_salary || '',
      job_max_salary: j.job_max_salary || '',
      job_salary_currency: j.job_salary_currency || '',
    }));
  } catch (err) {
    console.warn('JSearch error:', err.message);
    return [];
  }
}

/** Search Remotive (remote jobs — SECONDARY source) */
async function searchRemotive(query, limit = 20) {
  try {
    const { data } = await httpClient.get('https://remotive.com/api/remote-jobs', {
      params: { search: query, limit },
    });
    return (data.jobs || [])
      .filter(j => j.url && j.url.startsWith('http'))
      .map(j => ({
        employer_name: j.company_name || '',
        job_title: j.title || '',
        job_city: 'Remote',
        job_state: '',
        job_country: '',
        job_employment_type: j.job_type || '',
        job_apply_link: j.url || '',
        employer_logo: j.company_logo_url || '',
        jd: (j.description || '').replace(/<[^>]*>/g, ' ').substring(0, 3000),
        source: 'Remotive',
        posted: j.publication_date || '',
      }));
  } catch (err) {
    console.warn('Remotive search error:', err.message);
    return [];
  }
}

// ───── Deep Match Scoring ─────

/**
 * Compute a detailed match score using multi-factor analysis:
 *   - Skills match (50%): required + preferred skill overlap
 *   - Role fit (25%): job title vs target role alignment
 *   - Experience (15%): experience level alignment
 *   - Education (10%): education level alignment
 */
function computeMatchScore(job, student) {
  const skills = (student.keySkills || []).map(s => s.toLowerCase().trim()).filter(Boolean);
  const role = (student.jobRole || '').toLowerCase();
  const jdAnalysis = analyzeJD(job.jd);
  const jobText = `${job.job_title} ${job.jd}`.toLowerCase();

  if (skills.length === 0 && !role) {
    return { score: 50, strongMatches: [], missingSkills: [], summary: 'No skills provided for matching.', jdAnalysis };
  }

  // ── 1. Skills Match (50%) ──
  const strongMatches = [];
  const missingSkills = [];
  const partialMatches = [];

  // Common tech name aliases for fuzzy matching
  const skillAliases = {
    'node.js': ['node', 'nodejs', 'node.js'],
    'react': ['react', 'reactjs', 'react.js'],
    'vue': ['vue', 'vuejs', 'vue.js'],
    'angular': ['angular', 'angularjs'],
    'next.js': ['next', 'nextjs', 'next.js'],
    'typescript': ['typescript', 'ts'],
    'javascript': ['javascript', 'js', 'ecmascript'],
    'c++': ['c++', 'cpp'],
    'c#': ['c#', 'csharp', 'c sharp'],
    '.net': ['.net', 'dotnet', 'dot net'],
    'aws': ['aws', 'amazon web services'],
    'gcp': ['gcp', 'google cloud'],
    'ci/cd': ['ci/cd', 'cicd', 'ci cd', 'continuous integration'],
    'postgresql': ['postgresql', 'postgres'],
    'mongodb': ['mongodb', 'mongo'],
    'machine learning': ['machine learning', 'ml'],
    'artificial intelligence': ['artificial intelligence', 'ai'],
    'ui/ux': ['ui/ux', 'uiux', 'ui ux', 'user experience', 'user interface'],
  };

  for (const skill of skills) {
    const skillLower = skill.toLowerCase();
    // Get aliases for this skill
    const aliases = skillAliases[skillLower] || [skillLower];
    // Check any alias matches in JD text
    const matched = aliases.some(alias => jobText.includes(alias));
    if (matched) {
      strongMatches.push(skill);
    } else {
      // Fuzzy: check for partial/related matches (split by word)
      const skillWords = skillLower.split(/[\s/.\-]+/).filter(w => w.length > 2);
      const hasPartial = skillWords.some(w => jobText.includes(w));
      if (hasPartial) {
        partialMatches.push(skill);
      } else {
        missingSkills.push(skill);
      }
    }
  }

  // Also check JD-required skills the student has vs doesn't have
  const jdRequiredLower = (jdAnalysis.requiredSkills || []).map(s => s.toLowerCase());
  const jdMatchedRequired = jdRequiredLower.filter(js =>
    skills.some(us => us.includes(js) || js.includes(us))
  );
  const jdMissingRequired = jdRequiredLower.filter(js =>
    !skills.some(us => us.includes(js) || js.includes(us))
  );

  // Extra missing skills from JD that student doesn't have (add to missingSkills for display)
  const extraMissing = jdAnalysis.requiredSkills.filter(s =>
    !skills.some(us => us.toLowerCase().includes(s.toLowerCase()) || s.toLowerCase().includes(us.toLowerCase())) &&
    !missingSkills.map(m => m.toLowerCase()).includes(s.toLowerCase())
  );

  const allMissing = [...missingSkills, ...extraMissing.slice(0, 5)];

  const totalSkillsToMatch = Math.max(skills.length, jdRequiredLower.length, 1);
  const matchedCount = strongMatches.length + partialMatches.length * 0.5;
  const jdCoverage = jdRequiredLower.length > 0 ? jdMatchedRequired.length / jdRequiredLower.length : 0.5;
  const skillScore = ((matchedCount / totalSkillsToMatch) * 0.6 + jdCoverage * 0.4) * 50;

  // ── 2. Role Fit (25%) ──
  let roleFitScore = 0;
  if (role) {
    const roleWords = role.split(/\s+/).filter(w => w.length > 2);
    const titleLower = job.job_title.toLowerCase();
    const titleWords = titleLower.split(/\s+/).filter(w => w.length > 2);

    // Exact role word matches in title
    const titleMatchCount = roleWords.filter(w => titleLower.includes(w)).length;
    const roleInTitle = roleWords.length > 0 ? titleMatchCount / roleWords.length : 0;

    // Also check if role words appear in JD
    const roleInJD = roleWords.filter(w => jobText.includes(w)).length / Math.max(roleWords.length, 1);

    roleFitScore = (roleInTitle * 0.7 + roleInJD * 0.3) * 25;
  } else {
    roleFitScore = 10; // Default if no role specified
  }

  // ── 3. Experience Match (15%) ──
  let expScore = 7.5; // Default mid-score
  const studentYears = parseExperienceYears(student.experience);
  if (studentYears > 0 && jdAnalysis.requiredYears > 0) {
    const diff = studentYears - jdAnalysis.requiredYears;
    if (diff >= 0) expScore = 15; // Meets or exceeds
    else if (diff >= -1) expScore = 11; // Close enough
    else if (diff >= -2) expScore = 7; // Slightly under
    else expScore = 3; // Significantly under
  } else if (studentYears > 0) {
    // No years in JD — check seniority alignment
    const studentLevel = studentYears >= 7 ? 'senior' : studentYears >= 3 ? 'mid' : 'junior';
    expScore = studentLevel === jdAnalysis.seniorityLevel ? 15 :
      Math.abs(['junior','mid','senior','lead'].indexOf(studentLevel) - ['junior','mid','senior','lead'].indexOf(jdAnalysis.seniorityLevel)) <= 1 ? 10 : 5;
  }

  // ── 4. Education Match (10%) ──
  let eduScore = 5; // Default
  const studentEdu = parseEducationLevel(student.education);
  if (studentEdu && jdAnalysis.requiredEducation) {
    const eduLevels = { 'diploma': 1, 'other': 1, 'bachelors': 2, 'masters': 3, 'phd': 4 };
    const studentLevel = eduLevels[studentEdu] || 1;
    const requiredLevel = eduLevels[jdAnalysis.requiredEducation] || 1;
    if (studentLevel >= requiredLevel) eduScore = 10;
    else if (studentLevel === requiredLevel - 1) eduScore = 6;
    else eduScore = 2;
  } else if (studentEdu) {
    eduScore = 7; // Has education, JD doesn't specify
  }

  // ── Total Score ──
  const totalScore = Math.min(100, Math.round(skillScore + roleFitScore + expScore + eduScore));

  // ── Summary ──
  const parts = [];
  if (strongMatches.length > 0) parts.push(`Strong skill matches: ${strongMatches.slice(0, 4).join(', ')}`);
  if (partialMatches.length > 0) parts.push(`Partial matches: ${partialMatches.slice(0, 3).join(', ')}`);
  if (allMissing.length > 0) parts.push(`Missing: ${allMissing.slice(0, 4).join(', ')}`);
  if (studentYears > 0 && jdAnalysis.requiredYears > 0) {
    parts.push(`Experience: ${studentYears}yr${studentYears > 1 ? 's' : ''} (needs ${jdAnalysis.requiredYears}+)`);
  }
  if (roleFitScore >= 18) parts.push('Excellent role fit');
  else if (roleFitScore >= 12) parts.push('Good role alignment');

  const summary = parts.length > 0 ? parts.join('. ') + '.'
    : totalScore >= 70 ? 'Strong overall match based on profile alignment.'
    : totalScore >= 40 ? 'Moderate match — some skill gaps to address.'
    : 'Low match — consider upskilling for this role.';

  return {
    score: totalScore,
    strongMatches: [...strongMatches, ...partialMatches.map(p => `${p} (partial)`)],
    missingSkills: allMissing,
    summary,
    jdAnalysis,
  };
}

// ───── Tailored Resume Generation ─────

/** Generate a tailored resume using Gemini AI */
async function generateResumeWithGemini(student, job, matchResult) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const prompt = `Generate a tailored professional resume for the following candidate, optimized for the specific job description below.

CANDIDATE PROFILE:
- Name: ${student.fullName || 'Candidate'}
- Target Role: ${student.jobRole || 'Software Professional'}
- Key Skills: ${(student.keySkills || []).join(', ') || 'Not specified'}
- Experience: ${student.experience || 'Not specified'}
- Education: ${student.education || 'Not specified'}
- Location: ${student.location || 'Not specified'}

JOB DETAILS:
- Title: ${job.job_title}
- Company: ${job.employer_name}
- Description: ${job.jd.substring(0, 2000)}

MATCHING ANALYSIS:
- Strong Matches: ${matchResult.strongMatches.join(', ')}
- Missing Skills: ${matchResult.missingSkills.join(', ')}

FORMAT RULES (CRITICAL — follow exactly):
1. Start with the candidate's name on the first line
2. Second line: target role title
3. Use UPPERCASE section headers on their own line: PROFESSIONAL SUMMARY, PROFESSIONAL EXPERIENCE, EDUCATION, KEY SKILLS, CERTIFICATIONS
4. Professional Summary: 3-4 sentences highlighting relevant experience and skills matching this JD
5. Professional Experience: 2-3 role entries with bullet points emphasizing skills relevant to this JD
6. Education: Degree details
7. Key Skills: Bullet-pointed list organized by relevance to this JD (matched skills first)
8. If candidate is missing key JD skills, add a "NOTES ON ADDRESSED GAPS" section briefly noting transferable skills
9. Do NOT invent fake companies or degrees — use the candidate's actual background, tailoring the emphasis
10. Keep it concise — under 600 words
11. Use plain text only, no markdown formatting like ** or ##`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    return text || null;
  } catch (err) {
    console.warn('[Gemini Resume] Error:', err.message);
    return null;
  }
}

/** Generate a template-based tailored resume (fallback when no AI key) */
function generateTemplateResume(student, job, matchResult) {
  const name = student.fullName || 'Candidate';
  const role = student.jobRole || job.job_title || 'Software Professional';
  const skills = student.keySkills || [];
  const experience = student.experience || '';
  const education = student.education || '';
  const jdAnalysis = matchResult.jdAnalysis || {};

  // Organize skills: matched first, then others
  const matchedSkills = matchResult.strongMatches.map(s => s.replace(' (partial)', ''));
  const otherSkills = skills.filter(s => !matchedSkills.map(m => m.toLowerCase()).includes(s.toLowerCase()));
  const orderedSkills = [...matchedSkills, ...otherSkills];

  // Build professional summary
  const topMatches = matchedSkills.slice(0, 5).join(', ');
  const summaryLine = topMatches
    ? `Results-driven ${role} with expertise in ${topMatches}. Proven track record of delivering high-quality solutions in fast-paced environments. Seeking to leverage technical skills and experience to contribute to ${job.employer_name}'s team as ${job.job_title}.`
    : `Motivated ${role} with a strong foundation in software development and a passion for building impactful solutions. Eager to apply skills and knowledge to the ${job.job_title} role at ${job.employer_name}.`;

  // Build experience section
  let expSection = '';
  if (experience) {
    // Parse experience text — try to structure it
    const expLines = experience.split(/\n|;|\|/).map(l => l.trim()).filter(Boolean);
    expSection = expLines.map(line => {
      // If it's already a structured entry, use it
      if (line.length > 20) return line;
      return `- ${line}`;
    }).join('\n');
  } else {
    expSection = `- Developed and maintained applications using ${orderedSkills.slice(0, 4).join(', ')}\n- Collaborated with cross-functional teams to deliver projects on time\n- Implemented best practices for code quality and testing`;
  }

  // Build education section
  let eduSection = education || 'Bachelor\'s Degree in Computer Science';

  // Build skills section — organized by relevance to JD
  const skillsSection = orderedSkills.length > 0
    ? orderedSkills.map(s => `- ${s}${matchedSkills.includes(s) ? ' (matches JD requirement)' : ''}`).join('\n')
    : '- Software Development\n- Problem Solving\n- Team Collaboration';

  // Build gaps section (if any missing critical skills)
  let gapsSection = '';
  if (matchResult.missingSkills.length > 0) {
    const gaps = matchResult.missingSkills.slice(0, 4);
    gapsSection = `\nNOTES ON ADDRESSED GAPS\n${gaps.map(g => `- ${g}: Demonstrates strong foundational knowledge and ability to quickly upskill in related technologies`).join('\n')}`;
  }

  return `${name}
${role}

PROFESSIONAL SUMMARY
${summaryLine}

PROFESSIONAL EXPERIENCE
${expSection}

EDUCATION
${eduSection}

KEY SKILLS
${skillsSection}${gapsSection}`;
}

// ───── Main Search Function ─────

/**
 * Search for jobs using full student profile, deep score, and generate tailored resumes.
 *
 * @param {Object} student - { id, fullName, email, keySkills, resumeUrl, jobRole, location, experience, education }
 * @param {number} days - how many days back to search
 * @returns {Array} job results with match scores and tailored resumes
 */
async function searchJobs(student, days = 1) {
  const query = student.jobRole || (student.keySkills || []).slice(0, 3).join(' ') || 'Software Developer';
  const location = student.location || '';
  const skills = student.keySkills || [];
  const experience = student.experience || '';
  const education = student.education || '';

  // Resolve regions from student's location
  const regions = resolveSearchRegions(location);
  const experienceYears = parseExperienceYears(experience);
  const expLevel = experienceYears >= 7 ? 'senior' : experienceYears >= 3 ? 'mid' : experienceYears > 0 ? 'junior' : '';

  console.log(`[JS Job Search] Query: "${query}", Regions: ${regions.join(', ')}, Skills: ${skills.length}, Experience: ${experience || 'N/A'}, Level: ${expLevel || 'N/A'}, Days: ${days}`);

  // Search APIs in parallel
  const [jsearchJobs, remotiveJobs] = await Promise.all([
    searchJSearch(query, regions, days, expLevel),
    searchRemotive(query),
  ]);

  const allJobs = [...jsearchJobs, ...remotiveJobs];
  console.log(`[JS Job Search] Found: JSearch=${jsearchJobs.length}, Remotive=${remotiveJobs.length}, Total=${allJobs.length}`);

  if (allJobs.length === 0) return [];

  // Filter out invalid jobs
  const validJobs = allJobs.filter(j => {
    if (!j.job_apply_link || !j.job_apply_link.startsWith('http')) return false;
    if (!j.job_title || !j.employer_name) return false;
    return true;
  });

  if (validJobs.length === 0) return [];

  // Deduplicate
  const seen = new Set();
  const unique = validJobs.filter(j => {
    const key = `${j.employer_name}|${j.job_title}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Deep score
  const scored = unique.map(job => {
    const match = computeMatchScore(job, student);
    return { job, match };
  }).sort((a, b) => b.match.score - a.match.score);

  // Take top 50
  const topResults = scored.slice(0, 50);

  // Generate tailored resumes — Gemini for top 10, template for rest
  const hasGemini = !!process.env.GEMINI_API_KEY;
  console.log(`[JS Job Search] Generating resumes: ${hasGemini ? 'Gemini AI (top 10) + Template' : 'Template-based'} for ${topResults.length} jobs`);

  const results = [];
  for (let i = 0; i < topResults.length; i++) {
    const { job, match } = topResults[i];

    let resumeText = '';
    // Use Gemini for top 10 results (within free tier RPM), template for rest
    if (hasGemini && i < 10) {
      resumeText = await generateResumeWithGemini(student, job, match) || generateTemplateResume(student, job, match);
    } else {
      resumeText = generateTemplateResume(student, job, match);
    }

    results.push({
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
      resume_text: resumeText,
    });
  }

  // Write to Google Sheet — fire and forget
  const sheetRows = results.map(r => [
    '', '', r.candidate_id, r.candidate_name, r.email, r.employer_name,
    String(r.match_score), r.strong_matches, r.missing_skills, r.job_apply_link,
    r.match_summary, r.timestamp, r.pdf_link, r.jd.substring(0, 500), r.resume_text.substring(0, 2000),
  ]);
  appendToSheet(sheetRows).then(ok => {
    if (ok) console.log(`[JS Job Search] Wrote ${results.length} rows to Google Sheet`);
  });

  return results;
}

module.exports = { searchJobs, computeMatchScore, generateResumeWithGemini, generateTemplateResume };
