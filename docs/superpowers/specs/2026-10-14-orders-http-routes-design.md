# Orders HTTP routes — design

Date: 2026-10-14 · Status: awaiting review

## Goal

Expose the existing `createOrder` service over HTTP so a client can place and read orders:
`POST /orders` and `GET /orders/:id`. Success means: bad input never reaches the database, every
failure has a predictable status code, and the client never sees internals (SQL, stack traces,
table names).

## Decisions already made

- Unknown product → **422** (not 404): the route exists and the body is well-formed but refers to a
  product that does not exist. 404 stays reserved for "the thing in the URL was not found".
- Error mapping is **one central Express error handler** (`src/error-handler.ts`, mounted last).
  Route handlers stay thin and throw. Not per-route try/catch, and not errors that carry their own
  HTTP status (that would put HTTP knowledge in the service layer).
- Validation uses **zod**, for request shape only.

## Out of scope

List endpoint (`GET /orders`), cancelling or paying an order, authentication, pagination, a
response serializer, graceful shutdown
(its own saved plan), stock tracking (its own spec).

## HTTP contract

| Request | Success | Failure |
|---|---|---|
| `POST /orders` body `{"items":[{"productId":1,"quantity":2}]}` | `201` + order with items | see error table |
| `GET /orders/:id` | `200` + order with items, sorted by item id | `400` bad id, `404` no such order |

- Response body is the Sequelize model JSON (`res.json(order)`): order columns plus `items`.
  Money stays a string (`"total":"39.98"`). Tests pin the exact keys.
- Every error body is `{"status":"error","message":"..."}`. A validation 400 also has
  `"issues":[{"path":"items.0.quantity","message":"..."}]`.

## Validation (zod)

Schemas live in `src/routes/orders.ts`.

- Body: strict objects (unknown keys rejected). `items`: array of **1 to 100** entries; each entry
  `productId` and `quantity` are positive integers. The 100-line cap is new — the service has no
  line limit, and without it one 100 KB body could drive a very large query and transaction.
- The quantity ceiling, total ceiling and merging of repeated products stay in the service
  (`InvalidOrderError`, also 400). Zod checks shape only, so no rule is written twice.
- Path id: digits only, converted with `Number`, must be a safe integer ≥ 1.
- No JSON body or wrong content type: Express 5 leaves `req.body` undefined, so zod rejects it
  with 400.

## Error mapping

| Error | Status | Message |
|---|---|---|
| `ZodError` | 400 | `Invalid request` + `issues` |
| `InvalidOrderError` | 400 | its own message (written by us; contains only the client's own values) |
| body-parser `entity.parse.failed` | 400 | `Invalid JSON` |
| body-parser `entity.too.large` | 413 | `Request body too large` |
| any other error with a 4xx `status` (Express router, e.g. a URL that cannot be decoded) | that status | standard status text (e.g. `Bad Request`) |
| `ProductNotFoundError` | 422 | its own message (`Unknown product id(s): 5, 7`) |
| `OrderNotFoundError` (new) | 404 | `Order not found` |
| no route matched (`notFound`, mounted after the routes) | 404 | `Not Found` |
| known path, wrong method (`methodNotAllowed`, chained with `.all()` on each route) | 405 + `Allow` header | `Method Not Allowed` |
| MySQL unreachable: Sequelize `ConnectionError` except `AccessDeniedError` / `InvalidConnectionError` | 503 + `Retry-After: 5` | `Service Unavailable` |
| anything else | 500 | always `Internal Server Error` |

503 is only for failures that happen before the transaction starts, so a retry cannot duplicate an
order. Wrong credentials and a connection lost mid-query stay 500. `dialectOptions.connectTimeout`
is 3000 ms so an unreachable host answers 503 in about 3 s instead of 10 s.
`POST /orders` answers 201 with `Location: /orders/<id>`. `X-Powered-By` is disabled.

`OPTIONS` on a known path answers `204` with the `Allow` header instead of a 405. The two handlers
live in `src/error-handler.ts` and never echo the path or method.

- 500 path: the real error is logged with `console.error('Unhandled request error:', err)`; none of
  it reaches the response.
- Framework-error messages are fixed strings, never the library's own text.
- If headers were already sent, call `next(err)` and write nothing.

## Service change

`src/services/orders.ts` gains `OrderNotFoundError` and
`getOrder(id: number): Promise<Order>` — `Order.findByPk(id, { include: 'items' })` with items
ordered by id; throws `OrderNotFoundError` when null.

## Files

- Create `src/routes/orders.ts`, `src/error-handler.ts` (+ tests).
- Modify `src/services/orders.ts`, `src/app.ts` (`express.json()`, `app.use('/orders', router)`,
  `app.use(errorHandler)` last), `package.json` (`zod` under `dependencies` — CI's `run` job
  installs production dependencies only).
- `src/controllers/` stays unused: one router file does not need a controller layer.
- The saved plan `2026-10-10-graceful-shutdown-and-error-handling.md` Task 1 (error middleware) is
  superseded by this work; get a note there when done.

## Testing

Unit (no database, service mocked with `importActual` so the real error classes are used):

- every row of the error table, including 500 with `Error('secret SQL detail')` → body does not
  contain `secret` and the error is logged;
- bad bodies: missing, not JSON, malformed JSON, over 100 KB, unknown key, empty `items`, 101 lines,
  non-integer / zero / negative quantity, string `productId`;
- bad ids: `abc`, `0`, `-1`, `1.5`, a digit string beyond the safe-integer range.

Integration (real `_test` database, runs in `pnpm test:integration`):

- `POST` then `GET` return the same order and items;
- `POST` with an unknown product → 422 and zero rows in `orders`;
- `GET` of a missing id → 404.

Existing `/health` tests stay untouched.
