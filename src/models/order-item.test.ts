import { describe, expect, it } from 'vitest';
import { OrderItem } from './order-item.js';

describe('OrderItem model', () => {
  it('maps to the order_items table', () => {
    expect(OrderItem.tableName).toBe('order_items');
  });

  it('declares exactly the migration columns', () => {
    expect(Object.keys(OrderItem.getAttributes()).sort()).toEqual([
      'createdAt',
      'id',
      'orderId',
      'productId',
      'quantity',
      'unitPrice',
      'updatedAt',
    ]);
  });

  it('requires orderId, productId, quantity and unitPrice', () => {
    const attrs = OrderItem.getAttributes();
    for (const column of ['orderId', 'productId', 'quantity', 'unitPrice'] as const) {
      expect(attrs[column]?.allowNull, column).toBe(false);
    }
  });

  it('uses DECIMAL(10,2) for unitPrice, the same as Product.price', () => {
    expect(String(OrderItem.getAttributes().unitPrice?.type)).toBe('DECIMAL(10,2)');
  });

  it('builds an instance with typed fields, without touching the database', () => {
    const item = OrderItem.build({ orderId: 1, productId: 2, quantity: 3, unitPrice: '4.50' });
    expect(item.orderId).toBe(1);
    expect(item.productId).toBe(2);
    expect(item.quantity).toBe(3);
    expect(item.unitPrice).toBe('4.50');
  });

  it('rejects wrong shapes at compile time', () => {
    // @ts-expect-error orderId is required (Sequelize's ForeignKey<> helper would make it optional)
    OrderItem.build({ productId: 2, quantity: 3, unitPrice: '4.50' });
    // @ts-expect-error productId is required
    OrderItem.build({ orderId: 1, quantity: 3, unitPrice: '4.50' });
    // @ts-expect-error quantity is required
    OrderItem.build({ orderId: 1, productId: 2, unitPrice: '4.50' });
    // @ts-expect-error unitPrice is a string, not a number
    OrderItem.build({ orderId: 1, productId: 2, quantity: 3, unitPrice: 4.5 });
  });
});
