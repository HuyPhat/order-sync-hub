import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';
import { sequelize } from '../db/sequelize.js';

export class Product extends Model<InferAttributes<Product>, InferCreationAttributes<Product>> {
  declare id: CreationOptional<number>;
  declare sku: string;
  declare name: string;
  // DECIMAL is a string on purpose: MySQL returns it as text so no float rounding sneaks in.
  declare price: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Product.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    sku: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(255), allowNull: false },
    price: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'products' },
);
