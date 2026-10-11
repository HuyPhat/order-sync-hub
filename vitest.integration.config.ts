import { defineConfig } from 'vitest/config';
import { TEST_DATABASE } from './test/test-database.js';

// Load .env (MYSQL_PASSWORD etc.) for this process; variables already set are not overridden.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env file: rely on the real environment
}

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    env: { MYSQL_DATABASE: TEST_DATABASE },
    globalSetup: ['./test/integration-setup.ts'],
    fileParallelism: false, // all files share one database
  },
});
