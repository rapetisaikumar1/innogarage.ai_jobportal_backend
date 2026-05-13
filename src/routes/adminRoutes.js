const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const jobController = require('../controllers/jobController');
const requestController = require('../controllers/requestController');
const { authenticate, authorize } = require('../middleware/auth');

// Super Admin routes
router.post('/super-admins', authenticate, authorize('SUPER_ADMIN'), adminController.createSuperAdmin);
router.post('/admins', authenticate, authorize('SUPER_ADMIN'), adminController.createAdmin);
router.get('/admins', authenticate, authorize('SUPER_ADMIN'), adminController.getAdmins);
router.patch('/admins/:id', authenticate, authorize('SUPER_ADMIN'), adminController.updateAdmin);
router.patch('/admins/:id/toggle-status', authenticate, authorize('SUPER_ADMIN'), adminController.toggleAdminStatus);

router.get('/students', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), adminController.getStudents);
router.get('/students/reg/:regNumber', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), adminController.getStudentByRegNumber);
router.get('/students/:id', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), adminController.getStudentDetail);
router.delete('/students/:id', authenticate, authorize('SUPER_ADMIN'), adminController.deleteStudent);
router.patch('/students/:id/toggle-status', authenticate, authorize('SUPER_ADMIN'), adminController.toggleStudentStatus);
router.patch('/students/:id/plan', authenticate, authorize('SUPER_ADMIN'), adminController.updateStudentPlan);
router.patch('/students/:id/technology', authenticate, authorize('SUPER_ADMIN'), adminController.updateStudentTechnology);
router.get('/students/:studentId/matched-jobs', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), jobController.getMatchedJobs);
router.get('/students/:studentId/stats', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), jobController.getStats);
router.get('/students/:studentId/your-jobs', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), jobController.getYourJobs);
router.get('/students/:studentId/your-jobs/stream', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), jobController.streamYourJobs);
router.post('/students/:studentId/your-jobs/:yourJobId/resume-generate', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), jobController.generateYourJobResume);
router.get('/students/:studentId/external-applied-status', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), jobController.getExternalAppliedStatus);
router.get('/students/:studentId/applications', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), jobController.getMyApplications);
router.patch('/students/:studentId/applications/:applicationId/status', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), jobController.updateApplicationStatus);
router.post('/students/:studentId/mark-external-viewed', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), jobController.markExternalViewed);
router.post('/students/:studentId/mark-external-applied', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), jobController.markExternalApplied);
router.get('/students/:studentId/search/stream', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), jobController.searchJobsStream);
router.post('/register-student', authenticate, authorize('SUPER_ADMIN'), adminController.registerStudent);
router.post('/assign-mentor', authenticate, authorize('SUPER_ADMIN'), adminController.assignMentor);
router.post('/unassign-admin', authenticate, authorize('SUPER_ADMIN'), adminController.unassignAdmin);
router.get('/students/:studentId/admins', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), adminController.getStudentAdmins);
router.get('/available-technologies', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), adminController.getAvailableTechnologies);
router.post('/available-technologies', authenticate, authorize('SUPER_ADMIN'), adminController.createAvailableTechnology);
router.patch('/available-technologies/:id', authenticate, authorize('SUPER_ADMIN'), adminController.updateAvailableTechnology);
router.delete('/available-technologies/:id', authenticate, authorize('SUPER_ADMIN'), adminController.deleteAvailableTechnology);
router.get('/requests', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), requestController.getRequests);
router.post('/requests', authenticate, authorize('ADMIN'), requestController.createRequest);
router.patch('/requests/:id/status', authenticate, authorize('SUPER_ADMIN'), requestController.updateRequestStatus);

router.get('/analytics', authenticate, authorize('SUPER_ADMIN'), adminController.getAnalytics);

// Admin (Mentor) routes
router.get('/my-students', authenticate, authorize('ADMIN'), adminController.getAssignedStudents);

module.exports = router;
