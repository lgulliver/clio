import { type GitHubCheckpoint, parseGitHubCheckpoint } from '@clio/adapters';
import type { PoolClient } from 'pg';
import type { GitHubConfig, GitHubGrant } from './config.ts';
import { boundedJson, maxHistoryRecords, maxStoredBytes, parseEvidence } from './history.ts';
import type { Connection } from './input.ts';

interface Input {
  connection: Connection;
  config: GitHubConfig;
  grant: GitHubGrant;
}
/** Read bounded, strictly parsed retained context inside the worker's fenced transaction. */
export async function readHistory(client: PoolClient, connection: Connection) {
  const scope = [
    connection.workspaceId,
    connection.serviceId,
    connection.installationId,
    connection.repositoryId,
  ];
  const totals = await client.query<Record<string, unknown>>(
    'SELECT count(*)::int AS count,coalesce(sum(octet_length(payload::text)),0)::text AS bytes FROM github_collection_history WHERE workspace_id=$1 AND service_id=$2 AND installation_id=$3 AND repository_id=$4',
    scope,
  );
  if (
    Number(totals.rows[0]?.count) > maxHistoryRecords ||
    Number(totals.rows[0]?.bytes) > maxStoredBytes
  )
    throw new Error('Stored history limit');
  const history = await client.query<Record<string, unknown>>(
    'SELECT kind,payload FROM github_collection_history WHERE workspace_id=$1 AND service_id=$2 AND installation_id=$3 AND repository_id=$4 ORDER BY kind,record_key,observed_at LIMIT 5001',
    scope,
  );
  const evidence = parseEvidence(
    {
      deployments: history.rows.filter((r) => r.kind === 'deployment').map((r) => r.payload),
      statuses: history.rows.filter((r) => r.kind === 'status').map((r) => r.payload),
      completedStatusTraversals: history.rows
        .filter((r) => r.kind === 'traversal')
        .map((r) => r.payload),
    },
    connection,
  );
  return { scope, totals, history, evidence };
}
export async function readCheckpoint(
  client: PoolClient,
  input: Input,
): Promise<GitHubCheckpoint | null> {
  const c = input.connection;
  const result = await client.query<Record<string, unknown>>(
    'SELECT cursor FROM github_collection_checkpoints WHERE workspace_id=$1 AND service_id=$2 AND connection_revision=$3 AND app_id=$4 AND installation_id=$5 AND repository_id=$6 AND grant_fingerprint=$7',
    [
      c.workspaceId,
      c.serviceId,
      c.revision,
      input.config.appId,
      c.installationId,
      c.repositoryId,
      input.grant.fingerprint,
    ],
  );
  const row = result.rows[0];
  return !row || row.cursor === null ? null : parseGitHubCheckpoint(row.cursor);
}
/** Snapshot insert precedes this write; terminal write follows in the same transaction. */
export async function saveCheckpoint(
  client: PoolClient,
  input: Input,
  claim: { id: string; token: string },
  checkpoint: GitHubCheckpoint | null,
) {
  const c = input.connection;
  await client.query(
    `INSERT INTO github_collection_checkpoints(workspace_id,service_id,connection_revision,app_id,installation_id,repository_id,grant_fingerprint,run_id,lease_token,cursor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(workspace_id,service_id,connection_revision) DO UPDATE SET app_id=EXCLUDED.app_id,installation_id=EXCLUDED.installation_id,repository_id=EXCLUDED.repository_id,grant_fingerprint=EXCLUDED.grant_fingerprint,run_id=EXCLUDED.run_id,lease_token=EXCLUDED.lease_token,cursor=EXCLUDED.cursor,updated_at=clock_timestamp()`,
    [
      c.workspaceId,
      c.serviceId,
      c.revision,
      input.config.appId,
      c.installationId,
      c.repositoryId,
      input.grant.fingerprint,
      claim.id,
      claim.token,
      checkpoint === null ? null : boundedJson(checkpoint),
    ],
  );
}
