import { afterEach, describe, expect, it, vi } from 'vitest';
import { sequelize } from '../db/sequelize.js';
import { InvalidOrderError, createOrder } from './orders.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// Input validation happens before any database work, so these run without MySQL.
describe('createOrder input validation', () => {
  it.each([
    ['an empty order', []],
    ['quantity 0', [{ productId: 1, quantity: 0 }]],
    ['a negative quantity', [{ productId: 1, quantity: -2 }]],
    ['a fractional quantity', [{ productId: 1, quantity: 1.5 }]],
    ['a non-integer productId', [{ productId: 1.5, quantity: 1 }]],
    ['productId 0', [{ productId: 0, quantity: 1 }]],
    ['NaN', [{ productId: 1, quantity: Number.NaN }]],
  ])('rejects %s before opening a transaction', async (_label, lines) => {
    const transaction = vi.spyOn(sequelize, 'transaction');
    await expect(createOrder(lines)).rejects.toBeInstanceOf(InvalidOrderError);
    expect(transaction).not.toHaveBeenCalled();
  });
});
