const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});

// Warm up the Neon DB connection on startup to avoid cold-start timeouts
prisma.$connect()
  .then(() => console.log('Database connected successfully'))
  .catch((err) => console.error('Database connection failed (will retry on first query):', err.message));

module.exports = prisma;
