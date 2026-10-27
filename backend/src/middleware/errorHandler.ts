import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

export interface ApiError extends Error {
  statusCode?: number;
}

export function errorHandler(
  err: ApiError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error('Error:', err);

  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  // Whatever freshness the route asked for, an unhandled failure does not get
  // it. The routes' own 400s and 404s keep their `Cache-Control` on purpose -
  // "invalid scope" and "no tournament facts for this event" are deterministic
  // answers, and the second one is the common case for most events - but a
  // throw is a transient, and a transient pinned at the edge for an hour is a
  // small outage rather than a saving.
  res.setHeader('Cache-Control', 'no-store');

  res.status(statusCode).json({
    error: message,
    ...(env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Not Found' });
}
