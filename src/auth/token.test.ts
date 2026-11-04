import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  jwtSecretProblem,
  signAccessToken,
  verifyAccessToken,
} from './token.js';

const key = new TextEncoder().encode(config.jwtSecret);
const sign = (alg: string, claims: Record<string, unknown>, secret = key) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg })
    .setSubject('7')
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(secret);

afterEach(() => {
  vi.useRealTimers();
});

describe('access token', () => {
  it('round-trips the user id and role', async () => {
    const token = await signAccessToken({ id: 7, role: 'admin' });
    await expect(verifyAccessToken(token)).resolves.toEqual({ id: 7, role: 'admin' });
  });

  it('expires after 15 minutes', async () => {
    vi.useFakeTimers();
    const token = await signAccessToken({ id: 7, role: 'staff' });
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    await vi.advanceTimersByTimeAsync(899_000);
    await expect(verifyAccessToken(token)).resolves.toBeDefined();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(verifyAccessToken(token)).rejects.toThrow();
  });

  it('rejects a token signed with another secret', async () => {
    const token = await sign('HS256', { role: 'staff' }, new TextEncoder().encode('y'.repeat(40)));
    await expect(verifyAccessToken(token)).rejects.toThrow();
  });

  it('rejects any algorithm other than HS256', async () => {
    await expect(verifyAccessToken(await sign('HS512', { role: 'staff' }))).rejects.toThrow();
    const none = `${btoa('{"alg":"none"}')}.${btoa('{"sub":"7","role":"admin"}')}.`;
    await expect(verifyAccessToken(none)).rejects.toThrow();
  });

  it('rejects a role that is not admin or staff, or a non-numeric subject', async () => {
    await expect(verifyAccessToken(await sign('HS256', { role: 'root' }))).rejects.toThrow();
    const badSub = await new SignJWT({ role: 'staff' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('abc')
      .setExpirationTime('15m')
      .sign(key);
    await expect(verifyAccessToken(badSub)).rejects.toThrow();
  });
});

describe('jwtSecretProblem', () => {
  it('reports a missing or short secret', () => {
    expect(jwtSecretProblem('')).toMatch(/JWT_SECRET/);
    expect(jwtSecretProblem('x'.repeat(31))).toMatch(/at least 32/);
  });

  it('reports nothing for a long enough secret', () => {
    expect(jwtSecretProblem('x'.repeat(32))).toBeUndefined();
  });
});
