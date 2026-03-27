const prisma = require('../config/database');
const { sendMentoringConfirmationEmail, sendBookingRequestEmail, sendBookingCancelledEmail } = require('../services/emailService');

// Get available mentoring slots
exports.getAvailableSlots = async (req, res) => {
  try {
    const { mentorId } = req.query;
    const where = {
      isBooked: false,
      startTime: { gt: new Date() },
    };
    if (mentorId) where.mentorId = mentorId;

    const slots = await prisma.mentoringSlot.findMany({
      where,
      include: {
        mentor: {
          select: { id: true, fullName: true, email: true, mentorBio: true },
        },
      },
      orderBy: { startTime: 'asc' },
    });

    res.json(slots);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch slots', error: error.message });
  }
};

// Create mentoring slots (Admin/Mentor only)
exports.createSlots = async (req, res) => {
  try {
    const { slots } = req.body; // Array of { startTime, endTime }
    const mentorId = req.user.id;

    const created = await Promise.all(
      slots.map(slot =>
        prisma.mentoringSlot.create({
          data: {
            mentorId,
            startTime: new Date(slot.startTime),
            endTime: new Date(slot.endTime),
          },
        })
      )
    );

    res.status(201).json({ message: 'Slots created', slots: created });
  } catch (error) {
    res.status(500).json({ message: 'Failed to create slots', error: error.message });
  }
};

// Book a mentoring slot (Student) — creates PENDING booking, admin must confirm
exports.bookSlot = async (req, res) => {
  try {
    const { slotId } = req.params;
    const studentId = req.user.id;

    const slot = await prisma.mentoringSlot.findUnique({
      where: { id: slotId },
      include: { mentor: true },
    });

    if (!slot) {
      return res.status(404).json({ message: 'Slot not found' });
    }

    if (slot.isBooked) {
      return res.status(409).json({ message: 'Slot is already booked' });
    }

    // Enforce one booking per day per student
    const slotDate = new Date(slot.startTime);
    const dayStart = new Date(slotDate.getFullYear(), slotDate.getMonth(), slotDate.getDate());
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const existingBooking = await prisma.mentorBooking.findFirst({
      where: {
        studentId,
        status: { in: ['CONFIRMED', 'PENDING'] },
        slot: {
          startTime: { gte: dayStart, lt: dayEnd },
        },
      },
    });

    if (existingBooking) {
      return res.status(409).json({ message: 'You can only book one mentoring session per day' });
    }

    const [booking] = await prisma.$transaction([
      prisma.mentorBooking.create({
        data: {
          slotId,
          studentId,
          status: 'PENDING',
        },
        include: {
          slot: {
            include: {
              mentor: { select: { id: true, fullName: true, email: true } },
            },
          },
        },
      }),
      prisma.mentoringSlot.update({
        where: { id: slotId },
        data: { isBooked: true },
      }),
    ]);

    const student = await prisma.user.findUnique({ where: { id: studentId } });

    // Notify mentor about new booking request
    await sendBookingRequestEmail(student, slot.mentor, slot);

    // Create notifications
    await Promise.all([
      prisma.notification.create({
        data: {
          userId: studentId,
          title: 'Booking Request Sent',
          message: `Your request for a session with ${slot.mentor.fullName} on ${new Date(slot.startTime).toLocaleDateString()} is pending confirmation.`,
          type: 'BOOKING_CREATED',
          link: '/dashboard/mentoring',
        },
      }),
      prisma.notification.create({
        data: {
          userId: slot.mentorId,
          title: 'New Booking Request',
          message: `New booking request received from ${student.fullName}`,
          type: 'BOOKING_CREATED',
          link: '/admin/bookings',
        },
      }),
    ]);

    res.status(201).json(booking);
  } catch (error) {
    res.status(500).json({ message: 'Booking failed', error: error.message });
  }
};

// Confirm a booking (Admin) — admin provides Google Meet link
exports.confirmBooking = async (req, res) => {
  try {
    const { id } = req.params;
    const { meetLink } = req.body;

    if (!meetLink) {
      return res.status(400).json({ message: 'Google Meet link is required' });
    }

    const booking = await prisma.mentorBooking.findUnique({
      where: { id },
      include: {
        slot: {
          include: {
            mentor: { select: { id: true, fullName: true, email: true } },
          },
        },
        student: { select: { id: true, fullName: true, email: true } },
      },
    });

    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.status !== 'PENDING') {
      return res.status(400).json({ message: `Cannot confirm a ${booking.status.toLowerCase()} booking` });
    }

    const updated = await prisma.mentorBooking.update({
      where: { id },
      data: { status: 'CONFIRMED', meetLink },
      include: {
        slot: {
          include: {
            mentor: { select: { id: true, fullName: true, email: true } },
          },
        },
        student: { select: { id: true, fullName: true, email: true } },
      },
    });

    // Send confirmation emails to both student and mentor
    await sendMentoringConfirmationEmail(booking.student, booking.slot.mentor, booking.slot, meetLink);

    // Notify both student and mentor
    await Promise.all([
      prisma.notification.create({
        data: {
          userId: booking.student.id,
          title: 'Session Confirmed!',
          message: `Your mentoring session on ${new Date(booking.slot.startTime).toLocaleDateString()} has been confirmed. Google Meet link is ready.`,
          type: 'BOOKING_CONFIRMED',
          link: '/dashboard/mentoring',
        },
      }),
      prisma.notification.create({
        data: {
          userId: booking.slot.mentor.id,
          title: 'Session Confirmed',
          message: `Your session with ${booking.student.fullName} on ${new Date(booking.slot.startTime).toLocaleDateString()} is confirmed.`,
          type: 'BOOKING_CONFIRMED',
          link: '/admin/bookings',
        },
      }),
    ]);

    res.json(updated);
  } catch (error) {
    res.status(500).json({ message: 'Failed to confirm booking', error: error.message });
  }
};

// Cancel booking (Admin or Student) — with optional reason
exports.cancelBooking = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const booking = await prisma.mentorBooking.findUnique({
      where: { id },
      include: {
        slot: {
          include: {
            mentor: { select: { id: true, fullName: true, email: true } },
          },
        },
        student: { select: { id: true, fullName: true, email: true } },
      },
    });

    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.status === 'CANCELLED') {
      return res.status(400).json({ message: 'Booking is already cancelled' });
    }

    const cancelledBy = req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN' ? 'admin' : 'student';
    const cancelNote = reason ? `Cancelled by ${cancelledBy}: ${reason}` : `Cancelled by ${cancelledBy}`;

    await prisma.$transaction([
      prisma.mentorBooking.update({
        where: { id },
        data: { status: 'CANCELLED', notes: cancelNote },
      }),
      prisma.mentoringSlot.update({
        where: { id: booking.slotId },
        data: { isBooked: false },
      }),
    ]);

    // Send cancellation email to the other party
    if (cancelledBy === 'admin') {
      await sendBookingCancelledEmail(booking.student, booking.slot.mentor, booking.slot, reason);
      await prisma.notification.create({
        data: {
          userId: booking.student.id,
          title: 'Session Cancelled',
          message: `Your mentoring session on ${new Date(booking.slot.startTime).toLocaleDateString()} was cancelled by the mentor.${reason ? ` Reason: ${reason}` : ''}`,
          type: 'BOOKING_CANCELLED',
          link: '/dashboard/mentoring',
        },
      });
    } else {
      await prisma.notification.create({
        data: {
          userId: booking.slot.mentorId,
          title: 'Booking Cancelled',
          message: `${booking.student.fullName} cancelled their session on ${new Date(booking.slot.startTime).toLocaleDateString()}.${reason ? ` Reason: ${reason}` : ''}`,
          type: 'BOOKING_CANCELLED',
          link: '/admin/bookings',
        },
      });
    }

    res.json({ message: 'Booking cancelled' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to cancel booking', error: error.message });
  }
};

// Get my bookings (Student)
exports.getMyBookings = async (req, res) => {
  try {
    const bookings = await prisma.mentorBooking.findMany({
      where: { studentId: req.user.id },
      include: {
        slot: {
          include: {
            mentor: { select: { id: true, fullName: true, email: true, mentorBio: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(bookings);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch bookings', error: error.message });
  }
};

// Get mentor's bookings (Mentor)
exports.getMentorBookings = async (req, res) => {
  try {
    const slots = await prisma.mentoringSlot.findMany({
      where: { mentorId: req.user.id },
      include: {
        booking: {
          include: {
            student: { select: { id: true, fullName: true, email: true, phone: true } },
          },
        },
      },
      orderBy: { startTime: 'desc' },
    });

    res.json(slots);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch bookings', error: error.message });
  }
};

// Get mentor's slots
exports.getMentorSlots = async (req, res) => {
  try {
    const slots = await prisma.mentoringSlot.findMany({
      where: { mentorId: req.user.id },
      include: {
        booking: {
          include: {
            student: { select: { id: true, fullName: true, email: true } },
          },
        },
      },
      orderBy: { startTime: 'asc' },
    });

    res.json(slots);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch slots', error: error.message });
  }
};

// Delete a slot (Mentor)
exports.deleteSlot = async (req, res) => {
  try {
    const { id } = req.params;

    const slot = await prisma.mentoringSlot.findUnique({
      where: { id },
      include: { booking: true },
    });

    if (!slot) return res.status(404).json({ message: 'Slot not found' });
    if (slot.mentorId !== req.user.id) return res.status(403).json({ message: 'Unauthorized' });
    if (slot.isBooked) return res.status(400).json({ message: 'Cannot delete a booked slot' });

    await prisma.mentoringSlot.delete({ where: { id } });
    res.json({ message: 'Slot deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to delete slot', error: error.message });
  }
};

// Get all mentors (for students to view)
exports.getMentors = async (req, res) => {
  try {
    const mentors = await prisma.user.findMany({
      where: { role: 'ADMIN', isActive: true },
      select: {
        id: true,
        fullName: true,
        email: true,
        mentorBio: true,
        avatarUrl: true,
      },
    });

    res.json(mentors);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch mentors', error: error.message });
  }
};
