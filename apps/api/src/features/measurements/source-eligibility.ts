import { isDeepStrictEqual } from 'node:util';
import { type ArgoScope, identity } from '@clio/adapters';
import type { PoolClient } from 'pg';
import { eligibleArchive } from '../argo-collection/archive-grants.ts';
import { type ArgoConfig, grantFor as argoGrantFor, scopeFor } from '../argo-collection/config.ts';
import { eligibleProducers } from '../argo-collection/enrichment-grants.ts';
import { parseConnection as parseArgoConnection } from '../argo-collection/input.ts';
import { latestConnection as latestArgoConnection } from '../argo-collection/repository.ts';
import { type GitHubConfig, grantFor as githubGrantFor } from '../github-collection/config.ts';
import { storedRevision } from '../github-collection/db-value.ts';
import { snapshotDigest } from '../github-collection/digest.ts';
import { parseConnection as parseGitHubConnection } from '../github-collection/input.ts';
import { latestConnection as latestGitHubConnection } from '../github-collection/repository.ts';
import { IdentityError, uuid } from '../identity/input.ts';
import {
  type MeasurementConfig,
  type MeasurementGrant,
  type MeasurementSource,
  sourceScope,
} from './config.ts';
import { readNativeMeasurementBasis } from './native-basis.ts';

export interface MeasurementDependencies {
  configNow: () => MeasurementConfig | null;
  githubNow: () => GitHubConfig | null;
  argoNow: () => ArgoConfig | null;
}
export class MeasurementRevoked extends IdentityError {
  constructor() {
    super(409, 'conflict');
  }
}
export function provider(value: unknown): 'github' | 'argocd' {
  if (value === 'github' || value === 'argocd') return value;
  throw new IdentityError(400, 'invalid_request');
}
/** Caller holds workspace row lock. All inputs remain private; no network. */
export async function eligibleNativeBasis(
  client: PoolClient,
  dependencies: MeasurementDependencies,
  workspaceId: string,
  serviceId: string,
  kind: 'github' | 'argocd',
  runId: string,
) {
  const wid = uuid(workspaceId),
    sid = uuid(serviceId),
    rid = uuid(runId);
  // Provider is a closed enum, never an arbitrary SQL identifier.
  const table = kind === 'github' ? 'github_collection' : 'argo_collection';
  const found = await client.query<Record<string, unknown>>(
    `SELECT s.*,r.grant_fingerprint FROM ${table}_snapshots s JOIN ${table}_runs r ON r.id=s.run_id AND r.workspace_id=s.workspace_id AND r.service_id=s.service_id WHERE s.workspace_id=$1 AND s.service_id=$2 AND s.run_id=$3 AND r.status='succeeded'`,
    [wid, sid, rid],
  );
  const row = found.rows[0];
  if (!row) throw new IdentityError(404, 'not_found');
  let source: MeasurementSource,
    sourceId: string,
    productionPath: string,
    argoScope: ArgoScope | undefined;
  let companionPins: Pick<
    NonNullable<Awaited<ReturnType<typeof latestArgoConnection>>>,
    'archive' | 'producers'
  > | null = null;
  if (kind === 'github') {
    const connection = parseGitHubConnection(row.connection_input),
      latest = await latestGitHubConnection(client, wid, sid);
    const grant = githubGrantFor(
      dependencies.githubNow(),
      wid,
      connection.installationId,
      connection.repositoryId,
    );
    if (
      !grant ||
      !latest?.connection.active ||
      !isDeepStrictEqual(connection, latest.connection) ||
      latest.fingerprint !== grant.fingerprint ||
      row.grant_fingerprint !== grant.fingerprint
    )
      throw new MeasurementRevoked();
    source = {
      provider: 'github',
      installationId: connection.installationId,
      repositoryId: connection.repositoryId,
    };
    sourceId = identity('github', String(connection.installationId));
    productionPath = identity(
      'github-production',
      connection.installationId,
      connection.repositoryId,
      connection.productionEnvironment,
    );
  } else {
    const connection = parseArgoConnection(row.connection_input),
      latest = await latestArgoConnection(client, wid, sid),
      config = dependencies.argoNow();
    const grant = argoGrantFor(config, connection.sourceId, wid, sid);
    if (
      !grant ||
      !latest?.connection.active ||
      !isDeepStrictEqual(connection, latest.connection) ||
      row.grant_fingerprint !== grant.fingerprint ||
      latest.fingerprint !== grant.fingerprint ||
      !isDeepStrictEqual(latest.scope, scopeFor(grant)) ||
      eligibleArchive(config, connection, latest.archive) === undefined ||
      eligibleProducers(config, connection, latest.producers) === null
    )
      throw new MeasurementRevoked();
    source = { provider: 'argocd', sourceId: connection.sourceId };
    sourceId = identity('argocd', connection.instance);
    productionPath = identity(
      'argo-production',
      connection.sourceId,
      connection.productionEnvironment,
    );
    argoScope = scopeFor(grant);
    companionPins = { archive: latest.archive, producers: latest.producers };
  }
  const connection =
    kind === 'github'
      ? parseGitHubConnection(row.connection_input)
      : parseArgoConnection(row.connection_input);
  if (storedRevision(row.connection_revision) !== connection.revision)
    throw new Error('Invalid native basis revision');
  const capture = {
    connection,
    serviceName: row.service_name,
    evidence: row.evidence,
    snapshot: row.snapshot,
    metrics: row.metrics,
    oemsRevision: row.oems_revision,
    result: row.public_result,
    digest: row.digest,
  };
  const basis = readNativeMeasurementBasis({
    provider: kind,
    runId: rid,
    workspaceId: wid,
    serviceId: sid,
    sourceId,
    connectionRevision: connection.revision,
    productionPath,
    capture,
    ...(argoScope ? { argoScope } : {}),
  });
  return {
    ...basis,
    source,
    sourceScope: sourceScope(source),
    productionPath,
    nativeFingerprint: row.grant_fingerprint,
    capture,
    eligibilityFingerprint: snapshotDigest({
      source,
      connection,
      nativeFingerprint: row.grant_fingerprint,
      ...(companionPins ?? {}),
    }),
  };
}
export type EligibleBasis = Awaited<ReturnType<typeof eligibleNativeBasis>>;
export function eligibleAuthority(grant: MeasurementGrant, basis: EligibleBasis): void {
  if (
    grant.workspaceId !== basis.context.workspaceId ||
    grant.serviceId !== basis.context.serviceId ||
    sourceScope(grant.source) !== basis.sourceScope ||
    !grant.productionPaths.includes(basis.productionPath)
  )
    throw new MeasurementRevoked();
}
export function currentAuthority(
  dependencies: MeasurementDependencies,
  pinned: MeasurementGrant,
  basis: EligibleBasis,
): MeasurementGrant {
  const current = dependencies.configNow()?.grants.find((g) => g.producerId === pinned.producerId);
  if (!current || current.fingerprint !== pinned.fingerprint) throw new MeasurementRevoked();
  eligibleAuthority(current, basis);
  return current;
}
