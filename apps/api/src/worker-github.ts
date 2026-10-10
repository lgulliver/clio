import { setTimeout } from 'node:timers/promises';
import { databaseUrl } from './config.ts';
import { checkReadiness, loadMigrations } from './db/migrations.ts';
import { createPool } from './db/pool.ts';
import { readGitHubConfig } from './features/github-collection/config.ts';
import { processOne } from './features/github-collection/worker.ts';

const controller = new AbortController();
function stop() {
  controller.abort();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  if (process.argv.slice(2).some((arg) => arg !== '--once'))
    throw new Error('Invalid worker arguments');
  const github = await readGitHubConfig(process.env);
  if (!github) throw new Error('GitHub configuration required');
  const pool = createPool(databaseUrl(process.env.DATABASE_URL));
  try {
    await checkReadiness(pool, await loadMigrations());
    do {
      if (controller.signal.aborted) break;
      await processOne(pool, github, { signal: controller.signal });
      if (process.argv.includes('--once') || controller.signal.aborted) break;
      await setTimeout(1000, undefined, { signal: controller.signal }).catch((error: unknown) => {
        if (!controller.signal.aborted) throw error;
      });
    } while (!controller.signal.aborted);
  } finally {
    await pool.end();
  }
} catch {
  console.error('GitHub worker unavailable; check private configuration and migration history');
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
