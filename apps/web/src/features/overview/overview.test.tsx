import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { type ReactNode, StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/query-client';
import {
  archiveSummary,
  completed as argoCompleted,
  result as argoResult,
  coverageAssessment,
} from '../argo-collection/fixtures.test-support';
import {
  completed,
  result as githubResult,
  json,
  scope,
} from '../github-collection/fixtures.test-support';
import { withMetric } from '../measurements/fixtures.test-support';
import { completed as mockCompleted } from '../mock-collection/fixtures.test-support';
import { Overview } from './overview';

const identity = vi.hoisted(() => ({
  revision: 1,
  valid: true,
  status: 'ready',
  userId: 'alice',
  expire: vi.fn(),
}));
vi.mock('../identity/session', () => ({
  useSession: () => ({
    revision: identity.revision,
    current: (revision: number) => identity.valid && revision === identity.revision,
    expire: identity.expire,
    status: identity.status,
    user: identity.status === 'ready' ? { id: identity.userId } : null,
  }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));
const fetchMock =
  vi.fn<(input: string | URL | Request, options?: RequestInit) => Promise<Response>>();
const otherService = '44444444-4444-4444-8444-444444444444';
const otherWorkspace = '22222222-2222-4222-8222-222222222222';
function defaultRead(input: string | URL | Request) {
  const path = String(input);
  if (path.endsWith('/api/workspaces'))
    return json({
      workspaces: [
        { id: scope.workspaceId, name: 'First workspace', role: 'member' },
        { id: otherWorkspace, name: 'Other workspace', role: 'owner' },
      ],
    });
  if (path.endsWith('/services')) {
    const workspaceId = path.includes(otherWorkspace) ? otherWorkspace : scope.workspaceId;
    return json({
      services: [
        { id: scope.serviceId, name: 'Delivery', workspaceId },
        { id: otherService, name: 'Other service', workspaceId },
      ],
    });
  }
  return json({ runs: [] });
}
function mount(strict = false) {
  const client = createQueryClient();
  const content = () => (
    <QueryClientProvider client={client}>
      {strict ? (
        <StrictMode>
          <Overview />
        </StrictMode>
      ) : (
        <Overview />
      )}
    </QueryClientProvider>
  );
  const view = render(content());
  return { ...view, client, refreshSession: () => view.rerender(content()) };
}
async function select() {
  fireEvent.change(await screen.findByLabelText('Workspace'), {
    target: { value: scope.workspaceId },
  });
  fireEvent.change(await screen.findByLabelText('Service'), { target: { value: scope.serviceId } });
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
beforeEach(() => {
  identity.revision = 1;
  identity.valid = true;
  identity.status = 'ready';
  identity.userId = 'alice';
  identity.expire.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => defaultRead(input));
  vi.stubGlobal('fetch', fetchMock);
});

describe('stored results overview', () => {
  it('shows all five actual calculations for each live provider', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).endsWith('/github-collection-runs')
        ? json({ runs: [{ ...completed, result: withMetric(githubResult) }] })
        : String(input).endsWith('/argo-collection-runs')
          ? json({ runs: [{ ...argoCompleted, result: withMetric(argoResult) }] })
          : defaultRead(input),
    );
    mount();
    await select();
    const github = await screen.findByRole('region', { name: 'Live GitHub stored results' });
    const argo = await screen.findByRole('region', { name: 'Live Argo CD stored results' });
    for (const card of [github, argo]) {
      const metrics = await within(card).findByRole('region', { name: /Engineering metrics$/ });
      expect(within(metrics).getAllByRole('heading')).toHaveLength(5);
      expect(within(metrics).getByRole('region', { name: /Change lead time$/ })).toHaveTextContent(
        'Observed candidates: 1',
      );
    }
  });

  it('signed-out/checking/error states make no evidence absence claim or protected reads', () => {
    identity.status = 'signed-out';
    const view = mount();
    expect(
      screen.getByText('Sign in with GitHub to inspect stored service evidence.'),
    ).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    identity.status = 'checking';
    view.refreshSession();
    expect(screen.getByRole('status')).toHaveTextContent('Checking your session');
    identity.status = 'error';
    view.refreshSession();
    expect(screen.getByText(/unavailable until your session/)).toBeVisible();
    expect(screen.queryByText(/No service evidence/)).not.toBeInTheDocument();
  });

  it('requires explicit selections, reads bounded empty histories and never starts collection', async () => {
    mount(true);
    await screen.findByLabelText('Workspace');
    expect(screen.queryByLabelText('Service')).not.toBeInTheDocument();
    await select();
    const region = await screen.findByRole('region', { name: 'Live GitHub stored results' });
    expect(
      await within(region).findByText(/No successful saved result in this recent history/),
    ).toBeVisible();
    expect(screen.getAllByText('No collection requests in this recent history.')).toHaveLength(3);
    expect(fetchMock.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => /connection|sources/.test(String(input)))).toBe(
      false,
    );
  });

  it('shows workspace loading, empty and retriable read errors honestly', async () => {
    const late = deferred();
    fetchMock.mockImplementationOnce(() => late.promise);
    mount();
    expect(screen.getByRole('status')).toHaveTextContent('Loading workspaces');
    await act(async () => late.resolve(json({}, 503)));
    expect(await screen.findByRole('alert')).toHaveTextContent('Clio is unavailable');
    fetchMock.mockImplementationOnce(async () => json({ workspaces: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry workspaces' }));
    expect(await screen.findByText(/No accessible workspaces/)).toBeVisible();
  });

  it('shows empty services without asserting evidence absence', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).endsWith('/services') ? json({ services: [] }) : defaultRead(input),
    );
    mount();
    fireEvent.change(await screen.findByLabelText('Workspace'), {
      target: { value: scope.workspaceId },
    });
    expect(await screen.findByText(/No services in this workspace/)).toBeVisible();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it.each(['failed', 'running', 'pending'] as const)(
    'preserves older stored success beside newest %s request',
    async (status) => {
      const newer = {
        ...completed,
        id: '66666666-6666-4666-8666-666666666666',
        status,
        createdAt: '2026-01-05T00:00:00Z',
        updatedAt: '2026-01-05T00:01:00Z',
        completedAt: status === 'failed' ? '2026-01-05T00:01:00Z' : null,
        failureCode: status === 'failed' ? 'github_processing_failed' : null,
        result: null,
      };
      fetchMock.mockImplementation(async (input) =>
        String(input).endsWith('/github-collection-runs')
          ? json({ runs: [newer, completed] })
          : defaultRead(input),
      );
      mount();
      await select();
      const card = screen.getByRole('region', { name: 'Live GitHub stored results' });
      expect(await within(card).findByText(/Newest request in this history:/)).toHaveTextContent(
        status,
      );
      expect(within(card).getByText(/older saved result does not describe/)).toBeVisible();
      expect(within(card).getByText(/Provisional deployment frequency count:/)).toHaveTextContent(
        '0. Not a complete deployment measurement.',
      );
      expect(within(card).getByText(/Unknown qualification: 2/)).toBeVisible();
      expect(within(card).getByText('2026-01-04T00:01:00.000001Z')).toBeVisible();
      expect(within(card).getByText(/2026-01-01T00:00:00Z to 2026-01-03T00:00:00Z/)).toBeVisible();
      expect(within(card).getByText(/Coverage incomplete/)).toBeVisible();
      expect(within(card).getByText(/All five metric details unavailable/)).toHaveTextContent(
        'unavailable',
      );
    },
  );

  it('separates live GitHub, live Argo and fictional mock results with their own windows', async () => {
    fetchMock.mockImplementation(async (input) => {
      const path = String(input);
      if (path.endsWith('/github-collection-runs')) return json({ runs: [completed] });
      if (path.endsWith('/argo-collection-runs')) return json({ runs: [argoCompleted] });
      if (path.endsWith('/mock-collection-runs')) return json({ runs: [mockCompleted] });
      return defaultRead(input);
    });
    mount(true);
    await select();
    const mock = screen.getByRole('region', { name: 'Mock — fictional evidence stored results' });
    expect(await within(mock).findByText(/Fictional GitHub sample/)).toHaveTextContent(
      "Does not measure this service's live delivery",
    );
    expect(
      within(mock).queryByText(/Provisional deployment frequency count/),
    ).not.toBeInTheDocument();
    expect(within(mock).getByText('Mapping revision')).toBeVisible();
    const github = screen.getByRole('region', { name: 'Live GitHub stored results' });
    const argo = screen.getByRole('region', { name: 'Live Argo CD stored results' });
    expect(await within(github).findByText(/GitHub history retrieval complete/)).toBeVisible();
    expect(await within(argo).findByText('Source transport coverage is incomplete.')).toBeVisible();
    expect(
      within(argo).getByText(/This older result has no saved coverage assessment/),
    ).toBeVisible();
    expect(within(github).queryByText(/Fictional/)).not.toBeInTheDocument();
    expect(within(argo).queryByText(/Fictional/)).not.toBeInTheDocument();
  });

  it('separates archived capture bounds from reporting window and receiver cutoff', async () => {
    const saved = {
      ...argoCompleted,
      result: { ...argoCompleted.result, archiveSummary, coverageAssessment },
    };
    fetchMock.mockImplementation(async (input) =>
      String(input).endsWith('/argo-collection-runs')
        ? json({ runs: [saved] })
        : defaultRead(input),
    );
    mount();
    await select();
    const card = screen.getByRole('region', { name: 'Live Argo CD stored results' });
    expect(
      await within(card).findByText(/Sealed capture interval: 2026-01-01T01:00:00Z/),
    ).toBeVisible();
    expect(within(card).getByText(/Coverage remains incomplete/)).toBeVisible();
    expect(within(card).getByText(/Archive gaps: 1/)).toBeVisible();
    expect(
      within(card).getByRole('region', { name: 'Coverage evidence needed' }),
    ).toHaveTextContent('Unknown qualification across retained history: 2');
  });
  it.each([null, '2026-01-02T00:00:00Z'])(
    'shows Argo observation limits and gaps with observation start %s',
    async (start) => {
      const saved = {
        ...argoCompleted,
        result: {
          ...argoCompleted.result,
          observationPeriod: { start, end: '2026-01-04T00:01:00.000001Z' },
        },
      };
      fetchMock.mockImplementation(async (input) =>
        String(input).endsWith('/argo-collection-runs')
          ? json({ runs: [saved] })
          : defaultRead(input),
      );
      mount();
      await select();
      const card = screen.getByRole('region', { name: 'Live Argo CD stored results' });
      expect(await within(card).findByText(/Receipt observation period:/)).toHaveTextContent(
        start ?? 'Unknown start',
      );
      expect(within(card).getByText(/Recorded gaps:/)).toHaveTextContent(
        'Recorded gaps: 2. Rejected receipts: 3. Scope drift: 1.',
      );
      expect(within(card).getByText(/Receipt observation period:/)).toHaveTextContent(
        'does not prove continuous coverage',
      );
      expect(within(card).getByText(/Recorded gaps:/)).toHaveTextContent(
        'Zero recorded gaps does not prove complete operation history.',
      );
    },
  );

  it.each(['/api/workspaces', '/services'])(
    'expires identity after 401 while reading %s',
    async (suffix) => {
      fetchMock.mockImplementation(async (input) =>
        String(input).endsWith(suffix) ? json({}, 401) : defaultRead(input),
      );
      mount();
      if (suffix === '/services')
        fireEvent.change(await screen.findByLabelText('Workspace'), {
          target: { value: scope.workspaceId },
        });
      await screen.findByRole('alert');
      expect(identity.expire).toHaveBeenCalledWith(identity.revision);
      expect(screen.queryByRole('region')).not.toBeInTheDocument();
    },
  );

  it('hides service results after service list access is lost', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).endsWith('/services') ? json({}, 404) : defaultRead(input),
    );
    mount();
    fireEvent.change(await screen.findByLabelText('Workspace'), {
      target: { value: scope.workspaceId },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer available');
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Service')).not.toBeInTheDocument();
  });

  it('rejects invalid source responses while preserving independently readable sources', async () => {
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith('/github-collection-runs'))
        return json({ runs: [{ ...completed, serviceId: otherService }] });
      if (String(input).endsWith('/argo-collection-runs')) return json({ runs: [argoCompleted] });
      return defaultRead(input);
    });
    mount();
    await select();
    const github = screen.getByRole('region', { name: 'Live GitHub stored results' });
    expect(await within(github).findByRole('alert')).toHaveTextContent(
      'response could not be verified',
    );
    expect(
      within(github).queryByText(/Provisional deployment frequency count/),
    ).not.toBeInTheDocument();
    expect(
      await within(screen.getByRole('region', { name: 'Live Argo CD stored results' })).findByText(
        /Provisional deployment frequency count/,
      ),
    ).toBeVisible();
  });

  it.each([403, 404])(
    'hides all sources after %s access failure, including sibling success',
    async (status) => {
      const late = deferred();
      fetchMock.mockImplementation(async (input) => {
        if (String(input).endsWith('/github-collection-runs')) return json({ runs: [completed] });
        if (String(input).endsWith('/argo-collection-runs')) return late.promise;
        return defaultRead(input);
      });
      mount();
      await select();
      await screen.findByText(/Provisional deployment frequency count/);
      await act(async () => late.resolve(json({}, status)));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Stored results are no longer accessible',
      );
      expect(screen.queryByText(/Provisional deployment frequency count/)).not.toBeInTheDocument();
      expect(screen.queryByRole('region')).not.toBeInTheDocument();
    },
  );

  it('revoked access on history refresh hides previous successes and aborts pending sibling read', async () => {
    const late = deferred();
    let revoked = false;
    let siblingSignal: AbortSignal | null | undefined;
    fetchMock.mockImplementation(async (input, options) => {
      const path = String(input);
      if (path.endsWith('/github-collection-runs'))
        return revoked ? json({}, 403) : json({ runs: [completed] });
      if (path.endsWith('/argo-collection-runs')) {
        siblingSignal = options?.signal;
        return late.promise;
      }
      return defaultRead(input);
    });
    mount();
    await select();
    await screen.findByText(/Provisional deployment frequency count/);
    revoked = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Live GitHub history' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer accessible');
    expect(siblingSignal?.aborted).toBe(true);
    await act(async () => late.resolve(json({ runs: [argoCompleted] })));
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(screen.queryByText(/Provisional deployment frequency count/)).not.toBeInTheDocument();
  });

  it('expires session on protected 401', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).endsWith('/github-collection-runs') ? json({}, 401) : defaultRead(input),
    );
    mount();
    await select();
    await screen.findByRole('alert');
    expect(identity.expire).toHaveBeenCalledWith(1);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it.each(['service', 'workspace', 'session'] as const)(
    'abandons late source response after %s switch',
    async (change) => {
      const late = deferred();
      let oldSignal: AbortSignal | null | undefined;
      fetchMock.mockImplementation(async (input, options) => {
        if (
          String(input).includes(scope.serviceId) &&
          String(input).endsWith('/github-collection-runs')
        ) {
          oldSignal = options?.signal;
          return late.promise;
        }
        return defaultRead(input);
      });
      const view = mount();
      await select();
      expect(oldSignal).toBeDefined();
      if (change === 'service')
        fireEvent.change(screen.getByLabelText('Service'), { target: { value: otherService } });
      else if (change === 'workspace')
        fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: otherWorkspace } });
      else {
        identity.revision = 2;
        identity.userId = 'bob';
        view.refreshSession();
      }
      await act(async () => late.resolve(json({ runs: [completed] })));
      expect(oldSignal?.aborted).toBe(true);
      expect(screen.queryByText(/Provisional deployment frequency count/)).not.toBeInTheDocument();
      expect(
        view.client
          .getQueryCache()
          .getAll()
          .some((query) => String(query.queryKey.at(-1)).endsWith(`${scope.serviceId}/github`)),
      ).toBe(false);
    },
  );
});
