import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/query-client';
import { withMetric } from '../measurements/fixtures.test-support';
import { WorkspacePage } from '../workspace/workspace-page';
import { ArgoCollection } from './argo-collection';
import {
  archiveProducer,
  archiveSummary,
  completed,
  connection,
  coverageAssessment,
  json,
  queued,
  result,
  scope,
  source,
} from './fixtures.test-support';

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
      <ArgoCollection
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
  return String(input).endsWith('/argo-connection')
    ? json({ connection, configured: true, sources: [source] })
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

describe('live Argo workflow', () => {
  it('renders all five saved calculations in Settings detail', async () => {
    const run = { ...completed, result: withMetric(result) };
    fetchMock.mockImplementation(async (input) =>
      String(input).endsWith('/argo-collection-runs')
        ? json({ runs: [run] })
        : String(input).endsWith(`/${completed.id}`)
          ? json({ run })
          : defaultRead(input),
    );
    mount(false);
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: `View run ${completed.createdAt}` }));
    const metrics = await screen.findByRole('region', { name: 'Argo CD: Engineering metrics' });
    expect(within(metrics).getAllByRole('heading')).toHaveLength(5);
    expect(
      within(metrics).getByRole('region', { name: 'Argo CD: Failed deployment recovery time' }),
    ).toHaveTextContent('600 seconds');
  });

  it('member reads sealed capture bounds and missing intervals without archive write controls', async () => {
    const captured = {
      ...completed,
      result: { ...completed.result, archiveSummary, coverageAssessment },
    };
    fetchMock.mockImplementation(async (input) =>
      String(input).endsWith('/argo-collection-runs')
        ? json({ runs: [captured] })
        : String(input).endsWith(`/${completed.id}`)
          ? json({ run: captured })
          : defaultRead(input),
    );
    mount(false);
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: `View run ${completed.createdAt}` }));
    const detail = await screen.findByRole('region', { name: 'Live Argo run detail' });
    expect(within(detail).getByText(/Sealed capture interval: 2026-01-01T01:00:00Z/)).toBeVisible();
    expect(within(detail).getByText(/Archive gaps: 1.*Missing capture intervals: 1/)).toBeVisible();
    expect(within(detail).getByText(/Metric evidence uses current grants/)).toBeVisible();
    expect(within(detail).getByText(/Coverage remains incomplete/)).toBeVisible();
    expect(screen.queryByLabelText('Source history archive')).not.toBeInTheDocument();
    expect(
      within(detail).getByRole('region', { name: 'Coverage evidence needed' }),
    ).toHaveTextContent('Unknown qualification across retained history: 2');
    expect(
      within(detail).getByText(/authoritative census covering every production deployment path/),
    ).toBeVisible();
    expect(posts()).toHaveLength(0);
  });
  it('owner selects only granted archive and save acknowledgement preserves exact selection', async () => {
    fetchMock.mockImplementation(async (input, options) =>
      options?.method === 'POST'
        ? json({
            connection: { ...connection, revision: 2, enrichmentProducers: [], archiveProducer },
          })
        : String(input).endsWith('/argo-connection')
          ? json({
              connection,
              configured: true,
              sources: [{ ...source, archiveProducers: [archiveProducer] }],
            })
          : defaultRead(input),
    );
    mount();
    const user = userEvent.setup();
    await user.selectOptions(
      await screen.findByLabelText('Source history archive'),
      archiveProducer.producerId,
    );
    await user.click(screen.getByRole('checkbox', { name: /I assign all deployment operations/ }));
    await user.click(screen.getByRole('button', { name: 'Save Argo connection' }));
    await screen.findByText('Argo connection saved.');
    expect(JSON.parse(String(posts()[0]?.[1]?.body)).archiveProducerId).toBe(
      archiveProducer.producerId,
    );
  });
  it('member reads connection/history/detail and honest zero provisional count without write controls', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).endsWith('/argo-collection-runs')
        ? json({ runs: [completed] })
        : defaultRead(input),
    );
    mount(false);
    await screen.findByText(/Connected: delivery/);
    expect(screen.queryByRole('button', { name: 'Save Argo connection' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect Argo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Collect Argo evidence' })).not.toBeInTheDocument();
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: `View run ${completed.createdAt}` }));
    const detail = await screen.findByRole('region', { name: 'Live Argo run detail' });
    expect(await within(detail).findByText(/Argo transport history incomplete/)).toHaveTextContent(
      'does not establish complete metric coverage',
    );
    expect(within(detail).getByText(/Unknown qualification: 2/)).toBeVisible();
    expect(
      within(detail).getByText(/This older result has no saved coverage assessment/),
    ).toBeVisible();
    expect(
      within(detail).getByText(/Retained receipts across all dates at cutoff: 4/),
    ).toBeVisible();
    expect(
      within(detail).getByText(/Retained evidence records across all dates at cutoff: 2/),
    ).toBeVisible();
    expect(within(detail).getByText(/Recorded gaps: 2/)).toBeVisible();
    expect(within(detail).getByText(/Rejections: 3.*Scope drift: 1/)).toBeVisible();
    expect(within(detail).getByText(/Observation period: 2025-12-01/)).toBeVisible();
    expect(within(detail).getByText(/Native consumer exposure remains unknown/)).toBeVisible();

    expect(within(detail).getByText(/Provisional deployment frequency count: 0/)).toHaveTextContent(
      'not a complete deployment measurement',
    );
    expect(within(detail).getByText(/Evidence cutoff:.*OEMS revision:/)).toBeVisible();
    expect(
      within(detail).getByText(/All five metric details unavailable for this older saved result/),
    ).toBeVisible();
    expect(posts()).toHaveLength(0);
  });
  it('shows independent receipts without claiming complete coverage or build activation', async () => {
    const enriched = {
      ...completed,
      result: {
        ...completed.result,
        enrichmentSummary: {
          retainedReceiptCount: 2,
          consumerExposureCount: 1,
          applicationProvenanceCount: 1,
          policies: [
            {
              producerId: '99999999-9999-4999-8999-999999999999',
              capability: 'consumer_exposure',
              policyReference: 'urn:fixture:traffic:v1',
            },
            {
              producerId: '88888888-8888-4888-8888-888888888888',
              capability: 'application_provenance',
              policyReference: 'urn:fixture:build:v1',
            },
          ],
        },
      },
    };
    fetchMock.mockImplementation(async (input) =>
      String(input).endsWith('/argo-collection-runs')
        ? json({ runs: [enriched] })
        : String(input).endsWith(`/${completed.id}`)
          ? json({ run: enriched })
          : defaultRead(input),
    );
    mount(false);
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: `View run ${completed.createdAt}` }));
    const detail = await screen.findByRole('region', { name: 'Live Argo run detail' });
    expect(within(detail).getByText(/Independent exposure receipts are available/)).toBeVisible();
    expect(
      within(detail).getByText(/Independent exposure receipts: 1.*Build provenance receipts: 1/),
    ).toBeVisible();
    expect(within(detail).getByText(/Argo transport history incomplete/)).toBeVisible();
    expect(within(detail).getByText(/Provisional deployment frequency count: 0/)).toBeVisible();
    expect(
      within(detail).queryByText(/Native consumer exposure remains unknown/),
    ).not.toBeInTheDocument();
  });
  it('requires owner review when a selected producer policy is no longer granted', async () => {
    const producer = {
      producerId: '99999999-9999-4999-8999-999999999999',
      capability: 'consumer_exposure',
      policyReference: 'urn:fixture:traffic:v1',
    };
    fetchMock.mockImplementation(async (input, options) =>
      options?.method === 'POST'
        ? json({ connection: { ...connection, revision: 2, enrichmentProducers: [] } })
        : String(input).endsWith('/argo-connection')
          ? json({
              connection: { ...connection, enrichmentProducers: [producer] },
              configured: true,
              sources: [source],
            })
          : defaultRead(input),
    );
    mount();
    expect(await screen.findByText(/Granted source changed. An owner must review/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Collect Argo evidence' })).not.toBeInTheDocument();
    expect(screen.getByText(/Consumer exposure: urn:fixture:traffic:v1/)).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: /I assign all deployment operations/ }));
    await user.click(screen.getByRole('button', { name: 'Save Argo connection' }));
    await screen.findByText('Argo connection saved.');
    expect(JSON.parse(String(posts()[0]?.[1]?.body)).enrichmentProducerIds).toEqual([]);
  });
  it('preserves existing native policy metadata when saving the same source', async () => {
    const legacy = { ...connection, exposurePolicyReference: 'urn:fixture:legacy:v1' };
    fetchMock.mockImplementation(async (input, options) =>
      options?.method === 'POST'
        ? json({ connection: { ...legacy, revision: 2, enrichmentProducers: [] } })
        : String(input).endsWith('/argo-connection')
          ? json({ connection: legacy, configured: true, sources: [source] })
          : defaultRead(input),
    );
    mount();
    const user = userEvent.setup();
    expect(
      await screen.findByText(/Legacy native policy reference: urn:fixture:legacy:v1/),
    ).toBeVisible();
    await user.click(screen.getByRole('checkbox', { name: /I assign all deployment operations/ }));
    await user.click(screen.getByRole('button', { name: 'Save Argo connection' }));
    await screen.findByText('Argo connection saved.');
    expect(JSON.parse(String(posts()[0]?.[1]?.body)).exposurePolicyReference).toBe(
      legacy.exposurePolicyReference,
    );
  });
  it.each([null, connection])(
    'unconfigured workspace shows operator setup, no save/enqueue, history still readable %#',
    async (saved) => {
      fetchMock.mockImplementation(async (input) =>
        String(input).endsWith('/argo-connection')
          ? json({ connection: saved, configured: false, sources: [] })
          : json({ runs: [completed] }),
      );
      mount();
      expect(await screen.findByText(/Operator setup needed/)).toBeVisible();
      expect(
        screen.queryByRole('button', { name: 'Save Argo connection' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Collect Argo evidence' }),
      ).not.toBeInTheDocument();
      expect(
        await screen.findByRole('button', { name: `View run ${completed.createdAt}` }),
      ).toBeVisible();
    },
  );
  it('owner selects granted source and attests; production environment cannot be edited', async () => {
    const producer = {
      producerId: '99999999-9999-4999-8999-999999999999',
      capability: 'consumer_exposure',
      policyReference: 'policy/v2',
    };
    fetchMock.mockImplementation(async (input, options) =>
      options?.method === 'POST'
        ? json({
            connection: {
              ...connection,
              revision: 2,
              exposurePolicyReference: null,
              enrichmentProducers: [producer],
            },
          })
        : String(input).endsWith('/argo-connection')
          ? json({
              connection,
              configured: true,
              sources: [{ ...source, enrichmentProducers: [producer] }],
            })
          : defaultRead(input),
    );
    mount();
    const user = userEvent.setup();
    const save = await screen.findByRole('button', { name: 'Save Argo connection' });
    expect(screen.getByLabelText('Granted Argo source')).toHaveValue(source.sourceId);
    expect(screen.getByText(/Production environment from grant: production/)).toBeVisible();
    expect(
      screen.queryByLabelText(/Exact production environment|Token|Endpoint|Repository ID/),
    ).not.toBeInTheDocument();
    await user.click(save);
    expect(await screen.findByRole('alert')).toHaveTextContent('confirm application assignment');
    expect(posts()).toHaveLength(0);
    await user.click(screen.getByRole('checkbox', { name: /I assign all deployment operations/ }));
    expect(screen.queryByLabelText('Exposure policy reference (optional)')).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Production consumer exposure/ }));
    await user.click(save);
    await screen.findByText('Argo connection saved.');
    expect(JSON.parse(String(posts()[0]?.[1]?.body))).toEqual({
      expectedRevision: 1,
      sourceId: source.sourceId,
      archiveProducerId: null,
      applicationOperationsBelongToService: true,
      exposurePolicyReference: null,
      enrichmentProducerIds: [producer.producerId],
    });
    expect(
      screen.getByRole('checkbox', { name: /I assign all deployment operations/ }),
    ).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Production consumer exposure/ })).toBeChecked();
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
      return String(input).endsWith('/argo-connection')
        ? json({ connection: saved, configured: true, sources: [source] })
        : json({ runs: [] });
    });
    mount();
    const user = userEvent.setup();
    await screen.findByRole('checkbox');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Save Argo connection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Refresh connection and runs');
    expect(screen.getByRole('button', { name: 'Save Argo connection' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Refresh connection and runs' }));
    await screen.findByText(/Saved revision 2/);
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Save Argo connection' }));
    await screen.findByText('Argo connection saved.');
    expect(JSON.parse(String(posts()[1]?.[1]?.body)).expectedRevision).toBe(2);
  });
  it('disconnect pins expected revision, keeps history and removes collection until reconnect', async () => {
    fetchMock.mockImplementation(async (input, options) =>
      options?.method === 'POST'
        ? json({ connection: { ...connection, revision: 2, active: false } })
        : String(input).endsWith('/argo-collection-runs')
          ? json({ runs: [completed] })
          : defaultRead(input),
    );
    mount();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Disconnect Argo' }));
    expect(await screen.findByText(/Disconnected: delivery.*Saved revision 2/)).toBeVisible();
    expect(
      screen.getByText('Disconnected from Clio ingestion. Retained history remains available.'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Collect Argo evidence' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: `View run ${completed.createdAt}` })).toBeVisible();
    expect(String(posts()[0]?.[0])).toContain('/argo-connection/disconnect');
    expect(JSON.parse(String(posts()[0]?.[1]?.body))).toEqual({ expectedRevision: 1 });
  });
  it('validates closed calendar window, queues pinned revision, prevents double submit', async () => {
    const late = deferred();
    fetchMock.mockImplementation(async (input, options) =>
      options?.method === 'POST' ? late.promise : defaultRead(input),
    );
    mount();
    await screen.findByRole('button', { name: 'Collect Argo evidence' });
    const user = userEvent.setup();
    const button = screen.getByRole('button', { name: 'Collect Argo evidence' });
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
      String(input).endsWith('/argo-collection-runs')
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
      await screen.findByRole('button', { name: 'Collect Argo evidence' });
      dates();
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Collect Argo evidence' }));
      const retry = await screen.findByRole('button', { name: 'Retry collection request' });
      expect(screen.getByLabelText('Start date (UTC)')).toBeDisabled();
      await user.click(retry);
      await screen.findByText('Collection confirmed for saved revision 1.');
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Collect Argo evidence' })).toBeEnabled(),
      );
      await user.click(screen.getByRole('button', { name: 'Collect Argo evidence' }));
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
    await screen.findByRole('button', { name: 'Collect Argo evidence' });
    dates();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Collect Argo evidence' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You can still read history');
    expect(screen.getByRole('button', { name: 'Save Argo connection' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Disconnect Argo' })).toBeEnabled();
    view.demote();
    expect(screen.queryByRole('button', { name: 'Disconnect Argo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Collect Argo evidence' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save Argo connection' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh connection and runs' })).toBeEnabled();
  });
  it('read authorization loss clears displayed connection/history/cache; current 401 expires session', async () => {
    let status = 200;
    fetchMock.mockImplementation(async (input) =>
      status === 200 ? defaultRead(input) : json({}, status),
    );
    const view = mount();
    await screen.findByText(/Connected: delivery/);
    status = 404;
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Refresh connection and runs' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer available');
    expect(screen.queryByText(/Connected: delivery/)).not.toBeInTheDocument();
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
          return path.endsWith('/argo-connection')
            ? json({ connection: null, configured: true, sources: [source] })
            : json({ runs: [] });
        if (
          (operation === 'connection' && path.endsWith('/argo-connection')) ||
          (operation === 'runs' && path.endsWith('/argo-collection-runs')) ||
          (operation === 'save' && options?.method === 'POST') ||
          (operation === 'queue' && options?.method === 'POST') ||
          (operation === 'detail' && path.endsWith(`/${completed.id}`))
        )
          return late.promise;
        return path.endsWith('/argo-collection-runs')
          ? json({ runs: [completed] })
          : defaultRead(input);
      });
      const view = mount();
      const user = userEvent.setup();
      if (operation === 'save') {
        await user.click(await screen.findByRole('checkbox'));
        await user.click(screen.getByRole('button', { name: 'Save Argo connection' }));
      }
      if (operation === 'queue') {
        await screen.findByRole('button', { name: 'Collect Argo evidence' });
        dates();
        await user.click(screen.getByRole('button', { name: 'Collect Argo evidence' }));
      }
      if (operation === 'detail')
        await user.click(
          await screen.findByRole('button', { name: `View run ${completed.createdAt}` }),
        );
      view.switchScope(other);
      await screen.findByText('No live Argo connection saved.');
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
              ((operation === 'connection' && String(input).endsWith('/argo-connection')) ||
                (operation === 'runs' && String(input).endsWith('/argo-collection-runs')) ||
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
      await screen.findByRole('button', { name: 'Collect Argo evidence' });
      dates();
      await userEvent.setup().click(screen.getByRole('button', { name: 'Collect Argo evidence' }));
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
      if (path.endsWith('/github-connection')) return json({ connection: null, configured: false });
      return defaultRead(input);
    });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <WorkspacePage authError={false} />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('Workspace'), scope.workspaceId);
    await user.click(await screen.findByRole('button', { name: 'Live Argo for Delivery' }));
    expect(await screen.findByRole('heading', { name: 'Live Argo · Delivery' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save mock settings' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mock settings for Delivery' }));
    expect(await screen.findByRole('button', { name: 'Save mock settings' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Live Argo · Delivery' })).not.toBeInTheDocument();
  });
  it('creates first connection with null revision and blocks duplicate save clicks while confirmation waits', async () => {
    const late = deferred();
    fetchMock.mockImplementation(async (input, options) =>
      options?.method === 'POST'
        ? late.promise
        : String(input).endsWith('/argo-connection')
          ? json({ connection: null, configured: true, sources: [source] })
          : json({ runs: [] }),
    );
    mount();
    await screen.findByText('No live Argo connection saved.');
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox'));
    const button = screen.getByRole('button', { name: 'Save Argo connection' });
    await user.click(button);
    await user.click(button);
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0]?.[1]?.body)).expectedRevision).toBeNull();
    await act(async () => {
      late.resolve(json({ connection }));
      await late.promise;
    });
    expect(await screen.findByText('Argo connection saved.')).toBeVisible();
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
    await screen.findByRole('button', { name: 'Collect Argo evidence' });
    dates();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Collect Argo evidence' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('another collection is active');
    expect(screen.getByRole('button', { name: 'Collect Argo evidence' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Refresh connection and runs' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Collect Argo evidence' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Collect Argo evidence' }));
    await screen.findByText('Collection confirmed for saved revision 1.');
    const bodies = posts().map(([, options]) => JSON.parse(String(options?.body)));
    expect(bodies[0].requestId).not.toBe(bodies[1].requestId);
  });
  it('new connection revision clears uncertain collection replay and dates', async () => {
    let saved = connection;
    fetchMock.mockImplementation(async (input, options) => {
      if (options?.method === 'POST') throw new TypeError('network');
      return String(input).endsWith('/argo-connection')
        ? json({ connection: saved, configured: true, sources: [source] })
        : json({ runs: [] });
    });
    mount();
    await screen.findByRole('button', { name: 'Collect Argo evidence' });
    dates();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Collect Argo evidence' }));
    await screen.findByRole('button', { name: 'Retry collection request' });
    saved = { ...connection, revision: 2 };
    await user.click(screen.getByRole('button', { name: 'Refresh connection and runs' }));
    await screen.findByText('Collect saved connection revision 2');
    expect(screen.getByLabelText('Start date (UTC)')).toHaveValue('');
    dates();
    await user.click(screen.getByRole('button', { name: 'Collect Argo evidence' }));
    await screen.findByRole('button', { name: 'Retry collection request' });
    const bodies = posts().map(([, options]) => JSON.parse(String(options?.body)));
    expect(bodies[1].connectionRevision).toBe(2);
    expect(bodies[1].requestId).not.toBe(bodies[0].requestId);
  });
  it('incomplete transport and failed detail stay honest; private processing codes never rendered', async () => {
    let failed = false,
      revoked = false;
    fetchMock.mockImplementation(async (input) => {
      const run = failed
        ? {
            ...completed,
            status: 'failed',
            failureCode: revoked ? 'argo_connection_revoked' : 'argo_processing_failed',
            result: null,
          }
        : { ...completed, result: { ...completed.result, transportComplete: false } };
      return String(input).endsWith('/argo-collection-runs')
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
    expect(await screen.findByText(/Argo transport history incomplete/)).toBeVisible();
    failed = true;
    await user.click(screen.getByRole('button', { name: 'Refresh connection and runs' }));
    expect(
      await screen.findByText(/Collection failed. An owner can try another run/),
    ).toBeVisible();
    expect(screen.queryByText(/argo_processing_failed/)).not.toBeInTheDocument();
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
        String(input).endsWith('/argo-collection-runs')
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
        String(input).endsWith('/argo-collection-runs')
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
  it('unverifiable replay requires successful history review and explicit duplicate-risk acknowledgement before unlock', async () => {
    fetchMock.mockImplementation(async (input, options) =>
      options?.method === 'POST'
        ? json({ run: { ...completed, connectionRevision: 9 } }, 202)
        : defaultRead(input),
    );
    mount();
    await screen.findByRole('button', { name: 'Collect Argo evidence' });
    dates();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Collect Argo evidence' }));
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
        : String(input).endsWith('/argo-collection-runs')
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
    await user.click(screen.getByRole('button', { name: 'Collect Argo evidence' }));
    const bodies = posts().map(([, options]) => JSON.parse(String(options?.body)));
    expect(bodies[2].requestId).not.toBe(bodies[1].requestId);
    expect(bodies[2].window.start).toBe('2026-01-02T00:00:00Z');
  });
  it('failed history review keeps replay locked and retry uses original ID/window', async () => {
    let historyFails = false;
    fetchMock.mockImplementation(async (input, options) => {
      if (options?.method === 'POST') throw new TypeError('network');
      if (historyFails && String(input).endsWith('/argo-collection-runs')) return json({}, 503);
      return defaultRead(input);
    });
    mount();
    await screen.findByRole('button', { name: 'Collect Argo evidence' });
    dates();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Collect Argo evidence' }));
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
      if (connectionFails && String(input).endsWith('/argo-connection')) return json({}, 503);
      return defaultRead(input);
    });
    mount();
    await screen.findByRole('button', { name: 'Collect Argo evidence' });
    dates();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Collect Argo evidence' }));
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
        return path.endsWith('/argo-connection')
          ? json({ connection: null, configured: true, sources: [source] })
          : json({ runs: [] });
      if (options?.method === 'POST') throw new TypeError('network');
      if (reviewing && path.endsWith('/argo-collection-runs')) return late.promise;
      return defaultRead(input);
    });
    const view = mount();
    await screen.findByRole('button', { name: 'Collect Argo evidence' });
    dates();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Collect Argo evidence' }));
    await screen.findByRole('button', { name: 'Retry collection request' });
    reviewing = true;
    await user.click(screen.getByRole('button', { name: 'Review latest collection history' }));
    view.switchScope(other);
    await screen.findByText('No live Argo connection saved.');
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
  it('source grant changes reset attestation and require re-save before collection', async () => {
    let granted = source;
    fetchMock.mockImplementation(async (input) =>
      String(input).endsWith('/argo-connection')
        ? json({ connection, configured: true, sources: [granted] })
        : json({ runs: [] }),
    );
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox'));
    granted = { ...source, applicationName: 'replacement' };
    await user.click(screen.getByRole('button', { name: 'Refresh connection and runs' }));
    expect(
      await screen.findByText(/Granted source changed.*save the connection again/),
    ).toBeVisible();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.queryByRole('button', { name: 'Collect Argo evidence' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Argo connection' })).toBeEnabled();
  });
  it('rejects save response that changes selected granted source', async () => {
    fetchMock.mockImplementation(async (input, options) =>
      options?.method === 'POST'
        ? json({ connection: { ...connection, revision: 2, sourceId: scope.workspaceId } })
        : defaultRead(input),
    );
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Save Argo connection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('response could not be verified');
    expect(screen.queryByText('Argo connection saved.')).not.toBeInTheDocument();
    expect(screen.getByText(/Saved revision 1/)).toBeVisible();
  });
  it.each(['private', 'scope', 'pin'])(
    'malformed %s DTO never reaches visible result or cache',
    async (kind) => {
      const patch =
        kind === 'private'
          ? { tokenFile: '/private-secret' }
          : kind === 'scope'
            ? { serviceId: scope.workspaceId }
            : { oemsRevision: 'wrong-pin' };
      fetchMock.mockImplementation(async (input) =>
        String(input).endsWith('/argo-collection-runs')
          ? json({ runs: [completed] })
          : String(input).endsWith(`/${completed.id}`)
            ? json({ run: { ...completed, result: { ...completed.result, ...patch } } })
            : defaultRead(input),
      );
      const view = mount(false);
      await userEvent
        .setup()
        .click(await screen.findByRole('button', { name: `View run ${completed.createdAt}` }));
      expect(await screen.findByRole('alert')).toHaveTextContent('response could not be verified');
      expect(
        screen.queryByText(/private-secret|wrong-pin|Provisional deployment frequency count/),
      ).not.toBeInTheDocument();
      expect(
        view.client
          .getQueryCache()
          .getAll()
          .filter((query) => query.queryKey.includes('detail'))
          .every((query) => query.state.data === undefined),
      ).toBe(true);
    },
  );
  it('changing granted source clears assignment; saves chosen source and grant environment', async () => {
    const second = {
      ...source,
      sourceId: '88888888-8888-4888-8888-888888888888',
      applicationName: 'second-app',
      environment: 'Production-EU',
    };
    fetchMock.mockImplementation(async (input, options) =>
      options?.method === 'POST'
        ? json({
            connection: {
              ...connection,
              revision: 2,
              sourceId: second.sourceId,
              applicationName: second.applicationName,
              productionEnvironment: second.environment,
            },
          })
        : String(input).endsWith('/argo-connection')
          ? json({ connection, configured: true, sources: [source, second] })
          : json({ runs: [] }),
    );
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox'));
    await user.selectOptions(screen.getByLabelText('Granted Argo source'), second.sourceId);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByText('Production environment from grant: Production-EU')).toBeVisible();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Save Argo connection' }));
    expect(await screen.findByText(/Connected: second-app.*Production-EU/)).toBeVisible();
    expect(JSON.parse(String(posts()[0]?.[1]?.body))).toEqual({
      expectedRevision: 1,
      sourceId: second.sourceId,
      archiveProducerId: null,
      enrichmentProducerIds: [],
      exposurePolicyReference: null,
      applicationOperationsBelongToService: true,
    });
  });
});
