import { describe, expect, it } from 'vitest';
import { migrationName } from './migration-name.js';

describe('migrationName', () => {
  it('strips .ts so a migration run with tsx has no extension in its history', () => {
    expect(migrationName('2026.10.09T03.45.02.create-products.ts')).toBe(
      '2026.10.09T03.45.02.create-products',
    );
  });

  it('strips .js so a compiled migration run from dist/ has no extension either', () => {
    expect(migrationName('2026.10.09T03.45.02.create-products.js')).toBe(
      '2026.10.09T03.45.02.create-products',
    );
  });

  it('gives the .ts and .js build of one migration the same name', () => {
    const base = '2026.10.09T03.45.02.create-products';
    expect(migrationName(`${base}.ts`)).toBe(migrationName(`${base}.js`));
  });

  it('keeps the dots in the timestamp prefix', () => {
    expect(migrationName('2026.10.09T03.45.02.x.ts')).toBe('2026.10.09T03.45.02.x');
  });

  it('only strips a trailing extension, not "ts" or "js" inside the name', () => {
    expect(migrationName('2026.10.09T03.45.02.add-tsconfig.ts')).toBe(
      '2026.10.09T03.45.02.add-tsconfig',
    );
    expect(migrationName('2026.10.09T03.45.02.rename.js.ts')).toBe('2026.10.09T03.45.02.rename.js');
  });

  it('leaves a name without an extension unchanged', () => {
    expect(migrationName('2026.10.09T03.45.02.create-products')).toBe(
      '2026.10.09T03.45.02.create-products',
    );
  });
});
