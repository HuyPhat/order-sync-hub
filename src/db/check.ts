import { sequelize } from './sequelize.js';

// An unreachable host can block authenticate() for ~10s (mysql2's default connect timeout),
// longer than most probes wait, so cap it ourselves.
export async function checkDatabase(timeoutMs = 2000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`database check timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    await Promise.race([sequelize.authenticate(), timeout]);
    return true;
  } catch (error) {
    console.error('database health check failed:', error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
