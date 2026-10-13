import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { abortable } from '../github-collection/deadline.ts';
import { positive, text, timestamp } from '../github-collection/input.ts';
import { IdentityError, name, object, uuid } from '../identity/input.ts';
import { type Actor, authorizedWorkspaceTransaction } from '../identity/repository.ts';
import { grantFor, type SpaceGitHubConfig } from './config.ts';
import {
  type OperationContext,
  type OperationGrant,
  type OperationMapping,
  type OperationResult,
  type OperationRun,
  runReasons,
} from './contract.ts';
import {
  instantMicros,
  parseCollectionRequest,
  parseDisconnectRequest,
  parseMappingRequest,
  parseMappingUpdateRequest,
  parsePageQuery,
  parseWindow,
} from './input.ts';
import { createSpaceGitHubProvider, type SpaceGitHubProvider } from './provider.ts';
import { parseStoredResult } from './stored-result.ts';
export type StoredRow = Record<string, unknown>;
export function mappingFrom(row: StoredRow): OperationMapping {
  return stored(() => {
    if (typeof row.connected !== 'boolean') throw new Error('Invalid mapping');
    return {
      id: uuid(row.id),
      workspaceId: uuid(row.workspace_id),
      teamId: uuid(row.team_id),
      teamName: name(row.current_team_name ?? row.team_name),
      appId: positive(Number(row.app_id)),
      installationId: positive(Number(row.installation_id)),
      repositoryId: positive(Number(row.repository_id)),
      repositoryLabel: text(row.repository_label, 201),
      revision: positive(Number(row.revision)),
      connected: row.connected,
    };
  });
}
export function contextFrom(value: unknown): OperationContext {
  const row = object(value, [
    'workspaceId',
    'mappingId',
    'mappingRevision',
    'teamId',
    'teamName',
    'appId',
    'installationId',
    'repositoryId',
    'repositoryLabel',
    'windowStart',
    'windowEnd',
  ]);
  return {
    workspaceId: uuid(row.workspaceId),
    mappingId: uuid(row.mappingId),
    mappingRevision: positive(row.mappingRevision),
    teamId: uuid(row.teamId),
    teamName: name(row.teamName),
    appId: positive(row.appId),
    installationId: positive(row.installationId),
    repositoryId: positive(row.repositoryId),
    repositoryLabel: text(row.repositoryLabel, 201),
    ...parseWindow({ windowStart: row.windowStart, windowEnd: row.windowEnd }),
  };
}
function date(value: unknown): string {
  return timestamp(value instanceof Date ? value.toISOString() : value);
}
export function runFrom(row: StoredRow): OperationRun {
  return stored(() => {
    const state = row.state;
    if (
      state !== 'queued' &&
      state !== 'running' &&
      state !== 'succeeded' &&
      state !== 'failed' &&
      state !== 'cancelled'
    )
      throw new Error('Invalid job');
    const reason = runReasons.find((r) => r === row.reason) ?? null;
    if (row.reason !== null && !reason) throw new Error('Invalid job reason');
    const context = contextFrom(row.context),
      queuedAt = date(row.queued_at);
    if (instantMicros(context.windowEnd) > instantMicros(queuedAt))
      throw new Error('Invalid stored time');
    return {
      ...context,
      id: uuid(row.id),
      state,
      queuedAt,
      completedAt: row.completed_at === null ? null : date(row.completed_at),
      reason,
      resultId: row.result_id === null ? null : uuid(row.result_id),
    };
  });
}
export function resultFrom(row: StoredRow): OperationResult {
  return stored(() => {
    const result = parseStoredResult(row.result);
    const context: OperationContext = {
      workspaceId: result.workspaceId,
      mappingId: result.mappingId,
      mappingRevision: result.mappingRevision,
      teamId: result.teamId,
      teamName: result.teamName,
      appId: result.appId,
      installationId: result.installationId,
      repositoryId: result.repositoryId,
      repositoryLabel: result.repositoryLabel,
      windowStart: result.windowStart,
      windowEnd: result.windowEnd,
    };
    if (
      result.id !== row.id ||
      result.runId !== row.run_id ||
      result.workspaceId !== row.workspace_id ||
      result.mappingId !== row.mapping_id ||
      result.completedAt !== date(row.completed_at) ||
      !isDeepStrictEqual(contextFrom(row.context), context)
    )
      throw new Error('Invalid stored context');
    if (
      result.acquisitionStartedAt !== date(row.acquisition_started_at) ||
      result.acquisitionEndedAt !== date(row.acquisition_ended_at)
    )
      throw new Error('Invalid stored time');
    return result;
  });
}
function stored<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    throw new IdentityError(500, 'invalid_stored_data');
  }
}
function utc(column: string) {
  return `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
const mappingColumns =
  'm.id,m.workspace_id,m.team_id,m.team_name,m.app_id,m.installation_id,m.repository_id,m.repository_label,m.revision,m.connected';
function runColumns(alias = 'r') {
  return `${alias}.id,${alias}.context,${alias}.state,${utc(`${alias}.queued_at`)} AS queued_at,${utc(`${alias}.completed_at`)} AS completed_at,${alias}.reason,${alias}.result_id`;
}
const resultColumns = `r.id,r.workspace_id,r.mapping_id,r.run_id,r.result,${utc('r.completed_at')} AS completed_at,j.context,${utc('j.acquisition_started_at')} AS acquisition_started_at,${utc('j.acquisition_ended_at')} AS acquisition_ended_at`;
export async function findMapping(
  client: PoolClient,
  wid: string,
  id: string,
  privateGrant = false,
): Promise<StoredRow> {
  const found = await client.query<StoredRow>(
    `SELECT ${mappingColumns}${privateGrant ? ',m.grant_fingerprint' : ''},t.name AS current_team_name FROM space_github_mappings m LEFT JOIN teams t ON t.workspace_id=m.workspace_id AND t.id=m.live_team_id WHERE m.workspace_id=$1 AND m.id=$2`,
    [wid, uuid(id)],
  );
  if (!found.rows[0]) throw new IdentityError(404, 'not_found');
  return found.rows[0];
}
export async function cancelJobs(
  client: PoolClient,
  wid: string,
  id: string,
  reason: 'scope_changed' | 'disconnected' | 'grant_removed',
) {
  await client.query(
    "UPDATE space_github_jobs SET state='cancelled',reason=$3,completed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL WHERE workspace_id=$1 AND mapping_id=$2 AND state IN('queued','running')",
    [wid, id, reason],
  );
}
function revision(mapping: OperationMapping, expected: number) {
  if (mapping.revision !== expected || mapping.revision === Number.MAX_SAFE_INTEGER)
    throw new IdentityError(409, 'conflict');
}
function cursor(scope: unknown, id: string): string {
  return Buffer.from(JSON.stringify({ scope, id })).toString('base64url');
}
function decodeCursor(value: string | undefined, scope: unknown): string | null {
  if (!value) return null;
  try {
    const row = object(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')), [
      'scope',
      'id',
    ]);
    if (!isDeepStrictEqual(row.scope, scope) || cursor(scope, uuid(row.id)) !== value)
      throw new Error('Invalid cursor');
    return uuid(row.id);
  } catch {
    throw new IdentityError(400, 'invalid_request');
  }
}
export function createSpaceGitHubRepository(
  pool: Pool,
  config: SpaceGitHubConfig | null,
  dependencies: { provider?: SpaceGitHubProvider } = {},
) {
  const provider = dependencies.provider ?? createSpaceGitHubProvider(pool);
  function scoped<T>(
    actor: Actor,
    wid: string,
    write: boolean,
    fn: (client: PoolClient) => Promise<T>,
  ) {
    return authorizedWorkspaceTransaction(pool, actor, uuid(wid), write, fn);
  }
  function allowed(wid: string, installationId: number, repositoryId: number) {
    const grant = grantFor(config, wid, installationId, repositoryId);
    if (!config) throw new IdentityError(503, 'unavailable');
    if (!grant) throw new IdentityError(403, 'forbidden');
    return { config, grant };
  }
  async function team(client: PoolClient, wid: string, id: string) {
    const found = await client.query<StoredRow>(
      'SELECT name FROM teams WHERE workspace_id=$1 AND id=$2',
      [wid, id],
    );
    if (!found.rows[0]) throw new IdentityError(404, 'not_found');
    return name(found.rows[0].name);
  }
  async function history(
    actor: Actor,
    wid: string,
    mid: string,
    query: unknown,
    kind: 'runs' | 'results',
  ) {
    const { teamId, cursor: inputCursor } = parsePageQuery(query);
    return scoped(actor, wid, false, async (client) => {
      await findMapping(client, wid, mid);
      const scope = { kind, workspaceId: wid, mappingId: mid, teamId: teamId ?? null },
        after = decodeCursor(inputCursor, scope);
      const table = kind === 'runs' ? 'space_github_jobs' : 'space_github_results',
        time = kind === 'runs' ? 'queued_at' : 'completed_at',
        context = kind === 'runs' ? 'context' : 'result';
      const args = [wid, mid, teamId ?? null, after];
      if (after) {
        const valid = await client.query(
          `SELECT 1 FROM ${table} WHERE workspace_id=$1 AND mapping_id=$2 AND ($3::text IS NULL OR ${context}->>'teamId'=$3) AND id=$4`,
          args,
        );
        if (!valid.rowCount) throw new IdentityError(404, 'not_found');
      }
      const found = await client.query<StoredRow>(
        `SELECT ${kind === 'results' ? resultColumns : runColumns()} FROM ${table} r ${kind === 'results' ? 'JOIN space_github_jobs j ON j.id=r.run_id' : ''} WHERE r.workspace_id=$1 AND r.mapping_id=$2 AND ($3::text IS NULL OR r.${context}->>'teamId'=$3) AND ($4::uuid IS NULL OR (r.${time},r.id)<(SELECT ${time},id FROM ${table} WHERE id=$4 AND workspace_id=$1 AND mapping_id=$2)) ORDER BY r.${time} DESC,r.id DESC LIMIT 25`,
        args,
      );
      const nextCursor =
        found.rows.length === 25 && found.rows[24] ? cursor(scope, uuid(found.rows[24].id)) : null;
      return kind === 'runs'
        ? {
            workspaceId: wid,
            mappingId: mid,
            teamId: teamId ?? null,
            runs: found.rows.map(runFrom),
            nextCursor,
          }
        : {
            workspaceId: wid,
            mappingId: mid,
            teamId: teamId ?? null,
            results: found.rows.map(resultFrom),
            nextCursor,
          };
    });
  }
  return {
    availability(actor: Actor, wid: string) {
      return scoped(actor, wid, false, async (client) => {
        const role = await client.query<StoredRow>(
          'SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
          [wid, actor.userId],
        );
        const enabled = !!config;
        const grants: OperationGrant[] =
          config?.grants
            .filter((g) => g.workspaceId === wid)
            .map((g) => ({
              appId: config.appId,
              installationId: g.installationId,
              accountId: g.accountId,
              accountType: g.accountType,
              repositoryIds: g.repositoryIds,
            })) ?? [];
        return role.rows[0]?.role === 'owner'
          ? { workspaceId: wid, enabled, grants }
          : { workspaceId: wid, enabled };
      });
    },
    get(actor: Actor, wid: string, id: string) {
      return scoped(actor, wid, false, async (c) => mappingFrom(await findMapping(c, wid, id)));
    },
    list(actor: Actor, wid: string, query: unknown = {}) {
      const { teamId, cursor: inputCursor } = parsePageQuery(query);
      return scoped(actor, wid, false, async (c) => {
        const scope = { kind: 'mappings', workspaceId: wid, teamId: teamId ?? null },
          after = decodeCursor(inputCursor, scope);
        const filter =
          "($2::uuid IS NULL OR m.team_id=$2 OR EXISTS(SELECT 1 FROM space_github_jobs j WHERE j.workspace_id=m.workspace_id AND j.mapping_id=m.id AND j.context->>'teamId'=$2::text))";
        if (after) {
          const valid = await c.query(
            `SELECT 1 FROM space_github_mappings m WHERE m.workspace_id=$1 AND ${filter} AND m.id=$3`,
            [wid, teamId ?? null, after],
          );
          if (!valid.rowCount) throw new IdentityError(404, 'not_found');
        }
        const rows = await c.query<StoredRow>(
          `SELECT ${mappingColumns},t.name AS current_team_name FROM space_github_mappings m LEFT JOIN teams t ON t.workspace_id=m.workspace_id AND t.id=m.live_team_id WHERE m.workspace_id=$1 AND ${filter} AND ($3::uuid IS NULL OR m.id>$3) ORDER BY m.id LIMIT 25`,
          [wid, teamId ?? null, after],
        );
        return {
          workspaceId: wid,
          teamId: teamId ?? null,
          mappings: rows.rows.map(mappingFrom),
          nextCursor:
            rows.rows.length === 25 && rows.rows[24] ? cursor(scope, uuid(rows.rows[24].id)) : null,
        };
      });
    },
    async save(actor: Actor, wid: string, input: unknown) {
      const body = parseMappingRequest(input);
      const pre = await scoped(actor, wid, true, async (c) => {
        await team(c, wid, body.teamId);
        const old = await c.query<StoredRow>(
          'SELECT id,revision,connected FROM space_github_mappings WHERE workspace_id=$1 AND repository_id=$2',
          [wid, body.repositoryId],
        );
        if (old.rows[0]?.connected) throw new IdentityError(409, 'conflict');
        return {
          ...allowed(wid, body.installationId, body.repositoryId),
          previous: old.rows[0] ?? null,
        };
      });
      const signal = AbortSignal.timeout(60000),
        scope = await abortable(
          provider.verify({
            ...pre,
            repositoryId: body.repositoryId,
            clock: () => new Date(),
            signal,
          }),
          signal,
        );
      return scoped(actor, wid, true, async (c) => {
        const auth = allowed(wid, body.installationId, body.repositoryId);
        if (auth.grant.fingerprint !== pre.grant.fingerprint || signal.aborted)
          throw new IdentityError(409, 'conflict');
        const teamName = await team(c, wid, body.teamId),
          old = await c.query<StoredRow>(
            'SELECT id,revision,connected FROM space_github_mappings WHERE workspace_id=$1 AND repository_id=$2',
            [wid, body.repositoryId],
          );
        if (!isDeepStrictEqual(old.rows[0] ?? null, pre.previous))
          throw new IdentityError(409, 'conflict');
        const id = pre.previous ? uuid(pre.previous.id) : randomUUID(),
          rev = pre.previous ? positive(Number(pre.previous.revision)) + 1 : 1;
        const label = `${text(scope.accountLogin)}/${text(scope.repositoryName)}`;
        const saved = await c.query<StoredRow>(
          `INSERT INTO space_github_mappings(id,workspace_id,live_team_id,team_id,team_name,app_id,installation_id,repository_id,repository_label,revision,connected,grant_fingerprint) VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,true,$10) ON CONFLICT(workspace_id,repository_id) DO UPDATE SET live_team_id=EXCLUDED.live_team_id,team_id=EXCLUDED.team_id,team_name=EXCLUDED.team_name,app_id=EXCLUDED.app_id,installation_id=EXCLUDED.installation_id,repository_label=EXCLUDED.repository_label,revision=EXCLUDED.revision,connected=true,grant_fingerprint=EXCLUDED.grant_fingerprint RETURNING *`,
          [
            id,
            wid,
            body.teamId,
            teamName,
            config?.appId,
            body.installationId,
            body.repositoryId,
            label,
            rev,
            auth.grant.fingerprint,
          ],
        );
        if (!saved.rows[0]) throw new Error('Mapping missing');
        return mappingFrom(saved.rows[0]);
      });
    },
    update(actor: Actor, wid: string, id: string, input: unknown) {
      const body = parseMappingUpdateRequest(input);
      return scoped(actor, wid, true, async (c) => {
        const mappingRow = await findMapping(c, wid, id, true),
          m = mappingFrom(mappingRow);
        revision(m, body.revision);
        if (!m.connected) throw new IdentityError(409, 'conflict');
        const t = await team(c, wid, body.teamId),
          auth = allowed(wid, m.installationId, m.repositoryId);
        if (
          mappingRow.grant_fingerprint !== auth.grant.fingerprint ||
          m.appId !== auth.config.appId
        )
          throw new IdentityError(409, 'conflict');
        await cancelJobs(c, wid, id, 'scope_changed');
        const rows = await c.query<StoredRow>(
          'UPDATE space_github_mappings SET team_id=$3,live_team_id=$3,team_name=$4,revision=revision+1,grant_fingerprint=$5 WHERE workspace_id=$1 AND id=$2 RETURNING *',
          [wid, id, body.teamId, t, auth.grant.fingerprint],
        );
        if (!rows.rows[0]) throw new Error('Mapping missing');
        return mappingFrom(rows.rows[0]);
      });
    },
    disconnect(actor: Actor, wid: string, id: string, input: unknown) {
      const body = parseDisconnectRequest(input);
      return scoped(actor, wid, true, async (c) => {
        const m = mappingFrom(await findMapping(c, wid, id));
        if (!m.connected && (body.revision === m.revision || body.revision === m.revision - 1))
          return m;
        revision(m, body.revision);
        if (!m.connected) throw new IdentityError(409, 'conflict');
        await cancelJobs(c, wid, id, 'disconnected');
        const rows = await c.query<StoredRow>(
          'UPDATE space_github_mappings SET connected=false,live_team_id=NULL,team_name=$3,revision=revision+1 WHERE workspace_id=$1 AND id=$2 RETURNING *',
          [wid, id, m.teamName],
        );
        if (!rows.rows[0]) throw new Error('Mapping missing');
        return mappingFrom(rows.rows[0]);
      });
    },
    enqueue(actor: Actor, wid: string, id: string, input: unknown) {
      return scoped(actor, wid, true, async (c) => {
        const clock = await c.query<StoredRow>(`SELECT ${utc('clock_timestamp()')} AS queued_at`);
        const queuedAt = date(clock.rows[0]?.queued_at),
          body = parseCollectionRequest(input, new Date(queuedAt));
        const mappingRow = await findMapping(c, wid, id, true),
          m = mappingFrom(mappingRow);
        const replay = await c.query<StoredRow>(
          `SELECT ${runColumns()} FROM space_github_jobs r WHERE workspace_id=$1 AND mapping_id=$2 AND request_id=$3`,
          [wid, id, body.requestId],
        );
        if (replay.rows[0]) {
          const run = runFrom(replay.rows[0]);
          if (
            run.mappingRevision !== body.revision ||
            run.windowStart !== body.windowStart ||
            run.windowEnd !== body.windowEnd
          )
            throw new IdentityError(409, 'conflict');
          return run;
        }
        revision(m, body.revision);
        if (!m.connected) throw new IdentityError(409, 'conflict');
        const auth = allowed(wid, m.installationId, m.repositoryId);
        if (
          mappingRow.grant_fingerprint !== auth.grant.fingerprint ||
          m.appId !== auth.config.appId
        )
          throw new IdentityError(409, 'conflict');
        const existing = await c.query(
          "SELECT 1 FROM space_github_jobs WHERE workspace_id=$1 AND mapping_id=$2 AND state IN('queued','running')",
          [wid, id],
        );
        if (existing.rowCount) throw new IdentityError(409, 'conflict');
        const context: OperationContext = {
          workspaceId: wid,
          mappingId: id,
          mappingRevision: m.revision,
          teamId: m.teamId,
          teamName: m.teamName,
          appId: m.appId,
          installationId: m.installationId,
          repositoryId: m.repositoryId,
          repositoryLabel: m.repositoryLabel,
          windowStart: body.windowStart,
          windowEnd: body.windowEnd,
        };
        const rows = await c.query<StoredRow>(
          `INSERT INTO space_github_jobs AS r(id,workspace_id,mapping_id,request_id,context,grant_fingerprint,queued_at,expires_at,available_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7::timestamptz+interval '24 hours',$7) RETURNING ${runColumns()}`,
          [
            randomUUID(),
            wid,
            id,
            body.requestId,
            JSON.stringify(context),
            auth.grant.fingerprint,
            queuedAt,
          ],
        );
        if (!rows.rows[0]) throw new Error('Job missing');
        return runFrom(rows.rows[0]);
      });
    },
    getRun(actor: Actor, wid: string, mid: string, id: string) {
      return scoped(actor, wid, false, async (c) => {
        const rows = await c.query<StoredRow>(
          `SELECT ${runColumns()} FROM space_github_jobs r WHERE workspace_id=$1 AND mapping_id=$2 AND id=$3`,
          [wid, uuid(mid), uuid(id)],
        );
        if (!rows.rows[0]) throw new IdentityError(404, 'not_found');
        return runFrom(rows.rows[0]);
      });
    },
    getResult(actor: Actor, wid: string, id: string) {
      return scoped(actor, wid, false, async (c) => {
        const rows = await c.query<StoredRow>(
          `SELECT ${resultColumns} FROM space_github_results r JOIN space_github_jobs j ON j.id=r.run_id WHERE r.workspace_id=$1 AND r.id=$2`,
          [wid, uuid(id)],
        );
        if (!rows.rows[0]) throw new IdentityError(404, 'not_found');
        return resultFrom(rows.rows[0]);
      });
    },
    async history(actor: Actor, wid: string, mid: string, query: unknown = {}) {
      const page = await history(actor, wid, mid, query, 'runs');
      if (!('runs' in page)) throw new Error('Invalid history');
      return page;
    },
    async results(actor: Actor, wid: string, mid: string, query: unknown = {}) {
      const page = await history(actor, wid, mid, query, 'results');
      if (!('results' in page)) throw new Error('Invalid history');
      return page;
    },
  };
}
