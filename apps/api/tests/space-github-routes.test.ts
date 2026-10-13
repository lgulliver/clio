import fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityError } from '../src/features/identity/input.ts';
import { registerSpaceGitHubRoutes } from '../src/features/space-github/routes.ts';
import { createServer } from '../src/server.ts';

const repository = vi.hoisted(() => ({
  availability: vi.fn(),
  list: vi.fn(),
  save: vi.fn(),
  update: vi.fn(),
  disconnect: vi.fn(),
  enqueue: vi.fn(),
  history: vi.fn(),
  results: vi.fn(),
  getResult: vi.fn(),
}));
vi.mock('../src/features/space-github/repository.ts', () => ({
  createSpaceGitHubRepository: () => repository,
}));
const wid = '11111111-1111-4111-8111-111111111111';
const mid = '22222222-2222-4222-8222-222222222222';
const teamId = '33333333-3333-4333-8333-333333333333';
const base = `/api/workspaces/${wid}/space/github`;
const pool = new Pool();
const actor = vi.fn(async (_request: FastifyRequest, _reply: FastifyReply, _write: boolean) => ({
  userId: 'fixture',
  sessionId: 'session',
}));
const servers: ReturnType<typeof fastify>[] = [];
function fixture(enabled = true) {
  const server = fastify();
  servers.push(server);
  server.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof IdentityError)
      return reply.code(error.status).send({ error: error.message });
    return reply.code(500).send({ error: 'unexpected' });
  });
  registerSpaceGitHubRoutes(server, enabled ? { pool, config: null, actor } : undefined);
  return server;
}
beforeEach(() => {
  vi.resetAllMocks();
  actor.mockResolvedValue({ userId: 'fixture', sessionId: 'session' });
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});
const writes = [
  {
    method: 'POST',
    path: '/mappings',
    payload: { teamId, installationId: 10, repositoryId: 20 },
    name: 'save',
    status: 201,
    envelope: 'mapping',
  },
  {
    method: 'PATCH',
    path: `/mappings/${mid}`,
    payload: { revision: 1, teamId },
    name: 'update',
    status: 200,
    envelope: 'mapping',
  },
  {
    method: 'POST',
    path: `/mappings/${mid}/disconnect`,
    payload: { revision: 1 },
    name: 'disconnect',
    status: 200,
    envelope: 'mapping',
  },
  {
    method: 'POST',
    path: `/mappings/${mid}/runs`,
    payload: {
      revision: 1,
      requestId: mid,
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2026-01-03T00:00:00.000Z',
    },
    name: 'enqueue',
    status: 202,
    envelope: 'run',
  },
] as const;
describe('SPACE GitHub HTTP transport', () => {
  it.each([
    '/availability',
    '/mappings',
    `/mappings/${mid}/runs`,
    `/mappings/${mid}/results`,
    `/results/${mid}`,
  ])('registers scoped unavailable read %s without identity', async (path) => {
    const response = await fixture(false).inject(`${base}${path}`);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'unavailable' });
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it.each(writes)('registers unavailable write $name without identity', async (row) => {
    const response = await fixture(false).inject({
      method: row.method,
      url: base + row.path,
      payload: row.payload,
    });
    expect(response.statusCode).toBe(503);
  });
  it.each(writes)(
    'returns exact $name envelope and status; asks actor for write authorization',
    async (row) => {
      repository[row.name].mockResolvedValue({ id: mid });
      const response = await fixture().inject({
        method: row.method,
        url: base + row.path,
        payload: row.payload,
      });
      expect(response.statusCode).toBe(row.status);
      expect(response.json()).toEqual({ [row.envelope]: { id: mid } });
      expect(actor.mock.calls[0]?.[2]).toBe(true);
      expect(repository[row.name].mock.calls[0]?.slice(0, 2)).toEqual([
        { userId: 'fixture', sessionId: 'session' },
        wid,
      ]);
    },
  );
  it.each(writes)('rejects unknown body/query keys before $name storage', async (row) => {
    for (const url of [base + row.path, `${base + row.path}?extra=1`]) {
      const response = await fixture().inject({
        method: row.method,
        url,
        payload: { ...row.payload, extra: 'private-input' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid_request' });
    }
    expect(repository[row.name]).not.toHaveBeenCalled();
  });
  it.each([
    { path: '/availability', name: 'availability', value: { workspaceId: wid, enabled: false } },
    {
      path: '/mappings',
      name: 'list',
      value: { workspaceId: wid, teamId: null, mappings: [], nextCursor: null },
    },
    {
      path: `/mappings/${mid}/runs`,
      name: 'history',
      value: { workspaceId: wid, mappingId: mid, teamId: null, runs: [], nextCursor: null },
    },
    {
      path: `/mappings/${mid}/results`,
      name: 'results',
      value: { workspaceId: wid, mappingId: mid, teamId: null, results: [], nextCursor: null },
    },
    { path: `/results/${mid}`, name: 'getResult', value: { id: mid } },
  ] as const)('returns scoped $name read envelope with null config', async (row) => {
    repository[row.name].mockResolvedValue(row.value);
    const response = await fixture().inject(base + row.path);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(row.name === 'getResult' ? { result: row.value } : row.value);
    expect(actor.mock.calls[0]?.[2]).toBe(false);
    const invalid = await fixture().inject(`${base + row.path}?unexpected=1`);
    expect(invalid.statusCode).toBe(400);
  });
  it.each([400, 401, 403, 404, 409, 503])('preserves IdentityError.status %s', async (status) => {
    repository.list.mockRejectedValue(new IdentityError(status, 'safe_error'));
    const response = await fixture().inject(`${base}/mappings`);
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: 'safe_error' });
  });
  it.each(['23505', '23503', '23514', 'XX000'])(
    'redacts SQL/provider diagnostics %s',
    async (code) => {
      repository.save.mockRejectedValue(Object.assign(new Error('PRIVATE-TOKEN-QUERY'), { code }));
      const response = await fixture().inject({
        method: 'POST',
        url: `${base}/mappings`,
        payload: writes[0].payload,
      });
      expect(response.statusCode).toBe(['23505', '23503'].includes(code) ? 409 : 503);
      expect(response.body).not.toContain('PRIVATE');
    },
  );
  it('rejects malformed IDs and cursors before storage', async () => {
    expect((await fixture().inject(`${base}/mappings?cursor=%21`)).statusCode).toBe(400);
    expect((await fixture().inject(`${base}/mappings?teamId=nope`)).statusCode).toBe(400);
    expect((await fixture().inject(`${base}/results/nope`)).statusCode).toBe(400);
    expect(repository.list).not.toHaveBeenCalled();
    expect(repository.getResult).not.toHaveBeenCalled();
  });
  it('does not reach storage when session/Origin resolver denies request', async () => {
    actor.mockRejectedValue(new IdentityError(403, 'forbidden'));
    const response = await fixture().inject({
      method: 'POST',
      url: `${base}/mappings`,
      payload: writes[0].payload,
    });
    expect(response.statusCode).toBe(403);
    expect(repository.save).not.toHaveBeenCalled();
  });
});
it.each([
  { path: '/mappings', payload: { teamId, installationId: '10', repositoryId: 20 } },
  {
    path: '/mappings',
    payload: { teamId, installationId: 10, repositoryId: Number.MAX_SAFE_INTEGER + 1 },
  },
  { path: `/mappings/${mid}`, method: 'PATCH', payload: { revision: 0, teamId } },
  { path: `/mappings/${mid}/disconnect`, payload: { revision: 1, teamId } },
  {
    path: `/mappings/${mid}/runs`,
    payload: { ...writes[3].payload, windowEnd: '2026-02-30T00:00:00.000Z' },
  },
  {
    path: `/mappings/${mid}/runs`,
    payload: { ...writes[3].payload, windowEnd: '2026-01-01T00:00:00.000Z' },
  },
  { path: `/mappings/${mid}/runs`, payload: { ...writes[3].payload, requestId: 'invalid' } },
])('rejects invalid write payload on $path before storage', async (row) => {
  const response = await fixture().inject({
    method: row.method === 'PATCH' ? 'PATCH' : 'POST',
    url: `${base}${row.path}`,
    payload: row.payload,
  });
  expect(response.statusCode).toBe(400);
  for (const name of ['save', 'update', 'disconnect', 'enqueue'] as const)
    expect(repository[name]).not.toHaveBeenCalled();
});
it.each(writes)('rejects unknown query with valid $name body before storage', async (row) => {
  const response = await fixture().inject({
    method: row.method,
    url: `${base}${row.path}?unknown=1`,
    payload: row.payload,
  });
  expect(response.statusCode).toBe(400);
  expect(repository[row.name]).not.toHaveBeenCalled();
});
it.each(['list', 'history', 'results'] as const)(
  'forwards validated team/cursor scope to %s',
  async (name) => {
    repository[name].mockResolvedValue({ nextCursor: null });
    const path =
      name === 'list' ? '/mappings' : `/mappings/${mid}/${name === 'history' ? 'runs' : 'results'}`;
    const response = await fixture().inject(`${base}${path}?teamId=${teamId}&cursor=abc_123`);
    expect(response.statusCode).toBe(200);
    expect(repository[name].mock.calls[0]?.at(-1)).toEqual({ teamId, cursor: 'abc_123' });
  },
);

it.each(writes)('checks actor denial before invalid $name body', async (row) => {
  actor.mockRejectedValue(new IdentityError(403, 'forbidden'));
  const response = await fixture().inject({
    method: row.method,
    url: `${base}${row.path}`,
    payload: { unexpected: true },
  });
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ error: 'forbidden' });
  expect(actor.mock.calls[0]?.[2]).toBe(true);
  expect(repository[row.name]).not.toHaveBeenCalled();
});

it('registers SPACE GitHub routes through production identity plugin without identity', async () => {
  const server = createServer({ ready: async () => {}, close: async () => {} });
  servers.push(server);
  const response = await server.inject(`${base}/availability`);
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ error: 'unavailable' });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(repository.availability).not.toHaveBeenCalled();
});
