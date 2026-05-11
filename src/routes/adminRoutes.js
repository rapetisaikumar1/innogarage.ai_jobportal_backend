const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const requestController = require('../controllers/requestController');
const jobController = require('../controllers/jobController');
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
router.post('/register-student', authenticate, authorize('SUPER_ADMIN'), adminController.registerStudent);
router.post('/assign-mentor', authenticate, authorize('SUPER_ADMIN'), adminController.assignMentor);
router.post('/unassign-admin', authenticate, authorize('SUPER_ADMIN'), adminController.unassignAdmin);
router.get('/students/:studentId/admins', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), adminController.getStudentAdmins);
router.get('/available-technologies', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), adminController.getAvailableTechnologies);
router.post('/available-technologies', authenticate, authorize('SUPER_ADMIN'), adminController.createAvailableTechnology);
router.delete('/available-technologies/:id', authenticate, authorize('SUPER_ADMIN'), adminController.deleteAvailableTechnology);
router.get('/requests', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), requestController.getRequests);
router.post('/requests', authenticate, authorize('ADMIN'), requestController.createRequest);
router.patch('/requests/:id/status', authenticate, authorize('SUPER_ADMIN'), requestController.updateRequestStatus);

router.get('/analytics', authenticate, authorize('SUPER_ADMIN'), adminController.getAnalytics);

// Admin (Mentor) routes
router.get('/my-students', authenticate, authorize('ADMIN'), adminController.getAssignedStudents);

// ── Admin: job pipeline on behalf of a student ────────────────────────────────
const adminStudentAuth = [authenticate, authorize('SUPER_ADMIN', 'ADMIN')];

// Stream live job search for a student (admin triggers)
router.get('/students/:studentId/jobs/search/stream', ...adminStudentAuth, jobController.streamJobSearch);

// Get student's saved job matches
router.get('/students/:studentId/jobs/matched', ...adminStudentAuth, jobController.getMatchedJobs);

// Get student's job search stats
router.get('/students/:studentId/jobs/stats', ...adminStudentAuth, jobController.getStats);

// Get student's daily usage info
router.get('/students/:studentId/jobs/usage', ...adminStudentAuth, jobController.getUsage);

// Mark a job as applied for a student (admin applies on student's behalf)
router.post('/students/:studentId/jobs/external/mark-applied', ...adminStudentAuth, jobController.markExternalApplied);

// Get student's external applied status list
router.get('/students/:studentId/jobs/external-applied-status', ...adminStudentAuth, jobController.getExternalAppliedStatus);

// Get student's formal job applications
router.get('/students/:studentId/jobs/applications', ...adminStudentAuth, jobController.getMyApplications);

// ATS resume generation for student
router.post('/students/:studentId/jobs/resume/generate', ...adminStudentAuth, jobController.generateResume);

// Save ATS resume for student
router.post('/students/:studentId/jobs/resume/save', ...adminStudentAuth, jobController.saveResume);

// On-demand match score
router.post('/students/:studentId/jobs/match-score', ...adminStudentAuth, jobController.getMatchScore);

module.exports = router;
