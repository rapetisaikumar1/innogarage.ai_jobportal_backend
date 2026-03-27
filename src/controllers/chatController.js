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
    const receiver = await prisma.user.findUnique({ where: { id: receiverId }, select: { role: true } });
    const chatLink = receiver?.role === 'STUDENT' ? '/dashboard/chat' : receiver?.role === 'ADMIN' ? '/admin/chat' : '/superadmin/chat';
    await prisma.notification.create({
      data: {
        userId: receiverId,
        title: 'New Message',
        message: `${req.user.fullName} sent you a message`,
        type: 'CHAT_MESSAGE',
        link: chatLink,
      },
    });

    // Create notifications for @mentioned users (except receiver who already got one)
    const mentionMatches = (message || '').match(/@\[([^\]]+)\]/g);
    if (mentionMatches) {
      const mentionedNames = mentionMatches.map(m => m.slice(2, -1)); // extract names from @[Name]
      const mentionedUsers = await prisma.user.findMany({
        where: { fullName: { in: mentionedNames }, id: { notIn: [senderId, receiverId] }, isActive: true },
        select: { id: true, fullName: true },
      });
      if (mentionedUsers.length > 0) {
        await prisma.notification.createMany({
          data: mentionedUsers.map(u => ({
            userId: u.id,
            title: 'You were mentioned',
            message: `${req.user.fullName} mentioned you in a chat`,
            type: 'mention',
          })),
        });
      }
    }

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

    // If student, include ALL active admins (Marketing, HR, Proxy) + all super admins
    if (req.user.role === 'STUDENT') {
      const allStaff = await prisma.user.findMany({
        where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, isActive: true },
        select: { id: true },
      });
      allStaff.forEach(s => {
        if (!contactIds.includes(s.id)) contactIds.push(s.id);
      });
    }

    // If admin, include ALL active students + other admins/super admins
    if (req.user.role === 'ADMIN') {
      const allStudents = await prisma.user.findMany({
        where: { role: 'STUDENT', isActive: true },
        select: { id: true },
      });
      allStudents.forEach(s => {
        if (!contactIds.includes(s.id)) contactIds.push(s.id);
      });

      // Include other admins and super admins
      const staff = await prisma.user.findMany({
        where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, isActive: true, id: { not: userId } },
        select: { id: true },
      });
      staff.forEach(s => {
        if (!contactIds.includes(s.id)) contactIds.push(s.id);
      });
    }

    // If super admin, include all admins, other super admins, and all students
    if (req.user.role === 'SUPER_ADMIN') {
      const allUsers = await prisma.user.findMany({
        where: { role: { in: ['ADMIN', 'SUPER_ADMIN', 'STUDENT'] }, isActive: true, id: { not: userId } },
        select: { id: true },
      });
      allUsers.forEach(u => {
        if (!contactIds.includes(u.id)) contactIds.push(u.id);
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
        department: true,
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
