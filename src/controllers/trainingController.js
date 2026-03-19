const prisma = require('../config/database');
const { uploadToCloudinary } = require('../services/cloudinaryService');

// Get all training materials (admin/superadmin see all, students see only assigned)
exports.getMaterials = async (req, res) => {
  try {
    const { category, type, search } = req.query;
    const where = { isPublished: true };

    if (category) where.category = category;
    if (type) where.type = type;
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    // Students only see materials assigned to them
    if (req.user.role === 'STUDENT') {
      where.assignments = { some: { studentId: req.user.id } };
    }

    const materials = await prisma.trainingMaterial.findMany({
      where,
      include: {
        uploadedBy: { select: { id: true, fullName: true, role: true } },
        assignments: {
          include: { student: { select: { id: true, fullName: true, email: true } } }
        }
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(materials);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch materials', error: error.message });
  }
};

// Get single material
exports.getMaterial = async (req, res) => {
  try {
    const material = await prisma.trainingMaterial.findUnique({
      where: { id: req.params.id },
      include: {
        uploadedBy: { select: { id: true, fullName: true, role: true } },
        assignments: {
          include: { student: { select: { id: true, fullName: true, email: true } } }
        }
      },
    });

    if (!material) {
      return res.status(404).json({ message: 'Material not found' });
    }

    // Students can only access materials assigned to them
    if (req.user.role === 'STUDENT') {
      const isAssigned = material.assignments.some(a => a.studentId === req.user.id);
      if (!isAssigned) {
        return res.status(403).json({ message: 'Not assigned to you' });
      }
    }

    res.json(material);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch material', error: error.message });
  }
};

// Create training material (Super Admin / Admin)
exports.createMaterial = async (req, res) => {
  try {
    const { title, description, type, content, category, url } = req.body;
    let materialUrl = url;

    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, { folder: 'materials', resourceType: 'raw' });
      materialUrl = result.url;
    }

    const material = await prisma.trainingMaterial.create({
      data: {
        title,
        description,
        type,
        content,
        category,
        url: materialUrl,
        uploadedById: req.user.id,
      },
    });

    res.status(201).json(material);
  } catch (error) {
    res.status(500).json({ message: 'Failed to create material', error: error.message });
  }
};

// Update training material (Super Admin)
exports.updateMaterial = async (req, res) => {
  try {
    const { title, description, type, content, category, url, isPublished } = req.body;

    const updateData = {};
    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (type !== undefined) updateData.type = type;
    if (content !== undefined) updateData.content = content;
    if (category !== undefined) updateData.category = category;
    if (url !== undefined) updateData.url = url;
    if (isPublished !== undefined) updateData.isPublished = isPublished;

    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, { folder: 'materials', resourceType: 'raw' });
      updateData.url = result.url;
    }

    const material = await prisma.trainingMaterial.update({
      where: { id: req.params.id },
      data: updateData,
    });

    res.json(material);
  } catch (error) {
    res.status(500).json({ message: 'Failed to update material', error: error.message });
  }
};

// Download / proxy a training material file
exports.downloadMaterial = async (req, res) => {
  try {
    const material = await prisma.trainingMaterial.findUnique({ where: { id: req.params.id } });
    if (!material || !material.url) {
      return res.status(404).json({ message: 'Material not found' });
    }

    // Students can only download materials assigned to them
    if (req.user.role === 'STUDENT') {
      const assignment = await prisma.trainingAssignment.findFirst({
        where: { materialId: material.id, studentId: req.user.id },
      });
      if (!assignment) return res.status(403).json({ message: 'Not assigned to you' });
    }

    const https = require('https');
    https.get(material.url, (upstream) => {
      if (upstream.statusCode !== 200) {
        return res.status(502).json({ message: 'Failed to fetch file from storage' });
      }
      const ext = material.url.split('.').pop()?.split('?')[0] || 'pdf';
      const filename = `${material.title.replace(/[^a-zA-Z0-9_-]/g, '_')}.${ext}`;
      res.setHeader('Content-Type', upstream.headers['content-type'] || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      if (upstream.headers['content-length']) {
        res.setHeader('Content-Length', upstream.headers['content-length']);
      }
      upstream.pipe(res);
    }).on('error', () => {
      res.status(502).json({ message: 'Failed to fetch file from storage' });
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to download material', error: error.message });
  }
};

// Delete training material (Super Admin)
exports.deleteMaterial = async (req, res) => {
  try {
    await prisma.trainingMaterial.delete({
      where: { id: req.params.id },
    });
    res.json({ message: 'Material deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to delete material', error: error.message });
  }
};

// --- Training Notes (Student) ---

// Get my notes
exports.getMyNotes = async (req, res) => {
  try {
    const notes = await prisma.trainingNote.findMany({
      where: { userId: req.user.id },
      orderBy: { updatedAt: 'desc' },
    });
    res.json(notes);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch notes', error: error.message });
  }
};

// Create note
exports.createNote = async (req, res) => {
  try {
    const { title, content, category } = req.body;
    const note = await prisma.trainingNote.create({
      data: {
        userId: req.user.id,
        title,
        content,
        category,
      },
    });
    res.status(201).json(note);
  } catch (error) {
    res.status(500).json({ message: 'Failed to create note', error: error.message });
  }
};

// Update note
exports.updateNote = async (req, res) => {
  try {
    const { title, content, category } = req.body;
    const note = await prisma.trainingNote.update({
      where: { id: req.params.id },
      data: { title, content, category },
    });
    res.json(note);
  } catch (error) {
    res.status(500).json({ message: 'Failed to update note', error: error.message });
  }
};

// Delete note
exports.deleteNote = async (req, res) => {
  try {
    await prisma.trainingNote.delete({
      where: { id: req.params.id },
    });
    res.json({ message: 'Note deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to delete note', error: error.message });
  }
};

// --- Assignment endpoints ---

// Get students list for assignment (Admin sees their assigned students, Super Admin sees all)
exports.getStudentsForAssignment = async (req, res) => {
  try {
    const where = { role: 'STUDENT' };

    if (req.user.role === 'ADMIN') {
      where.assignedMentorId = req.user.id;
    }

    const students = await prisma.user.findMany({
      where,
      select: { id: true, fullName: true, email: true, registrationNumber: true, avatarUrl: true },
      orderBy: { fullName: 'asc' },
    });

    res.json(students);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch students', error: error.message });
  }
};

// Assign material to specific students
exports.assignMaterial = async (req, res) => {
  try {
    const { materialId } = req.params;
    const { studentIds } = req.body;

    if (!studentIds || !Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({ message: 'studentIds array is required' });
    }

    const material = await prisma.trainingMaterial.findUnique({ where: { id: materialId } });
    if (!material) {
      return res.status(404).json({ message: 'Material not found' });
    }

    // Create assignments (skip duplicates)
    const data = studentIds.map(studentId => ({
      materialId,
      studentId,
    }));

    await prisma.trainingAssignment.createMany({
      data,
      skipDuplicates: true,
    });

    // Return updated material with assignments
    const updated = await prisma.trainingMaterial.findUnique({
      where: { id: materialId },
      include: {
        assignments: {
          include: { student: { select: { id: true, fullName: true, email: true } } }
        }
      },
    });

    res.json(updated);
  } catch (error) {
    res.status(500).json({ message: 'Failed to assign material', error: error.message });
  }
};

// Unassign material from specific students
exports.unassignMaterial = async (req, res) => {
  try {
    const { materialId } = req.params;
    const { studentIds } = req.body;

    if (!studentIds || !Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({ message: 'studentIds array is required' });
    }

    await prisma.trainingAssignment.deleteMany({
      where: {
        materialId,
        studentId: { in: studentIds },
      },
    });

    const updated = await prisma.trainingMaterial.findUnique({
      where: { id: materialId },
      include: {
        assignments: {
          include: { student: { select: { id: true, fullName: true, email: true } } }
        }
      },
    });

    res.json(updated);
  } catch (error) {
    res.status(500).json({ message: 'Failed to unassign material', error: error.message });
  }
};
