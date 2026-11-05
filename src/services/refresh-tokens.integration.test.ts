import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../app.js';
import { UnauthorizedError } from '../auth/errors.js';
import { sequelize } from '../db/sequelize.js';
import { RefreshToken, User } from '../models/index.js';
import {
  REFRESH_GRACE_SECONDS,
  createRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
} from './refresh-tokens.js';
import { createUser } from './users.js';

// Runs against the TEST database (see vitest.integration.config.ts), real MySQL, nothing mocked.
const password = 'a-long-enough-password';
let userId: number;

beforeEach(async () => {
  await User.destroy({ where: {} }); // cascades to refresh_tokens
  ({ id: userId } = await createUser({ email: 'a@example.com', password, role: 'staff' }));
});

afterAll(async () => {
  await sequelize.close();
});

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);
const rowOf = async (token: string) => {
  const row = await RefreshToken.findOne({ where: { tokenHash: sha256(token) } });
  if (!row) throw new Error('no such row');
  return row;
};
const rejects = (promise: Promise<unknown>) =>
  expect(promise).rejects.toBeInstanceOf(UnauthorizedError);

describe('createRefreshToken', () => {
  it('stores only the SHA-256 hash, a week ahead, in a new family each time', async () => {
    const first = await createRefreshToken(userId);
    const second = await createRefreshToken(userId);

    const row = await rowOf(first);
    expect(row.tokenHash).toHaveLength(64);
    expect(row.tokenHash).not.toContain(first);
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(7 * 24 * 3600 * 1000 - 5000);
    expect(row.usedAt).toBeNull();
    expect(row.revokedAt).toBeNull();
    expect(row.familyId).not.toBe((await rowOf(second)).familyId);
    expect(await RefreshToken.count({ where: { tokenHash: first } })).toBe(0);
  });

  it('is deleted together with its user', async () => {
    await createRefreshToken(userId);
    await User.destroy({ where: { id: userId } });
    expect(await RefreshToken.count()).toBe(0);
  });
});

describe('rotateRefreshToken', () => {
  it('returns the user with the CURRENT role and a new token in the same family', async () => {
    const token = await createRefreshToken(userId);
    await User.update({ role: 'admin' }, { where: { id: userId } });

    const rotated = await rotateRefreshToken(token);
    expect(rotated.user).toEqual({ id: userId, role: 'admin' });
    expect(rotated.refreshToken).not.toBe(token);
    expect((await rowOf(rotated.refreshToken)).familyId).toBe((await rowOf(token)).familyId);
    expect((await rowOf(token)).usedAt).not.toBeNull();
  });

  it.each([
    ['an unknown token', async () => 'not-a-real-token'],
    [
      'an expired token',
      async () => {
        const token = await createRefreshToken(userId);
        await RefreshToken.update({ expiresAt: ago(1) }, { where: { tokenHash: sha256(token) } });
        return token;
      },
    ],
    [
      'a revoked token',
      async () => {
        const token = await createRefreshToken(userId);
        await revokeRefreshToken(token);
        return token;
      },
    ],
  ])('fails with %s', async (_name, makeToken) => {
    await rejects(rotateRefreshToken(await makeToken()));
  });

  it('accepts a token used less than the grace window ago, and keeps the family alive', async () => {
    const token = await createRefreshToken(userId);
    const first = await rotateRefreshToken(token);
    const usedAt = (await rowOf(token)).usedAt;

    const second = await rotateRefreshToken(token);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect((await rowOf(token)).usedAt).toEqual(usedAt); // the window does not slide
    await expect(rotateRefreshToken(first.refreshToken)).resolves.toBeDefined();
    await expect(rotateRefreshToken(second.refreshToken)).resolves.toBeDefined();
  });

  it('lets two concurrent requests with the same token both succeed with different tokens', async () => {
    const token = await createRefreshToken(userId);
    const [a, b] = await Promise.all([rotateRefreshToken(token), rotateRefreshToken(token)]);
    expect(a.refreshToken).not.toBe(b.refreshToken);
    expect(await RefreshToken.count({ where: { revokedAt: null } })).toBe(3);
  });

  it('treats a token used longer ago as theft: revokes the whole family', async () => {
    const token = await createRefreshToken(userId);
    const { refreshToken: newest } = await rotateRefreshToken(token);
    await RefreshToken.update(
      { usedAt: ago(REFRESH_GRACE_SECONDS + 1) },
      { where: { tokenHash: sha256(token) } },
    );

    await rejects(rotateRefreshToken(token));
    await rejects(rotateRefreshToken(newest)); // the thief's and the owner's tokens both die
    expect(await RefreshToken.count({ where: { revokedAt: null } })).toBe(0);
  });

  it('does not touch the families of other sessions', async () => {
    const mine = await createRefreshToken(userId);
    const other = await createRefreshToken(userId);
    await rotateRefreshToken(mine);
    await RefreshToken.update(
      { usedAt: ago(REFRESH_GRACE_SECONDS + 1) },
      { where: { tokenHash: sha256(mine) } },
    );
    await rejects(rotateRefreshToken(mine));
    await expect(rotateRefreshToken(other)).resolves.toBeDefined();
  });
});

describe('revokeRefreshToken', () => {
  it('revokes the whole family and ignores an unknown token', async () => {
    const token = await createRefreshToken(userId);
    const { refreshToken: newest } = await rotateRefreshToken(token);

    await revokeRefreshToken('not-a-real-token');
    await revokeRefreshToken(newest);
    await rejects(rotateRefreshToken(token));
    await rejects(rotateRefreshToken(newest));
  });
});

describe('the whole flow over HTTP', () => {
  it('login -> refresh -> logout, and the refresh token is dead after logout', async () => {
    const login = await request(app).post('/auth/login').send({ email: 'a@example.com', password });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ expiresIn: 900, refreshExpiresIn: 604800 });

    const refreshed = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: login.body.refreshToken });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refreshToken).not.toBe(login.body.refreshToken);
    const orders = await request(app)
      .get('/orders/999999')
      .set('Authorization', `Bearer ${refreshed.body.accessToken}`);
    expect(orders.status).toBe(404);

    const out = await request(app)
      .post('/auth/logout')
      .send({ refreshToken: refreshed.body.refreshToken });
    expect(out.status).toBe(204);
    const after = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: refreshed.body.refreshToken });
    expect(after.status).toBe(401);
  });
});
