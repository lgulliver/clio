import { readConfig } from './config.ts';
import { checkReadiness, loadMigrations } from './db/migrations.ts';
import { createPool } from './db/pool.ts';
import { readArgoConfig } from './features/argo-collection/config.ts';
import { readGitHubConfig } from './features/github-collection/config.ts';
import { createAuth } from './features/identity/auth.ts';
import { readAuthConfig } from './features/identity/config.ts';
import { readMeasurementConfig } from './features/measurements/config.ts';
import { createServer } from './server.ts';

async function main() {
  const config = readConfig(process.env);
  const authConfig = readAuthConfig(process.env);
  const github = await readGitHubConfig(process.env);
  const argo = await readArgoConfig(process.env);
  const measurement = await readMeasurementConfig(process.env);
  if ((github || argo || measurement) && !authConfig)
    throw new Error('Live connections require identity configuration');
  const migrations = await loadMigrations();
  const pool = createPool(config.databaseUrl);
  const server = createServer(
    {
      ready: () => checkReadiness(pool, migrations),
      close: () => pool.end(),
    },
    authConfig
      ? { auth: createAuth(pool, authConfig), config: authConfig, pool, github, argo, measurement }
      : undefined,
  );
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await server.close();
    } catch {
      console.error('API shutdown failed');
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await server.listen({ host: config.host, port: config.port });
  } catch {
    await shutdown();
    throw new Error('API startup failed');
  }
}

try {
  await main();
} catch {
  console.error('API startup failed; check configuration and local dependencies');
  process.exitCode = 1;
}
