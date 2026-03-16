const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { authenticate } = require('../middleware/auth');
const upload = require('../middleware/upload');

router.get('/profile', authenticate, userController.getProfile);
router.put('/profile', authenticate, upload.single('resume'), userController.updateProfile);
router.put('/profile/avatar', authenticate, upload.single('avatar'), userController.updateProfile);
router.put('/profile/document', authenticate, upload.single('document'), userController.uploadDocument);
router.get('/notifications', authenticate, userController.getNotifications);
router.patch('/notifications/:id/read', authenticate, userController.markNotificationRead);
router.patch('/notifications/read-all', authenticate, userController.markAllNotificationsRead);

module.exports = router;
