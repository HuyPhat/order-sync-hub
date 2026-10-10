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

  it('returns 404 for unknown routes', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
  });

  it('returns 404 for POST /health (only GET is defined)', async () => {
    const res = await request(app).post('/health');
    expect(res.status).toBe(404);
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
