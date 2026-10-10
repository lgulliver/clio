import { generateKeyPairSync, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { checkReadiness, loadMigrations, migrate } from '../src/db/migrations.ts';
import { digest } from '../src/features/argo-collection/config.ts';
import { registerArgoIngress } from '../src/features/argo-collection/ingress.ts';
import { consumeIngressToken } from '../src/features/argo-collection/rate-limit.ts';
import { createGitHubProvider } from '../src/features/github-collection/provider.ts';
import {
  acquireQuota,
  checkQuota,
  observeQuota,
  paceQuota,
  pauseQuota,
  releaseQuota,
  retryDelay,
} from '../src/features/github-collection/quota.ts';
import { grantFixture } from './argo-fixture.ts';

if (!process.env.CLIO_TEST_DATABASE_URL) throw new Error('CLIO_TEST_DATABASE_URL required');
const connectionString = process.env.CLIO_TEST_DATABASE_URL;
const schema = `clio_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString });
const options = { connectionString, options: `-c search_path=${schema}`, statement_timeout: 10000 };
const pool = new Pool(options),
  replica = new Pool(options);
let created = false;
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await migrate(pool, await loadMigrations());
});
afterAll(async () => {
  await Promise.all([pool.end(), replica.end()]);
  if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});
it('serializes an installation across pools and keeps other installations eligible', async () => {
  const held = await acquireQuota(pool, 1, 10);
  await expect(acquireQuota(replica, 1, 10)).rejects.toThrow('quota unavailable');
  const other = await acquireQuota(replica, 1, 11);
  await releaseQuota(pool, held);
  const next = await acquireQuota(replica, 1, 10);
  await releaseQuota(pool, held); // Stale release cannot unlock replacement owner.
  await checkQuota(pool, next);
  await Promise.all([releaseQuota(pool, next), releaseQuota(pool, other)]);
});
it('recovers crashed leases and rejects the expired acquisition token', async () => {
  const old = await acquireQuota(pool, 2, 10);
  await pool.query(
    "UPDATE github_quota_state SET lease_until=clock_timestamp()-interval '1 second' WHERE app_id=2 AND installation_id=10",
  );
  const next = await acquireQuota(replica, 2, 10);
  await expect(checkQuota(pool, old)).rejects.toThrow('quota unavailable');
  await releaseQuota(pool, old);
  await checkQuota(pool, next);
  await releaseQuota(pool, next);
});
it('persists long pauses across release and replica acquisition without shortening them', async () => {
  const lease = await acquireQuota(pool, 3, 10);
  expect(await pauseQuota(pool, lease, 9999)).toBeGreaterThanOrEqual(9999);
  await pauseQuota(replica, lease, 60);
  await releaseQuota(pool, lease);
  await expect(acquireQuota(replica, 3, 10)).rejects.toThrow('quota unavailable');
  const row = await pool.query<Record<string, unknown>>(
    'SELECT extract(epoch FROM blocked_until-clock_timestamp())::float AS seconds FROM github_quota_state WHERE app_id=3 AND installation_id=10',
  );
  expect(Number(row.rows[0]?.seconds)).toBeGreaterThan(9998);
  const other = await acquireQuota(pool, 3, 11);
  await releaseQuota(pool, other);
});
it('backs off repeated headerless throttles and pauses all installations for App responses', async () => {
  const lease = await acquireQuota(pool, 4, 10);
  expect(await pauseQuota(pool, lease, null, true)).toBeGreaterThanOrEqual(60);
  expect(await pauseQuota(pool, lease, null, true)).toBeGreaterThanOrEqual(120);
  await expect(acquireQuota(replica, 4, 11)).rejects.toThrow('quota unavailable');
  await releaseQuota(pool, lease);
  expect(retryDelay(9999, 3)).toBeGreaterThanOrEqual(9999);
});
it('observes exhausted successful responses before another outbound request', async () => {
  const lease = await acquireQuota(pool, 5, 10);
  await observeQuota(
    pool,
    lease,
    new Response('[]', {
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1200),
      },
    }),
    false,
  );
  await expect(checkQuota(replica, lease)).rejects.toThrow('quota unavailable');
  await releaseQuota(pool, lease);
});
it('connection verification respects persisted cooldown before attempting signing or network', async () => {
  const lease = await acquireQuota(pool, 6, 10);
  await pauseQuota(pool, lease, 600);
  await releaseQuota(pool, lease);
  const config = { appId: 6, privateKey: 'fixture-invalid-key', grants: [] };
  const provider = createGitHubProvider(replica, config);
  await expect(
    provider.verify({
      config,
      grant: {
        workspaceId: randomUUID(),
        installationId: 10,
        accountId: 1,
        accountType: 'User',
        repositoryIds: [20],
        fingerprint: 'a'.repeat(64),
      },
      repositoryId: 20,
      clock: () => new Date(),
      signal: AbortSignal.timeout(1000),
    }),
  ).rejects.toThrow('quota unavailable');
});
it('paces requests across independent installations and aborts waiting without keeping a DB transaction', async () => {
  const first = await acquireQuota(pool, 7, 10),
    second = await acquireQuota(replica, 7, 11);
  await paceQuota(pool, first);
  const abort = new AbortController();
  abort.abort();
  await expect(paceQuota(replica, second, abort.signal)).rejects.toThrow();
  const state = await pool.query<Record<string, unknown>>(
    'SELECT next_request_at>clock_timestamp() AS paced FROM github_quota_state WHERE app_id=7 AND installation_id=0',
  );
  expect(state.rows[0]?.paced).toBe(true);
  await Promise.all([releaseQuota(pool, first), releaseQuota(pool, second)]);
});
it('shares exactly one Argo burst across concurrent replicas, refills, and survives pool replacement', async () => {
  const sourceId = randomUUID();
  await pool.query(
    "INSERT INTO argo_ingress_buckets(source_id,tokens,refilled_at) VALUES($1,10,clock_timestamp()+interval '30 seconds')",
    [sourceId],
  );
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => consumeIngressToken(i % 2 ? pool : replica, sourceId)),
  );
  expect(results.filter(Boolean)).toHaveLength(10);
  const restarted = new Pool(options);
  try {
    expect(await consumeIngressToken(restarted, sourceId)).toBe(false);
  } finally {
    await restarted.end();
  }
  expect(await consumeIngressToken(replica, sourceId)).toBe(false);
  await pool.query(
    "UPDATE argo_ingress_buckets SET refilled_at=clock_timestamp()-interval '2 seconds' WHERE source_id=$1",
    [sourceId],
  );
  expect(await consumeIngressToken(replica, sourceId)).toBe(true);
  expect(await consumeIngressToken(pool, sourceId)).toBe(false);
  expect(await consumeIngressToken(pool, randomUUID())).toBe(true);
});
it('limits authenticated malformed Argo requests before JSON across two servers and grant rotation', async () => {
  const scope = grantFixture(),
    token = 'a'.repeat(64);
  const grant = { ...scope, tokenDigest: digest(token), fingerprint: 'b'.repeat(64) };
  await pool.query(
    "INSERT INTO argo_ingress_buckets(source_id,tokens,refilled_at) VALUES($1,10,clock_timestamp()+interval '30 seconds')",
    [scope.sourceId],
  );
  const one = Fastify(),
    two = Fastify();
  registerArgoIngress(one, { pool, argo: { grants: [grant] } });
  registerArgoIngress(two, {
    pool: replica,
    argo: { grants: [{ ...grant, fingerprint: 'c'.repeat(64) }] },
  });
  const post = (server: typeof one, authorization = `Bearer ${token}`) =>
    server.inject({
      method: 'POST',
      url: `/api/argo/sources/${scope.sourceId}/operations`,
      headers: { authorization, 'content-type': 'application/json' },
      payload: '{',
    });
  try {
    expect((await post(one, 'Bearer invalid')).statusCode).toBe(401);
    for (let i = 0; i < 10; i++) expect((await post(i % 2 ? one : two)).statusCode).toBe(400);
    const rejected = await post(two);
    expect(rejected.statusCode).toBe(503);
    expect(rejected.headers['retry-after']).toBe('2');
    expect(rejected.json()).toEqual({ error: 'unavailable' });
  } finally {
    await Promise.all([one.close(), two.close()]);
  }
});
it('readiness verifies durable limiter columns', async () => {
  await checkReadiness(pool, await loadMigrations());
  await pool.query('ALTER TABLE github_quota_state RENAME COLUMN next_request_at TO removed');
  await expect(checkReadiness(pool, await loadMigrations())).rejects.toThrow();
  await pool.query('ALTER TABLE github_quota_state RENAME COLUMN removed TO next_request_at');
});

it('persists throttling from the real production verification transport before returning its error', async () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const config = { appId: 8, privateKey, grants: [] };
  const provider = createGitHubProvider(pool, config);
  const grant = {
    workspaceId: randomUUID(),
    installationId: 10,
    accountId: 1,
    accountType: 'User' as const,
    repositoryIds: [20],
    fingerprint: 'a'.repeat(64),
  };
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response('{"message":"You have exceeded a secondary rate limit."}', { status: 403 }),
    );
  try {
    await expect(
      provider.verify({
        config,
        grant,
        repositoryId: 20,
        clock: () => new Date(),
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow('rate_limited');
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(
      provider.verify({
        config,
        grant: { ...grant, installationId: 11 },
        repositoryId: 20,
        clock: () => new Date(),
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow('quota unavailable');
    expect(fetch).toHaveBeenCalledTimes(1);
    const row = await pool.query<Record<string, unknown>>(
      'SELECT extract(epoch FROM blocked_until-clock_timestamp())::float AS wait FROM github_quota_state WHERE app_id=8 AND installation_id=0',
    );
    expect(Number(row.rows[0]?.wait)).toBeGreaterThanOrEqual(59);
  } finally {
    fetch.mockRestore();
  }
});

it('honors primary reset as an absolute DB deadline even when relative delay is short', async () => {
  const lease = await acquireQuota(pool, 9, 10);
  const time = await pool.query<Record<string, unknown>>(
    'SELECT floor(extract(epoch FROM clock_timestamp()))::float AS now',
  );
  const reset = Number(time.rows[0]?.now) + 9999;
  expect(await pauseQuota(pool, lease, 60, false, reset)).toBeGreaterThanOrEqual(9999);
  await releaseQuota(pool, lease);
  await expect(acquireQuota(replica, 9, 10)).rejects.toThrow('quota unavailable');
});

it('late throttle evidence can extend a cooldown without incrementing a stale lease counter', async () => {
  const old = await acquireQuota(pool, 10, 10);
  await releaseQuota(pool, old);
  const current = await acquireQuota(replica, 10, 10);
  await pauseQuota(pool, old, 600);
  const row = await pool.query<Record<string, unknown>>(
    'SELECT consecutive_throttles,lease_token FROM github_quota_state WHERE app_id=10 AND installation_id=10',
  );
  expect(row.rows[0]).toMatchObject({ consecutive_throttles: 0, lease_token: current.token });
  await releaseQuota(pool, current);
});

it('honors Retry-After on transient non-throttle provider errors', async () => {
  const lease = await acquireQuota(pool, 11, 10);
  await observeQuota(
    pool,
    lease,
    new Response('', { status: 503, headers: { 'retry-after': '9999' } }),
    false,
  );
  await releaseQuota(pool, lease);
  await expect(acquireQuota(replica, 11, 10)).rejects.toThrow('quota unavailable');
  const row = await pool.query<Record<string, unknown>>(
    'SELECT extract(epoch FROM blocked_until-clock_timestamp())::float AS wait FROM github_quota_state WHERE app_id=11 AND installation_id=10',
  );
  expect(Number(row.rows[0]?.wait)).toBeGreaterThan(9998);
});
