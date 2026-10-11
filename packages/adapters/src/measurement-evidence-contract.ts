import { oemsContract } from '@clio/oems';
import { AdapterError, instant, sha, timestamp } from './value.ts';

export type MeasurementCapability = 'population' | 'change_links' | 'classification' | 'recovery';
export type MeasurementInterval = { start: string; end: string };
export type MeasurementBasis = {
  provider: 'github' | 'argocd';
  runId: string;
  sourceId: string;
  connectionRevision: number;
  oemsRevision: string;
  snapshotDigest: string;
  evidenceDigest: string;
  gapManifestDigest: string;
};
export type MeasurementNativeIdentity = { sourceId: string; sourceDeploymentId: string };
export type MeasurementNativeRecord = MeasurementNativeIdentity & {
  deploymentId: string;
  productionPath: string;
};
export type MeasurementGap = {
  gapId: string;
  sourceId: string;
  reason: string;
  bounds: MeasurementInterval | null;
};
export type MeasurementGapResolution = {
  gap: MeasurementGap;
  scope: MeasurementInterval;
  evidenceRef: string;
};
export type MeasurementChange = {
  repositoryId: string;
  commitId: string;
  committedAt: string;
  evidenceRef: string;
};
export type MeasurementPopulation = {
  interval: MeasurementInterval;
  exhaustive: true;
  productionPaths: string[];
  operations: MeasurementNativeIdentity[];
  gapResolutions: MeasurementGapResolution[];
};
export type MeasurementChangeLinks = {
  history: {
    kind: 'service_history_origin';
    interval: MeasurementInterval;
    evidenceRef: string;
  } | null;
  operations: (MeasurementNativeIdentity & { changes: MeasurementChange[]; evidenceRef: string })[];
};
export type MeasurementClassification = {
  operations: (MeasurementNativeIdentity & {
    failure: 'failed' | 'no_recorded_failure' | 'unknown';
    rework: 'incident_driven' | 'not_incident_driven' | 'unknown';
    failureEvidenceRef: string | null;
    reworkEvidenceRef: string | null;
  })[];
};
export type MeasurementRecovery = {
  interval: MeasurementInterval;
  exhaustive: true;
  episodes: (MeasurementNativeIdentity & {
    episodeId: string;
    onset: string;
    restored: string | null;
    approximate: boolean;
    evidenceRef: string;
  })[];
};
type Envelope = {
  contract: 'clio.measurement.evidence.v1';
  eventId: string;
  producerId: string;
  workspaceId: string;
  serviceId: string;
  policyRef: string;
  evidenceRef: string;
  basis: MeasurementBasis;
};
export type MeasurementReport = Envelope &
  (
    | { capability: 'population'; payload: MeasurementPopulation }
    | { capability: 'change_links'; payload: MeasurementChangeLinks }
    | { capability: 'classification'; payload: MeasurementClassification }
    | { capability: 'recovery'; payload: MeasurementRecovery }
  );
/** Trusted server input, NOT proof of authentication. API must authenticate producer,
 * bind current grants/digests and supply receiver time before invoking this pure engine.
 * Never populate scopes from report claims or accept a transport "authenticated" flag. */
export type MeasurementAuthorityScope = {
  producerId: string;
  workspaceId: string;
  serviceId: string;
  capability: MeasurementCapability;
  policyRef: string;
  basis: MeasurementBasis;
  productionPaths: readonly string[];
  repositoryIds: readonly string[];
};
export type MeasurementBasisContext = {
  workspaceId: string;
  serviceId: string;
  canonicalServiceId: string;
  basis: MeasurementBasis;
};
export const measurementLimits = { records: 5000, payloadBytes: 8 * 1024 * 1024 } as const;
export function demand(condition: boolean, code: string): asserts condition {
  if (!condition) throw new AdapterError(`measurement_${code}`);
}
/** Bound JSON before serialization; reject cycles, unusual prototypes and non-JSON values. */
export function measurementJsonBytes(input: unknown): number {
  const ancestors = new Set<object>();
  let nodes = 0,
    bytes = 0;
  function walk(value: unknown, depth: number): void {
    demand(depth <= 16 && ++nodes <= 250000, 'payload_limit');
    if (typeof value === 'string') bytes += Buffer.byteLength(value, 'utf8');
    else if (typeof value === 'number') demand(Number.isFinite(value), 'json');
    else if (value === null || typeof value === 'boolean') return;
    else {
      demand(typeof value === 'object' && value !== null, 'json');
      demand(!ancestors.has(value), 'json');
      for (const key of Reflect.ownKeys(value)) {
        demand(typeof key === 'string', 'json');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        demand(
          descriptor !== undefined && descriptor.get === undefined && descriptor.set === undefined,
          'json',
        );
        demand(
          (Array.isArray(value) && key === 'length') || descriptor.enumerable === true,
          'json',
        );
        if (Array.isArray(value) && key !== 'length') demand(/^(0|[1-9][0-9]*)$/.test(key), 'json');
      }
      ancestors.add(value);
      if (Array.isArray(value)) {
        demand(value.length <= measurementLimits.records, 'record_limit');
        for (const entry of value) walk(entry, depth + 1);
      } else {
        demand(
          Object.getPrototypeOf(value) === Object.prototype ||
            Object.getPrototypeOf(value) === null,
          'json',
        );
        for (const [key, entry] of Object.entries(value)) {
          bytes += Buffer.byteLength(key, 'utf8');
          walk(entry, depth + 1);
        }
      }
      ancestors.delete(value);
    }
    demand(bytes <= measurementLimits.payloadBytes, 'payload_limit');
  }
  walk(input, 0);
  const size = Buffer.byteLength(JSON.stringify(input), 'utf8');
  demand(size <= measurementLimits.payloadBytes, 'payload_limit');
  return size;
}
export function exact(input: unknown, keys: readonly string[]): Record<string, unknown> {
  demand(typeof input === 'object' && input !== null && !Array.isArray(input), 'object');
  const entries = Object.entries(input);
  demand(entries.length === keys.length && entries.every(([key]) => keys.includes(key)), 'keys');
  return Object.fromEntries(entries);
}
export function text(input: unknown): string {
  demand(
    typeof input === 'string' &&
      input.length > 0 &&
      input.length <= 4096 &&
      !/[\p{Cc}\p{Cs}]/u.test(input),
    'text',
  );
  return input;
}
export function uuid(input: unknown): string {
  const value = text(input);
  demand(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
    'uuid',
  );
  return value.toLowerCase();
}
export function utc(input: unknown): string {
  const value = timestamp(input);
  demand(value.endsWith('Z'), 'utc');
  return value;
}
export function interval(input: unknown): MeasurementInterval {
  const value = exact(input, ['start', 'end']);
  const start = utc(value.start),
    end = utc(value.end);
  demand(instant(start) < instant(end), 'interval');
  return { start, end };
}
export function list<T>(input: unknown, parse: (entry: unknown) => T): T[] {
  demand(Array.isArray(input), 'array');
  demand(input.length <= measurementLimits.records, 'record_limit');
  return input.map(parse);
}
export function unique<T>(values: readonly T[], key: (entry: T) => string): void {
  demand(new Set(values.map(key)).size === values.length, 'duplicate');
}
export function texts(input: unknown): string[] {
  const values = list(input, text);
  unique(values, (value) => value);
  return values;
}
export function nativeIdentity(input: Record<string, unknown>): MeasurementNativeIdentity {
  return { sourceId: text(input.sourceId), sourceDeploymentId: text(input.sourceDeploymentId) };
}
export function nativeKey(value: MeasurementNativeIdentity): string {
  return JSON.stringify([value.sourceId, value.sourceDeploymentId]);
}
export function parseMeasurementBasis(input: unknown): MeasurementBasis {
  const value = exact(input, [
    'provider',
    'runId',
    'sourceId',
    'connectionRevision',
    'oemsRevision',
    'snapshotDigest',
    'evidenceDigest',
    'gapManifestDigest',
  ]);
  demand(value.provider === 'github' || value.provider === 'argocd', 'provider');
  demand(
    typeof value.connectionRevision === 'number' &&
      Number.isSafeInteger(value.connectionRevision) &&
      value.connectionRevision > 0,
    'revision',
  );
  const revision = text(value.oemsRevision);
  demand(revision === oemsContract.revision, 'oems_revision');
  function digest(input: unknown): string {
    const value = text(input);
    demand(/^[a-f0-9]{64}$/.test(value), 'digest');
    return value;
  }
  return {
    provider: value.provider,
    runId: uuid(value.runId),
    sourceId: text(value.sourceId),
    connectionRevision: value.connectionRevision,
    oemsRevision: revision,
    snapshotDigest: digest(value.snapshotDigest),
    evidenceDigest: digest(value.evidenceDigest),
    gapManifestDigest: digest(value.gapManifestDigest),
  };
}
export function parseMeasurementGap(input: unknown): MeasurementGap {
  const value = exact(input, ['gapId', 'sourceId', 'reason', 'bounds']);
  return {
    gapId: text(value.gapId),
    sourceId: text(value.sourceId),
    reason: text(value.reason),
    bounds: value.bounds === null ? null : interval(value.bounds),
  };
}
function population(input: unknown): MeasurementPopulation {
  const value = exact(input, [
    'interval',
    'exhaustive',
    'productionPaths',
    'operations',
    'gapResolutions',
  ]);
  demand(value.exhaustive === true, 'exhaustive');
  const operations = list(value.operations, (input) =>
    nativeIdentity(exact(input, ['sourceId', 'sourceDeploymentId'])),
  );
  unique(operations, nativeKey);
  const gapResolutions = list(value.gapResolutions, (input) => {
    const value = exact(input, ['gap', 'scope', 'evidenceRef']);
    return {
      gap: parseMeasurementGap(value.gap),
      scope: interval(value.scope),
      evidenceRef: text(value.evidenceRef),
    };
  });
  unique(gapResolutions, (resolution) => resolution.gap.gapId);
  return {
    interval: interval(value.interval),
    exhaustive: true,
    productionPaths: texts(value.productionPaths),
    operations,
    gapResolutions,
  };
}
function links(input: unknown): MeasurementChangeLinks {
  const value = exact(input, ['history', 'operations']);
  let history: MeasurementChangeLinks['history'] = null;
  if (value.history !== null) {
    const h = exact(value.history, ['kind', 'interval', 'evidenceRef']);
    demand(h.kind === 'service_history_origin', 'history_origin');
    history = {
      kind: 'service_history_origin',
      interval: interval(h.interval),
      evidenceRef: text(h.evidenceRef),
    };
  }
  let count = 0;
  const operations = list(value.operations, (input) => {
    const value = exact(input, ['sourceId', 'sourceDeploymentId', 'changes', 'evidenceRef']);
    const changes = list(value.changes, (input) => {
      demand(++count <= measurementLimits.records, 'record_limit');
      const c = exact(input, ['repositoryId', 'commitId', 'committedAt', 'evidenceRef']);
      return {
        repositoryId: text(c.repositoryId),
        commitId: sha(c.commitId),
        committedAt: utc(c.committedAt),
        evidenceRef: text(c.evidenceRef),
      };
    });
    unique(changes, (change) => JSON.stringify([change.repositoryId, change.commitId]));
    return { ...nativeIdentity(value), changes, evidenceRef: text(value.evidenceRef) };
  });
  unique(operations, nativeKey);
  return { history, operations };
}
function classification(input: unknown): MeasurementClassification {
  const value = exact(input, ['operations']);
  const operations = list<MeasurementClassification['operations'][number]>(
    value.operations,
    (input) => {
      const v = exact(input, [
        'sourceId',
        'sourceDeploymentId',
        'failure',
        'rework',
        'failureEvidenceRef',
        'reworkEvidenceRef',
      ]);
      demand(
        v.failure === 'failed' || v.failure === 'no_recorded_failure' || v.failure === 'unknown',
        'failure',
      );
      demand(
        v.rework === 'incident_driven' ||
          v.rework === 'not_incident_driven' ||
          v.rework === 'unknown',
        'rework',
      );
      const failureEvidenceRef = v.failureEvidenceRef === null ? null : text(v.failureEvidenceRef);
      const reworkEvidenceRef = v.reworkEvidenceRef === null ? null : text(v.reworkEvidenceRef);
      demand(v.failure === 'unknown' || failureEvidenceRef !== null, 'classification_reference');
      demand(v.rework === 'unknown' || reworkEvidenceRef !== null, 'classification_reference');
      return {
        ...nativeIdentity(v),
        failure: v.failure,
        rework: v.rework,
        failureEvidenceRef,
        reworkEvidenceRef,
      };
    },
  );
  unique(operations, nativeKey);
  return { operations };
}
function recovery(input: unknown): MeasurementRecovery {
  const value = exact(input, ['interval', 'exhaustive', 'episodes']);
  demand(value.exhaustive === true, 'exhaustive');
  const episodes = list(value.episodes, (input) => {
    const e = exact(input, [
      'sourceId',
      'sourceDeploymentId',
      'episodeId',
      'onset',
      'restored',
      'approximate',
      'evidenceRef',
    ]);
    demand(typeof e.approximate === 'boolean', 'approximate');
    const onset = utc(e.onset),
      restored = e.restored === null ? null : utc(e.restored);
    demand(restored === null || instant(onset) <= instant(restored), 'recovery_time');
    return {
      ...nativeIdentity(e),
      episodeId: text(e.episodeId),
      onset,
      restored,
      approximate: e.approximate,
      evidenceRef: text(e.evidenceRef),
    };
  });
  unique(episodes, (episode) => episode.episodeId);
  return { interval: interval(value.interval), exhaustive: true, episodes };
}
/** External unknown boundary. Returns detached strict JSON; does not authenticate it. */
export function parseMeasurementReport(input: unknown): MeasurementReport {
  measurementJsonBytes(input);
  const value = exact(input, [
    'contract',
    'eventId',
    'producerId',
    'workspaceId',
    'serviceId',
    'capability',
    'policyRef',
    'evidenceRef',
    'basis',
    'payload',
  ]);
  demand(value.contract === 'clio.measurement.evidence.v1', 'contract');
  const envelope: Envelope = {
    contract: 'clio.measurement.evidence.v1',
    eventId: uuid(value.eventId),
    producerId: uuid(value.producerId),
    workspaceId: uuid(value.workspaceId),
    serviceId: uuid(value.serviceId),
    policyRef: text(value.policyRef),
    evidenceRef: text(value.evidenceRef),
    basis: parseMeasurementBasis(value.basis),
  };
  switch (value.capability) {
    case 'population':
      return { ...envelope, capability: value.capability, payload: population(value.payload) };
    case 'change_links':
      return { ...envelope, capability: value.capability, payload: links(value.payload) };
    case 'classification':
      return { ...envelope, capability: value.capability, payload: classification(value.payload) };
    case 'recovery':
      return { ...envelope, capability: value.capability, payload: recovery(value.payload) };
    default:
      throw new AdapterError('measurement_capability');
  }
}
