/**
 * jobController.js
 *
 * Thin controller — all heavy lifting is in jobPipelineService and supporting services.
 * Handles:
 *  - SSE live search stream
 *  - Matched jobs (saved from last run)
 *  - Stats and usage
 *  - External apply tracking (student marks themselves applied)
 *  - Application listing (student view)
 *  - On-demand match-score
 *  - ATS resume generate + save
 *  - Admin: all-applications view, status patch
 */

const prisma = require('../config/database');
const { runJobSearchPipeline, getUsageInfo } = require('../services/jobPipelineService');
const { scoreJob } = require('../services/jobScoringService');
const { buildSearchIntent } = require('../services/geminiIntentService');

// ── SSE: live search stream ───────────────────────────────────────────────────

exports.streamJobSearch = async (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx: disable buffering
  res.flushHeaders();

  // Heartbeat every 20 s to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    try { if (!res.writableEnded) res.write(': heartbeat\n\n'); } catch { /* ignore */ }
  }, 20000);

  const userId = req.params.studentId || req.user.id;
  const days   = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 30);

  req.on('close', () => clearInterval(heartbeat));

  try {
    await runJobSearchPipeline({ userId, res, days });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
};

// ── Matched jobs (last saved run) ─────────────────────────────────────────────

exports.getMatchedJobs = async (req, res) => {
  try {
    const userId = req.params.studentId || req.user.id;

    const matches = await prisma.jobMatch.findMany({
      where: { userId },
      orderBy: [{ matchScore: 'desc' }, { savedAt: 'desc' }],
      take: 100,
    });

    // Shape to frontend-expected job object
    const jobs = matches.map(mapMatchToJob);
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load matched jobs', error: err.message });
  }
};

// ── Stats ─────────────────────────────────────────────────────────────────────

exports.getStats = async (req, res) => {
  try {
    const userId = req.params.studentId || req.user.id;

    const [totalMatchedJobs, totalExternal, runs] = await Promise.all([
      prisma.jobMatch.count({ where: { userId } }),
      prisma.externalJobApplication.count({ where: { userId } }),
      prisma.jobSearchRun.findFirst({
        where: { userId, status: 'COMPLETED' },
        orderBy: { createdAt: 'desc' },
        select: { jobsFound: true, durationMs: true, createdAt: true },
      }),
    ]);

    const adminApplyCount = await prisma.externalJobApplication.count({
      where: { userId, appliedById: { not: null } },
    });

    res.json({
      totalMatchedJobs,
      externalAppliedCount: totalExternal,
      candidateApplyCount: totalExternal - adminApplyCount,
      adminApplyCount,
      lastSearch: runs ? {
        jobsFound: runs.jobsFound,
        durationMs: runs.durationMs,
        at: runs.createdAt,
      } : null,
      totalApplications: totalExternal,
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load stats', error: err.message });
  }
};

// ── Usage ─────────────────────────────────────────────────────────────────────

exports.getUsage = async (req, res) => {
  try {
    const userId = req.params.studentId || req.user.id;
    const user   = await prisma.user.findUnique({
      where: { id: userId },
      select: { subscriptionPlan: true },
    });
    const info = await getUsageInfo(userId, user?.subscriptionPlan);
    res.json(info);
  } catch (err) {
    res.status(500).json({ message: 'Failed to load usage', error: err.message });
  }
};

// ── External apply: student or admin marks a job as applied ──────────────────

exports.markExternalApplied = async (req, res) => {
  try {
    const userId     = req.params.studentId || req.user.id;
    const appliedById = req.user.role === 'STUDENT' ? null : req.user.id;
    const { jobLink, jobTitle, employerName, matchScore, jobMatchId } = req.body;

    if (!jobLink) return res.status(400).json({ message: 'jobLink is required' });

    const record = await prisma.externalJobApplication.upsert({
      where: { userId_jobLink: { userId, jobLink } },
      create: {
        userId,
        jobMatchId:   jobMatchId || null,
        appliedById,
        jobLink,
        jobTitle:     jobTitle     || null,
        employerName: employerName || null,
        matchScore:   matchScore   ? String(matchScore) : null,
        appliedMethod: appliedById ? 'ADMIN' : 'MANUAL',
        status: 'APPLIED',
      },
      update: {
        appliedById,
        appliedMethod: appliedById ? 'ADMIN' : 'MANUAL',
      },
    });

    res.json({ message: 'Application recorded', application: record });
  } catch (err) {
    res.status(500).json({ message: 'Failed to record application', error: err.message });
  }
};

// ── External applied status ───────────────────────────────────────────────────

exports.getExternalAppliedStatus = async (req, res) => {
  try {
    const userId = req.params.studentId || req.user.id;

    const applications = await prisma.externalJobApplication.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ applications });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load applied status', error: err.message });
  }
};

// ── My applications (formal tracked) ─────────────────────────────────────────

exports.getMyApplications = async (req, res) => {
  try {
    const userId = req.params.studentId || req.user.id;
    const { status, limit = 20, page = 1 } = req.query;

    const where = { userId };
    if (status) where.status = status;

    const [applications, total] = await Promise.all([
      prisma.jobApplication.findMany({
        where,
        orderBy: { appliedAt: 'desc' },
        take: parseInt(limit),
        skip: (parseInt(page) - 1) * parseInt(limit),
        include: {
          appliedByUser: { select: { id: true, fullName: true, role: true } },
          jobMatch:      { select: { title: true, company: true, applyLink: true } },
        },
      }),
      prisma.jobApplication.count({ where }),
    ]);

    res.json({
      applications: applications.map((a) => ({
        id:       a.id,
        status:   a.status,
        appliedAt: a.appliedAt,
        appliedBy: a.appliedByUser || null,
        job: {
          title:    a.title   || a.jobMatch?.title   || 'Untitled',
          company:  a.company || a.jobMatch?.company || '—',
          applyLink: a.applyLink || a.jobMatch?.applyLink || null,
        },
        interviewDate:     a.interviewDate,
        interviewLocation: a.interviewLocation,
        interviewNotes:    a.interviewNotes,
        notes:             a.notes,
      })),
      pagination: {
        total,
        page: parseInt(page),
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load applications', error: err.message });
  }
};

// ── All applications (admin view) ─────────────────────────────────────────────

exports.getAllApplications = async (req, res) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;

    const where = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { title:   { contains: search, mode: 'insensitive' } },
        { company: { contains: search, mode: 'insensitive' } },
        { user: { fullName: { contains: search, mode: 'insensitive' } } },
        { user: { email:    { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [applications, total] = await Promise.all([
      prisma.jobApplication.findMany({
        where,
        orderBy: { appliedAt: 'desc' },
        take:  parseInt(limit),
        skip: (parseInt(page) - 1) * parseInt(limit),
        include: {
          user:          { select: { id: true, fullName: true, email: true, phone: true } },
          appliedByUser: { select: { id: true, fullName: true, role: true } },
        },
      }),
      prisma.jobApplication.count({ where }),
    ]);

    res.json({
      applications: applications.map((a) => ({
        id:       a.id,
        status:   a.status,
        appliedAt: a.appliedAt,
        notes:     a.notes,
        interviewDate:     a.interviewDate,
        interviewLocation: a.interviewLocation,
        interviewNotes:    a.interviewNotes,
        user:     a.user,
        appliedBy: a.appliedByUser || null,
        job: {
          title:    a.title,
          company:  a.company,
          applyLink: a.applyLink,
        },
      })),
      pagination: {
        total,
        page: parseInt(page),
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load applications', error: err.message });
  }
};

// ── Update application status (admin) ─────────────────────────────────────────

exports.updateApplicationStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes, interviewDate, interviewLocation, interviewNotes } = req.body;

    const validStatuses = ['APPLIED', 'INTERVIEW_SCHEDULED', 'OFFER_RECEIVED', 'REJECTED'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const data = {};
    if (status)            data.status            = status;
    if (notes !== undefined) data.notes            = notes;
    if (interviewDate !== undefined) data.interviewDate     = interviewDate ? new Date(interviewDate) : null;
    if (interviewLocation !== undefined) data.interviewLocation = interviewLocation;
    if (interviewNotes !== undefined)    data.interviewNotes   = interviewNotes;

    const updated = await prisma.jobApplication.update({
      where: { id },
      data,
    });

    res.json({ message: 'Application updated', application: updated });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update application', error: err.message });
  }
};

// ── Match score (on-demand JD vs resume) ──────────────────────────────────────

exports.getMatchScore = async (req, res) => {
  try {
    const userId = req.params.studentId || req.user.id;
    const { jd, resume_text, match_score, skills } = req.body;

    if (!jd) return res.status(400).json({ message: 'jd is required' });

    // Load intent from user profile for accurate scoring
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { jobRole: true, experience: true, location: true, keySkills: true, parsedResumeText: true, subscriptionPlan: true },
    });

    const { extractResumeIntro } = require('../services/jobPipelineService');

    const intent = await buildSearchIntent({
      jobRole:            user?.jobRole    || '',
      experience:         user?.experience || '',
      location:           user?.location   || '',
      skills:             skills || user?.keySkills || [],
      resumeIntroSummary: extractResumeIntro(resume_text || user?.parsedResumeText || ''),
    }).catch(() => ({
      normalizedRole:       user?.jobRole || '',
      titleVariants:        [],
      searchQueries:        [],
      seniority:            'any',
      seniorityRange:       { minYears: 0, maxYears: 20 },
      skillKeywords:        skills || user?.keySkills || [],
      locationVariants:     [user?.location, 'remote'].filter(Boolean),
      exclusionKeywords:    [],
      cleanedResumeSummary: extractResumeIntro(resume_text || user?.parsedResumeText || ''),
    }));

    const fakeJob = {
      title:       intent.normalizedRole,
      company:     '',
      location:    user?.location || '',
      description: jd,
      isRemote:    false,
      impliedSkills: [],
    };

    const result = scoreJob(fakeJob, intent);

    res.json({
      score:          result.score,
      summary:        result.summary,
      jdKeywords:     intent.skillKeywords,
      matchedKeywords: result.strongMatches ? result.strongMatches.split(', ') : [],
      missingKeywords: result.skillGaps     ? result.skillGaps.split(', ')     : [],
      missingSkills:   result.skillGaps     ? result.skillGaps.split(', ')     : [],
    });
  } catch (err) {
    res.status(500).json({ message: 'Match score failed', error: err.message });
  }
};

// ── ATS Resume generate ───────────────────────────────────────────────────────

exports.generateResume = async (req, res) => {
  try {
    const userId  = req.params.studentId || req.user.id;
    const job     = req.body; // full job object from frontend

    if (!job?.applyLink && !job?.job_apply_link) {
      return res.status(400).json({ message: 'Job apply link is required' });
    }

    const applyLink = job.applyLink || job.job_apply_link;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { fullName: true, parsedResumeText: true, keySkills: true, jobRole: true, experience: true, location: true, email: true, phone: true, linkedinProfile: true },
    });

    if (!user?.parsedResumeText) {
      return res.status(400).json({ message: 'No resume uploaded. Please upload your resume first.' });
    }

    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
    });

    const jd          = job.jd || job.description || '';
    const jobTitle    = job.job_title || job.title || 'the role';
    const companyName = job.employer_name || job.company || '';

    const prompt = `You are an expert ATS resume writer. 
Rewrite the candidate's resume to be optimised for this specific job, preserving ALL original content (experience, education, achievements) while tailoring the language to match the JD.

CANDIDATE NAME: ${user.fullName}
ORIGINAL RESUME:
${user.parsedResumeText.substring(0, 8000)}

JOB TITLE: ${jobTitle}
COMPANY: ${companyName}
JOB DESCRIPTION (first 3000 chars):
${jd.substring(0, 3000)}

Instructions:
1. Keep all real experience, projects, education — do not invent anything
2. Naturally incorporate keywords from the JD into existing bullet points
3. Start with a tailored professional summary (3-4 sentences)
4. Use clean plain-text format with clear section headings (SUMMARY, EXPERIENCE, SKILLS, EDUCATION)
5. Keep bullet points concise and achievement-oriented
6. Output ONLY the resume text, no explanations or meta-commentary`;

    const result = await model.generateContent(prompt);
    const resumeText = result.response.text().trim();

    // Save to JobMatch if we can find it
    const updatedMatch = await prisma.jobMatch.update({
      where: { userId_applyLink: { userId, applyLink } },
      data: { resumeText, candidateName: user.fullName },
    }).catch(() => null); // ok if match not found

    const updatedJob = updatedMatch ? { ...job, ...mapMatchToJob(updatedMatch) } : { ...job, resume_text: resumeText, candidate_name: user.fullName };

    res.json({ message: 'ATS resume generated successfully.', job: updatedJob });
  } catch (err) {
    res.status(500).json({ message: 'Resume generation failed', error: err.message });
  }
};

// ── ATS Resume save (user edited the draft) ───────────────────────────────────

exports.saveResume = async (req, res) => {
  try {
    const userId    = req.params.studentId || req.user.id;
    const { id, job_apply_link, resume_text } = req.body;

    const applyLink = job_apply_link;
    if (!applyLink) return res.status(400).json({ message: 'job_apply_link is required' });

    const updatedMatch = await prisma.jobMatch.update({
      where: { userId_applyLink: { userId, applyLink } },
      data:  { resumeText: resume_text },
    }).catch(() => null);

    res.json({
      message: 'Resume saved.',
      job: updatedMatch ? mapMatchToJob(updatedMatch) : null,
    });
  } catch (err) {
    res.status(500).json({ message: 'Resume save failed', error: err.message });
  }
};

// ── Helper: map DB JobMatch → frontend job shape ──────────────────────────────

function mapMatchToJob(m) {
  return {
    id:                          m.id,
    externalId:                  m.externalId,
    job_title:                   m.title,
    employer_name:                m.company,
    job_location:                 m.location,
    job_employment_type:          m.employmentType,
    jd:                           m.description,
    job_apply_link:               m.applyLink,
    job_posted_at_datetime_utc:   m.postedAt ? m.postedAt.toISOString() : null,
    match_score:                  m.matchScore,
    match_summary:                m.matchSummary,
    strong_matches:               m.strongMatches,
    skill_gaps:                   m.skillGaps,
    resume_text:                  m.resumeText || null,
    candidate_name:               m.candidateName || null,
    saved_at:                     m.savedAt ? m.savedAt.toISOString() : null,
    // Also include camelCase variants for backward compat
    title:       m.title,
    company:     m.company,
    location:    m.location,
    description: m.description,
    applyLink:   m.applyLink,
    matchScore:  m.matchScore,
    matchSummary: m.matchSummary,
    strongMatches: m.strongMatches,
    skillGaps:    m.skillGaps,
  };
}
