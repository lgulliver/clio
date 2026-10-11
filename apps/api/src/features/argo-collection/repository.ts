import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { storedRevision } from '../github-collection/db-value.ts';
import { IdentityError, object, uuid } from '../identity/input.ts';
import { type Actor, authorizedWorkspaceTransaction } from '../identity/repository.ts';
import { createRepository } from '../workspaces/repository.ts';
import {
  archiveFor,
  eligibleArchive,
  parseArchivePin,
  pinArchive,
  publicArchive,
} from './archive-grants.ts';
import { archiveSummary } from './archive-summary.ts';
import { type ArgoConfig, grantFor, parseScope, producerFor, scopeFor } from './config.ts';
import { eligibleProducers, parsePins, pinProducer, publicProducer } from './enrichment-grants.ts';
import {
  connectionInput,
  enqueueInput,
  parseConnection,
  positive,
  timestamp,
  windowInput,
} from './input.ts';
import { parseRun, runColumns } from './result.ts';

export async function latestConnection(client: PoolClient, workspaceId: string, serviceId: string) {
  const found = await client.query<Record<string, unknown>>(
    'SELECT connection,grant_fingerprint,scope,enrichment_grants,archive_grant FROM argo_connection_revisions WHERE workspace_id=$1 AND service_id=$2 ORDER BY revision DESC LIMIT 1',
    [workspaceId, serviceId],
  );
  const row = found.rows[0];
  if (!row) return null;
  if (typeof row.grant_fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(row.grant_fingerprint))
    throw new Error('Invalid stored grant');
  return {
    connection: parseConnection(row.connection),
    fingerprint: row.grant_fingerprint,
    scope: parseScope(row.scope),
    producers: parsePins(row.enrichment_grants),
    archive: parseArchivePin(row.archive_grant),
  };
}
export async function fenceRuns(client: PoolClient, workspaceId: string, serviceId: string) {
  await client.query(
    `UPDATE argo_collection_runs SET status='failed',failure_code='argo_connection_revoked',completed_at=statement_timestamp(),updated_at=statement_timestamp(),lease_token=NULL,lease_until=NULL WHERE workspace_id=$1 AND service_id=$2 AND status IN ('pending','running')`,
    [workspaceId, serviceId],
  );
}
export async function ensureSource(client: PoolClient, grant: import('./config.ts').ArgoGrant) {
  await client.query(
    'INSERT INTO argo_source_state(source_id,workspace_id,service_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [grant.sourceId, grant.workspaceId, grant.serviceId],
  );
  const found = await client.query<Record<string, unknown>>(
    'SELECT * FROM argo_source_state WHERE source_id=$1 FOR UPDATE',
    [grant.sourceId],
  );
  const row = found.rows[0];
  if (!row || row.workspace_id !== grant.workspaceId || row.service_id !== grant.serviceId)
    throw new IdentityError(409, 'conflict');
  return row;
}
async function interruption(
  client: PoolClient,
  current: NonNullable<Awaited<ReturnType<typeof latestConnection>>>,
) {
  await client.query('SELECT source_id FROM argo_source_state WHERE source_id=$1 FOR UPDATE', [
    current.connection.sourceId,
  ]);
  await client.query(
    'INSERT INTO argo_interruptions(source_id,grant_fingerprint,workspace_id,service_id,connection_revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
    [
      current.connection.sourceId,
      current.fingerprint,
      current.connection.workspaceId,
      current.connection.serviceId,
      current.connection.revision,
    ],
  );
}
export function createArgoRepository(
  pool: Pool,
  argo: ArgoConfig | null,
  dependencies: { clock?: () => Date; configNow?: () => ArgoConfig | null } = {},
) {
  const clock = dependencies.clock ?? (() => new Date()),
    configNow = dependencies.configNow ?? (() => argo);
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
  function allowed(workspaceId: string, serviceId: string, sourceId: string) {
    const config = configNow();
    if (!config) throw new IdentityError(503, 'unavailable');
    const grant = grantFor(config, sourceId, workspaceId, serviceId);
    if (!grant) throw new IdentityError(403, 'forbidden');
    return grant;
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
      return scoped(actor, workspaceId, serviceId, false, async (client, service) => {
        const sources = (configNow()?.grants ?? [])
          .filter((g) => g.workspaceId === service.workspaceId && g.serviceId === service.id)
          .map((g) => ({
            sourceId: g.sourceId,
            applicationName: g.applicationName,
            applicationNamespace: g.applicationNamespace,
            instance: g.instance,
            environment: g.environment,
            archiveProducers: (configNow()?.archives ?? [])
              .filter((p) => p.sourceId === g.sourceId)
              .map(publicArchive),
            enrichmentProducers: (configNow()?.producers ?? [])
              .filter((p) => p.sourceId === g.sourceId)
              .map(publicProducer)
              .sort((a, b) => a.producerId.localeCompare(b.producerId)),
          }));
        const latest = await latestConnection(client, service.workspaceId, service.id);
        const selected = latest
          ? eligibleArchive(configNow(), latest.connection, latest.archive)
          : null;
        return {
          ...(selected ? { archiveStatus: await archiveSummary(client, selected) } : {}),
          configured: sources.length > 0,
          sources,
          connection:
            (await latestConnection(client, service.workspaceId, service.id))?.connection ?? null,
        };
      });
    },
    save(actor: Actor, workspaceId: string, serviceId: string, input: unknown) {
      const body = connectionInput(input);
      return scoped(actor, workspaceId, serviceId, true, async (client, service) => {
        const current = await latestConnection(client, service.workspaceId, service.id);
        expectRevision(current, body.expectedRevision);
        const grant = allowed(service.workspaceId, service.id, body.sourceId);
        const producers = body.enrichmentProducerIds.map((id) => {
          const producer = producerFor(configNow(), grant.sourceId, id);
          if (!producer || !isDeepStrictEqual(scopeFor(producer), scopeFor(grant)))
            throw new IdentityError(403, 'forbidden');
          return producer;
        });
        const archive =
          body.archiveProducerId === null
            ? null
            : archiveFor(configNow(), grant.sourceId, body.archiveProducerId);
        if (
          body.archiveProducerId !== null &&
          (!archive || !isDeepStrictEqual(scopeFor(archive), scopeFor(grant)))
        )
          throw new IdentityError(403, 'forbidden');
        const archivePin = archive ? pinArchive(archive) : null;
        const pins = producers.map(pinProducer);
        await ensureSource(client, grant);
        if (archive) {
          const registered = (
            await client.query<Record<string, unknown>>(
              'SELECT scope,producer_id,policy_reference FROM argo_archive_journals WHERE source_id=$1 AND journal_id=$2',
              [grant.sourceId, archive.journalId],
            )
          ).rows[0];
          if (
            registered &&
            (!isDeepStrictEqual(parseScope(registered.scope), scopeFor(grant)) ||
              registered.producer_id !== archive.producerId ||
              registered.policy_reference !== archive.policyReference)
          )
            throw new IdentityError(409, 'conflict');
        }
        const bindingChanged =
          current !== null &&
          (current.connection.sourceId !== grant.sourceId ||
            current.fingerprint !== grant.fingerprint ||
            !isDeepStrictEqual(current.producers, pins) ||
            !isDeepStrictEqual(current.archive, archivePin));
        if (current?.connection.active && bindingChanged) await interruption(client, current);
        const revision = (current?.connection.revision ?? 0) + 1;
        const connection = {
          workspaceId: service.workspaceId,
          serviceId: service.id,
          mode: 'live',
          provider: 'argocd',
          revision,
          active: true,
          sourceId: grant.sourceId,
          applicationName: grant.applicationName,
          applicationNamespace: grant.applicationNamespace,
          instance: grant.instance,
          productionEnvironment: grant.environment,
          exposurePolicyReference: body.exposurePolicyReference,
          enrichmentProducers: producers.map(publicProducer),
          archiveProducer: archive ? publicArchive(archive) : null,
          applicationOperationsBelongToService: true,
        };
        const inserted = await client.query<Record<string, unknown>>(
          `INSERT INTO argo_connection_revisions(workspace_id,service_id,revision,connection,grant_fingerprint,scope,created_by,enrichment_grants,archive_grant) VALUES($1,$2,$3,$4::jsonb || jsonb_build_object('observedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),$5,$6,$7,$8,$9) RETURNING connection`,
          [
            service.workspaceId,
            service.id,
            revision,
            JSON.stringify(connection),
            grant.fingerprint,
            JSON.stringify(scopeFor(grant)),
            actor.userId,
            JSON.stringify(pins),
            archivePin ? JSON.stringify(archivePin) : null,
          ],
        );
        if (current && (!current.connection.active || bindingChanged))
          await client.query(
            'INSERT INTO argo_interruptions(source_id,grant_fingerprint,workspace_id,service_id,connection_revision) VALUES($1,$2,$3,$4,$5)',
            [grant.sourceId, grant.fingerprint, service.workspaceId, service.id, revision],
          );
        await fenceRuns(client, service.workspaceId, service.id);
        const saved = parseConnection(inserted.rows[0]?.connection),
          fresh = allowed(service.workspaceId, service.id, grant.sourceId);
        if (
          fresh.fingerprint !== grant.fingerprint ||
          eligibleProducers(configNow(), saved, pins) === null ||
          eligibleArchive(configNow(), saved, archivePin) === undefined
        )
          throw new IdentityError(409, 'conflict');
        return parseConnection(inserted.rows[0]?.connection);
      });
    },
    disconnect(actor: Actor, workspaceId: string, serviceId: string, input: unknown) {
      const expected = positive(object(input, ['expectedRevision']).expectedRevision);
      return scoped(actor, workspaceId, serviceId, true, async (client, service) => {
        const current = await latestConnection(client, service.workspaceId, service.id);
        expectRevision(current, expected);
        if (!current) throw new IdentityError(404, 'not_found');
        if (!current.connection.active) throw new IdentityError(409, 'conflict');
        await interruption(client, current);
        const next = { ...current.connection, revision: expected + 1, active: false };
        const inserted = await client.query<Record<string, unknown>>(
          `INSERT INTO argo_connection_revisions(workspace_id,service_id,revision,connection,grant_fingerprint,scope,created_by,enrichment_grants,archive_grant) VALUES($1,$2,$3,$4::jsonb || jsonb_build_object('observedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),$5,$6,$7,$8,$9) RETURNING connection`,
          [
            service.workspaceId,
            service.id,
            next.revision,
            JSON.stringify(next),
            current.fingerprint,
            JSON.stringify(current.scope),
            actor.userId,
            JSON.stringify(current.producers),
            current.archive ? JSON.stringify(current.archive) : null,
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
          `SELECT ${runColumns} FROM argo_collection_runs WHERE workspace_id=$1 AND service_id=$2 AND request_id=$3`,
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
        const time = await client.query<Record<string, unknown>>(
          `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed`,
        );
        windowInput(
          { start: body.window.start, end: body.window.end },
          new Date(timestamp(time.rows[0]?.observed)),
        );
        const current = await latestConnection(client, service.workspaceId, service.id);
        if (!current) throw new IdentityError(404, 'not_found');
        if (current.connection.revision !== body.connectionRevision || !current.connection.active)
          throw new IdentityError(409, 'conflict');
        const grant = allowed(service.workspaceId, service.id, current.connection.sourceId);
        if (
          grant.fingerprint !== current.fingerprint ||
          !isDeepStrictEqual(current.scope, scopeFor(grant)) ||
          eligibleProducers(configNow(), current.connection, current.producers) === null ||
          eligibleArchive(configNow(), current.connection, current.archive) === undefined
        )
          throw new IdentityError(403, 'forbidden');
        const active = await client.query(
          "SELECT id FROM argo_collection_runs WHERE workspace_id=$1 AND service_id=$2 AND status IN ('pending','running')",
          [service.workspaceId, service.id],
        );
        if (active.rowCount) throw new IdentityError(409, 'conflict');
        const inserted = await client.query<Record<string, unknown>>(
          `INSERT INTO argo_collection_runs(id,workspace_id,service_id,connection_revision,request_id,connection_input,grant_fingerprint,window_input,service_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${runColumns}`,
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
            `SELECT id FROM argo_collection_runs WHERE workspace_id=$1 AND service_id=$2 AND id=$3 AND ($4::boolean=false OR status='succeeded')`,
            [workspaceId, serviceId, cursor, succeeded],
          );
          if (!found.rowCount) throw new IdentityError(404, 'not_found');
        }
        const rows = await client.query<Record<string, unknown>>(
          `SELECT ${runColumns} FROM argo_collection_runs WHERE workspace_id=$1 AND service_id=$2 AND ($4::boolean=false OR status='succeeded') AND ($3::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM argo_collection_runs WHERE workspace_id=$1 AND service_id=$2 AND id=$3)) ORDER BY created_at DESC,id DESC LIMIT 26`,
          [workspaceId, serviceId, cursor, succeeded],
        );
        const runs = rows.rows.slice(0, 25).map(parseRun);
        return { runs, nextCursor: rows.rows.length > 25 ? (runs.at(-1)?.id ?? null) : null };
      });
    },
    list(actor: Actor, workspaceId: string, serviceId: string) {
      return scoped(actor, workspaceId, serviceId, false, async (client, service) =>
        (
          await client.query<Record<string, unknown>>(
            `SELECT ${runColumns} FROM argo_collection_runs WHERE workspace_id=$1 AND service_id=$2 ORDER BY created_at DESC,id DESC LIMIT 25`,
            [service.workspaceId, service.id],
          )
        ).rows.map(parseRun),
      );
    },
    getRun(actor: Actor, workspaceId: string, serviceId: string, runId: string) {
      const id = uuid(runId);
      return scoped(actor, workspaceId, serviceId, false, async (client, service) => {
        const found = await client.query<Record<string, unknown>>(
          `SELECT ${runColumns} FROM argo_collection_runs WHERE workspace_id=$1 AND service_id=$2 AND id=$3`,
          [service.workspaceId, service.id, id],
        );
        if (!found.rows[0]) throw new IdentityError(404, 'not_found');
        return parseRun(found.rows[0]);
      });
    },
  };
}
