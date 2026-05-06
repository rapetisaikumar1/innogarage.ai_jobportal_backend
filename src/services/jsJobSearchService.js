/**
 * JS-based Job Search Service
 * Flow: Student profile -> job APIs -> deep match scoring -> top listing results
 */

const axios = require('axios');
const https = require('https');

const httpClient = axios.create({
  timeout: 20000,
  httpsAgent: new https.Agent({ family: 4 }),
});

// ───── In-Memory Cache (TTL-based) ─────

class MemCache {
  constructor(ttlMs = 5 * 60 * 1000) {
    this._store = new Map();
    this._ttl = ttlMs;
  }
  get(key) {
    const entry = this._store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.exp) { this._store.delete(key); return undefined; }
    return entry.val;
  }
  set(key, val) {
    this._store.set(key, { val, exp: Date.now() + this._ttl });
  }
  clear() { this._store.clear(); }
}

const apiCache = new MemCache(5 * 60 * 1000); // 5-minute TTL for API results

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
  // Default to US if no known region matched (prevents random countries)
  if (codes.size === 0) { codes.add('US'); codes.add('UNITED STATES'); }
  return codes;
}

/** Search JSearch (RapidAPI — PRIMARY source) */
async function searchJSearch(query, regions, days, experienceYears, limit = 80) {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) return [];
  try {
    const datePosted = days <= 1 ? 'today' : days <= 3 ? '3days' : days <= 7 ? 'week' : 'month';

    // Build targeted queries for major job boards
    const queries = [];
    // Region-specific queries (Indeed, LinkedIn, ZipRecruiter, Dice pull through)
    for (const r of regions) {
      queries.push(`${query} in ${r}`);
    }
    // Source-targeted queries for better coverage from specific boards
    const topRegion = regions[0] || 'United States';
    queries.push(`${query} in ${topRegion} jobs`);

    const fetchPage = (q, remoteOnly = false, page = 1) => {
      const params = {
        query: q,
        page: String(page),
        num_pages: '10',
        date_posted: datePosted,
        remote_jobs_only: remoteOnly,
      };
      return httpClient.get('https://jsearch.p.rapidapi.com/search', {
        params,
        headers: {
          'X-RapidAPI-Key': apiKey,
          'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
        },
      }).then(res => res.data?.data || []).catch(() => []);
    };

    const delay = (ms) => new Promise(r => setTimeout(r, ms));

    // Execute API calls with delays to avoid 429 rate limits
    const allResults = [];
    for (let i = 0; i < queries.length; i++) {
      const results = await fetchPage(queries[i]);
      allResults.push(...results);
      if (i < queries.length - 1) await delay(500);
    }
    // Remote-only call with region (to avoid random country results)
    await delay(500);
    const remoteResults = await fetchPage(`${query} in ${topRegion}`, true);
    allResults.push(...remoteResults);

    // Strict country filtering — only allow user's chosen regions
    const allowedCodes = getAllowedCountryCodes(regions);
    const filtered = allResults.filter(j => {
      const country = (j.job_country || '').toUpperCase();
      // Allow jobs where country matches user's region OR job is remote with no country
      if (allowedCodes.has(country)) return true;
      // Allow remote jobs that don't specify a country
      if (!j.job_country && j.job_is_remote) return true;
      return false;
    });

    // Deduplicate by employer+title before slicing
    const seenKeys = new Set();
    const deduped = filtered.filter(j => {
      const k = `${j.employer_name}|${j.job_title}`.toLowerCase();
      if (seenKeys.has(k)) return false;
      seenKeys.add(k);
      return true;
    });

    return deduped.slice(0, limit).map(j => ({
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
  } catch {
    return [];
  }
}

/** Search Remotive (remote jobs — SECONDARY source, reduced limit for quality) */
async function searchRemotive(query, limit = 20) {
  try {
    // Try multiple search variations for more results
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const searches = [query];
    if (words.length > 1) searches.push(words[0]); // single keyword search
    
    const allJobs = [];
    for (const q of searches) {
      const { data } = await httpClient.get('https://remotive.com/api/remote-jobs', {
        params: { search: q, limit },
      });
      allJobs.push(...(data.jobs || []));
    }
    // Deduplicate by id
    const seen = new Set();
    const unique = allJobs.filter(j => {
      if (!j.url || !j.url.startsWith('http') || seen.has(j.id)) return false;
      seen.add(j.id);
      return true;
    });
    return unique.map(j => ({
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
  } catch {
    return [];
  }
}

/** Search RemoteOK (additional remote tech jobs — FREE, no auth, reduced limit for quality) */
async function searchRemoteOK(query, limit = 20) {
  try {
    const { data } = await httpClient.get('https://remoteok.com/api', {
      headers: { 'User-Agent': 'INNOGARAGE-JobSearch/1.0' },
      timeout: 10000,
    });
    // First item is metadata, actual jobs start from index 1
    const jobs = (Array.isArray(data) ? data.slice(1) : []);
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    // Score each job by how many query words match
    const scored = jobs.map(j => {
      const text = `${j.position || ''} ${(j.tags || []).join(' ')} ${j.company || ''} ${j.description || ''}`.toLowerCase();
      const hits = queryWords.filter(w => text.includes(w)).length;
      return { j, hits };
    }).filter(({ hits }) => hits >= 2)  // Require at least 2 keyword matches for quality
      .sort((a, b) => b.hits - a.hits)
      .slice(0, limit);
    return scored.map(({ j }) => ({
      employer_name: j.company || '',
      job_title: j.position || '',
      job_city: 'Remote',
      job_state: '',
      job_country: '',
      job_employment_type: 'FULLTIME',
      job_apply_link: j.url ? (j.url.startsWith('http') ? j.url : `https://remoteok.com${j.url}`) : '',
      employer_logo: j.company_logo || '',
      jd: (j.description || '').replace(/<[^>]*>/g, ' ').substring(0, 3000),
      source: 'RemoteOK',
      posted: j.date || '',
      job_min_salary: j.salary_min || '',
      job_max_salary: j.salary_max || '',
      job_salary_currency: 'USD',
    }));
  } catch {
    return [];
  }
}

/** Search Arbeitnow (free job API — no auth needed) */
async function searchArbeitnow(query, limit = 50) {
  try {
    const { data } = await httpClient.get('https://www.arbeitnow.com/api/job-board-api', {
      timeout: 10000,
    });
    const jobs = data?.data || [];
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const scored = jobs.map(j => {
      const text = `${j.title || ''} ${j.company_name || ''} ${(j.tags || []).join(' ')} ${j.description || ''}`.toLowerCase();
      const hits = queryWords.filter(w => text.includes(w)).length;
      return { j, hits };
    }).filter(({ hits }) => hits >= 2)  // Require at least 2 keyword matches for quality
      .sort((a, b) => b.hits - a.hits)
      .slice(0, limit);
    return scored.map(({ j }) => ({
      employer_name: j.company_name || '',
      job_title: j.title || '',
      job_city: j.location || '',
      job_state: '',
      job_country: '',
      job_employment_type: j.remote ? 'Remote' : 'FULLTIME',
      job_apply_link: j.url || '',
      employer_logo: '',
      jd: (j.description || '').replace(/<[^>]*>/g, ' ').substring(0, 3000),
      source: 'Arbeitnow',
      posted: j.created_at ? new Date(j.created_at * 1000).toISOString() : '',
    }));
  } catch {
    return [];
  }
}

/** Search Jobicy (free remote job API — no auth needed) */
async function searchJobicy(query, limit = 50) {
  try {
    const tag = query.split(/\s+/)[0].toLowerCase();
    const { data } = await httpClient.get(`https://jobicy.com/api/v2/remote-jobs`, {
      params: { count: limit, tag },
      timeout: 10000,
    });
    const jobs = data?.jobs || [];
    return jobs.map(j => ({
      employer_name: j.companyName || '',
      job_title: j.jobTitle || '',
      job_city: j.jobGeo || 'Remote',
      job_state: '',
      job_country: j.jobGeo || '',
      job_employment_type: j.jobType || '',
      job_apply_link: j.url || '',
      employer_logo: j.companyLogo || '',
      jd: (j.jobDescription || '').replace(/<[^>]*>/g, ' ').substring(0, 3000),
      source: 'Jobicy',
      posted: j.pubDate || '',
      job_min_salary: j.annualSalaryMin || '',
      job_max_salary: j.annualSalaryMax || '',
      job_salary_currency: j.salaryCurrency || 'USD',
    }));
  } catch {
    return [];
  }
}

// ───── Module-Level Constants (allocated once, not per-call) ─────

const TECH_EXTRACT_RE = /\b(Java|Python|JavaScript|TypeScript|React|Angular|Vue|Next\.?js|Node\.?js|Express|NestJS|Spring|Django|Flask|FastAPI|AWS|Azure|GCP|Docker|Kubernetes|SQL|NoSQL|MongoDB|PostgreSQL|MySQL|Redis|GraphQL|REST|Git|CI\/CD|Agile|Scrum|HTML|CSS|Tailwind|Bootstrap|C\+\+|C#|\.NET|Go|Rust|Swift|Kotlin|PHP|Ruby|Rails|Laravel|TensorFlow|PyTorch|Machine Learning|AI|Data Science|DevOps|Linux|Terraform|Kafka|Microservices|Selenium|Jest|Figma|Jira|Salesforce|SAP|Oracle|Flutter|React Native|Pandas|NumPy|Power\s?BI|Tableau|Spark|Hadoop|Snowflake|Databricks|Cypress|Playwright|Webpack|Vite|Nginx|Prometheus|Grafana|Jenkins|CRM|PowerPlatform|Power\s?Apps|Dynamics|AEP|Adobe|Marketo|HubSpot|MERN|MEAN|Full\s*Stack|Frontend|Backend|Web\s*Development|Mobile\s*Development|Cloud|API|Blockchain|Web3|Unity|Unreal)\b/gi;

const SKILL_ALIASES = {
  'node.js': ['node', 'nodejs', 'node.js', 'node js'],
  'node': ['node', 'nodejs', 'node.js', 'node js'],
  'nodejs': ['node', 'nodejs', 'node.js'],
  'react': ['react', 'reactjs', 'react.js'],
  'react.js': ['react', 'reactjs', 'react.js'],
  'reactjs': ['react', 'reactjs', 'react.js'],
  'vue': ['vue', 'vuejs', 'vue.js'],
  'vue.js': ['vue', 'vuejs', 'vue.js'],
  'angular': ['angular', 'angularjs', 'angular.js'],
  'angularjs': ['angular', 'angularjs'],
  'next.js': ['next', 'nextjs', 'next.js'],
  'nextjs': ['next', 'nextjs', 'next.js'],
  'typescript': ['typescript', 'ts '],
  'ts': ['typescript', ' ts '],
  'javascript': ['javascript', 'js ', 'ecmascript'],
  'js': ['javascript', ' js '],
  'java': ['java', ' java '],
  'python': ['python'],
  'c++': ['c++', 'cpp', 'c plus plus'],
  'cpp': ['c++', 'cpp'],
  'c#': ['c#', 'csharp', 'c sharp', 'c-sharp'],
  'csharp': ['c#', 'csharp'],
  '.net': ['.net', 'dotnet', 'dot net', 'asp.net'],
  'dotnet': ['.net', 'dotnet'],
  'aws': ['aws', 'amazon web services', 'amazon cloud'],
  'gcp': ['gcp', 'google cloud'],
  'azure': ['azure', 'microsoft cloud'],
  'ci/cd': ['ci/cd', 'cicd', 'ci cd', 'continuous integration', 'continuous delivery'],
  'postgresql': ['postgresql', 'postgres', 'psql'],
  'postgres': ['postgresql', 'postgres'],
  'mongodb': ['mongodb', 'mongo'],
  'mongo': ['mongodb', 'mongo'],
  'machine learning': ['machine learning', ' ml ', 'deep learning'],
  'ml': ['machine learning', ' ml '],
  'artificial intelligence': ['artificial intelligence', ' ai ', 'machine learning'],
  'ai': ['artificial intelligence', ' ai ', 'machine learning'],
  'ui/ux': ['ui/ux', 'uiux', 'ui ux', 'user experience', 'user interface', 'ux design'],
  'devops': ['devops', 'dev ops', 'site reliability'],
  'docker': ['docker', 'container'],
  'kubernetes': ['kubernetes', 'k8s'],
  'k8s': ['kubernetes', 'k8s'],
  'sql': ['sql', 'database', 'relational database'],
  'nosql': ['nosql', 'no-sql', 'non-relational'],
  'graphql': ['graphql', 'graph ql'],
  'rest': ['rest', 'restful', 'rest api'],
  'api': ['api', 'apis', 'rest api', 'web service'],
  'html': ['html', 'html5'],
  'css': ['css', 'css3', 'stylesheet'],
  'tailwind': ['tailwind', 'tailwindcss'],
  'bootstrap': ['bootstrap'],
  'express': ['express', 'express.js', 'expressjs'],
  'express.js': ['express', 'express.js', 'expressjs'],
  'spring': ['spring', 'spring boot', 'springboot'],
  'spring boot': ['spring boot', 'springboot', 'spring'],
  'django': ['django'],
  'flask': ['flask'],
  'laravel': ['laravel'],
  'ruby': ['ruby', 'ruby on rails'],
  'rails': ['rails', 'ruby on rails'],
  'go': ['golang', ' go '],
  'golang': ['golang', ' go '],
  'rust': ['rust', ' rust '],
  'swift': ['swift', 'swiftui'],
  'kotlin': ['kotlin'],
  'flutter': ['flutter'],
  'react native': ['react native', 'react-native'],
  'terraform': ['terraform', 'iac', 'infrastructure as code'],
  'jenkins': ['jenkins', 'ci/cd'],
  'git': [' git ', 'github', 'gitlab', 'version control'],
  'agile': ['agile', 'scrum', 'kanban'],
  'scrum': ['scrum', 'agile'],
  'jira': ['jira'],
  'linux': ['linux', 'unix', 'ubuntu'],
  'crm': ['crm', 'customer relationship', 'dynamics crm', 'salesforce'],
  'powerplatform': ['power platform', 'powerplatform', 'power apps', 'powerapps'],
  'power platform': ['power platform', 'powerplatform', 'power apps'],
  'salesforce': ['salesforce', 'sfdc', 'crm'],
  'sap': ['sap', 'sap hana'],
  'oracle': ['oracle', 'oracle db'],
  'aep': ['aep', 'adobe experience platform', 'adobe'],
  'aep devloper': ['aep', 'adobe experience platform', 'adobe', 'experience platform'],
  'aep developer': ['aep', 'adobe experience platform', 'adobe', 'experience platform'],
  'full stack': ['full stack', 'fullstack', 'full-stack'],
  'fullstack': ['full stack', 'fullstack', 'full-stack'],
  'full-stack': ['full stack', 'fullstack', 'full-stack'],
  'frontend': ['frontend', 'front end', 'front-end', 'ui'],
  'front end': ['frontend', 'front end', 'front-end'],
  'backend': ['backend', 'back end', 'back-end', 'server side'],
  'back end': ['backend', 'back end', 'back-end'],
  'mern': ['mern', 'mongodb', 'express', 'react', 'node'],
  'mean': ['mean', 'mongodb', 'express', 'angular', 'node'],
  'data science': ['data science', 'data scientist', 'data analysis'],
  'web development': ['web development', 'web developer', 'web app'],
  'mobile development': ['mobile development', 'mobile developer', 'mobile app'],
  'cloud': ['cloud', 'aws', 'azure', 'gcp'],
  'blockchain': ['blockchain', 'web3', 'smart contract'],
  'figma': ['figma', 'design tool'],
  'selenium': ['selenium', 'test automation'],
  'cypress': ['cypress', 'test automation'],
  'jest': ['jest', 'unit test'],
  'pandas': ['pandas', 'data analysis'],
  'numpy': ['numpy', 'numerical'],
  'tableau': ['tableau', 'data visualization'],
  'power bi': ['power bi', 'powerbi', 'data visualization'],
  'spark': ['spark', 'apache spark', 'pyspark'],
  'kafka': ['kafka', 'event streaming', 'message queue'],
  'redis': ['redis', 'caching', 'in-memory'],
  'elasticsearch': ['elasticsearch', 'elastic', 'search engine'],
  'firebase': ['firebase', 'firestore'],
  'supabase': ['supabase'],
  'prisma': ['prisma', 'orm'],
  'nginx': ['nginx', 'reverse proxy'],
  'webpack': ['webpack', 'bundler'],
  'vite': ['vite', 'bundler'],
};

const IMPLIED_BY = {
  'javascript': ['react', 'angular', 'vue', 'next.js', 'nextjs', 'nuxt', 'typescript', 'node.js', 'nodejs', 'express', 'jquery', 'svelte', 'gatsby'],
  'html': ['react', 'angular', 'vue', 'next.js', 'frontend', 'front end', 'web developer', 'ui developer'],
  'css': ['react', 'angular', 'vue', 'next.js', 'frontend', 'front end', 'tailwind', 'bootstrap', 'sass', 'scss'],
  'java': ['spring', 'spring boot', 'springboot', 'hibernate', 'jpa'],
  'python': ['django', 'flask', 'fastapi', 'pandas', 'numpy', 'tensorflow', 'pytorch', 'scikit'],
  'ruby': ['rails', 'ruby on rails'],
  'php': ['laravel', 'symfony', 'wordpress'],
  'typescript': ['angular', 'next.js', 'nextjs', 'nestjs'],
};

// Generic role suffixes/prefixes that should NOT be used alone for relevance matching
// (because every dev job contains "developer", "engineer", etc.)
const GENERIC_ROLE_WORDS = new Set([
  'developer','engineer','designer','analyst','architect','consultant','manager',
  'administrator','scientist','specialist','programmer','dev','eng','lead','senior',
  'sr','junior','jr','staff','principal','associate','intern','head','director',
  'officer','professional','expert','team','member','worker','employee','position',
  'role','full','part','time','stack','software','tech','it','data',
]);

/**
 * Extract meaningful role-specific keywords from a user-entered job role string.
 * Filters out generic words like "developer", "engineer" that match any tech job.
 * Example: "AEP DEVELOPER" → ["aep"]; "Salesforce Admin" → ["salesforce"]
 */
function extractRoleKeywords(rawRole) {
  if (!rawRole) return [];
  return rawRole
    .toLowerCase()
    .split(/[\s/,+&|()\-_.]+/)
    .map(w => w.trim())
    .filter(w => w.length >= 2 && !GENERIC_ROLE_WORDS.has(w));
}

function normalizeProfileSkills(rawSkills) {
  const normalized = new Set();

  for (const raw of rawSkills || []) {
    const original = String(raw || '').trim();
    const lower = original.toLowerCase();
    if (!lower) continue;

    const techMatches = original.match(TECH_EXTRACT_RE) || [];
    techMatches.forEach((match) => normalized.add(match.toLowerCase().trim()));

    const acronymMatches = [...original.matchAll(/\(([A-Za-z0-9-]{2,12})\)/g)];
    acronymMatches.forEach((match) => normalized.add(match[1].toLowerCase()));

    if (lower.includes('adobe experience platform')) normalized.add('adobe experience platform');
    if (lower.includes('customer data platform')) normalized.add('customer data platform');
    if (lower.includes('real-time customer data platform')) normalized.add('real-time customer data platform');
    if (lower.includes('marketo')) normalized.add('marketo');
    if (lower.includes('salesforce')) normalized.add('salesforce');
    if (lower.includes('power bi')) normalized.add('power bi');

    if (lower.length <= 30) {
      normalized.add(lower);
    }

    if (lower.includes('adobe experience platform')) {
      normalized.delete('adobe');
    }
  }

  return [...normalized].filter(Boolean);
}

function hasBusinessRoleMismatch(jobTitle, studentRole) {
  const title = (jobTitle || '').toLowerCase();
  const role = (studentRole || '').toLowerCase();

  const technicalTerms = ['developer', 'engineer', 'architect', 'consultant', 'analyst', 'administrator', 'admin', 'specialist', 'programmer'];
  const businessTerms = ['manager', 'director', 'executive', 'sales', 'recruiter', 'marketing', 'account manager', 'account executive', 'program manager', 'product manager'];

  const userIsTechnical = technicalTerms.some(term => role.includes(term));
  const titleIsTechnical = technicalTerms.some(term => title.includes(term));
  const titleIsBusiness = businessTerms.some(term => title.includes(term));

  return userIsTechnical && titleIsBusiness && !titleIsTechnical;
}

const DOMAIN_KEYWORDS = {
  frontend: ['frontend', 'front end', 'front-end', 'react', 'angular', 'vue', 'ui ', 'web developer'],
  backend: ['backend', 'back end', 'back-end', 'server', 'api developer', 'node.js developer', 'java developer', 'python developer'],
  fullstack: ['full stack', 'fullstack', 'full-stack', 'mern', 'mean'],
  devops: ['devops', 'dev ops', 'sre', 'infrastructure', 'cloud engineer', 'platform engineer'],
  data: ['data engineer', 'data scientist', 'data analyst', 'machine learning', 'ml engineer', 'ai engineer'],
  mobile: ['mobile', 'ios', 'android', 'flutter', 'react native'],
  security: ['security', 'cybersecurity', 'infosec', 'penetration'],
};

// ───── Profile-Based Relevance & Location Gates ─────

/**
 * Hard relevance gate: a job is relevant only if it matches the user's profile
 * on at least one of:
 *   1) A meaningful role keyword (excluding generic words like "developer")
 *      appears in the job title or top of the JD.
 *   2) At least one strong skill match exists.
 *   3) Any of the user's key-skill aliases appears verbatim in the title.
 *
 * This is what stops random tech jobs from being shown for niche profiles
 * (e.g., AEP Developer + Adobe Experience Platform skills must see Adobe/AEP jobs).
 */
function isJobRelevantToProfile(job, student, match) {
  const title = (job.job_title || '').toLowerCase();
  const jd = (job.jd || '').toLowerCase();
  const haystack = `${title} ${jd}`;

  if (hasBusinessRoleMismatch(job.job_title, student.jobRole)) return false;

  // 1) Strong skill match (computed by computeMatchScore against title+JD)
  if ((match.strongMatches || []).length >= 1) return true;

  // 2) Role-specific keyword in title or JD (excluding generic words)
  const roleKeywords = extractRoleKeywords(student.jobRole);
  if (roleKeywords.length > 0 && roleKeywords.some(w => haystack.includes(w))) {
    return true;
  }

  // 3) Skill aliases in title (covers cases where computeMatchScore split differently)
  const skills = normalizeProfileSkills(student.keySkills || []);
  for (const skill of skills) {
    const aliases = SKILL_ALIASES[skill] || [skill];
    if (aliases.some(a => a && a.length >= 3 && haystack.includes(a))) return true;
  }

  return false;
}

/**
 * Strict location filter: when the user has set a preferred location, drop jobs
 * whose country does not match AND whose JD/title does not mention the region.
 * Pure "Anywhere" remote jobs are dropped if they don't mention the user's region.
 */
function jobMatchesPreferredLocation(job, allowedCodes, allowedRegionTerms, userSetLocation) {
  const country = (job.job_country || '').toUpperCase();
  if (country && allowedCodes.has(country)) return true;

  const text = `${(job.job_title || '').toLowerCase()} ${(job.job_city || '').toLowerCase()} ${(job.jd || '').toLowerCase()}`;

  // If the JD/title explicitly references the user's region, allow
  if (allowedRegionTerms.some(term => text.includes(term))) return true;

  // If user did NOT specify a location, allow remote/anywhere jobs without country
  if (!userSetLocation) {
    if (!country) return true;
    return false;
  }

  // User set a location — only allow if there's NO country and the job is clearly remote AND
  // does not specify any other country.
  // Free-API "Anywhere" without any region marker is considered too risky and dropped.
  return false;
}

function buildAllowedRegionTerms(regions) {
  const terms = new Set();
  for (const r of regions) {
    const rl = r.toLowerCase();
    terms.add(rl);
    if (rl.includes('united states')) { terms.add('usa'); terms.add('u.s.'); terms.add('u.s'); terms.add('us '); terms.add('america'); terms.add('north america'); }
    if (rl.includes('canada')) { terms.add('canada'); terms.add('ca '); }
    if (rl.includes('united kingdom')) { terms.add('uk'); terms.add('britain'); terms.add('england'); }
    if (rl.includes('india')) { terms.add('india'); terms.add('bharat'); }
    if (rl.includes('australia')) { terms.add('australia'); terms.add('aus '); }
    if (rl.includes('germany')) { terms.add('germany'); terms.add('deutschland'); }
  }
  return Array.from(terms);
}

// ───── Resume Section Extractor ─────

/** Extract a section (experience, education, skills) from parsed resume text */
function extractResumeSection(resumeText, sectionName) {
  if (!resumeText) return '';
  const patterns = {
    experience: /(?:PROFESSIONAL\s*EXPERIENCE|WORK\s*EXPERIENCE|EXPERIENCE)\s*\n([\s\S]*?)(?=\n\s*(?:EDUCATION|SKILLS|KEY\s*SKILLS|TECHNICAL\s*SKILLS|CERTIFICATIONS|PROJECTS|$))/i,
    education: /(?:EDUCATION)\s*\n([\s\S]*?)(?=\n\s*(?:EXPERIENCE|SKILLS|KEY\s*SKILLS|TECHNICAL\s*SKILLS|CERTIFICATIONS|PROJECTS|$))/i,
    skills: /(?:SKILLS|KEY\s*SKILLS|TECHNICAL\s*SKILLS|CORE\s*COMPETENCIES)\s*\n([\s\S]*?)(?=\n\s*(?:EXPERIENCE|EDUCATION|CERTIFICATIONS|PROJECTS|$))/i,
  };
  const re = patterns[sectionName];
  if (!re) return '';
  const match = resumeText.match(re);
  return match ? match[1].trim().substring(0, 2000) : '';
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
  const rawSkills = normalizeProfileSkills(student.keySkills || []);
  const role = (student.jobRole || '').toLowerCase();
  const jdAnalysis = analyzeJD(job.jd);
  const jobText = `${job.job_title} ${job.jd}`.toLowerCase();

  const roleSkills = normalizeProfileSkills([student.jobRole || '']);
  const expSkills = normalizeProfileSkills((student.experience || '').match(TECH_EXTRACT_RE) || []);
  // Also extract skills from parsed resume text
  const resumeSkills = normalizeProfileSkills((student.parsedResumeText || '').match(TECH_EXTRACT_RE) || []);
  const extractedSkills = [...new Set([...roleSkills, ...expSkills, ...resumeSkills].map(s => s.toLowerCase().trim()))];

  // Merge: keySkills + extracted skills from role/experience (deduplicated)
  const allStudentSkills = [...new Set([...rawSkills, ...extractedSkills])];
  const skills = allStudentSkills.length > 0 ? allStudentSkills : rawSkills;

  if (skills.length === 0 && !role) {
    // Even with no skills, show what the JD requires
    const jdSkillsList = (jdAnalysis.jdSkills || []).slice(0, 8);
    return {
      score: 30,
      strongMatches: [],
      missingSkills: jdSkillsList.length > 0 ? jdSkillsList : ['Update your profile skills for better matching'],
      summary: 'No skills in profile — add your key skills for better job matching.',
      jdAnalysis
    };
  }

  // ── 1. Skills Match (50%) ──
  const strongMatches = [];
  const missingSkills = [];
  const partialMatches = [];

  for (const skill of skills) {
    const skillLower = skill.toLowerCase();
    const aliases = SKILL_ALIASES[skillLower] || [skillLower];
    let matched = aliases.some(alias => jobText.includes(alias));
    if (!matched && IMPLIED_BY[skillLower]) {
      matched = IMPLIED_BY[skillLower].some(framework => jobText.includes(framework));
    }
    if (matched) {
      strongMatches.push(skill);
    } else {
      // Fuzzy: only count as partial if a non-generic acronym matches or
      // at least two meaningful tokens match. Single generic words like
      // "experience" or "platform" should never qualify.
      const skillWords = skillLower
        .split(/[\s/.\-()]+/)
        .filter(w => w.length > 2 && !GENERIC_ROLE_WORDS.has(w));
      const acronymMatch = skillWords.find(w => /^[a-z]{2,12}(?:-[a-z]{2,12})?$/.test(w) && jobText.includes(w));
      const partialHits = skillWords.filter(w => jobText.includes(w)).length;
      const hasPartial = Boolean(acronymMatch) || partialHits >= 2;
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

  // Skill scoring: use student's own skills as denominator (not JD's long list)
  const studentSkillCount = Math.max(skills.length, 1);
  const matchedCount = strongMatches.length + partialMatches.length * 0.85;
  const studentCoverage = Math.min(matchedCount / studentSkillCount, 1.0); // How many of YOUR skills matched
  const jdCoverage = jdRequiredLower.length > 0 ? jdMatchedRequired.length / jdRequiredLower.length : 0.5;
  // Weight student coverage heavily — if most of your skills match, that's great
  const skillScore = (studentCoverage * 0.82 + jdCoverage * 0.18) * 50;

  // ── 2. Role Fit (25%) ──
  let roleFitScore = 0;
  if (role) {
    const roleWords = extractRoleKeywords(student.jobRole);
    const fallbackRoleWords = roleWords.length > 0
      ? roleWords
      : role.split(/\s+/).filter(w => w.length > 2 && !['developer', 'engineer', 'designer', 'analyst', 'architect', 'consultant', 'manager'].includes(w));
    const titleLower = job.job_title.toLowerCase();

    // Exact role word matches in title
    const titleMatchCount = fallbackRoleWords.filter(w => titleLower.includes(w)).length;
    const roleInTitle = fallbackRoleWords.length > 0 ? titleMatchCount / fallbackRoleWords.length : 0;

    // Also check if role words appear in JD
    const roleInJD = fallbackRoleWords.filter(w => jobText.includes(w)).length / Math.max(fallbackRoleWords.length, 1);

    roleFitScore = (roleInTitle * 0.7 + roleInJD * 0.3) * 25;
  } else {
    roleFitScore = 10; // Default if no role specified
  }

  // ── 3. Experience Match (15%) ──
  let expScore = 9; // Default mid-score (more generous)
  const studentYears = parseExperienceYears(student.experience);
  if (studentYears > 0 && jdAnalysis.requiredYears > 0) {
    const diff = studentYears - jdAnalysis.requiredYears;
    if (diff >= 0) expScore = 15; // Meets or exceeds
    else if (diff >= -1) expScore = 12; // Close enough
    else if (diff >= -2) expScore = 10; // Slightly under
    else expScore = 5; // Significantly under
  } else if (studentYears > 0) {
    // No years in JD — check seniority alignment
    const studentLevel = studentYears >= 7 ? 'senior' : studentYears >= 3 ? 'mid' : 'junior';
    expScore = studentLevel === jdAnalysis.seniorityLevel ? 15 :
      Math.abs(['junior','mid','senior','lead'].indexOf(studentLevel) - ['junior','mid','senior','lead'].indexOf(jdAnalysis.seniorityLevel)) <= 1 ? 10 : 5;
  }

  // ── 4. Education Match (10%) ──
  let eduScore = 7; // Default (generous baseline)
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

  // ── 5. Category & Relevance Bonus (up to +5) ──
  let bonusScore = 0;
  const titleAndJD = `${job.job_title} ${job.jd}`.toLowerCase();
  const roleLower = role.toLowerCase();
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    const studentInDomain = keywords.some(kw => roleLower.includes(kw) || skills.some(s => s.toLowerCase().includes(kw)));
    const jobInDomain = keywords.some(kw => titleAndJD.includes(kw));
    if (studentInDomain && jobInDomain) { bonusScore = 5; break; }
  }

  // ── Total Score ──
  const totalScore = Math.min(100, Math.round(skillScore + roleFitScore + expScore + eduScore + bonusScore));

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
    strongMatches,
    partialMatches,
    missingSkills: allMissing,
    summary,
    jdAnalysis,
  };
}

// ───── Tailored Resume Generation ─────

// Cache OpenAI client to avoid re-creating per call
let _openaiClient = null;
function getOpenAIClient() {
  if (!_openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;
    const OpenAI = require('openai');
    _openaiClient = new OpenAI({ apiKey });
  }
  return _openaiClient;
}

/** Generate a tailored resume using OpenAI GPT (with 8s timeout) */
async function generateResumeWithAI(student, job, matchResult) {
  const openai = getOpenAIClient();
  if (!openai) return null;

  try {
    const prompt = `Generate a tailored resume for this candidate for the job below. Be concise (under 500 words).

CANDIDATE: ${student.fullName || 'Candidate'} | Role: ${student.jobRole || 'Software Professional'}
Skills: ${(student.keySkills || []).join(', ')}
Experience: ${student.experience || 'Not specified'}
Education: ${student.education || 'Not specified'}
${student.parsedResumeText ? `Original Resume Content:\n${student.parsedResumeText.substring(0, 1500)}` : ''}

JOB: ${job.job_title} at ${job.employer_name}
JD: ${job.jd.substring(0, 1200)}

Matched Skills: ${matchResult.strongMatches.slice(0, 6).join(', ')}
Missing: ${matchResult.missingSkills.slice(0, 5).join(', ')}

FORMAT: Plain text only. Start with candidate name, then role title. Use UPPERCASE headers: PROFESSIONAL SUMMARY, PROFESSIONAL EXPERIENCE, EDUCATION, KEY SKILLS. If missing key skills, add NOTES ON ADDRESSED GAPS. No markdown (**,##).`;

    // Race against 8s timeout
    const aiCall = openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 800,
      temperature: 0.7,
    });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000));
    const response = await Promise.race([aiCall, timeout]);
    return response.choices?.[0]?.message?.content || null;
  } catch {
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
  const resumeText = student.parsedResumeText || '';
  const partials = matchResult.partialMatches || [];

  // Organize skills by relevance
  const matchedSkills = matchResult.strongMatches || [];
  const partialSkills = partials.filter(s => !matchedSkills.map(m => m.toLowerCase()).includes(s.toLowerCase()));
  // Also pull extra skills from parsed resume
  const resumeSkillsRaw = resumeText ? (resumeText.match(TECH_EXTRACT_RE) || []).map(s => s.trim()) : [];
  const allKnown = new Set([...matchedSkills, ...partialSkills, ...skills].map(s => s.toLowerCase()));
  const extraResumeSkills = [...new Set(resumeSkillsRaw.filter(s => !allKnown.has(s.toLowerCase())))].slice(0, 8);
  const otherSkills = [...skills.filter(s =>
    !matchedSkills.map(m => m.toLowerCase()).includes(s.toLowerCase()) &&
    !partialSkills.map(p => p.toLowerCase()).includes(s.toLowerCase())
  ), ...extraResumeSkills];

  const topMatches = matchedSkills.slice(0, 5).join(', ');
  const yearsText = experience.match(/(\d+)\s*\+?\s*year/i)?.[0] || '';

  // Professional Summary
  const summaryLine = topMatches
    ? `${role}${yearsText ? ` with ${yearsText} of experience` : ''} specializing in ${topMatches}. Proven ability to deliver scalable, production-ready solutions. Seeking to contribute expertise to ${job.employer_name || 'a forward-thinking team'} as ${job.job_title}.`
    : `${role} with a strong technical foundation${yearsText ? ` and ${yearsText} of experience` : ''}. Passionate about building impactful solutions and eager to apply skills to the ${job.job_title} role at ${job.employer_name || 'your organization'}.`;

  // Experience Section — prefer form field, fall back to parsed resume
  let expSection = '';
  const expSource = experience || extractResumeSection(resumeText, 'experience') || '';
  if (expSource) {
    const expLines = expSource.split(/\n|;|\|/).map(l => l.trim()).filter(Boolean);
    expSection = expLines.map(line => line.length > 20 ? line : `  • ${line}`).join('\n');
  } else {
    const techList = [...matchedSkills, ...partialSkills].slice(0, 4).join(', ') || 'modern technologies';
    expSection = `  • Developed and maintained applications using ${techList}\n  • Collaborated with cross-functional teams to deliver projects on schedule\n  • Implemented best practices for code quality, testing, and documentation`;
  }

  // Education Section — prefer form field, fall back to parsed resume
  const eduSection = education || extractResumeSection(resumeText, 'education') || "Bachelor's Degree in Computer Science";

  // Technical Skills — grouped by match status
  const skillLines = [];
  if (matchedSkills.length > 0) {
    skillLines.push(`  Core Skills (JD Match): ${matchedSkills.join(' | ')}`);
  }
  if (partialSkills.length > 0) {
    skillLines.push(`  Related Skills: ${partialSkills.join(' | ')}`);
  }
  if (otherSkills.length > 0) {
    skillLines.push(`  Additional Skills: ${otherSkills.join(' | ')}`);
  }
  if (skillLines.length === 0) {
    skillLines.push('  Software Development | Problem Solving | Team Collaboration');
  }

  const sections = [
    `${name}`,
    `${role}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    'PROFESSIONAL SUMMARY',
    '─────────────────────',
    summaryLine,
    '',
    'TECHNICAL SKILLS',
    '─────────────────────',
    ...skillLines,
    '',
    'PROFESSIONAL EXPERIENCE',
    '─────────────────────',
    expSection,
    '',
    'EDUCATION',
    '─────────────────────',
    eduSection,
  ];

  return sections.join('\n');
}

// ───── Smart Query Builder ─────

/** Map of common misspelled/non-standard role names to proper job titles */
const ROLE_NORMALIZATION = {
  'aep devloper': 'Adobe Experience Platform Developer',
  'aep developer': 'Adobe Experience Platform Developer',
  'aepdevloper': 'Adobe Experience Platform Developer',
  'aep': 'Adobe Experience Platform Developer',
  'mern stack': 'MERN Stack Developer',
  'mean stack': 'MEAN Stack Developer',
  'full stack': 'Full Stack Developer',
  'fullstack': 'Full Stack Developer',
  'full-stack': 'Full Stack Developer',
  'frontend': 'Frontend Developer',
  'front end': 'Frontend Developer',
  'front-end': 'Frontend Developer',
  'backend': 'Backend Developer',
  'back end': 'Backend Developer',
  'back-end': 'Backend Developer',
  'devops': 'DevOps Engineer',
  'sre': 'Site Reliability Engineer',
  'qa': 'QA Engineer',
  'ml engineer': 'Machine Learning Engineer',
  'ai engineer': 'AI Engineer',
  'data engineer': 'Data Engineer',
  'data scientist': 'Data Scientist',
  'data analyst': 'Data Analyst',
  'cloud engineer': 'Cloud Engineer',
  'ui/ux': 'UI/UX Designer',
  'ux designer': 'UX Designer',
  'ui designer': 'UI Designer',
  'ios developer': 'iOS Developer',
  'android developer': 'Android Developer',
  'mobile developer': 'Mobile Developer',
  'web developer': 'Web Developer',
  'react developer': 'React Developer',
  'node developer': 'Node.js Developer',
  'python developer': 'Python Developer',
  'java developer': 'Java Developer',
  'dotnet developer': '.NET Developer',
  '.net developer': '.NET Developer',
  'salesforce developer': 'Salesforce Developer',
  'crm developer': 'CRM Developer',
  'dynamics crm developer': 'Microsoft Dynamics CRM Developer',
  'sap consultant': 'SAP Consultant',
  'blockchain developer': 'Blockchain Developer',
  'security engineer': 'Security Engineer',
  'cybersecurity': 'Cybersecurity Engineer',
  'database admin': 'Database Administrator',
  'dba': 'Database Administrator',
  'sys admin': 'System Administrator',
  'network engineer': 'Network Engineer',
  'embedded': 'Embedded Software Engineer',
  'firmware': 'Firmware Engineer',
};

/** Normalize a raw job role string into a proper searchable job title */
function normalizeJobTitle(rawRole) {
  if (!rawRole) return 'Software Developer';
  const lower = rawRole.toLowerCase().trim();

  // Check exact match in normalization map
  if (ROLE_NORMALIZATION[lower]) return ROLE_NORMALIZATION[lower];

  // Check partial match
  for (const [key, normalized] of Object.entries(ROLE_NORMALIZATION)) {
    if (lower.includes(key) || key.includes(lower)) return normalized;
  }

  // If the role already looks like a proper title (has "developer", "engineer", "designer", etc.), use it
  if (/\b(developer|engineer|designer|analyst|architect|consultant|manager|administrator|scientist|specialist)\b/i.test(rawRole)) {
    // Clean up: capitalize words properly
    return rawRole.replace(/\b\w/g, c => c.toUpperCase()).trim();
  }

  // Try to make a proper title: "react" → "React Developer", "java" → "Java Developer"
  const techToRole = {
    'react': 'React Developer', 'angular': 'Angular Developer', 'vue': 'Vue.js Developer',
    'node': 'Node.js Developer', 'python': 'Python Developer', 'java': 'Java Developer',
    'javascript': 'JavaScript Developer', 'typescript': 'TypeScript Developer',
    'c++': 'C++ Developer', 'c#': 'C# Developer', '.net': '.NET Developer',
    'go': 'Go Developer', 'golang': 'Go Developer', 'rust': 'Rust Developer',
    'swift': 'iOS Developer', 'kotlin': 'Android Developer',
    'ruby': 'Ruby Developer', 'php': 'PHP Developer', 'laravel': 'Laravel Developer',
    'django': 'Django Developer', 'flask': 'Python Developer',
    'spring': 'Java Spring Developer', 'aws': 'AWS Cloud Engineer',
    'azure': 'Azure Cloud Engineer', 'docker': 'DevOps Engineer',
    'kubernetes': 'DevOps Engineer', 'terraform': 'Infrastructure Engineer',
    'salesforce': 'Salesforce Developer', 'sap': 'SAP Consultant',
    'flutter': 'Flutter Developer', 'react native': 'React Native Developer',
    'sql': 'Database Developer', 'mongodb': 'Backend Developer',
    'machine learning': 'Machine Learning Engineer', 'ai': 'AI Engineer',
    'data': 'Data Engineer', 'tableau': 'Data Analyst', 'power bi': 'Data Analyst',
    'crm': 'CRM Developer', 'powerplatform': 'Power Platform Developer',
    'adobe': 'Adobe Experience Platform Developer',
  };
  for (const [tech, title] of Object.entries(techToRole)) {
    if (lower.includes(tech)) return title;
  }

  // Fallback: append "Developer" if it's just a tech name
  if (rawRole.length < 30 && !/\s/.test(rawRole.trim())) {
    return `${rawRole.trim()} Developer`;
  }

  return rawRole.trim() || 'Software Developer';
}

/** Build an array of optimized search queries from role + skills */
function buildSearchQueries(normalizedRole, skills, expLevel) {
  const queries = [];

  // Map of niche roles to broader, more searchable queries
  const BROADER_QUERIES = {
    'adobe experience platform developer': ['Adobe Experience Platform', 'AEP Developer', 'Adobe developer'],
    'salesforce developer': ['Salesforce developer', 'Salesforce engineer', 'CRM developer'],
    'microsoft dynamics crm developer': ['Dynamics 365 developer', 'CRM developer', 'Microsoft Dynamics'],
    'sap consultant': ['SAP consultant', 'SAP developer', 'ERP consultant'],
    'blockchain developer': ['blockchain developer', 'Web3 developer', 'smart contract developer'],
    'site reliability engineer': ['SRE', 'DevOps engineer', 'infrastructure engineer'],
    'firmware engineer': ['firmware engineer', 'embedded software engineer', 'embedded developer'],
  };

  const lowerRole = normalizedRole.toLowerCase();
  const broaderAlts = BROADER_QUERIES[lowerRole];

  // Always keep the exact normalized role as the primary query.
  queries.push(normalizedRole);

  if (broaderAlts) {
    // For niche roles, use a tightly related alternate query instead of a broad one.
    queries.push(broaderAlts[0]);
  } else if ((skills || []).length > 0) {
    // For broader roles, add a skill-enriched secondary query for better relevance.
    const topKeywords = (skills || []).slice(0, 2).map(s => s.trim()).filter(Boolean).join(' ');
    if (topKeywords) queries.push(`${normalizedRole} ${topKeywords}`);
  }

  // Secondary query: use top skills to find more relevant jobs
  // Known real tech terms for validation
  const KNOWN_TECH = new Set(['java','python','javascript','typescript','react','react.js','angular','vue','vue.js','next.js','nuxt','node.js','node','express','nestjs','spring','django','flask','fastapi','aws','azure','gcp','docker','kubernetes','sql','nosql','mongodb','postgresql','mysql','redis','graphql','rest','git','html','css','tailwind','bootstrap','c++','c#','.net','go','golang','rust','swift','kotlin','php','ruby','rails','laravel','tensorflow','pytorch','machine learning','ml','ai','data science','devops','linux','terraform','kafka','microservices','selenium','jest','figma','jira','salesforce','sap','oracle','flutter','react native','pandas','numpy','tableau','power bi','spark','hadoop','cypress','firebase','prisma','nginx','webpack','vite','crm','powerplatform','aep','adobe','mern','mean','blockchain','web3','unity','jenkins','agile','scrum']);

  const cleanSkills = (skills || [])
    .map(s => s.trim().toLowerCase())
    .filter(s => {
      if (s.length < 2 || s.length > 30) return false;
      // Must be a known tech term or contain at least one recognizable tech word
      if (KNOWN_TECH.has(s)) return true;
      // Check if any known tech is a substring
      for (const tech of KNOWN_TECH) {
        if (s.includes(tech) || tech.includes(s)) return true;
      }
      return false;
    });

  if (cleanSkills.length >= 2) {
    const topSkills = cleanSkills.slice(0, 3).join(' ');
    const skillQuery = `${topSkills} developer`;
    if (skillQuery.toLowerCase() !== normalizedRole.toLowerCase()) {
      queries.push(skillQuery);
    }
  } else if (cleanSkills.length === 1) {
    const singleSkillQuery = `${cleanSkills[0]} developer`;
    if (singleSkillQuery.toLowerCase() !== normalizedRole.toLowerCase()) {
      queries.push(singleSkillQuery);
    }
  }

  return [...new Set(queries.map(q => (q || '').trim()).filter(Boolean))].slice(0, 2); // Max 2 queries to avoid API rate limits
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
  const selectedDays = Math.max(1, parseInt(days, 10) || 1);
  const location = student.location || '';
  const skills = student.keySkills || [];
  const experience = student.experience || '';

  const regions = resolveSearchRegions(location);
  const experienceYears = parseExperienceYears(experience);
  const expLevel = experienceYears >= 7 ? 'senior' : experienceYears >= 3 ? 'mid' : experienceYears > 0 ? 'junior' : '';

  const rawRole = (student.jobRole || '').trim();
  const normalizedRole = normalizeJobTitle(rawRole);
  const searchQueries = buildSearchQueries(normalizedRole, skills, expLevel);

  const DATE_TIERS = [...new Set([1, 3, 7, 30].filter((tier) => tier <= selectedDays).concat(selectedDays))]
    .sort((a, b) => a - b);
  const primaryQuery = searchQueries[0];
  const secondaryQuery = searchQueries.length > 1 ? searchQueries[1] : null;

  // Check cache for repeat searches
  const cacheKey = `${primaryQuery}|${regions.join(',')}|${selectedDays}`;
  const cached = apiCache.get(cacheKey);
  if (cached) return cached;

  // Progressive date search: try 24h first, broaden if too few
  let jsearchJobs = [];
  for (const searchDays of DATE_TIERS) {
    jsearchJobs = [];
    const primaryResults = await searchJSearch(primaryQuery, regions, searchDays, experienceYears, 80);
    jsearchJobs.push(...primaryResults);

    if (secondaryQuery) {
      const secondaryResults = await searchJSearch(secondaryQuery, regions, searchDays, experienceYears, 60);
      jsearchJobs.push(...secondaryResults);
    }

    if (jsearchJobs.length >= 10) break;
  }

  // Filter JSearch results by experience level (title-based)
  if (expLevel) {
    jsearchJobs = jsearchJobs.filter(j => {
      const title = (j.job_title || '').toLowerCase();
      if (expLevel === 'junior') {
        // Juniors should not see senior/lead/principal/director roles
        if (/\b(senior|sr\.|lead|principal|staff|director|head of|vp\b|architect)\b/.test(title)) return false;
      } else if (expLevel === 'mid') {
        // Mid-level: skip principal/director/vp
        if (/\b(principal|staff|director|head of|vp\b)\b/.test(title)) return false;
      }
      return true;
    });
  }

  // Fetch secondary sources in parallel (only high-quality free APIs)
  const [remotiveJobs, remoteOKJobs] = await Promise.all([
    searchRemotive(primaryQuery),
    searchRemoteOK(primaryQuery),
  ]);

  // Strict location filter: respect user's preferred location explicitly.
  const userSetLocation = !!(student.location && String(student.location).trim());
  const allowedCodes = getAllowedCountryCodes(regions);
  const allowedRegionTerms = buildAllowedRegionTerms(regions);
  const filterByRegion = (jobs) => jobs.filter(j =>
    jobMatchesPreferredLocation(j, allowedCodes, allowedRegionTerms, userSetLocation)
  );

  // Filter free API results by experience level (title-based)
  const filterByExperience = (jobs) => {
    if (!expLevel) return jobs; // No experience info, skip filtering
    return jobs.filter(j => {
      const title = (j.job_title || '').toLowerCase();
      const jd = (j.jd || '').toLowerCase();
      if (expLevel === 'junior') {
        // Juniors should not see senior/lead/principal roles
        if (/\b(senior|sr\.|lead|principal|staff|director|head of|vp\b|architect)\b/.test(title)) return false;
      } else if (expLevel === 'mid') {
        // Mid-level: skip principal/director/vp, allow senior
        if (/\b(principal|staff|director|head of|vp\b)\b/.test(title)) return false;
      }
      // Senior can see everything
      return true;
    });
  };

  const filteredRemotive = filterByExperience(filterByRegion(remotiveJobs));
  const filteredRemoteOK = filterByExperience(filterByRegion(remoteOKJobs));

  const allJobs = [
    ...jsearchJobs,
    ...filteredRemotive,
    ...filteredRemoteOK,
  ];

  // Fallback if 0 results — try broader queries on free APIs
  if (allJobs.length === 0) {
    const fallbackQueries = [
      normalizedRole.split(' ').slice(0, 2).join(' '),
      `${(skills[0] || 'software')} developer`,
      'software developer',
    ];
    for (const fq of fallbackQueries) {
      const [fb1, fb2, fb3] = await Promise.all([
        searchJSearch(fq, regions, 7, experienceYears, 60),
        searchRemoteOK(fq, 20),
        searchRemotive(fq, 20),
      ]);
      const fbAll = [...fb1, ...fb2, ...fb3];
      if (fbAll.length > 0) { allJobs.push(...fbAll); break; }
    }
  }

  if (allJobs.length === 0) return [];

  // Filter invalid + deduplicate in one pass
  const seen = new Set();
  const unique = allJobs.filter(j => {
    if (!j.job_apply_link?.startsWith('http') || !j.job_title || !j.employer_name) return false;
    const key = `${j.employer_name}|${j.job_title}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (unique.length === 0) return [];

  // Deep score & sort — boost JSearch results (Indeed/LinkedIn/Dice/ZipRecruiter) for source quality
  const scored = unique.map(job => {
    const match = computeMatchScore(job, student);
    // Source quality bonus: JSearch aggregates top job boards (Indeed, LinkedIn, Dice, ZipRecruiter, Glassdoor)
    const src = (job.source || '').toLowerCase();
    let sourceBonus = 0;
    if (src.includes('indeed') || src.includes('linkedin') || src.includes('dice') || src.includes('ziprecruiter') || src.includes('glassdoor') || src === 'jsearch') {
      sourceBonus = 8; // Premium source bonus
    } else if (src === 'remotive') {
      sourceBonus = 3; // Decent remote source
    } else if (src === 'remoteok') {
      sourceBonus = 2; // Basic remote source
    }
    // Location match bonus: jobs explicitly in user's region get a boost
    const jobCountry = (job.job_country || '').toUpperCase();
    const locationBonus = (jobCountry && allowedCodes.has(jobCountry)) ? 5 : 0;
    // Experience alignment bonus from JD analysis
    const adjustedScore = Math.min(100, match.score + sourceBonus + locationBonus);
    return { job, match: { ...match, score: adjustedScore } };
  }).sort((a, b) => b.match.score - a.match.score);

  // Hard profile-relevance gate: drop jobs that don't actually match the user's
  // role keywords or skills. This prevents random tech jobs being shown for
  // niche profiles (e.g., AEP Developer must see Adobe/AEP-related jobs only).
  const relevant = scored.filter(({ job, match }) => isJobRelevantToProfile(job, student, match));

  // Quality threshold — only return jobs that score well AND pass relevance.
  // No low-quality fallback: better to return fewer accurate jobs than 30 random ones.
  const MIN_SCORE = 60;
  const topResults = relevant
    .filter(({ match }) => match.score >= MIN_SCORE)
    .slice(0, 30);

  const results = topResults.map(({ job, match }) => ({
    ...job,
    match_score: match.score,
    strong_matches: JSON.stringify(match.strongMatches),
    partial_matches: JSON.stringify(match.partialMatches || []),
    missing_skills: JSON.stringify(match.missingSkills),
    match_summary: match.summary,
    candidate_id: student.id,
    candidate_name: student.fullName || '',
    email: student.email || '',
    timestamp: new Date().toISOString(),
    pdf_link: '',
    resume_text: '',
  }));

  // Cache results before returning
  apiCache.set(cacheKey, results);

  return results;
}

module.exports = { searchJobs, computeMatchScore, generateResumeWithAI, generateTemplateResume };
