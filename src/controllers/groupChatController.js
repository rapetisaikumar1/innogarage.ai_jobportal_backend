const prisma = require('../config/database');

const getAssignedAdminIdsForStudent = async (studentId) => {
  const [assignments, student] = await Promise.all([
    prisma.studentAdminAssignment.findMany({ where: { studentId }, select: { adminId: true } }),
    prisma.user.findUnique({ where: { id: studentId }, select: { assignedMentorId: true } }),
  ]);

  const adminIds = [...new Set([
    ...assignments.map(a => a.adminId),
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
  const [assignments, legacyStudents] = await Promise.all([
    prisma.studentAdminAssignment.findMany({ where: { adminId }, select: { studentId: true } }),
    prisma.user.findMany({ where: { role: 'STUDENT', isActive: true, assignedMentorId: adminId }, select: { id: true } }),
  ]);

  return [...new Set([...assignments.map(a => a.studentId), ...legacyStudents.map(s => s.id)])];
};

// Get or create the group chat for the current student
// Each student gets ONE group with super admins + their assigned admins
const ensureStudentGroup = async (studentId, studentName) => {
  // Fetch student for registration number
  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { registrationNumber: true, fullName: true },
  });
  const displayName = student?.fullName || studentName;
  const regNum = student?.registrationNumber || 'N/A';
  const groupName = `${displayName} @STUDENT @${regNum}`;

  let group = await prisma.chatGroup.findUnique({
    where: { studentId },
    include: { members: { include: { user: { select: { id: true, fullName: true, role: true } } } } },
  });

  if (!group) {
    const [assignedAdminIds, superAdmins] = await Promise.all([
      getAssignedAdminIdsForStudent(studentId),
      prisma.user.findMany({ where: { role: 'SUPER_ADMIN', isActive: true }, select: { id: true } }),
    ]);
    const memberIds = [
      studentId,
      ...assignedAdminIds,
      ...superAdmins.map(s => s.id),
    ];
    const uniqueMemberIds = [...new Set(memberIds)];

    group = await prisma.chatGroup.create({
      data: {
        name: groupName,
        studentId,
        members: {
          create: uniqueMemberIds.map(uid => ({ userId: uid })),
        },
      },
      include: { members: { include: { user: { select: { id: true, fullName: true, role: true } } } } },
    });
  } else {
    // Update group name if changed
    if (group.name !== groupName) {
      await prisma.chatGroup.update({ where: { id: group.id }, data: { name: groupName } });
    }
    const [assignedAdminIds, superAdmins] = await Promise.all([
      getAssignedAdminIdsForStudent(studentId),
      prisma.user.findMany({ where: { role: 'SUPER_ADMIN', isActive: true }, select: { id: true } }),
    ]);
    const shouldBeMembers = [
      studentId,
      ...assignedAdminIds,
      ...superAdmins.map(s => s.id),
    ];
    const uniqueShouldBe = [...new Set(shouldBeMembers)];
    const existingMemberIds = group.members.map(m => m.userId);
    const toAdd = uniqueShouldBe.filter(id => !existingMemberIds.includes(id));
    if (toAdd.length > 0) {
      await prisma.chatGroupMember.createMany({
        data: toAdd.map(uid => ({ groupId: group.id, userId: uid })),
        skipDuplicates: true,
      });
    }
    const staleAdminIds = group.members
      .filter(m => m.user?.role === 'ADMIN' && !assignedAdminIds.includes(m.userId))
      .map(m => m.userId);
    if (staleAdminIds.length > 0) {
      await prisma.chatGroupMember.deleteMany({
        where: { groupId: group.id, userId: { in: staleAdminIds } },
      });
    }
    // Re-fetch
    group = await prisma.chatGroup.findUnique({
      where: { id: group.id },
      include: { members: { include: { user: { select: { id: true, fullName: true, role: true } } } } },
    });
  }

  return group;
};

// GET /api/group-chat/my-groups — get all groups the user is a member of
exports.getMyGroups = async (req, res) => {
  try {
    const userId = req.user.id;
    const role = req.user.role;

    if (role === 'STUDENT') {
      // Student sees only their own group
      const group = await ensureStudentGroup(userId, req.user.fullName);
      const lastMsg = await prisma.groupMessage.findFirst({
        where: { groupId: group.id },
        orderBy: { createdAt: 'desc' },
        include: { sender: { select: { id: true, fullName: true } } },
      });
      const unreadCount = await prisma.groupMessage.count({
        where: { groupId: group.id, senderId: { not: userId }, isRead: false },
      });
      return res.json([{
        ...group,
        lastMessage: lastMsg ? `${lastMsg.sender.fullName}: ${lastMsg.message}` : null,
        lastMessageAt: lastMsg?.createdAt || group.createdAt,
        unreadCount,
      }]);
    }

    // Admin / Super Admin — see all relevant groups
    if (role === 'SUPER_ADMIN') {
      // Super admin sees ALL student groups — auto-create missing ones and ensure membership
      const allStudents = await prisma.user.findMany({
        where: { role: 'STUDENT', isActive: true },
        select: { id: true, fullName: true },
      });

      for (const student of allStudents) {
        await ensureStudentGroup(student.id, student.fullName);
      }
    } else if (role === 'ADMIN') {
      const assignedStudentIds = await getStudentIdsForAdmin(userId);
      const assignedStudents = assignedStudentIds.length > 0
        ? await prisma.user.findMany({
          where: { id: { in: assignedStudentIds }, role: 'STUDENT', isActive: true },
          select: { id: true, fullName: true },
        })
        : [];
      for (const student of assignedStudents) {
        await ensureStudentGroup(student.id, student.fullName);
      }

      const activeAssignedStudentIds = assignedStudents.map(student => student.id);
      const staleGroupWhere = { members: { some: { userId } } };
      if (activeAssignedStudentIds.length > 0) staleGroupWhere.studentId = { notIn: activeAssignedStudentIds };
      const staleGroups = await prisma.chatGroup.findMany({
        where: staleGroupWhere,
        select: { id: true },
      });
      if (staleGroups.length > 0) {
        await prisma.chatGroupMember.deleteMany({
          where: { userId, groupId: { in: staleGroups.map(g => g.id) } },
        });
      }
    }

    // Now fetch all groups this user is a member of
    const memberships = await prisma.chatGroupMember.findMany({
      where: { userId },
      include: {
        group: {
          include: {
            student: { select: { id: true, fullName: true, email: true, avatarUrl: true } },
            members: { include: { user: { select: { id: true, fullName: true, role: true, avatarUrl: true } } } },
          },
        },
      },
    });

    const groups = await Promise.all(
      memberships.map(async (m) => {
        const lastMsg = await prisma.groupMessage.findFirst({
          where: { groupId: m.groupId },
          orderBy: { createdAt: 'desc' },
          include: { sender: { select: { id: true, fullName: true } } },
        });
        const unreadCount = await prisma.groupMessage.count({
          where: { groupId: m.groupId, senderId: { not: userId }, isRead: false },
        });
        return {
          ...m.group,
          lastMessage: lastMsg ? `${lastMsg.sender.fullName}: ${lastMsg.message}` : null,
          lastMessageAt: lastMsg?.createdAt || m.group.createdAt,
          unreadCount,
        };
      })
    );

    res.json(groups);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch groups', error: error.message });
  }
};

// GET /api/group-chat/:groupId/messages
exports.getGroupMessages = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.user.id;

    // Verify membership
    const member = await prisma.chatGroupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    if (!member) return res.status(403).json({ message: 'Not a member of this group' });

    const messages = await prisma.groupMessage.findMany({
      where: { groupId },
      include: {
        sender: { select: { id: true, fullName: true, avatarUrl: true, role: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Mark messages as read (for unread count accuracy)
    await prisma.groupMessage.updateMany({
      where: { groupId, senderId: { not: userId }, isRead: false },
      data: { isRead: true },
    });

    res.json(messages);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch group messages', error: error.message });
  }
};

// POST /api/group-chat/:groupId/messages
exports.sendGroupMessage = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { message } = req.body;
    const senderId = req.user.id;

    // Verify membership
    const member = await prisma.chatGroupMember.findUnique({
      where: { groupId_userId: { groupId, userId: senderId } },
    });
    if (!member) return res.status(403).json({ message: 'Not a member of this group' });

    const msg = await prisma.groupMessage.create({
      data: { groupId, senderId, message },
      include: {
        sender: { select: { id: true, fullName: true, avatarUrl: true, role: true } },
      },
    });

    // Notify all other group members
    const members = await prisma.chatGroupMember.findMany({
      where: { groupId, userId: { not: senderId } },
      select: { userId: true },
    });

    if (members.length > 0) {
      // Fetch member roles to build correct chat links
      const memberUsers = await prisma.user.findMany({
        where: { id: { in: members.map(m => m.userId) } },
        select: { id: true, role: true },
      });
      const roleMap = Object.fromEntries(memberUsers.map(u => [u.id, u.role]));
      await prisma.notification.createMany({
        data: members.map(m => {
          const role = roleMap[m.userId];
          const link = role === 'STUDENT' ? '/dashboard/chat' : role === 'ADMIN' ? '/admin/chat' : '/superadmin/chat';
          return {
            userId: m.userId,
            title: 'Group Message',
            message: `${req.user.fullName} sent a message in group chat`,
            type: 'CHAT_MESSAGE',
            link,
          };
        }),
      });
    }

    // @mention notifications for users mentioned but not in the group (edge case) 
    // or highlighted mentions within the group
    const mentionMatches = (message || '').match(/@\[([^\]]+)\]/g);
    if (mentionMatches) {
      const mentionedNames = mentionMatches.map(m => m.slice(2, -1));
      const mentionedUsers = await prisma.user.findMany({
        where: { fullName: { in: mentionedNames }, id: { not: senderId }, isActive: true },
        select: { id: true },
      });
      const memberIds = members.map(m => m.userId);
      // Only create mention notifications for group members who were specifically @mentioned
      const mentionedMembers = mentionedUsers.filter(u => memberIds.includes(u.id));
      if (mentionedMembers.length > 0) {
        await prisma.notification.createMany({
          data: mentionedMembers.map(u => ({
            userId: u.id,
            title: 'You were mentioned',
            message: `${req.user.fullName} mentioned you in a group chat`,
            type: 'mention',
          })),
        });
      }
    }

    res.status(201).json(msg);
  } catch (error) {
    res.status(500).json({ message: 'Failed to send group message', error: error.message });
  }
};

// GET /api/group-chat/:groupId/members
exports.getGroupMembers = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.user.id;

    const member = await prisma.chatGroupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    if (!member) return res.status(403).json({ message: 'Not a member of this group' });

    const members = await prisma.chatGroupMember.findMany({
      where: { groupId },
      include: {
        user: { select: { id: true, fullName: true, email: true, avatarUrl: true, role: true } },
      },
    });

    res.json(members.map(m => m.user));
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch members', error: error.message });
  }
};
