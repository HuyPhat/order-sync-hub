import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../app.js';
import {
  IdempotencyKeyReusedError,
  InvalidOrderError,
  OrderNotFoundError,
  ProductNotFoundError,
  createOrder,
  createOrderOnce,
  getOrder,
} from '../services/orders.js';

// The service is mocked (these tests need no database) but its real error classes are kept,
// because the error handler recognises errors with instanceof.
vi.mock('../services/orders.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/orders.js')>()),
  createOrder: vi.fn(),
  createOrderOnce: vi.fn(),
  getOrder: vi.fn(),
}));

const createOrderMock = vi.mocked(createOrder);
const createOrderOnceMock = vi.mocked(createOrderOnce);
const getOrderMock = vi.mocked(getOrder);

// What res.json receives is whatever the service returns; a plain object is enough here.
const savedOrder = {
  id: 1,
  status: 'pending',
  total: '39.98',
  items: [{ id: 1, orderId: 1, productId: 3, quantity: 2, unitPrice: '19.99' }],
} as unknown as Awaited<ReturnType<typeof createOrder>>;

beforeEach(() => {
  createOrderMock.mockReset();
  createOrderOnceMock.mockReset();
  getOrderMock.mockReset();
});

describe('POST /orders', () => {
  it('creates the order and answers 201 with it', async () => {
    createOrderMock.mockResolvedValue(savedOrder);
    const res = await request(app)
      .post('/orders')
      .send({ items: [{ productId: 3, quantity: 2 }] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(JSON.parse(JSON.stringify(savedOrder)));
    expect(createOrderMock).toHaveBeenCalledWith([{ productId: 3, quantity: 2 }]);
  });

  it('points Location at the new order', async () => {
    createOrderMock.mockResolvedValue(savedOrder);
    const res = await request(app)
      .post('/orders')
      .send({ items: [{ productId: 3, quantity: 2 }] });
    expect(res.headers['location']).toBe('/orders/1');
  });

  it('passes a repeated product through unchanged, because the service merges them', async () => {
    createOrderMock.mockResolvedValue(savedOrder);
    const items = [
      { productId: 3, quantity: 1 },
      { productId: 3, quantity: 2 },
    ];
    const res = await request(app).post('/orders').send({ items });
    expect(res.status).toBe(201);
    expect(createOrderMock).toHaveBeenCalledWith(items);
  });

  it('accepts exactly 100 lines', async () => {
    createOrderMock.mockResolvedValue(savedOrder);
    const items = Array.from({ length: 100 }, (_, i) => ({ productId: i + 1, quantity: 1 }));
    const res = await request(app).post('/orders').send({ items });
    expect(res.status).toBe(201);
  });

  it.each([
    ['no body at all', undefined],
    ['a body that is not an object', [1, 2]],
    ['no items key', {}],
    ['items that is not an array', { items: 'x' }],
    ['an empty items array', { items: [] }],
    [
      '101 lines',
      { items: Array.from({ length: 101 }, (_, i) => ({ productId: i + 1, quantity: 1 })) },
    ],
    ['an unknown key on the body', { items: [{ productId: 1, quantity: 1 }], note: 'hi' }],
    ['an unknown key on a line', { items: [{ productId: 1, quantity: 1, price: '0.01' }] }],
    ['a string productId', { items: [{ productId: '1', quantity: 1 }] }],
    ['a missing quantity', { items: [{ productId: 1 }] }],
    ['quantity 0', { items: [{ productId: 1, quantity: 0 }] }],
    ['a negative quantity', { items: [{ productId: 1, quantity: -1 }] }],
    ['a fractional quantity', { items: [{ productId: 1, quantity: 1.5 }] }],
    ['an unsafe integer productId', { items: [{ productId: 2 ** 53, quantity: 1 }] }],
    ['null', null],
  ])('rejects %s with 400 before calling the service', async (_label, body) => {
    const req = request(app).post('/orders');
    const res = await (body === undefined ? req : req.send(body as object));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ status: 'error', message: 'Invalid request' });
    expect(res.body.issues.length).toBeGreaterThan(0);
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it('points at the bad field in the issues', async () => {
    const res = await request(app)
      .post('/orders')
      .send({
        items: [
          { productId: 1, quantity: 1 },
          { productId: 2, quantity: 0 },
        ],
      });
    expect(res.body.issues).toEqual([{ path: 'items.1.quantity', message: expect.any(String) }]);
  });

  it('rejects a body that is not JSON with 400', async () => {
    const res = await request(app).post('/orders').set('Content-Type', 'text/plain').send('items');
    expect(res.status).toBe(400);
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON with 400 "Invalid JSON"', async () => {
    const res = await request(app)
      .post('/orders')
      .set('Content-Type', 'application/json')
      .send('{"items": [');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ status: 'error', message: 'Invalid JSON' });
  });

  it('rejects a body over 100 kb with 413', async () => {
    const res = await request(app)
      .post('/orders')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ items: [], pad: 'x'.repeat(200_000) }));
    expect(res.status).toBe(413);
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it('maps InvalidOrderError from the service to 400', async () => {
    createOrderMock.mockRejectedValue(new InvalidOrderError('Order total exceeds 9999999999.99'));
    const res = await request(app)
      .post('/orders')
      .send({ items: [{ productId: 1, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ status: 'error', message: 'Order total exceeds 9999999999.99' });
  });

  it('maps ProductNotFoundError to 422', async () => {
    createOrderMock.mockRejectedValue(new ProductNotFoundError([5, 7]));
    const res = await request(app)
      .post('/orders')
      .send({ items: [{ productId: 5, quantity: 1 }] });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ status: 'error', message: 'Unknown product id(s): 5, 7' });
  });

  it('answers 500 without leaking when the service fails unexpectedly', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    createOrderMock.mockRejectedValue(new Error("Table 'order_sync_hub.orders' doesn't exist"));
    const res = await request(app)
      .post('/orders')
      .send({ items: [{ productId: 1, quantity: 1 }] });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ status: 'error', message: 'Internal Server Error' });
    expect(res.text).not.toMatch(/order_sync_hub|Table/);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe('POST /orders with an Idempotency-Key header', () => {
  const items = [{ productId: 3, quantity: 2 }];

  it('without the header it calls createOrder and never createOrderOnce', async () => {
    createOrderMock.mockResolvedValue(savedOrder);
    const res = await request(app).post('/orders').send({ items });
    expect(res.status).toBe(201);
    expect(createOrderMock).toHaveBeenCalledWith(items);
    expect(createOrderOnceMock).not.toHaveBeenCalled();
  });

  it('with a key and created: true it answers 201 with Location', async () => {
    createOrderOnceMock.mockResolvedValue({ order: savedOrder, created: true });
    const res = await request(app).post('/orders').set('Idempotency-Key', 'key-1').send({ items });
    expect(res.status).toBe(201);
    expect(res.headers['location']).toBe('/orders/1');
    expect(res.body).toEqual(JSON.parse(JSON.stringify(savedOrder)));
    expect(createOrderOnceMock).toHaveBeenCalledWith('key-1', items);
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it('with a key and created: false it answers 200 with the same body and Location', async () => {
    createOrderOnceMock.mockResolvedValue({ order: savedOrder, created: false });
    const res = await request(app).post('/orders').set('Idempotency-Key', 'key-1').send({ items });
    expect(res.status).toBe(200);
    expect(res.headers['location']).toBe('/orders/1');
    expect(res.body).toEqual(JSON.parse(JSON.stringify(savedOrder)));
  });

  it('answers 422 when createOrderOnce throws IdempotencyKeyReusedError', async () => {
    createOrderOnceMock.mockRejectedValue(new IdempotencyKeyReusedError());
    const res = await request(app).post('/orders').set('Idempotency-Key', 'key-1').send({ items });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      status: 'error',
      message: 'Idempotency-Key was already used with a different request',
    });
  });

  it.each([
    ['an empty key', ''],
    ['a 65 character key', 'a'.repeat(65)],
    ['a key with a space', 'has space'],
    ['a key with a non-ASCII character', 'café'],
  ])('rejects %s with 400 and calls no service', async (_label, key) => {
    const res = await request(app).post('/orders').set('Idempotency-Key', key).send({ items });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ status: 'error', message: 'Invalid request' });
    expect(createOrderOnceMock).not.toHaveBeenCalled();
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it('names the Idempotency-Key header in the issues of a bad key', async () => {
    const res = await request(app)
      .post('/orders')
      .set('Idempotency-Key', 'has space')
      .send({ items });
    expect(res.status).toBe(400);
    expect(res.body.issues).toEqual([
      { path: 'Idempotency-Key', message: expect.stringContaining('1 to 64') },
    ]);
  });

  it('rejects two keys joined into one header value (a repeated header) with 400', async () => {
    const res = await request(app)
      .post('/orders')
      .set('Idempotency-Key', 'key-1, key-2')
      .send({ items });
    expect(res.status).toBe(400);
    expect(createOrderOnceMock).not.toHaveBeenCalled();
  });

  it('accepts a 64 character key', async () => {
    createOrderOnceMock.mockResolvedValue({ order: savedOrder, created: true });
    const key = 'a'.repeat(64);
    const res = await request(app).post('/orders').set('Idempotency-Key', key).send({ items });
    expect(res.status).toBe(201);
    expect(createOrderOnceMock).toHaveBeenCalledWith(key, items);
  });

  it('rejects an invalid body with a valid key as 400 without calling the service', async () => {
    const res = await request(app)
      .post('/orders')
      .set('Idempotency-Key', 'key-1')
      .send({ items: [] });
    expect(res.status).toBe(400);
    expect(createOrderOnceMock).not.toHaveBeenCalled();
  });
});

describe('GET /orders/:id', () => {
  it('answers 200 with the order, asking the service for a number', async () => {
    getOrderMock.mockResolvedValue(savedOrder);
    const res = await request(app).get('/orders/7');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(JSON.parse(JSON.stringify(savedOrder)));
    expect(getOrderMock).toHaveBeenCalledWith(7);
  });

  it.each(['abc', '0', '-1', '1.5', '1e3', '007x', '99999999999999999999'])(
    'rejects the id %s with 400 before calling the service',
    async (id) => {
      const res = await request(app).get(`/orders/${id}`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ status: 'error', message: 'Invalid request' });
      expect(getOrderMock).not.toHaveBeenCalled();
    },
  );

  it('rejects an id with a broken percent-encoding with 400, not a server error', async () => {
    const res = await request(app).get('/orders/%E0%A4%A');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ status: 'error', message: 'Bad Request' });
    expect(getOrderMock).not.toHaveBeenCalled();
  });

  it('maps OrderNotFoundError to 404', async () => {
    getOrderMock.mockRejectedValue(new OrderNotFoundError(99));
    const res = await request(app).get('/orders/99');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ status: 'error', message: 'Order not found' });
  });

  it('answers 500 without leaking when the service fails unexpectedly', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    getOrderMock.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:3306'));
    const res = await request(app).get('/orders/1');
    expect(res.status).toBe(500);
    expect(res.text).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
    logged.mockRestore();
  });
});

describe('body parsing is limited to /orders', () => {
  it('does not turn a bad JSON body on /health into a 400', async () => {
    const res = await request(app)
      .post('/health')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(res.status).toBe(405);
  });
});
