import { setTimeout } from 'node:timers/promises';
import { databaseUrl } from './config.ts';
import { checkReadiness, loadMigrations } from './db/migrations.ts';
import { createPool } from './db/pool.ts';
import { readArgoConfig } from './features/argo-collection/config.ts';
import { readGitHubConfig } from './features/github-collection/config.ts';
import { readMeasurementConfig } from './features/measurements/config.ts';
import { createMeasurementWorker } from './features/measurements/worker.ts';

const controller = new AbortController();
function stop() {
  controller.abort();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  if (process.argv.slice(2).some((arg) => arg !== '--once'))
    throw new Error('Invalid worker arguments');
  const argo = await readArgoConfig(process.env);
  const github = await readGitHubConfig(process.env);
  const measurement = await readMeasurementConfig(process.env);
  const pool = createPool(databaseUrl(process.env.DATABASE_URL));
  try {
    await checkReadiness(pool, await loadMigrations());
    const worker = createMeasurementWorker(pool, {
      configNow: () => measurement,
      githubNow: () => github,
      argoNow: () => argo,
    });
    do {
      if (controller.signal.aborted) break;
      await worker.runOnce();
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
    'Measurement worker unavailable; check private configuration and migration history',
  );
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
