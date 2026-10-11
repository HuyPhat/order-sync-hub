import { Decimal } from 'decimal.js';
import { sequelize } from '../db/sequelize.js';
import { Order, OrderItem, Product } from '../models/index.js';

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

const isPositiveInteger = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1;

// Checks the input and merges repeated products into one line (quantities add up).
function normalizeLines(lines: OrderLine[]): OrderLine[] {
  if (lines.length === 0) throw new InvalidOrderError('An order needs at least one item');

  const merged = new Map<number, number>();
  for (const { productId, quantity } of lines) {
    if (!isPositiveInteger(productId))
      throw new InvalidOrderError(`Invalid productId: ${productId}`);
    if (!isPositiveInteger(quantity)) throw new InvalidOrderError(`Invalid quantity: ${quantity}`);
    merged.set(productId, (merged.get(productId) ?? 0) + quantity);
  }
  return [...merged].map(([productId, quantity]) => ({ productId, quantity }));
}

// Loads the products, snapshots their current prices into the items, and writes the order and
// all its items in ONE transaction: if anything throws, nothing is saved.
export async function createOrder(lines: OrderLine[]): Promise<Order> {
  const wanted = normalizeLines(lines);

  return sequelize.transaction(async (transaction) => {
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
    const total = items
      .reduce(
        (sum, item) => sum.plus(new Decimal(item.unitPrice).times(item.quantity)),
        new Decimal(0),
      )
      .toFixed(2);

    const order = await Order.create({ status: 'pending', total }, { transaction });
    await OrderItem.bulkCreate(
      items.map((item) => ({ ...item, orderId: order.id })),
      { transaction },
    );

    return order.reload({ include: 'items', transaction });
  });
}
