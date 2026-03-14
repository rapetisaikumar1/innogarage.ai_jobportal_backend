const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { createQuery, getMyQueries, getAllQueries, updateQuery, getNewQueryCount, getStudentQueryNotifCount } = require('../controllers/queryController');

// Student endpoints
router.post('/', authenticate, authorize('STUDENT'), createQuery);
router.get('/mine', authenticate, authorize('STUDENT'), getMyQueries);
router.get('/student-notifications', authenticate, authorize('STUDENT'), getStudentQueryNotifCount);

// Super Admin endpoints
router.get('/count', authenticate, authorize('SUPER_ADMIN'), getNewQueryCount);
router.get('/all', authenticate, authorize('SUPER_ADMIN'), getAllQueries);
router.patch('/:id', authenticate, authorize('SUPER_ADMIN'), updateQuery);

module.exports = router;
