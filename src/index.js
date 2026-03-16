const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const http = require('http');
const { Server } = require('socket.io');

const config = require('./config');
const errorHandler = require('./middleware/errorHandler');

// Route imports
const authRoutes = require('./routes/authRoutes');
const jobRoutes = require('./routes/jobRoutes');
const userRoutes = require('./routes/userRoutes');
const mentoringRoutes = require('./routes/mentoringRoutes');
const trainingRoutes = require('./routes/trainingRoutes');
const adminRoutes = require('./routes/adminRoutes');
const chatRoutes = require('./routes/chatRoutes');
const achieverRoutes = require('./routes/achieverRoutes');
const shoutboardRoutes = require('./routes/shoutboardRoutes');
const queryRoutes = require('./routes/queryRoutes');
const stripeRoutes = require('./routes/stripeRoutes');

const app = express();
const server = http.createServer(app);

// Allowed origins for CORS
const allowedOrigins = [
  config.frontendUrl,
  'https://www.innogarage.ai',
  'https://innogarage.ai',
  'https://maverickproject-finalise-1.vercel.app',
  'http://localhost:5173',
].filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
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
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Stripe webhook — must be before express.json() to receive raw body
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// Middleware
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors(corsOptions));
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Files are served from Cloudinary - no local static serving needed

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/users', userRoutes);
app.use('/api/mentoring', mentoringRoutes);
app.use('/api/training', trainingRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/achievers', achieverRoutes);
app.use('/api/shoutboard', shoutboardRoutes);
app.use('/api/queries', queryRoutes);
// Stripe routes (checkout + webhook)
app.use('/api/stripe', stripeRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    cloudinary: {
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME ? 'SET' : 'MISSING',
      api_key: process.env.CLOUDINARY_API_KEY ? 'SET' : 'MISSING',
      api_secret: process.env.CLOUDINARY_API_SECRET ? 'SET' : 'MISSING',
    },
  });
});

// Cloudinary test
app.get('/api/test-cloudinary', async (req, res) => {
  try {
    const cloudinary = require('cloudinary').v2;
    // Test with a tiny text file upload instead of admin API
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'gethired/test', resource_type: 'raw' },
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
server.listen(config.port, async () => {
  console.log(`Server running on port ${config.port} in ${config.nodeEnv} mode`);
  await seedSuperAdmin();
});

module.exports = { app, server, io };
