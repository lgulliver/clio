import type { ValidatedSnapshot } from '@clio/oems';
import { object } from '../identity/input.ts';
import { count, instant } from './input.ts';

/** Diagnostic only. An operation journal cannot attest a production deployment population. */
export function assessArgoCoverage(snapshot: ValidatedSnapshot['data']) {
  const end = instant(snapshot.window.end),
    start = instant(snapshot.window.start);
  const qualifying = snapshot.deployments.filter((d) => d.qualification === 'qualifying');
  const history = qualifying.filter(
    (d) => d.effective_at !== null && instant(d.effective_at) < end,
  );
  const population = history.filter(
    (d) => d.effective_at !== null && instant(d.effective_at) >= start,
  );
  return {
    version: 1 as const,
    populationEvidence: 'not_supplied' as const,
    firstDeploymentHistory: 'not_supplied' as const,
    recoveryEvidence: 'not_supplied' as const,
    unresolvedQualificationCount: snapshot.deployments.filter((d) => d.qualification === 'unknown')
      .length,
    historyQualifyingCount: history.length,
    incompleteChangeLinkCount: history.filter((d) => !d.change_links_complete).length,
    windowPopulationCount: population.length,
    unknownFailureCount: population.filter((d) => d.failure === 'unknown').length,
    unknownReworkCount: population.filter((d) => d.rework === 'unknown').length,
  };
}

/** Older stored results omit this assessment. Do not manufacture one while reading them. */
export function parseCoverageAssessment(
  value: unknown,
  totals: {
    unknownCount: number;
    qualifyingCount: number;
    frequencyCount: number;
  },
) {
  const row = object(value, [
    'version',
    'populationEvidence',
    'firstDeploymentHistory',
    'recoveryEvidence',
    'unresolvedQualificationCount',
    'historyQualifyingCount',
    'incompleteChangeLinkCount',
    'windowPopulationCount',
    'unknownFailureCount',
    'unknownReworkCount',
  ]);
  const unresolvedQualificationCount = count(row.unresolvedQualificationCount),
    historyQualifyingCount = count(row.historyQualifyingCount),
    incompleteChangeLinkCount = count(row.incompleteChangeLinkCount),
    windowPopulationCount = count(row.windowPopulationCount),
    unknownFailureCount = count(row.unknownFailureCount),
    unknownReworkCount = count(row.unknownReworkCount);
  if (
    row.version !== 1 ||
    row.populationEvidence !== 'not_supplied' ||
    row.firstDeploymentHistory !== 'not_supplied' ||
    row.recoveryEvidence !== 'not_supplied' ||
    unresolvedQualificationCount !== totals.unknownCount ||
    historyQualifyingCount > totals.qualifyingCount ||
    windowPopulationCount !== totals.frequencyCount ||
    windowPopulationCount > historyQualifyingCount ||
    // Version 1 pins current adapter behavior: no complete links or known failure/rework.
    // Adding that evidence requires a new assessment version in both parsers, preserving old reads.
    incompleteChangeLinkCount !== historyQualifyingCount ||
    unknownFailureCount !== windowPopulationCount ||
    unknownReworkCount !== windowPopulationCount
  )
    throw new Error('Invalid Argo coverage assessment');
  return {
    version: 1 as const,
    populationEvidence: 'not_supplied' as const,
    firstDeploymentHistory: 'not_supplied' as const,
    recoveryEvidence: 'not_supplied' as const,
    unresolvedQualificationCount,
    historyQualifyingCount,
    incompleteChangeLinkCount,
    windowPopulationCount,
    unknownFailureCount,
    unknownReworkCount,
  };
}
