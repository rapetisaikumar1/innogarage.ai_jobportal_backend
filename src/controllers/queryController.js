const prisma = require('../config/database');

// Student: Create a support query
const createQuery = async (req, res) => {
  try {
    const { subject, description, category, assignedToId } = req.body;

    if (!subject || !description) {
      return res.status(400).json({ message: 'Subject and description are required' });
    }

    // Validate assignedToId if provided
    if (assignedToId) {
      const assignee = await prisma.user.findUnique({
        where: { id: assignedToId },
        select: { role: true },
      });
      if (!assignee || (assignee.role !== 'ADMIN' && assignee.role !== 'SUPER_ADMIN')) {
        return res.status(400).json({ message: 'Invalid assignee' });
      }
    }

    const query = await prisma.supportQuery.create({
      data: {
        userId: req.user.id,
        subject,
        description,
        category: category || 'General',
        assignedToId: assignedToId || null,
      },
      include: {
        user: { select: { id: true, fullName: true, email: true } },
        assignedTo: { select: { id: true, fullName: true, role: true } },
      },
    });

    res.status(201).json(query);
  } catch (error) {
    console.error('Error creating query:', error);
    res.status(500).json({ message: 'Failed to create query' });
  }
};

// Student: Get own queries
const getMyQueries = async (req, res) => {
  try {
    const queries = await prisma.supportQuery.findMany({
      where: { userId: req.user.id },
      include: {
        assignedTo: { select: { id: true, fullName: true, role: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(queries);
  } catch (error) {
    console.error('Error fetching queries:', error);
    res.status(500).json({ message: 'Failed to fetch queries' });
  }
};

// Admin / Super Admin: Get queries (ADMIN sees only assigned-to-them, SUPER_ADMIN sees all)
const getAllQueries = async (req, res) => {
  try {
    const where = req.user.role === 'ADMIN' ? { assignedToId: req.user.id } : {};
    const queries = await prisma.supportQuery.findMany({
      where,
      include: {
        user: { select: { id: true, fullName: true, email: true, registrationNumber: true } },
        assignedTo: { select: { id: true, fullName: true, role: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(queries);
  } catch (error) {
    console.error('Error fetching all queries:', error);
    res.status(500).json({ message: 'Failed to fetch queries' });
  }
};

// Admin / Super Admin: Update query status, reply, and/or reassignment
const updateQuery = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, adminReply, assignedToId } = req.body;

    const data = {};

    if (status) {
      data.status = status === 'RESOLVED' ? 'CLOSED' : status;
    }

    if (adminReply !== undefined) {
      data.adminReply = adminReply || null;
    }

    if (assignedToId !== undefined) {
      if (assignedToId) {
        const assignee = await prisma.user.findUnique({
          where: { id: assignedToId },
          select: { role: true },
        });
        if (!assignee || (assignee.role !== 'ADMIN' && assignee.role !== 'SUPER_ADMIN')) {
          return res.status(400).json({ message: 'Invalid assignee' });
        }
      }
      data.assignedToId = assignedToId || null;
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ message: 'Nothing to update' });
    }

    const updated = await prisma.supportQuery.update({
      where: { id },
      data,
      include: {
        user: { select: { id: true, fullName: true, email: true, registrationNumber: true } },
        assignedTo: { select: { id: true, fullName: true, role: true } },
      },
    });

    res.json(updated);
  } catch (error) {
    console.error('Error updating query:', error);
    res.status(500).json({ message: 'Failed to update query' });
  }
};

// Admin / Super Admin: Get count of new (non-closed) queries
const getNewQueryCount = async (req, res) => {
  try {
    const since = req.query.since;
    const where = { status: { not: 'CLOSED' } };
    if (req.user.role === 'ADMIN') where.assignedToId = req.user.id;
    if (since) where.createdAt = { gt: new Date(since) };
    const count = await prisma.supportQuery.count({ where });
    res.json({ count });
  } catch (error) {
    console.error('Error fetching query count:', error);
    res.status(500).json({ message: 'Failed to fetch query count' });
  }
};

// Student: Get count of queries updated by admin since last seen
const getStudentQueryNotifCount = async (req, res) => {
  try {
    const since = req.query.since;
    const filter = {
      userId: req.user.id,
      OR: [
        { status: { not: 'OPEN' } },
        { adminReply: { not: null } },
      ],
    };
    if (since) {
      filter.updatedAt = { gt: new Date(since) };
    }
    const count = await prisma.supportQuery.count({ where: filter });
    res.json({ count });
  } catch (error) {
    console.error('Error fetching student query notif count:', error);
    res.status(500).json({ message: 'Failed to fetch notification count' });
  }
};

// Student: Get list of admins and super admins for query assignment
const getStaffList = async (req, res) => {
  try {
    const staff = await prisma.user.findMany({
      where: {
        role: { in: ['ADMIN', 'SUPER_ADMIN'] },
        isActive: true,
      },
      select: {
        id: true,
        fullName: true,
        role: true,
      },
      orderBy: { fullName: 'asc' },
    });
    res.json(staff);
  } catch (error) {
    console.error('Error fetching staff list:', error);
    res.status(500).json({ message: 'Failed to fetch staff list' });
  }
};

// Admin / Super Admin: Get query stats by status
const getQueryStats = async (req, res) => {
  try {
    const baseWhere = req.user.role === 'ADMIN' ? { assignedToId: req.user.id } : {};
    const [open, inProgress, closed, total] = await Promise.all([
      prisma.supportQuery.count({ where: { ...baseWhere, status: 'OPEN' } }),
      prisma.supportQuery.count({ where: { ...baseWhere, status: 'IN_PROGRESS' } }),
      prisma.supportQuery.count({ where: { ...baseWhere, status: 'CLOSED' } }),
      prisma.supportQuery.count({ where: baseWhere }),
    ]);
    res.json({ open, inProgress, closed, total });
  } catch (error) {
    console.error('Error fetching query stats:', error);
    res.status(500).json({ message: 'Failed to fetch query stats' });
  }
};

module.exports = { createQuery, getMyQueries, getAllQueries, updateQuery, getNewQueryCount, getStudentQueryNotifCount, getStaffList, getQueryStats };
