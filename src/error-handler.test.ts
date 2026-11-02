import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import {
  AccessDeniedError,
  ConnectionAcquireTimeoutError,
  ConnectionError,
  ConnectionRefusedError,
  ConnectionTimedOutError,
  DatabaseError,
  HostNotFoundError,
  HostNotReachableError,
  InvalidConnectionError,
} from 'sequelize';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { errorHandler } from './error-handler.js';
import { InvalidOrderError, OrderNotFoundError, ProductNotFoundError } from './services/orders.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// A tiny app: one route that fails on demand, a body parser, then the real error handler.
function appThatThrows(error: unknown) {
  const app = express();
  app.use(express.json());
  app.get('/boom', () => {
    throw error;
  });
  app.post('/echo', (req, res) => {
    res.json(req.body);
  });
  app.use(errorHandler);
  return app;
}

const zodError = z.strictObject({ items: z.array(z.number()) }).safeParse({ items: ['x'] }).error!;

describe('errorHandler: known errors', () => {
  it.each([
    ['InvalidOrderError', new InvalidOrderError('Invalid quantity: 0'), 400, 'Invalid quantity: 0'],
    ['ProductNotFoundError', new ProductNotFoundError([5, 7]), 422, 'Unknown product id(s): 5, 7'],
    ['OrderNotFoundError', new OrderNotFoundError(9), 404, 'Order not found'],
  ])('%s is answered with its status', async (_name, error, status, message) => {
    const res = await request(appThatThrows(error)).get('/boom');
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ status: 'error', message });
  });

  it('turns a ZodError into 400 with one issue per problem and a dotted path', async () => {
    const res = await request(appThatThrows(zodError)).get('/boom');
    expect(res.status).toBe(400);
    expect(res.body.status).toBe('error');
    expect(res.body.message).toBe('Invalid request');
    expect(res.body.issues).toEqual([{ path: 'items.0', message: expect.any(String) }]);
  });
});

describe('errorHandler: errors from the body parser', () => {
  it('answers 400 "Invalid JSON" for malformed JSON, without the parser message', async () => {
    const res = await request(appThatThrows(new Error('unused')))
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{"items": [');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ status: 'error', message: 'Invalid JSON' });
  });

  it('answers 413 for a body over the 100 kb default limit', async () => {
    const res = await request(appThatThrows(new Error('unused')))
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ pad: 'x'.repeat(200_000) }));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ status: 'error', message: 'Request body too large' });
  });

  it('passes another client error through with the standard status text', async () => {
    const error = Object.assign(new Error('internal wording'), { status: 415, expose: true });
    const res = await request(appThatThrows(error)).get('/boom');
    expect(res.status).toBe(415);
    expect(res.body).toEqual({ status: 'error', message: 'Unsupported Media Type' });
  });
});

describe('errorHandler: framework 4xx errors without an expose flag', () => {
  it.each([
    ['without an expose flag', { status: 400 }],
    ['even when it says not to show its message', { status: 400, expose: false }],
  ])('passes a 4xx error %s through as a fixed "Bad Request"', async (_name, props) => {
    const error = Object.assign(new URIError('secret decode detail'), props);
    const res = await request(appThatThrows(error)).get('/boom');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ status: 'error', message: 'Bad Request' });
    expect(res.text).not.toMatch(/secret/);
  });
});

describe('errorHandler: database unreachable', () => {
  const cause = new Error('secret: connect ECONNREFUSED 10.0.0.5:3306');

  it.each([
    ['ConnectionRefusedError', new ConnectionRefusedError(cause)],
    ['ConnectionTimedOutError', new ConnectionTimedOutError(cause)],
    ['HostNotReachableError', new HostNotReachableError(cause)],
    ['HostNotFoundError', new HostNotFoundError(cause)],
    ['ConnectionAcquireTimeoutError', new ConnectionAcquireTimeoutError(cause)],
    ['a plain ConnectionError', new ConnectionError(cause)],
  ])('%s is a 503 with Retry-After and a fixed body', async (_name, error) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(appThatThrows(error)).get('/boom');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body).toEqual({ status: 'error', message: 'Service Unavailable' });
    expect(res.text).not.toMatch(/secret|ECONNREFUSED|10\.0\.0\.5/);
    expect(logged).toHaveBeenCalledWith('Database unreachable:', error);
  });

  it.each([
    [
      'AccessDeniedError (our credentials are wrong; a retry cannot help)',
      new AccessDeniedError(cause),
    ],
    ['InvalidConnectionError', new InvalidConnectionError(cause)],
    [
      'a DatabaseError (a query failed mid-flight; the write may have happened)',
      new DatabaseError(Object.assign(cause, { sql: 'INSERT INTO orders ...' })),
    ],
  ])('%s stays a 500 without Retry-After', async (_name, error) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(appThatThrows(error)).get('/boom');
    expect(res.status).toBe(500);
    expect(res.headers['retry-after']).toBeUndefined();
    expect(res.body).toEqual({ status: 'error', message: 'Internal Server Error' });
  });
});

describe('errorHandler: everything else is a 500 that leaks nothing', () => {
  it.each([
    ['an Error with SQL detail', new Error("secret: SELECT * FROM `orders` WHERE password='x'")],
    ['a thrown string', 'secret string'],
    [
      'a 5xx error even if it claims to be exposable',
      Object.assign(new Error('secret'), { status: 503, expose: true }),
    ],
  ])('%s', async (_name, error) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(appThatThrows(error)).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ status: 'error', message: 'Internal Server Error' });
    expect(res.text).not.toMatch(/secret|SELECT|password/);
    expect(logged).toHaveBeenCalledWith('Unhandled request error:', error);
  });
});

it('hands the error to Express and writes nothing when the response has already started', () => {
  const error = new Error('late');
  const next = vi.fn();
  const res = { headersSent: true, status: vi.fn() } as unknown as Response;
  errorHandler(error, {} as Request, res, next as NextFunction);
  expect(next).toHaveBeenCalledWith(error);
  expect(res.status).not.toHaveBeenCalled();
});
