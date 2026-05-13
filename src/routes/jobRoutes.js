const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const ctrl = require('../controllers/jobController');

router.get('/matched', authenticate, ctrl.getMatchedJobs);
router.get('/your-jobs', authenticate, ctrl.getYourJobs);
router.get('/your-jobs/stream', authenticate, ctrl.streamYourJobs);
router.post('/your-jobs/:yourJobId/resume-generate', authenticate, ctrl.generateYourJobResume);
router.get('/stats', authenticate, ctrl.getStats);
router.get('/applications/mine', authenticate, ctrl.getMyApplications);
router.get('/external-applied-status', authenticate, ctrl.getExternalAppliedStatus);
router.post('/external/mark-viewed', authenticate, ctrl.markExternalViewed);
router.post('/external/mark-applied', authenticate, ctrl.markExternalApplied);
router.get('/search', authenticate, ctrl.searchJobs);
router.get('/search/stream', authenticate, ctrl.searchJobsStream);

module.exports = router;