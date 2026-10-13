import { TEST_DATABASE } from './test-database.js';

// Runs once before the integration tests: rebuild the test database schema from the migrations.
export default async function setup() {
  process.env.MYSQL_DATABASE = TEST_DATABASE;

  const { config } = await import('../src/config.js');
  // Reverting every migration drops all tables. Never do that to a real database.
  if (!config.db.name.endsWith('_test')) {
    throw new Error(
      `Refusing to reset "${config.db.name}": integration tests only run against a database whose name ends in "_test".`,
    );
  }

  const { migrator } = await import('../src/db/migrator.js');
  const { sequelize } = await import('../src/db/sequelize.js');

  await migrator.down({ to: 0 }); // clean slate: revert everything...
  await migrator.up(); // ...and apply every migration again

  return async () => {
    await sequelize.close();
  };
}
