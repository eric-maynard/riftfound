import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { closePool } from './config/database.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import eventsRouter from './routes/events.js';
import healthRouter from './routes/health.js';

const app = express();

// Middleware
app.use(cors({
  origin: env.FRONTEND_URL,
  credentials: true,
}));
app.use(express.json());

// Routes
app.use('/api/events', eventsRouter);
app.use('/api/health', healthRouter);

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

// Start server
const server = app.listen(env.PORT, () => {
  console.log(`🚀 Server running on port ${env.PORT}`);
  console.log(`📍 Environment: ${env.NODE_ENV}`);
});

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`\n${signal} received, shutting down gracefully...`);

  server.close(async () => {
    console.log('HTTP server closed');
    await closePool();
    console.log('Database connections closed');
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    console.error('Forcing shutdown...');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
