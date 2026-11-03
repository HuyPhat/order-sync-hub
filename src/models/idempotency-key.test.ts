import { describe, expect, it } from 'vitest';
import { IdempotencyKey } from './idempotency-key.js';

describe('IdempotencyKey model', () => {
  it('maps to the idempotency_keys table', () => {
    expect(IdempotencyKey.tableName).toBe('idempotency_keys');
  });

  it('declares exactly the migration columns', () => {
    expect(Object.keys(IdempotencyKey.getAttributes()).sort()).toEqual([
      'createdAt',
      'idempotencyKey',
      'orderId',
      'requestHash',
    ]);
  });

  it('idempotencyKey is the primary key', () => {
    expect(IdempotencyKey.primaryKeyAttributes).toEqual(['idempotencyKey']);
  });

  it('requires requestHash and orderId', () => {
    const attrs = IdempotencyKey.getAttributes();
    expect(attrs.requestHash?.allowNull).toBe(false);
    expect(attrs.orderId?.allowNull).toBe(false);
  });
});
