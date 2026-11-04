import { describe, expect, it } from 'vitest';
import { Order, OrderItem } from './index.js';

describe('model associations', () => {
  it('an order has many items, linked through orderId', () => {
    const association = Order.associations.items;
    expect(association?.associationType).toBe('HasMany');
    expect(association?.foreignKey).toBe('orderId');
    expect(association?.target).toBe(OrderItem);
  });
});
