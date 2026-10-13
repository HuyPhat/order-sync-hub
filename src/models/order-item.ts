import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from 'sequelize';
import { sequelize } from '../db/sequelize.js';
import type { Order } from './order.js';
import type { Product } from './product.js';

export class OrderItem extends Model<
  InferAttributes<OrderItem, { omit: 'order' | 'product' }>,
  InferCreationAttributes<OrderItem, { omit: 'order' | 'product' }>
> {
  declare id: CreationOptional<number>;
  // Plain numbers on purpose: Sequelize's ForeignKey<> helper would make these optional when
  // creating an item, so a missing orderId or productId would compile and only fail in MySQL.
  declare orderId: number;
  declare productId: number;
  declare quantity: number;
  // A snapshot of Product.price at the time of the order, not a live reference.
  declare unitPrice: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare order?: NonAttribute<Order>;
  declare product?: NonAttribute<Product>;
}

OrderItem.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    orderId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    productId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    unitPrice: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'order_items' },
);
