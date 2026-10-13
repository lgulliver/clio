import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullCheckpoint } from '../../../../../packages/adapters/src/github-pulls-contract.ts';
import { calculateSignals } from '../../../../api/src/features/space-github/calculate.ts';
import { createQueryClient } from '../../lib/query-client';
import {
  archivedTeam,
  instrumentBody,
  json,
  teamA,
  teamB,
  workspaceId,
} from '../space/fixtures.test-support';
import { DeveloperExperiencePage } from '../space/space-page';
import type { OperationMapping, OperationResult, OperationRun } from './api';

// Fictional operational fixtures for tests only; signal values come from the server calculator.
const session = vi.hoisted(() => ({ revision: 1, expire: vi.fn(), refresh: vi.fn() }));
vi.mock('../identity/session', () => ({
  useSession: () => ({
    status: 'ready',
    user: { id: 'alice', name: 'Alice', email: 'alice@example.test', emailVerified: true },
    revision: session.revision,
    current: (revision: number) => revision === session.revision,
    expire: session.expire,
    refresh: session.refresh,
  }),
}));

const secondWorkspace = '77777777-7777-4777-8777-777777777777';
const mappingA = 'aaaaaaaa-0000-4000-8000-000000000001';
const base = `/api/workspaces/${workspaceId}/space/github`;
let serial = 0;
function uuid() {
  serial += 1;
  return `bbbbbbbb-0000-4000-8000-${serial.toString(16).padStart(12, '0')}`;
}
function day(offset: number) {
  return new Date(Date.UTC(2026, 8, 1) + offset * 86_400_000).toISOString();
}
function checkpoint(start: string, pulls: number, reviewed: number, hours = 5): PullCheckpoint {
  const opened = Date.parse(start) + 9 * 3_600_000;
  const facts = Array.from({ length: pulls }, (_, index) => ({
    id: index + 1,
    number: index + 1,
    createdAt: new Date(opened).toISOString(),
    mergedAt: new Date(opened + hours * 3_600_000).toISOString(),
    authorClass: 'human' as const,
    observedAt: day(30),
  }));
  return {
    version: 1,
    phase: 'ready',
    repositoryId: 123,
    repositoryOwner: 'acme',
    repositoryName: 'api',
    nextPullPage: null,
    nextReviewIndex: facts.length,
    nextReviewPage: 1,
    discoveryTraversalComplete: true,
    reviewTraversalComplete: facts.map((item) => item.id),
    gaps: [],
    pulls: facts,
    reviews: facts.slice(0, reviewed).map((item) => ({
      id: item.id + 100,
      pullId: item.id,
      submittedAt: new Date(opened + 3_600_000).toISOString(),
      state: 'APPROVED' as const,
      authorClass: 'human' as const,
      reviewerClass: 'human' as const,
      actorEligibilityKnown: true,
      isSelfReview: false,
      observedAt: day(30),
    })),
  };
}
function mapping(overrides: Partial<OperationMapping> = {}): OperationMapping {
  return {
    id: mappingA,
    workspaceId,
    teamId: teamA,
    teamName: 'Platform',
    appId: 12,
    installationId: 34,
    repositoryId: 123,
    repositoryLabel: 'acme/api',
    revision: 1,
    connected: true,
    ...overrides,
  };
}
function context(item: OperationMapping, start: number, days: number) {
  return {
    workspaceId,
    mappingId: item.id,
    mappingRevision: item.revision,
    appId: item.appId,
    installationId: item.installationId,
    repositoryId: item.repositoryId,
    repositoryLabel: item.repositoryLabel,
    teamId: item.teamId,
    teamName: item.teamName,
    windowStart: day(start),
    windowEnd: day(start + days),
  };
}
function result(
  item: OperationMapping,
  input: { start?: number; days?: number; pulls?: number; reviewed?: number } = {},
): OperationResult {
  const ctx = context(item, input.start ?? 0, input.days ?? 14);
  return {
    ...ctx,
    id: uuid(),
    runId: uuid(),
    acquisitionStartedAt: day(30),
    acquisitionEndedAt: day(30),
    completedAt: day(30),
    contractVersion: 'clio.space.github.v1',
    calculated: calculateSignals(
      checkpoint(ctx.windowStart, input.pulls ?? 3, input.reviewed ?? 3),
      { windowStart: ctx.windowStart, windowEnd: ctx.windowEnd },
    ),
    discoveryTraversalComplete: true,
    reviewTraversalComplete: true,
    gaps: [],
  };
}
function run(
  item: OperationMapping,
  state: OperationRun['state'],
  input: { start?: number; resultId?: string; reason?: OperationRun['reason'] } = {},
): OperationRun {
  const terminal = state === 'succeeded' || state === 'failed' || state === 'cancelled';
  return {
    ...context(item, input.start ?? 0, 14),
    id: uuid(),
    state,
    queuedAt: day(30),
    completedAt: terminal ? day(31) : null,
    reason: input.reason ?? null,
    resultId: input.resultId ?? null,
  };
}

type Call = { method: string; path: string; body: unknown; signal: AbortSignal | undefined };
type Override = (call: Call) => Response | Promise<Response> | undefined;
const server = {
  role: 'owner' as 'owner' | 'member',
  listed: true,
  enabled: true,
  calls: [] as Call[],
  override: undefined as Override | undefined,
  mappings: [] as OperationMapping[],
  runs: [] as OperationRun[],
  results: [] as OperationResult[],
};
const grants = [
  {
    appId: 12,
    installationId: 34,
    accountId: 56,
    accountType: 'Organization',
    repositoryIds: [123, 456],
  },
];

function github(call: Call, url: URL, scope: string): Response {
  const rest = url.pathname.slice(`/api/workspaces/${scope}/space/github`.length);
  const team = url.searchParams.get('teamId');
  if (scope !== workspaceId)
    return rest === '/availability'
      ? json({ workspaceId: scope, enabled: false })
      : json({ workspaceId: scope, teamId: team, mappings: [], nextCursor: null });
  if (rest === '/availability')
    return json(
      server.role === 'owner'
        ? { workspaceId, enabled: server.enabled, grants }
        : { workspaceId, enabled: server.enabled },
    );
  if (rest === '/mappings' && call.method === 'GET') {
    const listed = server.mappings.filter(
      (item) =>
        !team ||
        item.teamId === team ||
        server.results.some((r) => r.mappingId === item.id && r.teamId === team) ||
        server.runs.some((r) => r.mappingId === item.id && r.teamId === team),
    );
    return json({ workspaceId, teamId: team, mappings: listed, nextCursor: null });
  }
  if (rest === '/mappings' && call.method === 'POST') {
    const body = call.body as { teamId: string; installationId: number; repositoryId: number };
    const created = mapping({
      id: 'aaaaaaaa-0000-4000-8000-0000000000aa',
      teamId: body.teamId,
      teamName: body.teamId === teamA ? 'Platform' : 'Mobile',
      installationId: body.installationId,
      repositoryId: body.repositoryId,
      repositoryLabel: body.repositoryId === 123 ? 'acme/api' : 'acme/web',
    });
    server.mappings.push(created);
    return json({ mapping: created }, 201);
  }
  const runs = /^\/mappings\/([0-9a-f-]+)\/runs$/.exec(rest);
  if (runs && call.method === 'GET') {
    return json({
      workspaceId,
      mappingId: runs[1],
      teamId: team,
      runs: server.runs.filter((r) => r.mappingId === runs[1] && (!team || r.teamId === team)),
      nextCursor: null,
    });
  }
  if (runs && call.method === 'POST') {
    const body = call.body as { revision: number; windowStart: string; windowEnd: string };
    const target = server.mappings.find((item) => item.id === runs[1]);
    if (!target) return json({ error: 'not_found' }, 404);
    const queued: OperationRun = {
      ...context(target, 0, 1),
      windowStart: body.windowStart,
      windowEnd: body.windowEnd,
      id: uuid(),
      state: 'queued',
      queuedAt: '2026-10-13T12:00:00.000Z',
      completedAt: null,
      reason: null,
      resultId: null,
    };
    server.runs.unshift(queued);
    return json({ run: queued }, 202);
  }
  const results = /^\/mappings\/([0-9a-f-]+)\/results$/.exec(rest);
  if (results)
    return json({
      workspaceId,
      mappingId: results[1],
      teamId: team,
      results: server.results.filter(
        (r) => r.mappingId === results[1] && (!team || r.teamId === team),
      ),
      nextCursor: null,
    });
  const patch = /^\/mappings\/([0-9a-f-]+)$/.exec(rest);
  if (patch && call.method === 'PATCH') {
    const body = call.body as { revision: number; teamId: string };
    const target = server.mappings.find((item) => item.id === patch[1]);
    if (!target || target.revision !== body.revision) return json({ error: 'stale' }, 409);
    const updated = {
      ...target,
      teamId: body.teamId,
      teamName: body.teamId === teamA ? 'Platform' : 'Mobile',
      revision: target.revision + 1,
    };
    server.mappings = server.mappings.map((item) => (item.id === target.id ? updated : item));
    return json({ mapping: updated });
  }
  const disconnect = /^\/mappings\/([0-9a-f-]+)\/disconnect$/.exec(rest);
  if (disconnect) {
    const target = server.mappings.find((item) => item.id === disconnect[1]);
    if (!target) return json({ error: 'not_found' }, 404);
    const updated = { ...target, connected: false, revision: target.revision + 1 };
    server.mappings = server.mappings.map((item) => (item.id === target.id ? updated : item));
    return json({ mapping: updated });
  }
  return json({ error: 'not_found' }, 404);
}

async function respond(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const call: Call = {
    method: init?.method ?? 'GET',
    path: `${url.pathname}${url.search}`,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    signal: init?.signal ?? undefined,
  };
  server.calls.push(call);
  const overridden = server.override?.(call);
  if (overridden) return overridden;
  if (url.pathname === '/api/workspaces')
    return json({
      workspaces: [
        ...(server.listed ? [{ id: workspaceId, name: 'Engineering', role: server.role }] : []),
        { id: secondWorkspace, name: 'Research', role: 'member' },
      ],
    });
  const scope = [workspaceId, secondWorkspace].find((id) =>
    url.pathname.startsWith(`/api/workspaces/${id}/`),
  );
  if (!scope) return json({ error: 'not_found' }, 404);
  const rest = url.pathname.slice(`/api/workspaces/${scope}`.length);
  if (rest === '/organization')
    return json({
      workspaceId: scope,
      teams: [
        { id: teamA, workspaceId: scope, name: 'Platform' },
        { id: teamB, workspaceId: scope, name: 'Mobile' },
      ],
      products: [],
      services: [],
      assignments: [],
    });
  if (rest.startsWith('/space/github')) return github(call, url, scope);
  if (rest === '/space/instrument') return json(instrumentBody());
  if (rest === '/space/preferences') return json({ workspaceId: scope, minimumRespondents: 3 });
  if (rest === '/space/assignment')
    return json({
      workspaceId: scope,
      teamId: null,
      teamName: null,
      history: [],
      nextCursor: null,
    });
  if (rest === '/space/pulses') return json({ workspaceId: scope, pulses: [], nextCursor: null });
  return json({ error: 'not_found' }, 404);
}

const fetchMock = vi.fn(respond);
const now = () => new Date('2026-10-13T12:00:00.000Z');
function mount() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <DeveloperExperiencePage now={now} />
    </QueryClientProvider>,
  );
}
async function chooseWorkspace(id = workspaceId) {
  fireEvent.change(await screen.findByLabelText('Workspace'), { target: { value: id } });
}
function deferred() {
  let resolve: (value: Response) => void = () => undefined;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function posts() {
  return server.calls.filter((call) => call.method !== 'GET');
}
async function panel() {
  return within(await screen.findByRole('region', { name: 'GitHub pull request activity' }));
}
async function openMapping(label = 'acme/api') {
  const view = await panel();
  await userEvent.click(await view.findByRole('button', { name: `View results for ${label}` }));
  return view;
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(respond);
  Object.assign(server, {
    role: 'owner',
    listed: true,
    enabled: true,
    calls: [],
    override: undefined,
    mappings: [],
    runs: [],
    results: [],
  });
  session.revision = 1;
});

describe('GitHub operational panel', () => {
  it('shows unconfigured setup honestly without counts or collection controls', async () => {
    server.enabled = false;
    mount();
    await chooseWorkspace();
    const view = await panel();
    expect(
      await view.findByText(/GitHub activity collection is not set up for this workspace/),
    ).toBeVisible();
    expect(await view.findByText('No repositories connected yet.')).toBeVisible();
    expect(view.queryByRole('button', { name: 'Connect a repository' })).not.toBeInTheDocument();
    expect(view.queryByRole('article')).not.toBeInTheDocument();
    expect(view.queryByText(/\b0 (pull requests|PRs)\b/)).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it('keeps disconnected history readable while collection is disabled', async () => {
    server.enabled = false;
    const gone = mapping({ connected: false, revision: 2 });
    server.mappings = [gone];
    server.results = [result(mapping())];
    mount();
    await chooseWorkspace();
    const view = await openMapping();
    expect(await view.findByText('Disconnected')).toBeVisible();
    expect(
      await view.findByRole('article', { name: 'PR review time (open to merge)' }),
    ).toBeVisible();
    expect(view.queryByRole('button', { name: /Collect/ })).not.toBeInTheDocument();
  });

  it('refresh performs reads only and never queues collection', async () => {
    const item = mapping();
    server.mappings = [item];
    server.results = [result(item, { pulls: 0, reviewed: 0 })];
    mount();
    await chooseWorkspace();
    const view = await openMapping();
    const opened = await view.findByRole('article', { name: 'PRs opened observed' });
    expect(within(opened).getByText('No observations')).toBeVisible();
    const before = server.calls.length;
    await userEvent.click(view.getByRole('button', { name: 'Refresh saved results' }));
    await waitFor(() =>
      expect(
        server.calls.slice(before).some((call) => call.path.startsWith(`${base}/mappings/`)),
      ).toBe(true),
    );
    expect(posts()).toHaveLength(0);
    expect(server.calls.slice(before).every((call) => call.method === 'GET')).toBe(true);
    expect(screen.getAllByText('No observations')[0]).toBeVisible();
    expect(screen.queryByText('0 pull requests')).not.toBeInTheDocument();
  });

  it('shows not-collected, queued and latest-failed states without hiding prior success', async () => {
    const item = mapping();
    server.mappings = [item];
    mount();
    await chooseWorkspace();
    let view = await openMapping();
    expect(await view.findByText(/Not collected yet/)).toBeVisible();
    expect(view.queryByRole('article')).not.toBeInTheDocument();

    const success = result(item);
    server.results = [success];
    server.runs = [
      run(item, 'failed', { start: 14, reason: 'provider_unavailable' }),
      run(item, 'succeeded', { resultId: success.id }),
    ];
    await userEvent.click(view.getByRole('button', { name: 'Refresh saved results' }));
    view = await panel();
    expect(await view.findByText(/Latest collection failed: GitHub was unavailable/)).toBeVisible();
    expect(view.getByRole('article', { name: 'PR review time (open to merge)' })).toBeVisible();

    server.runs = [run(item, 'queued', { start: 14 }), ...server.runs];
    await userEvent.click(view.getByRole('button', { name: 'Refresh saved results' }));
    expect(await view.findByText(/Collection queued/)).toBeVisible();
    expect(view.getByRole('article', { name: 'PR review time (open to merge)' })).toBeVisible();
    expect(posts()).toHaveLength(0);
  });

  it('labels both timing signals exactly with their different values and draft-inclusive context', async () => {
    const item = mapping();
    server.mappings = [item];
    server.results = [result(item)];
    mount();
    await chooseWorkspace();
    const view = await openMapping();
    const merge = await view.findByRole('article', { name: 'PR review time (open to merge)' });
    const first = view.getByRole('article', {
      name: 'Time to first human review (open to first review)',
    });
    expect(within(merge).getByText('5.0 h')).toBeVisible();
    expect(within(first).getByText('1.0 h')).toBeVisible();
    expect(within(merge).getByText(/not measured active review effort/)).toBeVisible();
    expect(within(merge).getByText(/draft time/)).toBeVisible();
    expect(within(first).getByText(/biased toward shorter/)).toBeVisible();
    expect(within(merge).getAllByText(/Provisional/)[0]).toBeVisible();
    expect(within(merge).getByText(/3 timed PRs/)).toBeVisible();
    expect(view.getAllByRole('article')).toHaveLength(5);
    const cards = view.getByRole('list', { name: 'Signals for acme/api' });
    expect(within(cards).queryByText(/total|score|rank/i)).not.toBeInTheDocument();
  });

  it('charts separate qualified points without connecting lines and with a data table', async () => {
    const item = mapping();
    server.mappings = [item];
    server.results = [result(item, { start: 14 }), result(item, { start: 0, pulls: 2 })];
    mount();
    await chooseWorkspace();
    const view = await openMapping();
    const chart = await view.findByRole('img', { name: /PR review time \(open to merge\)/ });
    expect(chart.querySelectorAll('path')).toHaveLength(0);
    await userEvent.click(view.getByText('Trend data and context'));
    const merge = view.getByRole('table', { name: /PR review time \(open to merge\)/ });
    expect(within(merge).getByText('5.0 h')).toBeVisible();
    await userEvent.selectOptions(
      view.getByLabelText('Trend signal'),
      'Time to first human review (open to first review)',
    );
    const first = view.getByRole('img', { name: /Time to first human review/ });
    expect(first.querySelectorAll('path')).toHaveLength(0);
    const table = view.getByRole('table', { name: /Time to first human review/ });
    expect(within(table).getByText('Insufficient samples (2 timed PRs; minimum 3)')).toBeVisible();
    expect(within(table).getByText('1.0 h')).toBeVisible();
  });

  it('member sees saved results but no owner grants, wizard or mapping controls', async () => {
    server.role = 'member';
    server.mappings = [mapping()];
    server.results = [result(mapping())];
    mount();
    await chooseWorkspace();
    const view = await openMapping();
    expect(await view.findAllByRole('article')).toHaveLength(5);
    expect(view.queryByRole('button', { name: 'Connect a repository' })).not.toBeInTheDocument();
    expect(view.queryByRole('button', { name: /Disconnect/ })).not.toBeInTheDocument();
    expect(view.queryByText(/installation 34/)).not.toBeInTheDocument();
  });

  it('guides owner setup with explicit save and collection confirmations', async () => {
    mount();
    await chooseWorkspace();
    const view = await panel();
    await userEvent.click(await view.findByRole('button', { name: 'Connect a repository' }));
    const wizard = within(screen.getByRole('region', { name: 'Connect a GitHub repository' }));
    expect(wizard.getByRole('list', { name: 'Repository setup steps' })).toBeVisible();
    await userEvent.selectOptions(
      wizard.getByLabelText('GitHub installation'),
      'App 12 · installation 34 · Organization account 56',
    );
    await userEvent.selectOptions(wizard.getByLabelText('Repository'), 'Repository ID 123');
    await userEvent.selectOptions(wizard.getByLabelText('Owning team'), 'Platform');
    expect(wizard.queryByText('acme/api')).not.toBeInTheDocument();
    await userEvent.click(wizard.getByRole('button', { name: 'Next: scope and limits' }));
    expect(wizard.getByText(/Pull requests: read/)).toBeVisible();
    expect(wizard.getByText(/1,000 pull requests/)).toBeVisible();
    expect(wizard.getByText(/single person/)).toBeVisible();
    const next = wizard.getByRole('button', { name: 'Next: save and collect' });
    await userEvent.click(next);
    expect(wizard.getByText(/Step 2 of 4/)).toBeVisible();
    await userEvent.click(
      wizard.getByLabelText('I have reviewed the scope, limits and attribution notes'),
    );
    await userEvent.click(next);
    await userEvent.click(wizard.getByRole('button', { name: 'Save connection' }));
    expect(posts()).toHaveLength(0);
    await userEvent.click(wizard.getByRole('button', { name: 'Confirm save' }));
    expect(await wizard.findByText(/Verified repository acme\/api/)).toBeVisible();
    expect(posts().map((call) => call.body)).toEqual([
      { teamId: teamA, installationId: 34, repositoryId: 123 },
    ]);
    await userEvent.click(wizard.getByRole('button', { name: 'Collect this window' }));
    expect(posts()).toHaveLength(1);
    await userEvent.click(wizard.getByRole('button', { name: 'Confirm collection' }));
    expect(await wizard.findByText(/Collection queued/)).toBeVisible();
    const collect = posts()[1];
    expect(collect?.path).toBe(`${base}/mappings/aaaaaaaa-0000-4000-8000-0000000000aa/runs`);
    expect(collect?.body).toEqual({
      revision: 1,
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      windowStart: '2026-09-29T00:00:00.000Z',
      windowEnd: '2026-10-13T00:00:00.000Z',
    });
    expect(wizard.getByText(/Step 4 of 4/)).toBeVisible();
  });

  it('keeps unsaved wizard choices through a read-only refresh', async () => {
    mount();
    await chooseWorkspace();
    const view = await panel();
    await userEvent.click(await view.findByRole('button', { name: 'Connect a repository' }));
    const wizard = within(screen.getByRole('region', { name: 'Connect a GitHub repository' }));
    await userEvent.selectOptions(
      wizard.getByLabelText('GitHub installation'),
      'App 12 · installation 34 · Organization account 56',
    );
    await userEvent.selectOptions(wizard.getByLabelText('Repository'), 'Repository ID 456');
    await userEvent.click(view.getByRole('button', { name: 'Refresh saved results' }));
    await waitFor(() =>
      expect(server.calls.filter((call) => call.path === `${base}/availability`)).toHaveLength(2),
    );
    expect(wizard.getByLabelText('Repository')).toHaveValue('456');
    expect(posts()).toHaveLength(0);
  });

  it('discards a save that resolves after the workspace changes', async () => {
    const pending = deferred();
    server.override = (call) =>
      call.method === 'POST' && call.path === `${base}/mappings` ? pending.promise : undefined;
    mount();
    await chooseWorkspace();
    const view = await panel();
    await userEvent.click(await view.findByRole('button', { name: 'Connect a repository' }));
    const wizard = within(screen.getByRole('region', { name: 'Connect a GitHub repository' }));
    await userEvent.selectOptions(
      wizard.getByLabelText('GitHub installation'),
      'App 12 · installation 34 · Organization account 56',
    );
    await userEvent.selectOptions(wizard.getByLabelText('Repository'), 'Repository ID 123');
    await userEvent.selectOptions(wizard.getByLabelText('Owning team'), 'Platform');
    await userEvent.click(wizard.getByRole('button', { name: 'Next: scope and limits' }));
    await userEvent.click(
      wizard.getByLabelText('I have reviewed the scope, limits and attribution notes'),
    );
    await userEvent.click(wizard.getByRole('button', { name: 'Next: save and collect' }));
    await userEvent.click(wizard.getByRole('button', { name: 'Save connection' }));
    await userEvent.click(wizard.getByRole('button', { name: 'Confirm save' }));
    const signal = posts()[0]?.signal;
    await chooseWorkspace(secondWorkspace);
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      pending.resolve(json({ mapping: mapping() }, 201));
    });
    expect(screen.queryByText(/Verified repository/)).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Connect a GitHub repository' })).toBeNull();
    expect(await screen.findByText('No repositories connected yet.')).toBeVisible();
  });

  it('aborts pending history reads when the workspace changes', async () => {
    const pending = deferred();
    server.mappings = [mapping()];
    server.override = (call) =>
      call.path.startsWith(`${base}/mappings/`) && call.path.includes('/results')
        ? pending.promise
        : undefined;
    mount();
    await chooseWorkspace();
    await openMapping();
    await waitFor(() =>
      expect(server.calls.some((call) => call.path.includes('/results'))).toBe(true),
    );
    const read = server.calls.find((call) => call.path.includes('/results'));
    await chooseWorkspace(secondWorkspace);
    expect(read?.signal?.aborted).toBe(true);
    await act(async () => pending.resolve(json({ error: 'late' }, 500)));
    expect(screen.queryByText('acme/api')).not.toBeInTheDocument();
  });

  it('clears owner setup when demotion is found during save', async () => {
    server.override = (call) => {
      if (call.method === 'POST' && call.path === `${base}/mappings`) {
        server.role = 'member';
        return json({ error: 'forbidden' }, 403);
      }
      return undefined;
    };
    mount();
    await chooseWorkspace();
    const view = await panel();
    await userEvent.click(await view.findByRole('button', { name: 'Connect a repository' }));
    const wizard = within(screen.getByRole('region', { name: 'Connect a GitHub repository' }));
    await userEvent.selectOptions(
      wizard.getByLabelText('GitHub installation'),
      'App 12 · installation 34 · Organization account 56',
    );
    await userEvent.selectOptions(wizard.getByLabelText('Repository'), 'Repository ID 123');
    await userEvent.selectOptions(wizard.getByLabelText('Owning team'), 'Platform');
    await userEvent.click(wizard.getByRole('button', { name: 'Next: scope and limits' }));
    await userEvent.click(
      wizard.getByLabelText('I have reviewed the scope, limits and attribution notes'),
    );
    await userEvent.click(wizard.getByRole('button', { name: 'Next: save and collect' }));
    await userEvent.click(wizard.getByRole('button', { name: 'Save connection' }));
    await userEvent.click(wizard.getByRole('button', { name: 'Confirm save' }));
    expect(await screen.findByText(/Your access to Engineering changed/)).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Connect a GitHub repository' })).toBeNull(),
    );
    expect(screen.queryByText(/installation 34/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect a repository' })).toBeNull();
    expect(session.expire).not.toHaveBeenCalled();
  });

  it('rechecks workspace metadata when owner availability has member shape', async () => {
    server.override = (call) => {
      if (call.path === `${base}/availability` && server.role === 'owner') {
        server.role = 'member';
        return json({ workspaceId, enabled: true });
      }
      return undefined;
    };
    mount();
    await chooseWorkspace();
    expect(await screen.findByText(/Your access to Engineering changed/)).toBeVisible();
    expect(server.calls.filter((call) => call.path === '/api/workspaces').length).toBeGreaterThan(
      1,
    );
    await panel();
    expect(screen.queryByRole('button', { name: 'Connect a repository' })).toBeNull();
  });

  it('recovers a stale repository cursor locally when membership is unchanged', async () => {
    server.mappings = Array.from({ length: 25 }, (_, index) =>
      mapping({
        id: `aaaaaaaa-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
        repositoryId: index + 1,
        repositoryLabel: `acme/repo-${index + 1}`,
      }),
    );
    server.override = (call) => {
      if (call.path === `${base}/mappings`)
        return json({ workspaceId, teamId: null, mappings: server.mappings, nextCursor: 'older' });
      if (call.path === `${base}/mappings?cursor=older`) return json({ error: 'gone' }, 404);
      return undefined;
    };
    mount();
    await chooseWorkspace();
    const view = await panel();
    await userEvent.click(await view.findByRole('button', { name: 'Older repositories' }));
    expect(
      await view.findByText(
        'That page of repositories is no longer available. Showing the newest repositories.',
      ),
    ).toBeVisible();
    expect(await view.findByRole('button', { name: 'View results for acme/repo-1' })).toBeVisible();
    expect(screen.queryByText(/no longer available to you/)).toBeNull();
    expect(session.expire).not.toHaveBeenCalled();
  });

  it('treats a missing repository as local when access is unchanged', async () => {
    server.mappings = [mapping()];
    server.override = (call) =>
      call.path.startsWith(`${base}/mappings/${mappingA}/`)
        ? json({ error: 'gone' }, 404)
        : undefined;
    mount();
    await chooseWorkspace();
    const view = await openMapping();
    expect(
      await view.findByText('This repository connection is no longer available. Refresh the list.'),
    ).toBeVisible();
    expect(screen.getByLabelText('Team')).toBeVisible();
  });

  it('hides private data on true access loss', async () => {
    server.mappings = [mapping()];
    server.override = (call) => {
      if (call.path.startsWith(`${base}/mappings/${mappingA}/`)) {
        server.listed = false;
        return json({ error: 'gone' }, 404);
      }
      return undefined;
    };
    mount();
    await chooseWorkspace();
    await openMapping();
    expect(
      await screen.findByText(
        'This workspace is no longer available to you. Choose another workspace.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('region', { name: 'GitHub pull request activity' })).toBeNull();
  });

  it('reports a stale disconnect locally and keeps history readable', async () => {
    const item = mapping();
    server.mappings = [item];
    server.results = [result(item)];
    server.override = (call) =>
      call.path.endsWith('/disconnect') ? json({ error: 'stale_revision' }, 409) : undefined;
    mount();
    await chooseWorkspace();
    const view = await openMapping();
    await userEvent.click(await view.findByRole('button', { name: 'Disconnect repository' }));
    await userEvent.click(view.getByRole('button', { name: 'Confirm disconnect' }));
    expect(await view.findByText(/This connection changed since it was loaded/)).toBeVisible();
    expect(posts()[0]?.body).toEqual({ revision: 1 });
    expect(view.getAllByRole('article')).toHaveLength(5);
  });

  it('disconnects explicitly and keeps saved results', async () => {
    const item = mapping();
    server.mappings = [item];
    server.results = [result(item)];
    mount();
    await chooseWorkspace();
    const view = await openMapping();
    await userEvent.click(await view.findByRole('button', { name: 'Disconnect repository' }));
    await userEvent.click(view.getByRole('button', { name: 'Confirm disconnect' }));
    expect(await view.findByText('Disconnected')).toBeVisible();
    expect(view.getAllByRole('article')).toHaveLength(5);
  });

  it('filters by historical team and links copied deleted-team context into team selection', async () => {
    const current = mapping();
    const historical = mapping({ teamId: archivedTeam, teamName: 'Legacy' });
    server.mappings = [current];
    server.results = [result(historical)];
    mount();
    await chooseWorkspace();
    const view = await openMapping();
    await userEvent.click(await view.findByRole('button', { name: 'View Legacy team history' }));
    expect(await screen.findByRole('heading', { name: /^Legacy/, level: 2 })).toBeVisible();
    expect(screen.getByRole('option', { name: 'Legacy (team deleted)' })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        server.calls.some((call) => call.path === `${base}/mappings?teamId=${archivedTeam}`),
      ).toBe(true),
    );
    const filtered = await openMapping();
    expect(await filtered.findByText(/Current owner: Platform/)).toBeVisible();
    await waitFor(() =>
      expect(
        server.calls.some(
          (call) => call.path === `${base}/mappings/${mappingA}/results?teamId=${archivedTeam}`,
        ),
      ).toBe(true),
    );
    expect(await filtered.findAllByRole('article')).toHaveLength(5);
  });

  it('retries an unconfirmed collection with the same request ID', async () => {
    server.mappings = [mapping()];
    let attempts = 0;
    server.override = (call) => {
      if (call.method === 'POST' && call.path.endsWith('/runs')) {
        attempts += 1;
        if (attempts === 1) return json({ error: 'unavailable' }, 503);
      }
      return undefined;
    };
    mount();
    await chooseWorkspace();
    const view = await openMapping();
    await userEvent.click(await view.findByRole('button', { name: 'Collect this window' }));
    await userEvent.click(view.getByRole('button', { name: 'Confirm collection' }));
    expect(await view.findByText(/could not be confirmed/)).toBeVisible();
    await userEvent.click(view.getByRole('button', { name: 'Collect this window' }));
    await userEvent.click(view.getByRole('button', { name: 'Confirm collection' }));
    expect(await view.findByText(/Collection queued\. Use Refresh/)).toBeVisible();
    const [first, second] = posts().map((call) => call.body as { requestId: string });
    expect(second?.requestId).toBe(first?.requestId);
  });

  it('changes the owning team with the loaded revision and keeps recorded history', async () => {
    const item = mapping();
    server.mappings = [item];
    server.results = [result(item)];
    mount();
    await chooseWorkspace();
    const view = await openMapping();
    await userEvent.selectOptions(await view.findByLabelText('Change owning team'), 'Mobile');
    await userEvent.click(view.getByRole('button', { name: 'Change owner' }));
    expect(posts()).toHaveLength(0);
    await userEvent.click(view.getByRole('button', { name: 'Confirm owner change' }));
    expect(await view.findByText(/Now owned by Mobile/)).toBeVisible();
    expect(posts()[0]).toMatchObject({ method: 'PATCH', body: { revision: 1, teamId: teamB } });
    const cards = view.getByRole('list', { name: 'Signals for acme/api' });
    expect(cards).toBeVisible();
    expect(view.getByText('Platform', { selector: 'dd' })).toBeVisible();
  });

  it('keeps keyboard focus on the team selector when an open repository remounts', async () => {
    server.mappings = [mapping()];
    mount();
    await chooseWorkspace();
    await openMapping();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'acme/api' })).toHaveFocus());
    const team = screen.getByLabelText('Team');
    team.focus();
    fireEvent.change(team, { target: { value: teamA } });
    await waitFor(() =>
      expect(server.calls.some((call) => call.path === `${base}/mappings?teamId=${teamA}`)).toBe(
        true,
      ),
    );
    expect(await screen.findByRole('heading', { name: 'acme/api' })).toBeVisible();
    expect(team).toHaveFocus();
  });

  it('lets an owner disconnect a connected repository while collection is not set up', async () => {
    server.enabled = false;
    const item = mapping();
    server.mappings = [item];
    server.results = [result(item)];
    mount();
    await chooseWorkspace();
    const view = await openMapping();
    expect(await view.findByText(/Collection is not set up for this workspace/)).toBeVisible();
    expect(view.queryByRole('button', { name: 'Collect this window' })).not.toBeInTheDocument();
    expect(view.queryByLabelText('Change owning team')).not.toBeInTheDocument();
    await userEvent.click(await view.findByRole('button', { name: 'Disconnect repository' }));
    expect(posts()).toHaveLength(0);
    await userEvent.click(view.getByRole('button', { name: 'Confirm disconnect' }));
    expect(await view.findByText('Disconnected')).toBeVisible();
    expect(posts()).toEqual([
      expect.objectContaining({
        path: `${base}/mappings/${mappingA}/disconnect`,
        body: { revision: 1 },
      }),
    ]);
    expect(view.getAllByRole('article')).toHaveLength(5);
  });

  it('keeps an unconfirmed window request ID after collecting another window', async () => {
    server.mappings = [mapping()];
    let attempts = 0;
    server.override = (call) => {
      if (call.method === 'POST' && call.path.endsWith('/runs')) {
        attempts += 1;
        if (attempts <= 2) return json({ error: 'unavailable' }, 503);
      }
      return undefined;
    };
    mount();
    await chooseWorkspace();
    const view = await openMapping();
    const collect = async () => {
      await userEvent.click(await view.findByRole('button', { name: 'Collect this window' }));
      await userEvent.click(view.getByRole('button', { name: 'Confirm collection' }));
    };
    await collect();
    expect(await view.findByText(/could not be confirmed/)).toBeVisible();
    const last = view.getByLabelText('Last day (UTC, inclusive)');
    fireEvent.change(last, { target: { value: '2026-10-11' } });
    await collect();
    await waitFor(() => expect(posts()).toHaveLength(2));
    fireEvent.change(last, { target: { value: '2026-10-12' } });
    await collect();
    expect(await view.findByText(/Collection queued\. Use Refresh/)).toBeVisible();
    const [a, b, again] = posts().map(
      (call) => call.body as { requestId: string; windowEnd: string },
    );
    expect(b?.windowEnd).toBe('2026-10-12T00:00:00.000Z');
    expect(b?.requestId).not.toBe(a?.requestId);
    expect(again?.windowEnd).toBe(a?.windowEnd);
    expect(again?.requestId).toBe(a?.requestId);
  });

  it('keeps an unconfirmed request ID when the repository is closed and reopened', async () => {
    server.mappings = [mapping()];
    let attempts = 0;
    server.override = (call) => {
      if (call.method === 'POST' && call.path.endsWith('/runs')) {
        attempts += 1;
        if (attempts === 1) return json({ error: 'unavailable' }, 503);
      }
      return undefined;
    };
    mount();
    await chooseWorkspace();
    let view = await openMapping();
    await userEvent.click(await view.findByRole('button', { name: 'Collect this window' }));
    await userEvent.click(view.getByRole('button', { name: 'Confirm collection' }));
    expect(await view.findByText(/could not be confirmed/)).toBeVisible();
    await userEvent.click(view.getByRole('button', { name: 'Close repository' }));
    expect(screen.queryByRole('heading', { name: 'acme/api' })).toBeNull();
    view = await openMapping();
    await userEvent.click(await view.findByRole('button', { name: 'Collect this window' }));
    await userEvent.click(view.getByRole('button', { name: 'Confirm collection' }));
    expect(await view.findByText(/Collection queued\. Use Refresh/)).toBeVisible();
    const [first, second] = posts().map((call) => call.body as { requestId: string });
    expect(second?.requestId).toBe(first?.requestId);
    // Reconciled by an accepted reply: a later deliberate collection is a new request.
    await userEvent.click(await view.findByRole('button', { name: 'Collect this window' }));
    await userEvent.click(view.getByRole('button', { name: 'Confirm collection' }));
    await waitFor(() => expect(posts()).toHaveLength(3));
    const [, , later] = posts().map((call) => call.body as { requestId: string });
    expect(later?.requestId).not.toBe(first?.requestId);
  });

  it('shares an unconfirmed setup collection request ID with the repository view', async () => {
    let attempts = 0;
    server.override = (call) => {
      if (call.method === 'POST' && call.path.endsWith('/runs')) {
        attempts += 1;
        if (attempts === 1) return json({ error: 'unavailable' }, 503);
      }
      return undefined;
    };
    mount();
    await chooseWorkspace();
    const view = await panel();
    await userEvent.click(await view.findByRole('button', { name: 'Connect a repository' }));
    const wizard = within(screen.getByRole('region', { name: 'Connect a GitHub repository' }));
    await userEvent.selectOptions(
      wizard.getByLabelText('GitHub installation'),
      'App 12 · installation 34 · Organization account 56',
    );
    await userEvent.selectOptions(wizard.getByLabelText('Repository'), 'Repository ID 123');
    await userEvent.selectOptions(wizard.getByLabelText('Owning team'), 'Platform');
    await userEvent.click(wizard.getByRole('button', { name: 'Next: scope and limits' }));
    await userEvent.click(
      wizard.getByLabelText('I have reviewed the scope, limits and attribution notes'),
    );
    await userEvent.click(wizard.getByRole('button', { name: 'Next: save and collect' }));
    await userEvent.click(wizard.getByRole('button', { name: 'Save connection' }));
    await userEvent.click(wizard.getByRole('button', { name: 'Confirm save' }));
    await userEvent.click(await wizard.findByRole('button', { name: 'Collect this window' }));
    await userEvent.click(wizard.getByRole('button', { name: 'Confirm collection' }));
    expect(await wizard.findByText(/could not be confirmed/)).toBeVisible();
    await userEvent.click(wizard.getByRole('button', { name: 'Done' }));
    const detail = await openMapping();
    await userEvent.click(await detail.findByRole('button', { name: 'Collect this window' }));
    await userEvent.click(detail.getByRole('button', { name: 'Confirm collection' }));
    expect(await detail.findByText(/Collection queued\. Use Refresh/)).toBeVisible();
    const [, first, second] = posts().map((call) => call.body as { requestId?: string });
    expect(first?.requestId).toEqual(expect.any(String));
    expect(second?.requestId).toBe(first?.requestId);
  });

  it('does not carry an unconfirmed request ID into another workspace scope', async () => {
    server.mappings = [mapping()];
    server.override = (call) =>
      call.method === 'POST' && call.path.endsWith('/runs')
        ? json({ error: 'unavailable' }, 503)
        : undefined;
    mount();
    await chooseWorkspace();
    let view = await openMapping();
    await userEvent.click(await view.findByRole('button', { name: 'Collect this window' }));
    await userEvent.click(view.getByRole('button', { name: 'Confirm collection' }));
    expect(await view.findByText(/could not be confirmed/)).toBeVisible();
    await chooseWorkspace(secondWorkspace);
    expect(await screen.findByText('No repositories connected yet.')).toBeVisible();
    await chooseWorkspace();
    view = await openMapping();
    await userEvent.click(await view.findByRole('button', { name: 'Collect this window' }));
    await userEvent.click(view.getByRole('button', { name: 'Confirm collection' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    const [first, second] = posts().map((call) => call.body as { requestId: string });
    expect(second?.requestId).not.toBe(first?.requestId);
  });
});
