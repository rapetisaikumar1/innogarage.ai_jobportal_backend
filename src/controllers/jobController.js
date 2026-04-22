const prisma = require('../config/database');
const jobScraperService = require('../services/jobScraperService');
const resumeService = require('../services/resumeService');
const jsJobSearchService = require('../services/jsJobSearchService');
const axios = require('axios');

const crypto = require('crypto');
const dns = require('dns');
const https = require('https');
const config = require('../config');

// JOB_SEARCH_MODE: 'js' = JavaScript direct search, 'n8n' = n8n webhook (default: 'js')
const JOB_SEARCH_MODE = process.env.JOB_SEARCH_MODE || 'js';

// Force IPv4 to avoid AggregateError on Render/cloud platforms
const n8nAxios = axios.create({
  timeout: 20000,
  httpsAgent: new https.Agent({ family: 4, keepAlive: true }),
});

// Cache n8n form field discovery (avoids re-fetching HTML every trigger)
const n8nFormFieldsCache = { fields: null, expiry: 0 };

// Google Sheet config
const GOOGLE_SHEET_ID = '1oBInp6BCblszz6RWdmhok3tlsRUfKX8BoEYs5uB0j6g';
const GOOGLE_SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/export?format=csv&gid=0`;

// Parse CSV text into array of objects
function parseCSV(text) {
  const lines = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      lines.push(current);
      current = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (current || lines.length) {
        lines.push(current);
        current = '';
      }
      if (lines.length) {
        // yield the row
        if (!parseCSV._rows) parseCSV._rows = [];
        parseCSV._rows.push([...lines]);
        lines.length = 0;
      }
    } else {
      current += ch;
    }
  }
  // last field / row
  if (current || lines.length) {
    lines.push(current);
    if (!parseCSV._rows) parseCSV._rows = [];
    parseCSV._rows.push([...lines]);
  }
  const rows = parseCSV._rows || [];
  parseCSV._rows = null;
  return rows;
}

// Fetch Google Sheet data — filtered per logged-in user
exports.getGoogleSheetJobs = async (req, res) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;

    // Hard timeout so a slow/hanging Google Sheet fetch cannot freeze the app.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetch(GOOGLE_SHEET_CSV_URL, { redirect: 'follow', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error('Failed to fetch Google Sheet');
    const csvText = await response.text();
    const rows = parseCSV(csvText);
    if (rows.length < 2) return res.json({ jobs: [] });

    const headers = rows[0].map(h => h.trim().toLowerCase());
    const allJobs = rows.slice(1).map((row, idx) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (row[i] || '').trim(); });
      return {
        id: idx + 1,
        candidate_id: obj['candidate_id'] || obj['candidate id'] || '',
        candidate_email: obj['email'] || obj['candidate_email'] || obj['candidate email'] || '',
        employer_name: obj['employer_name'] || obj['employer name'] || '',
        job_title: obj['job_title'] || obj['job title'] || '',
        job_city: obj['job_city'] || obj['job city'] || obj['location'] || '',
        job_state: obj['job_state'] || obj['job state'] || '',
        job_country: obj['job_country'] || obj['job country'] || '',
        job_employment_type: obj['job_employment_type'] || obj['job employment type'] || obj['employment_type'] || '',
        match_score: obj['match_score'] || obj['match score'] || '',
        job_apply_link: obj['job_apply_link'] || obj['job apply link'] || '',
        timestamp: obj['timestamp'] || '',
        candidate_name: obj['candidate_name'] || obj['candidate name'] || '',
        match_summary: obj['match_summary'] || obj['match summary'] || '',
        strong_matches: obj['strong_matches'] || obj['strong matches'] || '',
        missing_skills: obj['missing_skills'] || obj['missing skills'] || '',
        pdf_link: obj['pdf_link'] || obj['pdf link'] || '',
        jd: obj['jd'] || obj['job_description'] || obj['job description'] || '',
        resume_text: obj['resume_text'] || obj['resume text'] || obj['resume'] || obj['tailored_resume'] || obj['tailored resume'] || '',
      };
    }).filter(j => j.employer_name);

    // Filter: show only jobs belonging to the logged-in user (match by candidate_id or email)
    const jobs = allJobs.filter(j =>
      j.candidate_id === userId || j.candidate_email === userEmail
    );

    res.json({ jobs });
  } catch (error) {
    console.error('Google Sheet fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch jobs from Google Sheet', error: error.message });
  }
};

// Build multipart/form-data body manually.
// Text fields must NOT have Content-Type headers (busboy requirement).
function buildMultipartBody(textFields, fileFields) {
  const boundary = '----FormBoundary' + crypto.randomBytes(8).toString('hex');
  const CRLF = '\r\n';
  const parts = [];

  for (const [name, value] of Object.entries(textFields)) {
    parts.push(Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`
    ));
  }

  for (const file of fileFields) {
    parts.push(Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"${CRLF}Content-Type: ${file.contentType}${CRLF}${CRLF}`
    ));
    parts.push(file.data);
    parts.push(Buffer.from(CRLF));
  }

  parts.push(Buffer.from(`--${boundary}--${CRLF}`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

// Plan limits for job searches
const PLAN_LIMITS = {
  free: { maxSearches: 5, label: 'Free' },
  basic: { maxSearches: 35, label: 'Basic' },
  pro: { maxSearches: 200, label: 'Pro' },
  ultra: { maxSearches: 999999, label: 'Ultra' },
};

const getPlanLimit = (plan) => PLAN_LIMITS[plan] || PLAN_LIMITS.free;

// Reset search count if a new day has started
const resetSearchCountIfNeeded = async (user) => {
  const now = new Date();
  const last = user.lastSearchReset ? new Date(user.lastSearchReset) : null;
  if (!last || last.toDateString() !== now.toDateString()) {
    await prisma.user.update({
      where: { id: user.id },
      data: { jobSearchCount: 0, lastSearchReset: now },
    });
    return 0;
  }
  return user.jobSearchCount || 0;
};

// Auto-verify Stripe session and update plan if payment completed but plan never saved
const autoVerifyStripeSession = async (user) => {
  try {
    if (user.subscriptionPlan && user.subscriptionPlan !== 'free') return user.subscriptionPlan;
    if (!user.stripeSessionId) return user.subscriptionPlan || 'free';

    const config = require('../config');
    const secretKey = config.stripe.secretKey;
    if (!secretKey) return user.subscriptionPlan || 'free';

    const { data: session } = await axios.get(
      `https://api.stripe.com/v1/checkout/sessions/${user.stripeSessionId}`,
      { headers: { 'Authorization': `Bearer ${secretKey}` } }
    );

    if (session.payment_status === 'paid' && session.metadata?.plan) {
      const plan = session.metadata.plan;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          subscriptionPlan: plan,
          subscriptionStatus: 'active',
          subscriptionStart: new Date(),
        },
      });
      console.log(`Auto-verify: Updated user ${user.email} to plan: ${plan}`);
      return plan;
    }
    return user.subscriptionPlan || 'free';
  } catch (err) {
    console.error('Auto-verify Stripe session error:', err.message);
    return user.subscriptionPlan || 'free';
  }
};

// Get usage stats for the current user
exports.getUsage = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, subscriptionPlan: true, stripeSessionId: true, jobSearchCount: true, lastSearchReset: true },
    });
    // Self-healing: if plan is free but a Stripe session exists, auto-verify payment
    const plan = await autoVerifyStripeSession(user);
    const limit = getPlanLimit(plan);
    const used = await resetSearchCountIfNeeded(user);
    res.json({ plan, used, max: limit.maxSearches, label: limit.label });
  } catch (err) {
    res.status(500).json({ message: 'Failed to get usage', error: err.message });
  }
};

// Trigger job search — auto-switches between JS mode and n8n mode
exports.triggerN8nWorkflow = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, fullName: true, email: true, keySkills: true,
        resumeUrl: true, parsedResumeText: true, jobRole: true, location: true, experience: true, education: true,
        subscriptionPlan: true, stripeSessionId: true, jobSearchCount: true, lastSearchReset: true,
      },
    });

    if (!user) return res.status(404).json({ message: 'User not found' });

    // Self-healing plan check
    const plan = await autoVerifyStripeSession(user);
    const limit = getPlanLimit(plan);
    const used = await resetSearchCountIfNeeded(user);

    if (used >= limit.maxSearches) {
      return res.status(403).json({
        message: `You've reached your ${limit.label} plan limit of ${limit.maxSearches} searches today. Upgrade for more!`,
        limitReached: true,
        used,
        max: limit.maxSearches,
      });
    }

    // Parse days from request body
    const days = parseInt(req.body.days) || 1;

    // ─── N8N-ONLY MODE: trigger n8n webhook, results appear in Google Sheet ───
    let n8nTriggered = false;

    if (config.n8n.webhookUrl) {
      n8nTriggered = true;
      (async () => {
        try {
          const formPageUrl = config.n8n.webhookUrl.replace('/webhook/', '/form/');

          // Fetch form fields (cached) and resume in parallel
          const formFieldsPromise = (async () => {
            if (n8nFormFieldsCache.fields && Date.now() < n8nFormFieldsCache.expiry) {
              return n8nFormFieldsCache.fields;
            }
            const formPageResp = await n8nAxios.get(formPageUrl);
            const $ = require('cheerio').load(formPageResp.data);
            const formFields = [];
            $('input, textarea, select').each((i, el) => {
              const name = $(el).attr('name');
              if (!name) return;
              const type = $(el).attr('type') || 'text';
              let label = '';
              const id = $(el).attr('id');
              if (id) label = $(`label[for="${id}"]`).text().trim();
              if (!label) label = $(el).closest('label').text().trim();
              if (!label) label = $(el).closest('.form-group, .field, div').find('label').first().text().trim();
              formFields.push({ name, type, label: label.toLowerCase() });
            });
            n8nFormFieldsCache.fields = formFields;
            n8nFormFieldsCache.expiry = Date.now() + 10 * 60 * 1000;
            return formFields;
          })();

          const resumePromise = (async () => {
            if (!user.resumeUrl) return null;
            try {
              const resumeResp = await n8nAxios.get(user.resumeUrl, { responseType: 'arraybuffer' });
              return { buffer: Buffer.from(resumeResp.data), filename: user.resumeUrl.split('/').pop().split('?')[0] || 'resume.pdf' };
            } catch { return null; }
          })();

          const [formFields, resumeData] = await Promise.all([formFieldsPromise, resumePromise]);

          const dataMap = [
            { keywords: ['candidate id', 'candidate_id', 'candidateid', 'id'], value: String(user.id) },
            { keywords: ['candidate_name', 'candidate name', 'name'], value: user.fullName || '' },
            { keywords: ['email', 'e-mail'], value: user.email || '' },
            { keywords: ['role', 'job role', 'jobrole'], value: user.jobRole || 'Software Developer' },
            { keywords: ['keywords', 'skills', 'key skills'], value: (user.keySkills || []).join(', ') },
            { keywords: ['location', 'city'], value: user.location || '' },
            { keywords: ['days', 'day', 'date'], value: days },
          ];

          const textFields = {};
          let resumeFieldName = 'resume';
          const usedDataIndices = new Set();

          for (const field of formFields) {
            if (field.type === 'file') { resumeFieldName = field.name; continue; }
            if (field.type === 'hidden' || field.type === 'submit') continue;
            let matched = false;
            for (let i = 0; i < dataMap.length; i++) {
              if (usedDataIndices.has(i)) continue;
              const matchTarget = (field.label + ' ' + field.name).toLowerCase();
              if (dataMap[i].keywords.some(kw => matchTarget.includes(kw))) {
                textFields[field.name] = dataMap[i].value;
                usedDataIndices.add(i);
                matched = true;
                break;
              }
            }
            if (!matched) {
              for (let i = 0; i < dataMap.length; i++) {
                if (!usedDataIndices.has(i)) { textFields[field.name] = dataMap[i].value; usedDataIndices.add(i); break; }
              }
            }
          }

          const fileFields = [];
          if (resumeData) {
            fileFields.push({ name: resumeFieldName, filename: resumeData.filename, contentType: 'application/pdf', data: resumeData.buffer });
          }

          const { body, contentType } = buildMultipartBody(textFields, fileFields);
          await n8nAxios.post(formPageUrl, body, {
            headers: { 'Content-Type': contentType },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            validateStatus: () => true,
          });
          console.log('N8N background trigger completed');
        } catch (err) {
          console.error('N8N background trigger error:', err.message);
        }
      })(); // Fire and forget — don't await
    }

    // Increment search count and update lastSearchReset
    try {
      await prisma.user.update({
        where: { id: userId },
        data: { jobSearchCount: { increment: 1 }, lastSearchReset: new Date() },
      });
    } catch (err) {
      console.error('Failed to increment search count:', err.message);
    }

    // Return immediately — jobs will appear in Google Sheet via n8n
    return res.json({
      message: n8nTriggered
        ? 'Job search triggered! Jobs will appear shortly...'
        : 'N8N webhook not configured. Please set up n8n.',
      jobs: [],
      mode: 'n8n',
      n8nTriggered,
    });
  } catch (error) {
    console.error('Job search error:', error.message || error);
    console.error('Job search stack:', error.stack);
    res.status(500).json({ message: 'Failed to trigger job search', error: error.message || String(error) });
  }
};

// Get all jobs with filters
exports.getJobs = async (req, res) => {
  try {
    const { search, source, type, location, page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = { isActive: true };

    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { company: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (source) where.source = source;
    if (type) where.applicationType = type;
    if (location) where.location = { contains: location, mode: 'insensitive' };

    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where,
        orderBy: { datePosted: 'desc' },
        skip,
        take: parseInt(limit),
      }),
      prisma.job.count({ where }),
    ]);

    res.json({
      jobs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch jobs', error: error.message });
  }
};

// Get single job
exports.getJob = async (req, res) => {
  try {
    const job = await prisma.job.findUnique({
      where: { id: req.params.id },
    });

    if (!job) {
      return res.status(404).json({ message: 'Job not found' });
    }

    res.json(job);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch job', error: error.message });
  }
};

// Scrape jobs
exports.scrapeJobs = async (req, res) => {
  try {
    const { searchTerm, location } = req.body;
    const result = await jobScraperService.scrapeAllJobs(searchTerm, location);
    res.json({ message: 'Job scraping completed', ...result });
  } catch (error) {
    res.status(500).json({ message: 'Job scraping failed', error: error.message });
  }
};

// Add sample jobs
exports.addSampleJobs = async (req, res) => {
  try {
    const result = await jobScraperService.addSampleJobs();
    res.json({ message: 'Sample jobs added', ...result });
  } catch (error) {
    res.status(500).json({ message: 'Failed to add sample jobs', error: error.message });
  }
};

// Apply for a job
exports.applyForJob = async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.user.id;

    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) {
      return res.status(404).json({ message: 'Job not found' });
    }

    // Check if already applied
    const existing = await prisma.jobApplication.findUnique({
      where: { userId_jobId: { userId, jobId } },
    });

    if (existing) {
      return res.status(409).json({ message: 'Already applied for this job' });
    }

    // Get user profile for resume generation
    const user = await prisma.user.findUnique({ where: { id: userId } });

    // Generate tailored resume
    let tailoredResume = null;
    try {
      const resumeResult = await resumeService.generateTailoredResume(user, job);
      tailoredResume = await prisma.tailoredResume.create({
        data: {
          userId,
          jobId,
          resumeUrl: resumeResult.filePath,
          matchScore: resumeResult.matchScore,
          keywords: resumeResult.keywords,
        },
      });
    } catch (error) {
      console.error('Resume generation error:', error);
    }

    const application = await prisma.jobApplication.create({
      data: {
        userId,
        jobId,
        status: 'APPLIED',
        isAutoApplied: job.applicationType === 'EASY_APPLY',
        resumeUsed: tailoredResume?.resumeUrl || user.resumeUrl,
      },
      include: { job: true },
    });

    // Create notification
    await prisma.notification.create({
      data: {
        userId,
        title: 'Application Submitted',
        message: `You have applied for ${job.title} at ${job.company}`,
        type: 'application',
      },
    });

    res.status(201).json({
      message: 'Application submitted successfully',
      application,
      tailoredResume,
    });
  } catch (error) {
    res.status(500).json({ message: 'Application failed', error: error.message });
  }
};

// Easy Apply - bulk apply for all easy apply jobs
exports.easyApplyAll = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    // Get all easy apply jobs not yet applied
    const appliedJobIds = await prisma.jobApplication.findMany({
      where: { userId },
      select: { jobId: true },
    });

    const appliedIds = appliedJobIds.map(a => a.jobId);

    const easyApplyJobs = await prisma.job.findMany({
      where: {
        applicationType: 'EASY_APPLY',
        isActive: true,
        id: { notIn: appliedIds },
      },
    });

    const results = [];
    for (const job of easyApplyJobs) {
      try {
        // Generate tailored resume
        let resumeUrl = user.resumeUrl;
        try {
          const resumeResult = await resumeService.generateTailoredResume(user, job);
          await prisma.tailoredResume.upsert({
            where: { userId_jobId: { userId, jobId: job.id } },
            update: { resumeUrl: resumeResult.filePath, matchScore: resumeResult.matchScore, keywords: resumeResult.keywords },
            create: { userId, jobId: job.id, resumeUrl: resumeResult.filePath, matchScore: resumeResult.matchScore, keywords: resumeResult.keywords },
          });
          resumeUrl = resumeResult.filePath;
        } catch (e) {
          console.error('Resume generation error for job:', job.id, e.message);
        }

        const application = await prisma.jobApplication.create({
          data: {
            userId,
            jobId: job.id,
            status: 'APPLIED',
            isAutoApplied: true,
            resumeUsed: resumeUrl,
          },
        });
        results.push({ jobId: job.id, status: 'applied', title: job.title });
      } catch (error) {
        results.push({ jobId: job.id, status: 'failed', error: error.message });
      }
    }

    if (results.filter(r => r.status === 'applied').length > 0) {
      await prisma.notification.create({
        data: {
          userId,
          title: 'Bulk Apply Complete',
          message: `Applied to ${results.filter(r => r.status === 'applied').length} jobs automatically`,
          type: 'application',
        },
      });
    }

    res.json({
      message: 'Easy apply completed',
      totalProcessed: results.length,
      applied: results.filter(r => r.status === 'applied').length,
      failed: results.filter(r => r.status === 'failed').length,
      results,
    });
  } catch (error) {
    res.status(500).json({ message: 'Easy apply failed', error: error.message });
  }
};

// Get user's applications
exports.getMyApplications = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const where = { userId: req.user.id };
    if (status) where.status = status;

    const [applications, total] = await Promise.all([
      prisma.jobApplication.findMany({
        where,
        include: {
          job: true,
          user: { select: { id: true, fullName: true, email: true, phone: true, avatarUrl: true, education: true, jobRole: true } },
        },
        orderBy: { appliedAt: 'desc' },
        skip,
        take: parseInt(limit),
      }),
      prisma.jobApplication.count({ where }),
    ]);

    // Enrich with appliedBy info
    const appliedByIds = [...new Set(applications.filter(a => a.appliedById).map(a => a.appliedById))];
    let appliedByMap = {};
    if (appliedByIds.length > 0) {
      const users = await prisma.user.findMany({
        where: { id: { in: appliedByIds } },
        select: { id: true, fullName: true, role: true },
      });
      users.forEach(u => { appliedByMap[u.id] = u; });
    }
    const enriched = applications.map(a => ({
      ...a,
      appliedBy: a.appliedById ? (appliedByMap[a.appliedById] || null) : null,
    }));

    res.json({
      applications: enriched,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch applications', error: error.message });
  }
};

// Update application status
exports.updateApplicationStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes, interviewDate, interviewLocation, interviewNotes } = req.body;

    // Only ADMIN and SUPER_ADMIN can update application status
    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ message: 'Not authorized to update application status' });
    }

    const data = {};
    if (status) data.status = status;
    if (notes !== undefined) data.notes = notes;
    if (interviewDate !== undefined) data.interviewDate = interviewDate ? new Date(interviewDate) : null;
    if (interviewLocation !== undefined) data.interviewLocation = interviewLocation;
    if (interviewNotes !== undefined) data.interviewNotes = interviewNotes;

    const application = await prisma.jobApplication.update({
      where: { id },
      data,
      include: {
        job: true,
        user: { select: { id: true, fullName: true, email: true } },
      },
    });

    res.json(application);
  } catch (error) {
    res.status(500).json({ message: 'Failed to update application', error: error.message });
  }
};

// Get all applications (Admin/Super Admin) — includes applicant info
exports.getAllApplications = async (req, res) => {
  try {
    const { status, page = 1, limit = 20, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const where = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { user: { fullName: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
        { job: { title: { contains: search, mode: 'insensitive' } } },
        { job: { company: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [applications, total] = await Promise.all([
      prisma.jobApplication.findMany({
        where,
        include: {
          job: true,
          user: { select: { id: true, fullName: true, email: true, phone: true, avatarUrl: true, education: true, jobRole: true } },
        },
        orderBy: { appliedAt: 'desc' },
        skip,
        take: parseInt(limit),
      }),
      prisma.jobApplication.count({ where }),
    ]);

    res.json({
      applications,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch applications', error: error.message });
  }
};

// Get dashboard stats
exports.getDashboardStats = async (req, res) => {
  try {
    const userId = req.user.id;

    const [totalApplied, interviewScheduled, rejected, offerReceived, totalJobs, dbAdminApplied, sheetAdminApplied, sheetTotalApplied] = await Promise.all([
      prisma.jobApplication.count({ where: { userId, status: 'APPLIED' } }),
      prisma.jobApplication.count({ where: { userId, status: 'INTERVIEW_SCHEDULED' } }),
      prisma.jobApplication.count({ where: { userId, status: 'REJECTED' } }),
      prisma.jobApplication.count({ where: { userId, status: 'OFFER_RECEIVED' } }),
      prisma.job.count({ where: { isActive: true } }),
      prisma.jobApplication.count({ where: { userId, appliedById: { not: null } } }),
      prisma.sheetJobApplication.count({ where: { userId, appliedById: { not: null } } }),
      prisma.sheetJobApplication.count({ where: { userId } }),
    ]);

    const manualPending = await prisma.job.count({
      where: {
        isActive: true,
        applicationType: 'MANUAL_APPLY',
        NOT: {
          applications: {
            some: { userId },
          },
        },
      },
    });

    const allDbApplied = totalApplied + interviewScheduled + rejected + offerReceived;
    const adminApplyCount = dbAdminApplied + sheetAdminApplied;
    const candidateApplyCount = (allDbApplied - dbAdminApplied) + (sheetTotalApplied - sheetAdminApplied);

    res.json({
      totalJobs,
      totalApplied: allDbApplied,
      interviewScheduled,
      rejected,
      offerReceived,
      manualPending,
      adminApplyCount,
      candidateApplyCount,
      sheetAppliedCount: sheetTotalApplied,
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch stats', error: error.message });
  }
};

// Get tailored resume for a job
exports.getTailoredResume = async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.user.id;

    let resume = await prisma.tailoredResume.findUnique({
      where: { userId_jobId: { userId, jobId } },
    });

    if (!resume) {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      const job = await prisma.job.findUnique({ where: { id: jobId } });

      if (!job) return res.status(404).json({ message: 'Job not found' });

      const result = await resumeService.generateTailoredResume(user, job);
      resume = await prisma.tailoredResume.create({
        data: {
          userId,
          jobId,
          resumeUrl: result.filePath,
          matchScore: result.matchScore,
          keywords: result.keywords,
        },
      });
    }

    res.json(resume);
  } catch (error) {
    res.status(500).json({ message: 'Failed to generate resume', error: error.message });
  }
};

// ══════════════════════════════════════════════════════════════
// AUTO-APPLY BOT — applies to all Google Sheet jobs for the user
// ══════════════════════════════════════════════════════════════

// Apply All — marks all sheet jobs as applied and returns links for browser
exports.autoApplyAllSheetJobs = async (req, res) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;

    // 1. Fetch all jobs from Google Sheet for this user
    const sheetResp = await fetch(GOOGLE_SHEET_CSV_URL, { redirect: 'follow' });
    if (!sheetResp.ok) throw new Error('Failed to fetch Google Sheet');
    const csvText = await sheetResp.text();
    const rows = parseCSV(csvText);
    if (rows.length < 2) return res.json({ message: 'No jobs found', summary: { total: 0, readyToApply: 0, alreadyApplied: 0, noLink: 0 }, results: [], applyLinks: [] });

    const headers = rows[0].map(h => h.trim().toLowerCase());
    const allJobs = rows.slice(1).map((row) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (row[i] || '').trim(); });
      return {
        candidate_id: obj['candidate_id'] || obj['candidate id'] || '',
        candidate_email: obj['email'] || obj['candidate_email'] || obj['candidate email'] || '',
        employer_name: obj['employer_name'] || obj['employer name'] || '',
        job_apply_link: obj['job_apply_link'] || obj['job apply link'] || '',
        match_score: obj['match_score'] || obj['match score'] || '',
        pdf_link: obj['pdf_link'] || obj['pdf link'] || '',
      };
    }).filter(j => j.employer_name);

    // Filter to only this user's jobs
    const myJobs = allJobs.filter(j =>
      j.candidate_id === userId || j.candidate_email === userEmail
    );

    if (myJobs.length === 0) {
      return res.json({ message: 'No jobs found for your account', summary: { total: 0, readyToApply: 0, alreadyApplied: 0, noLink: 0 }, results: [], applyLinks: [] });
    }

    // 2. Check already-applied (best-effort)
    let appliedLinks = new Set();
    try {
      const existingApps = await prisma.sheetJobApplication.findMany({
        where: { userId },
        select: { jobLink: true },
      });
      appliedLinks = new Set(existingApps.map(a => a.jobLink));
    } catch { /* table may not exist yet */ }

    // 3. Process each job
    const results = [];
    const linksToOpen = [];

    for (const job of myJobs) {
      const link = job.job_apply_link;

      if (!link) {
        results.push({ employer: job.employer_name, status: 'NO_LINK', message: 'No apply link' });
        continue;
      }

      if (appliedLinks.has(link)) {
        results.push({ employer: job.employer_name, status: 'ALREADY_APPLIED', message: 'Already applied', link });
        continue;
      }

      // Mark as applied and queue link for opening in browser
      linksToOpen.push(link);
      results.push({ employer: job.employer_name, status: 'APPLIED', message: 'Open in browser to apply', link });

      // Save to DB (best-effort)
      try {
        await prisma.sheetJobApplication.upsert({
          where: { userId_jobLink: { userId, jobLink: link } },
          update: { status: 'APPLIED', appliedMethod: 'MANUAL', employerName: job.employer_name, matchScore: job.match_score, pdfLink: job.pdf_link },
          create: { userId, jobLink: link, status: 'APPLIED', appliedMethod: 'MANUAL', employerName: job.employer_name, matchScore: job.match_score, pdfLink: job.pdf_link },
        });
      } catch { /* ignore */ }
    }

    const readyToApply = results.filter(r => r.status === 'APPLIED').length;
    const alreadyApplied = results.filter(r => r.status === 'ALREADY_APPLIED').length;
    const noLink = results.filter(r => r.status === 'NO_LINK').length;

    // Create notification (best-effort)
    try {
      await prisma.notification.create({
        data: {
          userId,
          title: 'Apply All Complete',
          message: `Ready to apply: ${readyToApply} | Already applied: ${alreadyApplied} | No link: ${noLink}`,
          type: 'application',
        },
      });
    } catch { /* ignore */ }

    res.json({
      message: `${readyToApply} job${readyToApply !== 1 ? 's' : ''} ready — opening in your browser`,
      summary: { total: myJobs.length, readyToApply, alreadyApplied, noLink },
      results,
      applyLinks: linksToOpen,
    });
  } catch (error) {
    console.error('Apply all error:', error.message);
    res.status(500).json({ message: 'Apply all failed', error: error.message });
  }
};

// Get applied status for all sheet jobs
exports.getSheetAppliedStatus = async (req, res) => {
  try {
    const userId = req.user.id;
    const applications = await prisma.sheetJobApplication.findMany({
      where: { userId },
      select: { jobLink: true, status: true, appliedMethod: true, appliedById: true, employerName: true, jobTitle: true, matchScore: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ applications });
  } catch (error) {
    // Table might not exist yet — return empty
    res.json({ applications: [] });
  }
};

// Mark a single sheet job as applied
exports.markSheetJobApplied = async (req, res) => {
  try {
    const userId = req.user.id;
    const { jobLink, employerName, matchScore, jobTitle } = req.body;
    if (!jobLink) return res.status(400).json({ message: 'jobLink is required' });

    const application = await prisma.sheetJobApplication.upsert({
      where: { userId_jobLink: { userId, jobLink } },
      update: { status: 'APPLIED', appliedMethod: 'MANUAL', employerName, matchScore, jobTitle },
      create: { userId, jobLink, status: 'APPLIED', appliedMethod: 'MANUAL', employerName, matchScore, jobTitle },
    });

    res.json({ message: 'Marked as applied', application });
  } catch (error) {
    res.status(500).json({ message: 'Failed to mark applied', error: error.message });
  }
};

// ══════════════════════════════════════════════════════════════
// AUTO-APPLY (Single Job) — AI + Playwright, streams NDJSON progress
// ══════════════════════════════════════════════════════════════
exports.autoApplyToJob = async (req, res) => {
  // Extend timeouts for this long-running request
  req.setTimeout(300000);
  res.setTimeout(300000);

  const userId = req.user.id;
  const { applyUrl, employerName, matchScore } = req.body;

  if (!applyUrl) {
    return res.status(400).json({ message: 'Apply URL is required' });
  }

  // Fetch full user profile
  let user;
  try {
    user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, fullName: true, email: true, phone: true,
        keySkills: true, jobRole: true, location: true,
        resumeUrl: true, linkedinProfile: true,
        education: true, experience: true,
      },
    });
  } catch (err) {
    return res.status(500).json({ message: 'Database error', error: err.message });
  }

  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  // Set headers for NDJSON streaming
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Progress callback — writes NDJSON lines to the response stream
  const onProgress = (event) => {
    try { res.write(JSON.stringify(event) + '\n'); } catch {}
  };

  try {
    const autoApplyService = require('../services/autoApplyService');
    const result = await autoApplyService.applyToJob(
      { applyUrl, employerName, matchScore },
      user,
      onProgress
    );

    // Save to DB (best-effort)
    try {
      await prisma.sheetJobApplication.upsert({
        where: { userId_jobLink: { userId, jobLink: applyUrl } },
        update: {
          status: result.success ? 'APPLIED' : 'FAILED',
          appliedMethod: 'BOT',
          employerName,
          matchScore: String(result.matchScore || matchScore || ''),
          pdfLink: result.resumeUrl || null,
          reportUrl: result.reportUrl || null,
        },
        create: {
          userId,
          jobLink: applyUrl,
          status: result.success ? 'APPLIED' : 'FAILED',
          appliedMethod: 'BOT',
          employerName,
          matchScore: String(result.matchScore || matchScore || ''),
          pdfLink: result.resumeUrl || null,
          reportUrl: result.reportUrl || null,
        },
      });
    } catch (err) {
      console.error('Failed to save auto-apply record:', err.message);
    }

    // Create notification (best-effort)
    try {
      await prisma.notification.create({
        data: {
          userId,
          title: result.success ? 'Auto-Apply Successful' : 'Auto-Apply Attempted',
          message: `${result.success ? 'Applied' : 'Attempted'} to ${employerName || 'job'}${result.reportUrl ? '. Report generated.' : ''}`,
          type: 'application',
        },
      });
    } catch {}

    // Send final "done" event and close the stream
    onProgress({
      type: 'done',
      data: {
        success: result.success,
        message: result.success
          ? `Successfully applied to ${employerName || 'this job'}!`
          : `Application attempted for ${employerName || 'this job'}. Check the report for details.`,
        reportUrl: result.reportUrl,
        resumeUrl: result.resumeUrl,
        matchScore: result.matchScore,
        steps: result.steps,
        error: result.error,
      },
    });
  } catch (error) {
    console.error('Auto-apply endpoint error:', error.message);
    onProgress({
      type: 'done',
      data: {
        success: false,
        message: 'Auto-apply failed',
        error: error.message,
        steps: [],
      },
    });
  }

  res.end();
};

// ─── Get saved job results for a user ───
exports.getSavedJobs = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const skip = (page - 1) * limit;

    const [jobs, total] = await Promise.all([
      prisma.savedJobResult.findMany({
        where: { userId },
        orderBy: { matchScore: 'desc' },
        skip,
        take: limit,
      }),
      prisma.savedJobResult.count({ where: { userId } }),
    ]);

    // Map to frontend-compatible format
    const mapped = jobs.map(j => ({
      employer_name: j.employerName,
      job_title: j.jobTitle,
      job_city: j.jobCity,
      job_state: j.jobState,
      job_country: j.jobCountry,
      job_employment_type: j.employmentType,
      job_apply_link: j.applyLink?.startsWith('http') ? j.applyLink : null,
      employer_logo: j.employerLogo,
      source: j.source,
      posted: j.postedAt,
      jd: j.jd,
      match_score: j.matchScore,
      strong_matches: JSON.stringify(j.strongMatches),
      missing_skills: JSON.stringify(j.missingSkills),
      match_summary: j.matchSummary,
      resume_text: j.resumeText,
      original_resume: j.originalResume,
      job_min_salary: j.salaryMin,
      job_max_salary: j.salaryMax,
      job_salary_currency: j.salaryCurrency,
      saved_at: j.createdAt,
    }));

    res.json({ jobs: mapped, total, page, limit });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve saved jobs' });
  }
};
