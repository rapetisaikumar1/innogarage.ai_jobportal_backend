const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const http = require('http');
const { Server } = require('socket.io');

const config = require('./config');
const errorHandler = require('./middleware/errorHandler');

// Route imports
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const mentoringRoutes = require('./routes/mentoringRoutes');
const trainingRoutes = require('./routes/trainingRoutes');
const adminRoutes = require('./routes/adminRoutes');
const chatRoutes = require('./routes/chatRoutes');
const groupChatRoutes = require('./routes/groupChatRoutes');
const achieverRoutes = require('./routes/achieverRoutes');
const shoutboardRoutes = require('./routes/shoutboardRoutes');
const queryRoutes = require('./routes/queryRoutes');
const stripeRoutes = require('./routes/stripeRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const jobRoutes = require('./routes/jobRoutes');

const app = express();
const server = http.createServer(app);

// Allowed origins for CORS
const allowedOrigins = [
  config.frontendUrl,
  'https://www.innogarage.ai',
  'https://innogarage.ai',
  'https://maverickproject-finalise-1.vercel.app',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
].filter(Boolean);

const isLocalDevOrigin = (origin = '') => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
const isVercelOrigin = (origin = '') => /^https:\/\/[a-zA-Z0-9-]+(\.vercel\.app)$/.test(origin);

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  return allowedOrigins.includes(origin) || isLocalDevOrigin(origin) || isVercelOrigin(origin);
};

const corsOptions = {
  origin: function (origin, callback) {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
};

// Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Stripe webhook — must be before express.json() to receive raw body
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// Trust first proxy (Render/Vercel/Railway) for correct req.ip + secure cookies
app.set('trust proxy', 1);

// Middleware
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(compression());
app.use(cors(corsOptions));
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb', parameterLimit: 1000 }));
app.use(cookieParser());

// Rate limit auth endpoints (login/signup/OTP) to mitigate brute-force / abuse
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100, // 100 requests / 15 min / IP across auth endpoints
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many authentication attempts. Please try again later.' },
});

// Files are served from Cloudinary - no local static serving needed

const getHealthPayload = () => ({
  status: 'OK',
  service: 'Innogarage Platform Backend',
  timestamp: new Date().toISOString(),
  environment: config.nodeEnv,
  cloudinary: {
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME ? 'SET' : 'MISSING',
    api_key: process.env.CLOUDINARY_API_KEY ? 'SET' : 'MISSING',
    api_secret: process.env.CLOUDINARY_API_SECRET ? 'SET' : 'MISSING',
  },
});

app.get('/', (req, res) => {
  res.json({
    ...getHealthPayload(),
    message: 'Backend API is running',
    health: '/api/health',
  });
});

app.get('/health', (req, res) => {
  res.json(getHealthPayload());
});

// API Routes
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/mentoring', mentoringRoutes);
app.use('/api/training', trainingRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/group-chat', groupChatRoutes);
app.use('/api/achievers', achieverRoutes);
app.use('/api/shoutboard', shoutboardRoutes);
app.use('/api/queries', queryRoutes);
// Stripe routes (checkout + webhook)
app.use('/api/stripe', stripeRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/jobs', jobRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json(getHealthPayload());
});

// Cloudinary test
app.get('/api/test-cloudinary', async (req, res) => {
  try {
    const cloudinary = require('cloudinary').v2;
    // Test with a tiny text file upload instead of admin API
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'innogarage/test', resource_type: 'raw' },
        (error, result) => {
          if (error) return reject(error);
          resolve(result);
        }
      );
      stream.end(Buffer.from('test'));
    });
    // Clean up test file
    await cloudinary.uploader.destroy(result.public_id, { resource_type: 'raw' });
    res.json({ status: 'OK', message: 'Cloudinary upload works!' });
  } catch (error) {
    res.status(500).json({ status: 'FAILED', error: error.message, name: error.name });
  }
});

// Socket.IO - Real-time chat
const connectedUsers = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('register', (userId) => {
    connectedUsers.set(userId, socket.id);
    console.log(`User ${userId} registered with socket ${socket.id}`);
  });

  socket.on('sendMessage', (data) => {
    const { receiverId, message, senderId, senderName } = data;
    const receiverSocket = connectedUsers.get(receiverId);
    
    if (receiverSocket) {
      io.to(receiverSocket).emit('newMessage', {
        senderId,
        senderName,
        message,
        createdAt: new Date().toISOString(),
      });
    }
  });

  socket.on('joinGroup', (groupId) => {
    socket.join(`group_${groupId}`);
  });

  socket.on('sendGroupMessage', (data) => {
    const { groupId } = data;
    // Broadcast to all group members in the room except sender
    socket.to(`group_${groupId}`).emit('newGroupMessage', data);
  });

  socket.on('typing', (data) => {
    const { receiverId, senderId } = data;
    const receiverSocket = connectedUsers.get(receiverId);
    if (receiverSocket) {
      io.to(receiverSocket).emit('userTyping', { senderId });
    }
  });

  socket.on('disconnect', () => {
    for (const [userId, socketId] of connectedUsers.entries()) {
      if (socketId === socket.id) {
        connectedUsers.delete(userId);
        break;
      }
    }
    console.log('User disconnected:', socket.id);
  });
});

// Error handler
app.use(errorHandler);

// Seed super admin on startup
const seedSuperAdmin = async () => {
  const prisma = require('./config/database');
  const bcrypt = require('bcryptjs');
  
  try {
    const existing = await prisma.user.findUnique({
      where: { email: config.superAdmin.email },
    });

    if (!existing) {
      const hashedPassword = await bcrypt.hash(config.superAdmin.password, 12);
      await prisma.user.create({
        data: {
          fullName: config.superAdmin.name,
          email: config.superAdmin.email,
          password: hashedPassword,
          role: 'SUPER_ADMIN',
          isActive: true,
          isEmailVerified: true,
        },
      });
      console.log('Super Admin account created');
    }
  } catch (error) {
    console.error('Error seeding super admin:', error.message);
  }
};

// Start server
const httpServer = server.listen(config.port, async () => {
  console.log(`Server running on port ${config.port} in ${config.nodeEnv} mode`);
  await seedSuperAdmin();
});

// Graceful shutdown — close HTTP, Socket.IO, and Prisma connections cleanly
let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — shutting down gracefully...`);
  const forceExit = setTimeout(() => {
    console.error('Forcing exit after shutdown timeout');
    process.exit(1);
  }, 10000);
  forceExit.unref();
  try {
    io.close();
    await new Promise((resolve) => httpServer.close(resolve));
    try { await require('./config/database').$disconnect(); } catch (_) {}
    clearTimeout(forceExit);
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    clearTimeout(forceExit);
    process.exit(1);
  }
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server, io };
