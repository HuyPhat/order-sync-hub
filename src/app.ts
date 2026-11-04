import express, { type Express } from 'express';
import { checkDatabase } from './db/check.js';
import { requireAuth, requireRole } from './auth/middleware.js';
import { errorHandler, methodNotAllowed, notFound } from './error-handler.js';
import { authRouter, usersRouter } from './routes/auth.js';
import { ordersRouter } from './routes/orders.js';
const app: Express = express();

// Don't announce the framework in every response, including the 404, 405 and error ones.
app.disable('x-powered-by');

app
  .route('/health')
  .get((_req, res) => {
    res.json({ status: 'ok' });
  })
  .all(methodNotAllowed('GET', 'HEAD'));

// Readiness: can we reach MySQL? Kept apart from /health so a database outage
// doesn't fail liveness checks (and the CI smoke test, which runs without a database).
app
  .route('/health/db')
  .get(async (_req, res) => {
    const up = await checkDatabase();
    res
      .status(up ? 200 : 503)
      .json(up ? { status: 'ok', db: 'up' } : { status: 'error', db: 'down' });
  })
  .all(methodNotAllowed('GET', 'HEAD'));

app.use('/auth', authRouter);
app.use('/users', requireAuth, requireRole('admin'), usersRouter);
app.use('/orders', requireAuth, ordersRouter);

// After every route, before errorHandler: a request nothing matched.
app.use(notFound);

// Last, so it catches errors from every route above.
app.use(errorHandler);

export default app;
