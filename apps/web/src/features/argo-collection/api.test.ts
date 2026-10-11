import { describe, expect, it } from 'vitest';
import {
  closedWindow,
  parseConnection,
  parseHistoryPage,
  parseRun,
  parseRuns,
  parseSavedConnection,
} from './api';
import {
  archiveProducer,
  archiveSummary,
  completed,
  connection,
  coverageAssessment,
  result,
  scope,
  source,
} from './fixtures.test-support';

describe('live Argo boundary', () => {
  it('reads selected archive policies and immutable bounds separately from reporting window', () => {
    const saved = { ...connection, archiveProducer };
    expect(
      parseConnection(
        {
          connection: saved,
          configured: true,
          sources: [{ ...source, archiveProducers: [archiveProducer] }],
        },
        scope,
      ).connection,
    ).toEqual(saved);
    const captured = { ...result, archiveSummary };
    expect(parseRun({ run: { ...completed, result: captured } }, scope).result).toEqual(captured);
    expect(parseRun({ run: completed }, scope).result).not.toHaveProperty('archiveSummary');
  });
  it('rejects private archive fields, mismatched totals and bounds after evidence cutoff', () => {
    for (const summary of [
      { ...archiveSummary, token: 'private' },
      { ...archiveSummary, omittedIntervalCount: 1 },
      { ...archiveSummary, lastSuccessfulReconciliationAt: '2026-01-04T00:02:00Z' },
      {
        ...archiveSummary,
        sealedInterval: { start: '2026-01-05T00:00:00Z', end: '2026-01-06T00:00:00Z' },
      },
      { ...archiveSummary, gapCount: 4 },
    ])
      expect(() =>
        parseRun({ run: { ...completed, result: { ...result, archiveSummary: summary } } }, scope),
      ).toThrow();
  });
  it('rejects changed archive selection in a save acknowledgement', () => {
    expect(() =>
      parseSavedConnection(
        { connection: { ...connection, revision: 2, archiveProducer: null } },
        scope,
        1,
        true,
        { ...connection, archiveProducer },
      ),
    ).toThrow();
  });
  it('parses safe granted producers and separate enrichment counts without asserting coverage', () => {
    const producer = {
      producerId: '99999999-9999-4999-8999-999999999999',
      capability: 'consumer_exposure',
      policyReference: 'urn:fixture:traffic:v1',
    };
    const saved = { ...connection, enrichmentProducers: [producer] };
    expect(
      parseConnection(
        {
          connection: saved,
          configured: true,
          sources: [{ ...source, enrichmentProducers: [producer] }],
        },
        scope,
      ).connection,
    ).toEqual(saved);
    const captured = {
      ...result,
      enrichmentSummary: {
        retainedReceiptCount: 1,
        consumerExposureCount: 1,
        applicationProvenanceCount: 0,
        policies: [producer],
      },
    };
    expect(parseRun({ run: { ...completed, result: captured } }, scope).result).toEqual(captured);
  });
  it.each(
    [
      [
        {
          producerId: '99999999-9999-4999-8999-999999999999',
          capability: 'native',
          policyReference: 'policy/v1',
        },
      ],
      [
        {
          producerId: '99999999-9999-4999-8999-999999999999',
          capability: 'consumer_exposure',
          policyReference: 'policy/v1',
          token: 'private',
        },
      ],
      [
        {
          producerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          capability: 'consumer_exposure',
          policyReference: 'policy/v1',
        },
        {
          producerId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
          capability: 'consumer_exposure',
          policyReference: 'policy/v1',
        },
      ],
    ].map((enrichmentProducers) => ({ enrichmentProducers })),
  )('rejects untrusted producer metadata %#', ({ enrichmentProducers }) => {
    expect(() =>
      parseConnection(
        { connection: { ...connection, enrichmentProducers }, configured: true, sources: [source] },
        scope,
      ),
    ).toThrow();
  });
  it('rejects inconsistent enrichment totals', () => {
    expect(() =>
      parseRun(
        {
          run: {
            ...completed,
            result: {
              ...result,
              enrichmentSummary: {
                retainedReceiptCount: 0,
                consumerExposureCount: 1,
                applicationProvenanceCount: 0,
                policies: [],
              },
            },
          },
        },
        scope,
      ),
    ).toThrow();
  });
  it('accepts storage interruption gaps when no notification receipt exists', () => {
    const captured = {
      ...result,
      retainedReceiptCount: 0,
      retainedEvidenceCount: 0,
      recordedGapCount: 2,
      gapReasons: { connection_interruption: 2 },
      deploymentCount: 0,
      qualifyingCount: 0,
      unknownCount: 0,
    };
    expect(parseRun({ run: { ...completed, result: captured } }, scope).result).toEqual(captured);
  });
  it('accepts workspace configured flag independent of historical active connection', () => {
    expect(parseConnection({ connection, configured: false, sources: [] }, scope)).toEqual({
      connection,
      configured: false,
      sources: [],
    });
    expect(
      parseConnection({ connection: null, configured: true, sources: [source] }, scope).connection,
    ).toBeNull();
    expect(parseRun({ run: completed }, scope, 1, completed.id)).toEqual(completed);
  });
  it.each([
    { connection: { ...connection, token: 'private' }, configured: true, sources: [source] },
    { connection: { ...connection, mode: 'mock' }, configured: true, sources: [source] },
    { connection: { ...connection, provider: 'github' }, configured: true, sources: [source] },
    {
      connection: { ...connection, workspaceId: scope.serviceId },
      configured: true,
      sources: [source],
    },
    {
      connection: { ...connection, serviceId: scope.workspaceId },
      configured: true,
      sources: [source],
    },
    { connection: { ...connection, sourceId: 'not-uuid' }, configured: true, sources: [source] },
    { connection: { ...connection, applicationName: '' }, configured: true, sources: [source] },
    {
      connection: { ...connection, applicationOperationsBelongToService: false },
      configured: true,
      sources: [source],
    },
    {
      connection: { ...connection, observedAt: '2026-02-30T00:00:00Z' },
      configured: true,
      sources: [source],
    },
    {
      connection: { ...connection, observedAt: '2026-01-04T00:00:00+00:00' },
      configured: true,
      sources: [source],
    },
    { connection, configured: 'true', sources: [source] },
    { connection, configured: true, sources: [source], privateKeyFile: '/secret' },
  ])('rejects invalid/private connection fields %#', (value) =>
    expect(() => parseConnection(value, scope)).toThrow(),
  );
  it('rejects private, duplicate, unconfigured and malformed granted sources', () => {
    for (const sources of [
      [{ ...source, tokenFile: '/private' }],
      [source, source],
      [{ ...source, sourceId: 'bad' }],
      Array.from({ length: 101 }, () => source),
    ])
      expect(() => parseConnection({ connection, configured: true, sources }, scope)).toThrow();
    expect(() =>
      parseConnection({ connection: null, configured: false, sources: [source] }, scope),
    ).toThrow();
    expect(() =>
      parseConnection({ connection: null, configured: true, sources: [] }, scope),
    ).toThrow();
  });
  it('checks save/disconnect revision and active state', () => {
    expect(
      parseSavedConnection(
        { connection: { ...connection, revision: 2, active: false } },
        scope,
        1,
        false,
      ).active,
    ).toBe(false);
    expect(() => parseSavedConnection({ connection }, scope, 1, true)).toThrow();
    expect(() =>
      parseSavedConnection({ connection: { ...connection, revision: 2 } }, scope, 1, false),
    ).toThrow();
  });
  it.each([
    { ...result, mode: 'mock' },
    { ...result, provider: 'github' },
    { ...result, gapReasons: { ...result.gapReasons, tokenDigest: 'private' } },
    {
      ...result,
      observationPeriod: { ...result.observationPeriod, start: '2026-01-04T00:01:00.000002Z' },
    },
    { ...result, connectionRevision: 2 },
    { ...result, oemsRevision: 'other' },
    { ...result, serviceId: scope.workspaceId },
    { ...result, window: { ...result.window, calendarDays: 3 } },
    { ...result, window: { ...result.window, start: '2026-01-01T01:00:00Z' } },
    { ...result, window: { ...result.window, end: '2026-05-01T00:00:00Z', calendarDays: 120 } },
    { ...result, evidenceCutoff: '2026-01-02T00:00:00Z' },
    { ...result, transportComplete: true },
    { ...result, retainedReceiptCount: -1 },
    { ...result, recordedGapCount: 3 },
    { ...result, gapReasons: { arbitrary: 2 } },
    { ...result, rejectionCount: 1.2 },
    { ...result, observationPeriod: { ...result.observationPeriod, end: '2026-01-05T00:00:00Z' } },
    { ...result, coverage: { ...result.coverage, collectionComplete: true } },
    { ...result, coverage: { ...result.coverage, deploymentHistoryComplete: true } },
    { ...result, coverage: { ...result.coverage, recoveryEvidenceComplete: true } },
    { ...result, deploymentFrequency: { ...result.deploymentFrequency, deploymentsPerDay: 0 } },
    { ...result, deploymentFrequency: { ...result.deploymentFrequency, status: 'complete' } },
    { ...result, deploymentFrequency: { ...result.deploymentFrequency, qualityReasons: [''] } },
    { ...result, deploymentFrequency: { ...result.deploymentFrequency, qualityReasons: [] } },
    { ...result, deploymentFrequency: { ...result.deploymentFrequency, count: 1 } },
    { ...result, unknownCount: 3 },
    { ...result, qualifyingCount: -1 },
    { ...result, changeFailureRate: 0 },
    { ...result, failedDeploymentRecoveryTime: 0 },
    { ...result, rawEvidence: [] },
  ])('rejects unverifiable quality/result fields %#', (value) =>
    expect(() => parseRun({ run: { ...completed, result: value } }, scope)).toThrow(),
  );
  it('checks run scope/status/revision/detail ID/time and bounded unique newest history', () => {
    for (const patch of [
      { mode: 'mock' },
      { provider: 'github' },
      { workspaceId: scope.serviceId },
      { attempts: 4 },
      { status: 'pending' },
      { failureCode: 'private failure' },
      { completedAt: null },
      { updatedAt: '2026-01-03T00:00:00Z' },
      { completedAt: '2026-01-04T00:01:00Z' },
      { leaseToken: 'secret' },
    ])
      expect(() => parseRun({ run: { ...completed, ...patch } }, scope)).toThrow();
    expect(() => parseRun({ run: completed }, scope, 2)).toThrow();
    expect(() =>
      parseRun({ run: completed }, scope, 1, undefined, {
        start: '2026-01-02T00:00:00Z',
        end: '2026-01-03T00:00:00Z',
      }),
    ).toThrow();
    expect(() => parseRun({ run: completed }, scope, undefined, scope.serviceId)).toThrow();
    expect(() => parseRuns({ runs: [completed, completed] }, scope)).toThrow();
    expect(() => parseRuns({ runs: Array.from({ length: 26 }, () => completed) }, scope)).toThrow();
    expect(() =>
      parseRuns(
        {
          runs: [
            completed,
            { ...completed, id: scope.serviceId, createdAt: '2026-01-04T00:00:02Z' },
          ],
        },
        scope,
      ),
    ).toThrow();
  });
  it('accepts closed UTC 90 day window and rejects invalid/open/oversized dates', () => {
    expect(closedWindow('2026-01-01', '2026-04-01', Date.parse('2026-04-01T00:00:00Z'))).toEqual({
      start: '2026-01-01T00:00:00Z',
      end: '2026-04-01T00:00:00Z',
    });
    for (const [start, end] of [
      ['2026-01-01', '2026-04-02'],
      ['2026-02-30', '2026-03-04'],
      ['2026-01-01', '2026-01-01'],
      ['2026-04-02', '2026-04-01'],
      ['2026-04-01', '2026-04-02'],
      ['2026-1-1', '2026-01-02'],
    ])
      expect(() =>
        closedWindow(start ?? '', end ?? '', Date.parse('2026-04-01T12:00:00Z')),
      ).toThrow();
  });
});

it('parses saved assessment and leaves older assessments unknown; rejects hidden or contradictory claims', () => {
  const saved = { ...result, coverageAssessment };
  expect(parseRun({ run: { ...completed, result: saved } }, scope).result).toEqual(saved);
  expect(parseRun({ run: completed }, scope).result).not.toHaveProperty('coverageAssessment');
  for (const assessment of [
    null,
    { ...coverageAssessment, token: 'private' },
    { ...coverageAssessment, populationEvidence: 'complete' },
    { ...coverageAssessment, version: 2 },
    { ...coverageAssessment, unresolvedQualificationCount: 0 },
    { ...coverageAssessment, historyQualifyingCount: 1 },
    { ...coverageAssessment, windowPopulationCount: 1 },
    { ...coverageAssessment, unknownFailureCount: 1 },
    { ...coverageAssessment, incompleteChangeLinkCount: -1 },
  ]) {
    expect(() =>
      parseRun(
        { run: { ...completed, result: { ...result, coverageAssessment: assessment } } },
        scope,
      ),
    ).toThrow();
  }
});

describe('saved history pages', () => {
  it('keeps legacy runs readable and validates cursors, status, ties and safe scope', () => {
    const runs = Array.from({ length: 25 }, (_, index) => ({
      ...completed,
      id: `${String(100 - index).padStart(8, '0')}-1111-4111-8111-111111111111`,
    }));
    const nextCursor = runs.at(-1)?.id;
    expect(parseRuns({ runs, nextCursor }, scope)).toHaveLength(25);
    expect(parseHistoryPage({ runs: [completed] }, scope)).toEqual({
      runs: [completed],
      nextCursor: null,
    });
    expect(parseHistoryPage({ runs, nextCursor }, scope, { succeeded: true }).nextCursor).toBe(
      nextCursor,
    );
    for (const response of [
      { runs, nextCursor: 'bad' },
      { runs, nextCursor: completed.id },
      { runs: [completed], nextCursor: completed.id },
      { runs: [...runs].reverse(), nextCursor: null },
      { runs: [completed], privateEvidence: {} },
      { runs: [{ ...completed, serviceId: scope.workspaceId }] },
      { runs: [{ ...completed, leaseToken: 'private' }] },
    ])
      expect(() => parseHistoryPage(response, scope)).toThrow();
    expect(() =>
      parseHistoryPage({ runs: [completed] }, scope, { cursor: completed.id }),
    ).toThrow();
    expect(() => parseHistoryPage({ runs: [] }, scope, { cursor: 'bad' })).toThrow();
    const pending = {
      ...completed,
      status: 'pending',
      result: null,
      completedAt: null,
      failureCode: null,
    };
    expect(() => parseHistoryPage({ runs: [pending] }, scope, { succeeded: true })).toThrow();
  });
});
