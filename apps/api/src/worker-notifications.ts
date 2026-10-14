import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';
import { databaseUrl } from './config.ts';
import { checkReadiness, loadMigrations } from './db/migrations.ts';
import { createPool } from './db/pool.ts';
import { readNotificationConfig } from './features/notifications/config.ts';
import {
  createProductionConfigNow,
  processOneNotification,
  runNotificationCycle,
} from './features/notifications/worker.ts';

const housekeepingMillis = 30_000;
const idleMillis = 2_000;
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  if (process.argv.slice(2).some((arg) => arg !== '--once'))
    throw new Error('Invalid worker arguments');
  const once = process.argv.includes('--once');
  // Startup snapshot only validates configuration and its trusted-origin binding. Authority is
  // re-read from the private operator file for every claim and before provider calls.
  const configNow = createProductionConfigNow(process.env, readNotificationConfig);
  const snapshot = await configNow();
  const pool = createPool(databaseUrl(process.env.DATABASE_URL));
  try {
    await checkReadiness(pool, await loadMigrations());
    const dependencies = { signal: controller.signal, configNow };
    // Absent configuration stays disabled: no provider calls, bounded maintenance only.
    if (once) await runNotificationCycle(pool, snapshot, dependencies);
    else {
      let housekeeping = Number.NEGATIVE_INFINITY;
      while (!controller.signal.aborted) {
        let delivered: boolean;
        if (performance.now() - housekeeping >= housekeepingMillis) {
          housekeeping = performance.now();
          delivered = (await runNotificationCycle(pool, snapshot, dependencies)).delivered;
        } else delivered = await processOneNotification(pool, snapshot, dependencies);
        // Pacing and cooldowns live in the database; an idle queue waits instead of polling hot.
        if (!delivered && !controller.signal.aborted)
          await setTimeout(idleMillis, undefined, { signal: controller.signal }).catch(
            (error: unknown) => {
              if (!controller.signal.aborted) throw error;
            },
          );
      }
    }
  } finally {
    await pool.end();
  }
} catch {
  console.error(
    'Notification worker unavailable; check private configuration, trusted origin and migration history',
  );
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
