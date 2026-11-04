import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../app.js';
import { UnauthorizedError } from '../auth/errors.js';
import { signAccessToken, verifyAccessToken } from '../auth/token.js';
import { EmailTakenError, authenticate, createUser } from '../services/users.js';

// The service is mocked (no database) but its real error classes are kept, because the error
// handler recognises errors with instanceof.
vi.mock('../services/users.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/users.js')>()),
  authenticate: vi.fn(),
  createUser: vi.fn(),
}));

const authenticateMock = vi.mocked(authenticate);
const createUserMock = vi.mocked(createUser);

const bearer = async (role: 'admin' | 'staff') =>
  `Bearer ${await signAccessToken({ id: 1, role })}`;

beforeEach(() => {
  authenticateMock.mockReset();
  createUserMock.mockReset();
});

describe('POST /auth/login', () => {
  it('answers 200 with a 15-minute access token for the right credentials', async () => {
    authenticateMock.mockResolvedValue({ id: 9, role: 'staff' });
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'Staff@Example.com', password: 'whatever' });
    expect(res.status).toBe(200);
    expect(res.body.expiresIn).toBe(900);
    expect(await verifyAccessToken(res.body.accessToken)).toEqual({ id: 9, role: 'staff' });
    expect(authenticateMock).toHaveBeenCalledWith('staff@example.com', 'whatever');
  });

  it('answers 401 with a generic message for wrong credentials', async () => {
    authenticateMock.mockRejectedValue(new UnauthorizedError('Invalid credentials'));
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'a@example.com', password: 'nope' });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.body).toEqual({ status: 'error', message: 'Invalid credentials' });
  });

  it.each([
    ['a missing password', { email: 'a@example.com' }],
    ['an empty password', { email: 'a@example.com', password: '' }],
    ['a malformed email', { email: 'not-an-email', password: 'x' }],
    ['an extra key', { email: 'a@example.com', password: 'x', role: 'admin' }],
    ['a password over 128 characters', { email: 'a@example.com', password: 'x'.repeat(129) }],
  ])('answers 400 for %s', async (_name, body) => {
    const res = await request(app).post('/auth/login').send(body);
    expect(res.status).toBe(400);
    expect(authenticateMock).not.toHaveBeenCalled();
  });

  it('answers 405 to other methods', async () => {
    const res = await request(app).get('/auth/login');
    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe('POST');
  });
});

describe('POST /users', () => {
  const body = { email: 'New@Example.com', password: 'a-long-enough-password', role: 'staff' };

  it('lets an admin create a user and never returns a password or hash', async () => {
    createUserMock.mockResolvedValue({ id: 3, email: 'new@example.com', role: 'staff' });
    const res = await request(app)
      .post('/users')
      .set('Authorization', await bearer('admin'))
      .send(body);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 3, email: 'new@example.com', role: 'staff' });
    expect(createUserMock).toHaveBeenCalledWith({ ...body, email: 'new@example.com' });
  });

  it('answers 401 without a token and 403 for staff, without creating anything', async () => {
    expect((await request(app).post('/users').send(body)).status).toBe(401);
    const res = await request(app)
      .post('/users')
      .set('Authorization', await bearer('staff'))
      .send(body);
    expect(res.status).toBe(403);
    expect(createUserMock).not.toHaveBeenCalled();
  });

  it('answers 422 for an email that is already registered', async () => {
    createUserMock.mockRejectedValue(new EmailTakenError());
    const res = await request(app)
      .post('/users')
      .set('Authorization', await bearer('admin'))
      .send(body);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ status: 'error', message: 'Email already registered' });
  });

  it.each([
    ['a password under 12 characters', { ...body, password: 'short' }],
    ['a password over 128 characters', { ...body, password: 'x'.repeat(129) }],
    ['an unknown role', { ...body, role: 'root' }],
    ['a missing role', { email: body.email, password: body.password }],
    ['a malformed email', { ...body, email: 'nope' }],
  ])('answers 400 for %s', async (_name, bad) => {
    const res = await request(app)
      .post('/users')
      .set('Authorization', await bearer('admin'))
      .send(bad);
    expect(res.status).toBe(400);
    expect(createUserMock).not.toHaveBeenCalled();
  });
});

describe('which routes need a token', () => {
  it.each([
    ['post', '/orders'],
    ['get', '/orders/1'],
    ['post', '/users'],
  ] as const)('%s %s answers 401 without one', async (method, path) => {
    expect((await request(app)[method](path)).status).toBe(401);
  });

  it.each(['/health'])('%s stays public', async (path) => {
    expect((await request(app).get(path)).status).toBe(200);
  });
});
