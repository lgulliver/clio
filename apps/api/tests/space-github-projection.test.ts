import type { PullCheckpoint } from '@clio/adapters';
import { Client, Pool } from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { calculateSignals } from '../src/features/space-github/calculate.ts';
import { contractVersion } from '../src/features/space-github/contract.ts';
import { createSpaceGitHubRepository } from '../src/features/space-github/repository.ts';

const id = '00000000-0000-4000-8000-000000000001';
const context = {
  workspaceId: id,
  mappingId: id,
  mappingRevision: 1,
  teamId: id,
  teamName: 'Team',
  appId: 12,
  installationId: 10,
  repositoryId: 20,
  repositoryLabel: 'fixture/repo',
  windowStart: '2026-01-01T00:00:00.000Z',
  windowEnd: '2026-01-03T00:00:00.000Z',
};
const checkpoint: PullCheckpoint = {
  version: 1,
  phase: 'ready',
  repositoryId: 20,
  repositoryOwner: 'fixture',
  repositoryName: 'repo',
  nextPullPage: null,
  nextReviewIndex: 0,
  nextReviewPage: 1,
  pulls: [],
  reviews: [],
  reviewTraversalComplete: [],
  discoveryTraversalComplete: true,
  gaps: [],
};
const stamp = '2026-01-04T00:00:00.000123Z';
const result = {
  ...context,
  id,
  runId: id,
  acquisitionStartedAt: stamp,
  acquisitionEndedAt: stamp,
  completedAt: stamp,
  contractVersion,
  calculated: calculateSignals(checkpoint, {
    windowStart: context.windowStart,
    windowEnd: context.windowEnd,
  }),
  discoveryTraversalComplete: true,
  reviewTraversalComplete: true,
  gaps: [],
};
const mapping = {
  id,
  workspace_id: id,
  team_id: id,
  team_name: 'Team',
  app_id: 12,
  installation_id: 10,
  repository_id: 20,
  repository_label: 'fixture/repo',
  revision: 1,
  connected: true,
};
const run = {
  id,
  context,
  state: 'succeeded',
  queued_at: stamp,
  completed_at: stamp,
  reason: null,
  result_id: id,
};
const resultRow = {
  id,
  workspace_id: id,
  mapping_id: id,
  run_id: id,
  result,
  context,
  acquisition_started_at: stamp,
  acquisition_ended_at: stamp,
  completed_at: stamp,
};
afterEach(() => vi.restoreAllMocks());
it.each(['mapping', 'list', 'run', 'history', 'result', 'results', 'replay'])(
  'public %s SQL never projects private payloads or wildcard rows',
  async (kind) => {
    const pool = new Pool();
    const client = Object.assign(new Client(), { release: vi.fn() });
    const query = vi.spyOn(client, 'query');
    const response = (rows: Record<string, unknown>[]) => ({
      rows,
      rowCount: rows.length,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });
    // Real repository/auth transaction flow; only PostgreSQL I/O is substituted.
    const responses = [
      response([]),
      response([{ email: 'fixture@example.com', email_verified: true }]),
      response([{ id }]),
      response([{ role: 'owner' }]),
    ];
    if (kind === 'replay') responses.push(response([{ queued_at: stamp }]));
    if (kind === 'history' || kind === 'results' || kind === 'replay')
      responses.push(response([mapping]));
    const row =
      kind === 'run' || kind === 'history' || kind === 'replay'
        ? run
        : kind === 'result' || kind === 'results'
          ? resultRow
          : mapping;
    responses.push(response([row]), response([]));
    query.mockImplementation(() => Promise.resolve(responses.shift() ?? response([])));
    vi.spyOn(pool, 'connect').mockImplementation(() => Promise.resolve(client));
    const repo = createSpaceGitHubRepository(pool, null),
      actor = { userId: 'fixture', sessionId: 'fixture' };
    if (kind === 'mapping') expect(await repo.get(actor, id, id)).toMatchObject({ id });
    if (kind === 'list') expect((await repo.list(actor, id)).mappings).toHaveLength(1);
    if (kind === 'run') expect((await repo.getRun(actor, id, id, id)).completedAt).toBe(stamp);
    if (kind === 'history')
      expect(await repo.history(actor, id, id)).toMatchObject({
        runs: [expect.objectContaining({ completedAt: stamp })],
      });
    if (kind === 'result') expect(await repo.getResult(actor, id, id)).toEqual(result);
    if (kind === 'results')
      expect(await repo.results(actor, id, id)).toMatchObject({ results: [result] });
    if (kind === 'replay')
      expect(
        await repo.enqueue(actor, id, id, {
          revision: 1,
          requestId: id,
          windowStart: context.windowStart,
          windowEnd: context.windowEnd,
        }),
      ).toMatchObject({ id });
    const sql = query.mock.calls
      .map(([value]) => (typeof value === 'string' ? value : ''))
      .filter((s) => s.includes('FROM space_github_'));
    expect(sql.length).toBeGreaterThan(0);
    for (const statement of sql) {
      const projection = statement.slice(0, statement.indexOf(' FROM '));
      expect(projection).not.toMatch(/\*|\b(?:evidence|checkpoint|lease_token|lease_until)\b/);
      if (kind !== 'replay') expect(projection).not.toContain('grant_fingerprint');
    }
  },
);

it('rejects API-wallclock future window using authorized database cutoff before insert', async () => {
  const pool = new Pool();
  const client = Object.assign(new Client(), { release: vi.fn() });
  const response = (rows: Record<string, unknown>[]) => ({
    rows,
    rowCount: rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [],
  });
  const responses = [
    response([]),
    response([{ email: 'fixture@example.com', email_verified: true }]),
    response([{ id }]),
    response([{ role: 'owner' }]),
    response([{ queued_at: '2026-01-02T23:59:59.999999Z' }]),
  ];
  const query = vi
    .spyOn(client, 'query')
    .mockImplementation(() => Promise.resolve(responses.shift() ?? response([])));
  vi.spyOn(pool, 'connect').mockImplementation(() => Promise.resolve(client));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-04T00:00:00Z'));
  try {
    await expect(
      createSpaceGitHubRepository(pool, null).enqueue(
        { userId: 'fixture', sessionId: 'fixture' },
        id,
        id,
        {
          revision: 1,
          requestId: id,
          windowStart: context.windowStart,
          windowEnd: context.windowEnd,
        },
      ),
    ).rejects.toMatchObject({ status: 400, message: 'invalid_request' });
    const statements = query.mock.calls.map(([sql]) => (typeof sql === 'string' ? sql : ''));
    expect(statements.some((sql) => sql.includes('clock_timestamp()'))).toBe(true);
    expect(statements.some((sql) => sql.includes('INSERT INTO space_github_jobs'))).toBe(false);
    expect(statements.at(-1)).toBe('ROLLBACK');
  } finally {
    vi.useRealTimers();
  }
});
