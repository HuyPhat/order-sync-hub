import express, { Router } from 'express';
import { z } from 'zod';
import { methodNotAllowed } from '../error-handler.js';
import { createOrder, createOrderOnce, getOrder } from '../services/orders.js';

// Shape only. The quantity and total ceilings, and merging repeated products, stay in the service.
const MAX_LINES = 100;

const positiveInt = z.number().int().positive();

const createOrderBody = z.strictObject({
  items: z
    .array(z.strictObject({ productId: positiveInt, quantity: positiveInt }))
    .min(1)
    .max(MAX_LINES),
});

// Optional. 1..64 printable ASCII characters, case-sensitive, so a key never needs trimming or
// normalising before it is stored or compared.
// Wrapped in an object keyed by the header name, so a bad key is reported as an issue at
// `Idempotency-Key` instead of at an empty path.
const idempotencyHeader = z.object({
  'Idempotency-Key': z
    .string()
    .regex(/^[\x21-\x7e]{1,64}$/, 'Must be 1 to 64 printable ASCII characters')
    .optional(),
});

// Path ids arrive as text: digits only, then converted and range-checked.
const orderId = z.string().regex(/^\d+$/).transform(Number).pipe(positiveInt);

export const ordersRouter: Router = Router();

// Only /orders parses bodies, so /health never fails on a bad JSON body.
ordersRouter.use(express.json());

ordersRouter
  .route('/')
  .post(async (req, res) => {
    // The header is checked first, so a bad key is rejected before the body is looked at.
    const { 'Idempotency-Key': key } = idempotencyHeader.parse({
      'Idempotency-Key': req.get('Idempotency-Key'),
    });
    const { items } = createOrderBody.parse(req.body);
    const { order, created } =
      key === undefined
        ? { order: await createOrder(items), created: true }
        : await createOrderOnce(key, items);
    res
      .status(created ? 201 : 200)
      .location(`${req.baseUrl}/${order.id}`)
      .json(order);
  })
  .all(methodNotAllowed('POST'));

ordersRouter
  .route('/:id')
  .get(async (req, res) => {
    res.json(await getOrder(orderId.parse(req.params.id)));
  })
  .all(methodNotAllowed('GET', 'HEAD'));
