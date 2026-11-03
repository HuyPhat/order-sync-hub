import { createHash } from 'node:crypto';
import type { OrderLine } from './orders.js';

// Fingerprint of a request: SHA-256 of the lines sorted by productId. Expects lines that were
// already merged (one line per product), so the same set of lines always hashes the same.
export function hashOrderLines(lines: OrderLine[]): string {
  const canonical = [...lines]
    .sort((a, b) => a.productId - b.productId)
    .map(({ productId, quantity }) => ({ productId, quantity }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
