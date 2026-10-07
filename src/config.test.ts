import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadConfig() {
  vi.resetModules();
  return (await import('./config.js')).config;
}

describe('config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to port 3000 and development when env is empty', async () => {
    vi.stubEnv('PORT', '');
    vi.stubEnv('NODE_ENV', '');
    const config = await loadConfig();
    expect(config.port).toBe(3000);
    expect(config.nodeEnv).toBe('development');
  });

  it('parses a numeric PORT string into a number', async () => {
    vi.stubEnv('PORT', '8080');
    const config = await loadConfig();
    expect(config.port).toBe(8080);
    expect(typeof config.port).toBe('number');
  });

  it.each([0, 65535])('accepts the boundary port %i', async (port) => {
    vi.stubEnv('PORT', String(port));
    expect((await loadConfig()).port).toBe(port);
  });

  it.each(['abc', '99999', '-1', '30.5', 'Infinity'])(
    'throws for invalid PORT %s',
    async (bad) => {
      vi.stubEnv('PORT', bad);
      await expect(loadConfig()).rejects.toThrow(/Invalid PORT/);
    },
  );

  it('uses NODE_ENV when provided', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect((await loadConfig()).nodeEnv).toBe('production');
  });
});
