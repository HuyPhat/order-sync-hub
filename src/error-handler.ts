import type { ErrorRequestHandler, RequestHandler } from 'express';
import { STATUS_CODES } from 'node:http';
import { AccessDeniedError, ConnectionError, InvalidConnectionError } from 'sequelize';
import { ZodError } from 'zod';
import {
  IdempotencyKeyReusedError,
  InvalidOrderError,
  OrderNotFoundError,
  ProductNotFoundError,
} from './services/orders.js';

// body-parser and Express's router throw errors that carry a 4xx status (a bad body, a URL that
// cannot be decoded). Those are the client's mistake, so they pass through as that status, and only
// with a fixed message: the error's own text is never sent.
interface ClientError {
  status: number;
  type?: string;
}

const isClientError = (err: unknown): err is ClientError =>
  typeof err === 'object' &&
  err !== null &&
  'status' in err &&
  typeof err.status === 'number' &&
  err.status >= 400 &&
  err.status < 500;

const FIXED_MESSAGES: Record<string, string> = {
  'entity.parse.failed': 'Invalid JSON',
  'entity.too.large': 'Request body too large',
};

// MySQL could not be reached (refused, timed out, no route, pool exhausted). It fails before the
// transaction starts, so nothing was written and a retry is safe. Bad credentials and an invalid
// connection setup are our own misconfiguration: a retry never helps, so they stay a 500.
// A connection lost mid-query is a plain DatabaseError and stays a 500 too: the write may have
// committed, and a 503 would invite a retry that duplicates the order.
const isDatabaseUnreachable = (err: unknown) =>
  err instanceof ConnectionError &&
  !(err instanceof AccessDeniedError || err instanceof InvalidConnectionError);

const RETRY_AFTER_SECONDS = '5';

// No route matched. Mounted after every route and before errorHandler, so an unknown path gets the
// same JSON error shape instead of Express's HTML page. The path and method are never echoed back.
export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ status: 'error', message: 'Not Found' });
};

// For a path that exists but not with this method. Chain it with `.all()` after the route's real
// handlers: Express only reaches it for the methods they did not take.
export const methodNotAllowed =
  (...allowed: string[]): RequestHandler =>
  (req, res) => {
    res.set('Allow', allowed.join(', '));
    // `.all()` also catches OPTIONS, which Express would otherwise answer itself.
    if (req.method === 'OPTIONS') return void res.sendStatus(204);
    res.status(405).json({ status: 'error', message: 'Method Not Allowed' });
  };

// Last middleware: the one place that decides what the client is told about a failure.
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);

  const send = (status: number, message: string, extra?: object) =>
    res.status(status).json({ status: 'error', message, ...extra });

  if (err instanceof ZodError) {
    const issues = err.issues.map(({ path, message }) => ({
      path: path.join('.'),
      message,
    }));
    return send(400, 'Invalid request', { issues });
  }
  if (err instanceof InvalidOrderError) return send(400, err.message);
  if (err instanceof ProductNotFoundError) return send(422, err.message);
  if (err instanceof IdempotencyKeyReusedError) return send(422, err.message);
  if (err instanceof OrderNotFoundError) return send(404, 'Order not found');
  if (isClientError(err)) {
    return send(
      err.status,
      FIXED_MESSAGES[err.type ?? ''] ?? STATUS_CODES[err.status] ?? 'Bad Request',
    );
  }

  if (isDatabaseUnreachable(err)) {
    console.error('Database unreachable:', err);
    res.set('Retry-After', RETRY_AFTER_SECONDS);
    return send(503, 'Service Unavailable');
  }

  console.error('Unhandled request error:', err);
  send(500, 'Internal Server Error');
};
