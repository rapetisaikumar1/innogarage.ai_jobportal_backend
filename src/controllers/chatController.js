const prisma = require('../config/database');

// Get chat messages between two users
exports.getMessages = async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user.id;

    const messages = await prisma.chatMessage.findMany({
      where: {
        OR: [
          { senderId: currentUserId, receiverId: userId },
          { senderId: userId, receiverId: currentUserId },
        ],
      },
      include: {
        sender: { select: { id: true, fullName: true, avatarUrl: true } },
        receiver: { select: { id: true, fullName: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Mark received messages as read
    await prisma.chatMessage.updateMany({
      where: {
        senderId: userId,
        receiverId: currentUserId,
        isRead: false,
      },
      data: { isRead: true },
    });

    res.json(messages);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch messages', error: error.message });
  }
};

// Send a message
exports.sendMessage = async (req, res) => {
  try {
    const { receiverId, message } = req.body;
    const senderId = req.user.id;

    const chatMessage = await prisma.chatMessage.create({
      data: {
        senderId,
        receiverId,
        message,
      },
      include: {
        sender: { select: { id: true, fullName: true, avatarUrl: true } },
        receiver: { select: { id: true, fullName: true, avatarUrl: true } },
      },
    });

    // Create notification for receiver
    await prisma.notification.create({
      data: {
        userId: receiverId,
        title: 'New Message',
        message: `${req.user.fullName} sent you a message`,
        type: 'message',
      },
    });

    res.status(201).json(chatMessage);
  } catch (error) {
    res.status(500).json({ message: 'Failed to send message', error: error.message });
  }
};

// Get chat contacts
exports.getContacts = async (req, res) => {
  try {
    const userId = req.user.id;

    // Get unique users this user has chatted with
    const sentTo = await prisma.chatMessage.findMany({
      where: { senderId: userId },
      select: { receiverId: true },
      distinct: ['receiverId'],
    });

    const receivedFrom = await prisma.chatMessage.findMany({
      where: { receiverId: userId },
      select: { senderId: true },
      distinct: ['senderId'],
    });

    const contactIds = [...new Set([
      ...sentTo.map(m => m.receiverId),
      ...receivedFrom.map(m => m.senderId),
    ])];

    // If student, also include assigned mentor
    if (req.user.role === 'STUDENT') {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { assignedMentorId: true },
      });
      if (user?.assignedMentorId && !contactIds.includes(user.assignedMentorId)) {
        contactIds.push(user.assignedMentorId);
      }
    }

    // If mentor, include assigned students
    if (req.user.role === 'ADMIN') {
      const students = await prisma.user.findMany({
        where: { assignedMentorId: userId },
        select: { id: true },
      });
      students.forEach(s => {
        if (!contactIds.includes(s.id)) contactIds.push(s.id);
      });
    }

    const contacts = await prisma.user.findMany({
      where: { id: { in: contactIds } },
      select: {
        id: true,
        fullName: true,
        email: true,
        avatarUrl: true,
        role: true,
        isActive: true,
      },
    });

    // Add unread count for each contact
    const contactsWithUnread = await Promise.all(
      contacts.map(async (contact) => {
        const unreadCount = await prisma.chatMessage.count({
          where: {
            senderId: contact.id,
            receiverId: userId,
            isRead: false,
          },
        });
        return { ...contact, unreadCount };
      })
    );

    res.json(contactsWithUnread);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch contacts', error: error.message });
  }
};
