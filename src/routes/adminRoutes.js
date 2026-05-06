const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authenticate, authorize } = require('../middleware/auth');

// Super Admin routes
router.post('/super-admins', authenticate, authorize('SUPER_ADMIN'), adminController.createSuperAdmin);
router.post('/admins', authenticate, authorize('SUPER_ADMIN'), adminController.createAdmin);
router.get('/admins', authenticate, authorize('SUPER_ADMIN'), adminController.getAdmins);
router.patch('/admins/:id/toggle-status', authenticate, authorize('SUPER_ADMIN'), adminController.toggleAdminStatus);
router.patch('/admins/:id/department', authenticate, authorize('SUPER_ADMIN'), adminController.updateAdminDepartment);

router.get('/students', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), adminController.getStudents);
router.get('/students/reg/:regNumber', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), adminController.getStudentByRegNumber);
router.get('/students/:id', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), adminController.getStudentDetail);
router.delete('/students/:id', authenticate, authorize('SUPER_ADMIN'), adminController.deleteStudent);
router.patch('/students/:id/toggle-status', authenticate, authorize('SUPER_ADMIN'), adminController.toggleStudentStatus);
router.patch('/students/:id/plan', authenticate, authorize('SUPER_ADMIN'), adminController.updateStudentPlan);
router.post('/register-student', authenticate, authorize('SUPER_ADMIN'), adminController.registerStudent);
router.post('/assign-mentor', authenticate, authorize('SUPER_ADMIN'), adminController.assignMentor);
router.post('/unassign-admin', authenticate, authorize('SUPER_ADMIN'), adminController.unassignAdmin);
router.get('/students/:studentId/admins', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), adminController.getStudentAdmins);

router.get('/analytics', authenticate, authorize('SUPER_ADMIN'), adminController.getAnalytics);

// Admin (Mentor) routes
router.get('/my-students', authenticate, authorize('ADMIN'), adminController.getAssignedStudents);
router.get('/student-progress/:studentId', authenticate, authorize('ADMIN', 'SUPER_ADMIN'), adminController.getStudentProgress);

// Admin view-as-student routes
router.get('/students/:studentId/dashboard-data', authenticate, authorize('ADMIN', 'SUPER_ADMIN'), adminController.getStudentDashboardData);
router.get('/students/:studentId/applications', authenticate, authorize('ADMIN', 'SUPER_ADMIN'), adminController.getStudentApplications);
router.get('/students/:studentId/matched-jobs', authenticate, authorize('ADMIN', 'SUPER_ADMIN'), adminController.getStudentMatchedJobs);
router.get('/students/:studentId/external-applied-status', authenticate, authorize('ADMIN', 'SUPER_ADMIN'), adminController.getStudentExternalAppliedStatus);

// Admin act-on-behalf-of-student routes
router.post('/students/:studentId/trigger-job-search', authenticate, authorize('ADMIN', 'SUPER_ADMIN'), adminController.triggerStudentJobSearch);
router.post('/students/:studentId/apply-job', authenticate, authorize('ADMIN', 'SUPER_ADMIN'), adminController.applyJobForStudent);
router.post('/students/:studentId/mark-external-applied', authenticate, authorize('ADMIN', 'SUPER_ADMIN'), adminController.markExternalJobAppliedForStudent);
router.patch('/students/:studentId/application-status', authenticate, authorize('ADMIN', 'SUPER_ADMIN'), adminController.updateApplicationStatus);

module.exports = router;
