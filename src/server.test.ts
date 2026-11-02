import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

// Imports server.ts with app.listen mocked to report `outcome` to its callback, the way
// Express 5 does: no argument when listening works, the error when it fails.
async function startWith(outcome: Error | undefined, env: Record<string, string> = {}) {
  vi.stubEnv('PORT', '4321');
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  const { default: app } = await import('./app.js');
  vi.spyOn(app, 'listen').mockImplementation(((_port: number, cb: (e?: Error) => void) => {
    cb(outcome);
    return {} as never;
  }) as never);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  await import('./server.js');
  return { log, error, warn, exit };
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

describe('server database settings', () => {
  it.each(['production', 'qa'])(
    'refuses to start in %s without MYSQL_PASSWORD',
    async (nodeEnv) => {
      const { error, exit } = await startWith(undefined, { NODE_ENV: nodeEnv, MYSQL_PASSWORD: '' });
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Refusing to start'));
      expect(error).toHaveBeenCalledWith(expect.stringContaining('MYSQL_PASSWORD'));
      expect(exit).toHaveBeenCalledWith(1);
    },
  );

  it.each(['development', 'test'])(
    'only warns in %s without MYSQL_PASSWORD, and still starts',
    async (nodeEnv) => {
      const { warn, exit, log } = await startWith(undefined, {
        NODE_ENV: nodeEnv,
        MYSQL_PASSWORD: '',
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('MYSQL_PASSWORD'));
      expect(exit).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Server is running'));
    },
  );

  it('starts quietly in production when MYSQL_PASSWORD is set', async () => {
    const { warn, error, exit } = await startWith(undefined, {
      NODE_ENV: 'production',
      MYSQL_PASSWORD: 's3cret',
    });
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
