const prisma = require('../config/database');

// Get all approved success stories
const getStories = async (req, res) => {
  try {
    const stories = await prisma.successStory.findMany({
      where: { isApproved: true },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            avatarUrl: true,
            registrationNumber: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(stories);
  } catch (error) {
    console.error('Error fetching stories:', error);
    res.status(500).json({ message: 'Failed to fetch stories' });
  }
};

// Create a success story
const createStory = async (req, res) => {
  try {
    const { jobTitle, company, story } = req.body;

    if (!jobTitle || !company || !story) {
      return res.status(400).json({ message: 'Job title, company, and story are required' });
    }

    const newStory = await prisma.successStory.create({
      data: {
        userId: req.user.id,
        jobTitle,
        company,
        story,
      },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            avatarUrl: true,
            registrationNumber: true,
          },
        },
      },
    });

    res.status(201).json(newStory);
  } catch (error) {
    console.error('Error creating story:', error);
    res.status(500).json({ message: 'Failed to create story' });
  }
};

// Delete own story
const deleteStory = async (req, res) => {
  try {
    const { id } = req.params;
    const story = await prisma.successStory.findUnique({ where: { id } });

    if (!story) {
      return res.status(404).json({ message: 'Story not found' });
    }

    if (story.userId !== req.user.id && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ message: 'Not authorized' });
    }

    await prisma.successStory.delete({ where: { id } });
    res.json({ message: 'Story deleted' });
  } catch (error) {
    console.error('Error deleting story:', error);
    res.status(500).json({ message: 'Failed to delete story' });
  }
};

module.exports = { getStories, createStory, deleteStory };
