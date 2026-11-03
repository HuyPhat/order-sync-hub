import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';
import { sequelize } from '../db/sequelize.js';

export class IdempotencyKey extends Model<
  InferAttributes<IdempotencyKey>,
  InferCreationAttributes<IdempotencyKey>
> {
  declare idempotencyKey: string;
  declare requestHash: string;
  declare orderId: number;
  declare createdAt: CreationOptional<Date>;
}

IdempotencyKey.init(
  {
    idempotencyKey: { type: DataTypes.STRING(64), primaryKey: true },
    requestHash: { type: DataTypes.CHAR(64), allowNull: false },
    orderId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, unique: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'idempotency_keys', updatedAt: false },
);
