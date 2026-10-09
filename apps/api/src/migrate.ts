import { databaseUrl } from './config.ts';
import { migrate } from './db/migrations.ts';
import { createPool } from './db/pool.ts';

try {
  const pool = createPool(databaseUrl(process.env.DATABASE_URL));
  try {
    await migrate(pool);
    console.log('Migrations applied');
  } finally {
    await pool.end();
  }
} catch {
  console.error('Migration failed; check database configuration and migration history');
  process.exitCode = 1;
}
