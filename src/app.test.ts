import request from 'supertest';
import { describe, expect, it } from 'vitest';
import app from './app.js';

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
