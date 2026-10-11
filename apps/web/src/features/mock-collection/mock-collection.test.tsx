import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/query-client';
import { DeploymentMappings } from '../deployment-mappings/deployment-mappings';
import type { SourceSetupPresentation } from '../source-setup/provider-state';
import { completed, json, mapping, queued, scope } from './fixtures.test-support';
import { MockCollectionHistory } from './mock-collection';

const identity = vi.hoisted(() => ({ revision: 1, valid: true, expire: vi.fn() }));
vi.mock('../identity/session', () => ({
  useSession: () => ({
    revision: identity.revision,
    current: (revision: number) => identity.valid && revision === identity.revision,
    expire: identity.expire,
  }),
}));
const fetchMock =
  vi.fn<(input: string | URL | Request, options?: RequestInit) => Promise<Response>>();
const reload = vi.fn<() => Promise<void>>();
function mount(owner = true, setup?: SourceSetupPresentation) {
  const client = createQueryClient();
  const content = (serviceId = scope.serviceId, userId = 'alice', mappingRevision = 1) => (
    <QueryClientProvider client={client}>
      <MockCollectionHistory
        key={`${serviceId}:${userId}:${identity.revision}`}
        {...(setup ? { setup } : {})}
        mapping={{ ...mapping, serviceId, revision: mappingRevision }}
        userId={userId}
        owner={owner}
        validSelection={() => identity.valid}
        reloadMapping={reload}
      />
    </QueryClientProvider>
  );
  const view = render(content());
  return {
    ...view,
    client,
    switchScope: (serviceId: string, userId = 'alice', mappingRevision = 1) =>
      view.rerender(content(serviceId, userId, mappingRevision)),
  };
}
function deferred() {
  let resolve: (value: Response) => void = () => {
    throw new Error('No resolver');
  };
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
beforeEach(() => {
  identity.valid = true;
  identity.revision = 1;
  identity.expire.mockReset();
  reload.mockReset();
  reload.mockResolvedValue();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(json({ runs: [] }));
  vi.stubGlobal('fetch', fetchMock);
});
describe('demo collection history', () => {
  it('member reads stored result, quality and gaps without queue control', async () => {
    fetchMock.mockResolvedValue(json({ runs: [completed] }));
    mount(false);
    expect(
      await screen.findByText('Saved result · Provisional · Qualification: unknown'),
    ).toBeVisible();
    expect(screen.getByText(/Quality reasons: incomplete_coverage/)).toBeVisible();
    expect(screen.getByText(/Sample window: 2026-01-01/)).toBeVisible();
    expect(screen.getByText(/Evidence cutoff:.*OEMS revision:/)).toBeVisible();
    expect(screen.getByText(/recovery evidence incomplete/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Queue demo collection' })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh runs' }));
    expect(fetchMock.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
  });
  it('owner queues exact revision/UUID, reports pending processing and prevents duplicate clicks', async () => {
    const late = deferred();
    fetchMock.mockImplementation(async (_input, options) =>
      options?.method === 'POST' ? late.promise : json({ runs: [] }),
    );
    mount();
    await screen.findByText('No demo collection runs yet.');
    const user = userEvent.setup();
    const button = screen.getByRole('button', { name: 'Queue demo collection' });
    await user.click(button);
    await user.click(button);
    const posts = fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]?.[1]?.body))).toEqual({
      revision: 1,
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    fetchMock.mockResolvedValue(json({ runs: [queued] }));
    await act(async () => {
      late.resolve(json({ run: queued }, 202));
      await late.promise;
    });
    expect(await screen.findByText('Saved settings revision 1 · pending')).toBeVisible();
    expect(screen.getByText(/If processing is paused, runs stay pending/)).toBeVisible();
    expect(button).toBeDisabled();
  });
  it.each(['network', 'server', 'unverified'])(
    'replays %s queue failure with same ID, then creates new ID after confirmation',
    async (failure) => {
      let count = 0;
      fetchMock.mockImplementation(async (_input, options) => {
        if (options?.method !== 'POST') return json({ runs: [completed] });
        count += 1;
        if (count === 1) {
          if (failure === 'network') throw new TypeError('network failure');
          return failure === 'server'
            ? json({}, 503)
            : json({ run: { ...completed, mappingRevision: 99 } }, 202);
        }
        return json({ run: completed }, 202);
      });
      mount();
      await screen.findByText('Saved settings revision 1 · succeeded');
      const user = userEvent.setup();
      const button = screen.getByRole('button', { name: 'Queue demo collection' });
      await user.click(button);
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Retry queueing to confirm the same request',
      );
      await user.click(button);
      await screen.findByText('Demo collection queued for saved revision 1.');
      await waitFor(() => expect(button).toBeEnabled());
      await user.click(button);
      const bodies = fetchMock.mock.calls
        .filter(([, options]) => options?.method === 'POST')
        .map(([, options]) => JSON.parse(String(options?.body)));
      expect(bodies[0]).toEqual(bodies[1]);
      expect(bodies[2].requestId).not.toBe(bodies[1].requestId);
    },
  );
  it('starts new request after saved mapping revision changes while preserving historical runs', async () => {
    fetchMock.mockImplementation(async (_input, options) => {
      if (options?.method === 'POST') throw new TypeError('network failure');
      return json({ runs: [completed] });
    });
    const view = mount();
    await screen.findByText('Saved settings revision 1 · succeeded');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Queue demo collection' }));
    await screen.findByRole('alert');
    view.switchScope(scope.serviceId, 'alice', 2);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByText('Saved settings revision 1 · succeeded')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Queue demo collection' }));
    const bodies = fetchMock.mock.calls
      .filter(([, options]) => options?.method === 'POST')
      .map(([, options]) => JSON.parse(String(options?.body)));
    expect(bodies[0].revision).toBe(1);
    expect(bodies[1].revision).toBe(2);
    expect(bodies[1].requestId).not.toBe(bodies[0].requestId);
  });
  it('handles busy/stale 409 with refresh actions and resets confirmed rejected request', async () => {
    fetchMock.mockImplementation(async (_input, options) =>
      options?.method === 'POST' ? json({}, 409) : json({ runs: [] }),
    );
    mount();
    await screen.findByText('No demo collection runs yet.');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Queue demo collection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('another demo collection is active');
    expect(screen.getByRole('button', { name: 'Queue demo collection' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Refresh saved settings' }));
    expect(reload).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Queue demo collection' }));
    const bodies = fetchMock.mock.calls
      .filter(([, options]) => options?.method === 'POST')
      .map(([, options]) => JSON.parse(String(options?.body)));
    expect(bodies[1].requestId).not.toBe(bodies[0].requestId);
  });
  it('queue 403 removes queue rights while keeping readable history and refresh', async () => {
    fetchMock.mockImplementation(async (_input, options) =>
      options?.method === 'POST' ? json({}, 403) : json({ runs: [completed] }),
    );
    mount();
    await screen.findByText('Saved settings revision 1 · succeeded');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Queue demo collection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You can still read run history');
    expect(screen.queryByRole('button', { name: 'Queue demo collection' })).not.toBeInTheDocument();
    expect(screen.getByText('Saved settings revision 1 · succeeded')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refresh runs' })).toBeEnabled();
  });
  it.each(['read', 'queue'])(
    '%s 404 hides all results; 401 expires current session',
    async (operation) => {
      let status = 404;
      fetchMock.mockImplementation(async (_input, options) =>
        operation === 'read' || options?.method === 'POST'
          ? json({}, status)
          : json({ runs: [completed] }),
      );
      const view = mount();
      if (operation === 'queue') {
        await screen.findByText('Saved settings revision 1 · succeeded');
        await userEvent
          .setup()
          .click(screen.getByRole('button', { name: 'Queue demo collection' }));
      }
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Run history is no longer available',
      );
      expect(screen.queryByText('Saved settings revision 1 · succeeded')).not.toBeInTheDocument();
      view.unmount();
      status = 401;
      mount();
      if (operation === 'queue') {
        await screen.findByText('Saved settings revision 1 · succeeded');
        await userEvent
          .setup()
          .click(screen.getByRole('button', { name: 'Queue demo collection' }));
      }
      await waitFor(() => expect(identity.expire).toHaveBeenCalledWith(1));
    },
  );
  it.each(['read', 'queue'])(
    'ignores late %s on scope switch, aborts and removes old cache',
    async (operation) => {
      const late = deferred();
      const otherService = '44444444-4444-4444-8444-444444444444';
      fetchMock.mockImplementation(async (input, options) => {
        if (String(input).includes(otherService)) return json({ runs: [] });
        return operation === 'read' || options?.method === 'POST'
          ? late.promise
          : json({ runs: [] });
      });
      const view = mount();
      if (operation === 'queue') {
        await screen.findByText('No demo collection runs yet.');
        await userEvent
          .setup()
          .click(screen.getByRole('button', { name: 'Queue demo collection' }));
      }
      view.switchScope(otherService);
      await screen.findByText('No demo collection runs yet.');
      await act(async () => {
        late.resolve(operation === 'queue' ? json({}, 401) : json({ runs: [completed] }));
        await late.promise;
      });
      expect(identity.expire).not.toHaveBeenCalled();
      expect(screen.queryByText('Saved settings revision 1 · succeeded')).not.toBeInTheDocument();
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
              (operation === 'read' || options?.method === 'POST'),
          )
          .every(([, options]) => options?.signal?.aborted),
      ).toBe(true);
    },
  );
  it('rejects late identity response and drops replay ID after identity switch', async () => {
    const late = deferred();
    fetchMock.mockImplementation(async (_input, options) =>
      options?.method === 'POST' ? late.promise : json({ runs: [] }),
    );
    const view = mount();
    await screen.findByText('No demo collection runs yet.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Queue demo collection' }));
    identity.revision = 2;
    view.switchScope(scope.serviceId, 'bob');
    await screen.findByText('No demo collection runs yet.');
    await act(async () => {
      late.resolve(json({ run: queued }, 202));
      await late.promise;
    });
    expect(screen.queryByText(/Demo collection queued/)).not.toBeInTheDocument();
    expect(
      JSON.stringify(
        view.client
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey),
      ),
    ).not.toContain('alice');
  });
  it('keeps historical run after editing/saving newer deployment mapping', async () => {
    fetchMock.mockImplementation(async (input, options) => {
      if (String(input).endsWith('/mock-collection-runs')) return json({ runs: [completed] });
      return json({ mapping: options?.method === 'POST' ? { ...mapping, revision: 2 } : mapping });
    });
    const client = createQueryClient();
    render(
      <QueryClientProvider client={client}>
        <DeploymentMappings
          workspace={{ id: scope.workspaceId, name: 'Test', role: 'owner' }}
          serviceId={scope.serviceId}
          serviceName="Delivery"
          userId="alice"
          validSelection={() => true}
        />{' '}
      </QueryClientProvider>,
    );
    await screen.findByText('Saved settings revision 1 · succeeded');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Production environment'), '-eu');
    expect(screen.getByText('Saved settings revision 1 · succeeded')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save demo settings' }));
    await screen.findByText(/Saved settings revision 2. Observed at/);
    expect(screen.getByText('Saved settings revision 1 · succeeded')).toBeVisible();
    expect(screen.getByText(/Saved result/)).toBeVisible();
  });
  it('shows redacted failed run and retries history errors', async () => {
    fetchMock.mockResolvedValueOnce(json({ private: 'secret' }, 503)).mockResolvedValue(
      json({
        runs: [
          {
            ...completed,
            status: 'failed',
            failureCode: 'mock_processing_failed',
            attempts: 3,
            result: null,
          },
        ],
      }),
    );
    mount(false);
    expect(await screen.findByRole('alert')).toHaveTextContent('Clio is unavailable');
    expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh runs' }));
    expect(
      await screen.findByText(
        'Mock processing failed after 3 attempts. An owner can queue another run.',
      ),
    ).toBeVisible();
  });
  it('stops automatic polling once stored run reaches terminal status', async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      fetchMock.mockImplementation(async () => {
        reads += 1;
        return json({
          runs: [
            reads === 1
              ? queued
              : reads === 2
                ? { ...queued, status: 'running', attempts: 1 }
                : completed,
          ],
        });
      });
      const view = mount(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
      expect(screen.getByText('Saved settings revision 1 · running')).toBeVisible();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
      expect(screen.getByText('Saved settings revision 1 · succeeded')).toBeVisible();
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
  it('polls pending/running with bound; manual refresh resumes; unmount stops', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(async () => json({ runs: [queued] }));
      const view = mount(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      for (let index = 0; index < 31; index += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2100);
        });
      }
      expect(
        screen.getByText('Automatic refresh paused. Refresh runs to check progress again.'),
      ).toBeVisible();
      const count = fetchMock.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(count);
      fireEvent.click(screen.getByRole('button', { name: 'Refresh runs' }));
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
      expect(view.client.getQueryCache().getAll()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('mock setup collection status', () => {
  it('requires success for current mapping revision without blocking navigation on queued work', async () => {
    fetchMock.mockResolvedValue(json({ runs: [queued] }));
    const onStatus = vi.fn();
    const view = mount(true, { step: 'collect', onStatus, onAccessLost: vi.fn() });
    await waitFor(() =>
      expect(onStatus).toHaveBeenLastCalledWith({
        ready: true,
        busy: false,
        hasSavedResult: false,
      }),
    );
    fetchMock.mockResolvedValue(json({ runs: [completed] }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh runs' }));
    await waitFor(() =>
      expect(onStatus).toHaveBeenLastCalledWith({ ready: true, busy: false, hasSavedResult: true }),
    );
    view.switchScope(scope.serviceId, 'alice', 2);
    await waitFor(() =>
      expect(onStatus).toHaveBeenLastCalledWith({
        ready: true,
        busy: false,
        hasSavedResult: false,
      }),
    );
    view.unmount();
    expect(onStatus).toHaveBeenLastCalledWith({ ready: false, busy: false, hasSavedResult: false });
  });
  it('keeps unconfirmed queue request busy across refresh, and propagates read access loss', async () => {
    fetchMock.mockImplementation(async (_input, options) =>
      options?.method === 'POST' ? json({}, 503) : json({ runs: [] }),
    );
    const onStatus = vi.fn(),
      onAccessLost = vi.fn();
    mount(true, { step: 'collect', onStatus, onAccessLost });
    await waitFor(() =>
      expect(onStatus).toHaveBeenLastCalledWith({
        ready: true,
        busy: false,
        hasSavedResult: false,
      }),
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Queue demo collection' }));
    await screen.findByText(/Retry queueing to confirm the same request/);
    await waitFor(() =>
      expect(onStatus).toHaveBeenLastCalledWith({ ready: true, busy: true, hasSavedResult: false }),
    );
    fetchMock.mockResolvedValue(json({}, 403));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh runs' }));
    await waitFor(() => expect(onAccessLost).toHaveBeenCalled());
    await waitFor(() => expect(onStatus.mock.lastCall?.[0].ready).toBe(false));
  });
});
