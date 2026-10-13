import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/query-client';
import {
  archivedTeam,
  cancelledPulse,
  closedQuestions,
  draftPulse,
  historyId,
  instrumentBody,
  json,
  openPulse,
  type PulseFixture,
  pulse,
  pulseId,
  questionIds,
  suppressed,
  teamA,
  teamB,
  workspaceId,
} from './fixtures.test-support';
import { DeveloperExperiencePage } from './space-page';

const session = vi.hoisted(() => ({
  status: 'ready' as 'ready' | 'signed-out',
  revision: 1,
  valid: true,
  expire: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('../identity/session', () => ({
  useSession: () => ({
    status: session.status,
    user:
      session.status === 'ready'
        ? { id: 'alice', name: 'Alice', email: 'alice@example.test', emailVerified: true }
        : null,
    revision: session.revision,
    current: (revision: number) => session.valid && revision === session.revision,
    expire: session.expire,
    refresh: session.refresh,
  }),
}));

const secondWorkspace = '77777777-7777-4777-8777-777777777777';
type Call = { method: string; path: string; body: unknown };
type Override = (call: Call) => Response | Promise<Response> | undefined;
const server = {
  role: 'owner' as 'owner' | 'member',
  minimum: 3,
  pulses: [] as PulseFixture[],
  override: undefined as Override | undefined,
  calls: [] as Call[],
  /** False when the actor no longer belongs to the first workspace. */
  listed: true,
  workspacesStatus: 200,
};

function view(item: PulseFixture): PulseFixture {
  if (server.role === 'owner')
    return item.state === 'open' && item.submittedCount === null
      ? { ...item, submittedCount: 1 }
      : item;
  if (item.state === 'open') return { ...item, submittedCount: null };
  if (item.state === 'closed' && (item.submittedCount ?? 0) < item.minimumRespondents)
    return { ...item, submittedCount: null };
  return item;
}
function visible() {
  return server.pulses
    .filter((item) => server.role === 'owner' || item.state !== 'draft')
    .map(view);
}
function organization(id: string) {
  return {
    workspaceId: id,
    teams: [
      { id: teamA, workspaceId: id, name: 'Platform' },
      { id: teamB, workspaceId: id, name: 'Mobile' },
    ],
    products: [],
    services: [],
    assignments: [],
  };
}
async function respond(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const call: Call = {
    method: init?.method ?? 'GET',
    path: `${url.pathname}${url.search}`,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
  };
  server.calls.push(call);
  const overridden = server.override?.(call);
  if (overridden) return overridden;
  const base = `/api/workspaces/${workspaceId}/space`;
  if (call.path === '/api/workspaces')
    return server.workspacesStatus !== 200
      ? json({ error: 'unavailable' }, server.workspacesStatus)
      : json({
          workspaces: [
            ...(server.listed ? [{ id: workspaceId, name: 'Engineering', role: server.role }] : []),
            { id: secondWorkspace, name: 'Research', role: 'member' },
          ],
        });
  if (url.pathname === `/api/workspaces/${workspaceId}/organization`)
    return json(organization(workspaceId));
  if (url.pathname === `/api/workspaces/${secondWorkspace}/organization`)
    return json(organization(secondWorkspace));
  const space = url.pathname.startsWith(base)
    ? { scope: workspaceId, rest: url.pathname.slice(base.length) }
    : url.pathname.startsWith(`/api/workspaces/${secondWorkspace}/space`)
      ? {
          scope: secondWorkspace,
          rest: url.pathname.slice(`/api/workspaces/${secondWorkspace}/space`.length),
        }
      : null;
  if (url.pathname === `/api/workspaces/${workspaceId}/members`)
    return json({
      workspaceId,
      members: [
        {
          userId: 'alice',
          name: 'Alice',
          email: 'a@example.test',
          role: 'owner',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          userId: 'bo',
          name: 'Bo',
          email: 'b@example.test',
          role: 'member',
          createdAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
  if (!space) return json({ error: 'not_found' }, 404);
  const { scope, rest } = space;
  if (rest === '/instrument') return json(instrumentBody());
  if (rest === '/preferences')
    return json({ workspaceId: scope, minimumRespondents: server.minimum });
  if (rest === '/assignment')
    return json({
      workspaceId: scope,
      teamId: teamA,
      teamName: 'Platform',
      history: [
        {
          id: historyId(1),
          teamId: teamA,
          teamName: 'Platform',
          changedAt: '2026-09-01T09:30:00.000Z',
        },
      ],
      nextCursor: null,
    });
  if (rest === '/assignments')
    return json({
      workspaceId: scope,
      assignments: [
        { userId: 'alice', teamId: teamA, teamName: 'Platform' },
        { userId: 'bo', teamId: null, teamName: null },
      ],
      nextCursor: null,
    });
  if (rest === '/pulses' && call.method === 'GET') {
    const team = url.searchParams.get('teamId');
    const items = scope === workspaceId ? visible() : [];
    return json({
      workspaceId: scope,
      pulses: team ? items.filter((item) => item.teamId === team) : items,
      nextCursor: null,
    });
  }
  const detail = /^\/pulses\/([0-9a-f-]+)$/.exec(rest);
  if (detail && call.method === 'GET') {
    const found = visible().find((item) => item.id === detail[1]);
    return found ? json({ pulse: found }) : json({ error: 'not_found' }, 404);
  }
  return json({ error: 'not_found' }, 404);
}

const fetchMock = vi.fn(respond);
const now = () => new Date('2026-10-13T12:00:00.000Z');
function mount() {
  const client = createQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <DeveloperExperiencePage now={now} />
    </QueryClientProvider>,
  );
}
async function chooseWorkspace(id = workspaceId) {
  fireEvent.change(await screen.findByLabelText('Workspace'), { target: { value: id } });
}
async function chooseTeam(id: string) {
  fireEvent.change(await screen.findByLabelText('Team'), { target: { value: id } });
}
function posts(path: string) {
  return server.calls.filter((call) => call.method !== 'GET' && call.path.endsWith(path));
}
function deferred() {
  let resolve: (value: Response) => void = () => {};
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  session.status = 'ready';
  session.revision = 1;
  session.valid = true;
  session.expire.mockReset();
  session.refresh.mockReset();
  server.role = 'owner';
  server.minimum = 3;
  server.pulses = [];
  server.override = undefined;
  server.calls = [];
  server.listed = true;
  server.workspacesStatus = 200;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

describe('Developer experience access', () => {
  it('asks signed-out visitors to sign in without private reads', () => {
    session.status = 'signed-out';
    mount();
    expect(screen.getByRole('heading', { name: 'Developer experience', level: 1 })).toBeVisible();
    expect(screen.getByText('Sign in with GitHub to view team pulses.')).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('expires the session on a 401 private read', async () => {
    server.override = (call) =>
      call.path.endsWith('/space/preferences') ? json({ error: 'unauthorized' }, 401) : undefined;
    mount();
    await chooseWorkspace();
    await waitFor(() => expect(session.expire).toHaveBeenCalledWith(1));
  });

  it('hides private scope when a denied read follows real membership loss', async () => {
    server.pulses = [openPulse()];
    mount();
    await chooseWorkspace();
    await chooseTeam(teamA);
    server.override = (call) =>
      call.path.endsWith(`/pulses/${pulseId(2)}`) ? json({ error: 'not_found' }, 404) : undefined;
    server.listed = false;
    fireEvent.click(await screen.findByRole('button', { name: /^(View|Respond to) pulse for/ }));
    expect(
      await screen.findByText(
        'This workspace is no longer available to you. Choose another workspace.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Owner tools' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Your primary team' })).not.toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('removes owner controls when a denied write reveals a role change', async () => {
    server.pulses = [openPulse({ submittedCount: 1 })];
    mount();
    await chooseWorkspace();
    expect(await screen.findByRole('heading', { name: 'Owner tools' })).toBeVisible();
    await chooseTeam(teamA);
    fireEvent.click(await screen.findByRole('button', { name: /^(View|Respond to) pulse for/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Close pulse' }));
    server.override = (call) => {
      if (call.path.endsWith('/close')) {
        server.role = 'member';
        return json({ error: 'forbidden' }, 403);
      }
      return undefined;
    };
    fireEvent.click(screen.getByRole('button', { name: 'Confirm close pulse' }));
    expect(
      await screen.findByText(/Showing what your current role \(member\) can see/),
    ).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Your primary team' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Close pulse' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Owner tools' })).not.toBeInTheDocument();
  });

  it('drops a late write reply after the workspace selection changes', async () => {
    mount();
    await chooseWorkspace();
    const pending = deferred();
    server.override = (call) => (call.method === 'PATCH' ? pending.promise : undefined);
    const minimum = await screen.findByLabelText(/Minimum answers before a question result/);
    fireEvent.change(minimum, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save minimum' }));
    await waitFor(() => expect(posts('/preferences')).toHaveLength(1));
    await chooseWorkspace(secondWorkspace);
    await act(async () => {
      pending.resolve(json({ workspaceId, minimumRespondents: 5 }));
      await pending.promise;
    });
    expect(screen.queryByText(/Minimum saved/)).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Your primary team' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Owner tools' })).not.toBeInTheDocument();
  });

  it('ignores a write reply that completes after the session revision changes', async () => {
    mount();
    await chooseWorkspace();
    const pending = deferred();
    server.override = (call) => (call.method === 'PATCH' ? pending.promise : undefined);
    fireEvent.change(await screen.findByLabelText(/Minimum answers before a question result/), {
      target: { value: '4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save minimum' }));
    await waitFor(() => expect(posts('/preferences')).toHaveLength(1));
    session.valid = false;
    await act(async () => {
      pending.resolve(json({ workspaceId, minimumRespondents: 4 }));
      await pending.promise;
    });
    expect(screen.queryByText(/Minimum saved/)).not.toBeInTheDocument();
  });
});

describe('selection fences', () => {
  it('drops a close reply after another pulse is selected', async () => {
    server.pulses = [
      openPulse({ submittedCount: 1 }),
      cancelledPulse({
        referenceStart: '2026-08-01T00:00:00.000Z',
        referenceEnd: '2026-08-15T00:00:00.000Z',
      }),
    ];
    const pending = deferred();
    server.override = (call) => (call.path.endsWith('/close') ? pending.promise : undefined);
    mount();
    await chooseWorkspace();
    await chooseTeam(teamA);
    const [openRow, cancelledRow] = await screen.findAllByRole('button', {
      name: /^(View|Respond to) pulse for/,
    });
    fireEvent.click(openRow as HTMLElement);
    fireEvent.click(await screen.findByRole('button', { name: 'Close pulse' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm close pulse' }));
    await waitFor(() => expect(posts('/close')).toHaveLength(1));
    fireEvent.click(cancelledRow as HTMLElement);
    await act(async () => {
      pending.resolve(
        json({
          pulse: pulse({
            id: pulseId(2),
            referenceStart: '2026-09-29T00:00:00.000Z',
            referenceEnd: '2026-10-13T00:00:00.000Z',
            openedAt: '2026-10-13T08:00:00.000Z',
            closedAt: '2026-10-13T11:00:00.000Z',
          }),
        }),
      );
      await pending.promise;
    });
    expect(
      await screen.findByText('Cancelled pulses publish no participation counts or results.', {
        selector: 'dd',
      }),
    ).toBeVisible();
    expect(screen.queryByText('Pulse closed. Its results are now fixed.')).not.toBeInTheDocument();
  });

  it('never shows a pulse page that arrives after the workspace changed', async () => {
    server.pulses = [pulse()];
    const pending = deferred();
    server.override = (call) =>
      call.method === 'GET' && call.path === `/api/workspaces/${workspaceId}/space/pulses`
        ? pending.promise
        : undefined;
    mount();
    await chooseWorkspace();
    await waitFor(() =>
      expect(server.calls.some((call) => call.path.endsWith(`${workspaceId}/space/pulses`))).toBe(
        true,
      ),
    );
    await chooseWorkspace(secondWorkspace);
    await act(async () => {
      pending.resolve(json({ workspaceId, pulses: [pulse()], nextCursor: null }));
      await pending.promise;
    });
    const summaries = await screen.findByRole('region', { name: 'Engineering team summaries' });
    expect(within(summaries).queryByText(/frozen roster submitted/)).not.toBeInTheDocument();
    expect(
      within(summaries).getAllByText('No closed pulse for this team on this page.'),
    ).toHaveLength(2);
  });
});

describe('Engineering team summaries', () => {
  it('shows teams side by side, including deleted original teams, without totals', async () => {
    server.role = 'member';
    server.pulses = [
      pulse({ id: pulseId(1), submittedCount: 5 }),
      pulse({
        id: pulseId(5),
        teamId: archivedTeam,
        teamName: 'Payments',
        submittedCount: null,
        questions: questionIds.map((id) => suppressed(id)),
      }),
    ];
    mount();
    await chooseWorkspace();
    const summaries = await screen.findByRole('region', { name: 'Engineering team summaries' });
    const cards = within(summaries)
      .getAllByRole('listitem')
      .filter((item) => item.classList.contains('space-team-card'));
    expect(cards.map((card) => within(card).getByRole('heading').textContent)).toEqual([
      'Platform',
      'Mobile',
      'Payments',
    ]);
    expect(
      within(cards[0] as HTMLElement).getByText('5 of 6 frozen roster submitted.'),
    ).toBeVisible();
    expect(within(cards[2] as HTMLElement).getByText('Team deleted')).toBeVisible();
    expect(
      within(cards[2] as HTMLElement).getByText('Participation withheld: fewer than 3 submitted.'),
    ).toBeVisible();
    expect(
      within(cards[1] as HTMLElement).getByText('No closed pulse for this team on this page.'),
    ).toBeVisible();
    expect(summaries).not.toHaveTextContent(/overall|total score|productivity score|%/i);
    fireEvent.click(
      within(cards[2] as HTMLElement).getByRole('button', { name: 'View Payments pulses' }),
    );
    expect(
      await screen.findByRole('heading', { name: /Payments.*Team deleted/, level: 2 }),
    ).toHaveFocus();
    expect(screen.queryByRole('heading', { name: 'Owner tools' })).not.toBeInTheDocument();
  });

  it('keeps deleted teams selectable and pages their archived history', async () => {
    const first = Array.from({ length: 25 }, (_, index) =>
      cancelledPulse({
        id: pulseId(100 + index),
        teamId: archivedTeam,
        teamName: 'Payments',
      }),
    );
    server.pulses = first;
    server.override = (call) => {
      if (!call.path.includes(`teamId=${archivedTeam}`)) return undefined;
      return call.path.includes('cursor=')
        ? json({
            workspaceId,
            pulses: [
              pulse({ id: pulseId(200), teamId: archivedTeam, teamName: 'Payments Legacy' }),
            ],
            nextCursor: null,
          })
        : json({ workspaceId, pulses: first, nextCursor: pulseId(124) });
    };
    mount();
    await chooseWorkspace();
    const selector = await screen.findByLabelText('Team');
    selector.focus();
    fireEvent.change(selector, { target: { value: archivedTeam } });
    expect(await screen.findByRole('heading', { name: /Payments.*Team deleted/ })).toBeVisible();
    expect(selector).toHaveFocus();
    expect(
      await screen.findByText(/Older pulses are on later pages and are not included\./),
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Older team pulses' }));
    expect(await screen.findByText(/No older pulses for this team\./)).toBeVisible();
    expect(
      server.calls.some((call) =>
        call.path.endsWith(`/pulses?teamId=${archivedTeam}&cursor=${pulseId(124)}`),
      ),
    ).toBe(true);
    const table = screen.getByRole('table', { name: /Up to 25 pulses per page/ });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('Payments Legacy')).toBeVisible();
  });

  it('groups closed question means by dimension and explains suppression', async () => {
    server.role = 'member';
    server.pulses = [pulse()];
    mount();
    await chooseWorkspace();
    await chooseTeam(teamA);
    const results = await screen.findByRole('list', {
      name: 'Results by SPACE dimension for Platform',
    });
    const cards = within(results)
      .getAllByRole('heading', { level: 4 })
      .map((item) => item.textContent);
    expect(cards).toEqual([
      'Satisfaction and well-being',
      'Performance',
      'Activity',
      'Communication and collaboration',
      'Efficiency and flow',
    ]);
    expect(
      within(results).getByText('Descriptive frequency: higher is not better or worse.'),
    ).toBeVisible();
    expect(
      within(results).getByText('Fewer than 3 answered this question. The count is withheld.'),
    ).toBeVisible();
    expect(within(results).getAllByText('4 answered of 6 · minimum 3')).toHaveLength(7);
    const chart = screen.getByRole('img', { name: /I felt satisfied with my work/ });
    expect(chart.querySelectorAll('circle')).toHaveLength(1);
  });
});

describe('Owner pulse setup', () => {
  it('saves a default draft, reviews live roster and keeps it after an open conflict', async () => {
    const user = userEvent.setup();
    const created = draftPulse({ id: pulseId(30), rosterSize: 2 });
    server.override = (call) => {
      if (call.method === 'POST' && call.path.endsWith('/space/pulses')) {
        server.pulses = [created];
        return json({ pulse: created }, 201);
      }
      if (call.path.endsWith(`/pulses/${pulseId(30)}/open`))
        return posts('/open').length === 1
          ? json({ error: 'conflict' }, 409)
          : json({
              pulse: openPulse({
                id: pulseId(30),
                rosterSize: 2,
                submittedCount: 0,
                eligible: true,
              }),
            });
      return undefined;
    };
    mount();
    await chooseWorkspace();
    await user.click(await screen.findByRole('button', { name: 'Set up a pulse' }));
    expect(posts('/pulses')).toHaveLength(0);
    expect(screen.getByRole('heading', { name: 'Step 1 of 4: Team' })).toHaveFocus();
    const wizard = screen.getByRole('region', { name: 'Set up a team pulse' });
    expect(within(wizard).getByRole('button', { name: 'Next: period and roster' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    fireEvent.change(within(wizard).getByLabelText('Team'), { target: { value: teamA } });
    await user.click(within(wizard).getByRole('button', { name: 'Next: period and roster' }));
    expect(screen.getByRole('heading', { name: 'Step 2 of 4: Period and roster' })).toHaveFocus();
    expect(within(wizard).getByLabelText('First day (UTC)')).toHaveValue('2026-09-29');
    expect(within(wizard).getByLabelText('Last day (UTC, inclusive)')).toHaveValue('2026-10-12');
    expect(within(wizard).getByRole('button', { name: 'Next: preview questions' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.click(within(wizard).getByRole('button', { name: 'Save draft' }));
    expect(await within(wizard).findByText('2 currently assigned members')).toBeVisible();
    expect(posts('/pulses')[0]?.body).toEqual({
      teamId: teamA,
      referenceStart: '2026-09-29T00:00:00.000Z',
      referenceEnd: '2026-10-13T00:00:00.000Z',
    });
    expect(
      within(wizard).getByText(
        /every question result will remain suppressed because the roster cannot grow/,
      ),
    ).toBeVisible();
    await user.click(within(wizard).getByRole('button', { name: 'Next: preview questions' }));
    for (const prompt of [
      'I felt satisfied with my work.',
      'I had enough uninterrupted time for focused work.',
    ])
      expect(within(wizard).getByText(prompt)).toBeVisible();
    expect(
      within(wizard)
        .getAllByRole('listitem')
        .filter((item) => item.closest('.space-preview')),
    ).toHaveLength(8);
    await user.click(within(wizard).getByRole('button', { name: 'Next: open' }));
    await user.click(within(wizard).getByRole('button', { name: 'Open pulse for responses' }));
    expect(await within(wizard).findByText(/Your draft is still saved/)).toBeVisible();
    expect(posts('/pulses')).toHaveLength(1);
    await user.click(within(wizard).getByRole('button', { name: 'Open pulse for responses' }));
    expect(await screen.findByRole('heading', { name: 'Pulse opened for Platform' })).toHaveFocus();
    expect(posts('/pulses')).toHaveLength(1);
    expect(posts('/open')).toHaveLength(2);
    expect(posts('/open')[1]?.body).toEqual({});
  });

  it('blocks opening an empty roster', async () => {
    server.pulses = [draftPulse({ rosterSize: 0 })];
    mount();
    await chooseWorkspace();
    await chooseTeam(teamA);
    fireEvent.click(await screen.findByRole('button', { name: /^(View|Respond to) pulse for/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue setup' }));
    const wizard = screen.getByRole('region', { name: 'Continue pulse setup' });
    fireEvent.click(within(wizard).getByRole('button', { name: 'Next: period and roster' }));
    expect(
      within(wizard).getByText(
        'No members are assigned to this team. Assign primary teams before opening.',
      ),
    ).toBeVisible();
    fireEvent.click(within(wizard).getByRole('button', { name: 'Next: preview questions' }));
    fireEvent.click(within(wizard).getByRole('button', { name: 'Next: open' }));
    const open = within(wizard).getByRole('button', { name: 'Open pulse for responses' });
    expect(open).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(open);
    expect(posts('/open')).toHaveLength(0);
  });

  it('edits an existing draft through PATCH instead of creating a duplicate', async () => {
    const draft = draftPulse();
    server.pulses = [draft];
    server.override = (call) =>
      call.method === 'PATCH' && call.path.endsWith(`/pulses/${draft.id}`)
        ? json({
            pulse: {
              ...draft,
              referenceStart: '2026-09-22T00:00:00.000Z',
              referenceEnd: '2026-10-06T00:00:00.000Z',
            },
          })
        : undefined;
    mount();
    await chooseWorkspace();
    await chooseTeam(teamA);
    fireEvent.click(await screen.findByRole('button', { name: /^(View|Respond to) pulse for/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue setup' }));
    const wizard = screen.getByRole('region', { name: 'Continue pulse setup' });
    fireEvent.click(within(wizard).getByRole('button', { name: 'Next: period and roster' }));
    fireEvent.change(within(wizard).getByLabelText('First day (UTC)'), {
      target: { value: '2026-09-22' },
    });
    fireEvent.change(within(wizard).getByLabelText('Last day (UTC, inclusive)'), {
      target: { value: '2026-10-05' },
    });
    expect(within(wizard).getByText(/Changes are not saved yet/)).toBeVisible();
    fireEvent.click(within(wizard).getByRole('button', { name: 'Update draft' }));
    expect(
      await within(wizard).findByText('Draft saved. Review the live roster and minimum below.'),
    ).toBeVisible();
    expect(server.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    expect(posts(`/pulses/${draft.id}`)[0]).toMatchObject({
      method: 'PATCH',
      body: {
        teamId: teamA,
        referenceStart: '2026-09-22T00:00:00.000Z',
        referenceEnd: '2026-10-06T00:00:00.000Z',
      },
    });
  });

  it('rejects a reference period that includes today before saving', async () => {
    mount();
    await chooseWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Set up a pulse' }));
    const wizard = screen.getByRole('region', { name: 'Set up a team pulse' });
    fireEvent.change(within(wizard).getByLabelText('Team'), { target: { value: teamA } });
    fireEvent.click(within(wizard).getByRole('button', { name: 'Next: period and roster' }));
    fireEvent.change(within(wizard).getByLabelText('Last day (UTC, inclusive)'), {
      target: { value: '2026-10-13' },
    });
    fireEvent.click(within(wizard).getByRole('button', { name: 'Save draft' }));
    expect(within(wizard).getByRole('alert')).toHaveTextContent(
      'The reference period must end before today (UTC).',
    );
    expect(posts('/pulses')).toHaveLength(0);
  });

  it('closes an open pulse only after explicit confirmation and shows exact owner counts', async () => {
    server.pulses = [openPulse({ submittedCount: 2 })];
    server.override = (call) =>
      call.path.endsWith('/close')
        ? json({
            pulse: pulse({
              id: pulseId(2),
              referenceStart: '2026-09-29T00:00:00.000Z',
              referenceEnd: '2026-10-13T00:00:00.000Z',
              openedAt: '2026-10-13T08:00:00.000Z',
              closedAt: '2026-10-13T11:00:00.000Z',
              submitted: false,
              submittedCount: 2,
              questions: questionIds.map((id) => suppressed(id)),
            }),
          })
        : undefined;
    mount();
    await chooseWorkspace();
    await chooseTeam(teamA);
    fireEvent.click(await screen.findByRole('button', { name: /^(View|Respond to) pulse for/ }));
    const detail = await screen.findByRole('article');
    expect(within(detail).getByText('2 of 6 frozen roster submitted so far.')).toBeVisible();
    fireEvent.click(within(detail).getByRole('button', { name: 'Close pulse' }));
    expect(within(detail).getByRole('button', { name: 'Confirm close pulse' })).toHaveFocus();
    fireEvent.click(within(detail).getByRole('button', { name: 'Keep pulse open' }));
    expect(posts('/close')).toHaveLength(0);
    fireEvent.click(within(detail).getByRole('button', { name: 'Close pulse' }));
    fireEvent.click(within(detail).getByRole('button', { name: 'Confirm close pulse' }));
    expect(await screen.findByText('Pulse closed. Its results are now fixed.')).toBeVisible();
    expect(posts('/close')[0]?.body).toEqual({});
  });

  it('assigns current members to primary teams using member names', async () => {
    server.override = (call) =>
      call.method === 'POST' && call.path.endsWith('/assignments/bo')
        ? json({ workspaceId, assignment: { userId: 'bo', teamId: teamB, teamName: 'Mobile' } })
        : undefined;
    mount();
    await chooseWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Manage primary teams' }));
    const select = await screen.findByLabelText('Primary team for Bo');
    fireEvent.change(select, { target: { value: teamB } });
    fireEvent.click(screen.getByRole('button', { name: 'Save primary team for Bo' }));
    expect(await screen.findByText(/Primary team saved for Bo: Mobile/)).toBeVisible();
    expect(posts('/assignments/bo')[0]?.body).toEqual({ teamId: teamB });
  });
});

describe('Member pulse response', () => {
  beforeEach(() => {
    server.role = 'member';
    server.pulses = [openPulse({ eligible: true })];
  });

  async function openForm() {
    mount();
    await chooseWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: /Respond to Platform pulse/ }));
    return screen.findByRole('region', { name: 'Your response' });
  }

  it('shows frozen context, hides counts and defaults every item to prefer not to answer', async () => {
    const form = await openForm();
    const detail = screen.getByRole('article');
    expect(
      within(detail).getByText(
        'Participation counts are visible only to workspace owners while the pulse is open.',
      ),
    ).toBeVisible();
    expect(within(form).getByText('Frozen roster size').nextElementSibling).toHaveTextContent('6');
    expect(within(form).getByText(/This is not a promise of anonymity/)).toBeVisible();
    const history = within(form).getByRole('region', { name: 'Your primary team' });
    expect(await within(history).findByText('Assigned to Platform')).toBeInTheDocument();
    const groups = within(form)
      .getAllByRole('group')
      .filter((item) => item.tagName === 'FIELDSET');
    expect(groups).toHaveLength(8);
    for (const group of groups)
      expect(
        within(group).getByRole('radio', { name: 'Prefer not to answer / not applicable' }),
      ).toBeChecked();
    expect(screen.queryByRole('button', { name: 'Close pulse' })).not.toBeInTheDocument();
  });

  it('confirms before submitting, retries safely and clears answers after acceptance', async () => {
    const user = userEvent.setup();
    const form = await openForm();
    const satisfaction = within(form).getByRole('group', {
      name: 'I felt satisfied with my work.',
    });
    await user.click(within(satisfaction).getByRole('radio', { name: '4 Agree' }));
    const activity = within(form).getByRole('group', { name: /How frequently did you contribute/ });
    await user.click(within(activity).getByRole('radio', { name: '2 Rarely' }));
    await user.click(within(form).getByRole('button', { name: 'Review response' }));
    expect(screen.getByRole('heading', { name: 'Review your response' })).toHaveFocus();
    expect(posts('/response')).toHaveLength(0);
    let attempts = 0;
    server.override = (call) => {
      if (!call.path.endsWith('/response')) return undefined;
      attempts += 1;
      if (attempts === 1) return json({ error: 'unavailable' }, 503);
      server.pulses = [openPulse({ eligible: true, submitted: true })];
      return json({ workspaceId, pulseId: pulseId(2), submitted: true });
    };
    await user.click(screen.getByRole('button', { name: 'Submit response' }));
    const failure = await screen.findByRole('alert');
    expect(failure).toHaveTextContent('Your response was not confirmed.');
    expect(failure).toHaveTextContent(
      'If an earlier attempt was accepted, retries keep that original response.',
    );
    expect(failure).not.toHaveTextContent(/Agree|Rarely|4|2/);
    await user.click(screen.getByRole('button', { name: 'Retry submission' }));
    expect(
      await screen.findByText(
        'Response submitted. Your answers are not shown again and cannot be changed.',
      ),
    ).toBeVisible();
    const expected = {
      instrumentVersion: 'clio.space.pulse.v1',
      answers: {
        satisfaction: 4,
        sustainable_workload: null,
        useful_outcomes: null,
        contribution_frequency: 2,
        useful_help: null,
        shared_context: null,
        effective_tools: null,
        focus_time: null,
      },
    };
    expect(posts('/response').map((call) => call.body)).toEqual([expected, expected]);
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: /Your response|Review your response/ }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByText('4 Agree')).not.toBeInTheDocument();
    expect(
      screen.getByText('You have responded to this pulse. Answers cannot be viewed or changed.'),
    ).toBeVisible();
  });

  it('allows an all-skipped response that records participation only', async () => {
    const form = await openForm();
    fireEvent.click(within(form).getByRole('button', { name: 'Review response' }));
    expect(
      screen.getByText(
        'You skipped every item. Submitting records that you took part, but no question values.',
      ),
    ).toBeVisible();
    server.override = (call) =>
      call.path.endsWith('/response')
        ? json({ workspaceId, pulseId: pulseId(2), submitted: true })
        : undefined;
    fireEvent.click(screen.getByRole('button', { name: 'Submit response' }));
    await screen.findByText(/Response submitted\. Your answers are not shown again/);
    expect(posts('/response')[0]?.body).toEqual({
      instrumentVersion: 'clio.space.pulse.v1',
      answers: Object.fromEntries(questionIds.map((id) => [id, null])),
    });
  });

  it('explains that members moved in after opening are not on the frozen roster', async () => {
    server.pulses = [openPulse({ eligible: false })];
    mount();
    await chooseWorkspace();
    await chooseTeam(teamA);
    expect(
      screen.queryByRole('region', { name: 'Pulses awaiting your response' }),
    ).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /^(View|Respond to) pulse for/ }));
    expect(await screen.findByText(/You are not on this pulse.s frozen roster/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Review response' })).not.toBeInTheDocument();
  });

  it('keeps responding eligible members who moved team after opening', async () => {
    // The actor's current primary team is Platform; the frozen Mobile roster still includes them.
    server.pulses = [openPulse({ eligible: true, teamId: teamB, teamName: 'Mobile' })];
    mount();
    await chooseWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: /Respond to Mobile pulse/ }));
    const form = await screen.findByRole('region', { name: 'Your response' });
    expect(within(form).getByText('Team at opening').nextElementSibling).toHaveTextContent(
      'Mobile',
    );
    expect(
      await within(form).findByText('Platform', { selector: '.space-own-current' }),
    ).toBeVisible();
  });
});

describe('closed result privacy', () => {
  it('rejects responses that leak suppressed counts instead of displaying them', async () => {
    server.role = 'member';
    server.pulses = [
      pulse({
        questions: closedQuestions().map((item) =>
          item.questionId === 'focus_time' ? { ...item, answeredCount: 1, mean: null } : item,
        ),
      }),
    ];
    mount();
    await chooseWorkspace();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The response could not be verified.',
    );
    expect(screen.queryByText(/answered of/)).not.toBeInTheDocument();
  });
});

function workspaceReads() {
  return server.calls.filter((call) => call.path === '/api/workspaces').length;
}
const accessText = /no longer available with your current access/;

describe('local target changes keep the SPACE scope', () => {
  it('recovers the newest member page when an older cursor member was deleted', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      userId: `user-${index.toString().padStart(3, '0')}`,
      teamId: null,
      teamName: null,
    }));
    const members = rows.map((row, index) => ({
      userId: row.userId,
      name: `Member ${index}`,
      email: `m${index}@example.test`,
      role: 'member',
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
    server.override = (call) => {
      if (
        call.path.includes('/space/assignments?cursor=') ||
        call.path.includes('/members?cursor=')
      )
        return json({ error: 'not_found' }, 404);
      if (call.path.endsWith('/space/assignments'))
        return json({ workspaceId, assignments: rows, nextCursor: 'user-099' });
      if (call.path.endsWith('/members'))
        return json({ workspaceId, members, hasMore: true, nextCursor: 'user-099' });
      return undefined;
    };
    mount();
    await chooseWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Set up a pulse' }));
    fireEvent.change(
      within(screen.getByRole('region', { name: 'Set up a team pulse' })).getByLabelText('Team'),
      { target: { value: teamB } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Manage primary teams' }));
    await screen.findByLabelText('Primary team for Member 99');
    fireEvent.click(screen.getByRole('button', { name: 'Next member page' }));
    expect(
      await screen.findByText('That member page is no longer available. Showing the first page.'),
    ).toBeVisible();
    expect(await screen.findByLabelText('Primary team for Member 0')).toBeVisible();
    expect(screen.queryByText(accessText)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Owner tools' })).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: 'Set up a team pulse' })).getByLabelText('Team'),
    ).toHaveValue(teamB);
  });

  it('reports a deleted assignment target locally', async () => {
    server.override = (call) =>
      call.method === 'POST' && call.path.endsWith('/assignments/bo')
        ? json({ error: 'not_found' }, 404)
        : undefined;
    mount();
    await chooseWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Manage primary teams' }));
    fireEvent.change(await screen.findByLabelText('Primary team for Bo'), {
      target: { value: teamB },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save primary team for Bo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This member or team is no longer available. The member list has been refreshed.',
    );
    expect(screen.queryByText(accessText)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Owner tools' })).toBeVisible();
  });

  it('keeps the wizard and its inputs when the chosen team was deleted', async () => {
    server.override = (call) =>
      call.method === 'POST' && call.path.endsWith('/space/pulses')
        ? json({ error: 'not_found' }, 404)
        : undefined;
    mount();
    await chooseWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Set up a pulse' }));
    const wizard = screen.getByRole('region', { name: 'Set up a team pulse' });
    fireEvent.change(within(wizard).getByLabelText('Team'), { target: { value: teamA } });
    fireEvent.click(within(wizard).getByRole('button', { name: 'Next: period and roster' }));
    fireEvent.change(within(wizard).getByLabelText('First day (UTC)'), {
      target: { value: '2026-09-30' },
    });
    fireEvent.click(within(wizard).getByRole('button', { name: 'Save draft' }));
    expect(await within(wizard).findByRole('alert')).toHaveTextContent(
      'This team is no longer available. Choose a current team.',
    );
    expect(screen.queryByText(accessText)).not.toBeInTheDocument();
    expect(within(wizard).getByLabelText('First day (UTC)')).toHaveValue('2026-09-30');
  });
});

describe('role revalidation on verified reads', () => {
  it('remounts as owner when a 200 read shows owner-only counts after promotion', async () => {
    server.role = 'member';
    server.pulses = [openPulse({ eligible: false })];
    mount();
    await chooseWorkspace();
    await screen.findByRole('heading', { name: 'Your primary team' });
    expect(screen.queryByRole('heading', { name: 'Owner tools' })).not.toBeInTheDocument();
    server.role = 'owner';
    await chooseTeam(teamA);
    expect(await screen.findByRole('heading', { name: 'Owner tools' })).toBeVisible();
    expect(screen.getByText(/Showing what your current role \(owner\) can see/)).toBeVisible();
    expect(screen.queryByText('The response could not be verified. Please try again.')).toBeNull();
  });

  it('removes owner controls when a 200 read shows member counts after demotion', async () => {
    server.pulses = [openPulse({ submittedCount: 1 })];
    mount();
    await chooseWorkspace();
    expect(await screen.findByRole('heading', { name: 'Owner tools' })).toBeVisible();
    server.role = 'member';
    await chooseTeam(teamA);
    expect(
      await screen.findByText(/Showing what your current role \(member\) can see/),
    ).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Owner tools' })).not.toBeInTheDocument();
  });

  it('fails closed when role metadata cannot be revalidated', async () => {
    server.pulses = [openPulse({ submittedCount: 1 })];
    mount();
    await chooseWorkspace();
    expect(await screen.findByRole('heading', { name: 'Owner tools' })).toBeVisible();
    server.role = 'member';
    server.workspacesStatus = 503;
    await chooseTeam(teamA);
    expect(await screen.findByRole('button', { name: 'Retry workspaces' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Owner tools' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Your primary team' })).not.toBeInTheDocument();
  });

  it('still rejects a malformed count once when the role is unchanged', async () => {
    server.pulses = [openPulse({ submittedCount: 1 })];
    mount();
    await chooseWorkspace();
    expect(await screen.findByRole('heading', { name: 'Owner tools' })).toBeVisible();
    const before = workspaceReads();
    server.override = (call) =>
      call.path.includes(`/space/pulses?teamId=${teamA}`)
        ? json({ workspaceId, pulses: [openPulse({ submittedCount: null })], nextCursor: null })
        : undefined;
    await chooseTeam(teamA);
    expect(
      await screen.findByText('The response could not be verified. Please try again.'),
    ).toBeVisible();
    await waitFor(() => expect(workspaceReads()).toBe(before + 1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(workspaceReads()).toBe(before + 1);
    expect(screen.getByRole('heading', { name: 'Owner tools' })).toBeVisible();
    expect(screen.queryByText(/2 of 6|1 of 6/)).not.toBeInTheDocument();
  });
});

describe('wizard live draft preview', () => {
  async function continueDraft() {
    mount();
    await chooseWorkspace();
    await chooseTeam(teamA);
    fireEvent.click(await screen.findByRole('button', { name: /^(View|Respond to) pulse for/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue setup' }));
    return screen.getByRole('region', { name: 'Continue pulse setup' });
  }

  it('enables opening after a member is assigned while the wizard stays mounted', async () => {
    const draft = draftPulse({ rosterSize: 0 });
    server.pulses = [draft];
    server.override = (call) => {
      if (call.method === 'POST' && call.path.endsWith('/assignments/bo')) {
        server.pulses = [{ ...draft, rosterSize: 1 }];
        return json({
          workspaceId,
          assignment: { userId: 'bo', teamId: teamA, teamName: 'Platform' },
        });
      }
      if (call.path.endsWith(`/pulses/${draft.id}/open`))
        return json({
          pulse: openPulse({ id: draft.id, rosterSize: 1, submittedCount: 0, eligible: false }),
        });
      return undefined;
    };
    const wizard = await continueDraft();
    for (const label of ['Next: period and roster', 'Next: preview questions', 'Next: open'])
      fireEvent.click(within(wizard).getByRole('button', { name: label }));
    expect(
      within(wizard).getByRole('button', { name: 'Open pulse for responses' }),
    ).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Manage primary teams' }));
    fireEvent.change(await screen.findByLabelText('Primary team for Bo'), {
      target: { value: teamA },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save primary team for Bo' }));
    expect(await within(wizard).findByText('1 currently assigned member')).toBeVisible();
    expect(within(wizard).queryByText(/No members are assigned/)).not.toBeInTheDocument();
    expect(within(wizard).getByText(/smaller than the minimum \(3\)/)).toBeVisible();
    const open = within(wizard).getByRole('button', { name: 'Open pulse for responses' });
    expect(open).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(open);
    expect(await screen.findByRole('heading', { name: 'Pulse opened for Platform' })).toBeVisible();
  });

  it('reflects a new minimum without discarding unsaved dates and freezes the latest value', async () => {
    const draft = draftPulse({ rosterSize: 4 });
    server.pulses = [draft];
    server.override = (call) => {
      if (call.method === 'PATCH' && call.path.endsWith('/preferences')) {
        server.minimum = 5;
        server.pulses = [{ ...draft, minimumRespondents: 5 }];
        return json({ workspaceId, minimumRespondents: 5 });
      }
      if (call.path.endsWith(`/pulses/${draft.id}/open`))
        return json({
          pulse: openPulse({
            id: draft.id,
            rosterSize: 4,
            minimumRespondents: 5,
            submittedCount: 0,
            eligible: false,
          }),
        });
      return undefined;
    };
    const wizard = await continueDraft();
    fireEvent.click(within(wizard).getByRole('button', { name: 'Next: period and roster' }));
    fireEvent.change(within(wizard).getByLabelText('First day (UTC)'), {
      target: { value: '2026-09-28' },
    });
    fireEvent.change(screen.getByLabelText(/Minimum answers before a question result/), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save minimum' }));
    await screen.findByText(/Minimum saved: 5/);
    await waitFor(() =>
      expect(
        server.calls.filter(
          (call) => call.method === 'GET' && call.path.endsWith(`/pulses/${draft.id}`),
        ).length,
      ).toBeGreaterThanOrEqual(2),
    );
    expect(within(wizard).getByLabelText('First day (UTC)')).toHaveValue('2026-09-28');
    expect(within(wizard).getByText(/Changes are not saved yet/)).toBeVisible();
    expect(within(wizard).getByRole('button', { name: 'Next: preview questions' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    fireEvent.change(within(wizard).getByLabelText('First day (UTC)'), {
      target: { value: '2026-09-29' },
    });
    expect(
      await within(wizard).findByText(/roster \(4\) is smaller than the minimum \(5\)/),
    ).toBeVisible();
    fireEvent.click(within(wizard).getByRole('button', { name: 'Next: preview questions' }));
    fireEvent.click(within(wizard).getByRole('button', { name: 'Next: open' }));
    fireEvent.click(within(wizard).getByRole('button', { name: 'Open pulse for responses' }));
    expect(await within(wizard).findByText(/minimum of 5/)).toBeVisible();
  });

  it('stops opening when the saved draft was opened elsewhere', async () => {
    const draft = draftPulse({ rosterSize: 4 });
    server.pulses = [draft];
    const wizard = await continueDraft();
    for (const label of ['Next: period and roster', 'Next: preview questions', 'Next: open'])
      fireEvent.click(within(wizard).getByRole('button', { name: label }));
    // Let the wizard's first live read of the draft settle before the server state changes.
    await waitFor(() =>
      expect(server.calls.filter((call) => call.path.endsWith(`/pulses/${draft.id}`))).toHaveLength(
        2,
      ),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    server.pulses = [
      openPulse({ id: draft.id, rosterSize: 4, submittedCount: 0, eligible: false }),
    ];
    fireEvent.click(within(wizard).getByRole('button', { name: 'Refresh roster and minimum' }));
    expect(
      await within(wizard).findByText(
        'This draft was opened elsewhere. Close setup and check the pulse list.',
      ),
    ).toBeVisible();
    expect(within(wizard).queryByRole('button', { name: 'Open pulse for responses' })).toBeNull();
    expect(posts('/open')).toHaveLength(0);
  });
});

describe('captured context labels', () => {
  it('labels cancelled pulses that never opened without claiming a frozen roster', async () => {
    server.role = 'member';
    server.pulses = [cancelledPulse({ openedAt: null, rosterSize: 5 })];
    mount();
    await chooseWorkspace();
    await chooseTeam(teamA);
    fireEvent.click(await screen.findByRole('button', { name: /^View pulse for/ }));
    const detail = await screen.findByRole('article');
    expect(within(detail).getByText('Team captured at cancellation')).toBeVisible();
    expect(
      within(detail).getByText('Team size captured at cancellation').nextElementSibling,
    ).toHaveTextContent('5');
    expect(within(detail).queryByText('Frozen roster size')).toBeNull();
    expect(within(detail).queryByText('Team at opening')).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Team name recorded' })).toBeVisible();
  });

  it('keeps frozen labels for cancelled pulses that had opened and live labels for drafts', async () => {
    server.pulses = [
      cancelledPulse(),
      draftPulse({
        referenceStart: '2026-10-05T00:00:00.000Z',
        referenceEnd: '2026-10-12T00:00:00.000Z',
      }),
    ];
    mount();
    await chooseWorkspace();
    await chooseTeam(teamA);
    const buttons = await screen.findAllByRole('button', { name: /^View pulse for/ });
    fireEvent.click(buttons[0] as HTMLElement);
    let detail = await screen.findByRole('article');
    expect(within(detail).getByText('Team at opening')).toBeVisible();
    expect(within(detail).getByText('Frozen roster size')).toBeVisible();
    fireEvent.click(buttons[1] as HTMLElement);
    await waitFor(() => expect(screen.getByRole('article')).not.toBe(detail));
    detail = await screen.findByRole('article');
    await within(detail).findByText('Roster preview');
    expect(within(detail).getByText('Team')).toBeVisible();
    expect(within(detail).queryByText('Team at opening')).toBeNull();
    expect(within(detail).queryByText('Frozen roster size')).toBeNull();
  });
});
