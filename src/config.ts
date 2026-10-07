function parsePort(raw: string | undefined, fallback: number): number {
    const port = Number(raw || fallback);

    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid PORT: ${raw} (expected an integer between 0 and 65535)`);
    }

    return port;
}

export const config = {
    port: parsePort(process.env.PORT, 3000),
    nodeEnv: process.env.NODE_ENV || 'development',
} as const;