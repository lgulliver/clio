import { setTimeout } from 'node:timers/promises';
import { databaseUrl } from './config.ts';
import { checkReadiness, loadMigrations } from './db/migrations.ts';
import { createPool } from './db/pool.ts';
import { processOne } from './features/mock-collection/worker.ts';

let stopping = false;
const controller = new AbortController();
function stop() {
  stopping = true;
  controller.abort();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  if (process.argv.slice(2).some((arg) => arg !== '--once'))
    throw new Error('Invalid worker arguments');
  const pool = createPool(databaseUrl(process.env.DATABASE_URL));
  try {
    await checkReadiness(pool, await loadMigrations());
    do {
      if (stopping) break;
      await processOne(pool);
      if (process.argv.includes('--once') || stopping) break;
      await setTimeout(1000, undefined, { signal: controller.signal }).catch((error) => {
        if (!controller.signal.aborted) throw error;
      });
    } while (!stopping);
  } finally {
    await pool.end();
  }
} catch {
  console.error('Mock worker unavailable; check database configuration and migration history');
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
