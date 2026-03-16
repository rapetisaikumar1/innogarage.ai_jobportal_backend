const express = require('express');
const router = express.Router();
const jobController = require('../controllers/jobController');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/', authenticate, jobController.getJobs);
router.get('/sheet', authenticate, jobController.getGoogleSheetJobs);
router.get('/sheet/applied-status', authenticate, jobController.getSheetAppliedStatus);
router.get('/usage', authenticate, jobController.getUsage);
router.post('/sheet/mark-applied', authenticate, authorize('STUDENT'), jobController.markSheetJobApplied);
router.get('/extension-data', authenticate, jobController.getExtensionData);
router.post('/trigger-n8n', authenticate, authorize('STUDENT'), jobController.triggerN8nWorkflow);
router.post('/auto-apply-all', authenticate, authorize('STUDENT'), jobController.autoApplyAllSheetJobs);
router.post('/auto-apply', authenticate, authorize('STUDENT'), jobController.autoApplyToJob);
router.get('/stats', authenticate, jobController.getDashboardStats);
router.get('/applications/mine', authenticate, jobController.getMyApplications);
router.patch('/applications/:id/status', authenticate, jobController.updateApplicationStatus);
router.post('/scrape', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), jobController.scrapeJobs);
router.post('/sample', authenticate, authorize('SUPER_ADMIN'), jobController.addSampleJobs);
router.post('/easy-apply-all', authenticate, authorize('STUDENT'), jobController.easyApplyAll);
router.get('/:id', authenticate, jobController.getJob);
router.post('/:jobId/apply', authenticate, authorize('STUDENT'), jobController.applyForJob);
router.get('/:jobId/tailored-resume', authenticate, jobController.getTailoredResume);

module.exports = router;
