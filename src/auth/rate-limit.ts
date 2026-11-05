import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { TooManyRequestsError } from './errors.js';

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_FAILURES = 5;

// Counts failed logins per IP + email. Mount it AFTER the body is validated, so req.body.email is a
// lowercased string and malformed requests do not count. Successful logins are not counted.
// Once over the limit, even the right password is refused until the window ends.
// ponytail: memory store, so counters reset on restart and are not shared across instances;
// swap in a Redis store when Redis arrives. `req.ip` is the socket address until `trust proxy` is
// set, so behind a reverse proxy all clients would share one counter per email.
export const loginLimiter = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  limit: LOGIN_MAX_FAILURES,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? '')}|${req.body.email}`,
  handler: (_req, _res, next) => next(new TooManyRequestsError()),
});
