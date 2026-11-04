import express, { Router } from 'express';
import { z } from 'zod';
import { methodNotAllowed } from '../error-handler.js';
import { ACCESS_TOKEN_TTL_SECONDS, ROLES, signAccessToken } from '../auth/token.js';
import { authenticate, createUser } from '../services/users.js';

// Shape only. Emails are stored lowercase so they match however the client cased them.
const email = z
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());

const loginBody = z.strictObject({ email, password: z.string().min(1).max(128) });

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
  .post(async (req, res) => {
    const { email, password } = loginBody.parse(req.body);
    const user = await authenticate(email, password);
    res.json({ accessToken: await signAccessToken(user), expiresIn: ACCESS_TOKEN_TTL_SECONDS });
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
