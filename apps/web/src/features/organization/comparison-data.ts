import type { MetricResult } from '@clio/oems';
import { parseHistoryPage as parseArgoPage } from '../argo-collection/api';
import { parseHistoryPage as parseGitHubPage } from '../github-collection/api';
import { ApiError } from '../identity/api';
import { parseHistoryPage as parseMeasurementPage } from '../measurement-evidence/api';
import { parseHistoryPage as parseMockPage } from '../mock-collection/api';

export type ComparisonSource = 'measurement' | 'github' | 'argo' | 'mock';
export type ReportingWindow = { start: string; end: string };
export type SavedCapture = {
  id: string;
  window: ReportingWindow;
  result: MetricResult | undefined;
  source: string;
  revision: number;
  oemsRevision: string;
  completedAt: string | null;
  evidenceCutoff: string;
  coverage: {
    collectionComplete: boolean;
    deploymentHistoryComplete: boolean;
    recoveryEvidenceComplete: boolean;
  };
};
export function parseComparison(
  value: unknown,
  scope: { workspaceId: string; serviceId: string },
  source: ComparisonSource,
): SavedCapture[] {
  const options = { succeeded: true };
  if (source === 'measurement') {
    return parseMeasurementPage(value, scope, options).runs.map((run) => {
      const result = run.result;
      if (!result) throw new ApiError(0);
      return {
        id: run.id,
        window: result.window,
        result: result.metricResult,
        source: run.provider,
        revision: result.connectionRevision,
        oemsRevision: result.oemsRevision,
        completedAt: run.completedAt,
        evidenceCutoff: result.evidenceCutoff,
        coverage: result.coverage,
      };
    });
  }
  const page =
    source === 'github'
      ? parseGitHubPage(value, scope, options)
      : source === 'argo'
        ? parseArgoPage(value, scope, options)
        : parseMockPage(value, scope, options);
  return page.runs.map((run) => {
    const result = run.result;
    if (!result) throw new ApiError(0);
    return {
      id: run.id,
      window: result.window,
      result: result.metricResult,
      source: run.mode === 'mock' ? `demo:${run.primaryProvider}` : source,
      revision: run.mode === 'mock' ? run.mappingRevision : run.connectionRevision,
      oemsRevision: result.oemsRevision,
      completedAt: run.completedAt,
      evidenceCutoff: result.evidenceCutoff,
      coverage: result.coverage,
    };
  });
}

// Pinned reporting windows are UTC whole days; equivalent RFC3339 spellings share identity.
export function windowKey(window: ReportingWindow): string {
  return `${new Date(window.start).toISOString()}|${new Date(window.end).toISOString()}`;
}
export function windowLabel(key: string): string {
  const [start, end] = key.split('|');
  return `${start?.slice(0, 10)} to ${end?.slice(0, 10)} (UTC, end exclusive)`;
}
export function reportingWindows(histories: SavedCapture[][]): string[] {
  return [
    ...new Set(histories.flatMap((history) => history.map((capture) => windowKey(capture.window)))),
  ].sort((a, b) => b.localeCompare(a));
}
export function selectedCapture(history: SavedCapture[], period: string): SavedCapture | undefined {
  return period === 'latest'
    ? history[0]
    : history.find((capture) => windowKey(capture.window) === period);
}

/** Newest capture owns its exact period, including legacy captures with missing metrics. */
export function comparisonSeries(
  history: SavedCapture[],
  selected: SavedCapture,
  period = 'latest',
): SavedCapture[] {
  const periods = new Map<string, SavedCapture>();
  for (const capture of [selected, ...history]) {
    if (
      capture.source !== selected.source ||
      capture.revision !== selected.revision ||
      capture.oemsRevision !== selected.oemsRevision ||
      (period !== 'latest' && Date.parse(capture.window.end) > Date.parse(selected.window.end))
    )
      continue;
    const key = windowKey(capture.window);
    if (!periods.has(key)) periods.set(key, capture);
  }
  return [...periods.values()].sort((a, b) =>
    windowKey(a.window).localeCompare(windowKey(b.window)),
  );
}
export function sourceLabel(source: string) {
  return source.startsWith('demo:')
    ? 'Demo data'
    : source === 'argocd' || source === 'argo'
      ? 'Argo CD'
      : 'GitHub';
}
