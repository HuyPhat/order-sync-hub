import type { Model, ModelStatic } from 'sequelize';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { sequelize } from '../db/sequelize.js';
import { Order, OrderItem, Product } from './index.js';

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
];

describe('models match the migrated tables', () => {
  it.each(models)('%s has exactly the columns of its table', async (_name, model) => {
    const columns = Object.keys(await sequelize.getQueryInterface().describeTable(model.tableName));
    expect(Object.keys(model.getAttributes()).sort()).toEqual(columns.sort());
  });
});
