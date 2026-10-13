import { randomUUID } from 'node:crypto';
import { type PullCheckpoint, parsePullCheckpoint } from '@clio/adapters';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../db/pool.ts';
import { uuid } from '../identity/input.ts';
import { calculateSignals } from './calculate.ts';
import { terminalizePullCheckpoint } from './checkpoint.ts';
import { grantFor, type SpaceGitHubConfig } from './config.ts';
import {
  contractVersion,
  type OperationContext,
  type OperationResult,
  type RunReason,
} from './contract.ts';
import { contextFrom, type StoredRow } from './repository.ts';
import { parseStoredResult } from './stored-result.ts';
export interface SpaceGitHubClaim {
  id: string;
  workspaceId: string;
  mappingId: string;
  token: string;
  claimedAt: string;
}
export class JobLost extends Error {
  constructor() {
    super('SPACE GitHub job unavailable');
  }
}
function configReason(
  row: StoredRow,
  mapping: StoredRow | undefined,
  config: SpaceGitHubConfig | null,
): RunReason | null {
  if (!mapping?.connected) return 'disconnected';
  try {
    const context = contextFrom(row.context);
    const grant = grantFor(
      config,
      context.workspaceId,
      context.installationId,
      context.repositoryId,
    );
    if (
      !config ||
      !grant ||
      config.appId !== context.appId ||
      grant.fingerprint !== row.grant_fingerprint ||
      mapping.grant_fingerprint !== grant.fingerprint
    )
      return 'grant_removed';
    if (
      Number(mapping.revision) !== context.mappingRevision ||
      Number(mapping.app_id) !== context.appId ||
      Number(mapping.installation_id) !== context.installationId ||
      Number(mapping.repository_id) !== context.repositoryId ||
      mapping.team_id !== context.teamId
    )
      return 'scope_changed';
    return null;
  } catch {
    return 'invalid_provider_data';
  }
}
async function terminal(client: PoolClient, id: string, reason: RunReason) {
  const cancelled =
    reason === 'scope_changed' || reason === 'disconnected' || reason === 'grant_removed';
  await client.query(
    "UPDATE space_github_jobs SET state=$2,reason=$3,completed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL WHERE id=$1 AND state IN('queued','running')",
    [id, cancelled ? 'cancelled' : 'failed', reason],
  );
}
interface Acquisition {
  activeMillis: number;
  startedAt: string;
  endedAt: string;
}
async function account(client: PoolClient, row: StoredRow, input: Acquisition) {
  if (!Number.isSafeInteger(input.activeMillis) || input.activeMillis < 0)
    throw new Error('Invalid active time');
  await client.query(
    'UPDATE space_github_jobs SET active_millis=$2,acquisition_started_at=COALESCE(acquisition_started_at,clock_timestamp()),acquisition_ended_at=GREATEST(clock_timestamp(),acquisition_started_at,acquisition_ended_at) WHERE id=$1',
    [row.id, Math.min(1800000, Number(row.active_millis) + input.activeMillis)],
  );
}
export function createSpaceGitHubJobs(pool: Pool, configNow: () => SpaceGitHubConfig | null) {
  async function lock(client: PoolClient, claim: SpaceGitHubClaim, acquisition?: Acquisition) {
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [claim.workspaceId]);
    const rows = await client.query<StoredRow>(
      "SELECT *,to_char(acquisition_started_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS acquisition_started_at,expires_at<=clock_timestamp() AS expired FROM space_github_jobs WHERE workspace_id=$1 AND mapping_id=$2 AND id=$3 AND state='running' AND lease_token=$4 AND lease_until>clock_timestamp() FOR UPDATE",
      [claim.workspaceId, claim.mappingId, claim.id, claim.token],
    );
    const row = rows.rows[0];
    if (!row) return null;
    const mappings = await client.query<StoredRow>(
      'SELECT * FROM space_github_mappings WHERE workspace_id=$1 AND id=$2',
      [claim.workspaceId, claim.mappingId],
    );
    const reason = row.expired ? 'expired' : configReason(row, mappings.rows[0], configNow());
    if (reason) {
      if (acquisition) await account(client, row, acquisition);
      await terminal(client, claim.id, reason);
      return null;
    }
    return row;
  }
  return {
    async claim(): Promise<SpaceGitHubClaim | null> {
      return withTransaction(pool, async (client) => {
        // Workspace-first locks agree with browser writes; cooldown never hides lifetime expiry.
        const candidates = await client.query<StoredRow>(
          "SELECT id,workspace_id,mapping_id FROM space_github_jobs WHERE (state='queued' AND (available_at<=clock_timestamp() OR expires_at<=clock_timestamp())) OR (state='running' AND lease_until<=clock_timestamp()) ORDER BY available_at,queued_at,id LIMIT 25",
        );
        for (const candidate of candidates.rows) {
          const wid = uuid(candidate.workspace_id),
            mid = uuid(candidate.mapping_id),
            id = uuid(candidate.id);
          const workspace = await client.query(
            'SELECT id FROM workspaces WHERE id=$1 FOR UPDATE SKIP LOCKED',
            [wid],
          );
          if (!workspace.rowCount) continue;
          const rows = await client.query<StoredRow>(
            "SELECT *,to_char(acquisition_started_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS acquisition_started_at,expires_at<=clock_timestamp() AS expired FROM space_github_jobs WHERE id=$1 AND ((state='queued' AND (available_at<=clock_timestamp() OR expires_at<=clock_timestamp())) OR (state='running' AND lease_until<=clock_timestamp())) FOR UPDATE SKIP LOCKED",
            [id],
          );
          const row = rows.rows[0];
          if (!row) continue;
          const mappings = await client.query<StoredRow>(
            'SELECT * FROM space_github_mappings WHERE workspace_id=$1 AND id=$2',
            [wid, mid],
          );
          const reason = row.expired ? 'expired' : configReason(row, mappings.rows[0], configNow());
          if (reason) {
            await terminal(client, id, reason);
            continue;
          }
          if (Number(row.failures) >= 3) {
            await terminal(client, id, 'retry_exhausted');
            continue;
          }
          const token = randomUUID();
          const claimed = await client.query<{ claimed_at: string }>(
            `WITH stamp AS (SELECT clock_timestamp() AS now) UPDATE space_github_jobs SET active_millis=LEAST(1800000,active_millis+CASE WHEN state='running' THEN 120000 ELSE 0 END),state='running',lease_token=$2,lease_until=LEAST(expires_at,stamp.now+interval '120 seconds'),acquisition_started_at=COALESCE(acquisition_started_at,stamp.now),acquisition_ended_at=GREATEST(stamp.now,acquisition_ended_at) FROM stamp WHERE id=$1 RETURNING to_char(stamp.now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS claimed_at`,
            [id, token],
          );
          const claimedAt = claimed.rows[0]?.claimed_at;
          if (!claimedAt) throw new Error('Database time missing');
          return { id, workspaceId: wid, mappingId: mid, token, claimedAt };
        }
        return null;
      });
    },
    async preflight(claim: SpaceGitHubClaim, acquisition?: Acquisition) {
      const row = await withTransaction(pool, (c) => lock(c, claim, acquisition));
      if (!row) throw new JobLost();
      return row;
    },
    async finish(
      claim: SpaceGitHubClaim,
      input: {
        checkpoint: PullCheckpoint | null;
        activeMillis: number;
        startedAt: string;
        endedAt: string;
        done: boolean;
        failure?: RunReason;
        retryable?: boolean;
        delaySeconds?: number;
      },
    ) {
      return withTransaction(pool, async (client) => {
        const row = await lock(client, claim, input);
        if (!row) return false;
        if (!Number.isSafeInteger(input.activeMillis) || input.activeMillis < 0)
          throw new Error('Invalid active time');
        const active = Math.min(1800000, Number(row.active_millis) + input.activeMillis);
        const failures = Number(row.failures) + (input.retryable ? 1 : 0);
        let checkpoint = input.checkpoint;
        let failure = input.failure;
        if (active >= 1800000 && !failure && !checkpoint && row.checkpoint !== null) {
          try {
            checkpoint = parsePullCheckpoint(row.checkpoint);
          } catch {
            failure = 'invalid_provider_data';
          }
        }
        if (checkpoint && !failure) {
          const context = contextFrom(row.context);
          if (
            checkpoint.repositoryId !== context.repositoryId ||
            `${checkpoint.repositoryOwner}/${checkpoint.repositoryName}` !== context.repositoryLabel
          )
            failure = 'invalid_provider_data';
        }
        if (active >= 1800000 && checkpoint && !failure)
          checkpoint = terminalizePullCheckpoint(checkpoint);
        const stamp = await client.query<{ stamp: string }>(
          `SELECT to_char(GREATEST(clock_timestamp(),acquisition_started_at,acquisition_ended_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stamp FROM space_github_jobs WHERE id=$1`,
          [claim.id],
        );
        const completedAt = stamp.rows[0]?.stamp;
        if (!completedAt) throw new Error('Database time missing');
        await client.query(
          'UPDATE space_github_jobs SET active_millis=$2,acquisition_started_at=COALESCE(acquisition_started_at,$3::timestamptz),acquisition_ended_at=$4::timestamptz,checkpoint=COALESCE($5::jsonb,checkpoint),failures=$6 WHERE id=$1',
          [
            claim.id,
            active,
            claim.claimedAt,
            completedAt,
            checkpoint ? JSON.stringify(checkpoint) : null,
            failures,
          ],
        );
        if (failure) {
          await terminal(client, claim.id, failure);
          return true;
        }
        if (failures >= 3 && !(active >= 1800000 && checkpoint?.phase === 'ready')) {
          await terminal(client, claim.id, 'retry_exhausted');
          return true;
        }
        if (active >= 1800000 && checkpoint?.phase !== 'ready') {
          await terminal(client, claim.id, 'provider_unavailable');
          return true;
        }
        if ((input.done || active >= 1800000) && checkpoint?.phase === 'ready') {
          const context: OperationContext = contextFrom(row.context),
            calculated = calculateSignals(checkpoint, {
              windowStart: context.windowStart,
              windowEnd: context.windowEnd,
            });
          const startedAt =
            typeof row.acquisition_started_at === 'string'
              ? row.acquisition_started_at
              : claim.claimedAt;
          const result: OperationResult = {
            ...context,
            id: randomUUID(),
            runId: claim.id,
            acquisitionStartedAt: startedAt,
            acquisitionEndedAt: completedAt,
            completedAt,
            contractVersion,
            calculated,
            discoveryTraversalComplete: checkpoint.discoveryTraversalComplete,
            reviewTraversalComplete: checkpoint.pulls.every((p) =>
              checkpoint.reviewTraversalComplete.includes(p.id),
            ),
            gaps: checkpoint.gaps,
          };
          parseStoredResult(result);
          await client.query(
            'INSERT INTO space_github_results(id,workspace_id,mapping_id,run_id,completed_at,evidence,result) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [
              result.id,
              claim.workspaceId,
              claim.mappingId,
              claim.id,
              completedAt,
              JSON.stringify(checkpoint),
              JSON.stringify(result),
            ],
          );
          await client.query(
            "UPDATE space_github_jobs SET state='succeeded',result_id=$2,completed_at=$3,lease_token=NULL,lease_until=NULL WHERE id=$1",
            [claim.id, result.id, completedAt],
          );
        } else {
          const delay = input.delaySeconds ?? 0;
          await client.query(
            "UPDATE space_github_jobs SET state='queued',lease_token=NULL,lease_until=NULL,available_at=LEAST(expires_at,clock_timestamp()+$2*interval '1 second') WHERE id=$1",
            [claim.id, Number.isFinite(delay) ? Math.max(0, Math.min(delay, 86400)) : 86400],
          );
        }
        return true;
      });
    },
  };
}
