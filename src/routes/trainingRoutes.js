const express = require('express');
const router = express.Router();
const trainingController = require('../controllers/trainingController');
const { authenticate, authorize } = require('../middleware/auth');
const upload = require('../middleware/upload');

// Materials
router.get('/materials', authenticate, trainingController.getMaterials);
router.get('/materials/:id', authenticate, trainingController.getMaterial);
router.post('/materials', authenticate, authorize('SUPER_ADMIN'), upload.single('material'), trainingController.createMaterial);
router.put('/materials/:id', authenticate, authorize('SUPER_ADMIN'), upload.single('material'), trainingController.updateMaterial);
router.delete('/materials/:id', authenticate, authorize('SUPER_ADMIN'), trainingController.deleteMaterial);

// Notes
router.get('/notes', authenticate, trainingController.getMyNotes);
router.post('/notes', authenticate, trainingController.createNote);
router.put('/notes/:id', authenticate, trainingController.updateNote);
router.delete('/notes/:id', authenticate, trainingController.deleteNote);

module.exports = router;
