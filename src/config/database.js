const { PrismaClient } = require('@prisma/client');
const config = require('./index');

const prisma = new PrismaClient({
  log: config.nodeEnv === 'development' ? ['error', 'warn'] : ['error'],
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});

let reconnectPromise = null;

const isRetryableConnectionError = (error) => {
  const message = String(error?.message || '').toLowerCase();
  return error?.code === 'P1017'
    || message.includes('server has closed the connection')
    || message.includes('connection') && message.includes('closed');
};

const reconnectPrisma = async () => {
  if (!reconnectPromise) {
    reconnectPromise = (async () => {
      try {
        await prisma.$disconnect();
      } catch {
        // Ignore disconnect failures during a reconnect attempt.
      }
      await prisma.$connect();
    })().finally(() => {
      reconnectPromise = null;
    });
  }

  return reconnectPromise;
};

const prismaWithRetry = prisma.$extends({
  query: {
    async $allOperations({ operation, model, args, query }) {
      try {
        return await query(args);
      } catch (error) {
        if (!isRetryableConnectionError(error)) {
          throw error;
        }

        console.warn(`Retrying Prisma ${model || 'raw'}.${operation} after connection closure`);
        await reconnectPrisma();
        return query(args);
      }
    },
  },
});

// Warm up the Neon DB connection on startup to avoid cold-start timeouts
prisma.$connect()
  .then(() => console.log('Database connected successfully'))
  .catch((err) => console.error('Database connection failed (will retry on first query):', err.message));

module.exports = prismaWithRetry;
