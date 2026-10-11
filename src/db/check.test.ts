import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkDatabase } from './check.js';
import { sequelize } from './sequelize.js';

describe('checkDatabase', () => {
  afterEach(() => {
    vi.useRealTimers();
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

  it('returns false once the timeout passes if authenticate never settles', async () => {
    vi.useFakeTimers();
    vi.spyOn(sequelize, 'authenticate').mockReturnValue(new Promise(() => {}));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = checkDatabase(2000);
    await vi.advanceTimersByTimeAsync(1999);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(false);
  });

  it('does not leave a pending timer behind after a fast success', async () => {
    vi.useFakeTimers();
    vi.spyOn(sequelize, 'authenticate').mockResolvedValue(undefined);
    await checkDatabase();
    expect(vi.getTimerCount()).toBe(0);
  });
});
