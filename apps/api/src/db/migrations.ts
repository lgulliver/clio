import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { withTransaction } from './pool.ts';

export interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

export async function loadMigrations(
  directory = new URL('../../migrations/', import.meta.url),
): Promise<Migration[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  const numbers = new Set<string>();
  for (const name of names) {
    const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name);
    if (!match?.[1] || numbers.has(match[1]))
      throw new Error('Invalid or duplicate migration number');
    numbers.add(match[1]);
  }
  if (names.length === 0) throw new Error('No migrations found');
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(new URL(name, directory), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

function checkApplied(
  rows: Record<string, unknown>[],
  migrations: Migration[],
  requireAll: boolean,
) {
  const expected = new Map(migrations.map((migration) => [migration.name, migration.checksum]));
  const applied = new Set<string>();
  for (const row of rows) {
    if (
      typeof row.name !== 'string' ||
      typeof row.checksum !== 'string' ||
      expected.get(row.name) !== row.checksum
    ) {
      throw new Error('Applied migration does not match this application');
    }
    applied.add(row.name);
  }
  if (requireAll && applied.size !== migrations.length) throw new Error('Pending migrations');
  // Applied migrations must be a prefix, never skip an earlier migration.
  let pending = false;
  for (const migration of migrations) {
    if (!applied.has(migration.name)) pending = true;
    else if (pending) throw new Error('Applied migrations are out of order');
  }
  return applied;
}

export async function migrate(pool: Pool, suppliedMigrations?: Migration[]) {
  const migrations = suppliedMigrations ?? (await loadMigrations());
  await withTransaction(pool, async (client) => {
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL lock_timeout = '10s'");
    // Transaction-scoped lock serializes runners and is released even on failure.
    await client.query('SELECT pg_advisory_xact_lock(1129072975, 1)');
    await client.query(`CREATE TABLE IF NOT EXISTS clio_schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const result = await client.query<Record<string, unknown>>(
      'SELECT name, checksum FROM clio_schema_migrations ORDER BY name',
    );
    const applied = checkApplied(result.rows, migrations, false);
    for (const migration of migrations) {
      if (applied.has(migration.name)) continue;
      await client.query(migration.sql);
      await client.query('INSERT INTO clio_schema_migrations (name, checksum) VALUES ($1, $2)', [
        migration.name,
        migration.checksum,
      ]);
    }
  });
}

export async function checkReadiness(pool: Pool, migrations: Migration[]) {
  const result = await pool.query<Record<string, unknown>>(
    'SELECT name, checksum FROM clio_schema_migrations ORDER BY name',
  );
  checkApplied(result.rows, migrations, true);
  // Also detect missing tables/columns rather than trusting ledger alone.
  await pool.query('SELECT id, name, created_at FROM workspaces LIMIT 0');
  await pool.query('SELECT id, workspace_id, name, created_at FROM services LIMIT 0');
}
