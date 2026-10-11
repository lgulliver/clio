import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/query-client';
import { completed as argoBasis } from '../argo-collection/fixtures.test-support';
import { authorities, basis, json, queued, runFixture, scope } from './fixtures.test-support';
import { MeasurementEvidence } from './measurement-evidence';

const identity = vi.hoisted(() => ({ revision: 1, valid: true, userId: 'alice', expire: vi.fn() }));
vi.mock('../identity/session', () => ({
  useSession: () => ({
    revision: identity.revision,
    current: (revision: number) => identity.valid && identity.revision === revision,
    expire: identity.expire,
    status: 'ready',
    user: { id: identity.userId },
  }),
}));
const fetchMock =
  vi.fn<(input: string | URL | Request, options?: RequestInit) => Promise<Response>>();
const lost = vi.fn();
const otherService = '44444444-4444-4444-8444-444444444444';
function defaultRead(input: string | URL | Request, options?: RequestInit): Response {
  const path = String(input);
  if (options?.method === 'POST') return json({ run: queued }, 202);
  if (path.includes('github-collection-runs')) return json({ runs: [basis], nextCursor: null });
  if (path.includes('argo-collection-runs')) return json({ runs: [argoBasis], nextCursor: null });
  if (path.endsWith('/services'))
    return json({
      services: [{ id: scope.serviceId, workspaceId: scope.workspaceId, name: 'Delivery' }],
    });
  if (path.endsWith('/measurement-runs')) return json({ runs: [], nextCursor: null });
  if (path.includes('measurement-authorities')) return json({ authorities });
  return json({ run: queued });
}
function mount(strict = false, basisProvider?: 'github' | 'argocd') {
  const client = createQueryClient();
  let serviceId = scope.serviceId;
  const content = () => (
    <QueryClientProvider client={client}>
      {strict ? (
        <StrictMode>
          <MeasurementEvidence
            {...scope}
            serviceId={serviceId}
            serviceName="Delivery"
            onAccessLost={lost}
            {...(basisProvider ? { basisProvider } : {})}
          />
        </StrictMode>
      ) : (
        <MeasurementEvidence
          {...scope}
          serviceId={serviceId}
          serviceName="Delivery"
          onAccessLost={lost}
          {...(basisProvider ? { basisProvider } : {})}
        />
      )}
    </QueryClientProvider>
  );
  const view = render(content());
  return {
    ...view,
    client,
    refresh: () => view.rerender(content()),
    changeService: () => {
      serviceId = otherService;
      view.rerender(content());
    },
  };
}
async function chooseBasis() {
  fireEvent.click(await screen.findByRole('button', { name: 'Use selected saved collection' }));
  await screen.findByRole('radio', { name: /Fictional deployment census/ });
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
function posts() {
  return fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST');
}
beforeEach(() => {
  identity.revision = 1;
  identity.valid = true;
  identity.userId = 'alice';
  identity.expire.mockReset();
  lost.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, options) => defaultRead(input, options));
  vi.stubGlobal('fetch', fetchMock);
});
describe('owner independent measurement workflow', () => {
  it('pins wizard evidence to Argo without reading GitHub basis history', async () => {
    mount(false, 'argocd');
    await screen.findByRole('button', { name: 'Use selected saved collection' });
    expect(screen.getByLabelText('Basis provider')).toHaveValue('argocd');
    expect(screen.getByLabelText('Basis provider')).toBeDisabled();
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes('argo-collection-runs')),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes('github-collection-runs')),
    ).toBe(false);
  });
  it('selects one received authority per capability and queues only exact allowed fields', async () => {
    mount(true);
    await chooseBasis();
    expect(
      screen.getByText(/Original collection evidence cutoff: 2026-01-04T00:00:30.000001Z/),
    ).toBeVisible();
    const first = screen.getByRole('radio', { name: /Fictional deployment census/ }),
      second = screen.getByRole('radio', { name: /Fictional second census/ });
    fireEvent.click(first);
    fireEvent.click(second);
    expect(first).not.toBeChecked();
    expect(second).toBeChecked();
    expect(screen.getByRole('radio', { name: /Fictional history/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Calculate saved measurement' }));
    expect(await screen.findByText(/Measurement request: pending/)).toBeVisible();
    const options = posts()[0]?.[1];
    const body: unknown = JSON.parse(String(options?.body));
    expect(body).toEqual({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      provider: 'github',
      basisRunId: basis.id,
      producerIds: [authorities[1]?.producerId],
    });
    expect(options?.credentials).toBe('include');
    expect(options?.signal).toBeDefined();
  });
  it('allows explicitly explained partial calculation with no configured reports', async () => {
    fetchMock.mockImplementation(async (input, options) =>
      String(input).includes('measurement-authorities')
        ? json({ authorities: [] })
        : defaultRead(input, options),
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Use selected saved collection' }));
    expect(await screen.findByText(/No configured evidence authorities/)).toBeVisible();
    expect(
      screen.getByText(/Calculating with no reports saves a partial measurement/),
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Calculate saved measurement' }));
    await screen.findByText(/Measurement request: pending/);
    expect(JSON.parse(String(posts()[0]?.[1]?.body)).producerIds).toEqual([]);
  });
  it('preserves queue focus while pending and guards repeated clicks and radio changes', async () => {
    const late = deferred();
    fetchMock.mockImplementation(async (input, options) =>
      options?.method === 'POST' ? late.promise : defaultRead(input, options),
    );
    mount();
    await chooseBasis();
    const first = screen.getByRole('radio', { name: /Fictional deployment census/ });
    fireEvent.click(first);
    const button = screen.getByRole('button', { name: 'Calculate saved measurement' });
    button.focus();
    fireEvent.click(button);
    expect(button).toHaveFocus();
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('radio', { name: /Fictional second census/ }));
    expect(first).toBeChecked();
    expect(posts()).toHaveLength(1);
    await act(async () => late.resolve(json({ run: queued }, 202)));
    await screen.findByText(/Measurement request: pending/);
    expect(button).toHaveFocus();
  });
  it('uses same replay requestId after ambiguous failure, changes it after selection changes', async () => {
    fetchMock.mockImplementation(async (input, options) =>
      options?.method === 'POST' ? json({}, 503) : defaultRead(input, options),
    );
    mount();
    await chooseBasis();
    const button = screen.getByRole('button', { name: 'Calculate saved measurement' });
    fireEvent.click(button);
    await screen.findByRole('alert');
    fireEvent.click(button);
    await waitFor(() => expect(posts()).toHaveLength(2));
    await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'false'));
    expect(JSON.parse(String(posts()[0]?.[1]?.body)).requestId).toBe(
      JSON.parse(String(posts()[1]?.[1]?.body)).requestId,
    );
    fireEvent.click(screen.getByRole('radio', { name: /Fictional deployment census/ }));
    fireEvent.click(button);
    await waitFor(() => expect(posts()).toHaveLength(3));
    expect(JSON.parse(String(posts()[2]?.[1]?.body)).requestId).not.toBe(
      JSON.parse(String(posts()[1]?.[1]?.body)).requestId,
    );
  });
  it('refreshes pending status into full five-metric result without recomputing native basis', async () => {
    let done = false;
    fetchMock.mockImplementation(async (input, options) =>
      String(input).endsWith(`/measurement-runs/${queued.id}`)
        ? json({ run: done ? runFixture() : queued })
        : defaultRead(input, options),
    );
    mount();
    await chooseBasis();
    fireEvent.click(screen.getByRole('button', { name: 'Calculate saved measurement' }));
    await screen.findByText(/Measurement request: pending/);
    const refresh = screen.getByRole('button', { name: 'Refresh measurement status' });
    await waitFor(() => expect(refresh).toHaveAttribute('aria-disabled', 'false'));
    done = true;
    refresh.focus();
    fireEvent.click(refresh);
    expect(await screen.findByText(/Measurement request: succeeded/)).toBeVisible();
    expect(refresh).toHaveFocus();
    const metrics = screen.getByRole('region', {
      name: 'Independent measurement: Engineering metrics',
    });
    for (const name of ['Deployment frequency', 'Change lead time'])
      fireEvent.click(
        within(
          within(metrics).getByRole('region', { name: `Independent measurement: ${name}` }),
        ).getByText('Evidence details', { selector: 'summary' }),
      );
    expect(within(metrics).getByText(/0.5 deployments per day/)).toBeVisible();
    expect(within(metrics).getByText(/86,400 seconds/)).toBeVisible();
    expect(screen.getByText('2026-01-04T00:01:00.000001Z', { selector: 'dd' })).toBeVisible();
    expect(posts()).toHaveLength(1);
  });
  it.each([404, 409])('treats unavailable basis %s as local evidence error', async (status) => {
    fetchMock.mockImplementation(async (input, options) =>
      String(input).includes('measurement-authorities')
        ? json({}, status)
        : defaultRead(input, options),
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Use selected saved collection' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        status === 404
          ? 'saved collection is unavailable'
          : 'measurement may already be in progress',
      ),
    );
    expect(lost).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Basis provider')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Calculate saved measurement' }));
    expect(posts()).toHaveLength(0);
  });
  it.each([401, 403])('fences owner controls after real access loss %s', async (status) => {
    fetchMock.mockImplementation(async (input, options) =>
      String(input).includes('measurement-authorities')
        ? json({}, status)
        : defaultRead(input, options),
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Use selected saved collection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer accessible');
    expect(lost).toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Calculate saved measurement' }),
    ).not.toBeInTheDocument();
    if (status === 401) expect(identity.expire).toHaveBeenCalledWith(1);
  });
  it.each([401, 403, 404, 'missing'] as const)(
    'rechecks authority 404 and blocks lost service access %s',
    async (status) => {
      fetchMock.mockImplementation(async (input, options) => {
        const path = String(input);
        if (path.includes('measurement-authorities')) return json({}, 404);
        if (path.endsWith('/services'))
          return status === 'missing' ? json({ services: [] }) : json({}, status);
        return defaultRead(input, options);
      });
      mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Use selected saved collection' }));
      expect(await screen.findByText(/no longer accessible/)).toBeVisible();
      expect(lost).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByRole('button', { name: 'Calculate saved measurement' }),
      ).not.toBeInTheDocument();
      expect(
        fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/services')),
      ).toHaveLength(1);
      if (status === 401) expect(identity.expire).toHaveBeenCalledWith(1);
    },
  );
  it('shows active request on POST conflict and preserves queue focus', async () => {
    let conflict = false;
    fetchMock.mockImplementation(async (input, options) => {
      if (options?.method === 'POST') {
        conflict = true;
        return json({}, 409);
      }
      if (String(input).endsWith('/measurement-runs'))
        return json({ runs: conflict ? [queued] : [], nextCursor: null });
      return defaultRead(input, options);
    });
    mount();
    await chooseBasis();
    const button = screen.getByRole('button', { name: 'Calculate saved measurement' });
    button.focus();
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'measurement may already be in progress',
    );
    expect(await screen.findByText(/GitHub measurement: pending/)).toBeVisible();
    expect(button).toHaveFocus();
  });
  it('discovers abandoned POST from owner history after provider switch', async () => {
    const late = deferred();
    let created = false;
    fetchMock.mockImplementation(async (input, options) => {
      if (options?.method === 'POST') {
        created = true;
        return late.promise;
      }
      if (String(input).endsWith('/measurement-runs'))
        return json({ runs: created ? [queued] : [], nextCursor: null });
      return defaultRead(input, options);
    });
    mount();
    await chooseBasis();
    fireEvent.click(screen.getByRole('button', { name: 'Calculate saved measurement' }));
    fireEvent.change(screen.getByLabelText('Basis provider'), { target: { value: 'argocd' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh measurement requests' }));
    expect(await screen.findByText(/GitHub measurement: pending/)).toBeVisible();
    await act(async () => late.resolve(json({ run: queued }, 202)));
    expect(screen.queryByText(/Measurement request: pending/)).not.toBeInTheDocument();
  });
  it.each(['POST', 'detail'] as const)(
    'uses services recheck for %s 404 with accessible service',
    async (location) => {
      fetchMock.mockImplementation(async (input, options) => {
        if (location === 'POST' && options?.method === 'POST') return json({}, 404);
        if (location === 'detail' && String(input).endsWith(`/measurement-runs/${queued.id}`))
          return json({}, 404);
        return defaultRead(input, options);
      });
      mount();
      await chooseBasis();
      fireEvent.click(screen.getByRole('button', { name: 'Calculate saved measurement' }));
      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          location === 'detail'
            ? 'measurement request is unavailable'
            : 'saved collection is unavailable',
        ),
      );
      expect(lost).not.toHaveBeenCalled();
      expect(
        fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/services')),
      ).toHaveLength(1);
    },
  );
  it.each(['POST', 'detail'] as const)(
    'blocks owner panel after %s 404 recheck confirms lost service',
    async (location) => {
      fetchMock.mockImplementation(async (input, options) => {
        if (location === 'POST' && options?.method === 'POST') return json({}, 404);
        if (location === 'detail' && String(input).endsWith(`/measurement-runs/${queued.id}`))
          return json({}, 404);
        if (String(input).endsWith('/services')) return json({ services: [] });
        return defaultRead(input, options);
      });
      mount();
      await chooseBasis();
      fireEvent.click(screen.getByRole('button', { name: 'Calculate saved measurement' }));
      expect(await screen.findByText(/no longer accessible/)).toBeVisible();
      expect(lost).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByRole('button', { name: 'Calculate saved measurement' }),
      ).not.toBeInTheDocument();
    },
  );
  it('bounds failed access recheck, blocks actions and permits explicit retry', async () => {
    let accessible = false;
    fetchMock.mockImplementation(async (input, options) => {
      if (options?.method === 'POST') return json({}, 404);
      if (String(input).endsWith('/services') && !accessible) return json({}, 503);
      return defaultRead(input, options);
    });
    mount();
    await chooseBasis();
    const button = screen.getByRole('button', { name: 'Calculate saved measurement' });
    fireEvent.click(button);
    expect(await screen.findByText(/Workspace access could not be checked/)).toBeVisible();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(button);
    expect(posts()).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/services')),
    ).toHaveLength(1);
    expect(screen.queryByText(/saved collection is unavailable/)).not.toBeInTheDocument();
    accessible = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh received evidence' }));
    await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'false'));
    fireEvent.click(button);
    expect(await screen.findByText(/saved collection is unavailable/)).toBeVisible();
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/services')),
    ).toHaveLength(2);
    expect(lost).not.toHaveBeenCalled();
  });
  it('lets owner omit selected capability when refreshed authority disappears', async () => {
    let changed = false;
    fetchMock.mockImplementation(async (input, options) =>
      String(input).includes('measurement-authorities')
        ? json({ authorities: changed ? [] : authorities })
        : defaultRead(input, options),
    );
    mount();
    await chooseBasis();
    fireEvent.click(screen.getByRole('radio', { name: /Fictional deployment census/ }));
    changed = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh received evidence' }));
    await screen.findByText(/Selected evidence is no longer available/);
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Deployment population' })).getByRole('radio', {
        name: 'Omit this capability',
      }),
    );
    expect(screen.queryByText(/Selected evidence is no longer available/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Calculate saved measurement' }));
    await screen.findByText(/Measurement request: pending/);
    expect(JSON.parse(String(posts()[0]?.[1]?.body)).producerIds).toEqual([]);
  });
  it.each(['measurement_revoked', 'measurement_processing_failed'] as const)(
    'shows safe failed status %s',
    async (failureCode) => {
      fetchMock.mockImplementation(async (input, options) =>
        options?.method === 'POST'
          ? json({ run: { ...runFixture(), status: 'failed', result: null, failureCode } }, 202)
          : String(input).includes(`/measurement-runs/${queued.id}`)
            ? json({ run: { ...runFixture(), status: 'failed', result: null, failureCode } })
            : defaultRead(input, options),
      );
      mount();
      await chooseBasis();
      fireEvent.click(screen.getByRole('button', { name: 'Calculate saved measurement' }));
      expect(await screen.findByText(/Measurement request: failed/)).toHaveTextContent(
        failureCode === 'measurement_revoked' ? 'fresh basis' : 'Processing failed',
      );
    },
  );
});
describe('measurement selection and session fences', () => {
  it.each(['service', 'provider', 'session', 'unmount'] as const)(
    'abandons ignored-abort queue response after %s switch',
    async (change) => {
      const late = deferred();
      let signal: AbortSignal | null | undefined;
      fetchMock.mockImplementation(async (input, options) => {
        if (options?.method === 'POST') {
          signal = options.signal;
          return late.promise;
        }
        return defaultRead(input, options);
      });
      const view = mount();
      await chooseBasis();
      fireEvent.click(screen.getByRole('button', { name: 'Calculate saved measurement' }));
      if (change === 'service') view.changeService();
      if (change === 'provider')
        fireEvent.change(screen.getByLabelText('Basis provider'), { target: { value: 'argocd' } });
      if (change === 'session') {
        identity.revision++;
        identity.userId = 'bob';
        view.refresh();
      }
      if (change === 'unmount') view.unmount();
      expect(signal?.aborted).toBe(true);
      await act(async () => late.resolve(json({ run: runFixture() }, 202)));
      expect(screen.queryByText(/Measurement request: succeeded/)).not.toBeInTheDocument();
      expect(screen.queryByText('Selected saved measurement')).not.toBeInTheDocument();
    },
  );
  it.each(['service', 'provider', 'session'] as const)(
    'abandons ignored-abort authority read after %s switch',
    async (change) => {
      const late = deferred();
      let signal: AbortSignal | null | undefined;
      fetchMock.mockImplementation(async (input, options) => {
        if (String(input).includes('measurement-authorities')) {
          signal = options?.signal;
          return late.promise;
        }
        return defaultRead(input, options);
      });
      const view = mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Use selected saved collection' }));
      await screen.findByText('Loading received evidence…');
      if (change === 'service') view.changeService();
      if (change === 'provider')
        fireEvent.change(screen.getByLabelText('Basis provider'), { target: { value: 'argocd' } });
      if (change === 'session') {
        identity.revision++;
        view.refresh();
      }
      expect(signal?.aborted).toBe(true);
      await act(async () => late.resolve(json({ authorities })));
      expect(
        screen.queryByRole('radio', { name: /Fictional deployment census/ }),
      ).not.toBeInTheDocument();
    },
  );
  it.each(['service', 'provider', 'basis', 'session', 'unmount'] as const)(
    'abandons ignored-abort access recheck after %s change',
    async (change) => {
      const late = deferred();
      let signal: AbortSignal | null | undefined;
      fetchMock.mockImplementation(async (input, options) => {
        if (String(input).includes('measurement-authorities')) return json({}, 404);
        if (String(input).endsWith('/services')) {
          signal = options?.signal;
          return late.promise;
        }
        if (String(input).includes('github-collection-runs'))
          return json({
            runs: [basis, { ...basis, id: '00000001-1111-4111-8111-111111111111' }],
            nextCursor: null,
          });
        return defaultRead(input, options);
      });
      const view = mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Use selected saved collection' }));
      await screen.findByText('Checking workspace access…');
      if (change === 'service') view.changeService();
      if (change === 'provider')
        fireEvent.change(screen.getByLabelText('Basis provider'), { target: { value: 'argocd' } });
      if (change === 'basis') {
        fireEvent.change(screen.getByLabelText('GitHub basis saved reporting window'), {
          target: { value: '00000001-1111-4111-8111-111111111111' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Use selected saved collection' }));
      }
      if (change === 'session') {
        identity.revision++;
        view.refresh();
      }
      if (change === 'unmount') view.unmount();
      expect(signal?.aborted).toBe(true);
      await act(async () => late.resolve(json({}, 403)));
      expect(lost).not.toHaveBeenCalled();
      expect(identity.expire).not.toHaveBeenCalled();
    },
  );
  it('rejects response from another service and keeps malformed queue result out of UI', async () => {
    fetchMock.mockImplementation(async (input, options) =>
      options?.method === 'POST'
        ? json({ run: { ...runFixture(), serviceId: otherService } }, 202)
        : defaultRead(input, options),
    );
    mount();
    await chooseBasis();
    fireEvent.click(screen.getByRole('button', { name: 'Calculate saved measurement' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('response could not be verified');
    expect(screen.queryByText('Selected saved measurement')).not.toBeInTheDocument();
  });
});
