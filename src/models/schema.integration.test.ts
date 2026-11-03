import type { Model, ModelStatic } from 'sequelize';
import { UniqueConstraintError } from 'sequelize';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { sequelize } from '../db/sequelize.js';
import { IdempotencyKey, Order, OrderItem, Product } from './index.js';

afterAll(async () => {
  await sequelize.close();
});

describe('integration test database', () => {
  it('is the test database, never the dev one', async () => {
    expect(config.db.name).toMatch(/_test$/);
    const [rows] = await sequelize.query('SELECT DATABASE() AS name');
    expect(rows).toEqual([{ name: config.db.name }]);
  });
});

// The models and the migrations describe the same tables twice; this catches them drifting apart.
const models: Array<[string, ModelStatic<Model>]> = [
  ['Product', Product],
  ['Order', Order],
  ['OrderItem', OrderItem],
  ['IdempotencyKey', IdempotencyKey],
];

describe('models match the migrated tables', () => {
  it.each(models)('%s has exactly the columns of its table', async (_name, model) => {
    const columns = Object.keys(await sequelize.getQueryInterface().describeTable(model.tableName));
    expect(Object.keys(model.getAttributes()).sort()).toEqual(columns.sort());
  });
});

describe('idempotency_keys', () => {
  const hash = 'a'.repeat(64);
  const newOrder = () => Order.create({ total: '1.00' });

  it('exists after migrating up', async () => {
    const tables = await sequelize.getQueryInterface().showAllTables();
    expect(tables).toContain('idempotency_keys');
  });

  it('keys that differ only in case are distinct rows', async () => {
    const [a, b] = [await newOrder(), await newOrder()];
    await IdempotencyKey.create({ idempotencyKey: 'Ab', requestHash: hash, orderId: a.id });
    await expect(
      IdempotencyKey.create({ idempotencyKey: 'ab', requestHash: hash, orderId: b.id }),
    ).resolves.toBeDefined();
  });

  it('a duplicate key is rejected', async () => {
    const [a, b] = [await newOrder(), await newOrder()];
    await IdempotencyKey.create({ idempotencyKey: 'Dup', requestHash: hash, orderId: a.id });
    await expect(
      IdempotencyKey.create({ idempotencyKey: 'Dup', requestHash: hash, orderId: b.id }),
    ).rejects.toBeInstanceOf(UniqueConstraintError);
  });

  it('one order cannot have two keys', async () => {
    const order = await newOrder();
    await IdempotencyKey.create({ idempotencyKey: 'One', requestHash: hash, orderId: order.id });
    await expect(
      IdempotencyKey.create({ idempotencyKey: 'Two', requestHash: hash, orderId: order.id }),
    ).rejects.toBeInstanceOf(UniqueConstraintError);
  });

  it('deleting an order deletes its key', async () => {
    const order = await newOrder();
    await IdempotencyKey.create({ idempotencyKey: 'Gone', requestHash: hash, orderId: order.id });
    await order.destroy();
    expect(await IdempotencyKey.findByPk('Gone')).toBeNull();
  });
});
