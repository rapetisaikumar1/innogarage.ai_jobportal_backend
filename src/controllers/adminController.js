const prisma = require('../config/database');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jsJobSearchService = require('../services/jsJobSearchService');
const aiService = require('../services/aiService');

const parseJsonField = (value, fallback = []) => {
  if (value == null) return fallback;
  if (Array.isArray(value) || typeof value === 'object') return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const mapSavedJobToListing = (job, student = {}) => ({
  id: job.id,
  candidate_id: student.id || job.userId || '',
  candidate_email: student.email || '',
  candidate_name: student.fullName || '',
  employer_name: job.employerName || '',
  job_title: job.jobTitle || '',
  job_city: job.jobCity || '',
  job_state: job.jobState || '',
  job_country: job.jobCountry || '',
  job_employment_type: job.employmentType || '',
  match_score: job.matchScore || 0,
  job_apply_link: job.applyLink || '',
  employer_logo: job.employerLogo || '',
  source: job.source || '',
  posted: job.postedAt || '',
  timestamp: job.createdAt,
  match_summary: job.matchSummary || '',
  strong_matches: JSON.stringify(job.strongMatches || []),
  partial_matches: '[]',
  missing_skills: JSON.stringify(job.missingSkills || []),
  pdf_link: '',
  jd: job.jd || '',
  // Include persisted resume text so the portal shows "Resume" instead of "Gen Resume"
  resume_text: job.resumeText || '',
});

const saveSearchResultsForStudent = async (studentId, results) => {
  const seenLinks = new Set();
  const topResults = (results || [])
    .filter((job) => job.job_apply_link && job.job_apply_link.startsWith('http'))
    .filter((job) => {
      const key = job.job_apply_link.toLowerCase();
      if (seenLinks.has(key)) return false;
      seenLinks.add(key);
      return true;
    })
    .sort((a, b) => (parseInt(b.match_score, 10) || 0) - (parseInt(a.match_score, 10) || 0))
    .slice(0, 30);

  const saved = [];

  for (const result of topResults) {
    const data = {
      userId: studentId,
      employerName: result.employer_name || null,
      jobTitle: result.job_title || null,
      jobCity: result.job_city || null,
      jobState: result.job_state || null,
      jobCountry: result.job_country || null,
      employmentType: result.job_employment_type || null,
      applyLink: result.job_apply_link || null,
      employerLogo: result.employer_logo || null,
      source: result.source || result.job_publisher || null,
      postedAt: result.posted || result.timestamp || null,
      jd: result.jd || null,
      matchScore: parseInt(result.match_score, 10) || 0,
      strongMatches: parseJsonField(result.strong_matches),
      missingSkills: parseJsonField(result.missing_skills),
      matchSummary: result.match_summary || null,
      resumeText: null,
    };

    const existing = await prisma.savedJobResult.findFirst({
      where: { userId: studentId, applyLink: data.applyLink },
      select: { id: true, resumeText: true },
    });

    if (existing?.resumeText) {
      data.resumeText = existing.resumeText;
    }

    const savedJob = existing
      ? await prisma.savedJobResult.update({ where: { id: existing.id }, data })
      : await prisma.savedJobResult.create({ data });

    saved.push(savedJob);
  }

  return saved;
};

// ---- Admin (Mentor) Management ----

// Create Super Admin
exports.createSuperAdmin = async (req, res) => {
  try {
    const { fullName, email, password } = req.body;
    if (!fullName || !email || !password) {
      return res.status(400).json({ message: 'Full name, email, and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ message: 'Email already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const superAdmin = await prisma.user.create({
      data: {
        fullName,
        email,
        password: hashedPassword,
        role: 'SUPER_ADMIN',
        isActive: true,
        isEmailVerified: true,
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        createdAt: true,
      },
    });

    res.status(201).json(superAdmin);
  } catch (error) {
    res.status(500).json({ message: 'Failed to create super admin', error: error.message });
  }
};

// Create Admin (Mentor)
exports.createAdmin = async (req, res) => {
  try {
    const { fullName, email, password, mentorBio, phone, department } = req.body;

    const validDepartments = ['MARKETING', 'PROXY', 'HR'];
    if (department && !validDepartments.includes(department)) {
      return res.status(400).json({ message: 'Invalid department. Must be MARKETING, PROXY, or HR' });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ message: 'Email already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const admin = await prisma.user.create({
      data: {
        fullName,
        email,
        phone,
        password: hashedPassword,
        role: 'ADMIN',
        isActive: true,
        isEmailVerified: true,
        mentorBio,
        department: department || null,
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
        mentorBio: true,
        department: true,
        createdAt: true,
      },
    });

    res.status(201).json(admin);
  } catch (error) {
    res.status(500).json({ message: 'Failed to create admin', error: error.message });
  }
};

// Get all admins
exports.getAdmins = async (req, res) => {
  try {
    const admins = await prisma.user.findMany({
      where: { role: 'ADMIN' },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        isActive: true,
        mentorBio: true,
        department: true,
        createdAt: true,
        _count: {
          select: { assignedStudents: true, mentoringSlots: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(admins);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch admins', error: error.message });
  }
};

// Toggle admin active status
exports.toggleAdminStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const admin = await prisma.user.findUnique({ where: { id } });

    if (!admin || admin.role !== 'ADMIN') {
      return res.status(404).json({ message: 'Admin not found' });
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { isActive: !admin.isActive },
      select: { id: true, fullName: true, isActive: true },
    });

    res.json(updated);
  } catch (error) {
    res.status(500).json({ message: 'Failed to toggle admin status', error: error.message });
  }
};

// Update admin department
exports.updateAdminDepartment = async (req, res) => {
  try {
    const { id } = req.params;
    const { department } = req.body;

    const validDepartments = ['MARKETING', 'PROXY', 'HR'];
    if (!department || !validDepartments.includes(department)) {
      return res.status(400).json({ message: 'Invalid department. Must be MARKETING, PROXY, or HR' });
    }

    const admin = await prisma.user.findUnique({ where: { id } });
    if (!admin || admin.role !== 'ADMIN') {
      return res.status(404).json({ message: 'Admin not found' });
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { department },
      select: { id: true, fullName: true, department: true },
    });

    res.json(updated);
  } catch (error) {
    res.status(500).json({ message: 'Failed to update department', error: error.message });
  }
};

// ---- Student Management ----

// Get all students
exports.getStudents = async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = { role: 'STUDENT' };
    if (search) {
      where.OR = [
        { fullName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { registrationNumber: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [students, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          registrationNumber: true,
          fullName: true,
          email: true,
          phone: true,
          isActive: true,
          isEmailVerified: true,
          status: true,
          education: true,
          experience: true,
          keySkills: true,
          resumeUrl: true,
          subscriptionPlan: true,
          assignedMentorId: true,
          assignedMentor: {
            select: { id: true, fullName: true },
          },
          adminAssignments: {
            include: {
              admin: { select: { id: true, fullName: true, email: true, department: true } },
            },
            orderBy: { createdAt: 'asc' },
          },
          createdAt: true,
          _count: {
            select: { jobApplications: true, bookings: true, sheetApplications: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit),
      }),
      prisma.user.count({ where }),
    ]);

    res.json({
      students,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch students', error: error.message });
  }
};

// Get student detail
exports.getStudentDetail = async (req, res) => {
  try {
    const student = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        registrationNumber: true,
        fullName: true,
        email: true,
        phone: true,
        isActive: true,
        isEmailVerified: true,
        linkedinProfile: true,
        education: true,
        experience: true,
        keySkills: true,
        jobRole: true,
        location: true,
        resumeUrl: true,
        avatarUrl: true,
        assignedMentorId: true,
        assignedMentor: {
          select: { id: true, fullName: true, email: true },
        },
        adminAssignments: {
          select: {
            id: true,
            department: true,
            admin: { select: { id: true, fullName: true, email: true, department: true } },
          },
        },
        createdAt: true,
        updatedAt: true,
        jobApplications: {
          include: { job: { select: { id: true, title: true, company: true, location: true, source: true } } },
          orderBy: { appliedAt: 'desc' },
        },
        bookings: {
          include: { slot: { include: { mentor: { select: { id: true, fullName: true, email: true } } } } },
          orderBy: { createdAt: 'desc' },
        },
        sheetApplications: {
          orderBy: { createdAt: 'desc' },
        },
        trainingNotes: {
          select: { id: true, title: true, category: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        _count: {
          select: { jobApplications: true, bookings: true, sheetApplications: true, trainingNotes: true, tailoredResumes: true },
        },
      },
    });

    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }

    res.json(student);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch student', error: error.message });
  }
};

// Delete student
exports.deleteStudent = async (req, res) => {
  try {
    const { id } = req.params;
    const student = await prisma.user.findUnique({ where: { id } });

    if (!student || student.role !== 'STUDENT') {
      return res.status(404).json({ message: 'Student not found' });
    }

    await prisma.user.delete({ where: { id } });
    res.json({ message: 'Student deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to delete student', error: error.message });
  }
};

// Update student subscription plan
exports.updateStudentPlan = async (req, res) => {
  try {
    const { id } = req.params;
    const { plan } = req.body;

    const validPlans = ['FREE', 'BASIC', 'PRO', 'ULTRA'];
    if (!validPlans.includes(plan)) {
      return res.status(400).json({ message: 'Invalid plan. Must be FREE, BASIC, PRO, or ULTRA' });
    }

    const student = await prisma.user.findUnique({ where: { id } });
    if (!student || student.role !== 'STUDENT') {
      return res.status(404).json({ message: 'Student not found' });
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { subscriptionPlan: plan },
      select: { id: true, fullName: true, subscriptionPlan: true },
    });

    res.json(updated);
  } catch (error) {
    res.status(500).json({ message: 'Failed to update plan', error: error.message });
  }
};

// Toggle student active status
exports.toggleStudentStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const student = await prisma.user.findUnique({ where: { id } });

    if (!student || student.role !== 'STUDENT') {
      return res.status(404).json({ message: 'Student not found' });
    }

    const newStatus = student.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    const updated = await prisma.user.update({
      where: { id },
      data: { status: newStatus },
      select: { id: true, fullName: true, status: true },
    });

    res.json(updated);
  } catch (error) {
    res.status(500).json({ message: 'Failed to toggle student status', error: error.message });
  }
};

// Register a new student
exports.registerStudent = async (req, res) => {
  try {
    const { fullName, email, phone, education } = req.body;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ message: 'Email already registered' });
    }

    const regNumber = 'MIG-26' + crypto.randomInt(100, 999).toString();
    const tempPassword = crypto.randomBytes(4).toString('hex');
    const hashedPassword = await bcrypt.hash(tempPassword, 12);

    const student = await prisma.user.create({
      data: {
        fullName,
        email,
        phone,
        education,
        password: hashedPassword,
        role: 'STUDENT',
        registrationNumber: regNumber,
        isActive: true,
        isEmailVerified: false,
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        registrationNumber: true,
        education: true,
        isActive: true,
        status: true,
        createdAt: true,
      },
    });

    res.status(201).json({ ...student, tempPassword });
  } catch (error) {
    res.status(500).json({ message: 'Failed to register student', error: error.message });
  }
};

// Get student by registration number
exports.getStudentByRegNumber = async (req, res) => {
  try {
    const { regNumber } = req.params;
    const student = await prisma.user.findUnique({
      where: { registrationNumber: regNumber },
      select: {
        id: true,
        registrationNumber: true,
        fullName: true,
        email: true,
        phone: true,
        isActive: true,
        isEmailVerified: true,
        status: true,
        linkedinProfile: true,
        education: true,
        experience: true,
        keySkills: true,
        resumeUrl: true,
        avatarUrl: true,
        assignedMentorId: true,
        assignedMentor: {
          select: { id: true, fullName: true, email: true },
        },
        createdAt: true,
        jobApplications: {
          include: { job: true },
          orderBy: { appliedAt: 'desc' },
        },
      },
    });

    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }

    res.json(student);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch student', error: error.message });
  }
};

// Assign mentor to students
exports.assignMentor = async (req, res) => {
  try {
    const { mentorId, studentIds } = req.body;

    // Handle unassign (null/empty mentorId)
    if (!mentorId) {
      // Remove all admin assignments for these students
      await prisma.studentAdminAssignment.deleteMany({
        where: { studentId: { in: studentIds } },
      });
      // Also clear legacy assignedMentorId
      await prisma.user.updateMany({
        where: { id: { in: studentIds }, role: 'STUDENT' },
        data: { assignedMentorId: null },
      });
      return res.json({ message: `${studentIds.length} students unassigned from all admins` });
    }

    const mentor = await prisma.user.findUnique({ where: { id: mentorId } });
    if (!mentor || mentor.role !== 'ADMIN') {
      return res.status(404).json({ message: 'Admin not found' });
    }

    // For each student, check they don't already have 5 admins
    // Rule: first admin must be MARKETING department
    const results = [];
    for (const studentId of studentIds) {
      const existingAssignments = await prisma.studentAdminAssignment.findMany({
        where: { studentId },
        include: { admin: { select: { id: true, department: true } } },
      });
      const existingCount = existingAssignments.length;
      const alreadyAssigned = existingAssignments.some(a => a.adminId === mentorId);
      if (alreadyAssigned) {
        results.push({ studentId, status: 'already_assigned' });
        continue;
      }
      if (existingCount >= 5) {
        results.push({ studentId, status: 'limit_reached' });
        continue;
      }
      // First assignment must be a MARKETING admin
      if (existingCount === 0 && mentor.department !== 'MARKETING') {
        results.push({ studentId, status: 'marketing_first', message: 'First admin must be from Marketing department' });
        continue;
      }
      // After first, check that this department type isn't duplicated
      await prisma.studentAdminAssignment.create({
        data: { studentId, adminId: mentorId, department: mentor.department || null },
      });
      // Keep legacy field in sync (set to first assigned admin)
      await prisma.user.update({
        where: { id: studentId },
        data: { assignedMentorId: mentorId },
      });

      // Auto-create or update group chat
      const studentInfo = await prisma.user.findUnique({
        where: { id: studentId },
        select: { fullName: true, registrationNumber: true },
      });
      const groupName = `${studentInfo.fullName} @STUDENT @${studentInfo.registrationNumber || 'N/A'}`;

      let group = await prisma.chatGroup.findUnique({ where: { studentId } });
      if (!group) {
        // First assignment — create group with student + super admins + this admin
        const superAdmins = await prisma.user.findMany({
          where: { role: 'SUPER_ADMIN', isActive: true },
          select: { id: true },
        });
        const memberIds = [...new Set([studentId, mentorId, ...superAdmins.map(s => s.id)])];
        group = await prisma.chatGroup.create({
          data: {
            name: groupName,
            studentId,
            members: { create: memberIds.map(uid => ({ userId: uid })) },
          },
        });
      } else {
        // Add new admin to existing group
        await prisma.chatGroupMember.create({
          data: { groupId: group.id, userId: mentorId },
        }).catch(() => {}); // ignore if already a member
      }

      results.push({ studentId, status: 'assigned' });
    }

    const assigned = results.filter(r => r.status === 'assigned').length;
    const limited = results.filter(r => r.status === 'limit_reached').length;
    let msg = `${assigned} student(s) assigned to ${mentor.fullName}`;
    if (limited > 0) msg += `. ${limited} student(s) already have 5 admins assigned.`;

    res.json({ message: msg, results });
  } catch (error) {
    res.status(500).json({ message: 'Failed to assign admin', error: error.message });
  }
};

// ---- Analytics ----

// Get platform analytics
exports.getAnalytics = async (req, res) => {
  try {
    const [
      totalStudents,
      totalAdmins,
      totalInternalJobs,
      totalMatchedJobs,
      totalInternalApplications,
      totalSheetApplications,
      activeStudents,
      totalBookings,
      studentsWithoutMentor,
      completedBookings,
      totalMaterials,
    ] = await Promise.all([
      prisma.user.count({ where: { role: 'STUDENT' } }),
      prisma.user.count({ where: { role: 'ADMIN' } }),
      prisma.job.count({ where: { isActive: true } }),
      prisma.savedJobResult.count(),
      prisma.jobApplication.count(),
      prisma.sheetJobApplication.count(),
      prisma.user.count({ where: { role: 'STUDENT', isActive: true } }),
      prisma.mentorBooking.count(),
      prisma.user.count({ where: { role: 'STUDENT', assignedMentorId: null, adminAssignments: { none: {} } } }),
      prisma.mentorBooking.count({ where: { status: 'COMPLETED' } }),
      prisma.trainingMaterial.count(),
    ]);

    // Parallel: recent apps, combined status breakdown, technology breakdown
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [recentApplications, internalApplicationsByStatus, sheetApplicationsByStatus, studentsWithRole] = await Promise.all([
      prisma.jobApplication.groupBy({
        by: ['appliedAt'],
        where: { appliedAt: { gte: sevenDaysAgo } },
        _count: { _all: true },
      }),
      prisma.jobApplication.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      prisma.sheetJobApplication.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      prisma.user.findMany({
        where: { role: 'STUDENT', jobRole: { not: null } },
        select: { jobRole: true },
      }),
    ]);

    // Application status breakdown
    const statusBreakdown = {};
    const addStatusCount = (status, count) => {
      if (!status) return;
      statusBreakdown[status] = (statusBreakdown[status] || 0) + (count || 0);
    };
    internalApplicationsByStatus.forEach(item => addStatusCount(item.status, item._count?._all || 0));
    sheetApplicationsByStatus.forEach(item => addStatusCount(item.status, item._count?._all || 0));

    // Technology/Role-wise candidate breakdown
    const technologyBreakdown = {};
    studentsWithRole.forEach(s => {
      const role = (s.jobRole || '').trim();
      if (role) {
        technologyBreakdown[role] = (technologyBreakdown[role] || 0) + 1;
      }
    });

    const totalJobs = totalInternalJobs + totalMatchedJobs;
    const totalApplications = totalInternalApplications + totalSheetApplications;
    const interviewsScheduled = statusBreakdown.INTERVIEW_SCHEDULED || 0;
    const offersReceived = statusBreakdown.OFFER_RECEIVED || 0;
    const rejectedApplications = statusBreakdown.REJECTED || 0;

    res.json({
      totalStudents,
      totalAdmins,
      totalMentors: totalAdmins,
      totalJobs,
      totalInternalJobs,
      totalMatchedJobs,
      totalApplications,
      totalInternalApplications,
      totalSheetApplications,
      activeStudents,
      interviewsScheduled,
      offersReceived,
      totalBookings,
      rejectedApplications,
      studentsWithoutMentor,
      completedBookings,
      totalMaterials,
      recentApplications,
      applicationsByStatus: statusBreakdown,
      technologyBreakdown,
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch analytics', error: error.message });
  }
};

// ---- Mentor's Student Management (Admin) ----

// Get mentor's assigned students
exports.getAssignedStudents = async (req, res) => {
  try {
    // Check new multi-admin table first, fall back to legacy
    const assignments = await prisma.studentAdminAssignment.findMany({
      where: { adminId: req.user.id },
      select: { studentId: true },
    });
    const studentIds = assignments.map(a => a.studentId);

    // Also include legacy assignedMentorId students
    const legacyStudents = await prisma.user.findMany({
      where: { assignedMentorId: req.user.id, role: 'STUDENT', id: { notIn: studentIds } },
      select: { id: true },
    });
    const allIds = [...studentIds, ...legacyStudents.map(s => s.id)];

    const students = await prisma.user.findMany({
      where: { id: { in: allIds }, role: 'STUDENT' },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        education: true,
        experience: true,
        keySkills: true,
        resumeUrl: true,
        isActive: true,
        status: true,
        createdAt: true,
        _count: {
          select: { jobApplications: true, sheetApplications: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(students);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch students', error: error.message });
  }
};

// Get student application progress (Mentor)
exports.getStudentProgress = async (req, res) => {
  try {
    const { studentId } = req.params;

    const student = await prisma.user.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        fullName: true,
        email: true,
        assignedMentorId: true,
      },
    });

    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }

    // Only allow assigned mentor/admin or super admin
    if (req.user.role === 'ADMIN') {
      const isAssigned = await prisma.studentAdminAssignment.findUnique({
        where: { studentId_adminId: { studentId, adminId: req.user.id } },
      });
      if (!isAssigned && student.assignedMentorId !== req.user.id) {
        return res.status(403).json({ message: 'Not authorized to view this student' });
      }
    }

    const applications = await prisma.jobApplication.findMany({
      where: { userId: studentId },
      include: { job: true },
      orderBy: { appliedAt: 'desc' },
    });

    const stats = {
      total: applications.length,
      applied: applications.filter(a => a.status === 'APPLIED').length,
      interviewScheduled: applications.filter(a => a.status === 'INTERVIEW_SCHEDULED').length,
      rejected: applications.filter(a => a.status === 'REJECTED').length,
      offerReceived: applications.filter(a => a.status === 'OFFER_RECEIVED').length,
    };

    res.json({ student, applications, stats });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch progress', error: error.message });
  }
};

// ---- Admin View Student Endpoints ----

// Get student dashboard data (stats + recent apps + recent jobs)
exports.getStudentDashboardData = async (req, res) => {
  try {
    const { studentId } = req.params;

    const student = await prisma.user.findUnique({
      where: { id: studentId },
      select: { id: true, fullName: true, email: true, role: true },
    });
    if (!student || student.role !== 'STUDENT') {
      return res.status(404).json({ message: 'Student not found' });
    }

    const [totalApplied, interviewScheduled, rejected, offerReceived, totalMatchedJobs, dbAdminApplied, sheetAdminApplied, sheetTotalApplied] = await Promise.all([
      prisma.jobApplication.count({ where: { userId: studentId, status: 'APPLIED' } }),
      prisma.jobApplication.count({ where: { userId: studentId, status: 'INTERVIEW_SCHEDULED' } }),
      prisma.jobApplication.count({ where: { userId: studentId, status: 'REJECTED' } }),
      prisma.jobApplication.count({ where: { userId: studentId, status: 'OFFER_RECEIVED' } }),
      // Count the student's visible AI-matched jobs, not the internal Job table
      prisma.savedJobResult.count({ where: { userId: studentId, matchScore: { gte: 60 } } }),
      prisma.jobApplication.count({ where: { userId: studentId, appliedById: { not: null } } }),
      prisma.sheetJobApplication.count({ where: { userId: studentId, appliedById: { not: null } } }),
      prisma.sheetJobApplication.count({ where: { userId: studentId } }),
    ]);

    const allDbApplied = totalApplied + interviewScheduled + rejected + offerReceived;
    const adminApplyCount = dbAdminApplied + sheetAdminApplied;
    const candidateApplyCount = (allDbApplied - dbAdminApplied) + (sheetTotalApplied - sheetAdminApplied);

    const recentApplications = await prisma.jobApplication.findMany({
      where: { userId: studentId },
      include: {
        job: true,
        user: { select: { id: true, fullName: true, email: true } },
      },
      orderBy: { appliedAt: 'desc' },
      take: 5,
    });

    const sheetApplications = await prisma.sheetJobApplication.findMany({
      where: { userId: studentId },
      select: { jobLink: true, status: true, appliedMethod: true, employerName: true, jobTitle: true, matchScore: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }).catch(() => []);

    res.json({
      stats: {
        totalJobs: totalMatchedJobs,
        totalSheetJobs: totalMatchedJobs,
        totalApplied: allDbApplied,
        interviewScheduled,
        rejected,
        offerReceived,
        sheetAppliedCount: sheetTotalApplied,
        adminApplyCount,
        candidateApplyCount,
      },
      recentApplications,
      sheetApplications,
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch student dashboard data', error: error.message });
  }
};

// Get student applications (DB + sheet)
exports.getStudentApplications = async (req, res) => {
  try {
    const { studentId } = req.params;
    const { status, page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const student = await prisma.user.findUnique({
      where: { id: studentId },
      select: { id: true, fullName: true, role: true },
    });
    if (!student || student.role !== 'STUDENT') {
      return res.status(404).json({ message: 'Student not found' });
    }

    const where = { userId: studentId };
    if (status) where.status = status;

    const [applications, total] = await Promise.all([
      prisma.jobApplication.findMany({
        where,
        include: {
          job: true,
          user: { select: { id: true, fullName: true, email: true, phone: true, avatarUrl: true } },
        },
        orderBy: { appliedAt: 'desc' },
        skip,
        take: parseInt(limit),
      }),
      prisma.jobApplication.count({ where }),
    ]);

    const sheetApplications = await prisma.sheetJobApplication.findMany({
      where: { userId: studentId },
      select: { jobLink: true, status: true, appliedMethod: true, employerName: true, jobTitle: true, matchScore: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }).catch(() => []);

    res.json({
      applications,
      sheetApplications,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch student applications', error: error.message });
  }
};

// Get a student's saved matched jobs.
exports.getStudentMatchedJobs = async (req, res) => {
  try {
    const { studentId } = req.params;
    const MIN_MATCH_SCORE = 60;

    const student = await prisma.user.findUnique({
      where: { id: studentId },
      select: { id: true, email: true, fullName: true, role: true },
    });
    if (!student || student.role !== 'STUDENT') {
      return res.status(404).json({ message: 'Student not found' });
    }

    const jobs = await prisma.savedJobResult.findMany({
      where: { userId: studentId, matchScore: { gte: MIN_MATCH_SCORE } },
      orderBy: [{ matchScore: 'desc' }, { createdAt: 'desc' }],
      take: 30,
    });

    res.json({ jobs: jobs.map((job) => mapSavedJobToListing(job, student)) });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch student job listings', error: error.message });
  }
};

// Unassign a specific admin from a student
exports.unassignAdmin = async (req, res) => {
  try {
    const { studentId, adminId } = req.body;

    await prisma.studentAdminAssignment.deleteMany({
      where: { studentId, adminId },
    });

    // Remove admin from the student's group chat
    const group = await prisma.chatGroup.findUnique({ where: { studentId } });
    if (group) {
      await prisma.chatGroupMember.deleteMany({
        where: { groupId: group.id, userId: adminId },
      });
    }

    // If removing the legacy assignedMentorId
    const student = await prisma.user.findUnique({ where: { id: studentId } });
    if (student && student.assignedMentorId === adminId) {
      // Set to another assigned admin or null
      const remaining = await prisma.studentAdminAssignment.findFirst({
        where: { studentId },
      });
      await prisma.user.update({
        where: { id: studentId },
        data: { assignedMentorId: remaining ? remaining.adminId : null },
      });
    }

    res.json({ message: 'Admin unassigned from student' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to unassign admin', error: error.message });
  }
};

// ---- Admin Apply on Behalf of Student ----

// Trigger code-based job search on behalf of a student.
exports.triggerStudentJobSearch = async (req, res) => {
  try {
    const { studentId } = req.params;
    const student = await prisma.user.findUnique({
      where: { id: studentId },
      select: {
        id: true, fullName: true, email: true, keySkills: true,
        resumeUrl: true, jobRole: true, location: true, role: true, experience: true, education: true,
        subscriptionPlan: true, stripeSessionId: true, jobSearchCount: true, lastSearchReset: true,
      },
    });
    if (!student || student.role !== 'STUDENT') {
      return res.status(404).json({ message: 'Student not found' });
    }

    const days = Math.min(30, Math.max(1, parseInt(req.body.days, 10) || 1));
    const results = await jsJobSearchService.searchJobs(student, days);
    const savedJobs = await saveSearchResultsForStudent(studentId, results);

    res.json({
      message: savedJobs.length > 0
        ? `Found ${savedJobs.length} matching jobs for ${student.fullName}.`
        : 'No matching jobs found for this profile and time window.',
      jobs: savedJobs.map((job) => mapSavedJobToListing(job, student)),
      mode: 'js',
    });
  } catch (error) {
    console.error('Admin trigger job search error:', error.message);
    res.status(500).json({ message: 'Failed to trigger job search', error: error.message });
  }
};

// Apply for a DB job on behalf of a student
exports.applyJobForStudent = async (req, res) => {
  try {
    const { studentId } = req.params;
    const { jobId } = req.body;

    const student = await prisma.user.findUnique({ where: { id: studentId } });
    if (!student || student.role !== 'STUDENT') {
      return res.status(404).json({ message: 'Student not found' });
    }

    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) {
      return res.status(404).json({ message: 'Job not found' });
    }

    const existing = await prisma.jobApplication.findUnique({
      where: { userId_jobId: { userId: studentId, jobId } },
    });
    if (existing) {
      return res.status(409).json({ message: 'Student already applied for this job' });
    }

    const application = await prisma.jobApplication.create({
      data: {
        userId: studentId,
        jobId,
        status: 'APPLIED',
        isAutoApplied: false,
        appliedById: req.user.id,
        resumeUsed: student.resumeUrl,
        notes: `Applied by admin ${req.user.fullName} on behalf of student`,
      },
      include: { job: true },
    });

    // Notification for the student
    await prisma.notification.create({
      data: {
        userId: studentId,
        title: 'Job Application Update',
        message: 'A job has been applied on your behalf',
        type: 'JOB_APPLIED_BY_ADMIN',
        link: '/dashboard/applications',
      },
    });

    res.status(201).json({ message: 'Application submitted on behalf of student', application });
  } catch (error) {
    res.status(500).json({ message: 'Failed to apply for job', error: error.message });
  }
};

// Mark an external saved job as applied on behalf of student
// Update application status (interview/offer/rejection)
exports.updateApplicationStatus = async (req, res) => {
  try {
    const { studentId } = req.params;
    const { applicationId, status, source } = req.body;

    const validStatuses = ['APPLIED', 'INTERVIEW_SCHEDULED', 'REJECTED', 'OFFER_RECEIVED'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const student = await prisma.user.findUnique({ where: { id: studentId }, select: { id: true, role: true } });
    if (!student || student.role !== 'STUDENT') {
      return res.status(404).json({ message: 'Student not found' });
    }

    if (source === 'sheet') {
      // Update external job application status
      const app = await prisma.sheetJobApplication.findFirst({
        where: { userId: studentId, jobLink: applicationId },
      });
      if (!app) return res.status(404).json({ message: 'Sheet application not found' });
      const updated = await prisma.sheetJobApplication.update({
        where: { id: app.id },
        data: { status },
      });
      return res.json({ message: 'Status updated', application: updated });
    } else {
      // Update DB job application status
      const app = await prisma.jobApplication.findFirst({
        where: { id: applicationId, userId: studentId },
      });
      if (!app) return res.status(404).json({ message: 'Application not found' });
      const updated = await prisma.jobApplication.update({
        where: { id: applicationId },
        data: { status },
      });
      return res.json({ message: 'Status updated', application: updated });
    }
  } catch (error) {
    res.status(500).json({ message: 'Failed to update status', error: error.message });
  }
};

exports.markExternalJobAppliedForStudent = async (req, res) => {
  try {
    const { studentId } = req.params;
    const { jobLink, employerName, matchScore, jobTitle } = req.body;

    if (!jobLink) return res.status(400).json({ message: 'jobLink is required' });

    const student = await prisma.user.findUnique({ where: { id: studentId }, select: { id: true, role: true } });
    if (!student || student.role !== 'STUDENT') {
      return res.status(404).json({ message: 'Student not found' });
    }

    const application = await prisma.sheetJobApplication.upsert({
      where: { userId_jobLink: { userId: studentId, jobLink } },
      update: { status: 'APPLIED', appliedMethod: 'MANUAL', appliedById: req.user.id, employerName, matchScore: matchScore != null ? String(matchScore) : null, jobTitle },
      create: { userId: studentId, jobLink, status: 'APPLIED', appliedMethod: 'MANUAL', appliedById: req.user.id, employerName, matchScore: matchScore != null ? String(matchScore) : null, jobTitle },
    });

    res.json({ message: 'Marked as applied for student', application });
  } catch (error) {
    res.status(500).json({ message: 'Failed to mark applied', error: error.message });
  }
};

// Get applied status for a student's external saved jobs
exports.getStudentExternalAppliedStatus = async (req, res) => {
  try {
    const { studentId } = req.params;
    const applications = await prisma.sheetJobApplication.findMany({
      where: { userId: studentId },
      select: { jobLink: true, status: true, appliedMethod: true, appliedById: true, employerName: true, jobTitle: true, matchScore: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ applications });
  } catch (error) {
    res.json({ applications: [] });
  }
};

// Get all assigned admins for a student
exports.getStudentAdmins = async (req, res) => {
  try {
    const { studentId } = req.params;

    const assignments = await prisma.studentAdminAssignment.findMany({
      where: { studentId },
      include: {
        admin: {
          select: { id: true, fullName: true, email: true, phone: true, mentorBio: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json(assignments.map(a => ({ ...a.admin, department: a.department, assignedAt: a.createdAt })));
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch student admins', error: error.message });
  }
};

// Generate a tailored ATS resume for a student (admin acting on behalf)
exports.generateResumeForStudent = async (req, res) => {
  try {
    const { studentId } = req.params;
    const { forceRegenerate, ...jobData } = req.body || {};

    const student = await prisma.user.findUnique({
      where: { id: studentId },
      select: {
        id: true, fullName: true, email: true, phone: true,
        linkedinProfile: true, keySkills: true, jobRole: true,
        location: true, education: true, experience: true,
        resumeUrl: true, parsedResumeText: true,
      },
    });
    if (!student || !['STUDENT'].includes((await prisma.user.findUnique({ where: { id: studentId }, select: { role: true } }))?.role)) {
      return res.status(404).json({ message: 'Student not found' });
    }

    const jobApplyLink = jobData.job_apply_link;

    const existing = jobApplyLink
      ? await prisma.savedJobResult.findFirst({ where: { userId: studentId, applyLink: jobApplyLink } })
      : null;

    const isReusable = (text) => {
      if (!text || text.length < 1200) return false;
      return /PROFESSIONAL\s+SUMMARY/i.test(text) && /(?:PROFESSIONAL\s+EXPERIENCE|WORK\s+EXPERIENCE|EXPERIENCE)/i.test(text);
    };

    if (existing && isReusable(existing.resumeText) && !forceRegenerate) {
      const mapJob = (j) => ({
        id: j.id,
        job_apply_link: j.applyLink,
        employer_name: j.employerName,
        job_title: j.jobTitle,
        job_city: j.jobCity,
        job_state: j.jobState,
        job_country: j.jobCountry,
        job_employment_type: j.employmentType,
        employer_logo: j.employerLogo,
        source: j.source,
        posted: j.postedAt,
        jd: j.jd,
        match_score: j.matchScore,
        strong_matches: j.strongMatches,
        missing_skills: j.missingSkills,
        match_summary: j.matchSummary,
        resume_text: j.resumeText,
        candidate_name: student.fullName,
      });
      return res.json({ message: 'Existing ATS resume loaded.', job: mapJob(existing), provider: 'cached' });
    }

    // Get resume text from DB or URL (reuse job controller's PDF-parse helper)
    const jobCtrl = require('./jobController');
    const parsedResumeText = await jobCtrl._getParsedResumeTextForUser(student);

    if (!parsedResumeText || parsedResumeText.length < 800) {
      return res.status(400).json({ message: 'Student has no uploaded resume. Please ask them to upload their resume first.' });
    }

    const fullJobData = {
      job_apply_link: jobApplyLink || existing?.applyLink || null,
      employer_name: jobData.employer_name || existing?.employerName || '',
      job_title: jobData.job_title || existing?.jobTitle || '',
      job_city: jobData.job_city || existing?.jobCity || '',
      job_state: jobData.job_state || existing?.jobState || '',
      job_country: jobData.job_country || existing?.jobCountry || '',
      job_employment_type: jobData.job_employment_type || existing?.employmentType || '',
      jd: jobData.jd || existing?.jd || '',
      match_score: parseInt(jobData.match_score, 10) || existing?.matchScore || 0,
      strong_matches: jobData.strong_matches ?? existing?.strongMatches ?? [],
      missing_skills: jobData.missing_skills ?? existing?.missingSkills ?? [],
      match_summary: jobData.match_summary || existing?.matchSummary || '',
    };

    if (!fullJobData.jd) {
      return res.status(400).json({ message: 'Job description is required to generate a resume.' });
    }

    const generatedResume = await aiService.generateATSResumeText({ ...student, parsedResumeText }, fullJobData);
    const resumeText = typeof generatedResume === 'string' ? generatedResume : generatedResume?.text;
    if (!resumeText || !resumeText.trim()) {
      return res.status(500).json({ message: 'Failed to generate ATS resume.' });
    }

    const savedData = {
      userId: studentId,
      employerName: fullJobData.employer_name || null,
      jobTitle: fullJobData.job_title || null,
      jobCity: fullJobData.job_city || null,
      jobState: fullJobData.job_state || null,
      jobCountry: fullJobData.job_country || null,
      applyLink: fullJobData.job_apply_link || null,
      jd: fullJobData.jd || null,
      matchScore: fullJobData.match_score || 0,
      strongMatches: Array.isArray(fullJobData.strong_matches) ? JSON.stringify(fullJobData.strong_matches) : (fullJobData.strong_matches || null),
      missingSkills: Array.isArray(fullJobData.missing_skills) ? JSON.stringify(fullJobData.missing_skills) : (fullJobData.missing_skills || null),
      matchSummary: fullJobData.match_summary || null,
      resumeText,
    };

    const savedJob = existing
      ? await prisma.savedJobResult.update({ where: { id: existing.id }, data: savedData })
      : await prisma.savedJobResult.create({ data: savedData });

    const mapJob = (j) => ({
      id: j.id,
      job_apply_link: j.applyLink,
      employer_name: j.employerName,
      job_title: j.jobTitle,
      job_city: j.jobCity,
      job_state: j.jobState,
      job_country: j.jobCountry,
      job_employment_type: j.employmentType,
      employer_logo: j.employerLogo,
      source: j.source,
      posted: j.postedAt,
      jd: j.jd,
      match_score: j.matchScore,
      strong_matches: j.strongMatches,
      missing_skills: j.missingSkills,
      match_summary: j.matchSummary,
      resume_text: j.resumeText,
      candidate_name: student.fullName,
    });

    res.json({ message: 'ATS resume generated successfully.', job: mapJob(savedJob) });
  } catch (error) {
    res.status(500).json({ message: 'Failed to generate resume', error: error.message });
  }
};
