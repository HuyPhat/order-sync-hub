import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from 'sequelize';
import { sequelize } from '../db/sequelize.js';
import type { OrderItem } from './order-item.js';

export type OrderStatus = 'pending' | 'paid' | 'cancelled';

export class Order extends Model<
  InferAttributes<Order, { omit: 'items' }>,
  InferCreationAttributes<Order, { omit: 'items' }>
> {
  declare id: CreationOptional<number>;
  declare status: CreationOptional<OrderStatus>;
  // DECIMAL is a string on purpose, as for Product.price.
  declare total: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  // Filled only when queried with include: 'items'.
  declare items?: NonAttribute<OrderItem[]>;
}

Order.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    status: {
      type: DataTypes.ENUM('pending', 'paid', 'cancelled'),
      allowNull: false,
      defaultValue: 'pending',
    },
    total: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'orders' },
);
