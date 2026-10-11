import { describe, expect, it } from 'vitest';
import { Order, OrderItem, Product } from './index.js';

describe('model associations', () => {
  it('an order has many items, linked through orderId', () => {
    const association = Order.associations.items;
    expect(association?.associationType).toBe('HasMany');
    expect(association?.foreignKey).toBe('orderId');
    expect(association?.target).toBe(OrderItem);
  });

  it('an item belongs to its order, through orderId', () => {
    const association = OrderItem.associations.order;
    expect(association?.associationType).toBe('BelongsTo');
    expect(association?.foreignKey).toBe('orderId');
    expect(association?.target).toBe(Order);
  });

  it('an item belongs to its product, through productId', () => {
    const association = OrderItem.associations.product;
    expect(association?.associationType).toBe('BelongsTo');
    expect(association?.foreignKey).toBe('productId');
    expect(association?.target).toBe(Product);
  });
});
