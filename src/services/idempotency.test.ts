import { describe, expect, it } from 'vitest';
import { hashOrderLines } from './idempotency.js';

describe('hashOrderLines', () => {
  it('returns 64 hex characters', () => {
    expect(hashOrderLines([{ productId: 1, quantity: 2 }])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores line order', () => {
    const a = hashOrderLines([
      { productId: 1, quantity: 2 },
      { productId: 3, quantity: 1 },
    ]);
    const b = hashOrderLines([
      { productId: 3, quantity: 1 },
      { productId: 1, quantity: 2 },
    ]);
    expect(a).toBe(b);
  });

  it('differs when a quantity differs', () => {
    expect(hashOrderLines([{ productId: 1, quantity: 2 }])).not.toBe(
      hashOrderLines([{ productId: 1, quantity: 3 }]),
    );
  });

  it('differs when a product differs', () => {
    expect(hashOrderLines([{ productId: 1, quantity: 2 }])).not.toBe(
      hashOrderLines([{ productId: 2, quantity: 2 }]),
    );
  });
});
