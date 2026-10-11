import { describe, expect, it } from 'vitest';
import { Order } from './order.js';

describe('Order model', () => {
  it('maps to the orders table', () => {
    expect(Order.tableName).toBe('orders');
  });

  it('declares exactly the migration columns', () => {
    expect(Object.keys(Order.getAttributes()).sort()).toEqual([
      'createdAt',
      'id',
      'status',
      'total',
      'updatedAt',
    ]);
  });

  it('requires status and total, and defaults status to pending', () => {
    const attrs = Order.getAttributes();
    expect(attrs.status?.allowNull).toBe(false);
    expect(attrs.status?.defaultValue).toBe('pending');
    expect(attrs.total?.allowNull).toBe(false);
  });

  it('limits status to pending, paid and cancelled', () => {
    // Sequelize does not type the ENUM's values, hence the cast.
    const type = Order.getAttributes().status?.type as unknown as { values: string[] };
    expect(type.values).toEqual(['pending', 'paid', 'cancelled']);
  });

  it('uses DECIMAL(12,2) for total', () => {
    expect(String(Order.getAttributes().total?.type)).toBe('DECIMAL(12,2)');
  });

  it('builds with a pending status by default, without touching the database', () => {
    const order = Order.build({ total: '10.00' });
    expect(order.total).toBe('10.00');
    expect(order.status).toBe('pending');
  });

  it('rejects wrong shapes at compile time', () => {
    // Checked by `pnpm typecheck`: each @ts-expect-error fails the typecheck
    // if the line below it stops being an error.
    // @ts-expect-error total is required
    Order.build({});
    // @ts-expect-error total is a string, not a number
    Order.build({ total: 10 });
    // @ts-expect-error status must be pending, paid or cancelled
    Order.build({ total: '10.00', status: 'shipped' });
  });
});
