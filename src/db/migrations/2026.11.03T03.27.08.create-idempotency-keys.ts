import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator.js';

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.createTable('idempotency_keys', {
    idempotencyKey: { type: DataTypes.STRING(64), primaryKey: true },
    requestHash: { type: DataTypes.CHAR(64), allowNull: false },
    orderId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      unique: true,
      references: { model: 'orders', key: 'id' },
      onDelete: 'CASCADE',
    },
    createdAt: { type: DataTypes.DATE, allowNull: false },
  });
  // utf8mb4_bin makes keys case-sensitive: "Ab" and "ab" are different keys. Sequelize ignores
  // `collate` on a column definition for MySQL, so it is set explicitly.
  await queryInterface.sequelize.query(
    'ALTER TABLE idempotency_keys MODIFY idempotencyKey VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL',
  );
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('idempotency_keys');
};
