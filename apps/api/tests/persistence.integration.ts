import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrl } from '../src/config.ts';
import { checkReadiness, loadMigrations, migrate } from '../src/db/migrations.ts';
import { withTransaction } from '../src/db/pool.ts';
import { createRepository } from '../src/features/workspaces/repository.ts';

// Fails visibly when absent. Never falls back to DATABASE_URL or skips tests.
if (!process.env.CLIO_TEST_DATABASE_URL) {
  throw new Error('CLIO_TEST_DATABASE_URL is required for PostgreSQL integration tests');
}
const connectionString = databaseUrl(process.env.CLIO_TEST_DATABASE_URL);
const schema = `clio_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({
  connectionString,
  connectionTimeoutMillis: 3000,
  statement_timeout: 10000,
});
const pool = new Pool({
  connectionString,
  options: `-c search_path=${schema}`,
  connectionTimeoutMillis: 3000,
  statement_timeout: 10000,
});
const repository = createRepository(pool);
const migrations = await loadMigrations();
let schemaCreated = false;

beforeAll(async () => {
  // Only internally generated identifiers are interpolated. No user-owned schema is dropped.
  await admin.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
});

afterAll(async () => {
  await pool.end();
  try {
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await admin.end();
  }
});

describe('real PostgreSQL foundation', () => {
  it('rejects unmigrated schema, serializes concurrent runners and is idempotent', async () => {
    await expect(checkReadiness(pool, migrations)).rejects.toThrow();
    await migrate(
      pool,
      migrations.filter((migration) => migration.name < '0014_'),
    );
    const preservedWorkspace = randomUUID();
    await repository.createWorkspace(preservedWorkspace, 'Existing workspace');
    const preservedService = await repository.createService(preservedWorkspace, 'Existing service');
    await Promise.all([migrate(pool, migrations), migrate(pool, migrations)]);
    expect(await repository.getService(preservedWorkspace, preservedService.id)).toEqual(
      preservedService,
    );
    const assignment = await pool.query('SELECT product_id FROM services WHERE id = $1', [
      preservedService.id,
    ]);
    expect(assignment.rows).toEqual([{ product_id: null }]);
    await migrate(pool, migrations);
    await expect(checkReadiness(pool, migrations)).resolves.toBeUndefined();
    const ledger = await pool.query<Record<string, unknown>>(
      'SELECT count(*)::int AS count FROM clio_schema_migrations',
    );
    expect(ledger.rows[0]?.count).toBe(migrations.length);
  });

  it('persists workspaces and services without returning rows from another workspace', async () => {
    const first = randomUUID();
    const second = randomUUID();
    await repository.createWorkspace(first, 'First');
    await repository.createWorkspace(second, 'Second');
    const service = await repository.createService(first, "Delivery ' OR true --");
    const other = await repository.createService(second, service.name);
    expect(await repository.getWorkspace(first)).toEqual({ id: first, name: 'First' });
    expect(await repository.getWorkspace(randomUUID())).toBeNull();
    expect(await repository.getService(first, service.id)).toEqual(service);
    expect(await repository.getService(second, service.id)).toBeNull();
    expect(await repository.listServices(first)).toEqual([service]);
    expect(await repository.listServices(second)).toEqual([other]);
    expect(await repository.listServices(randomUUID())).toEqual([]);
    await expect(repository.createService(first, service.name)).rejects.toMatchObject({
      code: '23505',
    });
    await expect(repository.createWorkspace(first, 'Duplicate')).rejects.toMatchObject({
      code: '23505',
    });
    await expect(repository.createService(randomUUID(), 'Orphan')).rejects.toMatchObject({
      code: '23503',
    });
    await expect(repository.createService(first, ' ')).rejects.toThrow('Name');
    await expect(repository.listServices('invalid')).rejects.toThrow('UUID');
    await expect(
      pool.query('INSERT INTO services (id, workspace_id, name) VALUES ($1, $2, $3)', [
        randomUUID(),
        first,
        '',
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('normalizes Unicode names and UUIDs while database rejects noncanonical names', async () => {
    const id = randomUUID();
    const normalized = '😀'.repeat(200);
    const created = await repository.createWorkspace(id.toUpperCase(), ` \t${normalized}\n `);
    expect(created).toEqual({ id, name: normalized });
    expect(await repository.getWorkspace(id.toUpperCase())).toEqual(created);
    await expect(repository.createService(id, '😀'.repeat(201))).rejects.toThrow('Name');
    for (const invalid of ['\t\n', '\u00a0', ' padded ', '😀'.repeat(201)]) {
      await expect(
        pool.query('INSERT INTO services (id, workspace_id, name) VALUES ($1, $2, $3)', [
          randomUUID(),
          id,
          invalid,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('commits related writes together and rolls back entire transaction on duplicate', async () => {
    const committed = randomUUID();
    await withTransaction(pool, async (client) => {
      const scoped = createRepository(client);
      await scoped.createWorkspace(committed, 'Committed');
      await scoped.createService(committed, 'API');
    });
    expect(await repository.getWorkspace(committed)).not.toBeNull();
    expect(await repository.listServices(committed)).toHaveLength(1);
    const rolledBack = randomUUID();
    await expect(
      withTransaction(pool, async (client) => {
        const scoped = createRepository(client);
        await scoped.createWorkspace(rolledBack, 'Rollback');
        await scoped.createService(rolledBack, 'API');
        await scoped.createService(rolledBack, 'API');
      }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(await repository.getWorkspace(rolledBack)).toBeNull();
    expect(await repository.listServices(rolledBack)).toEqual([]);
  });

  it('rejects changed applied SQL and rolls back failed DDL and ledger writes', async () => {
    const changed = migrations.map((migration) => ({ ...migration, checksum: 'changed' }));
    await expect(migrate(pool, changed)).rejects.toThrow('does not match');
    await expect(checkReadiness(pool, changed)).rejects.toThrow('does not match');
    const bad = {
      name: '9999_failure.sql',
      checksum: 'test',
      sql: 'CREATE TABLE rollback_probe (id int); SELECT * FROM nonexistent_clio_test_table;',
    };
    await expect(checkReadiness(pool, [...migrations, bad])).rejects.toThrow('Pending');
    await expect(migrate(pool, [...migrations, bad])).rejects.toThrow();
    const probe = await pool.query<Record<string, unknown>>(
      "SELECT to_regclass('rollback_probe') AS relation",
    );
    expect(probe.rows[0]?.relation).toBeNull();
    const ledger = await pool.query<Record<string, unknown>>(
      'SELECT name FROM clio_schema_migrations WHERE name = $1',
      [bad.name],
    );
    expect(ledger.rows).toEqual([]);
    await expect(checkReadiness(pool, migrations)).resolves.toBeUndefined();
  });

  it('rejects a migration history that skips an earlier revision', async () => {
    const earlier = { name: '0000_earlier.sql', checksum: 'test', sql: 'SELECT 1;' };
    await expect(migrate(pool, [earlier, ...migrations])).rejects.toThrow('out of order');
    await expect(checkReadiness(pool, [earlier, ...migrations])).rejects.toThrow();
    await expect(checkReadiness(pool, migrations)).resolves.toBeUndefined();
  });

  it('requires archive tables, pins and authority columns for readiness', async () => {
    for (const [table, column] of [
      ['argo_archive_journals', 'last_sequence'],
      ['argo_archive_records', 'archive_fingerprint'],
      ['argo_receipt_authorities', 'observed_at'],
      ['teams', 'workspace_id'],
      ['products', 'team_id'],
      ['services', 'product_id'],
      ['argo_archive_buckets', 'tokens'],
      ['argo_connection_revisions', 'archive_grant'],
      ['argo_receipts', 'origin_transport'],
    ]) {
      await pool.query(`ALTER TABLE ${table} RENAME COLUMN ${column} TO archive_readiness_probe`);
      try {
        await expect(checkReadiness(pool, migrations)).rejects.toThrow();
      } finally {
        await pool.query(`ALTER TABLE ${table} RENAME COLUMN archive_readiness_probe TO ${column}`);
      }
      await expect(checkReadiness(pool, migrations)).resolves.toBeUndefined();
    }
  });

  it('detects schema drift even with matching migration history', async () => {
    await pool.query('ALTER TABLE argo_receipts RENAME COLUMN grant_fingerprint TO removed_grant');
    try {
      await expect(checkReadiness(pool, migrations)).rejects.toThrow();
    } finally {
      await pool.query(
        'ALTER TABLE argo_receipts RENAME COLUMN removed_grant TO grant_fingerprint',
      );
    }
    await expect(checkReadiness(pool, migrations)).resolves.toBeUndefined();
    await pool.query('ALTER TABLE services RENAME COLUMN name TO removed_name');
    try {
      await expect(checkReadiness(pool, migrations)).rejects.toThrow();
    } finally {
      await pool.query('ALTER TABLE services RENAME COLUMN removed_name TO name');
    }
    await expect(checkReadiness(pool, migrations)).resolves.toBeUndefined();
  });
});
