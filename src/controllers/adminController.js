const prisma = require('../config/database');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const https = require('https');
const jsJobSearchService = require('../services/jsJobSearchService');

// Google Sheet config (shared with jobController)
const GOOGLE_SHEET_ID = '1oBInp6BCblszz6RWdmhok3tlsRUfKX8BoEYs5uB0j6g';
const GOOGLE_SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/export?format=csv&gid=0`;

function parseCSV(text) {
  const lines = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      lines.push(current); current = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (current || lines.length) { lines.push(current); current = ''; }
      if (lines.length) { if (!parseCSV._rows) parseCSV._rows = []; parseCSV._rows.push([...lines]); lines.length = 0; }
    } else { current += ch; }
  }
  if (current || lines.length) { lines.push(current); if (!parseCSV._rows) parseCSV._rows = []; parseCSV._rows.push([...lines]); }
  const rows = parseCSV._rows || [];
  parseCSV._rows = null;
  return rows;
}

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
      totalMentors,
      totalJobs,
      totalApplications,
      activeStudents,
      interviewsScheduled,
      offersReceived,
      totalBookings,
      rejectedApplications,
      studentsWithoutMentor,
      completedBookings,
    ] = await Promise.all([
      prisma.user.count({ where: { role: 'STUDENT' } }),
      prisma.user.count({ where: { role: 'ADMIN' } }),
      prisma.job.count({ where: { isActive: true } }),
      prisma.jobApplication.count(),
      prisma.user.count({ where: { role: 'STUDENT', isActive: true } }),
      prisma.jobApplication.count({ where: { status: 'INTERVIEW_SCHEDULED' } }),
      prisma.jobApplication.count({ where: { status: 'OFFER_RECEIVED' } }),
      prisma.mentorBooking.count(),
      prisma.jobApplication.count({ where: { status: 'REJECTED' } }),
      prisma.user.count({ where: { role: 'STUDENT', assignedMentorId: null } }),
      prisma.mentorBooking.count({ where: { status: 'COMPLETED' } }),
    ]);

    // Parallel: recent apps, status breakdown, technology breakdown
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [recentApplications, applicationsByStatus, studentsWithRole] = await Promise.all([
      prisma.jobApplication.groupBy({
        by: ['appliedAt'],
        where: { appliedAt: { gte: sevenDaysAgo } },
        _count: true,
      }),
      prisma.jobApplication.groupBy({
        by: ['status'],
        _count: true,
      }),
      prisma.user.findMany({
        where: { role: 'STUDENT', jobRole: { not: null } },
        select: { jobRole: true },
      }),
    ]);

    // Application status breakdown
    const statusBreakdown = {};
    applicationsByStatus.forEach(item => {
      statusBreakdown[item.status] = item._count;
    });

    // Technology/Role-wise candidate breakdown
    const technologyBreakdown = {};
    studentsWithRole.forEach(s => {
      const role = (s.jobRole || '').trim();
      if (role) {
        technologyBreakdown[role] = (technologyBreakdown[role] || 0) + 1;
      }
    });

    res.json({
      totalStudents,
      totalMentors,
      totalJobs,
      totalApplications,
      activeStudents,
      interviewsScheduled,
      offersReceived,
      totalBookings,
      rejectedApplications,
      studentsWithoutMentor,
      completedBookings,
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
          select: { jobApplications: true },
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

    const [totalApplied, interviewScheduled, rejected, offerReceived, totalJobs, manualPending, dbAdminApplied, sheetAdminApplied, sheetTotalApplied] = await Promise.all([
      prisma.jobApplication.count({ where: { userId: studentId, status: 'APPLIED' } }),
      prisma.jobApplication.count({ where: { userId: studentId, status: 'INTERVIEW_SCHEDULED' } }),
      prisma.jobApplication.count({ where: { userId: studentId, status: 'REJECTED' } }),
      prisma.jobApplication.count({ where: { userId: studentId, status: 'OFFER_RECEIVED' } }),
      prisma.job.count({ where: { isActive: true } }),
      prisma.job.count({
        where: {
          isActive: true,
          applicationType: 'MANUAL_APPLY',
          NOT: { applications: { some: { userId: studentId } } },
        },
      }),
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
        totalJobs,
        totalApplied: allDbApplied,
        interviewScheduled,
        rejected,
        offerReceived,
        manualPending,
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

// Get student's Google Sheet jobs
exports.getStudentSheetJobs = async (req, res) => {
  try {
    const { studentId } = req.params;

    const student = await prisma.user.findUnique({
      where: { id: studentId },
      select: { id: true, email: true, fullName: true, role: true },
    });
    if (!student || student.role !== 'STUDENT') {
      return res.status(404).json({ message: 'Student not found' });
    }

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

    const jobs = allJobs.filter(j =>
      j.candidate_id === studentId || j.candidate_email === student.email
    );

    res.json({ jobs });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch student sheet jobs', error: error.message });
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

// Trigger n8n job search on behalf of a student
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

    const days = parseInt(req.body.days) || 1;
    const JOB_SEARCH_MODE = process.env.JOB_SEARCH_MODE || 'js';

    // ─── JS Mode: Direct job search via free APIs ───
    if (JOB_SEARCH_MODE === 'js') {
      console.log(`[Admin Job Search] JS mode for student ${student.email}`);
      const results = await jsJobSearchService.searchJobs(student, days);
      return res.json({
        message: results.length > 0
          ? `Found ${results.length} matching jobs for ${student.fullName}!`
          : 'No jobs found. Try different keywords.',
        jobs: results,
        mode: 'js',
      });
    }

    // ─── N8N Mode ───
    const config = require('../config');
    if (!config.n8n.webhookUrl) return res.status(500).json({ message: 'N8N webhook not configured' });
    const axios = require('axios');
    const cheerio = require('cheerio');
    const crypto = require('crypto');
    const https = require('https');
    const n8nAxios = axios.create({ timeout: 60000, httpsAgent: new https.Agent({ family: 4 }) });

    // Fetch n8n form to discover fields
    const formPageUrl = config.n8n.webhookUrl.replace('/webhook/', '/form/');
    const formPageResp = await n8nAxios.get(formPageUrl);
    const $ = cheerio.load(formPageResp.data);

    const formFields = [];
    $('input, textarea, select').each((i, el) => {
      const name = $(el).attr('name');
      if (!name) return;
      const type = $(el).attr('type') || 'text';
      let label = '';
      const elId = $(el).attr('id');
      if (elId) label = $(`label[for="${elId}"]`).text().trim();
      if (!label) label = $(el).closest('label').text().trim();
      if (!label) label = $(el).closest('.form-group, .field, div').find('label').first().text().trim();
      formFields.push({ name, type, label: label.toLowerCase() });
    });

    const dataMap = [
      { keywords: ['candidate id', 'candidate_id', 'candidateid', 'id'], value: String(student.id) },
      { keywords: ['candidate_name', 'candidate name', 'name'], value: student.fullName || '' },
      { keywords: ['email', 'e-mail'], value: student.email || '' },
      { keywords: ['role', 'job role', 'jobrole'], value: student.jobRole || 'Software Developer' },
      { keywords: ['keywords', 'skills', 'key skills'], value: (student.keySkills || []).join(', ') },
      { keywords: ['location', 'city'], value: student.location || '' },
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
        const entry = dataMap[i];
        const matchTarget = (field.label + ' ' + field.name).toLowerCase();
        if (entry.keywords.some(kw => matchTarget.includes(kw))) {
          textFields[field.name] = entry.value;
          usedDataIndices.add(i);
          matched = true;
          break;
        }
      }
      if (!matched) {
        for (let i = 0; i < dataMap.length; i++) {
          if (!usedDataIndices.has(i)) {
            textFields[field.name] = dataMap[i].value;
            usedDataIndices.add(i);
            break;
          }
        }
      }
    }

    // Download student resume
    const fileFields = [];
    if (student.resumeUrl) {
      try {
        const resumeResp = await n8nAxios.get(student.resumeUrl, { responseType: 'arraybuffer' });
        const resumeBuffer = Buffer.from(resumeResp.data);
        const filename = student.resumeUrl.split('/').pop().split('?')[0] || 'resume.pdf';
        fileFields.push({ name: resumeFieldName, filename, contentType: 'application/pdf', data: resumeBuffer });
      } catch (dlErr) {
        console.warn('Could not download student resume:', dlErr.message);
      }
    }

    // Build multipart
    const boundary = '----FormBoundary' + crypto.randomBytes(8).toString('hex');
    const CRLF = '\r\n';
    const parts = [];
    for (const [name, value] of Object.entries(textFields)) {
      parts.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`));
    }
    for (const file of fileFields) {
      parts.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"${CRLF}Content-Type: ${file.contentType}${CRLF}${CRLF}`));
      parts.push(file.data);
      parts.push(Buffer.from(CRLF));
    }
    parts.push(Buffer.from(`--${boundary}--${CRLF}`));
    const body = Buffer.concat(parts);
    const contentType = `multipart/form-data; boundary=${boundary}`;

    const n8nResponse = await n8nAxios.post(formPageUrl, body, {
      headers: { 'Content-Type': contentType },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    });

    if (n8nResponse.status >= 400) {
      return res.status(502).json({ message: 'N8N workflow error' });
    }

    res.json({ message: `Job search triggered for ${student.fullName}. Jobs will appear shortly.` });
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

// Mark sheet job as applied on behalf of student
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
      // Update sheet job application status
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

exports.markSheetJobAppliedForStudent = async (req, res) => {
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
      update: { status: 'APPLIED', appliedMethod: 'MANUAL', appliedById: req.user.id, employerName, matchScore, jobTitle },
      create: { userId: studentId, jobLink, status: 'APPLIED', appliedMethod: 'MANUAL', appliedById: req.user.id, employerName, matchScore, jobTitle },
    });

    res.json({ message: 'Marked as applied for student', application });
  } catch (error) {
    res.status(500).json({ message: 'Failed to mark applied', error: error.message });
  }
};

// Get applied status for student's sheet jobs
exports.getStudentSheetAppliedStatus = async (req, res) => {
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
