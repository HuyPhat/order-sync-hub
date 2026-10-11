import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sequelize } from '../db/sequelize.js';
import { Order, OrderItem, Product } from '../models/index.js';
import { ProductNotFoundError, createOrder } from './orders.js';

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

  // Behavior check only: the service looks every product up BEFORE writing anything, so this
  // passes even without a transaction. The two tests below are the real rollback proof.
  it('saves nothing when one product is unknown', async () => {
    const widget = await Product.create({ sku: 'W-1', name: 'Widget', price: '19.99' });
    const before = await counts();

    await expect(
      createOrder([
        { productId: widget.id, quantity: 1 },
        { productId: widget.id + 999, quantity: 1 },
      ]),
    ).rejects.toBeInstanceOf(ProductNotFoundError);

    expect(await counts()).toEqual(before);
  });

  it('rolls the order row back when saving the items fails afterwards', async () => {
    const widget = await Product.create({ sku: 'W-1', name: 'Widget', price: '19.99' });
    const before = await counts();
    const insertOrder = vi.spyOn(Order, 'create');
    vi.spyOn(OrderItem, 'bulkCreate').mockRejectedValue(new Error('disk full'));

    await expect(createOrder([{ productId: widget.id, quantity: 1 }])).rejects.toThrow('disk full');

    // The order row WAS inserted inside the transaction before the failure...
    expect(insertOrder).toHaveBeenCalledTimes(1);
    // ...and yet it is gone: the transaction rolled back.
    expect(await counts()).toEqual(before);
  });

  it('rolls everything back when MySQL itself rejects an item', async () => {
    const widget = await Product.create({ sku: 'W-1', name: 'Widget', price: '19.99' });
    const gadget = await Product.create({ sku: 'G-1', name: 'Gadget', price: '1.00' });
    const before = await counts();

    // 4294967296 passes validation but overflows the INT UNSIGNED column on insert.
    await expect(
      createOrder([
        { productId: widget.id, quantity: 1 },
        { productId: gadget.id, quantity: 4294967296 },
      ]),
    ).rejects.toThrow();

    expect(await counts()).toEqual(before);
  });
});
