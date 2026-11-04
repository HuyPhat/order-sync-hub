import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator.js';

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.createTable('users', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    // 254 is the longest valid email address. MySQL's default collation compares case-insensitively,
    // so the unique index also stops "A@x.com" and "a@x.com"; the app stores it lowercase anyway.
    email: { type: DataTypes.STRING(254), allowNull: false, unique: true },
    passwordHash: { type: DataTypes.STRING(255), allowNull: false },
    role: { type: DataTypes.ENUM('admin', 'staff'), allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('users');
};
