import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

// Imports server.ts with app.listen mocked to report `outcome` to its callback, the way
// Express 5 does: no argument when listening works, the error when it fails.
async function startWith(outcome: Error | undefined) {
  vi.stubEnv('PORT', '4321');
  vi.resetModules();
  const { default: app } = await import('./app.js');
  vi.spyOn(app, 'listen').mockImplementation(((_port: number, cb: (e?: Error) => void) => {
    cb(outcome);
    return {} as never;
  }) as never);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  await import('./server.js');
  return { log, error, exit };
}

describe('server startup', () => {
  it('logs success and does not exit when listening works', async () => {
    const { log, error, exit } = await startWith(undefined);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('4321'));
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('reports a busy port, exits 1 and never claims success', async () => {
    const busy = Object.assign(new Error('listen EADDRINUSE: address already in use :::4321'), {
      code: 'EADDRINUSE',
    });
    const { log, error, exit } = await startWith(busy);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('port 4321 is already in use'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('exits 1 with the error message for any other listen failure', async () => {
    const denied = Object.assign(new Error('listen EACCES: permission denied'), { code: 'EACCES' });
    const { log, error, exit } = await startWith(denied);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('permission denied'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).not.toHaveBeenCalled();
  });
});
