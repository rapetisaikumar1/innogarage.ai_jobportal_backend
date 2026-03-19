const express = require('express');
const router = express.Router();
const groupChatController = require('../controllers/groupChatController');
const { authenticate } = require('../middleware/auth');

router.get('/my-groups', authenticate, groupChatController.getMyGroups);
router.get('/:groupId/messages', authenticate, groupChatController.getGroupMessages);
router.post('/:groupId/messages', authenticate, groupChatController.sendGroupMessage);
router.get('/:groupId/members', authenticate, groupChatController.getGroupMembers);

module.exports = router;
