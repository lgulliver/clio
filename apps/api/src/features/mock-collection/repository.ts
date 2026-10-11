import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { IdentityError, object, uuid } from '../identity/input.ts';
import { type Actor, authorizedWorkspaceTransaction } from '../identity/repository.ts';
import { createRepository } from '../workspaces/repository.ts';
import { columns, enqueueInput, parseMapping, run } from './model.ts';

export function createMockCollectionRepository(pool: Pool) {
  function scoped<T>(
    actor: Actor,
    workspaceId: string,
    serviceId: string,
    owner: boolean,
    operation: (client: PoolClient, service: { id: string; name: string }) => Promise<T>,
  ) {
    const wid = uuid(workspaceId),
      sid = uuid(serviceId);
    return authorizedWorkspaceTransaction(pool, actor, wid, owner, async (client) => {
      const service = await createRepository(client).getService(wid, sid);
      if (!service) throw new IdentityError(404, 'not_found');
      return operation(client, service);
    });
  }
  return {
    enqueue(actor: Actor, workspaceId: string, serviceId: string, input: unknown) {
      const body = enqueueInput(input);
      return scoped(actor, workspaceId, serviceId, true, async (client, service) => {
        const replay = await client.query<Record<string, unknown>>(
          `SELECT ${columns} FROM mock_collection_runs WHERE workspace_id=$1 AND service_id=$2 AND request_id=$3`,
          [workspaceId, serviceId, body.requestId],
        );
        if (replay.rows[0]) {
          const previous = run(replay.rows[0]);
          if (previous.mappingRevision !== body.revision) throw new IdentityError(409, 'conflict');
          return previous;
        }
        const latest = await client.query<Record<string, unknown>>(
          `SELECT revision, primary_provider, production_environment, exposure_attested, to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed FROM deployment_mapping_revisions WHERE workspace_id=$1 AND service_id=$2 ORDER BY revision DESC LIMIT 1`,
          [workspaceId, serviceId],
        );
        const row = latest.rows[0];
        if (!row) throw new IdentityError(404, 'not_found');
        if (Number(row.revision) !== body.revision) throw new IdentityError(409, 'conflict');
        const active = await client.query(
          "SELECT id FROM mock_collection_runs WHERE workspace_id=$1 AND service_id=$2 AND status IN ('pending','running')",
          [workspaceId, serviceId],
        );
        if (active.rowCount) throw new IdentityError(409, 'conflict');
        const mapping = parseMapping({
          workspaceId,
          serviceId,
          mode: 'mock',
          revision: body.revision,
          primaryProvider: row.primary_provider,
          productionEnvironment: row.production_environment,
          exposureAttested: row.exposure_attested,
          observedAt: row.observed,
        });
        const inserted = await client.query<Record<string, unknown>>(
          `INSERT INTO mock_collection_runs (id,workspace_id,service_id,mapping_revision,request_id,mapping_input,service_name) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${columns}`,
          [
            randomUUID(),
            workspaceId,
            serviceId,
            body.revision,
            body.requestId,
            JSON.stringify(mapping),
            service.name,
          ],
        );
        if (!inserted.rows[0]) throw new Error('Missing inserted run');
        return run(inserted.rows[0]);
      });
    },
    /** Cursor is the last run ID in this exact workspace/service/provider history.
     * status=succeeded discovers saved results independently of recent failed requests.
     * Every page revalidates current session and membership; current grants are irrelevant.
     */
    listPage(actor: Actor, workspaceId: string, serviceId: string, input: unknown = {}) {
      const query = object(input, ['cursor', 'status']);
      const cursor = query.cursor === undefined ? null : uuid(query.cursor);
      if (query.status !== undefined && query.status !== 'succeeded')
        throw new IdentityError(400, 'invalid_request');
      const succeeded = query.status === 'succeeded';
      return scoped(actor, workspaceId, serviceId, false, async (client) => {
        if (cursor) {
          const found = await client.query(
            `SELECT id FROM mock_collection_runs WHERE workspace_id=$1 AND service_id=$2 AND id=$3 AND ($4::boolean=false OR status='succeeded')`,
            [workspaceId, serviceId, cursor, succeeded],
          );
          if (!found.rowCount) throw new IdentityError(404, 'not_found');
        }
        const rows = await client.query<Record<string, unknown>>(
          `SELECT ${columns} FROM mock_collection_runs WHERE workspace_id=$1 AND service_id=$2 AND ($4::boolean=false OR status='succeeded') AND ($3::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM mock_collection_runs WHERE workspace_id=$1 AND service_id=$2 AND id=$3)) ORDER BY created_at DESC,id DESC LIMIT 26`,
          [workspaceId, serviceId, cursor, succeeded],
        );
        const runs = rows.rows.slice(0, 25).map(run);
        return { runs, nextCursor: rows.rows.length > 25 ? (runs.at(-1)?.id ?? null) : null };
      });
    },
    list(actor: Actor, workspaceId: string, serviceId: string) {
      return scoped(actor, workspaceId, serviceId, false, async (client) => {
        const rows = await client.query<Record<string, unknown>>(
          `SELECT ${columns} FROM mock_collection_runs WHERE workspace_id=$1 AND service_id=$2 ORDER BY created_at DESC,id DESC LIMIT 25`,
          [workspaceId, serviceId],
        );
        return rows.rows.map(run);
      });
    },
    get(actor: Actor, workspaceId: string, serviceId: string, runId: string) {
      const id = uuid(runId);
      return scoped(actor, workspaceId, serviceId, false, async (client) => {
        const found = await client.query<Record<string, unknown>>(
          `SELECT ${columns} FROM mock_collection_runs WHERE workspace_id=$1 AND service_id=$2 AND id=$3`,
          [workspaceId, serviceId, id],
        );
        if (!found.rows[0]) throw new IdentityError(404, 'not_found');
        return run(found.rows[0]);
      });
    },
  };
}
