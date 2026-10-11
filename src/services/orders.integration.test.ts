import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sequelize } from '../db/sequelize.js';
import { Order, OrderItem, Product } from '../models/index.js';
import { createOrder } from './orders.js';

// Runs against the TEST database (see vitest.integration.config.ts), never the dev database.
async function counts() {
  return {
    orders: await Order.count(),
    items: await OrderItem.count(),
    products: await Product.count(),
  };
}

beforeEach(async () => {
  await OrderItem.destroy({ where: {} });
  await Order.destroy({ where: {} });
  await Product.destroy({ where: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await sequelize.close();
});

describe('createOrder', () => {
  it('saves the order and its items with prices snapshotted and the total computed', async () => {
    const widget = await Product.create({ sku: 'W-1', name: 'Widget', price: '19.99' });
    const gadget = await Product.create({ sku: 'G-1', name: 'Gadget', price: '0.10' });

    const order = await createOrder([
      { productId: widget.id, quantity: 2 },
      { productId: gadget.id, quantity: 3 },
    ]);

    expect(order.status).toBe('pending');
    expect(order.total).toBe('40.28'); // 2 x 19.99 + 3 x 0.10, exact
    expect(order.items).toHaveLength(2);
    expect(await counts()).toEqual({ orders: 1, items: 2, products: 2 });
  });

  it('keeps the price it saw even if the product price changes later', async () => {
    const widget = await Product.create({ sku: 'W-1', name: 'Widget', price: '19.99' });
    const order = await createOrder([{ productId: widget.id, quantity: 1 }]);

    await widget.update({ price: '99.00' });

    const item = await OrderItem.findOne({ where: { orderId: order.id } });
    expect(item?.unitPrice).toBe('19.99');
  });

  it('merges a product that appears twice into one line', async () => {
    const widget = await Product.create({ sku: 'W-1', name: 'Widget', price: '5.00' });
    const order = await createOrder([
      { productId: widget.id, quantity: 1 },
      { productId: widget.id, quantity: 2 },
    ]);
    expect(order.items).toHaveLength(1);
    expect(order.items?.[0]?.quantity).toBe(3);
    expect(order.total).toBe('15.00');
  });
});
