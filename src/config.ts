function parsePort(raw: string | undefined, fallback: number, name = 'PORT'): number {
  const port = Number(raw || fallback);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid ${name}: ${raw} (expected an integer between 0 and 65535)`);
  }

  return port;
}

export const config = {
  port: parsePort(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  // Same variable names docker-compose.yml uses, so .env is the single source.
  db: {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: parsePort(process.env.MYSQL_PORT, 3306, 'MYSQL_PORT'),
    name: process.env.MYSQL_DATABASE || 'order_sync_hub',
    user: process.env.MYSQL_USER || 'app',
    password: process.env.MYSQL_PASSWORD || '',
  },
} as const;
