import { randomUUID } from 'node:crypto';
import {
  collectGitHubDeployments,
  createBoundedGitHubTransport,
  type FetchTransport,
  identity,
} from '@clio/adapters';
import { oemsContract } from '@clio/oems';
import { describe, expect, it } from 'vitest';
import { captureGitHub } from '../src/features/github-collection/capture.ts';
import { mergeHistory, parseEvidence } from '../src/features/github-collection/history.ts';
import { parseConnection, windowInput } from '../src/features/github-collection/input.ts';

const connection = parseConnection({
  workspaceId: '11111111-1111-4111-8111-111111111111',
  serviceId: '22222222-2222-4222-8222-222222222222',
  mode: 'live',
  provider: 'github',
  revision: 1,
  active: true,
  installationId: 10,
  repositoryId: 20,
  repositoryName: 'fixture-repo',
  accountLogin: 'fixture-owner',
  productionEnvironment: 'production',
  exposurePolicyReference: 'urn:fixture:consumer-exposure-policy:v1',
  repositoryDeploymentsBelongToService: true,
  observedAt: '2026-10-10T08:00:00.000001Z',
  verifiedAt: '2026-10-10T08:00:00Z',
});
const window = windowInput({ start: '2026-01-01T00:00:00Z', end: '2026-01-03T00:00:00Z' });
const tip = 'a'.repeat(40);
const observedAt = '2026-10-10T08:00:01Z';
function deployment(id: number, at: string, environment = 'production') {
  return {
    id,
    sha: tip,
    environment,
    task: 'deploy',
    created_at: at,
    updated_at: at,
    payload: { private: 'discard-provider-payload' },
  };
}
function status(id: number, at: string, state = 'success', environment = 'production') {
  return { id, state, environment, created_at: at, updated_at: at };
}
const deployments = [
  deployment(30, '2026-01-01T10:00:00Z', 'staging'),
  deployment(31, '2026-01-02T14:00:00Z'),
  deployment(32, '2026-01-03T10:00:00Z'),
  deployment(33, '2026-01-02T10:00:00Z'),
];
const statuses = new Map([
  [
    30,
    [
      status(43, '2026-01-02T13:00:00Z', 'inactive'),
      status(42, '2026-01-02T12:00:00Z', 'failure'),
      status(41, '2026-01-01T11:00:00Z'),
      status(40, '2026-01-01T10:30:00Z', 'success', 'staging'),
    ],
  ],
  [31, [status(44, '2026-01-02T14:15:00Z')]],
  [32, [status(45, '2026-01-03T11:00:00Z')]],
  [33, [status(46, '2026-01-02T11:00:00Z', 'error')]],
]);
async function collect(rows = deployments, statusRows = statuses, time = observedAt) {
  const calls: string[] = [];
  const fetch: FetchTransport = async (url) => {
    calls.push(url);
    const path = new URL(url).pathname;
    let body: unknown;
    if (path === '/repositories/20')
      body = { id: 20, owner: { login: 'fixture-owner' }, name: 'fixture-repo' };
    else if (path === '/repos/fixture-owner/fixture-repo/deployments') body = rows;
    else {
      const match = /^\/repos\/fixture-owner\/fixture-repo\/deployments\/(\d+)\/statuses$/.exec(
        path,
      );
      if (!match) throw new Error('Unexpected controlled request');
      body = statusRows.get(Number(match[1])) ?? [];
    }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  const batch = await collectGitHubDeployments({
    instance: String(connection.installationId),
    repositoryId: connection.repositoryId,
    token: 'fictional-installation-token',
    clock: () => new Date(time),
    fetch: createBoundedGitHubTransport({ fetch }),
  });
  const evidence = parseEvidence(
    JSON.parse(
      JSON.stringify({
        deployments: batch.deployments,
        statuses: batch.statuses,
        completedStatusTraversals: batch.completedStatusTraversals,
      }),
    ),
    connection,
  );
  return { batch, evidence, calls };
}
function capture(
  evidence: ReturnType<typeof parseEvidence>,
  policy: string | null = connection.exposurePolicyReference,
  acquiredAt = '2026-10-10T08:00:02Z',
  databaseObservedAt = '2026-10-10T08:00:02.000002Z',
) {
  return captureGitHub({
    runId: randomUUID(),
    connection: { ...connection, exposurePolicyReference: policy },
    serviceName: 'Fixture service',
    window,
    evidence,
    transportComplete: true,
    acquiredAt,
    databaseObservedAt,
  });
}

describe('controlled GitHub HTTP ingestion through pinned OEMS capture', () => {
  it('preserves promotion, separate same-SHA rollouts and window-scoped metric populations', async () => {
    const collected = await collect();
    expect(collected.batch.transportComplete).toBe(true);
    expect(collected.calls).toHaveLength(6);
    expect(
      collected.calls.some((url) => url.includes('/actions/') || url.includes('environment=')),
    ).toBe(false);
    expect(JSON.stringify(collected.evidence)).not.toContain('discard-provider-payload');
    const captured = capture(collected.evidence);
    expect(captured.oemsRevision).toBe(oemsContract.revision);
    expect(captured.result).toMatchObject({
      evidenceCutoff: '2026-10-10T08:00:02.000002Z',
      deploymentCount: 4,
      qualifyingCount: 3,
      unknownCount: 1,
      deploymentFrequency: { count: 2, status: 'provisional', deploymentsPerDay: null },
      coverage: {
        collectionComplete: false,
        deploymentHistoryComplete: false,
        recoveryEvidenceComplete: false,
      },
      changeFailureRate: null,
      failedDeploymentRecoveryTime: null,
    });
    const sourceRef = `urn:clio:${identity('github', '10', 'repository', 20, 'deployment', 30)}`;
    const promoted = captured.snapshot.deployments.find((row) =>
      row.source_refs.includes(sourceRef),
    );
    expect(promoted).toMatchObject({
      environment: 'production',
      qualification: 'qualifying',
      effective_at: '2026-01-01T11:00:00Z',
      failure: 'unknown',
      rework: 'unknown',
      change_ids: [],
      change_links_complete: false,
      extensions: {
        tip_provenance: [
          { repository_id: identity('github', '10', 'repository', 20), tip_sha: tip },
        ],
      },
    });
    expect(captured.snapshot.changes).toEqual([]);
    expect(captured.snapshot.incidents).toEqual([]);
    expect(captured.metrics[0]).toMatchObject({
      qualification_unknown_count: 1,
      change_lead_time: { median_seconds: null },
      change_fail_rate: { denominator: 2, unknown_count: 2, ratio: null },
      deployment_rework_rate: { denominator: 2, unknown_count: 2, ratio: null },
      failed_deployment_recovery_time: { median_seconds: null },
    });
  });
  it('keeps successful deployment unknown without explicit consumer-exposure policy', async () => {
    const collected = await collect();
    expect(capture(collected.evidence, null).result).toMatchObject({
      deploymentCount: 4,
      qualifyingCount: 0,
      unknownCount: 4,
      deploymentFrequency: { count: 0, status: 'provisional', deploymentsPerDay: null },
    });
  });
  it('preserves exposure and first observation when later backfill omits records or reports failure', async () => {
    const first = await collect();
    const saved = capture(first.evidence);
    const original = JSON.stringify(saved.snapshot);
    const later = await collect(
      deployments.filter((row) => row.id === 31),
      new Map([[31, [status(50, '2026-01-02T15:00:00Z', 'failure')]]]),
      '2026-10-10T08:00:10Z',
    );
    const history = parseEvidence(
      JSON.parse(JSON.stringify(mergeHistory(first.evidence, later.evidence))),
      connection,
    );
    expect(history.deployments).toHaveLength(4);
    expect(
      history.deployments.every((row) => row.observedAt === new Date(observedAt).toISOString()),
    ).toBe(true);
    const after = capture(
      history,
      connection.exposurePolicyReference,
      '2026-10-10T08:00:11Z',
      '2026-10-10T08:00:11.000002Z',
    );
    expect(after.result).toMatchObject({ qualifyingCount: 3, deploymentFrequency: { count: 2 } });
    expect(JSON.stringify(saved.snapshot)).toBe(original);
    expect(Object.isFrozen(saved.snapshot)).toBe(true);
    expect(mergeHistory(history, first.evidence)).toEqual(history);
  });
  it('does not turn a complete empty REST traversal into complete metric coverage', async () => {
    const collected = await collect([]);
    expect(collected.batch.transportComplete).toBe(true);
    expect(capture(collected.evidence).result).toMatchObject({
      deploymentCount: 0,
      qualifyingCount: 0,
      deploymentFrequency: { count: 0, status: 'provisional', deploymentsPerDay: null },
      coverage: {
        collectionComplete: false,
        deploymentHistoryComplete: false,
        recoveryEvidenceComplete: false,
      },
    });
  });
});
