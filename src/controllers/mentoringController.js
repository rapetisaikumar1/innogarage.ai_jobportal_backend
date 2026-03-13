const prisma = require('../config/database');
const { sendMentoringConfirmationEmail } = require('../services/emailService');

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

// Book a mentoring slot (Student)
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
        status: 'CONFIRMED',
        slot: {
          startTime: { gte: dayStart, lt: dayEnd },
        },
      },
    });

    if (existingBooking) {
      return res.status(409).json({ message: 'You can only book one mentoring session per day' });
    }

    // Generate a Google Meet link placeholder
    const meetLink = `https://meet.google.com/maple-${Date.now().toString(36)}`;

    const [booking] = await prisma.$transaction([
      prisma.mentorBooking.create({
        data: {
          slotId,
          studentId,
          status: 'CONFIRMED',
          meetLink,
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

    // Send confirmation email
    const student = await prisma.user.findUnique({ where: { id: studentId } });
    await sendMentoringConfirmationEmail(student, slot.mentor, slot, meetLink);

    // Create notifications
    await Promise.all([
      prisma.notification.create({
        data: {
          userId: studentId,
          title: 'Mentoring Session Booked',
          message: `Session with ${slot.mentor.fullName} on ${new Date(slot.startTime).toLocaleDateString()}`,
          type: 'mentoring',
        },
      }),
      prisma.notification.create({
        data: {
          userId: slot.mentorId,
          title: 'New Booking',
          message: `${student.fullName} booked a session on ${new Date(slot.startTime).toLocaleDateString()}`,
          type: 'mentoring',
        },
      }),
    ]);

    res.status(201).json(booking);
  } catch (error) {
    res.status(500).json({ message: 'Booking failed', error: error.message });
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

// Cancel booking
exports.cancelBooking = async (req, res) => {
  try {
    const { id } = req.params;

    const booking = await prisma.mentorBooking.findUnique({
      where: { id },
      include: { slot: true },
    });

    if (!booking) return res.status(404).json({ message: 'Booking not found' });

    await prisma.$transaction([
      prisma.mentorBooking.update({
        where: { id },
        data: { status: 'CANCELLED' },
      }),
      prisma.mentoringSlot.update({
        where: { id: booking.slotId },
        data: { isBooked: false },
      }),
    ]);

    res.json({ message: 'Booking cancelled' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to cancel booking', error: error.message });
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
