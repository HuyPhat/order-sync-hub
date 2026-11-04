import express, { type Express } from 'express';
import { SignJWT } from 'jose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { errorHandler } from '../error-handler.js';
import { requireAuth, requireRole } from './middleware.js';
import { signAccessToken } from './token.js';

// Tiny app: /me needs any logged-in user, /admin needs the admin role.
const app: Express = express();
app.get('/me', requireAuth, (req, res) => void res.json(req.user));
app.get('/admin', requireAuth, requireRole('admin'), (_req, res) => void res.json({ ok: true }));
app.get('/role-only', requireRole('admin'), (_req, res) => void res.json({ ok: true }));
app.use(errorHandler);

const bearer = async (id: number, role: 'admin' | 'staff') =>
  `Bearer ${await signAccessToken({ id, role })}`;

describe('requireAuth', () => {
  it('lets a valid token through and sets req.user', async () => {
    const res = await request(app)
      .get('/me')
      .set('Authorization', await bearer(5, 'staff'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 5, role: 'staff' });
  });

  it('accepts the scheme in any letter case', async () => {
    const token = (await bearer(5, 'staff')).slice('Bearer '.length);
    const res = await request(app).get('/me').set('Authorization', `bearer ${token}`);
    expect(res.status).toBe(200);
  });

  const expired = () =>
    new SignJWT({ role: 'staff' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('5')
      .setIssuedAt(1)
      .setExpirationTime(2)
      .sign(new TextEncoder().encode(config.jwtSecret));

  it.each([
    ['no Authorization header', async () => undefined],
    ['a non-Bearer scheme', async () => 'Basic dXNlcjpwYXNz'],
    ['a Bearer header with no token', async () => 'Bearer '],
    ['a malformed token', async () => 'Bearer not.a.jwt'],
    ['an expired token', async () => `Bearer ${await expired()}`],
    [
      'a token signed with another secret',
      async () =>
        `Bearer ${await new SignJWT({ role: 'admin' })
          .setProtectedHeader({ alg: 'HS256' })
          .setSubject('5')
          .setExpirationTime('15m')
          .sign(new TextEncoder().encode('z'.repeat(40)))}`,
    ],
    [
      'an unsigned (alg none) token',
      async () => `Bearer ${btoa('{"alg":"none"}')}.${btoa('{"sub":"5","role":"admin"}')}.`,
    ],
  ])('answers 401 with a Bearer challenge for %s', async (_name, header) => {
    const req = request(app).get('/me');
    const value = await header();
    const res = await (value === undefined ? req : req.set('Authorization', value));
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.body).toMatchObject({ status: 'error' });
  });
});

describe('requireRole', () => {
  it('lets the allowed role through', async () => {
    const res = await request(app)
      .get('/admin')
      .set('Authorization', await bearer(1, 'admin'));
    expect(res.status).toBe(200);
  });

  it('answers 403 for a logged-in user with another role', async () => {
    const res = await request(app)
      .get('/admin')
      .set('Authorization', await bearer(2, 'staff'));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ status: 'error', message: 'Forbidden' });
  });

  it('answers 401, not 403, when nobody is logged in', async () => {
    const res = await request(app).get('/admin');
    expect(res.status).toBe(401);
  });

  it('fails closed with 401 if used without requireAuth', async () => {
    const res = await request(app)
      .get('/role-only')
      .set('Authorization', await bearer(1, 'admin'));
    expect(res.status).toBe(401);
  });
});
