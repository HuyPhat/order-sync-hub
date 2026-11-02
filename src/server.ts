import app from './app.js';
import { config } from './config.js';
import { dbPasswordProblem } from './db/preflight.js';
import { createShutdown } from './shutdown.js';

// The server can run without a database (/health stays up), so only development and test
// tolerate a missing password; anywhere else it is a deployment mistake worth failing on.
const dbProblem = dbPasswordProblem(config.db.password);
if (dbProblem) {
  if (config.nodeEnv === 'development' || config.nodeEnv === 'test') {
    console.warn(`Warning: ${dbProblem} /health/db will report the database as down.`);
  } else {
    console.error(`Refusing to start: ${dbProblem}`);
    process.exit(1);
  }
}

// Express 5 also calls this callback when listening fails, passing the error.
const server = app.listen(config.port, (error?: Error) => {
  if (error) {
    const reason =
      (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? `port ${config.port} is already in use`
        : error.message;
    console.error(`Failed to start server: ${reason}`);
    process.exit(1);
  } else {
    console.log(`Server is running on port ${config.port} (${config.nodeEnv})`);

    // Built on the first signal: `server` is not assigned yet if listen reports synchronously.
    let shutdown: ReturnType<typeof createShutdown> | undefined;
    const onSignal = (signal: string): void => {
      shutdown ??= createShutdown({
        server,
        closeDb: async () => {
          const { sequelize } = await import('./db/sequelize.js');
          await sequelize.close();
        },
        exit: (code) => process.exit(code),
        log: console.log,
      });
      void shutdown(signal);
    };
    // `once` is deliberate: a second identical signal falls through to Node's default and force-quits.
    process.once('SIGTERM', () => onSignal('SIGTERM'));
    process.once('SIGINT', () => onSignal('SIGINT'));
  }
});
