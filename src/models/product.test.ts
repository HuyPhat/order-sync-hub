import { describe, expect, it } from 'vitest';
import { Product } from './product.js';

describe('Product Model', () => {
  it('maps to the products table', () => {
    expect(Product.tableName).toBe('products');
  });

  it('declares exactly the migration columns', () => {
    expect(Object.keys(Product.getAttributes()).sort()).toEqual([
      'createdAt',
      'id',
      'name',
      'price',
      'sku',
      'updatedAt',
    ]);
  });

  it('requires sku, name and price, and makes sku unique', () => {
    const attrs = Product.getAttributes();
    expect(attrs.sku?.allowNull).toBe(false);
    expect(attrs.sku?.unique).toBe(true);
    expect(attrs.name?.allowNull).toBe(false);
    expect(attrs.price?.allowNull).toBe(false);
  });

  it('uses DECIMAL(10,2) for price', () => {
    expect(String(Product.getAttributes().price?.type)).toBe('DECIMAL(10,2)');
  });

  it('builds an instance with typed fields, without touching the database', () => {
    const product = Product.build({ sku: 'SKU-1', name: 'Widget', price: '19.99' });
    expect(product.sku).toBe('SKU-1');
    expect(product.name).toBe('Widget');
    expect(product.price).toBe('19.99');
  });

  it('rejects wrong shapes at compile time', () => {
    // Checked by `pnpm typecheck`: each @ts-expect-error fails the typecheck
    // if the line below it stops being an error.
    // @ts-expect-error sku is required
    Product.build({ name: 'Widget', price: '19.99' });
    // @ts-expect-error price is a string, not a number
    Product.build({ sku: 'SKU-1', name: 'Widget', price: 19.99 });
    // @ts-expect-error unknown field
    Product.build({ sku: 'SKU-1', name: 'Widget', price: '19.99', color: 'red' });
  });
});
