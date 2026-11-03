import { Decimal } from 'decimal.js';
import { UniqueConstraintError, type Transaction } from 'sequelize';
import { sequelize } from '../db/sequelize.js';
import { IdempotencyKey, Order, OrderItem, Product } from '../models/index.js';
import { hashOrderLines } from './idempotency.js';

export interface OrderLine {
  productId: number;
  quantity: number;
}

export class InvalidOrderError extends Error {
  override name = 'InvalidOrderError';
}

export class ProductNotFoundError extends Error {
  override name = 'ProductNotFoundError';
  constructor(readonly productIds: number[]) {
    super(`Unknown product id(s): ${productIds.join(', ')}`);
  }
}

export class IdempotencyKeyReusedError extends Error {
  override name = 'IdempotencyKeyReusedError';
  constructor() {
    super('Idempotency-Key was already used with a different request');
  }
}

export class OrderNotFoundError extends Error {
  override name = 'OrderNotFoundError';
  constructor(readonly orderId: number) {
    super(`Order ${orderId} not found`);
  }
}

// What the columns can hold: order_items.quantity is INT UNSIGNED, orders.total is DECIMAL(12,2).
// Checked here so a too-large order is rejected before any write, whatever the server's sql_mode
// (a non-strict MySQL would silently clamp an out-of-range value instead of failing).
const MAX_QUANTITY = 4_294_967_295;
const MAX_TOTAL = '9999999999.99';

const isPositiveInteger = (n: unknown): n is number =>
  Number.isSafeInteger(n) && (n as number) >= 1;

// Checks the input and merges repeated products into one line (quantities add up).
function normalizeLines(lines: OrderLine[]): OrderLine[] {
  if (lines.length === 0) throw new InvalidOrderError('An order needs at least one item');

  const merged = new Map<number, number>();
  for (const { productId, quantity } of lines) {
    if (!isPositiveInteger(productId))
      throw new InvalidOrderError(`Invalid productId: ${productId}`);
    if (!isPositiveInteger(quantity)) throw new InvalidOrderError(`Invalid quantity: ${quantity}`);
    const total = (merged.get(productId) ?? 0) + quantity;
    if (total > MAX_QUANTITY)
      throw new InvalidOrderError(`Quantity for product ${productId} exceeds ${MAX_QUANTITY}`);
    merged.set(productId, total);
  }
  return [...merged].map(([productId, quantity]) => ({ productId, quantity }));
}

// Loads the products, snapshots their current prices into the items, and writes the order and
// all its items inside the given transaction: if anything throws, the caller rolls it all back.
async function insertOrder(wanted: OrderLine[], transaction: Transaction): Promise<Order> {
  // LOCK IN SHARE MODE: nobody can change these prices until this transaction ends.
  const products = await Product.findAll({
    where: { id: wanted.map((line) => line.productId) },
    transaction,
    lock: transaction.LOCK.SHARE,
  });
  const priceById = new Map(products.map((product) => [product.id, product.price]));

  const unknown = wanted.filter((line) => !priceById.has(line.productId));
  if (unknown.length > 0) throw new ProductNotFoundError(unknown.map((line) => line.productId));

  const items = wanted.map((line) => ({
    productId: line.productId,
    quantity: line.quantity,
    unitPrice: priceById.get(line.productId) as string,
  }));
  const sum = items.reduce(
    (running, item) => running.plus(new Decimal(item.unitPrice).times(item.quantity)),
    new Decimal(0),
  );
  if (sum.gt(MAX_TOTAL)) throw new InvalidOrderError(`Order total exceeds ${MAX_TOTAL}`);
  const total = sum.toFixed(2);

  const order = await Order.create({ status: 'pending', total }, { transaction });
  await OrderItem.bulkCreate(
    items.map((item) => ({ ...item, orderId: order.id })),
    { transaction },
  );

  return order.reload({ include: 'items', transaction });
}

// Writes the order and all its items in ONE transaction: if anything throws, nothing is saved.
export async function createOrder(lines: OrderLine[]): Promise<Order> {
  const wanted = normalizeLines(lines);
  return sequelize.transaction((transaction) => insertOrder(wanted, transaction));
}

// The order saved under this key, if any. Throws if the key was used for a different request.
async function findReplay(idempotencyKey: string, requestHash: string): Promise<Order | undefined> {
  const row = await IdempotencyKey.findByPk(idempotencyKey);
  if (!row) return undefined;
  if (row.requestHash !== requestHash) throw new IdempotencyKeyReusedError();
  return getOrder(row.orderId);
}

// Like createOrder, but safe to retry: the same key with the same request returns the original
// order (created: false). The key row is written in the same transaction as the order, so a
// failed attempt leaves the key unused, and the primary key makes concurrent duplicates fail.
export async function createOrderOnce(
  idempotencyKey: string,
  lines: OrderLine[],
): Promise<{ order: Order; created: boolean }> {
  const wanted = normalizeLines(lines);
  const requestHash = hashOrderLines(wanted);

  const replay = await findReplay(idempotencyKey, requestHash);
  if (replay) return { order: replay, created: false };

  try {
    const order = await sequelize.transaction(async (transaction) => {
      const created = await insertOrder(wanted, transaction);
      await IdempotencyKey.create(
        { idempotencyKey, requestHash, orderId: created.id },
        { transaction },
      );
      return created;
    });
    return { order, created: true };
  } catch (error) {
    if (!(error instanceof UniqueConstraintError)) throw error;
    // A concurrent request committed this key first. We are outside the failed (rolled back)
    // transaction here, so this is a fresh read of what the winner saved.
    const winner = await findReplay(idempotencyKey, requestHash);
    if (!winner) throw error;
    return { order: winner, created: false };
  }
}

export async function getOrder(id: number): Promise<Order> {
  const order = await Order.findByPk(id, { include: 'items', order: [['items', 'id', 'ASC']] });
  if (!order) throw new OrderNotFoundError(id);
  return order;
}
