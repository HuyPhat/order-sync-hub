import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../app.js';
import { sequelize } from '../db/sequelize.js';
import { Order, OrderItem, Product } from '../models/index.js';

// Runs against the TEST database (see vitest.integration.config.ts): the real app, the real
// service and real MySQL, with nothing mocked.
beforeEach(async () => {
  await OrderItem.destroy({ where: {} });
  await Order.destroy({ where: {} });
  await Product.destroy({ where: {} });
});

afterAll(async () => {
  await sequelize.close();
});

describe('POST /orders then GET /orders/:id', () => {
  it('returns the order that was created, with prices and total computed', async () => {
    const widget = await Product.create({ sku: 'W-1', name: 'Widget', price: '19.99' });
    const gadget = await Product.create({ sku: 'G-1', name: 'Gadget', price: '0.10' });

    const created = await request(app)
      .post('/orders')
      .send({
        items: [
          { productId: widget.id, quantity: 2 },
          { productId: gadget.id, quantity: 3 },
        ],
      });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'pending', total: '40.28' });
    expect(created.body.items).toHaveLength(2);

    const fetched = await request(app).get(`/orders/${created.body.id}`);

    expect(fetched.status).toBe(200);
    // POST promises no item order; GET sorts by id. Sort POST's items to compare like with like.
    const byId = (a: { id: number }, b: { id: number }) => a.id - b.id;
    expect(fetched.body).toEqual({
      ...created.body,
      items: [...created.body.items].sort(byId),
    });
  });
});

describe('the fields a client receives', () => {
  it('are exactly these, so a column added later never reaches clients by accident', async () => {
    const widget = await Product.create({ sku: 'W-1', name: 'Widget', price: '19.99' });
    const created = await request(app)
      .post('/orders')
      .send({ items: [{ productId: widget.id, quantity: 1 }] });
    const fetched = await request(app).get(`/orders/${created.body.id}`);

    for (const body of [created.body, fetched.body]) {
      expect(Object.keys(body).sort()).toEqual([
        'createdAt',
        'id',
        'items',
        'status',
        'total',
        'updatedAt',
      ]);
      expect(Object.keys(body.items[0]).sort()).toEqual([
        'createdAt',
        'id',
        'orderId',
        'productId',
        'quantity',
        'unitPrice',
        'updatedAt',
      ]);
    }
  });
});

describe('POST /orders with an unknown product', () => {
  it('answers 422 and saves nothing', async () => {
    const widget = await Product.create({ sku: 'W-1', name: 'Widget', price: '19.99' });

    const res = await request(app)
      .post('/orders')
      .send({
        items: [
          { productId: widget.id, quantity: 1 },
          { productId: widget.id + 1000, quantity: 1 },
        ],
      });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      status: 'error',
      message: `Unknown product id(s): ${widget.id + 1000}`,
    });
    expect(await Order.count()).toBe(0);
    expect(await OrderItem.count()).toBe(0);
  });
});

describe('POST /orders with a quantity the database column cannot hold', () => {
  it('answers 400 from the service rule (zod only checks the shape) and saves nothing', async () => {
    const widget = await Product.create({ sku: 'W-1', name: 'Widget', price: '19.99' });

    const res = await request(app)
      .post('/orders')
      .send({ items: [{ productId: widget.id, quantity: 4294967296 }] });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ status: 'error' });
    expect(res.body.message).toMatch(/exceeds 4294967295/);
    expect(await Order.count()).toBe(0);
  });
});

describe('GET /orders/:id for an order that does not exist', () => {
  it('answers 404', async () => {
    const res = await request(app).get('/orders/999999');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ status: 'error', message: 'Order not found' });
  });
});
