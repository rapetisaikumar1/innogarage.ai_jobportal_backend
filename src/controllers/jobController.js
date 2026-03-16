const prisma = require('../config/database');
const jobScraperService = require('../services/jobScraperService');
const resumeService = require('../services/resumeService');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const config = require('../config');

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

    const response = await fetch(GOOGLE_SHEET_CSV_URL, { redirect: 'follow' });
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

// Trigger n8n workflow with user data
exports.triggerN8nWorkflow = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, fullName: true, email: true, keySkills: true,
        resumeUrl: true, jobRole: true, location: true,
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

    if (!config.n8n.webhookUrl) return res.status(500).json({ message: 'N8N webhook not configured' });

    const days = req.body.days || '1';

    // Step 1: GET the n8n form page HTML to discover the REAL field names
    const formPageUrl = config.n8n.webhookUrl.replace('/webhook/', '/form/');
    console.log('Step 1: Fetching n8n form HTML from:', formPageUrl);
    const formPageResp = await axios.get(formPageUrl, { timeout: 15000 });
    const $ = cheerio.load(formPageResp.data);

    // Extract all input/textarea/select field names and their labels
    const formFields = [];
    $('input, textarea, select').each((i, el) => {
      const name = $(el).attr('name');
      if (!name) return;
      const type = $(el).attr('type') || 'text';
      // Find the label - check for associated label element or parent label
      let label = '';
      const id = $(el).attr('id');
      if (id) {
        label = $(`label[for="${id}"]`).text().trim();
      }
      if (!label) {
        label = $(el).closest('label').text().trim();
      }
      if (!label) {
        label = $(el).closest('.form-group, .field, div').find('label').first().text().trim();
      }
      formFields.push({ name, type, label: label.toLowerCase() });
    });

    console.log('Discovered form fields:', JSON.stringify(formFields, null, 2));

    // Our data values mapped by expected label keywords
    const dataMap = [
      { keywords: ['candidate id', 'candidate_id', 'candidateid', 'id'], value: String(user.id) },
      { keywords: ['candidate_name', 'candidate name', 'name'], value: user.fullName || '' },
      { keywords: ['email', 'e-mail'], value: user.email || '' },
      { keywords: ['role', 'job role', 'jobrole'], value: user.jobRole || 'Software Developer' },
      { keywords: ['keywords', 'skills', 'key skills'], value: (user.keySkills || []).join(', ') },
      { keywords: ['location', 'city'], value: user.location || '' },
      { keywords: ['days', 'day', 'date'], value: days },
    ];

    // Map discovered field names to our data
    const textFields = {};
    let resumeFieldName = 'resume'; // default
    const usedDataIndices = new Set();

    for (const field of formFields) {
      // Skip file inputs and hidden fields
      if (field.type === 'file') {
        resumeFieldName = field.name;
        console.log(`  File field: "${field.name}" (label: "${field.label}")`);
        continue;
      }
      if (field.type === 'hidden' || field.type === 'submit') continue;

      // Try to match by label or field name
      let matched = false;
      for (let i = 0; i < dataMap.length; i++) {
        if (usedDataIndices.has(i)) continue;
        const entry = dataMap[i];
        const matchTarget = (field.label + ' ' + field.name).toLowerCase();
        if (entry.keywords.some(kw => matchTarget.includes(kw))) {
          textFields[field.name] = entry.value;
          usedDataIndices.add(i);
          console.log(`  Matched: "${field.name}" (label: "${field.label}") → "${entry.value}"`);
          matched = true;
          break;
        }
      }

      // Positional fallback for unmatched fields
      if (!matched) {
        for (let i = 0; i < dataMap.length; i++) {
          if (!usedDataIndices.has(i)) {
            textFields[field.name] = dataMap[i].value;
            usedDataIndices.add(i);
            console.log(`  Positional: "${field.name}" (label: "${field.label}") → "${dataMap[i].value}"`);
            break;
          }
        }
      }
    }

    // Step 2: Download resume and attach as file
    const fileFields = [];
    if (user.resumeUrl) {
      try {
        console.log('Downloading resume from:', user.resumeUrl);
        const resumeResp = await axios.get(user.resumeUrl, { responseType: 'arraybuffer', timeout: 15000 });
        const resumeBuffer = Buffer.from(resumeResp.data);
        const filename = user.resumeUrl.split('/').pop().split('?')[0] || 'resume.pdf';
        console.log('Resume downloaded, size:', resumeBuffer.length, 'bytes');
        fileFields.push({ name: resumeFieldName, filename, contentType: 'application/pdf', data: resumeBuffer });
      } catch (dlErr) {
        console.warn('Could not download resume:', dlErr.message);
      }
    }

    // Step 3: Build and POST multipart to the /form/ endpoint
    const { body, contentType } = buildMultipartBody(textFields, fileFields);

    console.log('Step 3: Posting multipart to:', formPageUrl);
    console.log('Final text fields:', JSON.stringify(textFields));
    console.log('Body size:', body.length, 'bytes');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const n8nResponse = await fetch(formPageUrl, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: body,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const responseText = await n8nResponse.text();
    console.log('N8N response status:', n8nResponse.status);
    console.log('N8N response:', responseText.substring(0, 300));

    if (!n8nResponse.ok) {
      return res.status(502).json({ message: 'N8N workflow error', details: responseText.substring(0, 200) });
    }

    res.json({ message: 'Job search triggered successfully. Jobs will appear shortly.' });

    // Increment search count after successful trigger (fire-and-forget)
    prisma.user.update({
      where: { id: userId },
      data: { jobSearchCount: { increment: 1 } },
    }).catch(() => {});
  } catch (error) {
    console.error('N8N trigger error:', error.message);
    res.status(500).json({ message: 'Failed to trigger job search', error: error.message });
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
        include: { job: true },
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

// Update application status
exports.updateApplicationStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    const application = await prisma.jobApplication.update({
      where: { id },
      data: { status, notes },
      include: { job: true },
    });

    res.json(application);
  } catch (error) {
    res.status(500).json({ message: 'Failed to update application', error: error.message });
  }
};

// Get dashboard stats
exports.getDashboardStats = async (req, res) => {
  try {
    const userId = req.user.id;

    const [totalApplied, interviewScheduled, rejected, offerReceived, totalJobs] = await Promise.all([
      prisma.jobApplication.count({ where: { userId, status: 'APPLIED' } }),
      prisma.jobApplication.count({ where: { userId, status: 'INTERVIEW_SCHEDULED' } }),
      prisma.jobApplication.count({ where: { userId, status: 'REJECTED' } }),
      prisma.jobApplication.count({ where: { userId, status: 'OFFER_RECEIVED' } }),
      prisma.job.count({ where: { isActive: true } }),
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

    res.json({
      totalJobs,
      totalApplied: totalApplied + interviewScheduled + rejected + offerReceived,
      interviewScheduled,
      rejected,
      offerReceived,
      manualPending,
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

// Get extension data for chrome extension
exports.getExtensionData = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, fullName: true, email: true, phone: true, resumePath: true },
    });
    const applications = await prisma.sheetJobApplication.findMany({
      where: { userId },
      select: { jobLink: true, status: true, appliedMethod: true, employerName: true },
    });
    res.json({ user, applications });
  } catch (error) {
    res.json({ user: null, applications: [] });
  }
};

// Get applied status for all sheet jobs
exports.getSheetAppliedStatus = async (req, res) => {
  try {
    const userId = req.user.id;
    const applications = await prisma.sheetJobApplication.findMany({
      where: { userId },
      select: { jobLink: true, status: true, appliedMethod: true, employerName: true, jobTitle: true, matchScore: true, createdAt: true },
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
