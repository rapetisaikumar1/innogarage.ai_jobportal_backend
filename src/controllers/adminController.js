const prisma = require('../config/database');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const {
  AVAILABLE_TECHNOLOGY_CATEGORIES,
  normalizeTechnologyName,
} = require('../constants/availableTechnologies');

const AVAILABLE_TECH_CATEGORY_ORDER = new Map(
  AVAILABLE_TECHNOLOGY_CATEGORIES.map((category, index) => [category, index])
);

const ANALYTICS_CACHE_TTL_MS = 15 * 1000;
const TECHNOLOGY_CACHE_TTL_MS = 30 * 1000;
const USER_LIST_CACHE_TTL_MS = 20 * 1000;
let analyticsCache = { expiresAt: 0, payload: null };
const availableTechnologiesCache = new Map();
const adminListCache = new Map();
const studentListCache = new Map();

const clearAvailableTechnologiesCache = () => availableTechnologiesCache.clear();
const clearAdminListCache = () => adminListCache.clear();
const clearStudentListCache = () => studentListCache.clear();

const getCachedListPayload = (cache, key) => {
  const cached = cache.get(key);
  if (!cached || Date.now() >= cached.expiresAt) {
    cache.delete(key);
    return null;
  }
  return cached.payload;
};

const setCachedListPayload = (cache, key, payload) => {
  cache.set(key, {
    payload,
    expiresAt: Date.now() + USER_LIST_CACHE_TTL_MS,
  });
};

const sortAvailableTechnologies = (technologies = []) => {
  return [...technologies].sort((left, right) => {
    const categoryOrderDiff =
      (AVAILABLE_TECH_CATEGORY_ORDER.get(left.category) ?? Number.MAX_SAFE_INTEGER) -
      (AVAILABLE_TECH_CATEGORY_ORDER.get(right.category) ?? Number.MAX_SAFE_INTEGER);

    if (categoryOrderDiff !== 0) return categoryOrderDiff;

    const sortOrderDiff = (left.sortOrder ?? 0) - (right.sortOrder ?? 0);
    if (sortOrderDiff !== 0) return sortOrderDiff;

    return left.name.localeCompare(right.name);
  });
};

const buildTechnologyUsageCounts = (students = []) => {
  const usageCounts = new Map();

  students.forEach((student) => {
    const studentValues = new Set();
    const normalizedRole = normalizeTechnologyName(student.jobRole || '');

    if (normalizedRole) {
      studentValues.add(normalizedRole);
    }

    (student.keySkills || []).forEach((skill) => {
      const normalizedSkill = normalizeTechnologyName(skill || '');
      if (normalizedSkill) {
        studentValues.add(normalizedSkill);
      }
    });

    studentValues.forEach((value) => {
      usageCounts.set(value, (usageCounts.get(value) || 0) + 1);
    });
  });

  return usageCounts;
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

    clearAdminListCache();

    res.status(201).json(admin);
  } catch (error) {
    res.status(500).json({ message: 'Failed to create admin', error: error.message });
  }
};

// Get all admins
exports.getAdmins = async (req, res) => {
  try {
    const summary = req.query.summary === 'true';
    const cacheKey = JSON.stringify({ summary });
    const cachedAdmins = getCachedListPayload(adminListCache, cacheKey);

    if (cachedAdmins) {
      return res.json(cachedAdmins);
    }

    const admins = await prisma.user.findMany({
      where: { role: 'ADMIN' },
      select: summary
        ? {
            id: true,
            fullName: true,
            email: true,
            isActive: true,
          }
        : {
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

    setCachedListPayload(adminListCache, cacheKey, admins);

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

    clearAdminListCache();

    res.json(updated);
  } catch (error) {
    res.status(500).json({ message: 'Failed to toggle admin status', error: error.message });
  }
};

// Update admin details and optional credentials
exports.updateAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { fullName, email, phone, password } = req.body;

    const admin = await prisma.user.findUnique({ where: { id } });
    if (!admin || admin.role !== 'ADMIN') {
      return res.status(404).json({ message: 'Admin not found' });
    }

    if (!fullName || !email) {
      return res.status(400).json({ message: 'Full name and email are required' });
    }

    if (email !== admin.email) {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing && existing.id !== id) {
        return res.status(409).json({ message: 'Email already registered' });
      }
    }

    const data = {
      fullName,
      email,
      phone: phone || null,
    };

    if (password) {
      data.password = await bcrypt.hash(password, 12);
    }

    const updated = await prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
        mentorBio: true,
        createdAt: true,
        _count: {
          select: { assignedStudents: true, mentoringSlots: true },
        },
      },
    });

    clearAdminListCache();

    res.json(updated);
  } catch (error) {
    res.status(500).json({ message: 'Failed to update admin', error: error.message });
  }
};

// ---- Student Management ----

// Get all students
exports.getStudents = async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const summary = req.query.summary === 'true';
    const pageNumber = parseInt(page, 10);
    const limitNumber = parseInt(limit, 10);
    const skip = (pageNumber - 1) * limitNumber;
    const cacheKey = JSON.stringify({
      search: search || '',
      page: pageNumber,
      limit: limitNumber,
      summary,
    });
    const cachedStudents = getCachedListPayload(studentListCache, cacheKey);

    if (cachedStudents) {
      return res.json(cachedStudents);
    }

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
        select: summary
          ? {
              id: true,
              registrationNumber: true,
              fullName: true,
              email: true,
              isActive: true,
              status: true,
              subscriptionPlan: true,
              assignedMentorId: true,
              assignedMentor: {
                select: { id: true, fullName: true },
              },
              adminAssignments: {
                select: {
                  id: true,
                  adminId: true,
                  admin: { select: { id: true, fullName: true } },
                },
                orderBy: { createdAt: 'asc' },
              },
              createdAt: true,
            }
          : {
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
                select: {
                  id: true,
                  adminId: true,
                  admin: { select: { id: true, fullName: true, email: true } },
                },
                orderBy: { createdAt: 'asc' },
              },
              createdAt: true,
              _count: {
                select: { bookings: true },
              },
            },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNumber,
      }),
      prisma.user.count({ where }),
    ]);

    const payload = {
      students,
      pagination: {
        page: pageNumber,
        limit: limitNumber,
        total,
        totalPages: Math.ceil(total / limitNumber),
      },
    };

    setCachedListPayload(studentListCache, cacheKey, payload);
    res.json(payload);
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
        status: true,
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
            admin: { select: { id: true, fullName: true, email: true } },
          },
        },
        createdAt: true,
        updatedAt: true,
        bookings: {
          include: { slot: { include: { mentor: { select: { id: true, fullName: true, email: true } } } } },
          orderBy: { createdAt: 'desc' },
        },
        trainingNotes: {
          select: { id: true, title: true, category: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        _count: {
          select: { bookings: true, trainingNotes: true },
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
    clearStudentListCache();
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

    clearStudentListCache();

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

    clearStudentListCache();

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

    clearStudentListCache();

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
      clearStudentListCache();
      return res.json({ message: `${studentIds.length} students unassigned from all admins` });
    }

    const mentor = await prisma.user.findUnique({ where: { id: mentorId } });
    if (!mentor || mentor.role !== 'ADMIN') {
      return res.status(404).json({ message: 'Admin not found' });
    }

    // For now, each student can only have one assigned admin.
    const results = [];
    for (const studentId of studentIds) {
      const existingAssignments = await prisma.studentAdminAssignment.findMany({
        where: { studentId },
        select: { adminId: true },
      });
      const existingCount = existingAssignments.length;
      const alreadyAssigned = existingAssignments.some((assignment) => assignment.adminId === mentorId);
      if (alreadyAssigned) {
        results.push({ studentId, status: 'already_assigned' });
        continue;
      }
      if (existingCount >= 1) {
        results.push({ studentId, status: 'limit_reached', message: 'Only one admin can be assigned per student' });
        continue;
      }

      await prisma.studentAdminAssignment.create({
        data: { studentId, adminId: mentorId },
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
    if (limited > 0) msg += `. ${limited} student(s) already have an admin assigned.`;

    clearStudentListCache();
    clearAdminListCache();

    res.json({ message: msg, results });
  } catch (error) {
    res.status(500).json({ message: 'Failed to assign admin', error: error.message });
  }
};

// ---- Analytics ----

exports.getAvailableTechnologies = async (req, res) => {
  try {
    const includeUsage = req.query.usage !== 'false';
    const cacheKey = includeUsage ? 'with-usage' : 'list-only';
    const cached = availableTechnologiesCache.get(cacheKey);

    if (cached && Date.now() < cached.expiresAt) {
      return res.json(cached.payload);
    }

    const technologies = await prisma.availableTechnology.findMany({
      select: {
        id: true,
        name: true,
        normalizedName: true,
        category: true,
        sortOrder: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!includeUsage) {
      const payload = sortAvailableTechnologies(technologies).map(({ normalizedName, ...technology }) => technology);
      availableTechnologiesCache.set(cacheKey, { payload, expiresAt: Date.now() + TECHNOLOGY_CACHE_TTL_MS });
      return res.json(payload);
    }

    const students = await prisma.user.findMany({
      where: { role: 'STUDENT' },
      select: {
        jobRole: true,
        keySkills: true,
      },
    });
    const usageCounts = buildTechnologyUsageCounts(students);
    const payload = sortAvailableTechnologies(technologies).map(({ normalizedName, ...technology }) => ({
      ...technology,
      usageCount: usageCounts.get(normalizedName) || 0,
    }));

    availableTechnologiesCache.set(cacheKey, { payload, expiresAt: Date.now() + TECHNOLOGY_CACHE_TTL_MS });
    res.json(payload);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch available technologies', error: error.message });
  }
};

exports.createAvailableTechnology = async (req, res) => {
  try {
    const rawName = typeof req.body?.name === 'string' ? req.body.name : '';
    const trimmedName = rawName.trim().replace(/\s+/g, ' ');
    const category = typeof req.body?.category === 'string' ? req.body.category.trim() : '';

    if (!trimmedName || !category) {
      return res.status(400).json({ message: 'Technology name and category are required' });
    }

    if (!AVAILABLE_TECHNOLOGY_CATEGORIES.includes(category)) {
      return res.status(400).json({ message: 'Invalid technology category' });
    }

    const normalizedName = normalizeTechnologyName(trimmedName);
    const existingTechnology = await prisma.availableTechnology.findUnique({
      where: { normalizedName },
      select: { id: true },
    });

    if (existingTechnology) {
      return res.status(409).json({ message: 'Technology already exists' });
    }

    const categoryOrder = await prisma.availableTechnology.aggregate({
      where: { category },
      _max: { sortOrder: true },
    });

    const technology = await prisma.availableTechnology.create({
      data: {
        name: trimmedName,
        normalizedName,
        category,
        sortOrder: (categoryOrder._max.sortOrder ?? 0) + 1,
      },
      select: {
        id: true,
        name: true,
        category: true,
        sortOrder: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.status(201).json({
      ...technology,
      usageCount: 0,
    });
    clearAvailableTechnologiesCache();
  } catch (error) {
    res.status(500).json({ message: 'Failed to create technology', error: error.message });
  }
};

exports.deleteAvailableTechnology = async (req, res) => {
  try {
    const { id } = req.params;
    const existingTechnology = await prisma.availableTechnology.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!existingTechnology) {
      return res.status(404).json({ message: 'Technology not found' });
    }

    await prisma.availableTechnology.delete({ where: { id } });
    clearAvailableTechnologiesCache();

    res.json({ message: 'Technology deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to delete technology', error: error.message });
  }
};

// Get platform analytics
exports.getAnalytics = async (req, res) => {
  try {
    if (analyticsCache.payload && Date.now() < analyticsCache.expiresAt) {
      return res.json(analyticsCache.payload);
    }

    const [
      totalStudents,
      totalAdmins,
      activeStudents,
      totalBookings,
      studentsWithoutMentor,
      completedBookings,
      totalMaterials,
    ] = await Promise.all([
      prisma.user.count({ where: { role: 'STUDENT' } }),
      prisma.user.count({ where: { role: 'ADMIN' } }),
      prisma.user.count({ where: { role: 'STUDENT', isActive: true } }),
      prisma.mentorBooking.count(),
      prisma.user.count({ where: { role: 'STUDENT', assignedMentorId: null, adminAssignments: { none: {} } } }),
      prisma.mentorBooking.count({ where: { status: 'COMPLETED' } }),
      prisma.trainingMaterial.count(),
    ]);

    const [studentsWithRole, recentStudents] = await Promise.all([
      prisma.user.findMany({
        where: { role: 'STUDENT', jobRole: { not: null } },
        select: { jobRole: true },
      }),
      prisma.user.findMany({
        where: { role: 'STUDENT' },
        select: {
          id: true,
          registrationNumber: true,
          fullName: true,
          email: true,
          createdAt: true,
          isActive: true,
          status: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
    ]);

    const technologyBreakdown = {};
    studentsWithRole.forEach(s => {
      const role = (s.jobRole || '').trim();
      if (role) {
        technologyBreakdown[role] = (technologyBreakdown[role] || 0) + 1;
      }
    });

    const payload = {
      totalStudents,
      totalAdmins,
      totalMentors: totalAdmins,
      activeStudents,
      totalBookings,
      studentsWithoutMentor,
      completedBookings,
      totalMaterials,
      recentStudents,
      technologyBreakdown,
    };

    analyticsCache = { payload, expiresAt: Date.now() + ANALYTICS_CACHE_TTL_MS };
    res.json(payload);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch analytics', error: error.message });
  }
};

// ---- Mentor's Student Management (Admin) ----

// Get mentor's assigned students
exports.getAssignedStudents = async (req, res) => {
  try {
    const students = await prisma.user.findMany({
      where: {
        role: 'STUDENT',
        OR: [
          { assignedMentorId: req.user.id },
          { adminAssignments: { some: { adminId: req.user.id } } },
        ],
      },
      select: {
        id: true,
        registrationNumber: true,
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
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(students);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch students', error: error.message });
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

    clearStudentListCache();
    clearAdminListCache();

    res.json({ message: 'Admin unassigned from student' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to unassign admin', error: error.message });
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

    res.json(assignments.map(a => ({ ...a.admin, assignedAt: a.createdAt })));
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch student admins', error: error.message });
  }
};

