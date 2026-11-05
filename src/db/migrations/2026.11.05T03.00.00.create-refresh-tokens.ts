import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator.js';

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.createTable('refresh_tokens', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    userId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      onDelete: 'CASCADE',
    },
    // All tokens of one login session share it; reuse of an old token revokes the whole family.
    familyId: { type: DataTypes.CHAR(36), allowNull: false },
    // SHA-256 hex of the token. The token itself is never stored.
    tokenHash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    usedAt: { type: DataTypes.DATE, allowNull: true },
    revokedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
  });
  await queryInterface.addIndex('refresh_tokens', ['familyId']);
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('refresh_tokens');
};
