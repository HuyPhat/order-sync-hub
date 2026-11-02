import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShutdown } from './shutdown.js';

type CloseCb = (err?: Error) => void;

function makeDeps(overrides: { close?: (cb: CloseCb) => void; timeoutMs?: number } = {}) {
  const close = vi.fn(overrides.close ?? ((cb: CloseCb) => cb()));
  const closeIdleConnections = vi.fn();
  const closeDb = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const exit = vi.fn();
  const log = vi.fn();
  const deps = {
    server: { close, closeIdleConnections } as never,
    closeDb,
    exit,
    log,
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
  };
  return { deps, close, closeIdleConnections, closeDb, exit, log };
}

describe('createShutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes the server, then the database, then exits 0', async () => {
    const { deps, close, closeIdleConnections, closeDb, exit } = makeDeps();
    await createShutdown(deps)('SIGTERM');

    expect(close).toHaveBeenCalledTimes(1);
    expect(closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(close.mock.invocationCallOrder[0]!).toBeLessThan(closeDb.mock.invocationCallOrder[0]!);
  });

  it('waits for in-flight requests before closing the database', async () => {
    let held: CloseCb | undefined;
    const { deps, closeDb } = makeDeps({ close: (cb) => (held = cb) });
    const pending = createShutdown(deps)('SIGTERM');

    await vi.advanceTimersByTimeAsync(0);
    expect(closeDb).not.toHaveBeenCalled();

    held!();
    await pending;
    expect(closeDb).toHaveBeenCalledTimes(1);
  });

  it('keeps sweeping idle connections while the close is pending, then leaves no timer', async () => {
    let held: CloseCb | undefined;
    const { deps, closeIdleConnections, exit } = makeDeps({ close: (cb) => (held = cb) });
    const pending = createShutdown(deps)('SIGTERM');

    await vi.advanceTimersByTimeAsync(100);
    const afterFirstTick = closeIdleConnections.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(closeIdleConnections.mock.calls.length).toBeGreaterThan(1);
    expect(closeIdleConnections.mock.calls.length).toBeGreaterThan(afterFirstTick);

    held!();
    await pending;
    expect(exit).toHaveBeenCalledWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a second signal while shutting down', async () => {
    const { deps, close, closeDb, exit } = makeDeps();
    const shutdown = createShutdown(deps);
    await Promise.all([shutdown('SIGINT'), shutdown('SIGINT')]);

    expect(close).toHaveBeenCalledTimes(1);
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits 1 when the server does not finish closing within the timeout', async () => {
    const { deps, exit } = makeDeps({ close: () => {} });
    void createShutdown(deps)('SIGTERM');

    await vi.advanceTimersByTimeAsync(9_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('honours a custom timeoutMs', async () => {
    const { deps, exit } = makeDeps({ close: () => {}, timeoutMs: 50 });
    void createShutdown(deps)('SIGTERM');

    await vi.advanceTimersByTimeAsync(50);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('still closes the database and exits 1 when server.close errors', async () => {
    const { deps, closeDb, exit } = makeDeps({ close: (cb) => cb(new Error('not running')) });
    await createShutdown(deps)('SIGTERM');

    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when closing the database fails', async () => {
    const { deps, closeDb, exit, log } = makeDeps();
    closeDb.mockRejectedValue(new Error('db boom'));
    await createShutdown(deps)('SIGTERM');

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('db boom'));
  });

  it('does not leave a pending timer after a clean shutdown', async () => {
    const { deps } = makeDeps();
    await createShutdown(deps)('SIGTERM');

    expect(vi.getTimerCount()).toBe(0);
  });
});
