const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { getStories, createStory, deleteStory } = require('../controllers/achieverController');

router.get('/', authenticate, getStories);
router.post('/', authenticate, createStory);
router.delete('/:id', authenticate, deleteStory);

module.exports = router;
