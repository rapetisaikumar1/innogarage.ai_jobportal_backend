const prisma = require('../config/database');
const { uploadToCloudinary } = require('../services/cloudinaryService');

// Get all training materials
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

    const materials = await prisma.trainingMaterial.findMany({
      where,
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
    });

    if (!material) {
      return res.status(404).json({ message: 'Material not found' });
    }

    res.json(material);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch material', error: error.message });
  }
};

// Create training material (Super Admin)
exports.createMaterial = async (req, res) => {
  try {
    const { title, description, type, content, category, url } = req.body;
    let materialUrl = url;

    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, { folder: 'materials', resourceType: 'auto' });
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
      const result = await uploadToCloudinary(req.file.buffer, { folder: 'materials', resourceType: 'auto' });
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
