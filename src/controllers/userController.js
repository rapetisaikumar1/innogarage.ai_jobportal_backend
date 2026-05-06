const prisma = require('../config/database');
const { uploadToCloudinary } = require('../services/cloudinaryService');
const { PDFParse } = require('pdf-parse');

const parseResumePdfBuffer = async (buffer) => {
  const parser = new PDFParse({ data: buffer });
  try {
    const parsed = await parser.getText();
    return (parsed.text || '').trim();
  } finally {
    await parser.destroy();
  }
};

// Update user profile
exports.updateProfile = async (req, res) => {
  try {
    const { fullName, phone, linkedinProfile, education, experience, keySkills, jobRole, location } = req.body;

    console.log('=== updateProfile called ===');
    console.log('Content-Type:', req.headers['content-type']);
    console.log('req.body:', JSON.stringify(req.body));
    console.log('jobRole:', jobRole, '| location:', location);
    console.log('req.file:', req.file ? req.file.fieldname : 'none');

    const updateData = {};
    if (fullName) updateData.fullName = fullName;
    if (phone) updateData.phone = phone;
    if (linkedinProfile !== undefined) updateData.linkedinProfile = linkedinProfile;
    if (jobRole !== undefined) updateData.jobRole = jobRole;
    if (location !== undefined) updateData.location = location;
    if (education) updateData.education = education;
    if (experience) updateData.experience = experience;
    if (keySkills) {
      updateData.keySkills = Array.isArray(keySkills) ? keySkills : keySkills.split(',').map(s => s.trim());
    }

    console.log('updateData:', JSON.stringify(updateData));

    if (req.file) {
      if (req.file.fieldname === 'resume') {
        try {
          const result = await uploadToCloudinary(req.file.buffer, { folder: 'resumes', resourceType: 'raw' });
          updateData.resumeUrl = result.url;
          // Extract text only from PDF resumes
          const ext = require('path').extname(req.file.originalname).toLowerCase();
          if (ext === '.pdf') {
            try {
              const resumeText = await parseResumePdfBuffer(req.file.buffer);
              if (resumeText.length > 20) {
                updateData.parsedResumeText = resumeText.substring(0, 20000);
              }
            } catch { /* PDF parse failed — continue without text */ }
          }
        } catch (uploadErr) {
          return res.status(500).json({ message: 'Resume upload failed', error: uploadErr.message });
        }
      } else if (req.file.fieldname === 'avatar') {
        try {
          const result = await uploadToCloudinary(req.file.buffer, { folder: 'avatars', resourceType: 'image' });
          updateData.avatarUrl = result.url;
        } catch (uploadErr) {
          console.error('Cloudinary avatar upload error:', uploadErr);
          return res.status(500).json({ message: 'Avatar upload failed', error: uploadErr.message });
        }
      }
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: updateData,
      select: {
        id: true,
        registrationNumber: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        linkedinProfile: true,
        education: true,
        experience: true,
        keySkills: true,
        jobRole: true,
        location: true,
        resumeUrl: true,
        parsedResumeText: true,
        avatarUrl: true,
        passportUrl: true,
        drivingLicenceUrl: true,
        visaUrl: true,
      },
    });

    res.json(user);
  } catch (error) {
    res.status(500).json({ message: 'Profile update failed', error: error.message });
  }
};

// Get user profile
exports.getProfile = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        registrationNumber: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        isEmailVerified: true,
        linkedinProfile: true,
        education: true,
        experience: true,
        keySkills: true,
        jobRole: true,
        location: true,
        resumeUrl: true,
        parsedResumeText: true,
        avatarUrl: true,
        passportUrl: true,
        drivingLicenceUrl: true,
        visaUrl: true,
        assignedMentorId: true,
        assignedMentor: {
          select: {
            id: true,
            fullName: true,
            email: true,
            mentorBio: true,
          },
        },
        createdAt: true,
      },
    });

    res.json(user);
  } catch (error) {
    res.status(500).json({ message: 'Failed to get profile', error: error.message });
  }
};

// Upload document (passport, driving licence, visa)
exports.uploadDocument = async (req, res) => {
  try {
    const { docType } = req.body;
    const validTypes = ['passport', 'drivingLicence', 'visa'];
    if (!validTypes.includes(docType)) {
      return res.status(400).json({ message: 'Invalid document type. Must be passport, drivingLicence, or visa' });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const result = await uploadToCloudinary(req.file.buffer, { folder: `documents/${docType}`, resourceType: 'image' });

    const fieldMap = {
      passport: 'passportUrl',
      drivingLicence: 'drivingLicenceUrl',
      visa: 'visaUrl',
    };

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { [fieldMap[docType]]: result.url },
      select: {
        id: true,
        passportUrl: true,
        drivingLicenceUrl: true,
        visaUrl: true,
      },
    });

    res.json(user);
  } catch (error) {
    res.status(500).json({ message: 'Document upload failed', error: error.message });
  }
};

// Get notifications
exports.getNotifications = async (req, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const unreadCount = await prisma.notification.count({
      where: { userId: req.user.id, isRead: false },
    });

    res.json({ notifications, unreadCount });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch notifications', error: error.message });
  }
};

// Mark notification as read
exports.markNotificationRead = async (req, res) => {
  try {
    await prisma.notification.update({
      where: { id: req.params.id },
      data: { isRead: true },
    });
    res.json({ message: 'Notification marked as read' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update notification', error: error.message });
  }
};

// Mark all notifications as read
exports.markAllNotificationsRead = async (req, res) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user.id, isRead: false },
      data: { isRead: true },
    });
    res.json({ message: 'All notifications marked as read' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update notifications', error: error.message });
  }
};
