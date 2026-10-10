import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseUrl } from '../src/config.ts';
import { checkReadiness, loadMigrations, migrate } from '../src/db/migrations.ts';
import { createMappingRepository } from '../src/features/deployment-mappings/repository.ts';
import { createAuth, readSession } from '../src/features/identity/auth.ts';
import { readAuthConfig } from '../src/features/identity/config.ts';
import { createIdentityRepository } from '../src/features/identity/repository.ts';
import { createServer } from '../src/server.ts';

vi.mock('../src/features/identity/auth.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/features/identity/auth.ts')>();
  return { ...original, readSession: vi.fn() };
});
if (!process.env.CLIO_TEST_DATABASE_URL)
  throw new Error('CLIO_TEST_DATABASE_URL is required for PostgreSQL integration tests');
const connectionString = databaseUrl(process.env.CLIO_TEST_DATABASE_URL);
const schema = `clio_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString, connectionTimeoutMillis: 3000 });
const pool = new Pool({
  connectionString,
  options: `-c search_path=${schema}`,
  connectionTimeoutMillis: 3000,
  statement_timeout: 10000,
});
const identities = createIdentityRepository(pool);
const mappings = createMappingRepository(pool);
const migrations = await loadMigrations();
const owner = { userId: 'mapping-owner', sessionId: 'mapping-owner-session' };
const member = { userId: 'mapping-member', sessionId: 'mapping-member-session' };
const outsider = { userId: 'mapping-outsider', sessionId: 'mapping-outsider-session' };
let server: FastifyInstance;
let created = false;
let workspaceId: string;
let serviceId: string;
const origin = 'http://localhost:5173';
const settings = {
  expectedRevision: null,
  primaryProvider: 'github',
  productionEnvironment: 'production',
  exposureAttested: true,
};
function url(suffix: string) {
  return `/api/workspaces/${workspaceId}/services/${serviceId}/${suffix}`;
}
function session(actor = owner) {
  const now = new Date();
  vi.mocked(readSession).mockResolvedValue({
    headers: new Headers({ 'set-cookie': 'renewed=fixture; HttpOnly' }),
    response: {
      user: {
        id: actor.userId,
        name: 'Fixture',
        email: `${actor.userId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
        image: null,
      },
      session: {
        id: actor.sessionId,
        userId: actor.userId,
        token: 'fictional-token',
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: now,
        updatedAt: now,
        ipAddress: null,
        userAgent: null,
      },
    },
  });
}
function post(
  suffix: string,
  payload: Record<string, unknown>,
  trustedOrigin: string | undefined = origin,
) {
  return server.inject({
    method: 'POST',
    url: url(suffix),
    headers: trustedOrigin ? { origin: trustedOrigin } : {},
    payload,
  });
}
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await migrate(pool, migrations);
  for (const actor of [owner, member, outsider]) {
    await pool.query(
      'INSERT INTO auth_users (id, name, email, email_verified) VALUES ($1, $1, $2, true)',
      [actor.userId, `${actor.userId}@example.com`],
    );
    await pool.query(
      "INSERT INTO auth_sessions (id, user_id, token, expires_at) VALUES ($1, $2, $1, now() + interval '1 day')",
      [actor.sessionId, actor.userId],
    );
  }
  const workspace = await identities.createWorkspace(owner, 'Mapping workspace');
  workspaceId = workspace.id;
  const service = await identities.createService(owner, workspaceId, 'Scoped backend');
  serviceId = service.id;
  await pool.query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
    [workspaceId, member.userId],
  );
  const config = readAuthConfig({
    AUTH_SECRET: 'fictional-mapping-test-secret-long-enough',
    AUTH_BASE_URL: 'http://localhost:3000',
    APP_ORIGIN: origin,
    GITHUB_CLIENT_ID: 'fixture',
    GITHUB_CLIENT_SECRET: 'fixture',
  });
  if (!config) throw new Error('Missing fixture configuration');
  server = createServer(
    { ready: async () => {}, close: async () => {} },
    { auth: createAuth(pool, config), config, pool },
  );
  session();
});
afterAll(async () => {
  if (server) await server.close();
  await pool.end();
  try {
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await admin.end();
  }
});
describe('transactional mapping HTTP/storage', () => {
  it('reads unset, rejects unset preview, persists revision and returns renewal/no-store', async () => {
    const unset = await server.inject(url('deployment-mapping'));
    expect(unset.statusCode).toBe(200);
    expect(unset.json()).toEqual({ mapping: null });
    expect((await post('deployment-preview', { revision: 1 })).statusCode).toBe(404);
    const saved = await post('deployment-mapping', {
      ...settings,
      productionEnvironment: '\uFEFF production\t',
    });
    expect(saved.statusCode).toBe(200);
    const observed = await pool.query<{ observation: string }>(
      `SELECT to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observation FROM deployment_mapping_revisions WHERE workspace_id = $1 AND service_id = $2 AND revision = 1`,
      [workspaceId, serviceId],
    );
    expect(saved.json().mapping.observedAt).toBe(observed.rows[0]?.observation);

    expect(saved.json()).toMatchObject({
      mapping: {
        mode: 'mock',
        revision: 1,
        productionEnvironment: 'production',
        workspaceId,
        serviceId,
      },
    });
    expect(saved.headers['cache-control']).toBe('no-store');
    expect(saved.headers['set-cookie']).toContain('renewed=fixture; HttpOnly');
    expect(await createMappingRepository(pool).get(owner, workspaceId, serviceId)).toEqual(
      saved.json().mapping,
    );
    const stored = await pool.query('SELECT created_by FROM deployment_mapping_revisions');
    expect(stored.rows).toEqual([{ created_by: owner.userId }]);
  });
  it('serializes concurrent saves and preserves immutable history', async () => {
    const results = await Promise.all([
      post('deployment-mapping', { ...settings, expectedRevision: 1 }),
      post('deployment-mapping', { ...settings, expectedRevision: 1, primaryProvider: 'argocd' }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const freshService = await identities.createService(
      owner,
      workspaceId,
      'Concurrent initial mapping',
    );
    const creates = await Promise.allSettled([
      mappings.save(owner, workspaceId, freshService.id, settings),
      mappings.save(owner, workspaceId, freshService.id, settings),
    ]);
    expect(creates.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = creates.find((result) => result.status === 'rejected');
    if (rejected?.status !== 'rejected') throw new Error('Expected creation conflict');
    expect(rejected.reason).toMatchObject({ status: 409 });
    expect((await post('deployment-mapping', settings)).statusCode).toBe(409);
    expect(
      (await post('deployment-mapping', { ...settings, expectedRevision: 1 })).statusCode,
    ).toBe(409);
    expect((await post('deployment-preview', { revision: 1 })).statusCode).toBe(409);
    expect(
      (
        await pool.query(
          'SELECT revision FROM deployment_mapping_revisions WHERE service_id = $1 ORDER BY revision',
          [serviceId],
        )
      ).rows,
    ).toEqual([{ revision: '1' }, { revision: '2' }]);
    for (const command of [
      'UPDATE deployment_mapping_revisions SET exposure_attested = false',
      'DELETE FROM deployment_mapping_revisions',
    ])
      await expect(pool.query(command)).rejects.toThrow('immutable');
  });
  it('permits members read/preview but denies writes, outsiders and wrong service scope', async () => {
    session(member);
    expect((await server.inject(url('deployment-mapping'))).statusCode).toBe(200);
    expect((await post('deployment-preview', { revision: 2 })).statusCode).toBe(200);
    expect(
      (await post('deployment-mapping', { ...settings, expectedRevision: 2 })).statusCode,
    ).toBe(403);
    session(outsider);
    for (const response of [
      await server.inject(url('deployment-mapping')),
      await post('deployment-preview', { revision: 2 }),
      await post('deployment-mapping', { ...settings, expectedRevision: 2 }),
    ])
      expect(response.statusCode).toBe(404);
    session();
    const other = await identities.createWorkspace(owner, 'Other workspace');
    expect(
      (await server.inject(`/api/workspaces/${other.id}/services/${serviceId}/deployment-mapping`))
        .statusCode,
    ).toBe(404);
    await expect(
      pool.query(
        `INSERT INTO deployment_mapping_revisions (workspace_id, service_id, mode, revision, primary_provider, production_environment, exposure_attested, created_by)
       VALUES ($1,$2,'mock',1,'github','production',true,$3)`,
        [other.id, serviceId, owner.userId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(mappings.get(owner, workspaceId, randomUUID())).rejects.toMatchObject({
      status: 404,
    });
  });
  it('runs both previews with consent and unmatched environment quality', async () => {
    let revision = 2;
    for (const primaryProvider of ['github', 'argocd']) {
      for (const selection of [
        { productionEnvironment: 'production', exposureAttested: true },
        { productionEnvironment: 'production', exposureAttested: false },
        { productionEnvironment: 'staging', exposureAttested: true },
      ]) {
        const save = await post('deployment-mapping', {
          ...settings,
          expectedRevision: revision,
          primaryProvider,
          ...selection,
        });
        expect(save.statusCode).toBe(200);
        revision++;
        const response = await post('deployment-preview', { revision });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          preview: {
            workspaceId,
            serviceId,
            mappingRevision: revision,
            mode: 'mock',
            qualification:
              selection.exposureAttested && selection.productionEnvironment === 'production'
                ? 'qualifying'
                : 'unknown',
            rolloutCount: 1,
            coverage: {
              collectionComplete: false,
              deploymentHistoryComplete: false,
              recoveryEvidenceComplete: false,
            },
            deploymentFrequency: { status: 'provisional', deploymentsPerDay: null },
            changeFailureRate: null,
            failedDeploymentRecoveryTime: null,
          },
        });
        const latest = await mappings.get(owner, workspaceId, serviceId);
        if (!latest) throw new Error('Missing mapping');
        const cutoff: string = response.json().preview.evidenceCutoff;
        const preciseCutoff = cutoff.replace(
          /\.(\d+)Z$/,
          (_match: string, fraction: string) => `.${fraction.padEnd(6, '0')}Z`,
        );
        expect(preciseCutoff >= latest.observedAt).toBe(true);
        expect(Date.parse(cutoff) - Date.parse(latest.observedAt)).toBeLessThanOrEqual(1);
        expect(response.body).not.toContain('sourceRef');
        expect(response.body).not.toContain('mock-config-revision');
      }
    }
  });
  it('rejects untrusted Origin/unknown bodies and redacts dependency errors', async () => {
    for (const suffix of ['deployment-mapping', 'deployment-preview']) {
      for (const badOrigin of ['', 'https://evil.example'])
        expect((await post(suffix, settings, badOrigin)).statusCode).toBe(403);
      const response = await post(suffix, { ...settings, token: 'private-payload' });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain('private-payload');
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(
      (
        await post('deployment-mapping', {
          primaryProvider: 'github',
          productionEnvironment: 'production',
          exposureAttested: true,
        })
      ).statusCode,
    ).toBe(409);
    expect((await post('deployment-preview', { revision: '8' })).statusCode).toBe(400);
    vi.mocked(readSession).mockRejectedValueOnce(new Error('private SQL credential payload'));
    const response = await server.inject(url('deployment-mapping'));
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'unavailable' });
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('revalidates session revocation, expiry and membership despite accepted transport session', async () => {
    session(member);
    await identities.revokeMember(owner, workspaceId, member.userId);
    expect((await server.inject(url('deployment-mapping'))).statusCode).toBe(404);
    session(outsider);
    await pool.query(
      "UPDATE auth_sessions SET expires_at = now() - interval '1 second' WHERE id = $1",
      [outsider.sessionId],
    );
    expect((await server.inject(url('deployment-mapping'))).statusCode).toBe(401);
    await pool.query('DELETE FROM auth_sessions WHERE id = $1', [member.sessionId]);
    session(member);
    expect((await post('deployment-preview', { revision: 8 })).statusCode).toBe(401);
    session();
  });
  it('preserves safe revisions beyond int32 and rejects overflow without a write', async () => {
    const service = await identities.createService(owner, workspaceId, 'Large revision fixture');
    const insert = `INSERT INTO deployment_mapping_revisions (workspace_id, service_id, mode, revision, primary_provider, production_environment, exposure_attested, created_by) VALUES ($1,$2,'mock',$3,'github','production',false,$4)`;
    await pool.query(insert, [workspaceId, service.id, 2147483647, owner.userId]);
    const saved = await mappings.save(owner, workspaceId, service.id, {
      ...settings,
      expectedRevision: 2147483647,
    });
    expect(saved.revision).toBe(2147483648);
    await pool.query(insert, [workspaceId, service.id, Number.MAX_SAFE_INTEGER, owner.userId]);
    await expect(
      mappings.save(owner, workspaceId, service.id, {
        ...settings,
        expectedRevision: Number.MAX_SAFE_INTEGER,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      pool.query(insert, [workspaceId, service.id, '9007199254740992', owner.userId]),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('enforces scope, actor, revision, mode and environment constraints and readiness', async () => {
    const insert = `INSERT INTO deployment_mapping_revisions (workspace_id, service_id, mode, revision, primary_provider, production_environment, exposure_attested, created_by) VALUES ($1,$2,$3,$4,$5,$6,true,$7)`;
    const valid = [workspaceId, serviceId, 'mock', 100, 'github', 'production', owner.userId];
    for (const [index, invalid, code] of [
      [0, randomUUID(), '23503'],
      [6, 'absent-user', '23503'],
      [2, 'live', '23514'],
      [3, 0, '23514'],
      [4, 'other', '23514'],
      [5, ' padded ', '23514'],
      [5, '', '23514'],
      [5, '😀'.repeat(201), '23514'],
    ] as const) {
      const values = [...valid];
      values[index] = invalid;
      await expect(pool.query(insert, values)).rejects.toMatchObject({ code });
    }
    await expect(checkReadiness(pool, migrations)).resolves.toBeUndefined();
    await pool.query(
      'ALTER TABLE deployment_mapping_revisions RENAME COLUMN observed_at TO missing_observed_at',
    );
    await expect(checkReadiness(pool, migrations)).rejects.toThrow();
    await pool.query(
      'ALTER TABLE deployment_mapping_revisions RENAME COLUMN missing_observed_at TO observed_at',
    );
  });
});
