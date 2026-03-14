const prisma = require('../config/database');

// Student: Create a support query
const createQuery = async (req, res) => {
  try {
    const { subject, description, category } = req.body;

    if (!subject || !description) {
      return res.status(400).json({ message: 'Subject and description are required' });
    }

    const query = await prisma.supportQuery.create({
      data: {
        userId: req.user.id,
        subject,
        description,
        category: category || 'General',
      },
      include: {
        user: { select: { id: true, fullName: true, email: true } },
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
      orderBy: { createdAt: 'desc' },
    });
    res.json(queries);
  } catch (error) {
    console.error('Error fetching queries:', error);
    res.status(500).json({ message: 'Failed to fetch queries' });
  }
};

// Super Admin: Get all queries
const getAllQueries = async (req, res) => {
  try {
    const queries = await prisma.supportQuery.findMany({
      include: {
        user: { select: { id: true, fullName: true, email: true, registrationNumber: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(queries);
  } catch (error) {
    console.error('Error fetching all queries:', error);
    res.status(500).json({ message: 'Failed to fetch queries' });
  }
};

// Super Admin: Update query status and reply
const updateQuery = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, adminReply } = req.body;

    if (!status) {
      return res.status(400).json({ message: 'Status is required' });
    }

    // Automatically close resolved queries
    const finalStatus = status === 'RESOLVED' ? 'CLOSED' : status;

    const updated = await prisma.supportQuery.update({
      where: { id },
      data: { status: finalStatus, adminReply: adminReply || null },
      include: {
        user: { select: { id: true, fullName: true, email: true, registrationNumber: true } },
      },
    });

    res.json(updated);
  } catch (error) {
    console.error('Error updating query:', error);
    res.status(500).json({ message: 'Failed to update query' });
  }
};

// Super Admin: Get count of new (non-closed) queries
const getNewQueryCount = async (req, res) => {
  try {
    const count = await prisma.supportQuery.count({
      where: { status: { not: 'CLOSED' } },
    });
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

module.exports = { createQuery, getMyQueries, getAllQueries, updateQuery, getNewQueryCount, getStudentQueryNotifCount };
