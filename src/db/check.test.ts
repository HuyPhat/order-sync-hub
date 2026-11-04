import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkDatabase } from './check.js';
import { sequelize } from './sequelize.js';

describe('checkDatabase', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when authenticate succeeds', async () => {
    vi.spyOn(sequelize, 'authenticate').mockResolvedValue(undefined);
    await expect(checkDatabase()).resolves.toBe(true);
  });

  it('returns false, without throwing, when authenticate rejects', async () => {
    vi.spyOn(sequelize, 'authenticate').mockRejectedValue(new Error('connection refused'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(checkDatabase()).resolves.toBe(false);
  });
});
