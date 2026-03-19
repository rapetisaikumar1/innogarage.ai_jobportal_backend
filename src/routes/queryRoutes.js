const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { createQuery, getMyQueries, getAllQueries, updateQuery, getNewQueryCount, getStudentQueryNotifCount, getStaffList, getQueryStats } = require('../controllers/queryController');

// Student endpoints
router.post('/', authenticate, authorize('STUDENT'), createQuery);
router.get('/mine', authenticate, authorize('STUDENT'), getMyQueries);
router.get('/staff', authenticate, authorize('STUDENT'), getStaffList);
router.get('/student-notifications', authenticate, authorize('STUDENT'), getStudentQueryNotifCount);

// Admin & Super Admin endpoints
router.get('/count', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), getNewQueryCount);
router.get('/stats', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), getQueryStats);
router.get('/staff-admin', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), getStaffList);
router.get('/all', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), getAllQueries);
router.patch('/:id', authenticate, authorize('SUPER_ADMIN', 'ADMIN'), updateQuery);

module.exports = router;
