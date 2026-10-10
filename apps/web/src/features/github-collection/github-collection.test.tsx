import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/query-client';
import { WorkspacePage } from '../workspace/workspace-page';
import { completed, connection, json, queued, scope } from './fixtures.test-support';
import { GitHubCollection } from './github-collection';

const identity = vi.hoisted(() => ({ revision: 1, valid: true, expire: vi.fn() }));
vi.mock('../identity/session', () => ({
  useSession: () => ({
    revision: identity.revision,
    current: (revision: number) => identity.valid && revision === identity.revision,
    expire: identity.expire,
    status: 'ready',
    user: { id: 'alice' },
    refresh: vi.fn(),
  }),
}));
const fetchMock =
  vi.fn<(input: string | URL | Request, options?: RequestInit) => Promise<Response>>();
function mount(owner = true) {
  const client = createQueryClient();
  const content = (
    serviceId = scope.serviceId,
    userId = 'alice',
    workspaceId = scope.workspaceId,
    role: 'owner' | 'member' = owner ? 'owner' : 'member',
  ) => (
    <QueryClientProvider client={client}>
      <GitHubCollection
        workspace={{ id: workspaceId, name: 'Test', role }}
        serviceId={serviceId}
        serviceName="Delivery"
        userId={userId}
        validSelection={() => identity.valid}
      />
    </QueryClientProvider>
  );
  const view = render(content());
  return {
    ...view,
    client,
    switchScope: (serviceId: string, userId = 'alice', workspaceId = scope.workspaceId) =>
      view.rerender(content(serviceId, userId, workspaceId)),
    demote: () => view.rerender(content(scope.serviceId, 'alice', scope.workspaceId, 'member')),
  };
}
function deferred() {
  let resolve: (value: Response) => void = () => {
    throw new Error('Missing resolver');
  };
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function defaultRead(input: string | URL | Request) {
  return String(input).endsWith('/github-connection')
    ? json({ connection, configured: true })
    : String(input).endsWith(`/${completed.id}`)
      ? json({ run: completed })
      : json({ runs: [] });
}
function dates(start = '2026-01-01', end = '2026-01-03') {
  fireEvent.change(screen.getByLabelText('Start date (UTC)'), { target: { value: start } });
  fireEvent.change(screen.getByLabelText('End date, exclusive (UTC)'), { target: { value: end } });
}
function posts() {
  return fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST');
}
beforeEach(() => {
  identity.revision = 1;
  identity.valid = true;
  identity.expire.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => defaultRead(input));
  vi.stubGlobal('fetch', fetchMock);
});

describe('live GitHub workflow', () => {
  it('member reads connection/history/detail and honest zero provisional count without write controls', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).endsWith('/github-collection-runs')
        ? json({ runs: [completed] })
        : defaultRead(input),
    );
    mount(false);
    await screen.findByText(/Connected: example\/delivery/);
    expect(
      screen.queryByRole('button', { name: 'Save GitHub connection' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect GitHub' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Collect GitHub deployments' }),
    ).not.toBeInTheDocument();
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: `View run ${completed.createdAt}` }));
    const detail = await screen.findByRole('region', { name: 'Live GitHub run detail' });
    expect(await within(detail).findByText(/GitHub history retrieval complete/)).toHaveTextContent(
      'does not establish complete metric coverage',
    );
    expect(within(detail).getByText(/Unknown qualification: 2/)).toBeVisible();
    expect(within(detail).getByText(/Provisional deployment frequency count: 0/)).toHaveTextContent(
      'not a complete deployment measurement',
    );
    expect(within(detail).getByText(/Evidence cutoff:.*OEMS revision:/)).toBeVisible();
    expect(
      within(detail).getByText(
        /Deployments per day, change failure rate and recovery time are unavailable/,
      ),
    ).toBeVisible();
    expect(posts()).toHaveLength(0);
  });
  it.each([null, connection])(
    'unconfigured workspace shows operator setup, no save/enqueue, history still readable %#',
    async (saved) => {
      fetchMock.mockImplementation(async (input) =>
        String(input).endsWith('/github-connection')
          ? json({ connection: saved, configured: false })
          : json({ runs: [completed] }),
      );
      mount();
      expect(await screen.findByText(/Operator setup needed/)).toBeVisible();
      expect(
        screen.queryByRole('button', { name: 'Save GitHub connection' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Collect GitHub deployments' }),
      ).not.toBeInTheDocument();
      expect(
        await screen.findByRole('button', { name: `View run ${completed.createdAt}` }),
      ).toBeVisible();
    },
  );
  it('owner saves exact inputs with explicit repository assignment; rejects unsafe IDs and missing assignment', async () => {
    fetchMock.mockImplementation(async (input, options) =>
      options?.method === 'POST'
        ? json({
            connection: {
              ...connection,
              revision: 2,
              productionEnvironment: 'Production-EU',
              exposurePolicyReference: 'policy/v2',
            },
          })
        : defaultRead(input),
    );
    mount();
    await screen.findByRole('button', { name: 'Save GitHub connection' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save GitHub connection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('confirm repository assignment');
    expect(posts()).toHaveLength(0);
    await user.click(screen.getByRole('checkbox', { name: /I assign all deployment operations/ }));
    fireEvent.change(screen.getByLabelText('Repository ID'), {
      target: { value: '9007199254740992' },
    });
    await user.click(screen.getByRole('button', { name: 'Save GitHub connection' }));
    expect(posts()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Repository ID'), { target: { value: '456' } });
    fireEvent.change(screen.getByLabelText('Exact production environment'), {
      target: { value: 'Production-EU' },
    });
    fireEvent.change(screen.getByLabelText('Exposure policy reference (optional)'), {
      target: { value: 'policy/v2' },
    });
    expect(
      screen.getByText(/successful deployment alone does not prove production exposure/),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save GitHub connection' }));
    await screen.findByText('GitHub connection saved.');
    expect(JSON.parse(String(posts()[0]?.[1]?.body))).toEqual({
      expectedRevision: 1,
      installationId: 123,
      repositoryId: 456,
      productionEnvironment: 'Production-EU',
      exposurePolicyReference: 'policy/v2',
      repositoryDeploymentsBelongToService: true,
    });
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });
  it('save conflict requires refresh; reloads new revision before next save', async () => {
    let saved = connection,
      conflict = true;
    fetchMock.mockImplementation(async (input, options) => {
      if (options?.method === 'POST') {
        if (conflict) {
          saved = { ...connection, revision: 2 };
          conflict = false;
          return json({}, 409);
        }
        return json({ connection: { ...saved, revision: 3 } });
      }
      return String(input).endsWith('/github-connection')
        ? json({ connection: saved, configured: true })
        : json({ runs: [] });
    });
    mount();
    const user = userEvent.setup();
    await screen.findByRole('checkbox');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Save GitHub connection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Refresh connection and runs');
    expect(screen.getByRole('button', { name: 'Save GitHub connection' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Refresh connection and runs' }));
    await screen.findByText(/Saved revision 2/);
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Save GitHub connection' }));
    await screen.findByText('GitHub connection saved.');
    expect(JSON.parse(String(posts()[1]?.[1]?.body)).expectedRevision).toBe(2);
  });
  it('disconnect pins expected revision, keeps history and removes collection until reconnect', async () => {
    fetchMock.mockImplementation(async (input, options) =>
      options?.method === 'POST'
        ? json({ connection: { ...connection, revision: 2, active: false } })
        : String(input).endsWith('/github-collection-runs')
          ? json({ runs: [completed] })
          : defaultRead(input),
    );
    mount();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Disconnect GitHub' }));
    expect(
      await screen.findByText(/Disconnected: example\/delivery.*Saved revision 2/),
    ).toBeVisible();
    expect(
      screen.getByText('Disconnected from Clio collection. GitHub installation remains unchanged.'),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Collect GitHub deployments' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: `View run ${completed.createdAt}` })).toBeVisible();
    expect(String(posts()[0]?.[0])).toContain('/github-connection/disconnect');
    expect(JSON.parse(String(posts()[0]?.[1]?.body))).toEqual({ expectedRevision: 1 });
  });
  it('validates closed calendar window, queues pinned revision, prevents double submit', async () => {
    const late = deferred();
    fetchMock.mockImplementation(async (input, options) =>
      options?.method === 'POST' ? late.promise : defaultRead(input),
    );
    mount();
    await screen.findByRole('button', { name: 'Collect GitHub deployments' });
    const user = userEvent.setup();
    const button = screen.getByRole('button', { name: 'Collect GitHub deployments' });
    for (const [start, end] of [
      ['2026-01-01', '2026-04-02'],
      ['2026-01-01', '2026-01-01'],
      ['2099-01-01', '2099-01-02'],
    ]) {
      dates(start, end);
      await user.click(button);
      expect(posts()).toHaveLength(0);
    }
    dates();
    await user.click(button);
    await user.click(button);
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0]?.[1]?.body))).toEqual({
      connectionRevision: 1,
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      window: { start: '2026-01-01T00:00:00Z', end: '2026-01-03T00:00:00Z' },
    });
    fetchMock.mockImplementation(async (input) =>
      String(input).endsWith('/github-collection-runs')
        ? json({ runs: [queued] })
        : defaultRead(input),
    );
    await act(async () => {
      late.resolve(json({ run: queued }, 202));
      await late.promise;
    });
    expect(await screen.findByText('Collection confirmed for saved revision 1.')).toBeVisible();
    expect(button).toBeDisabled();
  });
  it.each(['network', 'server', 'unverified', 'timeout', 'rate-limit'])(
    'replays same request after %s failure with dates locked, then new ID after accepted response',
    async (failure) => {
      let count = 0;
      fetchMock.mockImplementation(async (input, options) => {
        if (options?.method !== 'POST') return defaultRead(input);
        count++;
        if (count === 1) {
          if (failure === 'network') throw new TypeError('network');
          return failure === 'timeout'
            ? json({}, 408)
            : failure === 'rate-limit'
              ? json({}, 429)
              : failure === 'server'
                ? json({}, 503)
                : json({ run: { ...completed, connectionRevision: 4 } }, 202);
        }
        return json({ run: completed }, 202);
      });
      mount();
      await screen.findByRole('button', { name: 'Collect GitHub deployments' });
      dates();
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Collect GitHub deployments' }));
      const retry = await screen.findByRole('button', { name: 'Retry collection request' });
      expect(screen.getByLabelText('Start date (UTC)')).toBeDisabled();
      await user.click(retry);
      await screen.findByText('Collection confirmed for saved revision 1.');
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Collect GitHub deployments' })).toBeEnabled(),
      );
      await user.click(screen.getByRole('button', { name: 'Collect GitHub deployments' }));
      const bodies = posts().map(([, options]) => JSON.parse(String(options?.body)));
      expect(bodies[0]).toEqual(bodies[1]);
      expect(bodies[2].requestId).not.toBe(bodies[1].requestId);
    },
  );
  it('scope 403 preserves owner controls; actual parent demotion removes writes and preserves member reads', async () => {
    fetchMock.mockImplementation(async (input, options) =>
      options?.method === 'POST' ? json({}, 403) : defaultRead(input),
    );
    const view = mount();
    await screen.findByRole('button', { name: 'Collect GitHub deployments' });
    dates();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Collect GitHub deployments' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You can still read history');
    expect(screen.getByRole('button', { name: 'Save GitHub connection' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Disconnect GitHub' })).toBeEnabled();
    view.demote();
    expect(screen.queryByRole('button', { name: 'Disconnect GitHub' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Collect GitHub deployments' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Save GitHub connection' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh connection and runs' })).toBeEnabled();
  });
  it('read authorization loss clears displayed connection/history/cache; current 401 expires session', async () => {
    let status = 200;
    fetchMock.mockImplementation(async (input) =>
      status === 200 ? defaultRead(input) : json({}, status),
    );
    const view = mount();
    await screen.findByText(/Connected: example\/delivery/);
    status = 404;
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Refresh connection and runs' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer available');
    expect(screen.queryByText(/Connected: example\/delivery/)).not.toBeInTheDocument();
    expect(
      view.client
        .getQueryCache()
        .getAll()
        .every((query) => query.state.data === undefined),
    ).toBe(true);
    view.unmount();
    status = 401;
    mount();
    await waitFor(() => expect(identity.expire).toHaveBeenCalledWith(1));
  });
  it.each(['connection', 'runs', 'save', 'queue', 'detail'])(
    'fences late %s after service switch, aborts request, removes prior scoped cache',
    async (operation) => {
      const late = deferred(),
        other = '44444444-4444-4444-8444-444444444444';
      fetchMock.mockImplementation(async (input, options) => {
        const path = String(input);
        if (path.includes(other))
          return path.endsWith('/github-connection')
            ? json({ connection: null, configured: true })
            : json({ runs: [] });
        if (
          (operation === 'connection' && path.endsWith('/github-connection')) ||
          (operation === 'runs' && path.endsWith('/github-collection-runs')) ||
          (operation === 'save' && options?.method === 'POST') ||
          (operation === 'queue' && options?.method === 'POST') ||
          (operation === 'detail' && path.endsWith(`/${completed.id}`))
        )
          return late.promise;
        return path.endsWith('/github-collection-runs')
          ? json({ runs: [completed] })
          : defaultRead(input);
      });
      const view = mount();
      const user = userEvent.setup();
      if (operation === 'save') {
        await user.click(await screen.findByRole('checkbox'));
        await user.click(screen.getByRole('button', { name: 'Save GitHub connection' }));
      }
      if (operation === 'queue') {
        await screen.findByRole('button', { name: 'Collect GitHub deployments' });
        dates();
        await user.click(screen.getByRole('button', { name: 'Collect GitHub deployments' }));
      }
      if (operation === 'detail')
        await user.click(
          await screen.findByRole('button', { name: `View run ${completed.createdAt}` }),
        );
      view.switchScope(other);
      await screen.findByText('No live GitHub connection saved.');
      await act(async () => {
        late.resolve(json({}, 401));
        await late.promise;
      });
      expect(identity.expire).not.toHaveBeenCalled();
      expect(
        view.client
          .getQueryCache()
          .getAll()
          .some((query) => query.queryKey.includes(scope.serviceId)),
      ).toBe(false);
      expect(
        fetchMock.mock.calls
          .filter(
            ([input, options]) =>
              String(input).includes(scope.serviceId) &&
              ((operation === 'connection' && String(input).endsWith('/github-connection')) ||
                (operation === 'runs' && String(input).endsWith('/github-collection-runs')) ||
                ((operation === 'save' || operation === 'queue') && options?.method === 'POST') ||
                (operation === 'detail' && String(input).endsWith(`/${completed.id}`))),
          )
          .every(([, options]) => options?.signal?.aborted),
      ).toBe(true);
    },
  );
  it.each(['identity', 'workspace'])(
    'late queue rejected after %s change; replay and old cache disappear',
    async (change) => {
      const late = deferred();
      fetchMock.mockImplementation(async (input, options) =>
        options?.method === 'POST' ? late.promise : defaultRead(input),
      );
      const view = mount();
      await screen.findByRole('button', { name: 'Collect GitHub deployments' });
      dates();
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Collect GitHub deployments' }));
      if (change === 'identity') {
        identity.revision = 2;
        view.switchScope(scope.serviceId, 'bob');
      } else view.switchScope(scope.serviceId, 'alice', '22222222-2222-4222-8222-222222222222');
      await act(async () => {
        late.resolve(json({ run: queued }, 202));
        await late.promise;
      });
      expect(screen.queryByText(/Collection confirmed/)).not.toBeInTheDocument();
      expect(
        view.client
          .getQueryCache()
          .getAll()
          .some((query) =>
            change === 'identity'
              ? query.queryKey.includes('alice')
              : query.queryKey.includes(scope.workspaceId),
          ),
      ).toBe(false);
    },
  );
  it('workspace navigation exposes separate live and mock panels without exchanging attestations', async () => {
    fetchMock.mockImplementation(async (input) => {
      const path = String(input);
      if (path.endsWith('/api/workspaces'))
        return json({ workspaces: [{ id: scope.workspaceId, name: 'Test', role: 'owner' }] });
      if (path.endsWith('/services'))
        return json({
          services: [{ id: scope.serviceId, workspaceId: scope.workspaceId, name: 'Delivery' }],
        });
      if (path.endsWith('/deployment-mapping')) return json({ mapping: null });
      return defaultRead(input);
    });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <WorkspacePage authError={false} />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('Workspace'), scope.workspaceId);
    await user.click(await screen.findByRole('button', { name: 'Live GitHub for Delivery' }));
    expect(await screen.findByRole('heading', { name: 'Live GitHub · Delivery' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save mock settings' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mock settings for Delivery' }));
    expect(await screen.findByRole('button', { name: 'Save mock settings' })).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'Live GitHub · Delivery' }),
    ).not.toBeInTheDocument();
  });
  it('creates first connection with null revision and blocks duplicate save clicks while provider verification waits', async () => {
    const late = deferred();
    fetchMock.mockImplementation(async (input, options) =>
      options?.method === 'POST'
        ? late.promise
        : String(input).endsWith('/github-connection')
          ? json({ connection: null, configured: true })
          : json({ runs: [] }),
    );
    mount();
    await screen.findByText('No live GitHub connection saved.');
    fireEvent.change(screen.getByLabelText('GitHub App installation ID'), {
      target: { value: '123' },
    });
    fireEvent.change(screen.getByLabelText('Repository ID'), { target: { value: '456' } });
    fireEvent.change(screen.getByLabelText('Exact production environment'), {
      target: { value: 'production' },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox'));
    const button = screen.getByRole('button', { name: 'Save GitHub connection' });
    await user.click(button);
    await user.click(button);
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0]?.[1]?.body)).expectedRevision).toBeNull();
    await act(async () => {
      late.resolve(json({ connection }));
      await late.promise;
    });
    expect(await screen.findByText('GitHub connection saved.')).toBeVisible();
  });
  it('queue conflict refresh clears rejection and creates fresh request ID', async () => {
    let count = 0;
    fetchMock.mockImplementation(async (input, options) =>
      options?.method === 'POST'
        ? ++count === 1
          ? json({}, 409)
          : json({ run: completed }, 202)
        : defaultRead(input),
    );
    mount();
    await screen.findByRole('button', { name: 'Collect GitHub deployments' });
    dates();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Collect GitHub deployments' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('another collection is active');
    expect(screen.getByRole('button', { name: 'Collect GitHub deployments' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Refresh connection and runs' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Collect GitHub deployments' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Collect GitHub deployments' }));
    await screen.findByText('Collection confirmed for saved revision 1.');
    const bodies = posts().map(([, options]) => JSON.parse(String(options?.body)));
    expect(bodies[0].requestId).not.toBe(bodies[1].requestId);
  });
  it('new connection revision clears uncertain collection replay and dates', async () => {
    let saved = connection;
    fetchMock.mockImplementation(async (input, options) => {
      if (options?.method === 'POST') throw new TypeError('network');
      return String(input).endsWith('/github-connection')
        ? json({ connection: saved, configured: true })
        : json({ runs: [] });
    });
    mount();
    await screen.findByRole('button', { name: 'Collect GitHub deployments' });
    dates();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Collect GitHub deployments' }));
    await screen.findByRole('button', { name: 'Retry collection request' });
    saved = { ...connection, revision: 2 };
    await user.click(screen.getByRole('button', { name: 'Refresh connection and runs' }));
    await screen.findByText('Collect saved connection revision 2');
    expect(screen.getByLabelText('Start date (UTC)')).toHaveValue('');
    dates();
    await user.click(screen.getByRole('button', { name: 'Collect GitHub deployments' }));
    await screen.findByRole('button', { name: 'Retry collection request' });
    const bodies = posts().map(([, options]) => JSON.parse(String(options?.body)));
    expect(bodies[1].connectionRevision).toBe(2);
    expect(bodies[1].requestId).not.toBe(bodies[0].requestId);
  });
  it('partial traversal and failed detail stay honest; provider errors never rendered', async () => {
    let failed = false,
      revoked = false;
    fetchMock.mockImplementation(async (input) => {
      const run = failed
        ? {
            ...completed,
            status: 'failed',
            failureCode: revoked ? 'github_connection_revoked' : 'github_processing_failed',
            result: null,
          }
        : { ...completed, result: { ...completed.result, transportComplete: false } };
      return String(input).endsWith('/github-collection-runs')
        ? json({ runs: [run] })
        : String(input).endsWith(`/${completed.id}`)
          ? json({ run })
          : defaultRead(input);
    });
    mount(false);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: `View run ${completed.createdAt}` }),
    );
    expect(await screen.findByText(/GitHub history retrieval incomplete/)).toBeVisible();
    failed = true;
    await user.click(screen.getByRole('button', { name: 'Refresh connection and runs' }));
    expect(
      await screen.findByText(/Collection failed. An owner can try another run/),
    ).toBeVisible();
    expect(screen.queryByText(/github_processing_failed/)).not.toBeInTheDocument();
    revoked = true;
    await user.click(screen.getByRole('button', { name: 'Refresh connection and runs' }));
    expect(
      await screen.findByText(/Connection access changed. An owner must review and save/),
    ).toBeVisible();
    expect(screen.queryByText(/An owner can try another run/)).not.toBeInTheDocument();
  });
  it('pending polling stops at terminal completion and refreshes selected detail', async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      fetchMock.mockImplementation(async (input) =>
        String(input).endsWith('/github-collection-runs')
          ? json({ runs: [++reads < 3 ? queued : completed] })
          : defaultRead(input),
      );
      const view = mount(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      fireEvent.click(screen.getByRole('button', { name: `View run ${completed.createdAt}` }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
      expect(screen.getByText('Saved connection revision 1 · succeeded')).toBeVisible();
      const count = fetchMock.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(count);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
  it('bounds automatic polling; manual refresh resumes and unmount stops', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(async (input) =>
        String(input).endsWith('/github-collection-runs')
          ? json({ runs: [queued] })
          : defaultRead(input),
      );
      const view = mount(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      for (let index = 0; index < 31; index++)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2100);
        });
      expect(
        screen.getByText(
          'Automatic refresh paused. Refresh connection and runs to check progress.',
        ),
      ).toBeVisible();
      const count = fetchMock.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(count);
      fireEvent.click(screen.getByRole('button', { name: 'Refresh connection and runs' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
      expect(fetchMock.mock.calls.length).toBeGreaterThan(count);
      view.unmount();
      const final = fetchMock.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(final);
    } finally {
      vi.useRealTimers();
    }
  });
  it('save scope 403 leaves still-owner form correctable and disconnect usable; corrected save succeeds', async () => {
    let first = true;
    fetchMock.mockImplementation(async (input, options) => {
      if (options?.method !== 'POST') return defaultRead(input);
      if (first) {
        first = false;
        return json({}, 403);
      }
      return json({ connection: { ...connection, revision: 2, repositoryId: 789 } });
    });
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Save GitHub connection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('selected GitHub scope');
    expect(screen.getByRole('button', { name: 'Save GitHub connection' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Disconnect GitHub' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Repository ID'), { target: { value: '789' } });
    await user.click(screen.getByRole('button', { name: 'Save GitHub connection' }));
    expect(await screen.findByText('GitHub connection saved.')).toBeVisible();
    expect(posts()).toHaveLength(2);
    expect(JSON.parse(String(posts()[1]?.[1]?.body)).repositoryId).toBe(789);
  });
  it('unverifiable replay requires successful history review and explicit duplicate-risk acknowledgement before unlock', async () => {
    fetchMock.mockImplementation(async (input, options) =>
      options?.method === 'POST'
        ? json({ run: { ...completed, connectionRevision: 9 } }, 202)
        : defaultRead(input),
    );
    mount();
    await screen.findByRole('button', { name: 'Collect GitHub deployments' });
    dates();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Collect GitHub deployments' }));
    await user.click(await screen.findByRole('button', { name: 'Retry collection request' }));
    expect(posts()).toHaveLength(2);
    expect(posts()[0]?.[1]?.body).toEqual(posts()[1]?.[1]?.body);
    expect(screen.getByLabelText('Start date (UTC)')).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Abandon confirmation and unlock dates' }),
    ).not.toBeInTheDocument();
    fetchMock.mockImplementation(async (input, options) =>
      options?.method === 'POST'
        ? json({ run: { ...completed, connectionRevision: 9 } }, 202)
        : String(input).endsWith('/github-collection-runs')
          ? json({ runs: [completed] })
          : defaultRead(input),
    );
    await user.click(screen.getByRole('button', { name: 'Review latest collection history' }));
    expect(await screen.findByText(/Latest history refreshed/)).toBeVisible();
    expect(screen.getByRole('button', { name: `View run ${completed.createdAt}` })).toBeVisible();
    const abandon = screen.getByRole('button', { name: 'Abandon confirmation and unlock dates' });
    expect(abandon).toBeDisabled();
    expect(screen.getByLabelText('Start date (UTC)')).toBeDisabled();
    expect(posts()).toHaveLength(2);
    await user.click(screen.getByRole('checkbox', { name: /I reviewed history and understand/ }));
    await user.click(abandon);
    expect(screen.getByLabelText('Start date (UTC)')).toBeEnabled();
    expect(
      screen.getByText(/Confirmation abandoned.*previous request may already have completed/),
    ).toBeVisible();
    dates('2026-01-02', '2026-01-03');
    await user.click(screen.getByRole('button', { name: 'Collect GitHub deployments' }));
    const bodies = posts().map(([, options]) => JSON.parse(String(options?.body)));
    expect(bodies[2].requestId).not.toBe(bodies[1].requestId);
    expect(bodies[2].window.start).toBe('2026-01-02T00:00:00Z');
  });
  it('failed history review keeps replay locked and retry uses original ID/window', async () => {
    let historyFails = false;
    fetchMock.mockImplementation(async (input, options) => {
      if (options?.method === 'POST') throw new TypeError('network');
      if (historyFails && String(input).endsWith('/github-collection-runs')) return json({}, 503);
      return defaultRead(input);
    });
    mount();
    await screen.findByRole('button', { name: 'Collect GitHub deployments' });
    dates();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Collect GitHub deployments' }));
    await screen.findByRole('button', { name: 'Retry collection request' });
    historyFails = true;
    await user.click(screen.getByRole('button', { name: 'Review latest collection history' }));
    expect(
      await screen.findByText(/History could not be verified.*Keep the same request/),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Abandon confirmation and unlock dates' }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Start date (UTC)')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Retry collection request' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[0]?.[1]?.body).toEqual(posts()[1]?.[1]?.body);
  });
  it('failed connection refresh preserves uncertain replay and locked dates', async () => {
    let connectionFails = false;
    fetchMock.mockImplementation(async (input, options) => {
      if (options?.method === 'POST') throw new TypeError('network');
      if (connectionFails && String(input).endsWith('/github-connection')) return json({}, 503);
      return defaultRead(input);
    });
    mount();
    await screen.findByRole('button', { name: 'Collect GitHub deployments' });
    dates();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Collect GitHub deployments' }));
    await screen.findByRole('button', { name: 'Retry collection request' });
    connectionFails = true;
    await user.click(screen.getByRole('button', { name: 'Refresh connection and runs' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Refresh connection and runs' })).toBeEnabled(),
    );
    expect(screen.getByLabelText('Start date (UTC)')).toBeDisabled();
    expect(screen.getByLabelText('Start date (UTC)')).toHaveValue('2026-01-01');
    expect(screen.getByRole('button', { name: 'Retry collection request' })).toBeVisible();
    connectionFails = false;
    await user.click(screen.getByRole('button', { name: 'Refresh connection and runs' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry collection request' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Retry collection request' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[0]?.[1]?.body).toEqual(posts()[1]?.[1]?.body);
  });
  it('late history recovery cannot unlock or publish after service switch', async () => {
    const late = deferred(),
      other = '44444444-4444-4444-8444-444444444444';
    let reviewing = false;
    fetchMock.mockImplementation(async (input, options) => {
      const path = String(input);
      if (path.includes(other))
        return path.endsWith('/github-connection')
          ? json({ connection: null, configured: true })
          : json({ runs: [] });
      if (options?.method === 'POST') throw new TypeError('network');
      if (reviewing && path.endsWith('/github-collection-runs')) return late.promise;
      return defaultRead(input);
    });
    const view = mount();
    await screen.findByRole('button', { name: 'Collect GitHub deployments' });
    dates();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Collect GitHub deployments' }));
    await screen.findByRole('button', { name: 'Retry collection request' });
    reviewing = true;
    await user.click(screen.getByRole('button', { name: 'Review latest collection history' }));
    view.switchScope(other);
    await screen.findByText('No live GitHub connection saved.');
    await act(async () => {
      late.resolve(json({ runs: [completed] }));
      await late.promise;
    });
    expect(screen.queryByText(/Latest history refreshed/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Abandon confirmation and unlock dates' }),
    ).not.toBeInTheDocument();
    expect(
      view.client
        .getQueryCache()
        .getAll()
        .some((query) => query.queryKey.includes(scope.serviceId)),
    ).toBe(false);
  });
});
