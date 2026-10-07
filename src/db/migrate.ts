import { migrator } from './migrator.js';
import { sequelize } from './sequelize.js';

try {
  await migrator.runAsCLI();
} finally {
  await sequelize.close();
}
