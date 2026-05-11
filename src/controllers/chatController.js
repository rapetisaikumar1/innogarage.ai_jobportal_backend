const prisma = require('../config/database');

const CHAT_CONTACTS_CACHE_TTL_MS = 15 * 1000;
const chatContactsCache = new Map();

const getCachedContacts = (userId) => {
  const cached = chatContactsCache.get(userId);
  if (!cached || Date.now() >= cached.expiresAt) {
    chatContactsCache.delete(userId);
    return null;
  }
  return cached.payload;
};

const setCachedContacts = (userId, payload) => {
  chatContactsCache.set(userId, {
    payload,
    expiresAt: Date.now() + CHAT_CONTACTS_CACHE_TTL_MS,
  });
};

const clearContactsCache = (...userIds) => {
  userIds.filter(Boolean).forEach((userId) => chatContactsCache.delete(userId));
};

const getAssignedAdminIdsForStudent = async (studentId) => {
  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: {
      assignedMentorId: true,
      adminAssignments: { select: { adminId: true } },
    },
  });

  const adminIds = [...new Set([
    ...(student?.adminAssignments || []).map((assignment) => assignment.adminId),
    ...(student?.assignedMentorId ? [student.assignedMentorId] : []),
  ])];

  if (adminIds.length === 0) return [];
  const activeAdmins = await prisma.user.findMany({
    where: { id: { in: adminIds }, role: 'ADMIN', isActive: true },
    select: { id: true },
  });
  return activeAdmins.map(admin => admin.id);
};

const getStudentIdsForAdmin = async (adminId) => {
  const students = await prisma.user.findMany({
    where: {
      role: 'STUDENT',
      isActive: true,
      OR: [
        { assignedMentorId: adminId },
        { adminAssignments: { some: { adminId } } },
      ],
    },
    select: { id: true },
  });

  return students.map((student) => student.id);
};

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

    clearContactsCache(currentUserId, userId);

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

    clearContactsCache(senderId, receiverId);

    res.status(201).json(chatMessage);
  } catch (error) {
    res.status(500).json({ message: 'Failed to send message', error: error.message });
  }
};

// Get chat contacts
exports.getContacts = async (req, res) => {
  try {
    const userId = req.user.id;
    const cachedContacts = getCachedContacts(userId);

    if (cachedContacts) {
      return res.json(cachedContacts);
    }

    // Get unique users this user has chatted with
    const [sentTo, receivedFrom] = await Promise.all([
      prisma.chatMessage.findMany({
        where: { senderId: userId },
        select: { receiverId: true },
        distinct: ['receiverId'],
      }),
      prisma.chatMessage.findMany({
        where: { receiverId: userId },
        select: { senderId: true },
        distinct: ['senderId'],
      }),
    ]);

    const contactIds = [...new Set([
      ...sentTo.map(m => m.receiverId),
      ...receivedFrom.map(m => m.senderId),
    ])];

    // If student, include assigned admins + all super admins
    if (req.user.role === 'STUDENT') {
      const assignedAdminIds = await getAssignedAdminIdsForStudent(userId);
      const allStaff = await prisma.user.findMany({
        where: {
          isActive: true,
          OR: [
            { role: 'SUPER_ADMIN' },
            { id: { in: assignedAdminIds } },
          ],
        },
        select: { id: true },
      });
      allStaff.forEach((staffUser) => {
        if (!contactIds.includes(staffUser.id)) contactIds.push(staffUser.id);
      });
    }

    // If admin, include assigned students + other admins/super admins
    if (req.user.role === 'ADMIN') {
      const assignedStudentIds = await getStudentIdsForAdmin(userId);
      assignedStudentIds.forEach((studentId) => {
        if (!contactIds.includes(studentId)) contactIds.push(studentId);
      });

      // Include other admins and super admins
      const staff = await prisma.user.findMany({
        where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, isActive: true, id: { not: userId } },
        select: { id: true },
      });
      staff.forEach((staffUser) => {
        if (!contactIds.includes(staffUser.id)) contactIds.push(staffUser.id);
      });
    }

    // If super admin, include all admins, other super admins, and all students
    if (req.user.role === 'SUPER_ADMIN') {
      const allUsers = await prisma.user.findMany({
        where: { role: { in: ['ADMIN', 'SUPER_ADMIN', 'STUDENT'] }, isActive: true, id: { not: userId } },
        select: { id: true },
      });
      allUsers.forEach((contactUser) => {
        if (!contactIds.includes(contactUser.id)) contactIds.push(contactUser.id);
      });
    }

    if (contactIds.length === 0) {
      setCachedContacts(userId, []);
      return res.json([]);
    }

    const contacts = await prisma.user.findMany({
      where: { id: { in: contactIds }, isActive: true },
      select: {
        id: true,
        fullName: true,
        email: true,
        avatarUrl: true,
        role: true,
        isActive: true,
      },
    });

    const unreadCounts = contactIds.length > 0
      ? await prisma.chatMessage.groupBy({
          by: ['senderId'],
          where: {
            receiverId: userId,
            isRead: false,
            senderId: { in: contactIds },
          },
          _count: { _all: true },
        })
      : [];

    const unreadCountBySenderId = new Map(
      unreadCounts.map((entry) => [entry.senderId, entry._count._all])
    );

    const contactsWithUnread = contacts.map((contact) => ({
      ...contact,
      unreadCount: unreadCountBySenderId.get(contact.id) || 0,
    }));

    setCachedContacts(userId, contactsWithUnread);

    res.json(contactsWithUnread);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch contacts', error: error.message });
  }
};
