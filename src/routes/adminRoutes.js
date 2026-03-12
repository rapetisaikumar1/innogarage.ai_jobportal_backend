const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authenticate, authorize } = require('../middleware/auth');

// Super Admin routes
router.post('/super-admins', authenticate, authorize('SUPER_ADMIN'), adminController.createSuperAdmin);
router.post('/admins', authenticate, authorize('SUPER_ADMIN'), adminController.createAdmin);
router.get('/admins', authenticate, authorize('SUPER_ADMIN'), adminController.getAdmins);
router.patch('/admins/:id/toggle-status', authenticate, authorize('SUPER_ADMIN'), adminController.toggleAdminStatus);

router.get('/students', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), adminController.getStudents);
router.get('/students/reg/:regNumber', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), adminController.getStudentByRegNumber);
router.get('/students/:id', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), adminController.getStudentDetail);
router.delete('/students/:id', authenticate, authorize('SUPER_ADMIN'), adminController.deleteStudent);
router.patch('/students/:id/toggle-status', authenticate, authorize('SUPER_ADMIN'), adminController.toggleStudentStatus);
router.post('/register-student', authenticate, authorize('SUPER_ADMIN'), adminController.registerStudent);
router.post('/assign-mentor', authenticate, authorize('SUPER_ADMIN'), adminController.assignMentor);

router.get('/analytics', authenticate, authorize('SUPER_ADMIN'), adminController.getAnalytics);

// Admin (Mentor) routes
router.get('/my-students', authenticate, authorize('ADMIN'), adminController.getAssignedStudents);
router.get('/student-progress/:studentId', authenticate, authorize('ADMIN', 'SUPER_ADMIN'), adminController.getStudentProgress);

module.exports = router;
