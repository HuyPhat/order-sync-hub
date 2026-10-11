import { configDefaults, defineConfig } from 'vitest/config';

// `pnpm test`: fast, no database. Integration tests have their own config and script.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
  },
});
