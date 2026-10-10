import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { IdentityError, object, uuid } from '../identity/input.ts';
import { type Actor, authorizedWorkspaceTransaction } from '../identity/repository.ts';
import { createRepository } from '../workspaces/repository.ts';
import { type GitHubConfig, grantFor } from './config.ts';
import { storedRevision } from './db-value.ts';
import { abortable } from './deadline.ts';
import {
  connectionInput,
  enqueueInput,
  parseConnection,
  positive,
  text,
  timestamp,
} from './input.ts';
import { type GitHubProvider, githubProvider } from './provider.ts';
import { parseRun, runColumns } from './result.ts';

export async function latestConnection(client: PoolClient, workspaceId: string, serviceId: string) {
  const found = await client.query<Record<string, unknown>>(
    'SELECT connection,grant_fingerprint FROM github_connection_revisions WHERE workspace_id=$1 AND service_id=$2 ORDER BY revision DESC LIMIT 1',
    [workspaceId, serviceId],
  );
  const row = found.rows[0];
  if (!row) return null;
  if (typeof row.grant_fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(row.grant_fingerprint))
    throw new Error('Invalid stored grant');
  return { connection: parseConnection(row.connection), fingerprint: row.grant_fingerprint };
}
export async function fenceRuns(client: PoolClient, workspaceId: string, serviceId: string) {
  await client.query(
    `UPDATE github_collection_runs SET status='failed',failure_code='github_connection_revoked',completed_at=statement_timestamp(),updated_at=statement_timestamp(),lease_token=NULL,lease_until=NULL WHERE workspace_id=$1 AND service_id=$2 AND status IN ('pending','running')`,
    [workspaceId, serviceId],
  );
}
export function createGitHubRepository(
  pool: Pool,
  github: GitHubConfig | null,
  dependencies: { provider?: GitHubProvider; clock?: () => Date } = {},
) {
  const provider = dependencies.provider ?? githubProvider,
    clock = dependencies.clock ?? (() => new Date());
  function scoped<T>(
    actor: Actor,
    workspaceId: string,
    serviceId: string,
    write: boolean,
    operation: (
      client: PoolClient,
      service: { id: string; workspaceId: string; name: string },
    ) => Promise<T>,
  ) {
    const wid = uuid(workspaceId),
      sid = uuid(serviceId);
    return authorizedWorkspaceTransaction(pool, actor, wid, write, async (client) => {
      const service = await createRepository(client).getService(wid, sid);
      if (!service) throw new IdentityError(404, 'not_found');
      return operation(client, service);
    });
  }
  function allowed(workspaceId: string, installationId: number, repositoryId: number) {
    const grant = grantFor(github, workspaceId, installationId, repositoryId);
    if (!github) throw new IdentityError(503, 'unavailable');
    if (!grant) throw new IdentityError(403, 'forbidden');
    return { config: github, grant };
  }
  function expectRevision(
    current: Awaited<ReturnType<typeof latestConnection>>,
    expected: number | null,
  ) {
    if (
      (current?.connection.revision ?? null) !== expected ||
      current?.connection.revision === Number.MAX_SAFE_INTEGER
    )
      throw new IdentityError(409, 'conflict');
  }
  return {
    get(actor: Actor, workspaceId: string, serviceId: string) {
      return scoped(actor, workspaceId, serviceId, false, async (client, service) => ({
        connection:
          (await latestConnection(client, service.workspaceId, service.id))?.connection ?? null,
        configured: github?.grants.some((g) => g.workspaceId === service.workspaceId) ?? false,
      }));
    },
    async save(actor: Actor, workspaceId: string, serviceId: string, input: unknown) {
      const body = connectionInput(input);
      const preflight = await scoped(
        actor,
        workspaceId,
        serviceId,
        true,
        async (client, service) => {
          expectRevision(
            await latestConnection(client, service.workspaceId, service.id),
            body.expectedRevision,
          );
          return {
            ...allowed(service.workspaceId, body.installationId, body.repositoryId),
            service,
          };
        },
      );
      // No checked-out client or transaction survives the provider boundary.
      const signal = AbortSignal.timeout(30000);
      const verified = await abortable(
        provider.verify({
          ...preflight,
          repositoryId: body.repositoryId,
          clock,
          signal,
        }),
        signal,
      );
      if (signal.aborted) throw new IdentityError(503, 'unavailable');
      const verifiedAt = timestamp(clock().toISOString());
      const repositoryName = text(verified.repositoryName),
        accountLogin = text(verified.accountLogin);
      return scoped(actor, workspaceId, serviceId, true, async (client, service) => {
        const current = await latestConnection(client, service.workspaceId, service.id);
        expectRevision(current, body.expectedRevision);
        const currentGrant = allowed(
          service.workspaceId,
          body.installationId,
          body.repositoryId,
        ).grant;
        if (currentGrant.fingerprint !== preflight.grant.fingerprint)
          throw new IdentityError(403, 'forbidden');
        const connection = {
          workspaceId: service.workspaceId,
          serviceId: service.id,
          mode: 'live',
          provider: 'github',
          revision: (current?.connection.revision ?? 0) + 1,
          active: true,
          installationId: body.installationId,
          repositoryId: body.repositoryId,
          repositoryName,
          accountLogin,
          productionEnvironment: body.productionEnvironment,
          exposurePolicyReference: body.exposurePolicyReference,
          repositoryDeploymentsBelongToService: true,
          verifiedAt,
        };
        const inserted = await client.query<Record<string, unknown>>(
          `INSERT INTO github_connection_revisions(workspace_id,service_id,revision,connection,grant_fingerprint,created_by) VALUES($1,$2,$3,$4::jsonb || jsonb_build_object('observedAt',to_char(GREATEST(clock_timestamp(),$7::timestamptz) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),$5,$6) RETURNING connection`,
          [
            service.workspaceId,
            service.id,
            connection.revision,
            JSON.stringify(connection),
            currentGrant.fingerprint,
            actor.userId,
            verifiedAt,
          ],
        );
        await fenceRuns(client, service.workspaceId, service.id);
        return parseConnection(inserted.rows[0]?.connection);
      });
    },
    disconnect(actor: Actor, workspaceId: string, serviceId: string, input: unknown) {
      const body = object(input, ['expectedRevision']),
        expected = positive(body.expectedRevision);
      return scoped(actor, workspaceId, serviceId, true, async (client, service) => {
        const current = await latestConnection(client, service.workspaceId, service.id);
        expectRevision(current, expected);
        if (!current) throw new IdentityError(404, 'not_found');
        const next = { ...current.connection, revision: expected + 1, active: false };
        const inserted = await client.query<Record<string, unknown>>(
          `INSERT INTO github_connection_revisions(workspace_id,service_id,revision,connection,grant_fingerprint,created_by) VALUES($1,$2,$3,$4::jsonb || jsonb_build_object('observedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),$5,$6) RETURNING connection`,
          [
            service.workspaceId,
            service.id,
            next.revision,
            JSON.stringify(next),
            current.fingerprint,
            actor.userId,
          ],
        );
        await fenceRuns(client, service.workspaceId, service.id);
        return parseConnection(inserted.rows[0]?.connection);
      });
    },
    enqueue(actor: Actor, workspaceId: string, serviceId: string, input: unknown) {
      const body = enqueueInput(input, clock());
      return scoped(actor, workspaceId, serviceId, true, async (client, service) => {
        const replay = await client.query<Record<string, unknown>>(
          `SELECT ${runColumns} FROM github_collection_runs WHERE workspace_id=$1 AND service_id=$2 AND request_id=$3`,
          [service.workspaceId, service.id, body.requestId],
        );
        if (replay.rows[0]) {
          const row = replay.rows[0];
          if (
            storedRevision(row.connection_revision) !== body.connectionRevision ||
            JSON.stringify(row.window_input) !== JSON.stringify(body.window)
          ) {
            // JSONB key order differs from input; compare individual canonical window fields.
            const previous = object(row.window_input, ['start', 'end', 'timezone', 'calendarDays']);
            if (
              storedRevision(row.connection_revision) !== body.connectionRevision ||
              previous.start !== body.window.start ||
              previous.end !== body.window.end ||
              previous.timezone !== 'UTC' ||
              previous.calendarDays !== body.window.calendarDays
            )
              throw new IdentityError(409, 'conflict');
          }
          return parseRun(row);
        }
        const current = await latestConnection(client, service.workspaceId, service.id);
        if (!current) throw new IdentityError(404, 'not_found');
        if (current.connection.revision !== body.connectionRevision || !current.connection.active)
          throw new IdentityError(409, 'conflict');
        const grant = allowed(
          service.workspaceId,
          current.connection.installationId,
          current.connection.repositoryId,
        ).grant;
        if (grant.fingerprint !== current.fingerprint) throw new IdentityError(403, 'forbidden');
        const active = await client.query(
          "SELECT id FROM github_collection_runs WHERE workspace_id=$1 AND service_id=$2 AND status IN ('pending','running')",
          [service.workspaceId, service.id],
        );
        if (active.rowCount) throw new IdentityError(409, 'conflict');
        const inserted = await client.query<Record<string, unknown>>(
          `INSERT INTO github_collection_runs(id,workspace_id,service_id,connection_revision,request_id,connection_input,grant_fingerprint,window_input,service_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${runColumns}`,
          [
            randomUUID(),
            service.workspaceId,
            service.id,
            body.connectionRevision,
            body.requestId,
            JSON.stringify(current.connection),
            current.fingerprint,
            JSON.stringify(body.window),
            service.name,
          ],
        );
        if (!inserted.rows[0]) throw new Error('Missing inserted run');
        return parseRun(inserted.rows[0]);
      });
    },
    list(actor: Actor, workspaceId: string, serviceId: string) {
      return scoped(actor, workspaceId, serviceId, false, async (client, service) =>
        (
          await client.query<Record<string, unknown>>(
            `SELECT ${runColumns} FROM github_collection_runs WHERE workspace_id=$1 AND service_id=$2 ORDER BY created_at DESC,id DESC LIMIT 25`,
            [service.workspaceId, service.id],
          )
        ).rows.map(parseRun),
      );
    },
    getRun(actor: Actor, workspaceId: string, serviceId: string, runId: string) {
      const id = uuid(runId);
      return scoped(actor, workspaceId, serviceId, false, async (client, service) => {
        const found = await client.query<Record<string, unknown>>(
          `SELECT ${runColumns} FROM github_collection_runs WHERE workspace_id=$1 AND service_id=$2 AND id=$3`,
          [service.workspaceId, service.id, id],
        );
        if (!found.rows[0]) throw new IdentityError(404, 'not_found');
        return parseRun(found.rows[0]);
      });
    },
  };
}
