import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  deriveMeasurementEvidence,
  type MeasurementAuthorityScope,
  parseMeasurementReport,
} from '@clio/adapters';
import type { Pool, PoolClient } from 'pg';
import { snapshotDigest } from '../github-collection/digest.ts';
import { timestamp, windowInput } from '../github-collection/input.ts';
import { IdentityError, uuid } from '../identity/input.ts';
import { type Actor, authorizedWorkspaceTransaction } from '../identity/repository.ts';
import { createRepository } from '../workspaces/repository.ts';
import { authorityScope, type MeasurementGrant, measurementGrantFor } from './config.ts';
import { receiverTime } from './ingress.ts';
import {
  encodeCursor,
  enqueueInput,
  historyCursor,
  type MeasurementJobInput,
  parseJobInput,
} from './input.ts';
import { parseMeasurementRun, runColumns } from './result.ts';
import {
  type EligibleBasis,
  eligibleAuthority,
  eligibleNativeBasis,
  type MeasurementDependencies,
  MeasurementRevoked,
} from './source-eligibility.ts';

export function selectAuthorities(
  dependencies: MeasurementDependencies,
  basis: EligibleBasis,
  ids: readonly string[],
) {
  const grants: MeasurementGrant[] = [],
    scopes: MeasurementAuthorityScope[] = [];
  for (const id of ids) {
    const grant = measurementGrantFor(dependencies.configNow(), id);
    if (!grant) throw new MeasurementRevoked();
    eligibleAuthority(grant, basis);
    if (grants.some((g) => g.capability === grant.capability))
      throw new IdentityError(409, 'conflict');
    grants.push(grant);
    scopes.push(authorityScope(grant, basis.context.basis));
  }
  return { grants, scopes };
}
export async function receiptRows(
  client: PoolClient,
  basis: EligibleBasis,
  grants: readonly MeasurementGrant[],
  allowStale = false,
  staleProducers?: Set<string>,
) {
  const found = await client.query<Record<string, unknown>>(
    `SELECT *,to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS received FROM measurement_reports WHERE workspace_id=$1 AND service_id=$2 AND provider=$3 AND source_scope=$4 AND basis_run_id=$5 AND producer_id=ANY($6::uuid[]) ORDER BY capability`,
    [
      basis.context.workspaceId,
      basis.context.serviceId,
      basis.context.basis.provider,
      basis.sourceScope,
      basis.context.basis.runId,
      grants.map((g) => g.producerId),
    ],
  );
  if (found.rows.length > 4) throw new Error('Invalid measurement receipts');
  return found.rows
    .map((row) => {
      if (
        allowStale &&
        (row.authority_fingerprint !==
          grants.find((g) => g.producerId === row.producer_id)?.fingerprint ||
          row.native_fingerprint !== basis.eligibilityFingerprint)
      ) {
        staleProducers?.add(uuid(row.producer_id));
        return null;
      }

      const report = parseMeasurementReport(row.report),
        grant = grants.find((g) => g.producerId === report.producerId);
      if (
        !grant ||
        row.workspace_id !== basis.context.workspaceId ||
        row.service_id !== basis.context.serviceId ||
        row.provider !== basis.context.basis.provider ||
        row.source_scope !== basis.sourceScope ||
        row.basis_run_id !== basis.context.basis.runId ||
        row.producer_id !== report.producerId ||
        row.capability !== report.capability ||
        row.event_id !== report.eventId ||
        report.capability !== grant.capability ||
        report.policyRef !== grant.policyRef ||
        report.workspaceId !== grant.workspaceId ||
        report.serviceId !== grant.serviceId ||
        row.authority_fingerprint !== grant.fingerprint ||
        row.native_fingerprint !== basis.eligibilityFingerprint ||
        !isDeepStrictEqual(row.basis, basis.context.basis) ||
        !isDeepStrictEqual(report.basis, basis.context.basis) ||
        row.digest !== snapshotDigest(report)
      )
        throw new MeasurementRevoked();
      return {
        id: uuid(row.id),
        digest: snapshotDigest(report),
        producerId: report.producerId,
        report,
        observedAt: timestamp(row.received),
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
}
export async function validateJob(
  client: PoolClient,
  dependencies: MeasurementDependencies,
  job: MeasurementJobInput,
) {
  const basis = await eligibleNativeBasis(
    client,
    dependencies,
    job.workspaceId,
    job.serviceId,
    job.basis.provider,
    job.basis.runId,
  );
  if (
    !isDeepStrictEqual(job.basis, basis.context.basis) ||
    job.sourceScope !== basis.sourceScope ||
    job.nativeFingerprint !== basis.eligibilityFingerprint ||
    !isDeepStrictEqual(
      job.window,
      windowInput({ start: basis.snapshot.data.window.start, end: basis.snapshot.data.window.end }),
    )
  )
    throw new MeasurementRevoked();
  const selected = selectAuthorities(
    dependencies,
    basis,
    job.producerPins.map((p) => p.producerId),
  );
  for (const pin of job.producerPins) {
    const grant = selected.grants.find((g) => g.producerId === pin.producerId),
      scope = selected.scopes.find((s) => s.producerId === pin.producerId);
    if (
      !grant ||
      grant.fingerprint !== pin.fingerprint ||
      !scope ||
      snapshotDigest(scope) !== pin.scopeDigest
    )
      throw new MeasurementRevoked();
  }
  // Read only pinned immutable references. Later reports for previously missing capabilities are ignored.
  const all = await receiptRows(client, basis, selected.grants),
    receipts = job.receipts.map((pin) => {
      const receipt = all.find((r) => r.id === pin.id);
      if (!receipt || receipt.digest !== pin.digest || receipt.producerId !== pin.producerId)
        throw new MeasurementRevoked();
      return receipt;
    });
  return { basis, ...selected, receipts };
}
export function deriveSelected(input: Awaited<ReturnType<typeof validateJob>>, cutoff: string) {
  return deriveMeasurementEvidence({
    basis: input.basis.snapshot,
    context: input.basis.context,
    nativeIndex: input.basis.nativeIndex,
    gapManifest: input.basis.gapManifest,
    authorityScopes: input.scopes,
    reports: input.receipts.map((r) => ({ report: r.report, observedAt: r.observedAt })),
    measurementCutoff: cutoff,
  });
}
export function createMeasurementRepository(pool: Pool, dependencies: MeasurementDependencies) {
  function scoped<T>(
    actor: Actor,
    workspaceId: string,
    serviceId: string,
    write: boolean,
    operation: (client: PoolClient) => Promise<T>,
  ) {
    const wid = uuid(workspaceId),
      sid = uuid(serviceId);
    return authorizedWorkspaceTransaction(pool, actor, wid, write, async (client) => {
      if (!(await createRepository(client).getService(wid, sid)))
        throw new IdentityError(404, 'not_found');
      return operation(client);
    });
  }
  return {
    enqueue(actor: Actor, workspaceId: string, serviceId: string, input: unknown) {
      const body = enqueueInput(input);
      return scoped(actor, workspaceId, serviceId, true, async (client) => {
        const basis = await eligibleNativeBasis(
            client,
            dependencies,
            workspaceId,
            serviceId,
            body.provider,
            body.basisRunId,
          ),
          selected = selectAuthorities(dependencies, basis, body.producerIds);
        const replay = await client.query<Record<string, unknown>>(
          `SELECT *,${runColumns} FROM measurement_runs WHERE workspace_id=$1 AND service_id=$2 AND request_id=$3`,
          [workspaceId, serviceId, body.requestId],
        );
        if (replay.rows[0]) {
          const row = replay.rows[0],
            job = parseJobInput(row.input);
          if (
            job.basis.provider !== body.provider ||
            job.basis.runId !== body.basisRunId ||
            !isDeepStrictEqual(job.producerPins.map((p) => p.producerId).sort(), body.producerIds)
          )
            throw new IdentityError(409, 'conflict');
          await validateJob(client, dependencies, job);
          return parseMeasurementRun(row);
        }
        const receipts = await receiptRows(client, basis, selected.grants),
          job: MeasurementJobInput = {
            version: 1,
            workspaceId: uuid(workspaceId),
            serviceId: uuid(serviceId),
            basis: basis.context.basis,
            sourceScope: basis.sourceScope,
            nativeFingerprint: basis.eligibilityFingerprint,
            window: windowInput({
              start: basis.snapshot.data.window.start,
              end: basis.snapshot.data.window.end,
            }),
            producerPins: selected.grants.map((g) => ({
              producerId: g.producerId,
              fingerprint: g.fingerprint,
              scopeDigest: snapshotDigest(authorityScope(g, basis.context.basis)),
            })),
            receipts: receipts.map((r) => ({
              id: r.id,
              digest: r.digest,
              producerId: r.producerId,
            })),
          };
        const pinned = await validateJob(client, dependencies, job),
          cutoff = await receiverTime(client, basis.snapshot.data.evidence_cutoff);
        try {
          deriveSelected(pinned, cutoff);
        } catch (error) {
          if (error instanceof IdentityError) throw error;
          throw new IdentityError(409, 'conflict');
        }
        // Fresh current callbacks after calculation prevent mid-calculation revocation.
        await validateJob(client, dependencies, job);
        const active = await client.query(
          `SELECT id FROM measurement_runs WHERE workspace_id=$1 AND service_id=$2 AND provider=$3 AND source_scope=$4 AND status IN ('pending','running')`,
          [workspaceId, serviceId, body.provider, basis.sourceScope],
        );
        if (active.rowCount) throw new IdentityError(409, 'conflict');
        const inserted = await client.query<Record<string, unknown>>(
          `INSERT INTO measurement_runs(id,workspace_id,service_id,provider,source_scope,basis_run_id,request_id,input) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${runColumns}`,
          [
            randomUUID(),
            workspaceId,
            serviceId,
            body.provider,
            basis.sourceScope,
            body.basisRunId,
            body.requestId,
            JSON.stringify(job),
          ],
        );
        if (!inserted.rows[0]) throw new Error('Missing measurement run');
        return parseMeasurementRun(inserted.rows[0]);
      });
    },
    list(actor: Actor, workspaceId: string, serviceId: string, cursor?: unknown, status?: unknown) {
      const after = historyCursor(cursor);
      if (status !== undefined && status !== 'succeeded')
        throw new IdentityError(400, 'invalid_request');
      return scoped(actor, workspaceId, serviceId, false, async (client) => {
        const found = await client.query<Record<string, unknown>>(
          `SELECT ${runColumns} FROM measurement_runs WHERE workspace_id=$1 AND service_id=$2 AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) AND ($5::text IS NULL OR status=$5::text) ORDER BY created_at DESC,id DESC LIMIT 26`,
          [workspaceId, serviceId, after?.createdAt ?? null, after?.id ?? null, status ?? null],
        );
        const runs = found.rows.slice(0, 25).map(parseMeasurementRun),
          last = runs.at(-1);
        return {
          runs,
          nextCursor: found.rows.length > 25 && last ? encodeCursor(last.createdAt, last.id) : null,
        };
      });
    },
    getRun(actor: Actor, workspaceId: string, serviceId: string, runId: string) {
      const id = uuid(runId);
      return scoped(actor, workspaceId, serviceId, false, async (client) => {
        const found = await client.query<Record<string, unknown>>(
          `SELECT ${runColumns} FROM measurement_runs WHERE workspace_id=$1 AND service_id=$2 AND id=$3`,
          [workspaceId, serviceId, id],
        );
        if (!found.rows[0]) throw new IdentityError(404, 'not_found');
        return parseMeasurementRun(found.rows[0]);
      });
    },
    authorities(
      actor: Actor,
      workspaceId: string,
      serviceId: string,
      kind: 'github' | 'argocd',
      basisRunId: string,
    ) {
      return scoped(actor, workspaceId, serviceId, true, async (client) => {
        const basis = await eligibleNativeBasis(
            client,
            dependencies,
            workspaceId,
            serviceId,
            kind,
            basisRunId,
          ),
          grants = (dependencies.configNow()?.grants ?? []).filter((g) => {
            try {
              eligibleAuthority(g, basis);
              return true;
            } catch {
              return false;
            }
          }),
          staleProducers = new Set<string>(),
          receipts = await receiptRows(client, basis, grants, true, staleProducers);
        return {
          authorities: grants
            .filter((g) => !staleProducers.has(g.producerId))
            .map((g) => ({
              name: g.name,
              capability: g.capability,
              producerId: g.producerId,
              receiptAvailable: receipts.some((r) => r.producerId === g.producerId),
            })),
        };
      });
    },
  };
}
