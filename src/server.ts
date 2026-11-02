import app from './app.js';
import { config } from './config.js';
import { dbPasswordProblem } from './db/preflight.js';

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
app.listen(config.port, (error?: Error) => {
  if (error) {
    const reason =
      (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? `port ${config.port} is already in use`
        : error.message;
    console.error(`Failed to start server: ${reason}`);
    process.exit(1);
  } else {
    console.log(`Server is running on port ${config.port} (${config.nodeEnv})`);
  }
});
