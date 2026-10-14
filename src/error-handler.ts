import type { ErrorRequestHandler } from 'express';
import { STATUS_CODES } from 'node:http';
import { ZodError } from 'zod';
import { InvalidOrderError, OrderNotFoundError, ProductNotFoundError } from './services/orders.js';

// body-parser (and other Express internals) throw errors that carry a status and say whether the
// client may see them. Only those are passed through, and only with a fixed message.
interface ClientError {
  status: number;
  expose: true;
  type?: string;
}

const isClientError = (err: unknown): err is ClientError =>
  typeof err === 'object' &&
  err !== null &&
  'status' in err &&
  typeof err.status === 'number' &&
  err.status >= 400 &&
  err.status < 500 &&
  'expose' in err &&
  err.expose === true;

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
