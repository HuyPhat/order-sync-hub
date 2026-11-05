import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { TooManyRequestsError } from './errors.js';

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_FAILURES = 5;

// Counts failed logins (401s) per IP + email. Mount it AFTER the body is validated, so req.body.email is a
// lowercased string and malformed requests do not count. Successful logins are not counted.
// Once over the limit, even the right password is refused until the window ends.
// ponytail: memory store, so counters reset on restart and are not shared across instances;
// swap in a Redis store when Redis arrives. `req.ip` is the socket address until `trust proxy` is
// set, so behind a reverse proxy all clients would share one counter per email.
export const loginLimiter = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  limit: LOGIN_MAX_FAILURES,
  // Only a 401 is a failed login: a 400/429 is not, and a 5xx (database down) is not the user's
  // fault, so an outage must not lock people out.
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode !== 401,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? '')}|${req.body.email}`,
  handler: (_req, _res, next) => next(new TooManyRequestsError('Too many login attempts')),
});

// Every refresh call, per IP. A refresh inside the grace window inserts a new row, so without a
// cap a token holder could fill the table. Generous: a real client refreshes about every 15 min.
// ponytail: same memory-store and `trust proxy` ceilings as loginLimiter.
export const refreshLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? ''),
  handler: (_req, _res, next) => next(new TooManyRequestsError()),
});
