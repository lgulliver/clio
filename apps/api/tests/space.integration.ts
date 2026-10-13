import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseUrl } from '../src/config.ts';
import { checkReadiness, loadMigrations, migrate } from '../src/db/migrations.ts';
import { type ClioAuth, createAuth } from '../src/features/identity/auth.ts';
import { readAuthConfig } from '../src/features/identity/config.ts';
import { createIdentityRepository } from '../src/features/identity/repository.ts';
import { createOrganizationRepository } from '../src/features/organization/repository.ts';
import { createSpaceRepository } from '../src/features/space/repository.ts';
import { createServer } from '../src/server.ts';

if (!process.env.CLIO_TEST_DATABASE_URL) throw new Error('CLIO_TEST_DATABASE_URL required');
const connectionString = databaseUrl(process.env.CLIO_TEST_DATABASE_URL);
const schema = `clio_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString });
const pool = new Pool({
  connectionString,
  options: `-c search_path=${schema}`,
  statement_timeout: 10000,
});
const repo = createSpaceRepository(pool);
const organization = createOrganizationRepository(pool);
const identity = createIdentityRepository(pool);
const config = readAuthConfig({
  AUTH_SECRET: 'space-fixture-secret-random-only-123456789123456789',
  AUTH_BASE_URL: 'http://localhost:3000',
  APP_ORIGIN: 'http://localhost:5173',
  GITHUB_CLIENT_ID: 'fixture-client',
  GITHUB_CLIENT_SECRET: 'fixture-secret',
});
if (!config) throw new Error('Missing fixture config');
let auth: ClioAuth;
let server: FastifyInstance;
let created = false;
let providerId = 10000;
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Expected record');
  return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected string');
  return value;
}
function cookieHeader(value: string | string[] | undefined) {
  return (typeof value === 'string' ? [value] : (value ?? []))
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}
async function login() {
  const id = String(++providerId);
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://github.com/login/oauth/access_token')
      return Response.json({
        access_token: 'fixture-transient',
        token_type: 'bearer',
        scope: 'read:user,user:email',
      });
    if (url === 'https://api.github.com/user')
      return Response.json({
        id,
        login: `space-${id}`,
        name: `Space ${id}`,
        email: `space-${id}@example.com`,
        avatar_url: null,
      });
    if (url === 'https://api.github.com/user/emails')
      return Response.json([
        { email: `space-${id}@example.com`, primary: true, verified: true, visibility: 'private' },
      ]);
    throw new Error('Unexpected external request');
  });
  const start = await server.inject({
    method: 'POST',
    url: '/api/auth/sign-in/social',
    headers: { origin: 'http://localhost:5173' },
    payload: { provider: 'github', disableRedirect: true },
  });
  expect(start.statusCode).toBe(200);
  const state = new URL(string(record(start.json()).url)).searchParams.get('state');
  const callback = await server.inject({
    url: `/api/auth/callback/github?code=fixture&state=${encodeURIComponent(state ?? '')}`,
    headers: { cookie: cookieHeader(start.headers['set-cookie']) },
  });
  expect(callback.statusCode).toBe(302);
  const cookie = cookieHeader(callback.headers['set-cookie']);
  const current = await auth.api.getSession({ headers: new Headers({ cookie }) });
  if (!current) throw new Error('Fixture session absent');
  return { userId: current.user.id, sessionId: current.session.id, cookie };
}
const answers = {
  satisfaction: null,
  sustainable_workload: null,
  useful_outcomes: null,
  contribution_frequency: null,
  useful_help: null,
  shared_context: null,
  effective_tools: null,
  focus_time: null,
};
const response = (value: number | null) => ({
  instrumentVersion: 'clio.space.pulse.v1',
  answers: { ...answers, satisfaction: value },
});
const period = {
  referenceStart: '2026-09-01T00:00:00.000Z',
  referenceEnd: '2026-09-15T00:00:00.000Z',
};
async function fixture(count = 3) {
  const owner = await login();
  const workspace = await identity.createWorkspace(owner, 'SPACE fixture');
  const team = await organization.createTeam(owner, workspace.id, 'Platform');
  const members = [owner];
  for (let i = 1; i < count; i++) {
    const member = await login();
    await pool.query(
      "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'member')",
      [workspace.id, member.userId],
    );
    members.push(member);
  }
  for (const member of members)
    await repo.assign(owner, workspace.id, member.userId, { teamId: team.id });
  const pulse = await repo.create(owner, workspace.id, { teamId: team.id, ...period });
  return { owner, workspaceId: workspace.id, team, members, pulse };
}
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await migrate(pool);
  auth = createAuth(pool, config);
  server = createServer({ ready: async () => {}, close: async () => {} }, { pool, auth, config });
  await server.ready();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  if (server) await server.close();
  await pool.end();
  if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});

describe('SPACE PostgreSQL confidentiality and lifecycle', () => {
  it('does not invent assignment-clearing history for a never-assigned member', async () => {
    const f = await fixture();
    const member = await login();
    await pool.query(
      "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'member')",
      [f.workspaceId, member.userId],
    );
    await repo.assign(f.owner, f.workspaceId, member.userId, { teamId: null });
    expect((await repo.ownAssignment(member, f.workspaceId, {})).history).toEqual([]);
    await repo.assign(f.owner, f.workspaceId, member.userId, { teamId: f.team.id });
    await repo.assign(f.owner, f.workspaceId, member.userId, { teamId: null });
    expect(
      (await repo.ownAssignment(member, f.workspaceId, {})).history.map((h) => h.teamId),
    ).toEqual([null, f.team.id]);
  });
  it('freezes settings and roster, excludes later assignments, purges raw rows and retains immutable protected results', async () => {
    const f = await fixture();
    const opened = await repo.transition(f.owner, f.workspaceId, f.pulse.id, 'open');
    expect(opened.minimumRespondents).toBe(3);
    expect(opened.rosterSize).toBe(3);
    await repo.preferences(f.owner, f.workspaceId, { minimumRespondents: 4 });
    const late = await login();
    await pool.query(
      "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'member')",
      [f.workspaceId, late.userId],
    );
    await repo.assign(f.owner, f.workspaceId, late.userId, { teamId: f.team.id });
    await expect(repo.submit(late, f.workspaceId, f.pulse.id, response(4))).rejects.toMatchObject({
      status: 403,
    });
    const values = [1, 5, 3];
    for (const [index, member] of f.members.entries())
      await repo.submit(member, f.workspaceId, f.pulse.id, response(values[index] ?? null));
    const member = f.members[1];
    if (!member) throw new Error('Fixture member absent');
    expect((await repo.get(member, f.workspaceId, f.pulse.id)).submittedCount).toBeNull();
    expect((await repo.get(f.owner, f.workspaceId, f.pulse.id)).submittedCount).toBe(3);
    expect((await repo.get(f.owner, f.workspaceId, f.pulse.id)).questions).toBeNull();
    await organization.updateTeam(f.owner, f.workspaceId, f.team.id, 'Renamed');
    const closed = await repo.transition(f.owner, f.workspaceId, f.pulse.id, 'close');
    expect(closed.minimumRespondents).toBe(3);
    expect(closed.teamName).toBe('Platform');
    expect(closed.questions?.[0]).toEqual({
      questionId: 'satisfaction',
      status: 'published',
      mean: 3,
      answeredCount: 3,
    });
    expect(
      closed.questions?.slice(1).every((q) => q.status === 'suppressed' && !('answeredCount' in q)),
    ).toBe(true);
    expect(
      (await pool.query('SELECT * FROM space_answers WHERE pulse_id=$1', [f.pulse.id])).rows,
    ).toEqual([]);
    expect(await repo.transition(f.owner, f.workspaceId, f.pulse.id, 'close')).toEqual(closed);
    expect((await repo.get(member, f.workspaceId, f.pulse.id)).submittedCount).toBe(3);
    await organization.deleteTeam(f.owner, f.workspaceId, f.team.id);
    expect((await repo.get(member, f.workspaceId, f.pulse.id)).teamName).toBe('Platform');
    expect((await repo.ownAssignment(member, f.workspaceId, {})).teamId).toBeNull();
    expect((await repo.ownAssignment(member, f.workspaceId, {})).history[0]?.teamName).toBeNull();
    expect((await repo.list(member, f.workspaceId, { teamId: f.team.id })).pulses[0]?.id).toBe(
      f.pulse.id,
    );
  });
  it('keeps zero and small question cohorts indistinguishable even to owners; hides member participation below minimum', async () => {
    const f = await fixture();
    await repo.transition(f.owner, f.workspaceId, f.pulse.id, 'open');
    await repo.submit(f.owner, f.workspaceId, f.pulse.id, response(1));
    const closed = await repo.transition(f.owner, f.workspaceId, f.pulse.id, 'close');
    expect(closed.submittedCount).toBe(1);
    expect(closed.questions?.[0]).toEqual({
      questionId: 'satisfaction',
      status: 'suppressed',
      mean: null,
    });
    expect(closed.questions?.[1]).toEqual({
      questionId: 'sustainable_workload',
      status: 'suppressed',
      mean: null,
    });
    const member = f.members[1];
    if (!member) throw new Error('No member');
    expect((await repo.get(member, f.workspaceId, f.pulse.id)).submittedCount).toBeNull();
    await pool.query(
      "UPDATE workspace_memberships SET role='member' WHERE workspace_id=$1 AND user_id=$2",
      [f.workspaceId, f.owner.userId],
    );
    expect((await repo.get(f.owner, f.workspaceId, f.pulse.id)).submittedCount).toBeNull();
  });
  it('admits one unlinked response under concurrency and changed-body retries never replace or reveal answers', async () => {
    const f = await fixture();
    await repo.transition(f.owner, f.workspaceId, f.pulse.id, 'open');
    const success = { workspaceId: f.workspaceId, pulseId: f.pulse.id, submitted: true };
    expect(
      await Promise.all([
        repo.submit(f.owner, f.workspaceId, f.pulse.id, response(1)),
        repo.submit(f.owner, f.workspaceId, f.pulse.id, response(5)),
      ]),
    ).toEqual([success, success]);
    const saved = (
      await pool.query('SELECT answers FROM space_answers WHERE pulse_id=$1', [f.pulse.id])
    ).rows;
    expect(saved).toHaveLength(1);
    expect(await repo.submit(f.owner, f.workspaceId, f.pulse.id, response(null))).toEqual(success);
    expect(
      (await pool.query('SELECT answers FROM space_answers WHERE pulse_id=$1', [f.pulse.id])).rows,
    ).toEqual(saved);
    const columns = await pool.query<{ table_name: string; column_name: string }>(
      "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name IN ('space_answers','space_receipts')",
      [schema],
    );
    expect(
      columns.rows
        .filter((r) => r.table_name === 'space_answers')
        .map((r) => r.column_name)
        .sort(),
    ).toEqual(['answers', 'id', 'pulse_id']);
    expect(
      columns.rows
        .filter((r) => r.table_name === 'space_receipts')
        .map((r) => r.column_name)
        .sort(),
    ).toEqual(['pulse_id', 'user_id']);
    await repo.transition(f.owner, f.workspaceId, f.pulse.id, 'close');
    expect(await repo.submit(f.owner, f.workspaceId, f.pulse.id, response(5))).toEqual(success);
  });
  it('serializes close and submit; cancellation purges answers and blocks publication', async () => {
    const f = await fixture();
    await repo.transition(f.owner, f.workspaceId, f.pulse.id, 'open');
    const member = f.members[1];
    if (!member) throw new Error('No member');
    const [submit, close] = await Promise.allSettled([
      repo.submit(member, f.workspaceId, f.pulse.id, response(5)),
      repo.transition(f.owner, f.workspaceId, f.pulse.id, 'close'),
    ]);
    expect(close.status).toBe('fulfilled');
    expect((await repo.get(f.owner, f.workspaceId, f.pulse.id)).submittedCount).toBe(
      submit.status === 'fulfilled' ? 1 : 0,
    );
    if (submit.status === 'rejected') expect(submit.reason).toMatchObject({ status: 409 });
    expect(
      (await pool.query('SELECT * FROM space_answers WHERE pulse_id=$1', [f.pulse.id])).rowCount,
    ).toBe(0);
    const other = await fixture();
    await repo.transition(other.owner, other.workspaceId, other.pulse.id, 'open');
    await repo.submit(other.owner, other.workspaceId, other.pulse.id, response(4));
    const cancelled = await repo.transition(
      other.owner,
      other.workspaceId,
      other.pulse.id,
      'cancel',
    );
    expect(cancelled.questions).toBeNull();
    expect(cancelled.submittedCount).toBeNull();
    expect(cancelled.submitted).toBe(true);
    expect(await repo.submit(other.owner, other.workspaceId, other.pulse.id, response(1))).toEqual({
      workspaceId: other.workspaceId,
      pulseId: other.pulse.id,
      submitted: true,
    });
    expect(
      (await pool.query('SELECT * FROM space_answers WHERE pulse_id=$1', [other.pulse.id]))
        .rowCount,
    ).toBe(0);
    await expect(
      repo.transition(other.owner, other.workspaceId, other.pulse.id, 'close'),
    ).rejects.toMatchObject({ status: 409 });
    expect(await repo.transition(other.owner, other.workspaceId, other.pulse.id, 'cancel')).toEqual(
      cancelled,
    );
  });
  it('revalidates session/membership and uses stable identity on revoke/rejoin and moves', async () => {
    const f = await fixture();
    await repo.transition(f.owner, f.workspaceId, f.pulse.id, 'open');
    const member = f.members[1];
    if (!member) throw new Error('No member');
    const secondTeam = await organization.createTeam(f.owner, f.workspaceId, 'Second');
    await repo.assign(f.owner, f.workspaceId, member.userId, { teamId: secondTeam.id });
    await repo.submit(member, f.workspaceId, f.pulse.id, response(4));
    await identity.revokeMember(f.owner, f.workspaceId, member.userId);
    expect(
      (
        await pool.query('SELECT * FROM space_assignments WHERE workspace_id=$1 AND user_id=$2', [
          f.workspaceId,
          member.userId,
        ])
      ).rowCount,
    ).toBe(0);
    await expect(repo.submit(member, f.workspaceId, f.pulse.id, response(5))).rejects.toMatchObject(
      { status: 404 },
    );
    await expect(repo.get(member, f.workspaceId, f.pulse.id)).rejects.toMatchObject({
      status: 404,
    });
    await pool.query(
      "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'member')",
      [f.workspaceId, member.userId],
    );
    expect((await repo.get(member, f.workspaceId, f.pulse.id)).submitted).toBe(true);
    expect((await repo.get(member, f.workspaceId, f.pulse.id)).eligible).toBe(true);
    expect(await repo.submit(member, f.workspaceId, f.pulse.id, response(1))).toEqual({
      workspaceId: f.workspaceId,
      pulseId: f.pulse.id,
      submitted: true,
    });
    const ownHistory = await repo.ownAssignment(member, f.workspaceId, {});
    expect(ownHistory.teamId).toBeNull();
    expect(ownHistory.history.map((h) => h.teamId)).toEqual([null, secondTeam.id, f.team.id]);
    const formerEmail = (
      await pool.query<{ email: string }>('SELECT email FROM auth_users WHERE id=$1', [
        member.userId,
      ])
    ).rows[0]?.email;
    if (!formerEmail) throw new Error('Former email absent');
    await pool.query('UPDATE auth_users SET email=$1 WHERE id=$2', [
      `changed-${randomUUID()}@example.com`,
      member.userId,
    ]);
    const stranger = await login();
    await pool.query('UPDATE auth_users SET email=$1 WHERE id=$2', [formerEmail, stranger.userId]);
    await pool.query(
      "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'member')",
      [f.workspaceId, stranger.userId],
    );
    await expect(
      repo.submit(stranger, f.workspaceId, f.pulse.id, response(4)),
    ).rejects.toMatchObject({ status: 403 });
    await pool.query('DELETE FROM auth_sessions WHERE id=$1', [member.sessionId]);
    await expect(repo.get(member, f.workspaceId, f.pulse.id)).rejects.toMatchObject({
      status: 401,
    });
  });
  it('rejects empty rosters and shared overlapping cohorts across teams, accepts adjacent periods and replacement after cancellation', async () => {
    const f = await fixture();
    const empty = await organization.createTeam(f.owner, f.workspaceId, 'Empty');
    const emptyPulse = await repo.create(f.owner, f.workspaceId, { teamId: empty.id, ...period });
    await expect(
      repo.transition(f.owner, f.workspaceId, emptyPulse.id, 'open'),
    ).rejects.toMatchObject({ status: 409 });
    await repo.transition(f.owner, f.workspaceId, f.pulse.id, 'open');
    const sameTeam = await repo.create(f.owner, f.workspaceId, {
      teamId: f.team.id,
      referenceStart: '2026-09-15T00:00:00.000Z',
      referenceEnd: '2026-09-29T00:00:00.000Z',
    });
    await expect(
      repo.transition(f.owner, f.workspaceId, sameTeam.id, 'open'),
    ).rejects.toMatchObject({ status: 409 });
    await repo.assign(f.owner, f.workspaceId, f.owner.userId, { teamId: empty.id });
    await expect(
      repo.transition(f.owner, f.workspaceId, emptyPulse.id, 'open'),
    ).rejects.toMatchObject({ status: 409 });
    await repo.transition(f.owner, f.workspaceId, f.pulse.id, 'close');
    await expect(
      repo.transition(f.owner, f.workspaceId, emptyPulse.id, 'open'),
    ).rejects.toMatchObject({ status: 409 });
    const adjacent = await repo.create(f.owner, f.workspaceId, {
      teamId: empty.id,
      referenceStart: period.referenceEnd,
      referenceEnd: '2026-09-29T00:00:00.000Z',
    });
    await repo.transition(f.owner, f.workspaceId, adjacent.id, 'open');
    await repo.transition(f.owner, f.workspaceId, adjacent.id, 'cancel');
    const replacement = await repo.create(f.owner, f.workspaceId, {
      teamId: empty.id,
      referenceStart: period.referenceEnd,
      referenceEnd: '2026-09-29T00:00:00.000Z',
    });
    expect((await repo.transition(f.owner, f.workspaceId, replacement.id, 'open')).state).toBe(
      'open',
    );
  });
  it('guards team deletion for drafts/open pulses and enforces cross-workspace assignment FKs', async () => {
    const f = await fixture();
    await expect(organization.deleteTeam(f.owner, f.workspaceId, f.team.id)).rejects.toMatchObject({
      status: 409,
    });
    await repo.transition(f.owner, f.workspaceId, f.pulse.id, 'open');
    await expect(organization.deleteTeam(f.owner, f.workspaceId, f.team.id)).rejects.toMatchObject({
      status: 409,
    });
    const other = await fixture();
    await expect(
      repo.assign(f.owner, f.workspaceId, f.owner.userId, { teamId: other.team.id }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      pool.query('UPDATE space_assignments SET team_id=$1 WHERE workspace_id=$2 AND user_id=$3', [
        other.team.id,
        f.workspaceId,
        f.owner.userId,
      ]),
    ).rejects.toMatchObject({ code: '23503' });
    await repo.transition(f.owner, f.workspaceId, f.pulse.id, 'cancel');
    await organization.deleteTeam(f.owner, f.workspaceId, f.team.id);
    expect((await repo.get(f.owner, f.workspaceId, f.pulse.id)).teamId).toBe(f.team.id);
  });
  it('preserves cancelled draft context after team deletion without revealing counts or roster identities', async () => {
    const f = await fixture();
    const cancelled = await repo.transition(f.owner, f.workspaceId, f.pulse.id, 'cancel');
    expect(cancelled.openedAt).toBeNull();
    expect(cancelled.rosterSize).toBe(3);
    expect(cancelled.submittedCount).toBeNull();
    expect(cancelled.eligible).toBe(false);
    expect(
      (await pool.query('SELECT user_id FROM space_roster WHERE pulse_id=$1', [f.pulse.id])).rows,
    ).toEqual([]);
    const member = f.members[1];
    if (!member) throw new Error('No member');
    const read = await server.inject({
      url: `/api/workspaces/${f.workspaceId}/space/pulses/${f.pulse.id}`,
      headers: { cookie: member.cookie },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ pulse: cancelled });
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body).not.toContain('answers');
    for (const participant of f.members) expect(read.body).not.toContain(participant.userId);
    expect(cancelled.questions).toBeNull();
    await organization.deleteTeam(f.owner, f.workspaceId, f.team.id);
    expect(await repo.get(f.owner, f.workspaceId, f.pulse.id)).toEqual(cancelled);
  });
  it('bounds pulse and assignment history pages and scopes cursor visibility', async () => {
    const f = await fixture();
    for (let i = 0; i < 26; i++) {
      const pulse = await repo.create(f.owner, f.workspaceId, { teamId: f.team.id, ...period });
      await repo.transition(f.owner, f.workspaceId, pulse.id, 'cancel');
      await repo.assign(f.owner, f.workspaceId, f.owner.userId, {
        teamId: i % 2 === 0 ? null : f.team.id,
      });
    }
    const first = await repo.list(f.owner, f.workspaceId, {});
    expect(first.pulses).toHaveLength(25);
    expect(first.nextCursor).not.toBeNull();
    const next = await repo.list(f.owner, f.workspaceId, { cursor: first.nextCursor });
    expect(next.pulses).toHaveLength(2);
    expect(next.nextCursor).toBeNull();
    expect(new Set([...first.pulses, ...next.pulses].map((p) => p.id)).size).toBe(27);
    const member = f.members[1];
    if (!member) throw new Error('No member');
    expect(
      (await repo.list(member, f.workspaceId, {})).pulses.every((p) => p.state !== 'draft'),
    ).toBe(true);
    await expect(repo.list(member, f.workspaceId, { cursor: f.pulse.id })).rejects.toMatchObject({
      status: 404,
    });
    const history = await repo.ownAssignment(f.owner, f.workspaceId, {});
    expect(history.history).toHaveLength(25);
    expect(history.nextCursor).not.toBeNull();
    expect(
      (await repo.ownAssignment(f.owner, f.workspaceId, { cursor: history.nextCursor })).history,
    ).toHaveLength(2);
    await expect(
      repo.ownAssignment(member, f.workspaceId, { cursor: history.nextCursor }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('counts all-null submissions as participation without publishing any question and rejects later draft edits', async () => {
    const f = await fixture();
    await repo.update(f.owner, f.workspaceId, f.pulse.id, { teamId: f.team.id, ...period });
    await repo.transition(f.owner, f.workspaceId, f.pulse.id, 'open');
    await expect(
      repo.update(f.owner, f.workspaceId, f.pulse.id, { teamId: f.team.id, ...period }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(repo.transition(f.owner, f.workspaceId, f.pulse.id, 'open')).rejects.toMatchObject(
      { status: 409 },
    );
    for (const member of f.members)
      await repo.submit(member, f.workspaceId, f.pulse.id, response(null));
    const closed = await repo.transition(f.owner, f.workspaceId, f.pulse.id, 'close');
    expect(closed.submittedCount).toBe(3);
    expect(
      closed.questions?.every(
        (q) => q.status === 'suppressed' && q.mean === null && !('answeredCount' in q),
      ),
    ).toBe(true);
    const member = f.members[1];
    if (!member) throw new Error('No member');
    expect((await repo.get(member, f.workspaceId, f.pulse.id)).submittedCount).toBe(3);
    expect(
      (await pool.query('SELECT * FROM space_answers WHERE pulse_id=$1', [f.pulse.id])).rowCount,
    ).toBe(0);
  });
  it('detects missing SPACE storage despite a complete migration ledger', async () => {
    await checkReadiness(pool, await loadMigrations());
    await pool.query('ALTER TABLE space_answers RENAME COLUMN answers TO missing_answers');
    try {
      await expect(checkReadiness(pool, await loadMigrations())).rejects.toThrow();
    } finally {
      await pool.query('ALTER TABLE space_answers RENAME COLUMN missing_answers TO answers');
    }
  });
  it('HTTP applies origin, role, scope and strict allowlists with no private response payload leakage', async () => {
    const f = await fixture();
    const member = f.members[1];
    if (!member) throw new Error('No member');
    const base = `/api/workspaces/${f.workspaceId}/space`;
    const call = (
      method: 'GET' | 'POST' | 'PATCH',
      path: string,
      payload?: Record<string, unknown>,
      cookie = f.owner.cookie,
    ) =>
      server.inject({
        method,
        url: `${base}${path}`,
        headers: { cookie, origin: 'http://localhost:5173' },
        ...(payload ? { payload } : {}),
      });
    expect((await call('GET', '/instrument')).statusCode).toBe(200);
    expect((await call('GET', '/instrument?unexpected=1')).statusCode).toBe(400);
    expect((await call('GET', `/pulses/${f.pulse.id}`, undefined, member.cookie)).statusCode).toBe(
      404,
    );
    expect(
      (await call('PATCH', '/preferences', { minimumRespondents: 3 }, member.cookie)).statusCode,
    ).toBe(403);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: `${base}/pulses/${f.pulse.id}/open`,
          headers: { cookie: f.owner.cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect((await call('GET', '/pulses?extra=1')).statusCode).toBe(400);
    expect(
      (await call('PATCH', '/preferences', { minimumRespondents: 3, extra: true })).statusCode,
    ).toBe(400);
    await call('POST', `/pulses/${f.pulse.id}/open`, {});
    const submitted = await call(
      'POST',
      `/pulses/${f.pulse.id}/response`,
      response(5),
      member.cookie,
    );
    expect(submitted.headers['cache-control']).toBe('no-store');
    expect(submitted.json()).toEqual({
      workspaceId: f.workspaceId,
      pulseId: f.pulse.id,
      submitted: true,
    });
    const rejected = await call(
      'POST',
      `/pulses/${f.pulse.id}/response`,
      { ...response(1), userId: f.owner.userId },
      member.cookie,
    );
    expect(rejected.statusCode).toBe(400);
    expect(rejected.headers['cache-control']).toBe('no-store');
    expect(rejected.json()).toEqual({ error: 'invalid_request' });
    for (const path of ['/pulses', `/pulses/${f.pulse.id}`]) {
      const result = await call('GET', path, undefined, member.cookie);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.body).not.toContain(member.userId);
      expect(result.body).not.toContain(f.owner.userId);
      expect(result.body).not.toContain('answers');
      expect(result.body).not.toContain('receipt');
    }
    const foreign = await fixture();
    await repo.transition(foreign.owner, foreign.workspaceId, foreign.pulse.id, 'open');
    for (const [method, path, body] of [
      ['GET', `/pulses/${foreign.pulse.id}`, undefined],
      ['POST', `/pulses/${foreign.pulse.id}/response`, response(3)],
    ] as const) {
      const scoped = await call(method, path, body);
      expect(scoped.statusCode).toBe(404);
      expect(scoped.json()).toEqual({ error: 'not_found' });
      expect(scoped.headers['cache-control']).toBe('no-store');
    }
    const outsider = await login();
    expect((await call('GET', '/pulses', undefined, outsider.cookie)).statusCode).toBe(404);
    const unavailable = createServer({ ready: async () => {}, close: async () => {} });
    try {
      expect((await unavailable.inject({ url: `${base}/pulses` })).statusCode).toBe(503);
    } finally {
      await unavailable.close();
    }
  });
});
