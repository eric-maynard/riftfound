import { env } from './config/env.js';
import { closePool } from './config/database.js';
import app from './app.js';

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
