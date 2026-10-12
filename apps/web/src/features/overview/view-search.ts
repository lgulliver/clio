import { windowKey } from '../organization/comparison-data';
import { defaultView, type OrganizationView } from '../organization/view-state';

export type OverviewSearch = {
  workspace?: string;
  team?: string;
  product?: string;
  service?: string;
  source?: OrganizationView['source'];
  window?: string;
  previous?: string;
  invalidView?: true;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function period(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const parts = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(value);
  if (!parts?.[1] || !parts[2]) return;
  const start = `${parts[1]}T00:00:00.000Z`;
  const end = `${parts[2]}T00:00:00.000Z`;
  if (
    !Number.isFinite(Date.parse(start)) ||
    !Number.isFinite(Date.parse(end)) ||
    Date.parse(start) >= Date.parse(end)
  )
    return;
  if (new Date(start).toISOString() !== start || new Date(end).toISOString() !== end) return;
  return windowKey({ start, end });
}
export function parseOverviewSearch(value: Record<string, unknown>): OverviewSearch {
  const result: OverviewSearch = {};
  let invalid = false;
  for (const key of ['workspace', 'team', 'service'] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] === 'string' && uuid.test(value[key]))
      result[key] = value[key].toLowerCase();
    else invalid = true;
  }
  if (value.product !== undefined) {
    if (value.product === 'unassigned') result.product = value.product;
    else if (typeof value.product === 'string' && uuid.test(value.product))
      result.product = value.product.toLowerCase();
    else invalid = true;
  }
  if (value.source !== undefined) {
    if (
      value.source === 'github' ||
      value.source === 'argo' ||
      value.source === 'mock' ||
      value.source === 'measurement'
    )
      result.source = value.source;
    else invalid = true;
  }
  for (const key of ['window', 'previous'] as const) {
    if (value[key] === undefined) continue;
    if (period(value[key])) result[key] = String(value[key]);
    else invalid = true;
  }
  if (!result.workspace && (result.team || result.product || result.service)) {
    delete result.team;
    delete result.product;
    delete result.service;
    invalid = true;
  }
  if (result.previous && !result.window) {
    delete result.previous;
    invalid = true;
  }
  if (invalid) result.invalidView = true;
  return result;
}
export function viewFromSearch(search: OverviewSearch): OrganizationView {
  return {
    teamId: search.team ?? '',
    productId: search.product ?? '',
    serviceId: search.service ?? '',
    source: search.source ?? defaultView.source,
    period: period(search.window) ?? 'latest',
    previousPeriod: period(search.previous) ?? '',
  };
}
function windowParameter(key: string) {
  const [start, end] = key.split('|');
  return `${start?.slice(0, 10)}_${end?.slice(0, 10)}`;
}
export function searchForView(workspaceId: string, view: OrganizationView): OverviewSearch {
  return {
    workspace: workspaceId,
    ...(view.teamId ? { team: view.teamId } : {}),
    ...(view.productId ? { product: view.productId } : {}),
    ...(view.serviceId ? { service: view.serviceId } : {}),
    ...(view.source === 'measurement' ? {} : { source: view.source }),
    ...(view.period === 'latest' ? {} : { window: windowParameter(view.period) }),
    ...(view.previousPeriod && view.period !== 'latest'
      ? { previous: windowParameter(view.previousPeriod) }
      : {}),
  };
}

export type ChangeOverviewSearch = (update: (current: OverviewSearch) => OverviewSearch) => void;
