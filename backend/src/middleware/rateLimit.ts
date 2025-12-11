import rateLimit from 'express-rate-limit';

// Extract client IP from X-Forwarded-For (CloudFront) or req.ip
function getClientIp(req: { headers: { [key: string]: string | string[] | undefined }; ip?: string }): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || 'unknown';
}

// General rate limit for all API routes
export const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  limit: 100, // 100 requests per minute
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  keyGenerator: getClientIp,
  // Disable all validations - we handle X-Forwarded-For ourselves for CloudFront
  validate: false,
});

// Stricter rate limit for geocoding endpoints (hits external APIs)
export const geocodeLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  limit: 30, // 30 requests per minute
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many geocoding requests, please try again later.' },
  keyGenerator: getClientIp,
  // Disable all validations - we handle X-Forwarded-For ourselves for CloudFront
  validate: false,
});
