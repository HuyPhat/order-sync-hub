import express, { type Express } from 'express';
import { checkDatabase } from './db/check.js';
import { errorHandler } from './error-handler.js';
import { ordersRouter } from './routes/orders.js';
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

app.use('/orders', ordersRouter);

// Last, so it catches errors from every route above.
app.use(errorHandler);

export default app;
