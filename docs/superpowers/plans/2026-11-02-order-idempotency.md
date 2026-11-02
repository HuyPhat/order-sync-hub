# Idempotent `POST /orders`

Status: open, deferred (do after graceful shutdown). A client that retries after a timeout currently
creates a second order, because `createOrder` has no way to recognise a repeat.

## Design
Optional `Idempotency-Key` request header (client-generated, e.g. a UUID, max 64 chars).
- No header: behaviour unchanged.
- Header present and new: create the order and remember the key.
- Same key, same body: return the original order (status 200, same JSON, same `Location`), no new row.
- Same key, different body: 422 `idempotency_key_reused` (a client bug, never silently pick one).

## Steps
1. **Migration** `src/db/migrations/<timestamp>.add-orders-idempotency.ts` (create with `pnpm db:create --name add-orders-idempotency`):
   - `orders.idempotencyKey VARCHAR(64) NULL`, `orders.requestHash CHAR(64) NULL` (SHA-256 of the canonical body);
   - `UNIQUE INDEX orders_idempotency_key (idempotencyKey)`. MySQL allows many NULLs in a unique index,
     so orders without a key are unaffected.
   - `down` removes the index, then the columns.
2. **Model** `src/models/order.ts`: add the two nullable attributes; update `order.test.ts`.
3. **Route** `src/routes/orders.ts`: read and validate the header with zod (`z.string().min(1).max(64).optional()`), pass it to the service.
4. **Service** `src/services/orders.ts`: `createOrder(items, { idempotencyKey })`.
   - Hash the merged line items (sort by productId so order of lines doesn't matter).
   - Look up by key first; if found, compare hash -> return existing / throw the 422 error.
   - Otherwise insert inside the existing transaction. If the insert fails with
     `SequelizeUniqueConstraintError` on the key (two concurrent retries), re-read and treat as the found case.
     The unique index, not the pre-check, is what guarantees no duplicates.
   - Return `{ order, created }` so the route can pick 201 vs 200.
5. **Error handler** `src/error-handler.ts`: map the new error to 422 JSON in the existing format.
6. **Tests**: unit (service with mocks, route status codes) and integration
   (`orders.integration.test.ts`: repeat returns same id and one row; different body -> 422; concurrent
   `Promise.all` of two identical requests yields one row).
7. Update the orders design spec with the header and the 200/201/422 behaviour.

## Open questions
- Key expiry (keys kept forever is fine at current volume; add a cleanup job only if the table grows).
- Whether to scope keys per client once authentication exists.

## Done when
All checks pass locally and `pnpm test:integration` passes against MySQL (CI runs it).
