function parsePort(raw: string | undefined, fallback: number, name = 'PORT', min = 0): number {
  const value = raw?.trim();
  if (!value) return fallback; // unset, empty or whitespace-only

  const port = Number(value);
  if (!/^\d+$/.test(value) || port < min || port > 65535) {
    throw new Error(`Invalid ${name}: ${raw} (expected an integer between ${min} and 65535)`);
  }

  return port;
}

export const config = {
  port: parsePort(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  // Same variable names docker-compose.yml uses, so .env is the single source.
  db: {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: parsePort(process.env.MYSQL_PORT, 3306, 'MYSQL_PORT', 1),
    name: process.env.MYSQL_DATABASE || 'order_sync_hub',
    user: process.env.MYSQL_USER || 'app',
    password: process.env.MYSQL_PASSWORD || '',
  },
} as const;
