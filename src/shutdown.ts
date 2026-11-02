import type { Server } from 'node:http';

export const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ShutdownDeps {
  server: Pick<Server, 'close' | 'closeIdleConnections'>;
  closeDb: () => Promise<void>;
  exit: (code: number) => void;
  log: (message: string) => void;
  timeoutMs?: number;
}

export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const { server, closeDb, exit, log, timeoutMs = SHUTDOWN_TIMEOUT_MS } = deps;
  let shuttingDown = false;
  let done = false;

  const finish = (code: number): void => {
    if (done) return;
    done = true;
    exit(code);
  };

  return async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Received ${signal}, shutting down...`);

    const timer = setTimeout(() => {
      log('Shutdown timed out');
      finish(1);
    }, timeoutMs);
    timer.unref();

    let failed = false;

    const closeError = await new Promise<Error | undefined>((resolve) => {
      server.close((err?: Error) => resolve(err));
      server.closeIdleConnections();
    });
    if (closeError) {
      failed = true;
      log(`Error closing server: ${closeError.message}`);
    }

    try {
      await closeDb();
    } catch (err) {
      failed = true;
      log(`Error closing database: ${err instanceof Error ? err.message : String(err)}`);
    }

    clearTimeout(timer);
    finish(failed ? 1 : 0);
  };
}
