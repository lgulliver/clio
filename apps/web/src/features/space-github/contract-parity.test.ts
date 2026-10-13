// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, expectTypeOf, it } from 'vitest';
import { parsePullCheckpoint } from '../../../../../packages/adapters/src/github-pulls-checkpoint.ts';
import type { PullCheckpoint } from '../../../../../packages/adapters/src/github-pulls-contract.ts';
import { calculateSignals } from '../../../../api/src/features/space-github/calculate.ts';
import type * as Server from '../../../../api/src/features/space-github/contract.ts';
import type { OperationResult } from '../../../../api/src/features/space-github/contract.ts';
import type * as Browser from './api';
import { parseOperationResult } from './api';

it.runIf(process.env.CLIO_TEST_DATABASE_URL)(
  'persists actual REST acquisition through the worker into browser-safe results',
  async () => {
    const database = process.env.CLIO_TEST_DATABASE_URL;
    if (!database) throw new Error('CLIO_TEST_DATABASE_URL required');
    const { createPool } = await import('../../../../api/src/db/pool.ts');
    const { loadMigrations, migrate } = await import('../../../../api/src/db/migrations.ts');
    const { createIdentityRepository } = await import(
      '../../../../api/src/features/identity/repository.ts'
    );
    const { createOrganizationRepository } = await import(
      '../../../../api/src/features/organization/repository.ts'
    );
    const { spaceConfig } = await import('../../../../api/src/features/space-github/config.ts');
    const { createSpaceGitHubRepository } = await import(
      '../../../../api/src/features/space-github/repository.ts'
    );
    const { processOneSpaceGitHub } = await import(
      '../../../../api/src/features/space-github/worker.ts'
    );
    const { collectGitHubPullSlice } = await import(
      '../../../../../packages/adapters/src/github-pulls-collect.ts'
    );
    const schema = `clio_test_${randomUUID().replaceAll('-', '')}`;
    const admin = createPool(database);
    const scoped = new URL(database);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    const pool = createPool(scoped.href);
    let created = false;
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      const migrations = await loadMigrations(
        pathToFileURL(`${resolve(process.cwd(), '../api/migrations')}/`),
      );
      await migrate(pool, migrations);
      const actor = { userId: randomUUID(), sessionId: randomUUID() };
      await pool.query(
        "INSERT INTO auth_users(id,name,email,email_verified) VALUES($1,'Fixture','worker-parity@example.com',true)",
        [actor.userId],
      );
      await pool.query(
        "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
        [actor.sessionId, actor.userId, randomUUID()],
      );
      const workspace = await createIdentityRepository(pool).createWorkspace(actor, 'Fixture');
      const team = await createOrganizationRepository(pool).createTeam(actor, workspace.id, 'Team');
      const config = spaceConfig({
        appId: 12,
        privateKey: 'fixture-only',
        grants: [
          {
            workspaceId: workspace.id,
            installationId: 34,
            accountId: 56,
            accountType: 'Organization',
            repositoryIds: [123],
            fingerprint: 'f'.repeat(64),
          },
        ],
      });
      const base = 'https://api.github.com/repos/owner/repo/pulls';
      const repository = {
        id: 123,
        name: 'repo',
        full_name: 'owner/repo',
        owner: { login: 'owner' },
      };
      const pulls = [3, 2, 1].map((number) => ({
        id: number,
        number,
        url: `${base}/${number}`,
        base: { repo: repository },
        user: { id: 100 + number, type: 'User', login: 'private-author' },
        created_at: '2026-09-02T09:00:00Z',
        merged_at: '2026-09-02T14:00:00Z',
        title: 'private-title',
        body: 'private-body',
      }));
      const fetched: string[] = [];
      const provider = {
        verify: async () => ({
          accountLogin: 'owner',
          repositoryName: 'repo',
          token: 'fixture-only-token',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
        collect: (input: Parameters<typeof collectGitHubPullSlice>[0]) =>
          collectGitHubPullSlice({
            ...input,
            fetch: async (url) => {
              const path = new URL(url).pathname;
              fetched.push(path);
              if (path.endsWith('/pulls')) return Response.json(pulls);
              for (const pull of pulls) {
                if (path.endsWith(`/pulls/${pull.number}`)) return Response.json(pull);
                if (path.endsWith(`/pulls/${pull.number}/reviews`))
                  return Response.json([
                    {
                      id: 200 + pull.number,
                      pull_request_url: pull.url,
                      user: { id: 300 + pull.number, type: 'User', login: 'private-reviewer' },
                      state: 'APPROVED',
                      submitted_at: '2026-09-02T10:00:00Z',
                      body: 'private-review-body',
                    },
                  ]);
              }
              throw new Error('Unexpected fixture request');
            },
          }),
      };
      const api = createSpaceGitHubRepository(pool, config, { provider });
      const mapping = await api.save(actor, workspace.id, {
        teamId: team.id,
        installationId: 34,
        repositoryId: 123,
      });
      const run = await api.enqueue(actor, workspace.id, mapping.id, {
        revision: mapping.revision,
        requestId: randomUUID(),
        windowStart: '2026-09-01T00:00:00.000Z',
        windowEnd: '2026-09-15T00:00:00.000Z',
      });
      expect(await processOneSpaceGitHub(pool, config, { provider })).toBe(true);
      const completed = await api.getRun(actor, workspace.id, mapping.id, run.id);
      expect(completed.state).toBe('succeeded');
      if (!completed.resultId) throw new Error('Missing saved result');
      const result = await api.getResult(actor, workspace.id, completed.resultId);
      const serialized: unknown = JSON.parse(JSON.stringify({ result }));
      const parsed = parseOperationResult(serialized, {
        workspaceId: workspace.id,
        mappingId: mapping.id,
        resultId: completed.resultId,
      });
      expect(parsed.calculated.signals.map((signal) => signal.value)).toEqual([3, 3, 3, 1, 5]);
      expect(parsed.calculated.signals.every((signal) => signal.status === 'provisional')).toBe(
        true,
      );
      expect(fetched).toHaveLength(7);
      const evidence = await pool.query('SELECT evidence FROM space_github_results WHERE id=$1', [
        completed.resultId,
      ]);
      expect(JSON.stringify(evidence.rows)).not.toMatch(
        /private-|fixture-only-token|"user"|"login"/,
      );
      expect(JSON.stringify(serialized)).not.toMatch(/evidence|checkpoint|fingerprint|private-/);
    } finally {
      await pool.end();
      if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
  20000,
);

const ids = {
  workspaceId: '00000000-0000-0000-0000-000000000001',
  mappingId: '00000000-0000-0000-0000-000000000002',
  teamId: '00000000-0000-0000-0000-000000000003',
  resultId: '00000000-0000-0000-0000-000000000004',
  runId: '00000000-0000-0000-0000-000000000005',
};
function fixture(): OperationResult {
  const window = { windowStart: '2026-09-01T00:00:00.000Z', windowEnd: '2026-09-15T00:00:00.000Z' };
  const checkpoint: PullCheckpoint = {
    version: 1,
    phase: 'ready',
    repositoryId: 123,
    repositoryOwner: 'owner',
    repositoryName: 'repo',
    nextPullPage: null,
    nextReviewIndex: 3,
    nextReviewPage: 1,
    discoveryTraversalComplete: true,
    reviewTraversalComplete: [1, 2, 3],
    gaps: ['invalid_time'],
    pulls: [1, 2, 3].map((id) => ({
      id,
      number: id,
      createdAt: '2026-09-02T09:00:00.000Z',
      mergedAt: '2026-09-02T14:00:00.000Z',
      authorClass: 'human',
      observedAt: '2026-09-16T00:00:00.000Z',
    })),
    reviews: [1, 2, 3].map((id) => ({
      id,
      pullId: id,
      submittedAt: '2026-09-02T10:00:00.000Z',
      state: 'APPROVED',
      authorClass: 'human',
      reviewerClass: 'human',
      actorEligibilityKnown: true,
      isSelfReview: false,
      observedAt: '2026-09-16T00:00:00.000Z',
    })),
  };
  return {
    id: ids.resultId,
    runId: ids.runId,
    workspaceId: ids.workspaceId,
    mappingId: ids.mappingId,
    mappingRevision: 1,
    appId: 12,
    installationId: 34,
    repositoryId: 123,
    repositoryLabel: 'owner/repo',
    teamId: ids.teamId,
    teamName: 'Original team',
    ...window,
    acquisitionStartedAt: '2026-09-16T00:00:00.000Z',
    acquisitionEndedAt: '2026-09-16T00:01:00.000Z',
    completedAt: '2026-09-16T00:02:00.000Z',
    contractVersion: 'clio.space.github.v1',
    calculated: calculateSignals(
      parsePullCheckpoint(
        JSON.parse(
          JSON.stringify({ ...checkpoint, pulls: [...checkpoint.pulls].reverse() }).replaceAll(
            '.000Z',
            'Z',
          ),
        ),
      ),
      window,
    ),
    discoveryTraversalComplete: true,
    reviewTraversalComplete: true,
    gaps: checkpoint.gaps,
  };
}

it('actual server calculation serializes into strict browser result', () => {
  const server = fixture();
  const serialized: unknown = JSON.parse(JSON.stringify({ result: server }));
  const parsed = parseOperationResult(serialized, ids);
  expect(parsed.calculated.signals.map((s) => s.value)).toEqual([3, 3, 3, 1, 5]);
  expect(parsed).toEqual(server);
});
it('rejects mutated calculation version/status/frozen context after serialization', () => {
  const r = fixture();
  for (const result of [
    { ...r, teamId: '00000000-0000-0000-0000-000000000099' },
    { ...r, appId: 99 },
    { ...r, calculated: { ...r.calculated, calculationVersion: 'oems.v1' } },
    {
      ...r,
      calculated: {
        ...r.calculated,
        signals: r.calculated.signals.map((s) => ({ ...s, status: 'complete' })),
      },
    },
  ]) {
    const serialized: unknown = JSON.parse(JSON.stringify({ result }));
    expect(() => parseOperationResult(serialized, { ...ids, appId: 12 })).toThrow();
  }
});

it('keeps safe server and browser types assignable in both directions', () => {
  expectTypeOf<Server.OperationResult>().toExtend<Browser.OperationResult>();
  expectTypeOf<Browser.OperationResult>().toExtend<Server.OperationResult>();
  expectTypeOf<Server.OperationRun>().toExtend<Browser.OperationRun>();
  expectTypeOf<Browser.OperationRun>().toExtend<Server.OperationRun>();
  expectTypeOf<Server.OperationMapping>().toExtend<Browser.OperationMapping>();
  expectTypeOf<Browser.OperationMapping>().toExtend<Server.OperationMapping>();
  expectTypeOf<Server.OperationAvailability>().toExtend<Browser.OperationAvailability>();
  expectTypeOf<Browser.OperationAvailability>().toExtend<Server.OperationAvailability>();
  expectTypeOf<Server.OperationMappingPage>().toExtend<Browser.OperationMappingPage>();
  expectTypeOf<Browser.OperationMappingPage>().toExtend<Server.OperationMappingPage>();
  expectTypeOf<Server.OperationRunPage>().toExtend<Browser.OperationRunPage>();
  expectTypeOf<Browser.OperationRunPage>().toExtend<Server.OperationRunPage>();
  expectTypeOf<Server.OperationResultPage>().toExtend<Browser.OperationResultPage>();
  expectTypeOf<Browser.OperationResultPage>().toExtend<Server.OperationResultPage>();
});
