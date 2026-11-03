# Orders HTTP Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a client place and read orders over HTTP: `POST /orders` and `GET /orders/:id`, with the body validated by zod and every failure answered with a predictable status code and no internal detail.

**Architecture:** A thin Express router (`src/routes/orders.ts`) parses and validates input with zod, then calls the existing service (`createOrder`, plus a new `getOrder`). Handlers throw; one error handler (`src/error-handler.ts`), mounted last on the app, is the only place that decides status codes and what the client is told. The service layer stays free of HTTP knowledge.

**Tech Stack:** Express 5, zod 4, Sequelize 6, Vitest 5 and supertest, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-14-orders-http-routes-design.md`

## Global Constraints

- ESM with `module: nodenext`: relative imports end in `.js`; `verbatimModuleSyntax` is on, so type-only imports use `import type` or inline `type`.
- `zod` goes under `dependencies`, not `devDependencies`: CI's `run` job installs production dependencies only and boots the built server.
- Money fields stay strings (`"total":"39.98"`). Never convert them to numbers.
- Every error body is `{"status":"error","message":"..."}`; a validation 400 also has `"issues":[{"path","message"}]`.
- A 500 body is always exactly `{"status":"error","message":"Internal Server Error"}`. The real error is only logged with `console.error('Unhandled request error:', err)`.
- Status mapping: `ZodError` 400, `InvalidOrderError` 400, malformed JSON 400, body over 100 KB 413, `ProductNotFoundError` 422, `OrderNotFoundError` 404, anything else 500.
- `POST /orders` accepts 1 to 100 lines. Zod checks shape only; the quantity and total ceilings and merging of repeated products stay in the service.
- Commit messages carry no `Co-Authored-By` trailer (the user's standing preference). Do not push or open a PR; finishing the branch is the user's choice.
- Run `pnpm format` before every commit; `pnpm format:check`, `pnpm typecheck` and `pnpm test` must be green at every commit.

## Review Focus

Failure modes the spec implies that are easy to miss. Each is pinned by a named test.

1. **A repeated product in the body** (`[{3,1},{3,2}]`) must reach the service untouched so it can merge them, not be rejected by zod. Pinned by `passes a repeated product through unchanged, because the service merges them` (Task 3).
2. **A quantity the database column cannot hold** (`4294967296`) is valid in shape, so zod lets it through; the service must still turn it into a 400 and save nothing. Pinned by the integration test `answers 400 from the service rule` (Task 3).
3. **A bad `Content-Type` or no body at all** must be a 400, not a crash on `undefined`. Pinned by `no body at all` and `rejects a body that is not JSON with 400` (Task 3).
4. **A huge digit string as an id** (`/orders/99999999999999999999`) becomes `1e20` as a number; it must be a 400, not a database query. Pinned by the `rejects the id ... with 400` cases (Task 3).
5. **A bad JSON body sent to a route that is not `/orders`** (`POST /health`) must stay a 404; body parsing is mounted on the orders router only. Pinned by `does not turn a bad JSON body on /health into a 400` (Task 3).

## Deviations from the spec (decided while writing this plan)

- **Body parser location.** The spec says `express.json()` is added in `app.ts`. This plan mounts it on the orders router (`ordersRouter.use(express.json())`) instead, so a malformed body sent to `/health` or any future non-order route is not turned into a 400 by an unrelated parser. Cost if wrong: none; moving it to `app.ts` is one line, and the `/health` test in Task 3 is the only thing that would fail.
- **Issue path for the id.** `GET /orders/abc` is a 400 whose issue has `"path":""` because the id is validated on its own. The spec only shows body paths (`items.0.quantity`). Cost if wrong: none.

## File Structure

| File | Responsibility |
|---|---|
| `src/services/orders.ts` (modify) | Add `OrderNotFoundError` and `getOrder(id)`. |
| `src/services/orders.integration.test.ts` (modify) | Two `getOrder` tests against the real test database. |
| `src/error-handler.ts` (create) | The last Express middleware: maps errors to status and body, logs the rest. |
| `src/error-handler.test.ts` (create) | Unit tests against a tiny throw-away Express app. |
| `src/routes/orders.ts` (create) | Router, zod schemas, the two handlers. |
| `src/routes/orders.test.ts` (create) | Route tests with the service mocked (no database). |
| `src/routes/orders.integration.test.ts` (create) | End-to-end through the real app and MySQL. |
| `src/app.ts` (modify) | Mount the router and, last, the error handler. |
| `package.json`, `pnpm-lock.yaml` (modify) | Add `zod`. |

`src/controllers/` and the other empty folders stay as they are: one router file does not need a controller layer.

## Baseline (do this before Task 1)

- [ ] **Step 0: Branch, database and baseline numbers**

```bash
git status --short                       # must print nothing
git switch -c feature/orders-routes
docker compose up -d && docker compose ps   # wait until mysql shows (healthy)
bash scripts/create-test-db.sh
pnpm test 2>&1 | tail -6
pnpm test:integration 2>&1 | tail -6
```

Expected: no uncommitted files; branch created from `main`; `pnpm test` reports `Tests  77 passed (77)`; `pnpm test:integration` reports `Tests  13 passed (13)`. If the baseline differs, stop and find out why before changing anything: every later "Expected" count is baseline plus this plan's additions.

---

### Task 1: `getOrder` and `OrderNotFoundError`

**Files:**
- Modify: `src/services/orders.ts`
- Test: `src/services/orders.integration.test.ts` (needs MySQL running)

**Interfaces:**
- Consumes: `Order`, `OrderItem` from `../models/index.js` (already imported in `orders.ts`).
- Produces: `export class OrderNotFoundError extends Error` with `readonly orderId: number` and message `Order <id> not found`; `export async function getOrder(id: number): Promise<Order>`, which returns the order with `items` included and sorted by item id, or throws `OrderNotFoundError`. Task 2 imports the class; Task 3 imports `getOrder`.

- [ ] **Step 1: Write the failing tests**

In `src/services/orders.integration.test.ts`, replace the existing import from `./orders.js`:

```ts
import { InvalidOrderError, ProductNotFoundError, createOrder } from './orders.js';
```

with:

```ts
import {
  InvalidOrderError,
  OrderNotFoundError,
  ProductNotFoundError,
  createOrder,
  getOrder,
} from './orders.js';
```

and append to the end of the file:

```ts
describe('getOrder', () => {
  it('returns the saved order with its items sorted by id', async () => {
    const widget = await Product.create({ sku: 'W-1', name: 'Widget', price: '19.99' });
    const gadget = await Product.create({ sku: 'G-1', name: 'Gadget', price: '0.10' });
    const created = await createOrder([
      { productId: gadget.id, quantity: 3 },
      { productId: widget.id, quantity: 2 },
    ]);

    const found = await getOrder(created.id);

    expect(found.id).toBe(created.id);
    expect(found.total).toBe('40.28');
    const ids = found.items?.map((item) => item.id) ?? [];
    expect(ids).toHaveLength(2);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it('throws OrderNotFoundError for an id that does not exist', async () => {
    await expect(getOrder(999999)).rejects.toBeInstanceOf(OrderNotFoundError);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:integration src/services/orders.integration.test.ts 2>&1 | tail -25`
Expected: the two `getOrder` tests fail (`getOrder is not a function`, and `OrderNotFoundError` is undefined); the existing `createOrder` tests still pass. Tests are not type-checked by Vitest, which is why a missing export fails at run time rather than at load.

- [ ] **Step 3: Implement**

In `src/services/orders.ts`, add the new error class directly after `ProductNotFoundError` (before the `// What the columns can hold` comment):

```ts
export class OrderNotFoundError extends Error {
  override name = 'OrderNotFoundError';
  constructor(readonly orderId: number) {
    super(`Order ${orderId} not found`);
  }
}
```

and append `getOrder` at the end of the file:

```ts

export async function getOrder(id: number): Promise<Order> {
  const order = await Order.findByPk(id, { include: 'items', order: [['items', 'id', 'ASC']] });
  if (!order) throw new OrderNotFoundError(id);
  return order;
}
```

- [ ] **Step 4: Run to verify green**

Run: `pnpm test:integration 2>&1 | tail -8; pnpm typecheck; pnpm format:check`
Expected: `Tests  15 passed (15)` (13 baseline + 2); typecheck and format check print no errors.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/services/orders.ts src/services/orders.integration.test.ts
git commit -m "feat: add getOrder and OrderNotFoundError to the orders service"
```

---

### Task 2: The error handler (and the `zod` dependency)

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml` (by `pnpm add`)
- Create: `src/error-handler.ts`
- Test: `src/error-handler.test.ts`

**Interfaces:**
- Consumes: `InvalidOrderError`, `ProductNotFoundError`, `OrderNotFoundError` from `./services/orders.js` (Task 1 added the last); `ZodError` from `zod`.
- Produces: `export const errorHandler: ErrorRequestHandler` from `src/error-handler.ts`. Task 3 mounts it with `app.use(errorHandler)`.

- [ ] **Step 1: Add the dependency**

Run: `pnpm add zod && grep -n '"zod"' package.json`
Expected: pnpm prints `+ zod 4.x.y`; the grep shows `"zod": "^4.…"` inside `dependencies` (between `"umzug"` and the closing brace, not under `devDependencies`). `pnpm-lock.yaml` changes too.

- [ ] **Step 2: Write the failing test**

Create `src/error-handler.test.ts`:

```ts
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { errorHandler } from './error-handler.js';
import { InvalidOrderError, OrderNotFoundError, ProductNotFoundError } from './services/orders.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// A tiny app: one route that fails on demand, a body parser, then the real error handler.
function appThatThrows(error: unknown) {
  const app = express();
  app.use(express.json());
  app.get('/boom', () => {
    throw error;
  });
  app.post('/echo', (req, res) => {
    res.json(req.body);
  });
  app.use(errorHandler);
  return app;
}

const zodError = z.strictObject({ items: z.array(z.number()) }).safeParse({ items: ['x'] }).error!;

describe('errorHandler: known errors', () => {
  it.each([
    ['InvalidOrderError', new InvalidOrderError('Invalid quantity: 0'), 400, 'Invalid quantity: 0'],
    ['ProductNotFoundError', new ProductNotFoundError([5, 7]), 422, 'Unknown product id(s): 5, 7'],
    ['OrderNotFoundError', new OrderNotFoundError(9), 404, 'Order not found'],
  ])('%s is answered with its status', async (_name, error, status, message) => {
    const res = await request(appThatThrows(error)).get('/boom');
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ status: 'error', message });
  });

  it('turns a ZodError into 400 with one issue per problem and a dotted path', async () => {
    const res = await request(appThatThrows(zodError)).get('/boom');
    expect(res.status).toBe(400);
    expect(res.body.status).toBe('error');
    expect(res.body.message).toBe('Invalid request');
    expect(res.body.issues).toEqual([{ path: 'items.0', message: expect.any(String) }]);
  });
});

describe('errorHandler: errors from the body parser', () => {
  it('answers 400 "Invalid JSON" for malformed JSON, without the parser message', async () => {
    const res = await request(appThatThrows(new Error('unused')))
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{"items": [');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ status: 'error', message: 'Invalid JSON' });
  });

  it('answers 413 for a body over the 100 kb default limit', async () => {
    const res = await request(appThatThrows(new Error('unused')))
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ pad: 'x'.repeat(200_000) }));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ status: 'error', message: 'Request body too large' });
  });

  it('passes another client error through with the standard status text', async () => {
    const error = Object.assign(new Error('internal wording'), { status: 415, expose: true });
    const res = await request(appThatThrows(error)).get('/boom');
    expect(res.status).toBe(415);
    expect(res.body).toEqual({ status: 'error', message: 'Unsupported Media Type' });
  });
});

describe('errorHandler: everything else is a 500 that leaks nothing', () => {
  it.each([
    ['an Error with SQL detail', new Error("secret: SELECT * FROM `orders` WHERE password='x'")],
    ['a thrown string', 'secret string'],
    [
      'a 4xx error that says it must not be shown',
      Object.assign(new Error('secret'), { status: 400, expose: false }),
    ],
    [
      'a client-looking error that is not exposable',
      Object.assign(new Error('secret'), { status: 400 }),
    ],
    [
      'a 5xx error even if it claims to be exposable',
      Object.assign(new Error('secret'), { status: 503, expose: true }),
    ],
  ])('%s', async (_name, error) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(appThatThrows(error)).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ status: 'error', message: 'Internal Server Error' });
    expect(res.text).not.toMatch(/secret|SELECT|password/);
    expect(logged).toHaveBeenCalledWith('Unhandled request error:', error);
  });
});

it('hands the error to Express and writes nothing when the response has already started', () => {
  const error = new Error('late');
  const next = vi.fn();
  const res = { headersSent: true, status: vi.fn() } as unknown as Response;
  errorHandler(error, {} as Request, res, next as NextFunction);
  expect(next).toHaveBeenCalledWith(error);
  expect(res.status).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm exec vitest run src/error-handler.test.ts 2>&1 | tail -15`
Expected: the file fails to load: `Failed to resolve import "./error-handler.js"`.

- [ ] **Step 4: Implement**

Create `src/error-handler.ts`:

```ts
import type { ErrorRequestHandler } from 'express';
import { STATUS_CODES } from 'node:http';
import { ZodError } from 'zod';
import { InvalidOrderError, OrderNotFoundError, ProductNotFoundError } from './services/orders.js';

// body-parser (and other Express internals) throw errors that carry a status and say whether the
// client may see them. Only those are passed through, and only with a fixed message.
interface ClientError {
  status: number;
  expose: true;
  type?: string;
}

const isClientError = (err: unknown): err is ClientError =>
  typeof err === 'object' &&
  err !== null &&
  'status' in err &&
  typeof err.status === 'number' &&
  err.status >= 400 &&
  err.status < 500 &&
  'expose' in err &&
  err.expose === true;

const FIXED_MESSAGES: Record<string, string> = {
  'entity.parse.failed': 'Invalid JSON',
  'entity.too.large': 'Request body too large',
};

// Last middleware: the one place that decides what the client is told about a failure.
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);

  const send = (status: number, message: string, extra?: object) =>
    res.status(status).json({ status: 'error', message, ...extra });

  if (err instanceof ZodError) {
    const issues = err.issues.map(({ path, message }) => ({
      path: path.join('.'),
      message,
    }));
    return send(400, 'Invalid request', { issues });
  }
  if (err instanceof InvalidOrderError) return send(400, err.message);
  if (err instanceof ProductNotFoundError) return send(422, err.message);
  if (err instanceof OrderNotFoundError) return send(404, 'Order not found');
  if (isClientError(err)) {
    return send(
      err.status,
      FIXED_MESSAGES[err.type ?? ''] ?? STATUS_CODES[err.status] ?? 'Bad Request',
    );
  }

  console.error('Unhandled request error:', err);
  send(500, 'Internal Server Error');
};
```

- [ ] **Step 5: Run to verify green**

Run: `pnpm exec vitest run src/error-handler.test.ts 2>&1 | tail -8; pnpm typecheck; pnpm format:check`
Expected: `Tests  13 passed (13)`; typecheck and format check print no errors.

- [ ] **Step 6: Prove the tests can fail (mutation checks)**

For each row: copy the file aside (`cp src/error-handler.ts /tmp/eh.bak`), make the one change by hand, run `pnpm exec vitest run src/error-handler.test.ts 2>&1 | grep -E "Tests |FAIL"`, then restore (`cp /tmp/eh.bak src/error-handler.ts`). One change at a time.

| Change | Expected: this test fails |
|---|---|
| Replace `send(500, 'Internal Server Error')` with `send(500, String((err as Error)?.message ?? err))` | the `errorHandler: everything else is a 500 that leaks nothing` cases (an Error with SQL detail, a thrown string, and the two status-looking ones) |
| In `isClientError`, replace `err.expose === true;` with `true;` | `a 4xx error that says it must not be shown` |
| Delete the line `if (res.headersSent) return next(err);` | `hands the error to Express and writes nothing when the response has already started` |
| Change `send(422, err.message)` to `send(404, err.message)` | `ProductNotFoundError is answered with its status` |

After restoring the last one: `git diff --stat` must list only `package.json`, `pnpm-lock.yaml` and (untracked) the two new files; rerun Step 5.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add package.json pnpm-lock.yaml src/error-handler.ts src/error-handler.test.ts
git commit -m "feat: add error handler that maps service errors to HTTP statuses without leaking"
```

---

### Task 3: The router, wiring, and end-to-end checks

**Files:**
- Create: `src/routes/orders.ts`
- Modify: `src/app.ts`
- Test: `src/routes/orders.test.ts` (no database), `src/routes/orders.integration.test.ts` (needs MySQL)

**Interfaces:**
- Consumes: `createOrder(lines: OrderLine[]): Promise<Order>` and `getOrder(id: number): Promise<Order>` from `../services/orders.js`; `errorHandler` from Task 2.
- Produces: `export const ordersRouter: Router` from `src/routes/orders.ts`, mounted at `/orders`.

- [ ] **Step 1: Write the failing route tests**

Create `src/routes/orders.test.ts`:

```ts
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../app.js';
import {
  InvalidOrderError,
  OrderNotFoundError,
  ProductNotFoundError,
  createOrder,
  getOrder,
} from '../services/orders.js';

// The service is mocked (these tests need no database) but its real error classes are kept,
// because the error handler recognises errors with instanceof.
vi.mock('../services/orders.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/orders.js')>()),
  createOrder: vi.fn(),
  getOrder: vi.fn(),
}));

const createOrderMock = vi.mocked(createOrder);
const getOrderMock = vi.mocked(getOrder);

// What res.json receives is whatever the service returns; a plain object is enough here.
const savedOrder = {
  id: 1,
  status: 'pending',
  total: '39.98',
  items: [{ id: 1, orderId: 1, productId: 3, quantity: 2, unitPrice: '19.99' }],
} as unknown as Awaited<ReturnType<typeof createOrder>>;

beforeEach(() => {
  createOrderMock.mockReset();
  getOrderMock.mockReset();
});

describe('POST /orders', () => {
  it('creates the order and answers 201 with it', async () => {
    createOrderMock.mockResolvedValue(savedOrder);
    const res = await request(app)
      .post('/orders')
      .send({ items: [{ productId: 3, quantity: 2 }] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(JSON.parse(JSON.stringify(savedOrder)));
    expect(createOrderMock).toHaveBeenCalledWith([{ productId: 3, quantity: 2 }]);
  });

  it('passes a repeated product through unchanged, because the service merges them', async () => {
    createOrderMock.mockResolvedValue(savedOrder);
    const items = [
      { productId: 3, quantity: 1 },
      { productId: 3, quantity: 2 },
    ];
    const res = await request(app).post('/orders').send({ items });
    expect(res.status).toBe(201);
    expect(createOrderMock).toHaveBeenCalledWith(items);
  });

  it('accepts exactly 100 lines', async () => {
    createOrderMock.mockResolvedValue(savedOrder);
    const items = Array.from({ length: 100 }, (_, i) => ({ productId: i + 1, quantity: 1 }));
    const res = await request(app).post('/orders').send({ items });
    expect(res.status).toBe(201);
  });

  it.each([
    ['no body at all', undefined],
    ['a body that is not an object', [1, 2]],
    ['no items key', {}],
    ['items that is not an array', { items: 'x' }],
    ['an empty items array', { items: [] }],
    [
      '101 lines',
      { items: Array.from({ length: 101 }, (_, i) => ({ productId: i + 1, quantity: 1 })) },
    ],
    ['an unknown key on the body', { items: [{ productId: 1, quantity: 1 }], note: 'hi' }],
    ['an unknown key on a line', { items: [{ productId: 1, quantity: 1, price: '0.01' }] }],
    ['a string productId', { items: [{ productId: '1', quantity: 1 }] }],
    ['a missing quantity', { items: [{ productId: 1 }] }],
    ['quantity 0', { items: [{ productId: 1, quantity: 0 }] }],
    ['a negative quantity', { items: [{ productId: 1, quantity: -1 }] }],
    ['a fractional quantity', { items: [{ productId: 1, quantity: 1.5 }] }],
    ['an unsafe integer productId', { items: [{ productId: 2 ** 53, quantity: 1 }] }],
    ['null', null],
  ])('rejects %s with 400 before calling the service', async (_label, body) => {
    const req = request(app).post('/orders');
    const res = await (body === undefined ? req : req.send(body as object));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ status: 'error', message: 'Invalid request' });
    expect(res.body.issues.length).toBeGreaterThan(0);
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it('points at the bad field in the issues', async () => {
    const res = await request(app)
      .post('/orders')
      .send({
        items: [
          { productId: 1, quantity: 1 },
          { productId: 2, quantity: 0 },
        ],
      });
    expect(res.body.issues).toEqual([{ path: 'items.1.quantity', message: expect.any(String) }]);
  });

  it('rejects a body that is not JSON with 400', async () => {
    const res = await request(app).post('/orders').set('Content-Type', 'text/plain').send('items');
    expect(res.status).toBe(400);
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON with 400 "Invalid JSON"', async () => {
    const res = await request(app)
      .post('/orders')
      .set('Content-Type', 'application/json')
      .send('{"items": [');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ status: 'error', message: 'Invalid JSON' });
  });

  it('rejects a body over 100 kb with 413', async () => {
    const res = await request(app)
      .post('/orders')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ items: [], pad: 'x'.repeat(200_000) }));
    expect(res.status).toBe(413);
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it('maps InvalidOrderError from the service to 400', async () => {
    createOrderMock.mockRejectedValue(new InvalidOrderError('Order total exceeds 9999999999.99'));
    const res = await request(app)
      .post('/orders')
      .send({ items: [{ productId: 1, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ status: 'error', message: 'Order total exceeds 9999999999.99' });
  });

  it('maps ProductNotFoundError to 422', async () => {
    createOrderMock.mockRejectedValue(new ProductNotFoundError([5, 7]));
    const res = await request(app)
      .post('/orders')
      .send({ items: [{ productId: 5, quantity: 1 }] });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ status: 'error', message: 'Unknown product id(s): 5, 7' });
  });

  it('answers 500 without leaking when the service fails unexpectedly', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    createOrderMock.mockRejectedValue(new Error("Table 'order_sync_hub.orders' doesn't exist"));
    const res = await request(app)
      .post('/orders')
      .send({ items: [{ productId: 1, quantity: 1 }] });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ status: 'error', message: 'Internal Server Error' });
    expect(res.text).not.toMatch(/order_sync_hub|Table/);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe('GET /orders/:id', () => {
  it('answers 200 with the order, asking the service for a number', async () => {
    getOrderMock.mockResolvedValue(savedOrder);
    const res = await request(app).get('/orders/7');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(JSON.parse(JSON.stringify(savedOrder)));
    expect(getOrderMock).toHaveBeenCalledWith(7);
  });

  it.each(['abc', '0', '-1', '1.5', '1e3', '007x', '99999999999999999999'])(
    'rejects the id %s with 400 before calling the service',
    async (id) => {
      const res = await request(app).get(`/orders/${id}`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ status: 'error', message: 'Invalid request' });
      expect(getOrderMock).not.toHaveBeenCalled();
    },
  );

  it('maps OrderNotFoundError to 404', async () => {
    getOrderMock.mockRejectedValue(new OrderNotFoundError(99));
    const res = await request(app).get('/orders/99');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ status: 'error', message: 'Order not found' });
  });

  it('answers 500 without leaking when the service fails unexpectedly', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    getOrderMock.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:3306'));
    const res = await request(app).get('/orders/1');
    expect(res.status).toBe(500);
    expect(res.text).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
    logged.mockRestore();
  });
});

describe('body parsing is limited to /orders', () => {
  it('does not turn a bad JSON body on /health into a 400', async () => {
    const res = await request(app)
      .post('/health')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run src/routes/orders.test.ts 2>&1 | tail -30`
Expected: most tests fail because `/orders` does not exist yet (Express answers 404 where the tests expect 201, 400, 413, 422 and so on). Only the `/health` test passes.

- [ ] **Step 3: Implement the router**

Create `src/routes/orders.ts`:

```ts
import express, { Router } from 'express';
import { z } from 'zod';
import { createOrder, getOrder } from '../services/orders.js';

// Shape only. The quantity and total ceilings, and merging repeated products, stay in the service.
const MAX_LINES = 100;

const positiveInt = z.number().int().positive();

const createOrderBody = z.strictObject({
  items: z
    .array(z.strictObject({ productId: positiveInt, quantity: positiveInt }))
    .min(1)
    .max(MAX_LINES),
});

// Path ids arrive as text: digits only, then converted and range-checked.
const orderId = z.string().regex(/^\d+$/).transform(Number).pipe(positiveInt);

export const ordersRouter: Router = Router();

// Only /orders parses bodies, so /health never fails on a bad JSON body.
ordersRouter.use(express.json());

ordersRouter.post('/', async (req, res) => {
  const { items } = createOrderBody.parse(req.body);
  res.status(201).json(await createOrder(items));
});

ordersRouter.get('/:id', async (req, res) => {
  res.json(await getOrder(orderId.parse(req.params.id)));
});
```

- [ ] **Step 4: Wire it into the app**

In `src/app.ts`, add two imports under the existing `checkDatabase` import:

```ts
import { errorHandler } from './error-handler.js';
import { ordersRouter } from './routes/orders.js';
```

and replace `export default app;` with:

```ts
app.use('/orders', ordersRouter);

// Last, so it catches errors from every route above.
app.use(errorHandler);

export default app;
```

- [ ] **Step 5: Run to verify green**

Run: `pnpm exec vitest run src/routes/orders.test.ts 2>&1 | tail -8; pnpm test 2>&1 | grep -E "Test Files|Tests |FAIL"; pnpm typecheck; pnpm format:check`
Expected: `src/routes/orders.test.ts` reports `Tests  36 passed (36)`; the whole suite reports `Tests  126 passed (126)` (77 baseline + 13 + 36); typecheck and format check print no errors.

- [ ] **Step 6: Write the integration test (real app, real MySQL)**

Create `src/routes/orders.integration.test.ts`:

```ts
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../app.js';
import { sequelize } from '../db/sequelize.js';
import { Order, OrderItem, Product } from '../models/index.js';

// Runs against the TEST database (see vitest.integration.config.ts): the real app, the real
// service and real MySQL, with nothing mocked.
beforeEach(async () => {
  await OrderItem.destroy({ where: {} });
  await Order.destroy({ where: {} });
  await Product.destroy({ where: {} });
});

afterAll(async () => {
  await sequelize.close();
});

describe('POST /orders then GET /orders/:id', () => {
  it('returns the order that was created, with prices and total computed', async () => {
    const widget = await Product.create({ sku: 'W-1', name: 'Widget', price: '19.99' });
    const gadget = await Product.create({ sku: 'G-1', name: 'Gadget', price: '0.10' });

    const created = await request(app)
      .post('/orders')
      .send({
        items: [
          { productId: widget.id, quantity: 2 },
          { productId: gadget.id, quantity: 3 },
        ],
      });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'pending', total: '40.28' });
    expect(created.body.items).toHaveLength(2);

    const fetched = await request(app).get(`/orders/${created.body.id}`);

    expect(fetched.status).toBe(200);
    // POST promises no item order; GET sorts by id. Sort POST's items to compare like with like.
    const byId = (a: { id: number }, b: { id: number }) => a.id - b.id;
    expect(fetched.body).toEqual({
      ...created.body,
      items: [...created.body.items].sort(byId),
    });
  });
});

describe('POST /orders with an unknown product', () => {
  it('answers 422 and saves nothing', async () => {
    const widget = await Product.create({ sku: 'W-1', name: 'Widget', price: '19.99' });

    const res = await request(app)
      .post('/orders')
      .send({
        items: [
          { productId: widget.id, quantity: 1 },
          { productId: widget.id + 1000, quantity: 1 },
        ],
      });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      status: 'error',
      message: `Unknown product id(s): ${widget.id + 1000}`,
    });
    expect(await Order.count()).toBe(0);
    expect(await OrderItem.count()).toBe(0);
  });
});

describe('POST /orders with a quantity the database column cannot hold', () => {
  it('answers 400 from the service rule (zod only checks the shape) and saves nothing', async () => {
    const widget = await Product.create({ sku: 'W-1', name: 'Widget', price: '19.99' });

    const res = await request(app)
      .post('/orders')
      .send({ items: [{ productId: widget.id, quantity: 4294967296 }] });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ status: 'error' });
    expect(res.body.message).toMatch(/exceeds 4294967295/);
    expect(await Order.count()).toBe(0);
  });
});

describe('GET /orders/:id for an order that does not exist', () => {
  it('answers 404', async () => {
    const res = await request(app).get('/orders/999999');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ status: 'error', message: 'Order not found' });
  });
});
```

Run: `pnpm test:integration 2>&1 | tail -10`
Expected: `Tests  19 passed (19)` (15 after Task 1, plus these 4). If `POST then GET returns the order that was created` fails only on the order of `items`, the test is wrong about what `POST` promises, not the code: re-read its comment before changing anything.

- [ ] **Step 7: Prove the tests can fail (mutation checks)**

Same routine as Task 2 Step 6, with `src/routes/orders.ts` (or `src/app.ts`) copied aside. Run `pnpm exec vitest run src/routes/orders.test.ts 2>&1 | grep -E "Tests |FAIL"`.

| Change | Expected: this test fails |
|---|---|
| Delete `.max(MAX_LINES)` | `rejects 101 lines with 400 before calling the service` |
| Delete `.min(1)` | `rejects an empty items array with 400 before calling the service` |
| `const createOrderBody = z.strictObject({` becomes `const createOrderBody = z.object({` | `rejects an unknown key on the body ...` |
| `z.strictObject({ productId` becomes `z.object({ productId` | `rejects an unknown key on a line ...` |
| `res.status(201).json(` becomes `res.json(` | `creates the order and answers 201 with it` and `accepts exactly 100 lines` |
| `z.string().regex(/^\d+$/)` becomes `z.string()` | `rejects the id 1e3 with 400 ...` |
| `const positiveInt = z.number().int().positive();` becomes `z.number().positive();` | the fractional quantity, unsafe `productId` and `99999999999999999999` id cases |
| In `src/app.ts`, add `app.use(express.json());` as the first line after `const app: Express = express();` | `does not turn a bad JSON body on /health into a 400` |

Restore after each; then `git diff --stat` must show only `src/app.ts` modified, and Step 5 must be green again.

- [ ] **Step 8: Check the built server for real**

```bash
pnpm build && bash scripts/smoke.sh
(MYSQL_PORT=1 PORT=3156 node --env-file=.env dist/server.js > /tmp/orders-server.log 2>&1 & echo $! > /tmp/orders-server.pid); sleep 1.5
c() { curl -s -w '  -> HTTP %{http_code}\n' "$@"; }
c -X POST localhost:3156/orders -H 'content-type: application/json' -d '{"items":[{"productId":1,"quantity":0}]}'
c -X POST localhost:3156/orders -H 'content-type: application/json' -d '{"items":['
c localhost:3156/orders/abc
c localhost:3156/orders/1
c localhost:3156/health
kill "$(cat /tmp/orders-server.pid)"; sleep 0.3; grep -m1 Unhandled /tmp/orders-server.log | cut -c1-120
```

Expected: smoke prints `health: {"status":"ok"}`. Then, in order:
`{"status":"error","message":"Invalid request","issues":[{"path":"items.0.quantity","message":"Too small: expected number to be >0"}]}  -> HTTP 400`;
`{"status":"error","message":"Invalid JSON"}  -> HTTP 400`;
`{"status":"error","message":"Invalid request","issues":[{"path":"","message":"Invalid string: must match pattern /^\\d+$/"}]}  -> HTTP 400`;
`{"status":"error","message":"Internal Server Error"}  -> HTTP 500` (the database is deliberately unreachable here: `MYSQL_PORT=1`, which `--env-file` does not override); `{"status":"ok"}  -> HTTP 200`.
The log line starts `Unhandled request error: ConnectionRefusedError [SequelizeConnectionRefusedError]: connect ECONNREFUSED 127.0.0.1:1`. That detail is in the log and nowhere in any response above. (The exact zod message wording may differ between zod versions; the tests do not pin it.)

- [ ] **Step 9: Note the superseded plan, then commit**

Append one line at the top of the local plan `docs/superpowers/plans/2026-10-10-graceful-shutdown-and-error-handling.md`, just under its title: `> **Note (2026-10-14):** Task 1 (error-handling middleware) was done by the orders-HTTP-routes work as src/error-handler.ts. Only the graceful-shutdown tasks remain. Its 500 body is the same.` (That folder is git-ignored; this is a local note, not part of the commit.)

```bash
pnpm format
git add src/routes src/app.ts
git commit -m "feat: add POST /orders and GET /orders/:id with zod validation"
git status --short    # must print nothing
git log --oneline main..HEAD
```

Expected: a clean tree and three commits on `feature/orders-routes`.

---

## Final verification (after Task 3)

```bash
pnpm format:check && pnpm typecheck && pnpm test 2>&1 | grep -E "Tests " && pnpm test:integration 2>&1 | grep -E "Tests " && pnpm build
```

Expected: no formatting or type errors; `Tests  126 passed (126)`; `Tests  19 passed (19)`; build succeeds.

## For the pull request description

- New public routes: `POST /orders` (201) and `GET /orders/:id` (200). Error contract: 400 invalid input, 404 no such order, 413 body over 100 KB, 422 unknown product, 500 always the fixed message.
- New runtime dependency: `zod` (the CI `run` job installs production dependencies, so it must not be a devDependency).
- `POST /orders` accepts at most 100 lines.
- Body parsing is mounted on `/orders` only (a small departure from the spec, which put it in `app.ts`).
- The unused `src/controllers/` and `src/routes/` placeholder folders: `routes` is now used.

## Evidence behind this plan

Everything except the integration tests was run in a scratch copy of the project before this plan was written (Docker was off, so the three integration test files could only be typechecked): 126 unit tests passed; typecheck, format check and build were clean; the mutation changes listed above each made the named test fail; `scripts/smoke.sh` passed; and the live requests in Task 3 Step 8 returned the outputs listed there. The integration expectations (15 after Task 1, 19 after Task 3) are therefore the one part not yet observed: if they differ, trust the observed output over this plan and say so in the ledger.
