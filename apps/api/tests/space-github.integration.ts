import { randomUUID } from 'node:crypto';
import {
  AdapterError,
  collectGitHubPullSlice,
  type PullCheckpoint,
  PullSliceError,
} from '@clio/adapters';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrations.ts';
import {
  acquireQuota,
  QuotaUnavailable,
  releaseQuota,
} from '../src/features/github-collection/quota.ts';
import { createIdentityRepository } from '../src/features/identity/repository.ts';
import { createOrganizationRepository } from '../src/features/organization/repository.ts';
import { spaceConfig } from '../src/features/space-github/config.ts';
import { instantMicros } from '../src/features/space-github/input.ts';
import { createSpaceGitHubJobs } from '../src/features/space-github/jobs.ts';
import type { SpaceGitHubProvider } from '../src/features/space-github/provider.ts';
import {
  contextFrom,
  createSpaceGitHubRepository,
} from '../src/features/space-github/repository.ts';
import { parseStoredResult } from '../src/features/space-github/stored-result.ts';
import { processOneSpaceGitHub } from '../src/features/space-github/worker.ts';

if (!process.env.CLIO_TEST_DATABASE_URL) throw new Error('CLIO_TEST_DATABASE_URL required');
const schema = `clio_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({
  connectionString: process.env.CLIO_TEST_DATABASE_URL,
  connectionTimeoutMillis: 3000,
});
const pool = new Pool({
  connectionString: process.env.CLIO_TEST_DATABASE_URL,
  options: `-c search_path=${schema}`,
  connectionTimeoutMillis: 3000,
});
const owner = { userId: 'space-github-owner', sessionId: 'space-github-session' };
let created = false;
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await migrate(pool);
  await pool.query(
    "INSERT INTO auth_users(id,name,email,email_verified) VALUES($1,'Fixture','space-github@example.com',true)",
    [owner.userId],
  );
  await pool.query(
    "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES($1,$2,'fixture-session-token',now()+interval '1 day')",
    [owner.sessionId, owner.userId],
  );
});
afterAll(async () => {
  await pool.end();
  if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});
const window = { windowStart: '2026-01-01T00:00:00.000Z', windowEnd: '2026-01-03T00:00:00.000Z' };
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
const provider: SpaceGitHubProvider = {
  verify: async () => ({
    accountLogin: 'fixture',
    repositoryName: 'repo',
    token: 'transient-token',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  }),
  collect: async () => ({ checkpoint, done: true, activeMillis: 1, requests: 0 }),
};
async function fixture() {
  const w = await createIdentityRepository(pool).createWorkspace(owner, `Fixture ${randomUUID()}`);
  const team = await createOrganizationRepository(pool).createTeam(owner, w.id, 'Team');
  const config = spaceConfig({
    appId: 12,
    privateKey: 'fixture',
    grants: [
      {
        workspaceId: w.id,
        installationId: 10,
        accountId: 30,
        accountType: 'Organization',
        repositoryIds: [20],
        fingerprint: 'f'.repeat(64),
      },
    ],
  });
  const repo = createSpaceGitHubRepository(pool, config, { provider });
  const mapping = await repo.save(owner, w.id, {
    teamId: team.id,
    installationId: 10,
    repositoryId: 20,
  });
  return { w, team, config, repo, mapping };
}
it('replays exact requests, rejects changed bodies and atomically publishes safe immutable evidence', async () => {
  const f = await fixture();
  const request = { ...window, revision: f.mapping.revision, requestId: randomUUID() };
  const run = await f.repo.enqueue(owner, f.w.id, f.mapping.id, request);
  expect(await f.repo.enqueue(owner, f.w.id, f.mapping.id, request)).toEqual(run);
  await expect(
    f.repo.enqueue(owner, f.w.id, f.mapping.id, {
      ...request,
      windowEnd: '2026-01-04T00:00:00.000Z',
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(await processOneSpaceGitHub(pool, f.config, { provider })).toBe(true);
  const saved = await f.repo.getRun(owner, f.w.id, f.mapping.id, run.id);
  expect(saved.state).toBe('succeeded');
  if (!saved.resultId) throw new Error('Result missing');
  const result = await f.repo.getResult(owner, f.w.id, saved.resultId);
  expect(result.calculated.signals.every((s) => s.value === null)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/token|fingerprint|checkpoint|actorId/);
  await expect(
    pool.query(
      'UPDATE space_github_results SET result=result||\'{"teamName":"Changed"}\'::jsonb WHERE id=$1',
      [saved.resultId],
    ),
  ).rejects.toThrow();
});
it('disconnect cancels active work and detaches live team FK while retaining copied context', async () => {
  const f = await fixture();
  const run = await f.repo.enqueue(owner, f.w.id, f.mapping.id, {
    ...window,
    revision: 1,
    requestId: randomUUID(),
  });
  const disconnected = await f.repo.disconnect(owner, f.w.id, f.mapping.id, { revision: 1 });
  expect(disconnected.teamId).toBe(f.team.id);
  expect((await f.repo.getRun(owner, f.w.id, f.mapping.id, run.id)).reason).toBe('disconnected');
  await pool.query('DELETE FROM teams WHERE id=$1', [f.team.id]);
  expect((await f.repo.get(owner, f.w.id, f.mapping.id)).teamName).toBe('Team');
});

it('preserves original team/name after rename and remap; historical filter uses captured ownership', async () => {
  const f = await fixture();
  const run = await f.repo.enqueue(owner, f.w.id, f.mapping.id, {
    ...window,
    revision: 1,
    requestId: randomUUID(),
  });
  await pool.query("UPDATE teams SET name='Renamed' WHERE id=$1", [f.team.id]);
  await processOneSpaceGitHub(pool, f.config, { provider });
  const saved = await f.repo.getRun(owner, f.w.id, f.mapping.id, run.id);
  expect(saved.teamName).toBe('Team');
  expect(saved.state).toBe('succeeded');
  const next = await createOrganizationRepository(pool).createTeam(owner, f.w.id, 'Other');
  await f.repo.update(owner, f.w.id, f.mapping.id, { revision: 1, teamId: next.id });
  const list = await f.repo.list(owner, f.w.id, { teamId: f.team.id });
  expect(list.mappings[0]?.teamId).toBe(next.id);
  const history = await f.repo.history(owner, f.w.id, f.mapping.id, { teamId: f.team.id });
  expect('runs' in history && history.runs[0]?.teamName).toBe('Team');
  const results = await f.repo.results(owner, f.w.id, f.mapping.id, { teamId: f.team.id });
  expect('results' in results && results.results[0]?.teamId).toBe(f.team.id);
});
it('cannot delete connected team; member reads are scoped and owner writes require current role', async () => {
  const f = await fixture();
  await expect(pool.query('DELETE FROM teams WHERE id=$1', [f.team.id])).rejects.toThrow();
  await pool.query(
    "UPDATE workspace_memberships SET role='member' WHERE workspace_id=$1 AND user_id=$2",
    [f.w.id, owner.userId],
  );
  expect((await f.repo.get(owner, f.w.id, f.mapping.id)).id).toBe(f.mapping.id);
  expect(await f.repo.availability(owner, f.w.id)).toEqual({ workspaceId: f.w.id, enabled: true });
  await expect(
    f.repo.disconnect(owner, f.w.id, f.mapping.id, { revision: 1 }),
  ).rejects.toMatchObject({ status: 403 });
  const other = await fixture();
  await expect(other.repo.get(owner, other.w.id, f.mapping.id)).rejects.toMatchObject({
    status: 404,
  });
});
it('rechecks owner authorization after external verification before saving', async () => {
  const f = await fixture();
  await f.repo.disconnect(owner, f.w.id, f.mapping.id, { revision: 1 });
  const raced = createSpaceGitHubRepository(pool, f.config, {
    provider: {
      ...provider,
      verify: async () => {
        await pool.query(
          "UPDATE workspace_memberships SET role='member' WHERE workspace_id=$1 AND user_id=$2",
          [f.w.id, owner.userId],
        );
        return provider.verify({
          config: f.config,
          grant:
            f.config.grants[0] ??
            (() => {
              throw new Error('Grant missing');
            })(),
          repositoryId: 20,
          clock: () => new Date(),
          signal: AbortSignal.timeout(1000),
        });
      },
    },
  });
  await expect(
    raced.save(owner, f.w.id, { teamId: f.team.id, installationId: 10, repositoryId: 20 }),
  ).rejects.toMatchObject({ status: 403 });
  expect((await f.repo.get(owner, f.w.id, f.mapping.id)).connected).toBe(false);
});
it('fences a disconnect during verification and never publishes revoked result', async () => {
  const f = await fixture();
  const run = await f.repo.enqueue(owner, f.w.id, f.mapping.id, {
    ...window,
    revision: 1,
    requestId: randomUUID(),
  });
  await processOneSpaceGitHub(pool, f.config, {
    provider: {
      ...provider,
      verify: async (input) => {
        await f.repo.disconnect(owner, f.w.id, f.mapping.id, { revision: 1 });
        return provider.verify(input);
      },
    },
  });
  const saved = await f.repo.getRun(owner, f.w.id, f.mapping.id, run.id);
  expect(saved.state).toBe('cancelled');
  expect(saved.resultId).toBeNull();
});
it('cancels queued jobs after grant removal without HTTP', async () => {
  const f = await fixture();
  const run = await f.repo.enqueue(owner, f.w.id, f.mapping.id, {
    ...window,
    revision: 1,
    requestId: randomUUID(),
  });
  await processOneSpaceGitHub(pool, null, { provider });
  expect((await f.repo.getRun(owner, f.w.id, f.mapping.id, run.id)).reason).toBe('grant_removed');
});
it('turns malformed stored windows and checkpoints into safe worker failure', async () => {
  const f = await fixture();
  const run = await f.repo.enqueue(owner, f.w.id, f.mapping.id, {
    ...window,
    revision: 1,
    requestId: randomUUID(),
  });
  await pool.query('UPDATE space_github_jobs SET checkpoint=\'{"version":1}\' WHERE id=$1', [
    run.id,
  ]);
  await processOneSpaceGitHub(pool, f.config, { provider });
  expect((await f.repo.getRun(owner, f.w.id, f.mapping.id, run.id)).reason).toBe(
    'invalid_provider_data',
  );
});
it('bounds real retryable failures and persists spent acquisition on failure', async () => {
  const f = await fixture();
  const run = await f.repo.enqueue(owner, f.w.id, f.mapping.id, {
    ...window,
    revision: 1,
    requestId: randomUUID(),
  });
  const failing: SpaceGitHubProvider = {
    ...provider,
    collect: async () => {
      throw new AdapterError('transport_failed');
    },
  };
  for (let i = 0; i < 3; i++) {
    await processOneSpaceGitHub(pool, f.config, { provider: failing });
    if (i < 2)
      await pool.query('UPDATE space_github_jobs SET available_at=clock_timestamp() WHERE id=$1', [
        run.id,
      ]);
  }
  const saved = await f.repo.getRun(owner, f.w.id, f.mapping.id, run.id);
  expect(saved.reason).toBe('retry_exhausted');
  const rows = await pool.query(
    'SELECT active_millis,failures FROM space_github_jobs WHERE id=$1',
    [run.id],
  );
  expect(rows.rows[0].active_millis).toBeGreaterThan(0);
  expect(rows.rows[0].failures).toBe(3);
});
it('refunds quota contention without consuming failures and isolates App cooldowns', async () => {
  const f = await fixture();
  const run = await f.repo.enqueue(owner, f.w.id, f.mapping.id, {
    ...window,
    revision: 1,
    requestId: randomUUID(),
  });
  const held = await acquireQuota(pool, 12, 10);
  try {
    await processOneSpaceGitHub(pool, f.config, { provider });
    const rows = await pool.query(
      'SELECT state,failures,active_millis FROM space_github_jobs WHERE id=$1',
      [run.id],
    );
    expect(rows.rows[0].state).toBe('queued');
    expect(rows.rows[0].failures).toBe(0);
    expect(rows.rows[0].active_millis).toBeGreaterThan(0);
    await pool.query(
      "UPDATE github_quota_state SET blocked_until=clock_timestamp()+interval '1 hour' WHERE app_id=12 AND installation_id=0",
    );
    const separate = await acquireQuota(pool, 13, 10);
    await releaseQuota(pool, separate);
    await expect(acquireQuota(pool, 12, 11)).rejects.toBeInstanceOf(QuotaUnavailable);
  } finally {
    await releaseQuota(pool, held);
    await pool.query("UPDATE github_quota_state SET blocked_until='-infinity' WHERE app_id=12");
  }
});
it('allows one concurrent claim and rejects completion from expired lease', async () => {
  const f = await fixture();
  await f.repo.enqueue(owner, f.w.id, f.mapping.id, {
    ...window,
    revision: 1,
    requestId: randomUUID(),
  });
  const jobs = createSpaceGitHubJobs(pool, () => f.config),
    claims = await Promise.all([jobs.claim(), jobs.claim()]);
  const claim = claims.find((c) => c !== null);
  expect(claims.filter(Boolean)).toHaveLength(1);
  if (!claim) throw new Error('Claim missing');
  await pool.query(
    "UPDATE space_github_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [claim.id],
  );
  expect(
    await jobs.finish(claim, {
      checkpoint,
      activeMillis: 1,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      done: true,
    }),
  ).toBe(false);
  const recovered = await jobs.claim();
  expect(recovered?.id).toBe(claim.id);
  if (recovered)
    await jobs.finish(recovered, {
      checkpoint,
      activeMillis: 1,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      done: false,
      failure: 'provider_unavailable',
    });
});
it('expires old jobs even during provider cooldown', async () => {
  const f = await fixture();
  const context = {
    workspaceId: f.w.id,
    mappingId: f.mapping.id,
    mappingRevision: 1,
    teamId: f.team.id,
    teamName: 'Team',
    appId: 12,
    installationId: 10,
    repositoryId: 20,
    repositoryLabel: 'fixture/repo',
    ...window,
  };
  const id = randomUUID();
  await pool.query(
    "INSERT INTO space_github_jobs(id,workspace_id,mapping_id,request_id,context,grant_fingerprint,queued_at,expires_at,available_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()-interval '25 hours',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 day')",
    [
      id,
      f.w.id,
      f.mapping.id,
      randomUUID(),
      JSON.stringify(context),
      f.config.grants[0]?.fingerprint,
    ],
  );
  await processOneSpaceGitHub(pool, f.config, { provider });
  expect((await f.repo.getRun(owner, f.w.id, f.mapping.id, id)).reason).toBe('expired');
});
it('retains accepted checkpoint on retry and resumes without persisting private actor/token fields', async () => {
  const f = await fixture();
  const run = await f.repo.enqueue(owner, f.w.id, f.mapping.id, {
    ...window,
    revision: 1,
    requestId: randomUUID(),
  });
  const partial: PullCheckpoint = {
    ...checkpoint,
    phase: 'discovery',
    nextPullPage: 2,
    discoveryTraversalComplete: false,
  };
  await processOneSpaceGitHub(pool, f.config, {
    provider: {
      ...provider,
      collect: async () => {
        throw new PullSliceError('transport_failed', partial);
      },
    },
  });
  const rows = await pool.query('SELECT checkpoint FROM space_github_jobs WHERE id=$1', [run.id]);
  expect(rows.rows[0].checkpoint).toEqual(partial);
  expect(JSON.stringify(rows.rows[0].checkpoint)).not.toMatch(/token|user|login|actorId/);
  await pool.query('UPDATE space_github_jobs SET available_at=clock_timestamp() WHERE id=$1', [
    run.id,
  ]);
  await processOneSpaceGitHub(pool, f.config, {
    provider: {
      ...provider,
      collect: async (input) => {
        expect(input.checkpoint).toEqual(partial);
        return { checkpoint, done: true, activeMillis: 0, requests: 0 };
      },
    },
  });
  expect((await f.repo.getRun(owner, f.w.id, f.mapping.id, run.id)).state).toBe('succeeded');
});
it('bounds history to 25, binds cursor to filter, and filters before limit', async () => {
  const f = await fixture();
  const other = await createOrganizationRepository(pool).createTeam(owner, f.w.id, 'Other');
  for (let i = 0; i < 26; i++) {
    const run = await f.repo.enqueue(owner, f.w.id, f.mapping.id, {
      ...window,
      revision: 1,
      requestId: randomUUID(),
    });
    await processOneSpaceGitHub(pool, f.config, { provider });
    expect((await f.repo.getRun(owner, f.w.id, f.mapping.id, run.id)).state).toBe('succeeded');
  }
  const first = await f.repo.history(owner, f.w.id, f.mapping.id, { teamId: f.team.id });
  expect('runs' in first && first.runs).toHaveLength(25);
  expect(first.nextCursor).not.toBeNull();
  const second = await f.repo.history(owner, f.w.id, f.mapping.id, {
    teamId: f.team.id,
    cursor: first.nextCursor,
  });
  expect('runs' in second && second.runs).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  await expect(
    f.repo.history(owner, f.w.id, f.mapping.id, { teamId: other.id, cursor: first.nextCursor }),
  ).rejects.toMatchObject({ status: 400 });
  expect((await f.repo.list(owner, f.w.id, { teamId: other.id })).mappings).toEqual([]);
});
it('re-fetches deleted author on a resumed review slice; person IDs never enter evidence', async () => {
  const f = await fixture();
  const run = await f.repo.enqueue(owner, f.w.id, f.mapping.id, {
    ...window,
    revision: 1,
    requestId: randomUUID(),
  });
  const partial: PullCheckpoint = {
    ...checkpoint,
    phase: 'reviews',
    nextReviewIndex: 0,
    nextReviewPage: 1,
    pulls: [
      {
        id: 101,
        number: 1,
        createdAt: '2026-01-01T10:00:00Z',
        mergedAt: '2026-01-02T10:00:00Z',
        authorClass: 'human',
        observedAt: '2026-01-04T00:00:00Z',
      },
    ],
  };
  await pool.query('UPDATE space_github_jobs SET checkpoint=$2 WHERE id=$1', [
    run.id,
    JSON.stringify(partial),
  ]);
  const fetched: string[] = [];
  await processOneSpaceGitHub(pool, f.config, {
    provider: {
      ...provider,
      collect: (input) =>
        collectGitHubPullSlice({
          ...input,
          fetch: async (url) => {
            fetched.push(new URL(url).pathname);
            if (new URL(url).pathname.endsWith('/reviews'))
              return Response.json([
                {
                  id: 201,
                  pull_request_url: 'https://api.github.com/repos/fixture/repo/pulls/1',
                  user: { id: 888999, type: 'User', login: 'private-person' },
                  state: 'APPROVED',
                  submitted_at: '2026-01-02T09:00:00Z',
                },
              ]);
            return Response.json({
              id: 101,
              number: 1,
              url: 'https://api.github.com/repos/fixture/repo/pulls/1',
              base: {
                repo: {
                  id: 20,
                  name: 'repo',
                  full_name: 'fixture/repo',
                  owner: { login: 'fixture' },
                },
              },
              created_at: '2026-01-01T10:00:00Z',
              merged_at: '2026-01-02T10:00:00Z',
              user: null,
            });
          },
        }),
    },
  });
  expect(fetched).toEqual(['/repos/fixture/repo/pulls/1', '/repos/fixture/repo/pulls/1/reviews']);
  const saved = await f.repo.getRun(owner, f.w.id, f.mapping.id, run.id);
  if (!saved.resultId) throw new Error('Missing result');
  const rows = await pool.query('SELECT evidence FROM space_github_results WHERE id=$1', [
    saved.resultId,
  ]);
  expect(rows.rows[0].evidence.pulls[0].authorClass).toBe('unknown');
  expect(JSON.stringify(rows.rows[0].evidence)).not.toMatch(/888999|private-person|login|user/);
  const result = await f.repo.getResult(owner, f.w.id, saved.resultId);
  expect(result.gaps).toContain('unknown_actor');
  expect(result.calculated.signals.find((s) => s.id === 'open_to_merge')?.sampleCount).toBe(0);
});
it('rejects repository rename or transfer during resumed acquisition without combining populations', async () => {
  const f = await fixture();
  const run = await f.repo.enqueue(owner, f.w.id, f.mapping.id, {
    ...window,
    revision: 1,
    requestId: randomUUID(),
  });
  await pool.query('UPDATE space_github_jobs SET checkpoint=$2 WHERE id=$1', [
    run.id,
    JSON.stringify({
      ...checkpoint,
      phase: 'discovery',
      nextPullPage: 2,
      discoveryTraversalComplete: false,
    }),
  ]);
  await processOneSpaceGitHub(pool, f.config, {
    provider: {
      ...provider,
      verify: async () => ({
        accountLogin: 'transferred',
        repositoryName: 'renamed',
        token: 'transient',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    },
  });
  const saved = await f.repo.getRun(owner, f.w.id, f.mapping.id, run.id);
  expect(saved.reason).toBe('invalid_provider_data');
  expect(saved.resultId).toBeNull();
});
it('enforces composite scope, active-job uniqueness, byte bounds and immutable captured context', async () => {
  const f = await fixture(),
    other = await fixture();
  await expect(
    pool.query('UPDATE space_github_mappings SET team_id=$2,live_team_id=$2 WHERE id=$1', [
      f.mapping.id,
      other.team.id,
    ]),
  ).rejects.toThrow();
  const run = await f.repo.enqueue(owner, f.w.id, f.mapping.id, {
    ...window,
    revision: 1,
    requestId: randomUUID(),
  });
  await expect(
    pool.query(
      'UPDATE space_github_jobs SET context=context||\'{"teamName":"Changed"}\'::jsonb WHERE id=$1',
      [run.id],
    ),
  ).rejects.toThrow();
  await expect(
    pool.query(
      "UPDATE space_github_jobs SET checkpoint=jsonb_build_object('payload',repeat('x',16777217)) WHERE id=$1",
      [run.id],
    ),
  ).rejects.toThrow();
  await expect(
    f.repo.enqueue(owner, f.w.id, f.mapping.id, {
      ...window,
      revision: 1,
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ status: 409 });
  await f.repo.disconnect(owner, f.w.id, f.mapping.id, { revision: 1 });
});
it('caps total active time and keeps duration independent of incomplete review traversal', async () => {
  const f = await fixture();
  const run = await f.repo.enqueue(owner, f.w.id, f.mapping.id, {
    ...window,
    revision: 1,
    requestId: randomUUID(),
  });
  const limited: PullCheckpoint = {
    ...checkpoint,
    nextReviewIndex: 0,
    gaps: ['active_time_limit'],
    pulls: [103, 102, 101].map((id) => ({
      id,
      number: id,
      createdAt: '2026-01-01T10:00:00Z',
      mergedAt: '2026-01-02T10:00:00Z',
      authorClass: 'human',
      observedAt: '2026-01-04T00:00:00Z',
    })),
  };
  await processOneSpaceGitHub(pool, f.config, {
    provider: {
      ...provider,
      collect: async () => ({ checkpoint: limited, done: true, activeMillis: 1, requests: 0 }),
    },
  });
  const saved = await f.repo.getRun(owner, f.w.id, f.mapping.id, run.id);
  if (!saved.resultId) throw new Error('Missing result');
  const result = await f.repo.getResult(owner, f.w.id, saved.resultId);
  expect(result.calculated.signals.find((s) => s.id === 'open_to_first_review')?.value).toBeNull();
  expect(result.calculated.signals.find((s) => s.id === 'open_to_merge')?.value).toBe(24);
  await expect(
    pool.query('UPDATE space_github_jobs SET active_millis=1800001 WHERE id=$1', [run.id]),
  ).rejects.toThrow();
});
it('maps malformed persisted window to invalid_provider_data without an HTTP request error', async () => {
  const f = await fixture();
  const run = await f.repo.enqueue(owner, f.w.id, f.mapping.id, {
    ...window,
    revision: 1,
    requestId: randomUUID(),
  });
  const rows = await pool.query(
    'SELECT context,grant_fingerprint FROM space_github_jobs WHERE id=$1',
    [run.id],
  );
  await pool.query('DELETE FROM space_github_jobs WHERE id=$1', [run.id]);
  const context = { ...rows.rows[0].context, windowEnd: '2026-02-30T00:00:00.000Z' };
  await pool.query(
    'INSERT INTO space_github_jobs(id,workspace_id,mapping_id,request_id,context,grant_fingerprint) VALUES($1,$2,$3,$4,$5,$6)',
    [
      run.id,
      f.w.id,
      f.mapping.id,
      randomUUID(),
      JSON.stringify(context),
      rows.rows[0].grant_fingerprint,
    ],
  );
  await expect(processOneSpaceGitHub(pool, f.config, { provider })).resolves.toBe(false);
  const failed = await pool.query('SELECT state,reason FROM space_github_jobs WHERE id=$1', [
    run.id,
  ]);
  expect(failed.rows[0]).toEqual({ state: 'failed', reason: 'invalid_provider_data' });
});
it('fences current grant replacement after verification while retaining spent active time', async () => {
  const f = await fixture();
  const run = await f.repo.enqueue(owner, f.w.id, f.mapping.id, {
    ...window,
    revision: 1,
    requestId: randomUUID(),
  });
  let current: typeof f.config | null = f.config;
  await processOneSpaceGitHub(pool, f.config, {
    configNow: () => current,
    provider: {
      ...provider,
      verify: async (input) => {
        const scope = await provider.verify(input);
        current = null;
        return scope;
      },
    },
  });
  expect((await f.repo.getRun(owner, f.w.id, f.mapping.id, run.id)).reason).toBe('grant_removed');
  const rows = await pool.query('SELECT active_millis FROM space_github_jobs WHERE id=$1', [
    run.id,
  ]);
  expect(rows.rows[0].active_millis).toBeGreaterThan(0);
});

it('disconnect replays previous/current revision unchanged and fences replay after reconnect', async () => {
  const f = await fixture();
  const disconnected = await f.repo.disconnect(owner, f.w.id, f.mapping.id, { revision: 1 });
  expect(await f.repo.disconnect(owner, f.w.id, f.mapping.id, { revision: 1 })).toEqual(
    disconnected,
  );
  expect(
    await f.repo.disconnect(owner, f.w.id, f.mapping.id, { revision: disconnected.revision }),
  ).toEqual(disconnected);
  const connected = await f.repo.save(owner, f.w.id, {
    teamId: f.team.id,
    installationId: 10,
    repositoryId: 20,
  });
  expect(connected.revision).toBe(disconnected.revision + 1);
  await expect(
    f.repo.disconnect(owner, f.w.id, f.mapping.id, { revision: disconnected.revision }),
  ).rejects.toMatchObject({ status: 409 });
  expect((await f.repo.get(owner, f.w.id, f.mapping.id)).connected).toBe(true);
});
it('reassignment rejects changed grant fingerprint until explicit reconnect verification', async () => {
  const f = await fixture();
  const other = await createOrganizationRepository(pool).createTeam(owner, f.w.id, 'Other');
  const changed = spaceConfig({
    ...f.config,
    grants: f.config.grants.map((g) => ({ ...g, repositoryIds: [20, 21] })),
  });
  const repo = createSpaceGitHubRepository(pool, changed, { provider });
  await expect(
    repo.update(owner, f.w.id, f.mapping.id, { revision: 1, teamId: other.id }),
  ).rejects.toMatchObject({ status: 409 });
  expect((await f.repo.get(owner, f.w.id, f.mapping.id)).teamId).toBe(f.team.id);
});
it('rejects null terminal state and null connected team guards', async () => {
  const f = await fixture();
  await expect(
    pool.query('UPDATE space_github_mappings SET live_team_id=NULL WHERE id=$1', [f.mapping.id]),
  ).rejects.toThrow();
  const run = await f.repo.enqueue(owner, f.w.id, f.mapping.id, {
    ...window,
    revision: 1,
    requestId: randomUUID(),
  });
  for (const [state, reason, completed] of [
    ['failed', null, new Date()],
    ['failed', 'provider_unavailable', null],
    ['cancelled', null, new Date()],
  ]) {
    await expect(
      pool.query('UPDATE space_github_jobs SET state=$2,reason=$3,completed_at=$4 WHERE id=$1', [
        run.id,
        state,
        reason,
        completed,
      ]),
    ).rejects.toThrow();
  }
  await f.repo.disconnect(owner, f.w.id, f.mapping.id, { revision: 1 });
});

it('publishes retained progress when actual worker aborts in App pacing at total active cap', async () => {
  const f = await fixture();
  const run = await f.repo.enqueue(owner, f.w.id, f.mapping.id, {
    ...window,
    revision: 1,
    requestId: randomUUID(),
  });
  const retained: PullCheckpoint = {
    ...checkpoint,
    phase: 'reviews',
    pulls: [103, 102, 101].map((id) => ({
      id,
      number: id,
      createdAt: '2026-01-01T10:00:00Z',
      mergedAt: '2026-01-02T10:00:00Z',
      authorClass: 'human',
      observedAt: '2026-01-04T00:00:00Z',
    })),
  };
  await pool.query('UPDATE space_github_jobs SET checkpoint=$2,active_millis=1799970 WHERE id=$1', [
    run.id,
    JSON.stringify(retained),
  ]);
  const lease = await acquireQuota(pool, 12, 10);
  await releaseQuota(pool, lease);
  await pool.query(
    "UPDATE github_quota_state SET next_request_at=clock_timestamp()+interval '2 seconds' WHERE app_id=12 AND installation_id=0",
  );
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('Unexpected network request');
  });
  try {
    await processOneSpaceGitHub(pool, f.config, {
      provider: { ...provider, collect: collectGitHubPullSlice },
    });
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
    await pool.query(
      'UPDATE github_quota_state SET next_request_at=clock_timestamp() WHERE app_id=12 AND installation_id=0',
    );
  }
  const saved = await f.repo.getRun(owner, f.w.id, f.mapping.id, run.id);
  expect(saved.state).toBe('succeeded');
  if (!saved.resultId) throw new Error('Missing capped result');
  const result = await f.repo.getResult(owner, f.w.id, saved.resultId);
  expect(result.gaps).toEqual(['active_time_limit']);
  expect(result.reviewTraversalComplete).toBe(false);
  expect(result.calculated.signals.find((s) => s.id === 'pulls_opened')?.value).toBe(3);
  expect(result.calculated.signals.find((s) => s.id === 'open_to_merge')?.value).toBe(24);
  expect(result.calculated.signals.find((s) => s.id === 'open_to_first_review')?.value).toBeNull();
  const retainedState = (
    await pool.query<{ active_millis: number; checkpoint: unknown }>(
      'SELECT active_millis,checkpoint FROM space_github_jobs WHERE id=$1',
      [run.id],
    )
  ).rows[0];
  expect(retainedState).toMatchObject({
    checkpoint: { phase: 'ready', pulls: retained.pulls },
  });
  // Millisecond timer quantization can stop just before the boundary.
  expect(retainedState?.active_millis).toBeGreaterThanOrEqual(1800000 - 2);
  expect(retainedState?.active_millis).toBeLessThanOrEqual(1800000);
});
it('expired running leases spend conservative budget and publish accepted progress at cap', async () => {
  const f = await fixture();
  const run = await f.repo.enqueue(owner, f.w.id, f.mapping.id, {
    ...window,
    revision: 1,
    requestId: randomUUID(),
  });
  const partial: PullCheckpoint = {
    ...checkpoint,
    phase: 'discovery',
    nextPullPage: 2,
    discoveryTraversalComplete: false,
  };
  await pool.query('UPDATE space_github_jobs SET checkpoint=$2,active_millis=1700000 WHERE id=$1', [
    run.id,
    JSON.stringify(partial),
  ]);
  const jobs = createSpaceGitHubJobs(pool, () => f.config);
  expect(await jobs.claim()).not.toBeNull();
  await pool.query(
    "UPDATE space_github_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [run.id],
  );
  let called = false;
  await processOneSpaceGitHub(pool, f.config, {
    provider: {
      ...provider,
      verify: async (input) => {
        called = true;
        return provider.verify(input);
      },
    },
  });
  expect(called).toBe(false);
  const saved = await f.repo.getRun(owner, f.w.id, f.mapping.id, run.id);
  expect(saved.state).toBe('succeeded');
  if (!saved.resultId) throw new Error('Missing recovered result');
  expect((await f.repo.getResult(owner, f.w.id, saved.resultId)).gaps).toContain(
    'active_time_limit',
  );
  expect(
    (await pool.query('SELECT active_millis FROM space_github_jobs WHERE id=$1', [run.id])).rows[0]
      .active_millis,
  ).toBe(1800000);
});
it('two operational jobs on same App/installation contend through shared durable quota', async () => {
  const first = await fixture(),
    second = await fixture();
  const config = spaceConfig({
    ...first.config,
    grants: [...first.config.grants, ...second.config.grants],
  });
  const a = await first.repo.enqueue(owner, first.w.id, first.mapping.id, {
    ...window,
    revision: 1,
    requestId: randomUUID(),
  });
  const b = await second.repo.enqueue(owner, second.w.id, second.mapping.id, {
    ...window,
    revision: 1,
    requestId: randomUUID(),
  });
  let release = () => {},
    entered = () => {};
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const work = processOneSpaceGitHub(pool, config, {
    provider: {
      ...provider,
      verify: async (input) => {
        entered();
        await held;
        return provider.verify(input);
      },
    },
  });
  try {
    await started;
    await processOneSpaceGitHub(pool, config, { provider });
    const contended = await pool.query(
      'SELECT state,failures,active_millis FROM space_github_jobs WHERE id=$1',
      [b.id],
    );
    expect(contended.rows[0]).toMatchObject({ state: 'queued', failures: 0 });
    expect(contended.rows[0].active_millis).toBeGreaterThan(0);
  } finally {
    release();
    await work;
  }
  expect((await first.repo.getRun(owner, first.w.id, first.mapping.id, a.id)).state).toBe(
    'succeeded',
  );
  await pool.query('UPDATE space_github_jobs SET available_at=clock_timestamp() WHERE id=$1', [
    b.id,
  ]);
  await processOneSpaceGitHub(pool, config, { provider });
  expect((await second.repo.getRun(owner, second.w.id, second.mapping.id, b.id)).state).toBe(
    'succeeded',
  );
});
it.each(['2040-01-01T00:00:00Z', '1990-01-01T00:00:00Z'])(
  'database acquisition/result stamps survive worker wall skew %s with microsecond run parity',
  async (skew) => {
    const f = await fixture();
    const run = await f.repo.enqueue(owner, f.w.id, f.mapping.id, {
      ...window,
      revision: 1,
      requestId: randomUUID(),
    });
    const queued = (
      await pool.query(
        `SELECT to_char(queued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stamp FROM space_github_jobs WHERE id=$1`,
        [run.id],
      )
    ).rows[0].stamp;
    expect(run.queuedAt).toBe(queued);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(skew));
    try {
      await processOneSpaceGitHub(pool, f.config, { provider });
    } finally {
      vi.useRealTimers();
    }
    const saved = await f.repo.getRun(owner, f.w.id, f.mapping.id, run.id);
    expect(saved.state).toBe('succeeded');
    if (!saved.resultId) throw new Error('Missing skew result');
    const result = await f.repo.getResult(owner, f.w.id, saved.resultId);
    expect(parseStoredResult(result)).toEqual(result);
    expect(saved.completedAt).toBe(result.completedAt);
    expect(instantMicros(result.acquisitionStartedAt)).toBeGreaterThanOrEqual(
      instantMicros(window.windowEnd),
    );
    expect(instantMicros(result.acquisitionEndedAt)).toBeGreaterThanOrEqual(
      instantMicros(result.acquisitionStartedAt),
    );
    expect(instantMicros(result.completedAt)).toBeGreaterThanOrEqual(
      instantMicros(result.acquisitionEndedAt),
    );
    expect(result.completedAt).not.toContain(skew.slice(0, 4));
  },
);
it('corrupt public JSON reads fail with redacted server error without private evidence recalculation', async () => {
  const f = await fixture();
  const run = await f.repo.enqueue(owner, f.w.id, f.mapping.id, {
    ...window,
    revision: 1,
    requestId: randomUUID(),
  });
  const jobs = createSpaceGitHubJobs(pool, () => f.config),
    claim = await jobs.claim();
  if (!claim || claim.id !== run.id) throw new Error('Missing scoped claim');
  const resultId = randomUUID();
  const stamp = (
    await pool.query(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stamp`,
    )
  ).rows[0].stamp;
  const captured = await pool.query<{ context: unknown }>(
    'SELECT context FROM space_github_jobs WHERE id=$1',
    [run.id],
  );
  const corrupted = {
    ...contextFrom(captured.rows[0]?.context),
    id: resultId,
    runId: run.id,
    acquisitionStartedAt: claim.claimedAt,
    acquisitionEndedAt: stamp,
    completedAt: stamp,
    contractVersion: 'clio.space.github.v1',
    calculated: { privateCorruption: 'must never leak' },
    discoveryTraversalComplete: true,
    reviewTraversalComplete: true,
    gaps: [],
  };
  await pool.query(
    'INSERT INTO space_github_results(id,workspace_id,mapping_id,run_id,completed_at,evidence,result) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      resultId,
      f.w.id,
      f.mapping.id,
      run.id,
      stamp,
      JSON.stringify(checkpoint),
      JSON.stringify(corrupted),
    ],
  );
  await expect(
    pool.query(
      "UPDATE space_github_jobs SET state='succeeded',completed_at=NULL,result_id=$2,lease_token=NULL,lease_until=NULL WHERE id=$1",
      [run.id, resultId],
    ),
  ).rejects.toThrow();
  await pool.query(
    "UPDATE space_github_jobs SET state='succeeded',completed_at=$3,result_id=$2,lease_token=NULL,lease_until=NULL WHERE id=$1",
    [run.id, resultId, stamp],
  );
  await expect(f.repo.getResult(owner, f.w.id, resultId)).rejects.toMatchObject({
    status: 500,
    message: 'invalid_stored_data',
  });
  await expect(f.repo.results(owner, f.w.id, f.mapping.id)).rejects.toMatchObject({
    status: 500,
    message: 'invalid_stored_data',
  });
});
it('active cap without any retained checkpoint fails safely without invoking provider', async () => {
  const f = await fixture();
  const run = await f.repo.enqueue(owner, f.w.id, f.mapping.id, {
    ...window,
    revision: 1,
    requestId: randomUUID(),
  });
  await pool.query('UPDATE space_github_jobs SET active_millis=1800000 WHERE id=$1', [run.id]);
  let called = false;
  await processOneSpaceGitHub(pool, f.config, {
    provider: {
      ...provider,
      verify: async (input) => {
        called = true;
        return provider.verify(input);
      },
    },
  });
  expect(called).toBe(false);
  expect(await f.repo.getRun(owner, f.w.id, f.mapping.id, run.id)).toMatchObject({
    state: 'failed',
    reason: 'provider_unavailable',
    resultId: null,
  });
});

it('rejects future DB period despite API wallclock ahead before persisting job', async () => {
  const f = await fixture();
  const clock = await pool.query<{ stamp: string }>(
    "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS stamp",
  );
  const start = new Date(`${clock.rows[0]?.stamp}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 86400000);
  const requestId = randomUUID();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(end.getTime() + 86400000));
  try {
    await expect(
      f.repo.enqueue(owner, f.w.id, f.mapping.id, {
        revision: 1,
        requestId,
        windowStart: start.toISOString(),
        windowEnd: end.toISOString(),
      }),
    ).rejects.toMatchObject({ status: 400, message: 'invalid_request' });
  } finally {
    vi.useRealTimers();
  }
  const jobs = await pool.query('SELECT id FROM space_github_jobs WHERE request_id=$1', [
    requestId,
  ]);
  expect(jobs.rowCount).toBe(0);
});
it.each(['workspaceId', 'mappingId'])(
  'SQL rejects absent or null context %s identity',
  async (key) => {
    const f = await fixture();
    const run = await f.repo.enqueue(owner, f.w.id, f.mapping.id, {
      ...window,
      revision: 1,
      requestId: randomUUID(),
    });
    const rows = await pool.query<{ context: Record<string, unknown>; grant_fingerprint: string }>(
      'SELECT context,grant_fingerprint FROM space_github_jobs WHERE id=$1',
      [run.id],
    );
    const row = rows.rows[0];
    if (!row) throw new Error('Missing job');
    await pool.query('DELETE FROM space_github_jobs WHERE id=$1', [run.id]);
    const missing = { ...row.context };
    delete missing[key];
    for (const context of [missing, { ...row.context, [key]: null }]) {
      await expect(
        pool.query(
          'INSERT INTO space_github_jobs(id,workspace_id,mapping_id,request_id,context,grant_fingerprint) VALUES($1,$2,$3,$4,$5,$6)',
          [
            randomUUID(),
            f.w.id,
            f.mapping.id,
            randomUUID(),
            JSON.stringify(context),
            row.grant_fingerprint,
          ],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
  },
);
