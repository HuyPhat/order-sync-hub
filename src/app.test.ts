import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from './app.js';
import { sequelize } from './db/sequelize.js';

describe('GET /health', () => {
  it('returns 200 and { status: "ok" }', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('returns a JSON content type', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('does not send X-Powered-By, on success, 404 or 405', async () => {
    for (const res of [
      await request(app).get('/health'),
      await request(app).get('/nope'),
      await request(app).post('/health'),
    ]) {
      expect(res.headers['x-powered-by']).toBeUndefined();
    }
  });

  it('answers HEAD with 200 and no body', async () => {
    const res = await request(app).head('/health');
    expect(res.status).toBe(200);
    expect(res.text).toBeUndefined();
  });
});

describe('requests no route matches', () => {
  it.each(['/nope', '/orders/1/items', '/health/db/x'])('GET %s is a JSON 404', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ status: 'error', message: 'Not Found' });
  });

  it('does not echo the path back', async () => {
    const res = await request(app).get('/secret-probe-path');
    expect(res.text).not.toMatch(/secret-probe-path/);
  });
});

describe('OPTIONS on a known path', () => {
  it.each([
    ['/health', 'GET, HEAD'],
    ['/orders', 'POST'],
    ['/orders/1', 'GET, HEAD'],
  ])('%s answers 204 and lists the allowed methods', async (path, allow) => {
    const res = await request(app).options(path);
    expect(res.status).toBe(204);
    expect(res.headers['allow']).toBe(allow);
  });
});

describe('a known path with the wrong method is a JSON 405 with an Allow header', () => {
  it.each([
    ['post', '/health', 'GET, HEAD'],
    ['delete', '/health/db', 'GET, HEAD'],
    ['get', '/orders', 'POST'],
    ['put', '/orders', 'POST'],
    ['delete', '/orders/1', 'GET, HEAD'],
    ['post', '/orders/1', 'GET, HEAD'],
  ] as const)('%s %s', async (method, path, allow) => {
    const res = await request(app)[method](path);
    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe(allow);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ status: 'error', message: 'Method Not Allowed' });
  });
});

describe('GET /health/db', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 and { status: "ok", db: "up" } when the database answers', async () => {
    vi.spyOn(sequelize, 'authenticate').mockResolvedValue(undefined);
    const res = await request(app).get('/health/db');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up' });
  });

  it('returns 503 and { status: "error", db: "down" } when the database is unreachable', async () => {
    vi.spyOn(sequelize, 'authenticate').mockRejectedValue(new Error('connect ECONNREFUSED'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get('/health/db');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'error', db: 'down' });
  });

  it('does not leak the underlying error message', async () => {
    vi.spyOn(sequelize, 'authenticate').mockRejectedValue(new Error('Access denied for user app'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get('/health/db');
    expect(res.status).toBe(503);
    expect(res.text).not.toMatch(/denied|app|ECONNREFUSED/);
  });

  it('is not called by /health, which stays a pure liveness check', async () => {
    const authenticate = vi.spyOn(sequelize, 'authenticate').mockResolvedValue(undefined);
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(authenticate).not.toHaveBeenCalled();
  });
});
