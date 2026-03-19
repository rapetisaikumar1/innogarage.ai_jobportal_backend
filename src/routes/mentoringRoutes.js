const express = require('express');
const router = express.Router();
const mentoringController = require('../controllers/mentoringController');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/slots', authenticate, mentoringController.getAvailableSlots);
router.get('/mentors', authenticate, mentoringController.getMentors);
router.post('/slots', authenticate, authorize('ADMIN'), mentoringController.createSlots);
router.get('/my-slots', authenticate, authorize('ADMIN'), mentoringController.getMentorSlots);
router.delete('/slots/:id', authenticate, authorize('ADMIN'), mentoringController.deleteSlot);
router.post('/book/:slotId', authenticate, authorize('STUDENT'), mentoringController.bookSlot);
router.patch('/bookings/:id/confirm', authenticate, authorize('ADMIN'), mentoringController.confirmBooking);
router.get('/my-bookings', authenticate, mentoringController.getMyBookings);
router.get('/mentor-bookings', authenticate, authorize('ADMIN'), mentoringController.getMentorBookings);
router.patch('/bookings/:id/cancel', authenticate, mentoringController.cancelBooking);

module.exports = router;
