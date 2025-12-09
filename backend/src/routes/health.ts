import { Router, Request, Response } from 'express';
import { testConnection } from '../config/database.js';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  const dbHealthy = await testConnection();

  const status = dbHealthy ? 'healthy' : 'degraded';
  const statusCode = dbHealthy ? 200 : 503;

  res.status(statusCode).json({
    status,
    timestamp: new Date().toISOString(),
    services: {
      database: dbHealthy ? 'connected' : 'disconnected',
    },
  });
});

export default router;
