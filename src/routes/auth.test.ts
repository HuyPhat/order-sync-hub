import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../app.js';
import { UnauthorizedError } from '../auth/errors.js';
import { signAccessToken, verifyAccessToken } from '../auth/token.js';
import {
  createRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
} from '../services/refresh-tokens.js';
import { EmailTakenError, authenticate, createUser } from '../services/users.js';

// The service is mocked (no database) but its real error classes are kept, because the error
// handler recognises errors with instanceof.
vi.mock('../services/users.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/users.js')>()),
  authenticate: vi.fn(),
  createUser: vi.fn(),
}));

vi.mock('../services/refresh-tokens.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/refresh-tokens.js')>()),
  createRefreshToken: vi.fn(),
  rotateRefreshToken: vi.fn(),
  revokeRefreshToken: vi.fn(),
}));

const authenticateMock = vi.mocked(authenticate);
const createRefreshTokenMock = vi.mocked(createRefreshToken);
const rotateMock = vi.mocked(rotateRefreshToken);
const revokeMock = vi.mocked(revokeRefreshToken);
const createUserMock = vi.mocked(createUser);

const bearer = async (role: 'admin' | 'staff') =>
  `Bearer ${await signAccessToken({ id: 1, role })}`;

beforeEach(() => {
  authenticateMock.mockReset();
  createUserMock.mockReset();
  createRefreshTokenMock.mockReset().mockResolvedValue('refresh-1');
  rotateMock.mockReset();
  revokeMock.mockReset();
});

describe('POST /auth/login', () => {
  it('answers 200 with a 15-minute access token and a 7-day refresh token', async () => {
    authenticateMock.mockResolvedValue({ id: 9, role: 'staff' });
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'Staff@Example.com', password: 'whatever' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      expiresIn: 900,
      refreshToken: 'refresh-1',
      refreshExpiresIn: 604800,
    });
    expect(createRefreshTokenMock).toHaveBeenCalledWith(9);
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

describe('POST /auth/refresh', () => {
  it('answers 200 with a new access token and refresh token', async () => {
    rotateMock.mockResolvedValue({ user: { id: 4, role: 'admin' }, refreshToken: 'refresh-2' });
    const res = await request(app).post('/auth/refresh').send({ refreshToken: 'refresh-1' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      expiresIn: 900,
      refreshToken: 'refresh-2',
      refreshExpiresIn: 604800,
    });
    expect(await verifyAccessToken(res.body.accessToken)).toEqual({ id: 4, role: 'admin' });
    expect(rotateMock).toHaveBeenCalledWith('refresh-1');
  });

  it('answers 401 with a Bearer challenge for a bad refresh token', async () => {
    rotateMock.mockRejectedValue(new UnauthorizedError('Invalid refresh token'));
    const res = await request(app).post('/auth/refresh').send({ refreshToken: 'nope' });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.body).toEqual({ status: 'error', message: 'Invalid refresh token' });
  });

  it.each([
    ['no body', {}],
    ['an empty token', { refreshToken: '' }],
    ['a token that is not a string', { refreshToken: 5 }],
    ['a token over 256 characters', { refreshToken: 'x'.repeat(257) }],
    ['an extra key', { refreshToken: 'x', role: 'admin' }],
  ])('answers 400 for %s', async (_name, body) => {
    expect((await request(app).post('/auth/refresh').send(body)).status).toBe(400);
    expect(rotateMock).not.toHaveBeenCalled();
  });

  it('answers 405 to other methods', async () => {
    const res = await request(app).get('/auth/refresh');
    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe('POST');
  });
});

describe('POST /auth/logout', () => {
  it('answers 204 and revokes the session', async () => {
    const res = await request(app).post('/auth/logout').send({ refreshToken: 'refresh-1' });
    expect(res.status).toBe(204);
    expect(revokeMock).toHaveBeenCalledWith('refresh-1');
  });

  it('answers 400 for an invalid body and 405 to other methods', async () => {
    expect((await request(app).post('/auth/logout').send({})).status).toBe(400);
    expect(revokeMock).not.toHaveBeenCalled();
    const res = await request(app).get('/auth/logout');
    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe('POST');
  });
});

// The limiter keeps its counters in memory for the whole test file, so every test below uses its
// own email: the key is IP + email.
describe('POST /auth/login rate limit', () => {
  const login = (email: string, password = 'whatever') =>
    request(app).post('/auth/login').send({ email, password });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers 429 with Retry-After on the 6th failure, even with the right password', async () => {
    authenticateMock.mockRejectedValue(new UnauthorizedError('Invalid credentials'));
    for (let i = 0; i < 5; i++) expect((await login('limit@example.com')).status).toBe(401);

    authenticateMock.mockClear();
    authenticateMock.mockResolvedValue({ id: 1, role: 'staff' });
    const blocked = await login('limit@example.com', 'the-right-password');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.body).toEqual({ status: 'error', message: 'Too many login attempts' });
    expect(authenticateMock).not.toHaveBeenCalled();
  });

  it('lets the same email in again after the window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    authenticateMock.mockRejectedValue(new UnauthorizedError('Invalid credentials'));
    for (let i = 0; i < 6; i++) await login('window@example.com');
    expect((await login('window@example.com')).status).toBe(429);

    vi.advanceTimersByTime(15 * 60 * 1000 + 1000);
    expect((await login('window@example.com')).status).toBe(401);
  });

  it('does not count successful logins', async () => {
    authenticateMock.mockResolvedValue({ id: 1, role: 'staff' });
    for (let i = 0; i < 8; i++) expect((await login('ok@example.com')).status).toBe(200);
  });

  it('counts an unknown email like any other, and leaves other emails alone', async () => {
    authenticateMock.mockRejectedValue(new UnauthorizedError('Invalid credentials'));
    for (let i = 0; i < 5; i++) await login('Ghost@Example.com');
    expect((await login('ghost@example.com')).status).toBe(429);
    expect((await login('someone-else@example.com')).status).toBe(401);
  });

  it('does not count invalid bodies', async () => {
    for (let i = 0; i < 8; i++) {
      expect(
        (await request(app).post('/auth/login').send({ email: 'bad@example.com' })).status,
      ).toBe(400);
    }
    authenticateMock.mockRejectedValue(new UnauthorizedError('Invalid credentials'));
    expect((await login('bad@example.com')).status).toBe(401);
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
