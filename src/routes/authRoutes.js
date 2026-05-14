const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const upload = require('../middleware/upload');

router.post('/signup', upload.single('resume'), authController.signup);
router.post('/login', authController.login);
router.post('/verify-login-otp', authController.verifyLoginOtp);
router.post('/resend-login-otp', authController.resendLoginOtp);
router.post('/google-login', authController.googleLogin);
router.get('/public-config', authController.getPublicConfig);
router.post('/complete-profile', authenticate, upload.single('resume'), authController.completeProfile);
router.get('/verify-email/:token', authController.verifyEmail);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password/:token', authController.resetPassword);
router.post('/refresh-token', authController.refreshToken);
router.get('/me', authenticate, authController.me);
router.post('/change-password', authenticate, authController.changePassword);
router.post('/logout', authenticate, authController.logout);

module.exports = router;
