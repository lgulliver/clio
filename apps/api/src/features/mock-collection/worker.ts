import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { withTransaction } from '../../db/pool.ts';
import { captureMapping } from '../deployment-mappings/preview.ts';
import { name, uuid } from '../identity/input.ts';
import { snapshotDigest } from './digest.ts';
import { parseMapping } from './model.ts';

export function createMockWorker(pool: Pool) {
  return {
    async claim() {
      return withTransaction(pool, async (client) => {
        // Exhausted expired leases never remain active indefinitely.
        const expired =
          await client.query(`WITH expired AS (SELECT id FROM mock_collection_runs WHERE status='running' AND lease_until <= clock_timestamp() AND attempts=3 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
          UPDATE mock_collection_runs SET status='failed',failure_code='mock_processing_failed',completed_at=statement_timestamp(),updated_at=statement_timestamp(),lease_token=NULL,lease_until=NULL WHERE id IN (SELECT id FROM expired)`);
        if (expired.rowCount) return null;
        const token = randomUUID();
        const claimed = await client.query<Record<string, unknown>>(
          `WITH eligible AS (
          SELECT id FROM mock_collection_runs WHERE attempts < 3 AND ((status='pending' AND available_at <= clock_timestamp()) OR (status='running' AND lease_until <= clock_timestamp())) ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
          UPDATE mock_collection_runs SET status='running',attempts=attempts+1,lease_token=$1,lease_until=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp() WHERE id IN (SELECT id FROM eligible) RETURNING id,mapping_input,service_name`,
          [token],
        );
        const row = claimed.rows[0];
        if (!row) return null;
        // Keep claim raw: malformed private inputs must consume bounded attempts.
        return {
          id: uuid(row.id),
          token,
          mapping: row.mapping_input,
          serviceName: row.service_name,
        };
      });
    },
    async complete(
      claim: { id: string; token: string; mapping: unknown; serviceName: unknown },
      capture: ReturnType<typeof captureMapping>,
    ) {
      const mapping = parseMapping(claim.mapping);
      const serviceName = name(claim.serviceName);
      const expected = captureMapping(mapping, { id: mapping.serviceId, name: serviceName });
      if (!isDeepStrictEqual(capture, expected)) throw new Error('Capture mismatch');
      const payload = { mapping, serviceName, ...capture };
      const digest = snapshotDigest(payload);
      return withTransaction(pool, async (client) => {
        const locked = await client.query<Record<string, unknown>>(
          `SELECT mapping_input,service_name,workspace_id,service_id,mapping_revision FROM mock_collection_runs WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until > clock_timestamp() FOR UPDATE`,
          [claim.id, claim.token],
        );
        const row = locked.rows[0];
        if (!row) return false;
        if (
          !isDeepStrictEqual(parseMapping(row.mapping_input), mapping) ||
          row.service_name !== serviceName
        )
          throw new Error('Captured input mismatch');
        await client.query(
          `INSERT INTO mock_collection_snapshots (run_id,workspace_id,service_id,mapping_revision,mapping_input,service_name,evidence,snapshot,metrics,oems_revision,public_result,digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            claim.id,
            mapping.workspaceId,
            mapping.serviceId,
            mapping.revision,
            JSON.stringify(mapping),
            row.service_name,
            JSON.stringify(capture.evidence),
            JSON.stringify(capture.snapshot),
            JSON.stringify(capture.metrics),
            capture.oemsRevision,
            JSON.stringify(capture.preview),
            digest,
          ],
        );
        const updated = await client.query(
          `UPDATE mock_collection_runs SET status='succeeded',result=$3,completed_at=statement_timestamp(),updated_at=statement_timestamp(),lease_token=NULL,lease_until=NULL WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until > clock_timestamp()`,
          [claim.id, claim.token, JSON.stringify(capture.preview)],
        );
        // Expiry during insertion must roll back snapshot too.
        if (!updated.rowCount) throw new LeaseLost();
        return true;
      }).catch((error) => {
        if (error instanceof LeaseLost) return false;
        throw error;
      });
    },
    async fail(claim: { id: string; token: string }) {
      const failed = await pool.query(
        `UPDATE mock_collection_runs SET status=CASE WHEN attempts=3 THEN 'failed' ELSE 'pending' END, failure_code=CASE WHEN attempts=3 THEN 'mock_processing_failed' ELSE NULL END, completed_at=CASE WHEN attempts=3 THEN statement_timestamp() ELSE NULL END, available_at=clock_timestamp()+attempts*interval '1 second', updated_at=statement_timestamp(),lease_token=NULL,lease_until=NULL WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until > clock_timestamp()`,
        [claim.id, claim.token],
      );
      return Boolean(failed.rowCount);
    },
  };
}
class LeaseLost extends Error {}

/** One claim, pure fixture processing outside claim/completion transactions. */
export async function processOne(
  pool: Pool,
  process = (mapping: unknown, serviceName: unknown) => {
    const parsed = parseMapping(mapping);
    return captureMapping(parsed, { id: parsed.serviceId, name: name(serviceName) });
  },
) {
  const worker = createMockWorker(pool);
  const claim = await worker.claim();
  if (!claim) return false;
  try {
    const capture = process(claim.mapping, claim.serviceName);
    await worker.complete(claim, capture);
  } catch {
    await worker.fail(claim);
    console.error('Mock collection processing failed');
  }
  return true;
}
