import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock('./db/sequelize.js');
});

// Imports server.ts with app.listen mocked to report `outcome` to its callback, the way
// Express 5 does: no argument when listening works, the error when it fails.
async function startWith(outcome: Error | undefined, env: Record<string, string> = {}) {
  vi.stubEnv('PORT', '4321');
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  const dbClose = vi.fn().mockResolvedValue(undefined);
  const { default: app } = await import('./app.js');
  // Registered after app.js (whose models need the real Sequelize) and before server.js, whose
  // shutdown path imports ./db/sequelize.js lazily.
  vi.doMock('./db/sequelize.js', () => ({ sequelize: { close: dbClose } }));
  const server = {
    close: vi.fn((cb: (e?: Error) => void) => cb()),
    closeIdleConnections: vi.fn(),
  };
  vi.spyOn(app, 'listen').mockImplementation(((_port: number, cb: (e?: Error) => void) => {
    cb(outcome);
    return server as never;
  }) as never);
  const handlers: Record<string, () => void> = {};
  vi.spyOn(process, 'once').mockImplementation(((event: string, fn: () => void) => {
    handlers[event] = fn;
    return process;
  }) as never);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  await import('./server.js');
  return { log, error, warn, exit, server, handlers, dbClose };
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

describe('server startup without a JWT secret', () => {
  it.each(['', 'x'.repeat(31)])('exits 1 for the secret %j outside test', async (secret) => {
    const { error, exit } = await startWith(undefined, {
      NODE_ENV: 'development',
      JWT_SECRET: secret,
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('JWT_SECRET'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('starts in the test environment even with no secret', async () => {
    const { exit } = await startWith(undefined, { NODE_ENV: 'test', JWT_SECRET: '' });
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('server shutdown', () => {
  it('registers SIGTERM and SIGINT handlers', async () => {
    const { handlers } = await startWith(undefined);
    expect(Object.keys(handlers)).toEqual(expect.arrayContaining(['SIGTERM', 'SIGINT']));
  });

  it('SIGTERM closes the server and exits 0', async () => {
    const { handlers, server, exit, dbClose } = await startWith(undefined);
    handlers.SIGTERM?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.closeIdleConnections).toHaveBeenCalled();
    expect(dbClose).toHaveBeenCalledTimes(1);
  });

  it('does not register handlers when listening fails', async () => {
    const busy = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    const { handlers, server, exit } = await startWith(busy);
    expect(Object.keys(handlers)).toEqual([]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(server.close).not.toHaveBeenCalled();
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
