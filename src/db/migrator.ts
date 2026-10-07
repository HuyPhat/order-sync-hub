import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SequelizeStorage, Umzug } from 'umzug';
import { sequelize } from './sequelize.js';

const migrationsDir = join(import.meta.dirname, 'migrations');

export const migrator = new Umzug({
  migrations: {
    // ignore *.d.ts: `declaration: true` emits them next to compiled migrations in dist/
    glob: ['*.{ts,js}', { cwd: migrationsDir, ignore: ['*.d.ts'] }],
    // Load with import() so ESM migrations work (umzug's default uses require()).
    resolve: ({ name, path, context }) => ({
      name,
      up: async () => (await import(pathToFileURL(path!).href)).up({ context }),
      down: async () => (await import(pathToFileURL(path!).href)).down({ context }),
    }),
  },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize }),
  logger: console,
  create: {
    folder: migrationsDir,
    template: (filepath) => [
      [
        filepath,
        [
          "import type { Migration } from '../migrator.js';",
          '',
          'export const up: Migration = async ({ context: queryInterface }) => {};',
          '',
          'export const down: Migration = async ({ context: queryInterface }) => {};',
          '',
        ].join('\n'),
      ],
    ],
  },
});

export type Migration = typeof migrator._types.migration;
