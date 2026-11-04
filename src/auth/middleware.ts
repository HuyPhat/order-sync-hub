import type { RequestHandler } from 'express';
import { ForbiddenError, UnauthorizedError } from './errors.js';
import { verifyAccessToken, type AuthUser, type Role } from './token.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// 401 unless the request carries a valid `Authorization: Bearer <access token>`.
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const match = /^Bearer (\S+)$/i.exec(req.get('Authorization') ?? '');
  if (!match) throw new UnauthorizedError('Authentication required');
  try {
    req.user = await verifyAccessToken(match[1]!);
  } catch {
    // Expired, wrong signature, wrong algorithm, odd claims: the client only needs to log in again.
    throw new UnauthorizedError('Invalid or expired token');
  }
  next();
};

// 403 when the user is logged in but not allowed. Mount it after requireAuth; used alone it fails
// closed with 401.
export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) throw new UnauthorizedError('Authentication required');
    if (!roles.includes(req.user.role)) throw new ForbiddenError();
    next();
  };
