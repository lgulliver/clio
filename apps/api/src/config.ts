export function databaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('DATABASE_URL is required');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DATABASE_URL must be a PostgreSQL URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must be a PostgreSQL URL');
  }
  return value;
}

export function readConfig(env: NodeJS.ProcessEnv) {
  const port = env.PORT === undefined ? 3000 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  const host = env.HOST ?? '127.0.0.1';
  if (host.trim().length === 0) throw new Error('HOST must not be empty');
  return { databaseUrl: databaseUrl(env.DATABASE_URL), host, port };
}
