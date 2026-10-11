import { type MetricResult, oemsContract, validateStructure } from '@clio/oems';
import { timestamp } from '../github-collection/api';
import { ApiError, record } from '../identity/api';

export type Scope = { workspaceId: string; serviceId: string };
export type Provider = 'github' | 'argocd';
export const capabilities = ['population', 'change_links', 'classification', 'recovery'] as const;
export type Capability = (typeof capabilities)[number];
export type Authority = {
  name: string;
  capability: Capability;
  producerId: string;
  receiptAvailable: boolean;
};
export const blockerLabels = {
  population_missing: 'Deployment census missing',
  population_interval: 'Deployment census does not cover the reporting window',
  population_paths: 'Production paths are not fully covered',
  population_roster_mismatch: 'Deployment census differs from saved collection',
  gap_manifest_missing: 'Saved collection gap inventory unavailable',
  gap_resolution_mismatch: 'Collection gaps remain unresolved',
  history_missing: 'Change history missing',
  history_population: 'Change history population incomplete',
  history_origin: 'First-deployment history origin incomplete',
  history_change_links: 'Deployed change links incomplete',
  recovery_classification_missing: 'Recovery failure classification missing',
  recovery_missing: 'Recovery evidence missing',
  recovery_interval: 'Recovery evidence does not cover the reporting window',
};
export type Blocker = keyof typeof blockerLabels;
export type MeasurementResult = Scope & {
  contract: 'clio.measurement.result.v1';
  provider: Provider;
  basisRunId: string;
  connectionRevision: number;
  oemsRevision: string;
  window: { start: string; end: string; timezone: 'UTC'; calendarDays: number };
  basisEvidenceCutoff: string;
  evidenceCutoff: string;
  assessment: {
    blockers: Blocker[];
    collectionComplete: boolean;
    historyComplete: boolean;
    recoveryComplete: boolean;
  };
  coverage: {
    collectionComplete: boolean;
    deploymentHistoryComplete: boolean;
    recoveryEvidenceComplete: boolean;
  };
  metricResult: MetricResult;
};
export type Run = Scope & {
  id: string;
  provider: Provider;
  basisRunId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  failureCode: 'measurement_revoked' | 'measurement_processing_failed' | null;
  result: MeasurementResult | null;
};
export type HistoryPage = { runs: Run[]; nextCursor: string | null };
export type Basis = {
  id: string;
  provider: Provider;
  connectionRevision: number;
  result: { window: { start: string; end: string; calendarDays: number }; evidenceCutoff: string };
};
function fail(): never {
  throw new ApiError(0);
}
function exact(value: unknown, keys: readonly string[]) {
  const row = record(value);
  if (
    Object.keys(row).length !== keys.length ||
    Object.keys(row).some((key) => !keys.includes(key))
  )
    fail();
  return row;
}
function uuid(value: unknown): string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : fail();
}
function integer(value: unknown, minimum = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
    ? value
    : fail();
}
function boolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : fail();
}
function provider(value: unknown): Provider {
  return value === 'github' || value === 'argocd' ? value : fail();
}
function bind(row: Record<string, unknown>, scope: Scope) {
  if (row.workspaceId !== uuid(scope.workspaceId) || row.serviceId !== uuid(scope.serviceId))
    fail();
}
// Preserve microsecond precision, including standard timestamps with explicit offsets.
export function instant(value: string): bigint {
  const match = /^(.*?)(?:\.(\d{1,6}))?([Zz]|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match?.[1] || !match[3]) return fail();
  const milliseconds = Date.parse(`${match[1]}${match[3].toUpperCase()}`);
  if (!Number.isFinite(milliseconds)) return fail();
  return BigInt(milliseconds) * 1000n + BigInt((match[2] ?? '').padEnd(6, '0'));
}
function blocker(value: unknown): Blocker {
  switch (value) {
    case 'population_missing':
    case 'population_interval':
    case 'population_paths':
    case 'population_roster_mismatch':
    case 'gap_manifest_missing':
    case 'gap_resolution_mismatch':
    case 'history_missing':
    case 'history_population':
    case 'history_origin':
    case 'history_change_links':
    case 'recovery_classification_missing':
    case 'recovery_missing':
    case 'recovery_interval':
      return value;
    default:
      return fail();
  }
}
export function parseResult(value: unknown, scope: Scope): MeasurementResult {
  const row = exact(value, [
    'contract',
    'workspaceId',
    'serviceId',
    'provider',
    'basisRunId',
    'connectionRevision',
    'oemsRevision',
    'window',
    'basisEvidenceCutoff',
    'evidenceCutoff',
    'assessment',
    'coverage',
    'metricResult',
  ]);
  bind(row, scope);
  if (row.contract !== 'clio.measurement.result.v1' || row.oemsRevision !== oemsContract.revision)
    fail();
  const w = exact(row.window, ['start', 'end', 'timezone', 'calendarDays']);
  const start = timestamp(w.start),
    end = timestamp(w.end);
  const days = (Date.parse(end) - Date.parse(start)) / 86400000;
  if (
    w.timezone !== 'UTC' ||
    ![start, end].every((time) => /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0{1,6})?Z$/.test(time)) ||
    days < 1 ||
    days > 90 ||
    w.calendarDays !== days
  )
    fail();
  const basisEvidenceCutoff = timestamp(row.basisEvidenceCutoff),
    evidenceCutoff = timestamp(row.evidenceCutoff);
  if (
    instant(basisEvidenceCutoff) < instant(end) ||
    instant(evidenceCutoff) <= instant(basisEvidenceCutoff)
  )
    fail();
  const a = exact(row.assessment, [
    'blockers',
    'collectionComplete',
    'historyComplete',
    'recoveryComplete',
  ]);
  if (!Array.isArray(a.blockers) || a.blockers.length > 13) return fail();
  const blockers = a.blockers.map(blocker);
  if (new Set(blockers).size !== blockers.length) fail();
  const assessment = {
    blockers,
    collectionComplete: boolean(a.collectionComplete),
    historyComplete: boolean(a.historyComplete),
    recoveryComplete: boolean(a.recoveryComplete),
  };
  const c = exact(row.coverage, [
    'collectionComplete',
    'deploymentHistoryComplete',
    'recoveryEvidenceComplete',
  ]);
  const coverage = {
    collectionComplete: boolean(c.collectionComplete),
    deploymentHistoryComplete: boolean(c.deploymentHistoryComplete),
    recoveryEvidenceComplete: boolean(c.recoveryEvidenceComplete),
  };
  if (
    coverage.collectionComplete !== assessment.collectionComplete ||
    coverage.deploymentHistoryComplete !== assessment.historyComplete ||
    coverage.recoveryEvidenceComplete !== assessment.recoveryComplete
  )
    fail();
  for (const [prefix, complete] of [
    ['collection', coverage.collectionComplete],
    ['history', coverage.deploymentHistoryComplete],
    ['recovery', coverage.recoveryEvidenceComplete],
  ] as const) {
    const relevant = blockers.some((item) =>
      prefix === 'collection'
        ? item.startsWith('population_') || item.startsWith('gap_')
        : item.startsWith(`${prefix}_`),
    );
    if (complete === relevant) fail();
  }
  const parsed = validateStructure('metric-result', row.metricResult);
  if (!parsed.ok) return fail();
  const m = parsed.data;
  if (
    m.service_id !== scope.serviceId ||
    m.profile_version !== '0.1-draft' ||
    instant(m.window.start) !== instant(start) ||
    instant(m.window.end) !== instant(end) ||
    m.window.calendar_days !== days ||
    instant(m.evidence_cutoff) !== instant(evidenceCutoff)
  )
    fail();
  for (const metric of [
    m.deployment_frequency,
    m.change_lead_time,
    m.change_fail_rate,
    m.deployment_rework_rate,
    m.failed_deployment_recovery_time,
  ]) {
    if (metric.quality_reasons.includes('incomplete_collection') === coverage.collectionComplete)
      fail();
  }
  // Extra history uncertainty can persist despite an exhaustive history authority.
  if (
    (!coverage.deploymentHistoryComplete &&
      !m.change_lead_time.quality_reasons.includes('incomplete_history')) ||
    m.failed_deployment_recovery_time.quality_reasons.includes('incomplete_recovery_evidence') ===
      coverage.recoveryEvidenceComplete
  )
    fail();
  if (
    m.qualification_unknown_count > 0 !==
    m.deployment_frequency.quality_reasons.includes('unresolved_qualification')
  )
    fail();
  return {
    ...scope,
    contract: 'clio.measurement.result.v1',
    provider: provider(row.provider),
    basisRunId: uuid(row.basisRunId),
    connectionRevision: integer(row.connectionRevision, 1),
    oemsRevision: oemsContract.revision,
    window: { start, end, timezone: 'UTC', calendarDays: days },
    basisEvidenceCutoff,
    evidenceCutoff,
    assessment,
    coverage,
    metricResult: m,
  };
}
function run(value: unknown, scope: Scope): Run {
  const row = exact(value, [
    'id',
    'workspaceId',
    'serviceId',
    'provider',
    'basisRunId',
    'status',
    'attempts',
    'createdAt',
    'updatedAt',
    'completedAt',
    'failureCode',
    'result',
  ]);
  bind(row, scope);
  const status = row.status;
  if (status !== 'pending' && status !== 'running' && status !== 'succeeded' && status !== 'failed')
    return fail();
  const id = uuid(row.id),
    kind = provider(row.provider),
    basisRunId = uuid(row.basisRunId),
    attempts = integer(row.attempts);
  const createdAt = timestamp(row.createdAt),
    updatedAt = timestamp(row.updatedAt),
    completedAt = row.completedAt === null ? null : timestamp(row.completedAt);
  const terminal = status === 'succeeded' || status === 'failed';
  if (
    attempts > 3 ||
    terminal !== (completedAt !== null) ||
    (status === 'succeeded') !== (row.result !== null) ||
    instant(updatedAt) < instant(createdAt) ||
    (completedAt !== null &&
      (instant(completedAt) < instant(createdAt) || instant(completedAt) > instant(updatedAt)))
  )
    fail();
  const failureCode = row.failureCode;
  if (
    status === 'failed'
      ? failureCode !== 'measurement_revoked' && failureCode !== 'measurement_processing_failed'
      : failureCode !== null
  )
    return fail();
  if (
    failureCode !== null &&
    failureCode !== 'measurement_revoked' &&
    failureCode !== 'measurement_processing_failed'
  )
    return fail();
  const result = row.result === null ? null : parseResult(row.result, scope);
  if (
    result &&
    (result.provider !== kind ||
      result.basisRunId !== basisRunId ||
      completedAt === null ||
      instant(result.evidenceCutoff) > instant(completedAt) ||
      instant(result.evidenceCutoff) < instant(createdAt))
  )
    fail();
  return {
    ...scope,
    id,
    provider: kind,
    basisRunId,
    status,
    attempts,
    createdAt,
    updatedAt,
    completedAt,
    failureCode,
    result,
  };
}
export function parseRun(
  value: unknown,
  scope: Scope,
  expected?: { id?: string; basis?: Basis },
): Run {
  const parsed = run(exact(value, ['run']).run, scope);
  if (expected?.id !== undefined && parsed.id !== expected.id) fail();
  const basis = expected?.basis;
  if (basis && (parsed.basisRunId !== basis.id || parsed.provider !== basis.provider)) fail();
  if (
    basis &&
    parsed.result &&
    (parsed.result.connectionRevision !== basis.connectionRevision ||
      instant(parsed.result.basisEvidenceCutoff) !== instant(basis.result.evidenceCutoff) ||
      instant(parsed.result.window.start) !== instant(basis.result.window.start) ||
      instant(parsed.result.window.end) !== instant(basis.result.window.end) ||
      parsed.result.window.calendarDays !== basis.result.window.calendarDays)
  )
    fail();
  return parsed;
}
function tuple(value: unknown): { createdAt: string; id: string } {
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value))
    return fail();
  try {
    const json = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
    if (btoa(json).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') !== value)
      return fail();
    const decoded: unknown = JSON.parse(json);
    const row = exact(decoded, ['createdAt', 'id']);
    return { createdAt: timestamp(row.createdAt), id: uuid(row.id) };
  } catch {
    return fail();
  }
}
function before(
  left: { createdAt: string; id: string },
  right: { createdAt: string; id: string },
): boolean {
  return (
    instant(left.createdAt) < instant(right.createdAt) ||
    (instant(left.createdAt) === instant(right.createdAt) &&
      left.id.toLowerCase() < right.id.toLowerCase())
  );
}
export function parseHistoryPage(
  value: unknown,
  scope: Scope,
  options: { cursor?: string; succeeded?: boolean } = {},
): HistoryPage {
  const row = exact(value, ['runs', 'nextCursor']);
  if (!Array.isArray(row.runs) || row.runs.length > 25) return fail();
  const runs = row.runs.map((value: unknown) => run(value, scope));
  const cursor = options.cursor === undefined ? null : tuple(options.cursor);
  if (
    new Set(runs.map((item) => item.id.toLowerCase())).size !== runs.length ||
    runs.some(
      (item) =>
        (options.succeeded && item.status !== 'succeeded') || (cursor && !before(item, cursor)),
    )
  )
    fail();
  for (let i = 1; i < runs.length; i++) {
    const previous = runs[i - 1],
      current = runs[i];
    if (!previous || !current || !before(current, previous)) fail();
  }
  const nextCursor = row.nextCursor === null ? null : row.nextCursor;
  if (nextCursor !== null) {
    const next = tuple(nextCursor),
      last = runs.at(-1);
    if (
      runs.length !== 25 ||
      !last ||
      next.id !== last.id ||
      instant(next.createdAt) !== instant(last.createdAt)
    )
      fail();
  }
  return {
    runs,
    nextCursor: nextCursor === null ? null : typeof nextCursor === 'string' ? nextCursor : fail(),
  };
}
export function parseAuthorities(value: unknown): Authority[] {
  const items = exact(value, ['authorities']).authorities;
  if (!Array.isArray(items) || items.length > 100) return fail();
  const parsed = items.map((value: unknown) => {
    const row = exact(value, ['name', 'capability', 'producerId', 'receiptAvailable']);
    const name = row.name;
    if (
      typeof name !== 'string' ||
      !name ||
      name !== name.trim() ||
      [...name].length > 200 ||
      [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      return fail();
    const capability = capabilities.find((item) => item === row.capability);
    if (!capability) return fail();
    return {
      name,
      capability,
      producerId: uuid(row.producerId),
      receiptAvailable: boolean(row.receiptAvailable),
    };
  });
  if (new Set(parsed.map((item) => item.producerId.toLowerCase())).size !== parsed.length) fail();
  return parsed;
}
