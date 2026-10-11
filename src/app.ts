import express, { type Express } from 'express';
import { checkDatabase } from './db/check.js';
const app: Express = express();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Readiness: can we reach MySQL? Kept apart from /health so a database outage
// doesn't fail liveness checks (and the CI smoke test, which runs without a database).
app.get('/health/db', async (_req, res) => {
  const up = await checkDatabase();
  res
    .status(up ? 200 : 503)
    .json(up ? { status: 'ok', db: 'up' } : { status: 'error', db: 'down' });
});

export default app;
