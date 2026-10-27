import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { generalLimiter } from './middleware/rateLimit.js';
import eventsRouter from './routes/events.js';
import healthRouter from './routes/health.js';
import rankingsRouter from './routes/rankings.js';
import playersRouter from './routes/players.js';
import setsRouter from './routes/sets.js';
import tournamentsRouter from './routes/tournaments.js';

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
// The tournament routes share the /api/events prefix and are mounted first, so
// `/tournament-availability` matches as a literal before the events router's
// `/:id` can take it. Anything they do not match falls through.
app.use('/api/events', tournamentsRouter);
app.use('/api/events', eventsRouter);
app.use('/api/health', healthRouter);
app.use('/api/rankings', rankingsRouter);
app.use('/api/players', playersRouter);
app.use('/api/sets', setsRouter);

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
