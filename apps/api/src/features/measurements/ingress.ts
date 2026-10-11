import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type MeasurementReport, parseMeasurementReport } from '@clio/adapters';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../db/pool.ts';
import { snapshotDigest } from '../github-collection/digest.ts';
import { count, instant, timestamp } from '../github-collection/input.ts';
import { IdentityError, object, uuid } from '../identity/input.ts';
import {
  credentialDigest,
  type MeasurementGrant,
  measurementGrantFor,
  sourceScope,
} from './config.ts';
import {
  currentAuthority,
  type EligibleBasis,
  eligibleNativeBasis,
  type MeasurementDependencies,
  provider,
} from './source-eligibility.ts';

export function reportFacts(report: MeasurementReport): number {
  switch (report.capability) {
    case 'population':
      return 1 + report.payload.operations.length + report.payload.gapResolutions.length;
    case 'change_links':
      return (
        1 +
        (report.payload.history ? 1 : 0) +
        report.payload.operations.reduce((n, r) => n + 1 + r.changes.length, 0)
      );
    case 'classification':
      return 1 + report.payload.operations.length;
    case 'recovery':
      return 1 + report.payload.episodes.length;
  }
}
function admit(report: MeasurementReport, grant: MeasurementGrant, basis: EligibleBasis): void {
  if (
    report.workspaceId !== grant.workspaceId ||
    report.serviceId !== grant.serviceId ||
    report.producerId !== grant.producerId ||
    report.capability !== grant.capability ||
    report.policyRef !== grant.policyRef ||
    !isDeepStrictEqual(report.basis, basis.context.basis)
  )
    throw new IdentityError(409, 'conflict');
  const operations =
    report.capability === 'recovery' ? report.payload.episodes : report.payload.operations;
  for (const operation of operations) {
    const native = basis.nativeIndex.find(
      (n) =>
        n.sourceId === operation.sourceId && n.sourceDeploymentId === operation.sourceDeploymentId,
    );
    if (!native) throw new IdentityError(409, 'conflict');
  }
  if (
    report.capability === 'change_links' &&
    report.payload.operations.some((o) =>
      o.changes.some((c) => !grant.repositoryIds.includes(c.repositoryId)),
    )
  )
    throw new IdentityError(403, 'forbidden');
  if (report.capability === 'population') {
    if (report.payload.productionPaths.some((p) => !grant.productionPaths.includes(p)))
      throw new IdentityError(403, 'forbidden');
    for (const resolution of report.payload.gapResolutions)
      if (!basis.gaps.some((g) => isDeepStrictEqual(g, resolution.gap)))
        throw new IdentityError(409, 'conflict');
  }
  if (report.capability === 'classification') {
    for (const operation of report.payload.operations)
      if (operation.failure === 'failed') {
        const native = basis.nativeIndex.find(
          (n) =>
            n.sourceId === operation.sourceId &&
            n.sourceDeploymentId === operation.sourceDeploymentId,
        );
        const deployment = basis.snapshot.data.deployments.find(
          (d) => d.id === native?.deploymentId,
        );
        if (deployment?.qualification !== 'qualifying') throw new IdentityError(409, 'conflict');
      }
  }
}
export async function workspaceLock(client: PoolClient, workspaceId: string): Promise<void> {
  const found = await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [
    workspaceId,
  ]);
  if (!found.rowCount) throw new IdentityError(404, 'not_found');
}
export async function receiverTime(client: PoolClient, min: string): Promise<string> {
  const found = await client.query<Record<string, unknown>>(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed`,
  );
  const observed = timestamp(found.rows[0]?.observed);
  if (instant(observed) <= instant(min)) throw new IdentityError(409, 'conflict');
  return observed;
}
/** Every authenticated machine request uses a committed fixed-window budget before capture parsing. */
async function rate(client: PoolClient, grant: MeasurementGrant): Promise<boolean> {
  const key = [
    grant.workspaceId,
    grant.serviceId,
    grant.source.provider,
    sourceScope(grant.source),
  ];
  await client.query(
    'INSERT INTO measurement_source_budgets(workspace_id,service_id,provider,source_scope) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    key,
  );
  const found = await client.query(
    `UPDATE measurement_source_budgets SET rate_requests=CASE WHEN rate_started_at<=clock_timestamp()-interval '60 seconds' THEN 1 ELSE rate_requests+1 END,rate_started_at=CASE WHEN rate_started_at<=clock_timestamp()-interval '60 seconds' THEN clock_timestamp() ELSE rate_started_at END WHERE workspace_id=$1 AND service_id=$2 AND provider=$3 AND source_scope=$4 AND (rate_requests<120 OR rate_started_at<=clock_timestamp()-interval '60 seconds') RETURNING workspace_id`,
    key,
  );
  return Boolean(found.rowCount);
}
export async function reserveMeasurementRequest(
  pool: Pool,
  grant: MeasurementGrant,
): Promise<void> {
  const accepted = await withTransaction(pool, (client) => rate(client, grant));
  if (!accepted) throw new IdentityError(429, 'rate_limited');
}
export async function acceptMeasurementReport(
  pool: Pool,
  dependencies: MeasurementDependencies,
  pinned: MeasurementGrant,
  kind: 'github' | 'argocd',
  basisRunId: string,
  input: unknown,
  alreadyPaced = false,
) {
  // Only the authenticated HTTP handler passes true after its onRequest reservation.
  if (!alreadyPaced) await reserveMeasurementRequest(pool, pinned);
  let report: MeasurementReport;
  try {
    report = parseMeasurementReport(input);
  } catch {
    throw new IdentityError(400, 'invalid_request');
  }
  const facts = reportFacts(report),
    bytes = Buffer.byteLength(JSON.stringify(report), 'utf8');
  if (facts > 5000 || bytes > 8388608) throw new IdentityError(409, 'conflict');
  const result = await withTransaction(pool, async (client) => {
    await workspaceLock(client, pinned.workspaceId);
    const basis = await eligibleNativeBasis(
        client,
        dependencies,
        pinned.workspaceId,
        pinned.serviceId,
        kind,
        basisRunId,
      ),
      grant = currentAuthority(dependencies, pinned, basis);
    admit(report, grant, basis);
    const digest = snapshotDigest(report);
    const found = await client.query<Record<string, unknown>>(
      `SELECT *,to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS received FROM measurement_reports WHERE workspace_id=$1 AND service_id=$2 AND provider=$3 AND source_scope=$4 AND ((basis_run_id=$5 AND capability=$6) OR (producer_id=$7 AND event_id=$8))`,
      [
        grant.workspaceId,
        grant.serviceId,
        kind,
        basis.sourceScope,
        basisRunId,
        grant.capability,
        grant.producerId,
        report.eventId,
      ],
    );
    if (found.rows.length) {
      if (found.rows.length !== 1) throw new IdentityError(409, 'conflict');
      const row = found.rows[0];
      if (
        !row ||
        row.digest !== digest ||
        row.authority_fingerprint !== grant.fingerprint ||
        row.native_fingerprint !== basis.eligibilityFingerprint ||
        !isDeepStrictEqual(row.report, report) ||
        !isDeepStrictEqual(row.basis, basis.context.basis)
      )
        throw new IdentityError(409, 'conflict');
      // Revocation fences apply even to exact replay acknowledgement.
      const fresh = await eligibleNativeBasis(
        client,
        dependencies,
        grant.workspaceId,
        grant.serviceId,
        kind,
        basisRunId,
      );
      currentAuthority(dependencies, grant, fresh);
      if (fresh.eligibilityFingerprint !== basis.eligibilityFingerprint)
        throw new IdentityError(409, 'conflict');
      return {
        limited: false as const,
        receipt: { id: uuid(row.id), receivedAt: timestamp(row.received), replayed: true },
      };
    }
    const measured = await client.query<Record<string, unknown>>(
      'SELECT octet_length($1::jsonb::text)::int AS bytes',
      [JSON.stringify(report)],
    );
    const storedBytes = Math.max(bytes, count(measured.rows[0]?.bytes));
    if (storedBytes > 8388608) throw new IdentityError(409, 'conflict');
    const budget = await client.query(
      `UPDATE measurement_source_budgets SET retained_facts=retained_facts+$5,retained_bytes=retained_bytes+$6 WHERE workspace_id=$1 AND service_id=$2 AND provider=$3 AND source_scope=$4 AND retained_facts+$5<=5000 AND retained_bytes+$6<=8388608 RETURNING workspace_id`,
      [grant.workspaceId, grant.serviceId, kind, basis.sourceScope, facts, storedBytes],
    );
    if (!budget.rowCount) throw new IdentityError(409, 'conflict');
    const receivedAt = await receiverTime(client, basis.snapshot.data.evidence_cutoff),
      id = randomUUID();
    await client.query(
      'INSERT INTO measurement_reports(id,workspace_id,service_id,provider,source_scope,basis_run_id,producer_id,capability,event_id,report,digest,basis,native_fingerprint,authority_fingerprint,fact_count,payload_bytes,received_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',
      [
        id,
        grant.workspaceId,
        grant.serviceId,
        kind,
        basis.sourceScope,
        basisRunId,
        grant.producerId,
        grant.capability,
        report.eventId,
        JSON.stringify(report),
        digest,
        JSON.stringify(basis.context.basis),
        basis.eligibilityFingerprint,
        grant.fingerprint,
        facts,
        storedBytes,
        receivedAt,
      ],
    );
    const fresh = await eligibleNativeBasis(
      client,
      dependencies,
      grant.workspaceId,
      grant.serviceId,
      kind,
      basisRunId,
    );
    currentAuthority(dependencies, grant, fresh);
    if (fresh.eligibilityFingerprint !== basis.eligibilityFingerprint)
      throw new IdentityError(409, 'conflict');
    return { limited: false as const, receipt: { id, receivedAt, replayed: false } };
  });
  return result.receipt;
}
export function basisProjection(basis: EligibleBasis) {
  return {
    contract: 'clio.measurement.basis.v1' as const,
    workspaceId: basis.context.workspaceId,
    serviceId: basis.context.serviceId,
    basis: basis.context.basis,
    window: basis.snapshot.data.window,
    evidenceCutoff: basis.snapshot.data.evidence_cutoff,
    operations: basis.nativeIndex.map((n) => {
      const d = basis.snapshot.data.deployments.find((d) => d.id === n.deploymentId);
      if (!d) throw new Error('Missing native operation');
      return {
        sourceId: n.sourceId,
        sourceDeploymentId: n.sourceDeploymentId,
        productionPath: n.productionPath,
        qualification: d.qualification,
        effectiveAt: d.effective_at,
        qualificationWindow: d.qualification_window,
      };
    }),
    gapManifest: basis.gapManifest,
  };
}
function registerMachineRoutes(
  routes: FastifyInstance,
  dependencies: MeasurementDependencies & { pool: Pool },
) {
  const authenticated = new WeakMap<
    FastifyRequest,
    { grant: MeasurementGrant; provider: 'github' | 'argocd'; basisRunId: string }
  >();
  async function auth(request: FastifyRequest) {
    let grant: MeasurementGrant | null = null,
      kind: 'github' | 'argocd' = 'github',
      basisRunId = '';
    try {
      const params = object(request.params, ['provider', 'basisRunId', 'producerId']);
      grant = measurementGrantFor(dependencies.configNow(), uuid(params.producerId));
      kind = provider(params.provider);
      basisRunId = uuid(params.basisRunId);
    } catch {}
    const header = request.headers.authorization,
      token =
        typeof header === 'string' && /^Bearer [a-f0-9]{64}$/.test(header) ? header.slice(7) : '';
    const equal = timingSafeEqual(
      Buffer.from(credentialDigest(token), 'hex'),
      Buffer.from(grant?.tokenDigest ?? '0'.repeat(64), 'hex'),
    );
    if (!grant || !token || !equal || grant.source.provider !== kind || request.url.includes('?'))
      throw new IdentityError(401, 'unauthorized');
    await reserveMeasurementRequest(dependencies.pool, grant);
    authenticated.set(request, { grant, provider: kind, basisRunId });
  }
  const base = '/api/measurement/bases/:provider/:basisRunId/producers/:producerId';
  routes.get(base, { onRequest: auth }, async (request) => {
    const s = authenticated.get(request);
    if (!s) throw new IdentityError(401, 'unauthorized');
    return withTransaction(dependencies.pool, async (client) => {
      await workspaceLock(client, s.grant.workspaceId);
      const basis = await eligibleNativeBasis(
        client,
        dependencies,
        s.grant.workspaceId,
        s.grant.serviceId,
        s.provider,
        s.basisRunId,
      );
      currentAuthority(dependencies, s.grant, basis);
      return basisProjection(basis);
    });
  });
  routes.post(
    `${base}/reports`,
    {
      bodyLimit: 8388608,
      onRequest: async (request) => {
        await auth(request);
        if (
          !['application/json', 'application/json; charset=utf-8'].includes(
            request.headers['content-type']?.toLowerCase() ?? '',
          )
        )
          throw new IdentityError(400, 'invalid_request');
      },
    },
    async (request, reply) => {
      const s = authenticated.get(request);
      if (!s) throw new IdentityError(401, 'unauthorized');
      const receipt = await acceptMeasurementReport(
        dependencies.pool,
        dependencies,
        s.grant,
        s.provider,
        s.basisRunId,
        request.body,
        true,
      );
      return reply.code(receipt.replayed ? 200 : 201).send({ receipt });
    },
  );
}

/** Own isolated machine plugin: sanitized errors and no session authorization. */
export function registerMeasurementIngress(
  routes: FastifyInstance,
  dependencies: MeasurementDependencies & { pool: Pool },
) {
  routes.register(async (plugin) => {
    plugin.addHook('onRequest', async (_request, reply) => {
      reply.header('cache-control', 'no-store');
    });
    plugin.setErrorHandler((error, _request, reply) => {
      if (error instanceof IdentityError) {
        if (error.status === 429) reply.header('retry-after', '60');
        const safe = new Map([
          [400, 'invalid_request'],
          [401, 'unauthorized'],
          [403, 'forbidden'],
          [404, 'not_found'],
          [409, 'conflict'],
          [429, 'rate_limited'],
        ]).get(error.status);
        return reply.code(safe ? error.status : 503).send({ error: safe ?? 'unavailable' });
      }
      const code =
        typeof error === 'object' && error !== null && 'statusCode' in error
          ? error.statusCode
          : undefined;
      const status = typeof code === 'number' && [400, 413, 415].includes(code) ? code : 503;
      return reply.code(status).send({ error: status === 503 ? 'unavailable' : 'invalid_request' });
    });
    registerMachineRoutes(plugin, dependencies);
  });
}
