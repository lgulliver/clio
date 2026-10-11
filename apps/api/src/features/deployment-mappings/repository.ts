import type { Pool, PoolClient } from 'pg';
import { IdentityError, uuid } from '../identity/input.ts';
import { type Actor, authorizedWorkspaceTransaction } from '../identity/repository.ts';
import { createRepository } from '../workspaces/repository.ts';
import { type DeploymentMapping, revision, scenario, settings } from './input.ts';

const observedTime = `to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at_text`;

function mapping(row: Record<string, unknown>): DeploymentMapping {
  if (
    row.mode !== 'mock' ||
    (row.primary_provider !== 'github' && row.primary_provider !== 'argocd') ||
    typeof row.production_environment !== 'string' ||
    typeof row.exposure_attested !== 'boolean' ||
    !(row.observed_at instanceof Date) ||
    typeof row.observed_at_text !== 'string'
  )
    throw new Error('Invalid stored mapping');
  return {
    workspaceId: uuid(row.workspace_id),
    serviceId: uuid(row.service_id),
    mode: row.mode,
    scenario: scenario(row.scenario),
    revision: revision(typeof row.revision === 'string' ? Number(row.revision) : row.revision),
    primaryProvider: row.primary_provider,
    productionEnvironment: row.production_environment,
    exposureAttested: row.exposure_attested,
    observedAt: row.observed_at_text,
  };
}
async function latest(client: PoolClient, workspaceId: string, serviceId: string) {
  const result = await client.query<Record<string, unknown>>(
    `SELECT workspace_id, service_id, mode, scenario, revision, primary_provider, production_environment, exposure_attested, observed_at, ${observedTime}
    FROM deployment_mapping_revisions WHERE workspace_id = $1 AND service_id = $2 ORDER BY revision DESC LIMIT 1`,
    [workspaceId, serviceId],
  );
  return result.rows[0] ? mapping(result.rows[0]) : null;
}
export function createMappingRepository(pool: Pool) {
  function scoped<T>(
    actor: Actor,
    workspaceId: string,
    serviceId: string,
    owner: boolean,
    operation: (
      client: PoolClient,
      service: { id: string; workspaceId: string; name: string },
    ) => Promise<T>,
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
    get(actor: Actor, workspaceId: string, serviceId: string) {
      return scoped(actor, workspaceId, serviceId, false, (client, service) =>
        latest(client, service.workspaceId, service.id),
      );
    },
    save(actor: Actor, workspaceId: string, serviceId: string, input: unknown) {
      const body = settings(input);
      return scoped(actor, workspaceId, serviceId, true, async (client, service) => {
        const current = await latest(client, service.workspaceId, service.id);
        if (
          (current?.revision ?? null) !== body.expectedRevision ||
          current?.revision === Number.MAX_SAFE_INTEGER
        )
          throw new IdentityError(409, 'conflict');
        const result = await client.query<Record<string, unknown>>(
          `INSERT INTO deployment_mapping_revisions (workspace_id, service_id, mode, revision, primary_provider, production_environment, exposure_attested, created_by, scenario)
          VALUES ($1, $2, 'mock', $3, $4, $5, $6, $7, $8) RETURNING *, ${observedTime}`,
          [
            service.workspaceId,
            service.id,
            (current?.revision ?? 0) + 1,
            body.primaryProvider,
            body.productionEnvironment,
            body.exposureAttested,
            actor.userId,
            body.scenario,
          ],
        );
        const row = result.rows[0];
        if (!row) throw new Error('Mapping insert failed');
        return mapping(row);
      });
    },
    previewInput(actor: Actor, workspaceId: string, serviceId: string, savedRevision: number) {
      return scoped(actor, workspaceId, serviceId, false, async (client, service) => {
        const mapping = await latest(client, service.workspaceId, service.id);
        if (!mapping) throw new IdentityError(404, 'not_found');
        if (mapping.revision !== revision(savedRevision)) throw new IdentityError(409, 'conflict');
        return { mapping, service };
      });
    },
  };
}
