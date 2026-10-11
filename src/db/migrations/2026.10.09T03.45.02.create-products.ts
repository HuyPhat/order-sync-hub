import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator.js';

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.createTable('products', {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    sku: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(255), allowNull: false },
    price: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('products');
};
