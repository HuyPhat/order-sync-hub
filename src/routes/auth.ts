import express, { Router } from 'express';
import { z } from 'zod';
import { loginLimiter } from '../auth/rate-limit.js';
import { methodNotAllowed } from '../error-handler.js';
import { ACCESS_TOKEN_TTL_SECONDS, ROLES, signAccessToken, type AuthUser } from '../auth/token.js';
import {
  REFRESH_TOKEN_TTL_SECONDS,
  createRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
} from '../services/refresh-tokens.js';
import { authenticate, createUser } from '../services/users.js';

// Shape only. Emails are stored lowercase so they match however the client cased them.
const email = z
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());

const loginBody = z.strictObject({ email, password: z.string().min(1).max(128) });

const refreshBody = z.strictObject({ refreshToken: z.string().min(1).max(256) });

const sessionResponse = async (user: AuthUser, refreshToken: string) => ({
  accessToken: await signAccessToken(user),
  expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  refreshToken,
  refreshExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
});

// 128 is a cap, not a policy: hashing a huge string would burn CPU for nothing.
export const newUserBody = z.strictObject({
  email,
  password: z.string().min(12).max(128),
  role: z.enum(ROLES),
});

export const authRouter: Router = Router();
authRouter.use(express.json());

authRouter
  .route('/login')
  .post(
    // Validate first and keep the parsed (lowercased) body: the limiter keys on its email.
    (req, _res, next) => {
      req.body = loginBody.parse(req.body);
      next();
    },
    loginLimiter,
    async (req, res) => {
      const { email, password } = req.body as z.infer<typeof loginBody>;
      const user = await authenticate(email, password);
      res.json(await sessionResponse(user, await createRefreshToken(user.id)));
    },
  )
  .all(methodNotAllowed('POST'));

// Public: the refresh token is the credential.
authRouter
  .route('/refresh')
  .post(async (req, res) => {
    const { refreshToken } = refreshBody.parse(req.body);
    const rotated = await rotateRefreshToken(refreshToken);
    res.json(await sessionResponse(rotated.user, rotated.refreshToken));
  })
  .all(methodNotAllowed('POST'));

authRouter
  .route('/logout')
  .post(async (req, res) => {
    await revokeRefreshToken(refreshBody.parse(req.body).refreshToken);
    res.sendStatus(204);
  })
  .all(methodNotAllowed('POST'));

// Mounted behind requireAuth and requireRole('admin') in app.ts.
export const usersRouter: Router = Router();
usersRouter.use(express.json());

usersRouter
  .route('/')
  .post(async (req, res) => {
    res.status(201).json(await createUser(newUserBody.parse(req.body)));
  })
  .all(methodNotAllowed('POST'));
