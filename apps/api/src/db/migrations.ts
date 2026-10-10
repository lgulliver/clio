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
  await pool.query(
    'SELECT source_id,journal_id,producer_id,policy_reference,startup_at,registered_at,last_sequence,last_digest,last_capture_at,sealed_sequence,sealed_end FROM argo_archive_journals LIMIT 0',
  );
  await pool.query(
    'SELECT id,source_id,journal_id,producer_id,native_fingerprint,archive_fingerprint,connection_revision,kind,sequence,seal_id,digest,record,captured_at,received_at,receipt_id,gap_reason,remaining_rows,remaining_bytes FROM argo_archive_records LIMIT 0',
  );
  await pool.query(
    'SELECT receipt_id,kind,authority_id,native_fingerprint,archive_fingerprint,journal_id,producer_id,observed_at FROM argo_receipt_authorities LIMIT 0',
  );
  await pool.query('SELECT source_id,tokens,refilled_at FROM argo_archive_buckets LIMIT 0');
  await pool.query(
    'SELECT id,source_id,workspace_id,service_id,connection_revision,producer_id,event_id,native_fingerprint,producer_fingerprint,scope,event,digest,observed_at FROM argo_enrichment_receipts LIMIT 0',
  );
  await pool.query(
    'SELECT source_id,application_uid,operation_id,subject FROM argo_enrichment_subjects LIMIT 0',
  );
  await pool.query(
    'SELECT source_id,artifact_digest,repository_id,commit_sha FROM argo_enrichment_artifacts LIMIT 0',
  );
  await pool.query(
    'SELECT app_id,installation_id,next_request_at,blocked_until,consecutive_throttles,lease_token,lease_until FROM github_quota_state LIMIT 0',
  );
  await pool.query(
    'SELECT workspace_id,service_id,connection_revision,app_id,installation_id,repository_id,grant_fingerprint,run_id,lease_token,cursor,updated_at FROM github_collection_checkpoints LIMIT 0',
  );
  await pool.query('SELECT source_id,tokens,refilled_at FROM argo_ingress_buckets LIMIT 0');
  await pool.query(
    'SELECT workspace_id,service_id,revision,connection,grant_fingerprint,scope,created_by,enrichment_grants,archive_grant FROM argo_connection_revisions LIMIT 0',
  );
  await pool.query(
    'SELECT id,workspace_id,service_id,connection_revision,request_id,connection_input,grant_fingerprint,window_input,service_name,status,attempts,created_at,updated_at,completed_at,failure_code,result,lease_token,lease_until,available_at FROM argo_collection_runs LIMIT 0',
  );
  await pool.query(
    'SELECT run_id,workspace_id,service_id,connection_revision,connection_input,service_name,evidence,snapshot,metrics,oems_revision,public_result,digest FROM argo_collection_snapshots LIMIT 0',
  );
  await pool.query(
    'SELECT source_id,workspace_id,service_id,retained_rows,retained_bytes,rejection_count,scope_drift_count,first_observed_at FROM argo_source_state LIMIT 0',
  );
  await pool.query(
    'SELECT source_id,application_uid,operation_id,metadata_digest FROM argo_operation_metadata LIMIT 0',
  );
  await pool.query(
    'SELECT id,source_id,workspace_id,service_id,connection_revision,application_uid,grant_fingerprint,scope,digest,observed_at,started_at,operation_id,notification_revision,phase,health,reason,canonical_json,evidence,origin_transport FROM argo_receipts LIMIT 0',
  );
  await pool.query(
    'SELECT source_id,grant_fingerprint,workspace_id,service_id,connection_revision,observed_at FROM argo_interruptions LIMIT 0',
  );
  await pool.query(
    'SELECT workspace_id,service_id,revision,connection,grant_fingerprint,created_by FROM github_connection_revisions LIMIT 0',
  );
  await pool.query(
    'SELECT id,workspace_id,service_id,connection_revision,request_id,connection_input,grant_fingerprint,window_input,service_name,status,attempts,created_at,updated_at,completed_at,failure_code,result,lease_token,lease_until,available_at,quota_app_id FROM github_collection_runs LIMIT 0',
  );
  await pool.query(
    'SELECT workspace_id,service_id,installation_id,repository_id,kind,record_key,observed_at,payload FROM github_collection_history LIMIT 0',
  );
  await pool.query(
    'SELECT run_id,workspace_id,service_id,connection_revision,connection_input,service_name,evidence,snapshot,metrics,oems_revision,public_result,digest FROM github_collection_snapshots LIMIT 0',
  );
  await pool.query('SELECT id, name, created_at FROM workspaces LIMIT 0');
  await pool.query('SELECT id, workspace_id, name, created_at FROM services LIMIT 0');
  await pool.query(
    'SELECT workspace_id, service_id, mode, revision, primary_provider, production_environment, exposure_attested, observed_at, created_by FROM deployment_mapping_revisions LIMIT 0',
  );
  await pool.query(
    'SELECT id, workspace_id, service_id, mapping_revision, request_id, mapping_input, service_name, status, attempts, created_at, updated_at, completed_at, failure_code, result, lease_token, lease_until, available_at FROM mock_collection_runs LIMIT 0',
  );
  await pool.query(
    'SELECT run_id, workspace_id, service_id, mapping_revision, mapping_input, service_name, evidence, snapshot, metrics, oems_revision, public_result, digest FROM mock_collection_snapshots LIMIT 0',
  );
  await pool.query(
    'SELECT id, name, email, email_verified, image, created_at, updated_at FROM auth_users LIMIT 0',
  );
  await pool.query(
    'SELECT id, user_id, token, expires_at, ip_address, user_agent, created_at, updated_at FROM auth_sessions LIMIT 0',
  );
  await pool.query(
    'SELECT id, user_id, account_id, provider_id, access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope, password, created_at, updated_at FROM auth_accounts LIMIT 0',
  );
  await pool.query(
    'SELECT id, identifier, value, expires_at, created_at, updated_at FROM auth_verifications LIMIT 0',
  );
  await pool.query(
    'SELECT workspace_id, user_id, role, created_at FROM workspace_memberships LIMIT 0',
  );
  await pool.query(
    'SELECT id, workspace_id, email, token_hash, created_by, expires_at, consumed_at, cancelled_at, created_at FROM workspace_invitations LIMIT 0',
  );
}
