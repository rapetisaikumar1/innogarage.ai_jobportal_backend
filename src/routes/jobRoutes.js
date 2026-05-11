/**
 * jobRoutes.js
 *
 * All routes are mounted under /api/jobs
 */

const express    = require('express');
const router     = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const ctrl = require('../controllers/jobController');

// ── Student routes (any authenticated user) ───────────────────────────────────

// Live job search — SSE stream
router.get('/search/stream', authenticate, ctrl.streamJobSearch);

// Saved matched jobs
router.get('/matched', authenticate, ctrl.getMatchedJobs);

// Dashboard stats
router.get('/stats', authenticate, ctrl.getStats);

// Daily search usage
router.get('/usage', authenticate, ctrl.getUsage);

// Mark a job as externally applied (self-apply)
router.post('/external/mark-applied', authenticate, ctrl.markExternalApplied);

// External applied list
router.get('/external-applied-status', authenticate, ctrl.getExternalAppliedStatus);

// On-demand JD vs resume match score
router.post('/match-score', authenticate, ctrl.getMatchScore);

// ATS-optimised resume generation
router.post('/resume/generate', authenticate, ctrl.generateResume);

// Save edited ATS resume
router.post('/resume/save', authenticate, ctrl.saveResume);

// Student's own formal applications
router.get('/applications/mine', authenticate, ctrl.getMyApplications);

// ── Admin-only routes ─────────────────────────────────────────────────────────

// All applications (admin view)
router.get(
  '/applications/all',
  authenticate,
  authorize('ADMIN', 'SUPERADMIN'),
  ctrl.getAllApplications,
);

// Update application status (admin)
router.patch(
  '/applications/:id/status',
  authenticate,
  authorize('ADMIN', 'SUPERADMIN'),
  ctrl.updateApplicationStatus,
);

module.exports = router;
