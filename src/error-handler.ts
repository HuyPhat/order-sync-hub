import type { ErrorRequestHandler } from 'express';
import { STATUS_CODES } from 'node:http';
import { ZodError } from 'zod';
import { InvalidOrderError, OrderNotFoundError, ProductNotFoundError } from './services/orders.js';

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
  if (err instanceof OrderNotFoundError) return send(404, 'Order not found');
  if (isClientError(err)) {
    return send(
      err.status,
      FIXED_MESSAGES[err.type ?? ''] ?? STATUS_CODES[err.status] ?? 'Bad Request',
    );
  }

  console.error('Unhandled request error:', err);
  send(500, 'Internal Server Error');
};
