import {
  type MockScenario,
  type Preview,
  parsePreview,
  parseScenario,
  type Scope,
} from '../deployment-mappings/api';
import { ApiError, record } from '../identity/api';

export type Run = Scope & {
  id: string;
  mode: 'mock';
  scenario?: MockScenario;
  mappingRevision: number;
  mappingObservedAt: string;
  primaryProvider: 'github' | 'argocd';
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  failureCode: 'mock_processing_failed' | null;
  result: Preview | null;
};
function fail(): never {
  throw new ApiError(0);
}
function uuid(value: unknown): string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : fail();
}
function integer(value: unknown, minimum: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
    ? value
    : fail();
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string') return fail();
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z$/.exec(value);
  if (
    !match ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10) !== match[1] ||
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    Number(match[4]) > 59
  )
    return fail();
  return value;
}
function instant(value: string): bigint {
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? '';
  return BigInt(Date.parse(value)) * 1000n + BigInt(fraction.padEnd(6, '0').slice(3));
}
function run(value: unknown, scope: Scope): Run {
  const item = record(value);
  const keys = [
    'id',
    'workspaceId',
    'serviceId',
    'mode',
    'mappingRevision',
    'mappingObservedAt',
    'primaryProvider',
    'status',
    'attempts',
    'createdAt',
    'updatedAt',
    'completedAt',
    'failureCode',
    'result',
    ...(Object.hasOwn(item, 'scenario') ? ['scenario'] : []),
  ];
  if (
    Object.keys(item).length !== keys.length ||
    Object.keys(item).some((key) => !keys.includes(key)) ||
    item.workspaceId !== uuid(scope.workspaceId) ||
    item.serviceId !== uuid(scope.serviceId) ||
    item.mode !== 'mock' ||
    (item.primaryProvider !== 'github' && item.primaryProvider !== 'argocd') ||
    (item.status !== 'pending' &&
      item.status !== 'running' &&
      item.status !== 'succeeded' &&
      item.status !== 'failed')
  )
    return fail();
  const scenario = parseScenario(item.scenario);
  const mappingRevision = integer(item.mappingRevision, 1);
  const mappingObservedAt = timestamp(item.mappingObservedAt);
  const attempts = integer(item.attempts, 0);
  const createdAt = timestamp(item.createdAt);
  const updatedAt = timestamp(item.updatedAt);
  const terminal = item.status === 'succeeded' || item.status === 'failed';
  const completedAt = item.completedAt === null ? null : timestamp(item.completedAt);
  if (
    attempts > 3 ||
    terminal !== (completedAt !== null) ||
    (item.status === 'failed'
      ? item.failureCode !== 'mock_processing_failed'
      : item.failureCode !== null) ||
    (item.status === 'succeeded' ? item.result === null : item.result !== null) ||
    instant(createdAt) < instant(mappingObservedAt) ||
    instant(updatedAt) < instant(createdAt) ||
    (completedAt !== null &&
      (instant(completedAt) < instant(createdAt) || instant(completedAt) > instant(updatedAt)))
  )
    return fail();
  // Preview parser needs mapping metadata only. Editable fields do not participate in result validation.
  const result =
    item.status === 'succeeded'
      ? parsePreview(
          { preview: item.result },
          {
            ...scope,
            scenario,
            mode: 'mock',
            revision: mappingRevision,
            observedAt: mappingObservedAt,
            primaryProvider: item.primaryProvider,
            productionEnvironment: '',
            exposureAttested: false,
          },
        )
      : null;
  return {
    ...(item.scenario === undefined ? {} : { scenario }),
    ...scope,
    id: uuid(item.id),
    mode: 'mock',
    mappingRevision,
    mappingObservedAt,
    primaryProvider: item.primaryProvider,
    status: item.status,
    attempts,
    createdAt,
    updatedAt,
    completedAt,
    failureCode: item.status === 'failed' ? 'mock_processing_failed' : null,
    result,
  };
}
export function parseRun(value: unknown, scope: Scope, expectedRevision?: number): Run {
  const result = run(record(value).run, scope);
  if (expectedRevision !== undefined && result.mappingRevision !== expectedRevision) return fail();
  return result;
}
export function parseRuns(value: unknown, scope: Scope): Run[] {
  const items = record(value).runs;
  if (!Array.isArray(items) || items.length > 25) return fail();
  const runs = items.map((item: unknown) => run(item, scope));
  if (new Set(runs.map((item) => item.id.toLowerCase())).size !== runs.length) return fail();
  for (let index = 1; index < runs.length; index += 1) {
    const previous = runs[index - 1];
    const current = runs[index];
    if (!previous || !current || instant(previous.createdAt) < instant(current.createdAt))
      return fail();
  }
  return runs;
}

export function newestFirst(left: Run, right: Run): number {
  const difference = instant(right.createdAt) - instant(left.createdAt);
  return difference > 0n ? 1 : difference < 0n ? -1 : right.id.localeCompare(left.id);
}

/** Legacy {runs} remains readable. Missing nextCursor means pagination unavailable.
 * Filter and cursor are request scope, never claims supplied by response data.
 */
export type HistoryPage = { runs: Run[]; nextCursor: string | null };
export function parseHistoryPage(
  value: unknown,
  scope: Scope,
  options: { cursor?: string; succeeded?: boolean } = {},
): HistoryPage {
  const row = record(value);
  if (Object.keys(row).some((key) => key !== 'runs' && key !== 'nextCursor')) return fail();
  const runs = parseRuns(value, scope);
  const nextCursor =
    row.nextCursor === undefined || row.nextCursor === null ? null : uuid(row.nextCursor);
  if (options.cursor !== undefined) uuid(options.cursor);
  if (
    (nextCursor !== null &&
      (runs.length !== 25 || nextCursor.toLowerCase() !== runs.at(-1)?.id.toLowerCase())) ||
    runs.some(
      (run) =>
        run.id.toLowerCase() === options.cursor?.toLowerCase() ||
        (options.succeeded && run.status !== 'succeeded'),
    )
  )
    return fail();
  for (let index = 1; index < runs.length; index++) {
    const prior = runs[index - 1],
      current = runs[index];
    if (
      !prior ||
      !current ||
      instant(prior.createdAt) < instant(current.createdAt) ||
      (instant(prior.createdAt) === instant(current.createdAt) &&
        prior.id.toLowerCase() <= current.id.toLowerCase())
    )
      return fail();
  }
  return { runs, nextCursor };
}
