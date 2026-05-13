const prisma = require('../config/database');

const QUERY_CACHE_TTL_MS = 15 * 1000;
const queryListCache = new Map();
const queryStatsCache = new Map();

const getCachedValue = (cache, key) => {
  const cached = cache.get(key);
  if (!cached || Date.now() >= cached.expiresAt) {
    cache.delete(key);
    return null;
  }
  return cached.payload;
};

const setCachedValue = (cache, key, payload) => {
  cache.set(key, {
    payload,
    expiresAt: Date.now() + QUERY_CACHE_TTL_MS,
  });
};

const clearQueryCaches = () => {
  queryListCache.clear();
  queryStatsCache.clear();
};

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

    // Send notification to relevant staff about the new query
    const staffUsers = await prisma.user.findMany({
      where: assignedToId
        ? { OR: [{ id: assignedToId }, { role: 'SUPER_ADMIN' }], isActive: true }
        : { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, isActive: true },
      select: { id: true, role: true },
    });
    if (staffUsers.length > 0) {
      await prisma.notification.createMany({
        data: staffUsers.map(s => ({
          userId: s.id,
          title: 'New Support Query',
          message: `${query.user.fullName} raised a query: "${subject}"`,
          type: 'query',
          link: s.role === 'ADMIN' ? '/admin/queries' : '/superadmin/queries',
        })),
      });
    }

    clearQueryCaches();

    res.status(201).json(query);
  } catch (error) {
    console.error('Error creating query:', error);
    res.status(500).json({ message: 'Failed to create query' });
  }
};

// Student: Get own queries
const getMyQueries = async (req, res) => {
  try {
    const cacheKey = `student:${req.user.id}:mine`;
    const cachedQueries = getCachedValue(queryListCache, cacheKey);
    if (cachedQueries) {
      return res.json(cachedQueries);
    }

    const queries = await prisma.supportQuery.findMany({
      where: { userId: req.user.id },
      include: {
        assignedTo: { select: { id: true, fullName: true, role: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    setCachedValue(queryListCache, cacheKey, queries);
    res.json(queries);
  } catch (error) {
    console.error('Error fetching queries:', error);
    res.status(500).json({ message: 'Failed to fetch queries' });
  }
};

// Admin / Super Admin: Get queries (ADMIN sees assigned and unassigned, SUPER_ADMIN sees all)
const getAllQueries = async (req, res) => {
  try {
    const parsedLimit = parseInt(req.query.limit, 10);
    const parsedPage = parseInt(req.query.page, 10);
    const limitNumber = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : null;
    const pageNumber = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
    const cacheKey = req.user.role === 'ADMIN'
      ? `admin:${req.user.id}:all:${pageNumber}:${limitNumber || 'all'}`
      : `super-admin:all:${pageNumber}:${limitNumber || 'all'}`;
    const cachedQueries = getCachedValue(queryListCache, cacheKey);
    if (cachedQueries) {
      return res.json(cachedQueries);
    }

    const where = req.user.role === 'ADMIN'
      ? { OR: [{ assignedToId: req.user.id }, { assignedToId: null }] }
      : {};
    const queries = await prisma.supportQuery.findMany({
      where,
      include: {
        user: { select: { id: true, fullName: true, email: true, registrationNumber: true } },
        assignedTo: { select: { id: true, fullName: true, role: true } },
      },
      orderBy: { createdAt: 'desc' },
      ...(limitNumber ? { skip: (pageNumber - 1) * limitNumber, take: limitNumber } : {}),
    });

    setCachedValue(queryListCache, cacheKey, queries);
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

    // Notify the student who raised the query about the update
    if (updated.userId) {
      const parts = [];
      if (status) parts.push(`status changed to ${(data.status || status).replace(/_/g, ' ')}`);
      if (adminReply) parts.push('admin replied');
      const msg = parts.length > 0 ? `Your query "${updated.subject}" — ${parts.join(', ')}.` : `Your query "${updated.subject}" was updated.`;
      await prisma.notification.create({
        data: {
          userId: updated.userId,
          title: 'Query Updated',
          message: msg,
          type: 'query',
          link: '/dashboard/help-support',
        },
      });
    }

    clearQueryCaches();

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
    if (req.user.role === 'ADMIN') where.OR = [{ assignedToId: req.user.id }, { assignedToId: null }];
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
    const cacheKey = req.user.role === 'ADMIN' ? `admin:${req.user.id}:stats` : 'super-admin:stats';
    const cachedStats = getCachedValue(queryStatsCache, cacheKey);
    if (cachedStats) {
      return res.json(cachedStats);
    }

    const baseWhere = req.user.role === 'ADMIN'
      ? { OR: [{ assignedToId: req.user.id }, { assignedToId: null }] }
      : {};

    const groupedStats = await prisma.supportQuery.groupBy({
      by: ['status'],
      where: baseWhere,
      _count: { _all: true },
    });

    const countsByStatus = groupedStats.reduce((acc, item) => {
      acc[item.status] = item._count._all;
      return acc;
    }, {});

    const payload = {
      open: countsByStatus.OPEN || 0,
      inProgress: countsByStatus.IN_PROGRESS || 0,
      closed: countsByStatus.CLOSED || 0,
      total: groupedStats.reduce((sum, item) => sum + item._count._all, 0),
    };

    setCachedValue(queryStatsCache, cacheKey, payload);
    res.json(payload);
  } catch (error) {
    console.error('Error fetching query stats:', error);
    res.status(500).json({ message: 'Failed to fetch query stats' });
  }
};

module.exports = { createQuery, getMyQueries, getAllQueries, updateQuery, getNewQueryCount, getStudentQueryNotifCount, getStaffList, getQueryStats };
