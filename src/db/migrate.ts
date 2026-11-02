import { config } from '../config.js';
import { dbPasswordProblem } from './preflight.js';
import { migrator } from './migrator.js';
import { sequelize } from './sequelize.js';

const problem = dbPasswordProblem(config.db.password);
if (problem) {
  console.error(problem);
  process.exit(1);
}

try {
  await migrator.runAsCLI();
} finally {
  await sequelize.close();
}
