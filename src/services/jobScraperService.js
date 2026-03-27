const axios = require('axios');
let cheerio;
try { cheerio = require('cheerio'); } catch { cheerio = null; }
const prisma = require('../config/database');

class JobScraperService {
  /**
   * Scrape jobs from multiple sources and store them in the database
   */
  async scrapeAllJobs(searchTerm = 'software developer', location = 'United States') {
    const jobs = [];

    try {
      const indeedJobs = await this.scrapeIndeed(searchTerm, location);
      jobs.push(...indeedJobs);
    } catch (error) {
      console.error('Indeed scraping error:', error.message);
    }

    try {
      const remoteJobs = await this.scrapeRemoteOk(searchTerm);
      jobs.push(...remoteJobs);
    } catch (error) {
      console.error('RemoteOK scraping error:', error.message);
    }

    try {
      const githubJobs = await this.scrapeGitHubJobs(searchTerm);
      jobs.push(...githubJobs);
    } catch (error) {
      console.error('GitHub Jobs scraping error:', error.message);
    }

    // Save jobs to database
    let savedCount = 0;
    for (const job of jobs) {
      try {
        await prisma.job.upsert({
          where: { externalId: job.externalId },
          update: {
            title: job.title,
            description: job.description,
            isActive: true,
          },
          create: job,
        });
        savedCount++;
      } catch (error) {
        console.error('Error saving job:', error.message);
      }
    }

    return { total: jobs.length, saved: savedCount };
  }

  /**
   * Scrape jobs from Indeed
   */
  async scrapeIndeed(searchTerm, location) {
    const jobs = [];
    const url = `https://www.indeed.com/jobs?q=${encodeURIComponent(searchTerm)}&l=${encodeURIComponent(location)}`;

    try {
      const { data } = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        timeout: 15000,
      });

      const $ = cheerio.load(data);

      $('div.job_seen_beacon, div.jobsearch-ResultsList > div').each((i, element) => {
        const title = $(element).find('h2.jobTitle span, a.jcs-JobTitle span').text().trim();
        const company = $(element).find('span.companyName, span[data-testid="company-name"]').text().trim();
        const loc = $(element).find('div.companyLocation').text().trim();
        const description = $(element).find('div.job-snippet').text().trim();
        const link = $(element).find('a.jcs-JobTitle').attr('href');

        if (title && company) {
          const externalId = `indeed-${Buffer.from(title + company).toString('base64').substring(0, 50)}`;
          jobs.push({
            externalId,
            title,
            company,
            location: loc || location,
            description: description || 'No description available',
            source: 'Indeed',
            sourceUrl: link ? `https://www.indeed.com${link}` : url,
            applicationType: 'MANUAL_APPLY',
            datePosted: new Date(),
          });
        }
      });
    } catch (error) {
      console.error('Indeed scraping failed:', error.message);
    }

    return jobs;
  }

  /**
   * Scrape jobs from RemoteOK
   */
  async scrapeRemoteOk(searchTerm) {
    const jobs = [];

    try {
      const { data } = await axios.get(`https://remoteok.com/api?tag=${encodeURIComponent(searchTerm)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
        timeout: 15000,
      });

      if (Array.isArray(data)) {
        data.slice(1, 21).forEach((job) => {
          if (job.position && job.company) {
            jobs.push({
              externalId: `remoteok-${job.id || Date.now()}`,
              title: job.position,
              company: job.company,
              location: job.location || 'Remote',
              description: job.description || job.position,
              source: 'RemoteOK',
              sourceUrl: job.url || `https://remoteok.com/remote-jobs/${job.slug || ''}`,
              applicationType: 'MANUAL_APPLY',
              salary: job.salary_min ? `$${job.salary_min} - $${job.salary_max}` : null,
              datePosted: job.date ? new Date(job.date) : new Date(),
            });
          }
        });
      }
    } catch (error) {
      console.error('RemoteOK scraping failed:', error.message);
    }

    return jobs;
  }

  /**
   * Scrape jobs from GitHub Jobs (alternative API)
   */
  async scrapeGitHubJobs(searchTerm) {
    const jobs = [];

    try {
      const { data } = await axios.get(`https://jobs.github.com/positions.json?description=${encodeURIComponent(searchTerm)}`, {
        timeout: 15000,
      });

      if (Array.isArray(data)) {
        data.slice(0, 20).forEach((job) => {
          jobs.push({
            externalId: `github-${job.id}`,
            title: job.title,
            company: job.company,
            location: job.location || 'Remote',
            description: job.description || job.title,
            source: 'GitHub Jobs',
            sourceUrl: job.url || '',
            applicationType: 'MANUAL_APPLY',
            datePosted: job.created_at ? new Date(job.created_at) : new Date(),
          });
        });
      }
    } catch (error) {
      console.error('GitHub Jobs scraping failed:', error.message);
    }

    return jobs;
  }

  /** 
   * Add sample jobs for testing
   */
  async addSampleJobs() {
    const sampleJobs = [
      {
        externalId: 'sample-1',
        title: 'Full Stack Developer',
        company: 'TechCorp Inc.',
        location: 'New York, NY',
        description: 'We are looking for a Full Stack Developer with experience in React, Node.js, and PostgreSQL. The ideal candidate will have 2+ years of experience building scalable web applications. Responsibilities include developing new features, maintaining existing code, and collaborating with the design team. Requirements: JavaScript, TypeScript, React, Node.js, PostgreSQL, Git.',
        source: 'Company Website',
        sourceUrl: 'https://example.com/jobs/1',
        applicationType: 'EASY_APPLY',
        salary: '$80,000 - $120,000',
        datePosted: new Date(),
      },
      {
        externalId: 'sample-2',
        title: 'Frontend Engineer',
        company: 'StartupXYZ',
        location: 'San Francisco, CA',
        description: 'Join our growing team as a Frontend Engineer! You will be responsible for building user-facing features using React and TypeScript. We offer competitive salary, equity, and remote work options. Requirements: 3+ years of frontend development, React, TypeScript, CSS/SCSS, REST APIs.',
        source: 'Indeed',
        sourceUrl: 'https://example.com/jobs/2',
        applicationType: 'EASY_APPLY',
        salary: '$100,000 - $140,000',
        datePosted: new Date(),
      },
      {
        externalId: 'sample-3',
        title: 'Backend Developer',
        company: 'DataFlow Systems',
        location: 'Austin, TX',
        description: 'DataFlow Systems is hiring a Backend Developer to work on our data processing platform. Experience with Python, Node.js, or Java is required. Knowledge of AWS services, databases, and microservices architecture is a plus.',
        source: 'LinkedIn',
        sourceUrl: 'https://linkedin.com/jobs/3',
        applicationType: 'MANUAL_APPLY',
        salary: '$90,000 - $130,000',
        datePosted: new Date(Date.now() - 86400000),
      },
      {
        externalId: 'sample-4',
        title: 'DevOps Engineer',
        company: 'CloudNine Solutions',
        location: 'Remote',
        description: 'We need a DevOps Engineer to manage our CI/CD pipelines, cloud infrastructure, and monitoring systems. Experience with AWS, Docker, Kubernetes, and Terraform is required. Great benefits and fully remote position.',
        source: 'RemoteOK',
        sourceUrl: 'https://example.com/jobs/4',
        applicationType: 'EASY_APPLY',
        salary: '$110,000 - $150,000',
        datePosted: new Date(Date.now() - 172800000),
      },
      {
        externalId: 'sample-5',
        title: 'Data Analyst',
        company: 'Analytics Pro',
        location: 'Chicago, IL',
        description: 'Analytics Pro is looking for a Data Analyst to join our team. You will work with SQL, Python, and data visualization tools to generate insights from large datasets. Experience with Tableau or Power BI is a plus.',
        source: 'Indeed',
        sourceUrl: 'https://example.com/jobs/5',
        applicationType: 'MANUAL_APPLY',
        salary: '$70,000 - $95,000',
        datePosted: new Date(Date.now() - 259200000),
      },
      {
        externalId: 'sample-6',
        title: 'Mobile App Developer',
        company: 'AppWorks Studio',
        location: 'Seattle, WA',
        description: 'Seeking a Mobile App Developer proficient in React Native or Flutter. Build cross-platform mobile applications with clean, maintainable code. 2+ years of mobile development experience required.',
        source: 'Company Website',
        sourceUrl: 'https://example.com/jobs/6',
        applicationType: 'EASY_APPLY',
        salary: '$85,000 - $125,000',
        datePosted: new Date(Date.now() - 345600000),
      },
      {
        externalId: 'sample-7',
        title: 'Machine Learning Engineer',
        company: 'AI Innovations',
        location: 'Boston, MA',
        description: 'Join AI Innovations as a Machine Learning Engineer. You will design and implement ML models, work with large datasets, and deploy models to production. Requirements: Python, TensorFlow/PyTorch, scikit-learn, SQL.',
        source: 'LinkedIn',
        sourceUrl: 'https://linkedin.com/jobs/7',
        applicationType: 'MANUAL_APPLY',
        salary: '$120,000 - $160,000',
        datePosted: new Date(Date.now() - 432000000),
      },
      {
        externalId: 'sample-8',
        title: 'QA Automation Engineer',
        company: 'QualitySoft',
        location: 'Denver, CO',
        description: 'QualitySoft needs a QA Automation Engineer to build and maintain automated test suites. Experience with Selenium, Cypress, or Playwright required. Knowledge of CI/CD pipelines and agile methodologies preferred.',
        source: 'Indeed',
        sourceUrl: 'https://example.com/jobs/8',
        applicationType: 'EASY_APPLY',
        salary: '$75,000 - $110,000',
        datePosted: new Date(Date.now() - 518400000),
      },
    ];

    let saved = 0;
    for (const job of sampleJobs) {
      try {
        await prisma.job.upsert({
          where: { externalId: job.externalId },
          update: { ...job, externalId: undefined },
          create: job,
        });
        saved++;
      } catch (error) {
        console.error('Error saving sample job:', error.message);
      }
    }

    return { total: sampleJobs.length, saved };
  }
}

module.exports = new JobScraperService();
