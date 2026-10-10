import type { Pool } from 'pg';
import { withTransaction } from '../../db/pool.ts';

/** Shared source budget survives process restarts, replicas, and credential rotation. */
export async function consumeIngressToken(pool: Pool, sourceId: string) {
  return withTransaction(pool, async (client) => {
    await client.query(
      'INSERT INTO argo_ingress_buckets(source_id,tokens,refilled_at) VALUES($1,10,clock_timestamp()) ON CONFLICT DO NOTHING',
      [sourceId],
    );
    const row = await client.query<Record<string, unknown>>(
      'SELECT tokens,refilled_at::text AS refilled_at FROM argo_ingress_buckets WHERE source_id=$1 FOR UPDATE',
      [sourceId],
    );
    const old = row.rows[0];
    if (!old) throw new Error('Missing ingress bucket');
    const refill = await client.query<Record<string, unknown>>(
      'SELECT LEAST(10,$1::double precision+GREATEST(0,extract(epoch FROM clock_timestamp()-$2::timestamptz))/2)::double precision AS tokens,clock_timestamp()::text AS now',
      [old.tokens, old.refilled_at],
    );
    const tokens = Number(refill.rows[0]?.tokens);
    if (!Number.isFinite(tokens) || tokens < 0 || tokens > 10)
      throw new Error('Invalid ingress bucket');
    const allowed = tokens >= 1;
    await client.query(
      'UPDATE argo_ingress_buckets SET tokens=$2,refilled_at=GREATEST(refilled_at,$3::timestamptz) WHERE source_id=$1',
      [sourceId, allowed ? tokens - 1 : tokens, refill.rows[0]?.now],
    );
    return allowed;
  });
}

export async function consumeArchiveToken(pool: Pool, sourceId: string) {
  return withTransaction(pool, async (client) => {
    await client.query(
      'INSERT INTO argo_ingress_buckets(source_id,tokens,refilled_at) VALUES($1,10,clock_timestamp()) ON CONFLICT DO NOTHING',
      [sourceId],
    );
    await client.query(
      'INSERT INTO argo_archive_buckets(source_id,tokens,refilled_at) VALUES($1,2,clock_timestamp()) ON CONFLICT DO NOTHING',
      [sourceId],
    );
    await client.query('SELECT source_id FROM argo_ingress_buckets WHERE source_id=$1 FOR UPDATE', [
      sourceId,
    ]);
    await client.query('SELECT source_id FROM argo_archive_buckets WHERE source_id=$1 FOR UPDATE', [
      sourceId,
    ]);
    const found = await client.query<Record<string, unknown>>(
      `SELECT LEAST(10,s.tokens+GREATEST(0,extract(epoch FROM clock_timestamp()-s.refilled_at))/2) AS shared,LEAST(2,a.tokens+GREATEST(0,extract(epoch FROM clock_timestamp()-a.refilled_at))/4) AS archive,clock_timestamp()::text AS now FROM argo_ingress_buckets s JOIN argo_archive_buckets a USING(source_id) WHERE source_id=$1`,
      [sourceId],
    );
    const shared = Number(found.rows[0]?.shared),
      archive = Number(found.rows[0]?.archive);
    if (!Number.isFinite(shared) || !Number.isFinite(archive))
      throw new Error('Invalid archive bucket');
    const allowed = shared >= 3 && archive >= 1;
    await client.query(
      'UPDATE argo_ingress_buckets SET tokens=$2,refilled_at=GREATEST(refilled_at,$3::timestamptz) WHERE source_id=$1',
      [sourceId, shared - (allowed ? 1 : 0), found.rows[0]?.now],
    );
    await client.query(
      'UPDATE argo_archive_buckets SET tokens=$2,refilled_at=GREATEST(refilled_at,$3::timestamptz) WHERE source_id=$1',
      [sourceId, archive - (allowed ? 1 : 0), found.rows[0]?.now],
    );
    return allowed;
  });
}
