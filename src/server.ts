import app from './app.js';
import { config } from './config.js';

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
