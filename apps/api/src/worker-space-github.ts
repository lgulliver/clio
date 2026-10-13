import { setTimeout } from 'node:timers/promises';
import { databaseUrl } from './config.ts';
import { checkReadiness, loadMigrations } from './db/migrations.ts';
import { createPool } from './db/pool.ts';
import { readGitHubConfig } from './features/github-collection/config.ts';
import { readAuthConfig } from './features/identity/config.ts';
import { readSpaceGitHubConfig } from './features/space-github/config.ts';
import { processOneSpaceGitHub } from './features/space-github/worker.ts';

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  if (process.argv.slice(2).some((arg) => arg !== '--once'))
    throw new Error('Invalid worker arguments');
  const deployment = await readGitHubConfig(process.env);
  const config = await readSpaceGitHubConfig(process.env, deployment?.appId ?? null);
  if (!config || !readAuthConfig(process.env))
    throw new Error('SPACE GitHub and identity configuration required');
  const pool = createPool(databaseUrl(process.env.DATABASE_URL));
  try {
    await checkReadiness(pool, await loadMigrations());
    do {
      if (controller.signal.aborted) break;
      await processOneSpaceGitHub(pool, config, { signal: controller.signal });
      if (process.argv.includes('--once') || controller.signal.aborted) break;
      await setTimeout(1000, undefined, { signal: controller.signal }).catch((error: unknown) => {
        if (!controller.signal.aborted) throw error;
      });
    } while (!controller.signal.aborted);
  } finally {
    await pool.end();
  }
} catch {
  console.error(
    'SPACE GitHub worker unavailable; check private configuration and migration history',
  );
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
