import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';
import { sequelize } from '../db/sequelize.js';
import { ROLES, type Role } from '../auth/token.js';

export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
  declare id: CreationOptional<number>;
  declare email: string;
  // argon2id PHC string. Never send it to a client.
  declare passwordHash: string;
  declare role: Role;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

User.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    email: { type: DataTypes.STRING(254), allowNull: false, unique: true },
    passwordHash: { type: DataTypes.STRING(255), allowNull: false },
    role: { type: DataTypes.ENUM(...ROLES), allowNull: false },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'users' },
);
