const jwt = require('jsonwebtoken');
const config = require('../config');
const prisma = require('../config/database');

// Small in-memory cache for authenticated user lookups.
// Keyed by userId; TTL is short so deactivations / role changes propagate quickly.
// Capped to prevent unbounded memory growth.
const USER_CACHE_TTL_MS = 60 * 1000;
const USER_CACHE_MAX_ENTRIES = 5000;
const userAuthCache = new Map();

const getCachedUser = (userId) => {
  const entry = userAuthCache.get(userId);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    userAuthCache.delete(userId);
    return null;
  }
  return entry.user;
};

const setCachedUser = (userId, user) => {
  if (userAuthCache.size >= USER_CACHE_MAX_ENTRIES) {
    // Evict oldest entry (Map preserves insertion order).
    const firstKey = userAuthCache.keys().next().value;
    if (firstKey !== undefined) userAuthCache.delete(firstKey);
  }
  userAuthCache.set(userId, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
};

const invalidateCachedUser = (userId) => {
  if (userId) userAuthCache.delete(userId);
};

const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1] || req.cookies?.token;

    if (!token) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const decoded = jwt.verify(token, config.jwt.secret);

    let user = getCachedUser(decoded.userId);
    if (!user) {
      user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          isActive: true,
          isEmailVerified: true,
        },
      });
      if (user) setCachedUser(decoded.userId, user);
    }

    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    if (!user.isActive) {
      invalidateCachedUser(user.id);
      return res.status(403).json({ message: 'Account is deactivated' });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired' });
    }
    if (error.name === 'JsonWebTokenError' || error.name === 'NotBeforeError') {
      return res.status(401).json({ message: 'Invalid token' });
    }

    return next(error);
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Insufficient permissions' });
    }

    next();
  };
};

module.exports = { authenticate, authorize, invalidateCachedUser };
