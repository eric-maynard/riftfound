import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { generalLimiter } from './middleware/rateLimit.js';
import eventsRouter from './routes/events.js';
import healthRouter from './routes/health.js';
import dropshipRouter from './routes/dropship.js';

const app = express();

// Trust proxy for correct IP behind CloudFront/load balancers/API Gateway
app.set('trust proxy', true);

// CORS configuration
// In Lambda mode, allow all origins since API Gateway handles CORS
const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
app.use(cors({
  origin: isLambda ? '*' : env.FRONTEND_URL,
  credentials: !isLambda,
}));

app.use(express.json());

// Rate limiting (100 req/min per IP) - skip in Lambda (API Gateway handles this)
if (!isLambda) {
  app.use('/api', generalLimiter);
}

// Routes
app.use('/api/events', eventsRouter);
app.use('/api/health', healthRouter);
app.use('/api/dropship', dropshipRouter);

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
