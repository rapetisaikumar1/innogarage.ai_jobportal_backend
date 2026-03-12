const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const { authenticate } = require('../middleware/auth');

router.get('/contacts', authenticate, chatController.getContacts);
router.get('/messages/:userId', authenticate, chatController.getMessages);
router.post('/messages', authenticate, chatController.sendMessage);

module.exports = router;
