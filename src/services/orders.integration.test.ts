import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sequelize } from '../db/sequelize.js';
import { Order, OrderItem, Product } from '../models/index.js';
import { InvalidOrderError, ProductNotFoundError, createOrder } from './orders.js';

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
    const before = await counts();
    const insertOrder = vi.spyOn(Order, 'create');
    // Let the real INSERT run, but point the item at a product that does not exist, so MySQL's
    // foreign key rejects it after the order row has already been written.
    const realBulkCreate = OrderItem.bulkCreate.bind(OrderItem);
    vi.spyOn(OrderItem, 'bulkCreate').mockImplementation(((rows: Array<object>, options: object) =>
      realBulkCreate(
        rows.map((row) => ({ ...row, productId: 999_999_999 })) as never,
        options as never,
      )) as never);

    await expect(createOrder([{ productId: widget.id, quantity: 1 }])).rejects.toMatchObject({
      name: 'SequelizeForeignKeyConstraintError',
    });

    expect(insertOrder).toHaveBeenCalledTimes(1); // the order row was written first...
    expect(await counts()).toEqual(before); // ...and rolled back
  });

  it('rejects an order whose total is too large for the column, and saves nothing', async () => {
    const pricey = await Product.create({ sku: 'P-1', name: 'Pricey', price: '99999999.99' });
    const before = await counts();

    // 101 x 99999999.99 = 10099999999.99, above the 9999999999.99 the total column can hold.
    await expect(createOrder([{ productId: pricey.id, quantity: 101 }])).rejects.toBeInstanceOf(
      InvalidOrderError,
    );

    expect(await counts()).toEqual(before);
  });

  it('accepts the largest total the column can hold', async () => {
    const pricey = await Product.create({ sku: 'P-1', name: 'Pricey', price: '99999999.99' });
    const order = await createOrder([{ productId: pricey.id, quantity: 100 }]);
    expect(order.total).toBe('9999999999.00');
  });

  it('accepts the largest quantity the column can hold', async () => {
    const free = await Product.create({ sku: 'F-1', name: 'Free', price: '0.00' });
    const order = await createOrder([{ productId: free.id, quantity: 4294967295 }]);
    expect(order.items?.[0]?.quantity).toBe(4294967295);
  });
});
