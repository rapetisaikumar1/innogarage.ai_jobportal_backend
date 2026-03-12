const prisma = require('../config/database');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

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
    const { fullName, email, password, mentorBio, phone } = req.body;

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
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
        mentorBio: true,
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
          education: true,
          experience: true,
          keySkills: true,
          resumeUrl: true,
          assignedMentorId: true,
          assignedMentor: {
            select: { id: true, fullName: true },
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

// Toggle student active status
exports.toggleStudentStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const student = await prisma.user.findUnique({ where: { id } });

    if (!student || student.role !== 'STUDENT') {
      return res.status(404).json({ message: 'Student not found' });
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { isActive: !student.isActive },
      select: { id: true, fullName: true, isActive: true },
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
      await prisma.user.updateMany({
        where: { id: { in: studentIds }, role: 'STUDENT' },
        data: { assignedMentorId: null },
      });
      return res.json({ message: `${studentIds.length} students unassigned from mentor` });
    }

    const mentor = await prisma.user.findUnique({ where: { id: mentorId } });
    if (!mentor || mentor.role !== 'ADMIN') {
      return res.status(404).json({ message: 'Mentor not found' });
    }

    await prisma.user.updateMany({
      where: { id: { in: studentIds }, role: 'STUDENT' },
      data: { assignedMentorId: mentorId },
    });

    res.json({ message: `${studentIds.length} students assigned to ${mentor.fullName}` });
  } catch (error) {
    res.status(500).json({ message: 'Failed to assign mentor', error: error.message });
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

    // Applications per day (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentApplications = await prisma.jobApplication.groupBy({
      by: ['appliedAt'],
      where: { appliedAt: { gte: sevenDaysAgo } },
      _count: true,
    });

    // Application status breakdown
    const applicationsByStatus = await prisma.jobApplication.groupBy({
      by: ['status'],
      _count: true,
    });
    const statusBreakdown = {};
    applicationsByStatus.forEach(item => {
      statusBreakdown[item.status] = item._count;
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
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch analytics', error: error.message });
  }
};

// ---- Mentor's Student Management (Admin) ----

// Get mentor's assigned students
exports.getAssignedStudents = async (req, res) => {
  try {
    const students = await prisma.user.findMany({
      where: { assignedMentorId: req.user.id, role: 'STUDENT' },
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

    // Only allow assigned mentor or super admin
    if (req.user.role === 'ADMIN' && student.assignedMentorId !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to view this student' });
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
