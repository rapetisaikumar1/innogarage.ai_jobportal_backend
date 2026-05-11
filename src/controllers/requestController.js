const prisma = require('../config/database');
const { normalizeTechnologyName } = require('../constants/availableTechnologies');

const REQUEST_TITLE_OPTIONS = new Set(['ASSIGN']);
const REQUEST_STATUS_OPTIONS = new Set(['REQUEST_SENT', 'ACCEPTED', 'REJECTED']);
const REQUEST_LIST_CACHE_TTL_MS = 10 * 1000;
const requestListCache = new Map();

const getRequestCacheKey = (user) => (user.role === 'ADMIN' ? `admin:${user.id}` : 'super-admin:all');

const clearRequestListCache = (adminId) => {
  requestListCache.delete('super-admin:all');
  if (adminId) requestListCache.delete(`admin:${adminId}`);
};

const mapRequestPayload = (request) => ({
  id: request.id,
  title: request.title,
  studentFullName: request.studentFullName,
  registrationNumber: request.registrationNumber,
  technology: request.technology,
  status: request.status,
  reviewedAt: request.reviewedAt,
  createdAt: request.createdAt,
  updatedAt: request.updatedAt,
  admin: request.admin
    ? {
        id: request.admin.id,
        fullName: request.admin.fullName,
        email: request.admin.email,
      }
    : null,
  reviewedBy: request.reviewedBy
    ? {
        id: request.reviewedBy.id,
        fullName: request.reviewedBy.fullName,
        email: request.reviewedBy.email,
      }
    : null,
});

exports.getRequests = async (req, res) => {
  try {
    const where = req.user.role === 'ADMIN' ? { adminId: req.user.id } : {};
    const cacheKey = getRequestCacheKey(req.user);
    const cached = requestListCache.get(cacheKey);

    if (cached && Date.now() < cached.expiresAt) {
      return res.json(cached.payload);
    }

    const requests = await prisma.adminRequest.findMany({
      where,
      include: {
        admin: { select: { id: true, fullName: true, email: true } },
        reviewedBy: { select: { id: true, fullName: true, email: true } },
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });

    const payload = requests.map(mapRequestPayload);
    requestListCache.set(cacheKey, { payload, expiresAt: Date.now() + REQUEST_LIST_CACHE_TTL_MS });
    res.json(payload);
  } catch (error) {
    console.error('Error fetching admin requests:', error);
    res.status(500).json({ message: 'Failed to fetch requests' });
  }
};

exports.createRequest = async (req, res) => {
  try {
    const rawTitle = typeof req.body?.title === 'string' ? req.body.title : '';
    const rawStudentFullName = typeof req.body?.studentFullName === 'string' ? req.body.studentFullName : '';
    const rawRegistrationNumber = typeof req.body?.registrationNumber === 'string' ? req.body.registrationNumber : '';
    const rawTechnology = typeof req.body?.technology === 'string' ? req.body.technology : '';

    const title = rawTitle.trim().toUpperCase() || 'ASSIGN';
    const studentFullName = rawStudentFullName.trim().replace(/\s+/g, ' ');
    const registrationNumber = rawRegistrationNumber.trim().replace(/\s+/g, ' ');
    const normalizedTechnology = normalizeTechnologyName(rawTechnology);

    if (!REQUEST_TITLE_OPTIONS.has(title)) {
      return res.status(400).json({ message: 'Invalid request title' });
    }

    if (!studentFullName || !registrationNumber || !normalizedTechnology) {
      return res.status(400).json({ message: 'Student name, registration number, and technology are required' });
    }

    const availableTechnology = await prisma.availableTechnology.findUnique({
      where: { normalizedName: normalizedTechnology },
      select: { name: true },
    });

    if (!availableTechnology) {
      return res.status(400).json({ message: 'Invalid technology selected' });
    }

    const createdRequest = await prisma.adminRequest.create({
      data: {
        adminId: req.user.id,
        title,
        studentFullName,
        registrationNumber,
        technology: availableTechnology.name,
      },
      include: {
        admin: { select: { id: true, fullName: true, email: true } },
        reviewedBy: { select: { id: true, fullName: true, email: true } },
      },
    });

    clearRequestListCache(req.user.id);

    const superAdmins = await prisma.user.findMany({
      where: { role: 'SUPER_ADMIN', isActive: true },
      select: { id: true },
    });

    if (superAdmins.length > 0) {
      await prisma.notification.createMany({
        data: superAdmins.map((superAdmin) => ({
          userId: superAdmin.id,
          title: 'New Raise Request',
          message: `${req.user.fullName} sent an assign request for ${studentFullName} (${registrationNumber}).`,
          type: 'admin_request',
          link: '/superadmin/requests',
        })),
      });
    }

    res.status(201).json(mapRequestPayload(createdRequest));
  } catch (error) {
    console.error('Error creating admin request:', error);
    res.status(500).json({ message: 'Failed to create request' });
  }
};

exports.updateRequestStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const status = typeof req.body?.status === 'string' ? req.body.status.trim().toUpperCase() : '';

    if (!REQUEST_STATUS_OPTIONS.has(status) || status === 'REQUEST_SENT') {
      return res.status(400).json({ message: 'Invalid request status' });
    }

    const existingRequest = await prisma.adminRequest.findUnique({
      where: { id },
      include: {
        admin: { select: { id: true, fullName: true, email: true } },
        reviewedBy: { select: { id: true, fullName: true, email: true } },
      },
    });

    if (!existingRequest) {
      return res.status(404).json({ message: 'Request not found' });
    }

    if (existingRequest.status !== 'REQUEST_SENT') {
      return res.status(400).json({ message: 'Request has already been reviewed' });
    }

    const updatedRequest = await prisma.adminRequest.update({
      where: { id },
      data: {
        status,
        reviewedById: req.user.id,
        reviewedAt: new Date(),
      },
      include: {
        admin: { select: { id: true, fullName: true, email: true } },
        reviewedBy: { select: { id: true, fullName: true, email: true } },
      },
    });

    clearRequestListCache(updatedRequest.adminId);

    await prisma.notification.create({
      data: {
        userId: updatedRequest.adminId,
        title: `Request ${status === 'ACCEPTED' ? 'Accepted' : 'Rejected'}`,
        message: `Your assign request for ${updatedRequest.studentFullName} (${updatedRequest.registrationNumber}) was ${status === 'ACCEPTED' ? 'accepted' : 'rejected'}.`,
        type: 'admin_request',
        link: '/admin/raise-request',
      },
    });

    res.json(mapRequestPayload(updatedRequest));
  } catch (error) {
    console.error('Error updating admin request:', error);
    res.status(500).json({ message: 'Failed to update request' });
  }
};