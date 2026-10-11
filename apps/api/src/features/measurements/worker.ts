import { randomUUID } from 'node:crypto';
import { oemsContract } from '@clio/oems';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../db/pool.ts';
import { snapshotDigest } from '../github-collection/digest.ts';
import { windowInput } from '../github-collection/input.ts';
import { uuid } from '../identity/input.ts';
import { receiverTime, workspaceLock } from './ingress.ts';
import { parseJobInput } from './input.ts';
import { deriveSelected, validateJob } from './repository.ts';
import { parseMeasurementResult } from './result.ts';
import { type MeasurementDependencies, MeasurementRevoked } from './source-eligibility.ts';

export const measurementLeaseSeconds = 120;
export interface MeasurementClaim {
  id: string;
  token: string;
  workspaceId: string;
  serviceId: string;
}
class LeaseLost extends Error {}
export function createMeasurementWorker(pool: Pool, dependencies: MeasurementDependencies) {
  async function current(client: PoolClient, claim: MeasurementClaim) {
    await workspaceLock(client, claim.workspaceId);
    const found = await client.query<Record<string, unknown>>(
      `SELECT * FROM measurement_runs WHERE id=$1 AND workspace_id=$3 AND service_id=$4 AND status='running' AND lease_token=$2 AND lease_until>clock_timestamp() FOR UPDATE`,
      [claim.id, claim.token, claim.workspaceId, claim.serviceId],
    );
    const row = found.rows[0];
    if (!row) throw new LeaseLost();
    const job = parseJobInput(row.input);
    if (
      job.workspaceId !== claim.workspaceId ||
      job.serviceId !== claim.serviceId ||
      job.basis.runId !== row.basis_run_id ||
      job.basis.provider !== row.provider ||
      job.sourceScope !== row.source_scope
    )
      throw new Error('Invalid measurement job scope');
    return { job, input: await validateJob(client, dependencies, job) };
  }
  const worker = {
    async claim(): Promise<MeasurementClaim | null> {
      return withTransaction(pool, async (client) => {
        // Candidate read takes no row lock. Workspace comes first, then recheck/lock candidate.
        const candidates = await client.query<Record<string, unknown>>(
          `SELECT id,workspace_id,service_id FROM measurement_runs WHERE (status='pending' AND available_at<=clock_timestamp()) OR (status='running' AND lease_until<=clock_timestamp()) ORDER BY available_at,created_at,id LIMIT 25`,
        );
        for (const candidate of candidates.rows) {
          const wid = uuid(candidate.workspace_id),
            sid = uuid(candidate.service_id),
            id = uuid(candidate.id);
          const workspace = await client.query(
            'SELECT id FROM workspaces WHERE id=$1 FOR UPDATE SKIP LOCKED',
            [wid],
          );
          if (!workspace.rowCount) continue;
          const found = await client.query<Record<string, unknown>>(
            `SELECT attempts FROM measurement_runs WHERE id=$1 AND ((status='pending' AND available_at<=clock_timestamp()) OR (status='running' AND lease_until<=clock_timestamp())) FOR UPDATE SKIP LOCKED`,
            [id],
          );
          if (!found.rows[0]) continue;
          if (found.rows[0].attempts === 3) {
            await client.query(
              `UPDATE measurement_runs SET status='failed',failure_code='measurement_processing_failed',completed_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token=NULL,lease_until=NULL WHERE id=$1`,
              [id],
            );
            return null;
          }
          const token = randomUUID();
          await client.query(
            `UPDATE measurement_runs SET status='running',attempts=attempts+1,lease_token=$2,lease_until=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp() WHERE id=$1`,
            [id, token],
          );
          return { id, token, workspaceId: wid, serviceId: sid };
        }
        return null;
      });
    },
    async complete(claim: MeasurementClaim): Promise<boolean> {
      try {
        const prepared = await withTransaction(pool, async (client) => {
          const state = await current(client, claim),
            cutoff = await receiverTime(client, state.input.basis.snapshot.data.evidence_cutoff);
          return { ...state, cutoff };
        });
        // Pure reconciliation/calculation runs without a checked-out client.
        const derived = deriveSelected(prepared.input, prepared.cutoff),
          metric = derived.metrics[0];
        if (!metric || derived.metrics.length !== 1) throw new Error('Invalid measurement service');
        const b = prepared.job.basis,
          w = prepared.input.basis.snapshot.data.window;
        const result = parseMeasurementResult({
          contract: 'clio.measurement.result.v1',
          workspaceId: claim.workspaceId,
          serviceId: claim.serviceId,
          provider: b.provider,
          basisRunId: b.runId,
          connectionRevision: b.connectionRevision,
          oemsRevision: oemsContract.revision,
          window: windowInput({ start: w.start, end: w.end }),
          basisEvidenceCutoff: prepared.input.basis.snapshot.data.evidence_cutoff,
          evidenceCutoff: prepared.cutoff,
          assessment: derived.assessment,
          coverage: {
            collectionComplete: derived.assessment.collectionComplete,
            deploymentHistoryComplete: derived.assessment.historyComplete,
            recoveryEvidenceComplete: derived.assessment.recoveryComplete,
          },
          metricResult: metric,
        });
        return await withTransaction(pool, async (client) => {
          const fresh = await current(client, claim);
          if (snapshotDigest(fresh.job) !== snapshotDigest(prepared.job))
            throw new MeasurementRevoked();
          const privateSnapshot = {
            snapshot: derived.snapshot.data,
            metrics: derived.metrics,
            lineage: prepared.job,
            publicResult: result,
          };
          await client.query(
            'INSERT INTO measurement_snapshots(run_id,workspace_id,service_id,snapshot,metrics,lineage,public_result,digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
            [
              claim.id,
              claim.workspaceId,
              claim.serviceId,
              JSON.stringify(privateSnapshot.snapshot),
              JSON.stringify(privateSnapshot.metrics),
              JSON.stringify(privateSnapshot.lineage),
              JSON.stringify(result),
              snapshotDigest(privateSnapshot),
            ],
          );
          // Final config check occurs after insert but before transition; any failure rolls both back.
          await validateJob(client, dependencies, prepared.job);
          const done = await client.query(
            `UPDATE measurement_runs SET status='succeeded',result=$3,completed_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token=NULL,lease_until=NULL WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>clock_timestamp()`,
            [claim.id, claim.token, JSON.stringify(result)],
          );
          if (!done.rowCount) throw new LeaseLost();
          return true;
        });
      } catch (error) {
        if (error instanceof LeaseLost) return false;
        throw error;
      }
    },
    async fail(claim: MeasurementClaim, revoked = false): Promise<boolean> {
      return withTransaction(pool, async (client) => {
        await workspaceLock(client, claim.workspaceId);
        const updated = await client.query(
          `UPDATE measurement_runs SET status=CASE WHEN attempts=3 OR $3 THEN 'failed' ELSE 'pending' END,failure_code=CASE WHEN $3 THEN 'measurement_revoked' WHEN attempts=3 THEN 'measurement_processing_failed' ELSE NULL END,completed_at=CASE WHEN attempts=3 OR $3 THEN clock_timestamp() ELSE NULL END,available_at=clock_timestamp()+interval '1 second',updated_at=clock_timestamp(),lease_token=NULL,lease_until=NULL WHERE id=$1 AND workspace_id=$4 AND service_id=$5 AND status='running' AND lease_token=$2 AND lease_until>clock_timestamp()`,
          [claim.id, claim.token, revoked, claim.workspaceId, claim.serviceId],
        );
        return Boolean(updated.rowCount);
      });
    },
    async runOnce(): Promise<boolean> {
      const claim = await worker.claim();
      if (!claim) return false;
      try {
        await worker.complete(claim);
      } catch (error) {
        await worker.fail(claim, error instanceof MeasurementRevoked);
      }
      return true;
    },
  };
  return worker;
}
