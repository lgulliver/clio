import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/query-client';
import { createAppRouter } from '../../router';
import {
  archivedTeam,
  cancelledPulse,
  draftPulse,
  instrumentBody,
  json,
  openPulse,
  type PulseFixture,
  pulse,
  pulseId,
  teamA,
  workspaceId,
} from '../space/fixtures.test-support';

const secondWorkspace = '77777777-7777-4777-8777-777777777777';
const hiddenWorkspace = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type Server = {
  signedIn: boolean;
  role: 'owner' | 'member';
  listed: boolean;
  /** Pulses the workspace history lists (newest page). */
  history: PulseFixture[];
  /** Pulses reachable by direct detail request, per workspace. */
  detail: Map<string, PulseFixture[]>;
  hold: Map<string, Promise<Response>>;
  paths: string[];
};
const server: Server = {
  signedIn: true,
  role: 'owner',
  listed: true,
  history: [],
  detail: new Map(),
  hold: new Map(),
  paths: [],
};

function org(id: string) {
  return {
    workspaceId: id,
    teams: [{ id: teamA, workspaceId: id, name: 'Platform' }],
    products: [],
    services: [],
    assignments: [],
  };
}
function respond(input: string | URL | Request): Response | Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const path = `${url.pathname}${url.search}`;
  server.paths.push(path);
  if (path === '/api/me')
    return server.signedIn
      ? json({
          user: {
            id: 'alice',
            name: 'Alice',
            email: 'alice@example.test',
            emailVerified: true,
            image: null,
          },
        })
      : json({ error: 'unauthorized' }, 401);
  if (path === '/api/workspaces')
    return json({
      workspaces: [
        ...(server.listed ? [{ id: workspaceId, name: 'Engineering', role: server.role }] : []),
        { id: secondWorkspace, name: 'Research', role: 'member' },
      ],
    });
  const match = /^\/api\/workspaces\/([0-9a-f-]+)\/(.*)$/.exec(url.pathname);
  const scope = match?.[1];
  const rest = match?.[2];
  if (!scope || rest === undefined) return json({ error: 'not_found' }, 404);
  if (scope !== workspaceId && scope !== secondWorkspace) return json({ error: 'not_found' }, 404);
  if (rest === 'organization') return json(org(scope));
  if (rest === 'space/instrument') return json(instrumentBody());
  if (rest === 'space/preferences') return json({ workspaceId: scope, minimumRespondents: 3 });
  if (rest === 'space/github/availability') return json({ workspaceId: scope, enabled: false });
  if (rest === 'space/assignment')
    return json({
      workspaceId: scope,
      teamId: null,
      teamName: null,
      history: [],
      nextCursor: null,
    });
  if (rest === 'space/pulses')
    return json({
      workspaceId: scope,
      pulses: scope === workspaceId ? server.history : [],
      nextCursor: null,
    });
  const detail = /^space\/pulses\/([0-9a-f-]+)$/.exec(rest);
  if (detail) {
    const held = server.hold.get(`${scope}/${detail[1]}`);
    if (held) return held;
    const found = server.detail.get(scope)?.find((item) => item.id === detail[1]);
    return found ? json({ pulse: found }) : json({ error: 'not_found' }, 404);
  }
  return json({ error: 'not_found' }, 404);
}

const fetchMock = vi.fn(respond);
function mount(path: string) {
  const client = createQueryClient();
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter(client, history);
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, history };
}
const link = (workspace: string, pulseId?: string) =>
  `/developer-experience?workspace=${workspace}${pulseId ? `&pulse=${pulseId}` : ''}`;
function spacePaths() {
  return server.paths.filter((path) => path.includes('/space/'));
}
function deferred() {
  let resolve: (value: Response) => void = () => {};
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const closedOld = pulse({ id: pulseId(9), teamName: 'Platform' });

beforeEach(() => {
  server.signedIn = true;
  server.role = 'owner';
  server.listed = true;
  server.history = [];
  server.detail = new Map();
  server.hold = new Map();
  server.paths = [];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

describe('notification link navigation', () => {
  it('opens a saved pulse that is absent from the current history page and moves focus to it', async () => {
    server.history = [openPulse()];
    server.detail.set(workspaceId, [closedOld]);
    mount(link(workspaceId, closedOld.id));
    const heading = await screen.findByRole('heading', { name: 'Pulse from your link' });
    expect(heading).toHaveFocus();
    expect(await screen.findByRole('article')).toHaveTextContent('Platform pulse');
    expect(screen.getByLabelText('Workspace')).toHaveValue(workspaceId);
    expect(screen.getByLabelText('Team')).toHaveValue('');
    expect(spacePaths()).toContain(`/api/workspaces/${workspaceId}/space/pulses/${closedOld.id}`);
  });

  it('opens a closed pulse whose team was deleted and whose history is empty', async () => {
    const orphan = pulse({ id: pulseId(8), teamId: archivedTeam, teamName: 'Retired squad' });
    server.history = [];
    server.detail.set(workspaceId, [orphan]);
    mount(link(workspaceId, orphan.id));
    expect(await screen.findByRole('heading', { name: /Retired squad pulse/ })).toBeVisible();
    expect(screen.getByLabelText('Team')).toHaveValue('');
  });

  it('shows an unavailable state for an unknown pulse without rendering other data', async () => {
    server.history = [openPulse()];
    mount(link(workspaceId, pulseId(99)));
    expect(await screen.findByText(/This pulse is not available/)).toBeVisible();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pulse from your link' })).toHaveFocus();
  });

  it('ignores malformed links and sends no private reads for them', async () => {
    const { router } = mount(
      `/developer-experience?workspace=${workspaceId}&pulse=../../admin&returnTo=https://evil.test`,
    );
    await screen.findByLabelText('Workspace');
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(await screen.findByLabelText('Workspace')).toHaveValue('');
    expect(screen.queryByRole('heading', { name: 'Pulse from your link' })).not.toBeInTheDocument();
    expect(spacePaths()).toEqual([]);
  });

  it('does not select or read a workspace missing from the current roster', async () => {
    server.detail.set(hiddenWorkspace, [closedOld]);
    mount(link(hiddenWorkspace, closedOld.id));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /linked workspace is not available/i,
    );
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(server.paths.some((path) => path.includes(hiddenWorkspace))).toBe(false);
  });

  it('rejects a detail reply that belongs to another workspace', async () => {
    server.detail.set(workspaceId, [{ ...closedOld, workspaceId: secondWorkspace }]);
    mount(link(workspaceId, closedOld.id));
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('keeps a late reply from a previous target out of the newly selected workspace', async () => {
    const late = deferred();
    server.hold.set(`${workspaceId}/${closedOld.id}`, late.promise);
    mount(link(workspaceId, closedOld.id));
    await screen.findByText('Loading pulse…');
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: secondWorkspace } });
    await screen.findByRole('heading', { name: 'Your primary team' });
    await act(async () => {
      late.resolve(json({ pulse: closedOld }));
      await late.promise;
    });
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Pulse from your link' })).not.toBeInTheDocument();
  });

  it('clears the URL and local target on workspace change and on close', async () => {
    server.detail.set(workspaceId, [closedOld]);
    const { router } = mount(link(workspaceId, closedOld.id));
    await screen.findByRole('article');
    fireEvent.click(screen.getByRole('button', { name: 'Close linked pulse' }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Engineering teams' })).toHaveFocus();
  });

  it('clears the target when another workspace is chosen', async () => {
    server.detail.set(workspaceId, [closedOld]);
    const { router } = mount(link(workspaceId, closedOld.id));
    await screen.findByRole('article');
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: secondWorkspace } });
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('follows back and forward between targets', async () => {
    const other = pulse({ id: pulseId(7), teamName: 'Mobile' });
    server.detail.set(workspaceId, [closedOld, other]);
    const { router, history } = mount('/developer-experience');
    await screen.findByLabelText('Workspace');
    await act(async () => {
      await router.navigate({
        to: '/developer-experience',
        search: { workspace: workspaceId, pulse: closedOld.id },
      });
    });
    expect(await screen.findByRole('heading', { name: /Platform pulse/ })).toBeVisible();
    await act(async () => {
      await router.navigate({
        to: '/developer-experience',
        search: { workspace: workspaceId, pulse: other.id },
      });
    });
    expect(await screen.findByRole('heading', { name: /Mobile pulse/ })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Pulse from your link' })).toHaveFocus();
    act(() => history.back());
    expect(await screen.findByRole('heading', { name: /Platform pulse/ })).toBeVisible();
    act(() => history.back());
    await waitFor(() => expect(screen.queryByRole('article')).not.toBeInTheDocument());
    act(() => history.forward());
    expect(await screen.findByRole('heading', { name: /Platform pulse/ })).toBeVisible();
  });

  it('hides the linked pulse when membership is lost', async () => {
    server.detail.set(workspaceId, [closedOld]);
    mount(link(workspaceId, closedOld.id));
    await screen.findByRole('article');
    server.listed = false;
    server.detail = new Map();
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: secondWorkspace } });
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: workspaceId } });
    expect(await screen.findByText(/no longer available to you/)).toBeVisible();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('drops the linked pulse and shows the sign-in prompt when the session expires', async () => {
    server.hold.set(`${workspaceId}/${closedOld.id}`, Promise.resolve(json({ error: 'x' }, 401)));
    mount(link(workspaceId, closedOld.id));
    expect(
      await screen.findByText(/Sign in with GitHub, then reopen the original notification link/),
    ).toBeVisible();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Pulse from your link' })).not.toBeInTheDocument();
  });

  it('keeps the team filter and history working beside a linked pulse', async () => {
    server.history = [openPulse({ submittedCount: 1 }), cancelledPulse()];
    server.detail.set(workspaceId, [closedOld]);
    mount(link(workspaceId, closedOld.id));
    await screen.findByRole('article');
    fireEvent.change(screen.getByLabelText('Team'), { target: { value: teamA } });
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row').length).toBeGreaterThan(1);
  });

  it('asks guests to sign in and reopen the link without revealing context', async () => {
    server.signedIn = false;
    mount(link(workspaceId, closedOld.id));
    expect(
      await screen.findByText(/Sign in with GitHub, then reopen the original notification link/),
    ).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Pulse from your link' })).not.toBeInTheDocument();
    expect(server.paths.filter((path) => path !== '/api/me')).toEqual([]);
  });

  it('shows the fixed Slack outcome once and removes it from the URL', async () => {
    const { router } = mount(`${link(workspaceId)}&notificationLink=failed`);
    expect(await screen.findByText(/Slack account linking did not complete/)).toBeVisible();
    await waitFor(() => expect(router.state.location.search).toEqual({ workspace: workspaceId }));
    expect(screen.getByLabelText('Workspace')).toHaveValue(workspaceId);
  });

  it('shows the workspace-free callback failure without selecting a workspace or reading private data', async () => {
    const { router } = mount('/developer-experience?notificationLink=failed');
    expect(await screen.findByText(/Slack account linking did not complete/)).toBeVisible();
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(screen.getByLabelText('Workspace')).toHaveValue('');
    expect(spacePaths()).toEqual([]);
    expect(server.paths.filter((path) => path.includes('/organization'))).toEqual([]);
  });

  it('shows the callback failure to a guest without any private request', async () => {
    server.signedIn = false;
    mount('/developer-experience?notificationLink=failed');
    expect(await screen.findByText(/Slack account linking did not complete/)).toBeVisible();
    expect(server.paths.filter((path) => path !== '/api/me')).toEqual([]);
  });

  it('rejects a workspace-free success outcome', async () => {
    const { router } = mount('/developer-experience?notificationLink=success');
    await screen.findByLabelText('Workspace');
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(screen.queryByText(/Slack sign-in finished/)).not.toBeInTheDocument();
  });

  it('consumes each later callback outcome for the same workspace and follows back and forward', async () => {
    const { router, history } = mount(`${link(workspaceId)}&notificationLink=failed`);
    expect(await screen.findByText(/Slack account linking did not complete/)).toBeVisible();
    await waitFor(() => expect(router.state.location.search).toEqual({ workspace: workspaceId }));
    expect(screen.getByText(/Slack account linking did not complete/)).toBeVisible();
    await act(async () => {
      await router.navigate({
        to: '/developer-experience',
        search: { workspace: workspaceId, notificationLink: 'success' },
      });
    });
    expect(await screen.findByText(/Slack sign-in finished/)).toBeVisible();
    expect(screen.queryByText(/did not complete/)).not.toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toEqual({ workspace: workspaceId }));
    expect(screen.getByText(/Slack sign-in finished/)).toBeVisible();
    await act(async () => {
      await router.navigate({
        to: '/developer-experience',
        search: { workspace: workspaceId, notificationLink: 'failed' },
      });
    });
    expect(await screen.findByText(/did not complete/)).toBeVisible();
    await waitFor(() => expect(router.state.location.search).toEqual({ workspace: workspaceId }));
    expect(screen.getByText(/did not complete/)).toBeVisible();
    // Back to the cleaned entry of the earlier success: its notice is not restored and the
    // newer failure notice must not linger.
    act(() => history.back());
    await waitFor(() => expect(screen.queryByText(/did not complete/)).not.toBeInTheDocument());
    expect(screen.queryByText(/Slack sign-in finished/)).not.toBeInTheDocument();
    expect(router.state.location.search).toEqual({ workspace: workspaceId });
    expect(screen.getByLabelText('Workspace')).toHaveValue(workspaceId);
    act(() => history.forward());
    await waitFor(() => expect(router.state.location.search).toEqual({ workspace: workspaceId }));
    expect(screen.queryByText(/did not complete/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Slack sign-in finished/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Workspace')).toHaveValue(workspaceId);
  });

  it('opens the wizard for a linked draft and says when its team is gone', async () => {
    const draft = draftPulse({ teamId: archivedTeam, teamName: 'Retired squad' });
    server.detail.set(workspaceId, [draft]);
    mount(link(workspaceId, draft.id));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue setup' }));
    expect(await screen.findByText(/team for this draft no longer exists/i)).toBeVisible();
  });

  it('tells members a draft link is unavailable instead of offering setup', async () => {
    server.role = 'member';
    const draft = draftPulse();
    server.detail.set(workspaceId, []);
    mount(link(workspaceId, draft.id));
    expect(await screen.findByText(/This pulse is not available/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Continue setup' })).not.toBeInTheDocument();
  });
});
