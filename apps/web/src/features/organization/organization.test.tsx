import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/query-client';
import {
  completed,
  result as githubResult,
  json,
  scope,
} from '../github-collection/fixtures.test-support';
import { runFixture } from '../measurement-evidence/fixtures.test-support';
import { withMetric } from '../measurements/fixtures.test-support';
import { parseOrganization } from './api';
import { windowKey } from './comparison-data';
import { OrganizationBrowser } from './organization-browser';
import { OrganizationSettings } from './organization-settings';

const session = vi.hoisted(() => ({ revision: 1, valid: true, expire: vi.fn() }));
vi.mock('../identity/session', () => ({
  useSession: () => ({
    user: { id: 'alice' },
    revision: session.revision,
    current: (revision: number) => session.valid && revision === session.revision,
    expire: session.expire,
  }),
}));
const fetchMock =
  vi.fn<(input: string | URL | Request, options?: RequestInit) => Promise<Response>>();
const teamId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherTeam = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const productId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const otherProduct = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const otherService = '44444444-4444-4444-8444-444444444444';
const unassignedService = '55555555-5555-4555-8555-555555555555';
const services = [
  { id: scope.serviceId, workspaceId: scope.workspaceId, name: 'Payments API' },
  { id: otherService, workspaceId: scope.workspaceId, name: 'Customer API' },
  { id: unassignedService, workspaceId: scope.workspaceId, name: 'Shared library' },
];
function organization() {
  return {
    workspaceId: scope.workspaceId,
    services,
    teams: [
      { id: teamId, workspaceId: scope.workspaceId, name: 'Commerce' },
      { id: otherTeam, workspaceId: scope.workspaceId, name: 'Experience' },
    ],
    products: [
      { id: productId, workspaceId: scope.workspaceId, teamId, name: 'Payments' },
      { id: otherProduct, workspaceId: scope.workspaceId, teamId: otherTeam, name: 'Customers' },
    ],
    assignments: [
      { serviceId: scope.serviceId, productId },
      { serviceId: otherService, productId: otherProduct },
      { serviceId: unassignedService, productId: null },
    ],
  };
}
function read(input: string | URL | Request) {
  return String(input).endsWith('/organization')
    ? json(organization())
    : json({ runs: [], nextCursor: null });
}
function mountBrowser() {
  const client = createQueryClient();
  const content = () => (
    <QueryClientProvider client={client}>
      <OrganizationBrowser
        key={session.revision}
        workspaceId={scope.workspaceId}
        renderService={(service) => (
          <section aria-label="Selected service evidence">Evidence for {service.name}</section>
        )}
      />
    </QueryClientProvider>
  );
  const view = render(content());
  return { ...view, client, refreshSession: () => view.rerender(content()) };
}

async function openSettings(role: 'owner' | 'member' = 'owner', onAccessLost = vi.fn()) {
  const view = render(
    <QueryClientProvider client={createQueryClient()}>
      <OrganizationSettings
        workspace={{ id: scope.workspaceId, name: 'Engineering', role }}
        services={services}
        validSelection={() => session.valid}
        onAccessLost={onAccessLost}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText('Organize teams and products'));
  await screen.findByText('2 teams · 2 products · 1 unassigned services');
  return view;
}
beforeEach(() => {
  session.valid = true;
  session.revision = 1;
  session.expire.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => read(input));
  vi.stubGlobal('fetch', fetchMock);
});

describe('organization drill-down', () => {
  it('drills engineering → team → product → service and returns through breadcrumbs', async () => {
    mountBrowser();
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('button', { name: 'Shared library' })).toBeVisible();
    fireEvent.change(screen.getByLabelText('Result source'), { target: { value: 'argo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commerce 1 products' }));
    expect(screen.getByLabelText('Result source')).toHaveValue('argo');
    await screen.findByRole('heading', { name: 'Commerce' });
    expect(screen.queryByRole('button', { name: 'Customer API' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Payments 1 services' }));
    expect(screen.getByRole('heading', { name: 'Payments' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Payments API' }));
    expect(screen.getByRole('region', { name: 'Selected service evidence' })).toHaveTextContent(
      'Evidence for Payments API',
    );
    const breadcrumbs = screen.getByRole('navigation', { name: 'Engineering drill-down' });
    expect(breadcrumbs).toHaveTextContent('EngineeringCommercePaymentsPayments API');
    fireEvent.click(within(breadcrumbs).getByRole('button', { name: 'Engineering' }));
    expect(
      screen.queryByRole('region', { name: 'Selected service evidence' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Engineering' })).toHaveFocus();
    expect(
      within(screen.getByRole('table')).getByRole('button', { name: 'Customer API' }),
    ).toBeVisible();
  });
  it('keeps keyboard focus on selectors when changing team or product', async () => {
    mountBrowser();
    const team = await screen.findByLabelText('Team');
    fireEvent.click(screen.getByRole('button', { name: 'Engineering' }));
    team.focus();
    fireEvent.change(team, { target: { value: teamId } });
    expect(team).toHaveFocus();
    const product = screen.getByLabelText('Product');
    product.focus();
    fireEvent.change(product, { target: { value: productId } });
    expect(product).toHaveFocus();
    const service = screen.getByLabelText('Service');
    service.focus();
    fireEvent.change(service, { target: { value: scope.serviceId } });
    expect(service).toHaveFocus();
  });
  it('uses one ownership snapshot when another owner creates a service during loading', async () => {
    let resolve: (value: Response) => void = () => {
      throw new Error('Missing resolver');
    };
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    fetchMock.mockImplementation(async (input) =>
      String(input).endsWith('/organization') ? pending : read(input),
    );
    mountBrowser();
    const snapshot = organization();
    const added = { id: otherTeam, workspaceId: scope.workspaceId, name: 'New service' };
    await act(async () =>
      resolve(
        json({
          ...snapshot,
          services: [...snapshot.services, added],
          assignments: [...snapshot.assignments, { serviceId: added.id, productId: null }],
        }),
      ),
    );
    expect(await screen.findByRole('button', { name: 'New service' })).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith('/services'))).toBe(false);
  });
  it('choosing a product directly restores its owning team and keeps unassigned services reachable', async () => {
    mountBrowser();
    fireEvent.change(await screen.findByLabelText('Product'), { target: { value: productId } });
    expect(screen.getByLabelText('Team')).toHaveValue(teamId);
    fireEvent.change(screen.getByLabelText('Team'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Product'), { target: { value: 'unassigned' } });
    expect(screen.getByRole('heading', { name: 'Unassigned services' })).toBeVisible();
    expect(
      within(screen.getByRole('table')).getByRole('button', { name: 'Shared library' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Payments API' })).not.toBeInTheDocument();
  });
  it('shows stored metrics with quality, windows and source separation rather than missing-as-zero', async () => {
    fetchMock.mockImplementation(async (input) => {
      const path = String(input);
      if (path.includes(scope.serviceId) && path.includes('/measurement-runs'))
        return json({ runs: [runFixture(false)], nextCursor: null });
      if (path.includes(scope.serviceId) && path.includes('/github-collection-runs'))
        return json({
          runs: [{ ...completed, result: withMetric(githubResult) }],
          nextCursor: null,
        });
      return read(input);
    });
    mountBrowser();
    const table = await screen.findByRole('table');
    const row = within(table).getByRole('button', { name: 'Payments API' }).closest('tr');
    if (!row) throw new Error('Missing service row');
    await within(row).findByText('Collection: incomplete');
    expect(row).toHaveTextContent('2026-01-01 to 2026-01-03');
    expect(within(row).getAllByText('Unavailable').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('No successful saved result for this source.')).toHaveLength(
      2,
    );
    fireEvent.change(screen.getByLabelText('Result source'), { target: { value: 'argo' } });
    await waitFor(() =>
      expect(
        within(table).getAllByText('No successful saved result for this source.'),
      ).toHaveLength(3),
    );
    expect(
      fetchMock.mock.calls.some(([path]) =>
        String(path).includes('/argo-collection-runs?status=succeeded'),
      ),
    ).toBe(true);
  });
  it('hides group comparisons when a source read reports lost workspace access', async () => {
    fetchMock.mockImplementation(async (input) => {
      const path = String(input);
      if (path.includes(scope.serviceId) && path.includes('/measurement-runs'))
        return json({ runs: [runFixture()], nextCursor: null });
      if (path.includes('/github-collection-runs')) return json({}, 403);
      return read(input);
    });
    mountBrowser();
    await screen.findByText('Collection: complete');
    fireEvent.change(screen.getByLabelText('Result source'), { target: { value: 'github' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer accessible');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Payments API' })).not.toBeInTheDocument();
  });
  it('rejects duplicate, dangling and cross-workspace organization links', () => {
    const valid = organization();
    expect(parseOrganization(valid, scope.workspaceId).assignments).toHaveLength(3);
    expect(() =>
      parseOrganization({ ...valid, teams: [valid.teams[0], valid.teams[0]] }, scope.workspaceId),
    ).toThrow();
    expect(() =>
      parseOrganization(
        { ...valid, products: [{ ...valid.products[0], teamId: unassignedService }] },
        scope.workspaceId,
      ),
    ).toThrow();
    expect(() =>
      parseOrganization({ ...valid, workspaceId: otherTeam }, scope.workspaceId),
    ).toThrow();
    expect(() =>
      parseOrganization({ ...valid, assignments: valid.assignments.slice(1) }, scope.workspaceId),
    ).toThrow();
  });
  it('pages comparisons to bound requests to ten visible services', async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      workspaceId: scope.workspaceId,
      name: `Service ${i}`,
    }));
    fetchMock.mockImplementation(async (input) =>
      String(input).endsWith('/organization')
        ? json({
            workspaceId: scope.workspaceId,
            teams: [],
            products: [],
            services: many,
            assignments: many.map((service) => ({ serviceId: service.id, productId: null })),
          })
        : json({ runs: [], nextCursor: null }),
    );
    render(
      <QueryClientProvider client={createQueryClient()}>
        <OrganizationBrowser workspaceId={scope.workspaceId} renderService={() => null} />
      </QueryClientProvider>,
    );
    await screen.findByRole('button', { name: 'Next services' });
    expect(
      fetchMock.mock.calls.filter(([path]) => String(path).includes('/measurement-runs')),
    ).toHaveLength(10);
    fireEvent.click(screen.getByRole('button', { name: 'Next services' }));
    expect(await screen.findByRole('button', { name: 'Service 10' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Service 0' })).not.toBeInTheDocument();
  });
});

describe('organization owner setup', () => {
  it('creates teams/products and assigns then clears a service', async () => {
    const data = organization();
    fetchMock.mockImplementation(async (input, options) => {
      const body: unknown = options?.body ? JSON.parse(String(options.body)) : null;
      const path = String(input);
      if (options?.method !== 'POST') return json(data);
      if (path.endsWith('/teams'))
        return json({
          team: { id: unassignedService, workspaceId: scope.workspaceId, name: 'New team' },
        });
      if (path.endsWith('/products'))
        return json({
          product: {
            id: unassignedService,
            workspaceId: scope.workspaceId,
            name: 'New product',
            teamId,
          },
        });
      if (path.endsWith('/product')) {
        const product =
          typeof body === 'object' && body !== null && 'productId' in body
            ? body.productId
            : undefined;
        return json({ assignment: { serviceId: scope.serviceId, productId: product } });
      }
      throw new Error('Unexpected request');
    });
    await openSettings();
    fireEvent.change(screen.getByLabelText('New team name'), { target: { value: 'New team' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }));
    await screen.findByText('Team created.');
    fireEvent.change(screen.getByLabelText('New product name'), {
      target: { value: 'New product' },
    });
    fireEvent.change(screen.getByLabelText('Owning team'), { target: { value: teamId } });
    fireEvent.click(screen.getByRole('button', { name: 'Create product' }));
    await screen.findByText('Product created.');
    fireEvent.change(screen.getByLabelText('Service to assign'), {
      target: { value: scope.serviceId },
    });
    expect(screen.getByLabelText('Assigned product')).toHaveValue(productId);
    fireEvent.click(screen.getByRole('button', { name: 'Save service assignment' }));
    await screen.findByText('Service assignment saved.');
    await waitFor(() => expect(screen.queryByText('Saving organization…')).not.toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Assigned product'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save service assignment' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(
        4,
      ),
    );
    const posts = fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(posts[1]?.[1]?.body).toBe(JSON.stringify({ name: 'New product', teamId }));
    expect(posts[3]?.[1]?.body).toBe(JSON.stringify({ productId: null }));
  });
  it('members read hierarchy without write controls', async () => {
    await openSettings('member');
    expect(screen.queryByRole('button', { name: 'Create team' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Assigned product')).not.toBeInTheDocument();
  });
  it('preserves draft after failed write and ignores late success after scope unmount', async () => {
    let resolve: (value: Response) => void = () => {
      throw new Error('Missing resolver');
    };
    const late = new Promise<Response>((done) => {
      resolve = done;
    });
    let attempt = 0;
    fetchMock.mockImplementation(async (input, options) =>
      options?.method === 'POST' ? (++attempt === 1 ? json({}, 503) : late) : read(input),
    );
    const view = await openSettings();
    fireEvent.change(screen.getByLabelText('New team name'), { target: { value: 'Draft team' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }));
    await screen.findByRole('alert');
    expect(screen.getByLabelText('New team name')).toHaveValue('Draft team');
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }));
    view.unmount();
    await act(async () =>
      resolve(
        json({
          team: { id: unassignedService, workspaceId: scope.workspaceId, name: 'Draft team' },
        }),
      ),
    );
    expect(
      fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/organization')),
    ).toHaveLength(1);
  });
});

function savedPeriod(id: number, serviceId: string, month: string, leadHours: number) {
  const run = runFixture();
  if (!run.result) throw new Error('Missing measurement fixture');
  const window = { start: `2025-${month}-01T00:00:00Z`, end: `2025-${month}-03T00:00:00Z` };
  return {
    ...run,
    id: `77777777-7777-4777-8777-${String(id).padStart(12, '0')}`,
    serviceId,
    result: {
      ...run.result,
      serviceId,
      window: { ...run.result.window, ...window },
      metricResult: {
        ...run.result.metricResult,
        service_id: serviceId,
        window: { ...run.result.metricResult.window, ...window },
        change_lead_time: {
          ...run.result.metricResult.change_lead_time,
          median_seconds: leadHours * 3600,
        },
      },
    },
  };
}
function installPeriods() {
  fetchMock.mockImplementation(async (input) => {
    const path = String(input);
    if (path.includes('/measurement-runs') && path.includes(scope.serviceId))
      return json({
        runs: [
          savedPeriod(30, scope.serviceId, '12', 12),
          savedPeriod(20, scope.serviceId, '11', 2),
          savedPeriod(10, scope.serviceId, '10', 1),
        ],
        nextCursor: null,
      });
    if (path.includes('/measurement-runs') && path.includes(otherService))
      return json({
        runs: [savedPeriod(20, otherService, '11', 7), savedPeriod(10, otherService, '10', 3)],
        nextCursor: null,
      });
    return read(input);
  });
}
const october = windowKey({ start: '2025-10-01T00:00:00Z', end: '2025-10-03T00:00:00Z' });

describe('group reporting-window controls', () => {
  it('aligns exact older periods without extra requests and keeps absent matches explicit', async () => {
    installPeriods();
    mountBrowser();
    await screen.findByRole('option', { name: '2025-10-01 to 2025-10-03 (UTC, end exclusive)' });
    const reads = fetchMock.mock.calls.length;
    const filter = screen.getByLabelText('Reporting window');
    filter.focus();
    fireEvent.change(filter, { target: { value: october } });
    expect(filter).toHaveFocus();
    const table = screen.getByRole('table');
    const payments = within(table).getByRole('button', { name: 'Payments API' }).closest('tr');
    const customers = within(table).getByRole('button', { name: 'Customer API' }).closest('tr');
    expect(payments).toHaveTextContent('2025-10-01 to 2025-10-03');
    expect(payments).toHaveTextContent('1 h');
    expect(payments).not.toHaveTextContent('12 h');
    expect(customers).toHaveTextContent('2025-10-01 to 2025-10-03');
    expect(customers).toHaveTextContent('3 h');
    expect(
      within(table).getByText('No saved result for selected reporting window in loaded history.'),
    ).toBeVisible();
    const summary = screen.getByRole('region', { name: 'Coverage and freshness' });
    expect(summary).toHaveTextContent('Page 1: 3 of 3 services');
    expect(summary).toHaveTextContent('Missing results (1)');
    expect(summary).toHaveTextContent('2025-10-01 to 2025-10-03 (UTC, end exclusive)');
    expect(fetchMock.mock.calls.length).toBe(reads);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh comparisons' }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(reads + 3));
    expect(screen.getByLabelText('Reporting window')).toHaveValue(october);
  });
  it('retains period through team/product/service navigation, then resets it when source changes', async () => {
    installPeriods();
    mountBrowser();
    await screen.findByRole('option', { name: '2025-10-01 to 2025-10-03 (UTC, end exclusive)' });
    fireEvent.change(screen.getByLabelText('Reporting window'), { target: { value: october } });
    fireEvent.click(screen.getByRole('button', { name: 'Commerce 1 products' }));
    expect(screen.getByLabelText('Reporting window')).toHaveValue(october);
    fireEvent.click(screen.getByRole('button', { name: 'Payments 1 services' }));
    expect(screen.getByLabelText('Reporting window')).toHaveValue(october);
    fireEvent.click(screen.getByRole('button', { name: 'Payments API' }));
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Engineering drill-down' })).getByRole(
        'button',
        { name: 'Engineering' },
      ),
    );
    expect(screen.getByLabelText('Reporting window')).toHaveValue(october);
    fireEvent.change(screen.getByLabelText('Result source'), { target: { value: 'argo' } });
    expect(screen.getByLabelText('Reporting window')).toHaveValue('latest');
    await waitFor(() =>
      expect(screen.getAllByText('No successful saved result for this source.')).toHaveLength(3),
    );
  });
  it('aborts abandoned history and excludes late values after switching source', async () => {
    let resolve: (value: Response) => void = () => {
      throw new Error('Missing resolver');
    };
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    fetchMock.mockImplementation(async (input) =>
      String(input).includes('/measurement-runs') && String(input).includes(scope.serviceId)
        ? pending
        : read(input),
    );
    mountBrowser();
    await screen.findByLabelText('Result source');
    const abandoned = fetchMock.mock.calls.find(
      ([path]) =>
        String(path).includes(scope.serviceId) && String(path).includes('/measurement-runs'),
    );
    fireEvent.change(screen.getByLabelText('Result source'), { target: { value: 'argo' } });
    await waitFor(() => expect(abandoned?.[1]?.signal?.aborted).toBe(true));
    await act(async () =>
      resolve(json({ runs: [savedPeriod(10, scope.serviceId, '10', 99)], nextCursor: null })),
    );
    await waitFor(() =>
      expect(screen.getAllByText('No successful saved result for this source.')).toHaveLength(3),
    );
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: '2025-10-01 to 2025-10-03 (UTC, end exclusive)' }),
    ).not.toBeInTheDocument();
  });
});

it('retains exact reporting-window selection on a service page without matching history', async () => {
  const many = Array.from({ length: 11 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    workspaceId: scope.workspaceId,
    name: `Service ${i}`,
  }));
  const first = many[0];
  if (!first) throw new Error('Missing first service');
  fetchMock.mockImplementation(async (input) => {
    const path = String(input);
    if (path.endsWith('/organization'))
      return json({
        workspaceId: scope.workspaceId,
        teams: [],
        products: [],
        services: many,
        assignments: many.map((service) => ({ serviceId: service.id, productId: null })),
      });
    return path.includes(first.id)
      ? json({ runs: [savedPeriod(10, first.id, '10', 1)], nextCursor: null })
      : json({ runs: [], nextCursor: null });
  });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <OrganizationBrowser workspaceId={scope.workspaceId} renderService={() => null} />
    </QueryClientProvider>,
  );
  await screen.findByRole('option', { name: '2025-10-01 to 2025-10-03 (UTC, end exclusive)' });
  fireEvent.change(screen.getByLabelText('Reporting window'), { target: { value: october } });
  fireEvent.click(screen.getByRole('button', { name: 'Next services' }));
  expect(screen.getByLabelText('Reporting window')).toHaveValue(october);
  await screen.findByText('No saved result for selected reporting window in loaded history.');
  expect(screen.getByRole('option', { name: /not in loaded history/ })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Service 10' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Service 0' })).not.toBeInTheDocument();
  expect(
    fetchMock.mock.calls.filter(([path]) => String(path).includes('/measurement-runs')),
  ).toHaveLength(11);
});

it.each(['scope', 'session'] as const)(
  'drops late history after %s changes and fetches a fresh result on return',
  async (change) => {
    let resolve: (value: Response) => void = () => {
      throw new Error('Missing resolver');
    };
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    let reads = 0;
    fetchMock.mockImplementation(async (input) => {
      const path = String(input);
      if (path.includes('/measurement-runs') && path.includes(scope.serviceId))
        return ++reads === 1
          ? pending
          : json({ runs: [savedPeriod(10, scope.serviceId, '10', 1)], nextCursor: null });
      return read(input);
    });
    const view = mountBrowser();
    await screen.findByLabelText('Result source');
    const abandoned = fetchMock.mock.calls.find(
      ([path]) =>
        String(path).includes(scope.serviceId) && String(path).includes('/measurement-runs'),
    );
    if (change === 'scope') {
      fireEvent.click(screen.getByRole('button', { name: 'Experience 1 products' }));
      await screen.findByRole('heading', { name: 'Experience' });
      fireEvent.click(
        within(screen.getByRole('navigation', { name: 'Engineering drill-down' })).getByRole(
          'button',
          { name: 'Engineering' },
        ),
      );
    } else {
      session.revision += 1;
      view.refreshSession();
    }
    await screen.findByText('1 h');
    expect(abandoned?.[1]?.signal?.aborted).toBe(true);
    await act(async () =>
      resolve(json({ runs: [savedPeriod(10, scope.serviceId, '10', 99)], nextCursor: null })),
    );
    expect(screen.queryByText('99 h')).not.toBeInTheDocument();
    expect(screen.getByText('1 h')).toBeVisible();
    if (change === 'session')
      expect(
        view.client
          .getQueryCache()
          .getAll()
          .some((query) => query.queryKey[0] === 'identity' && query.queryKey[2] === 1),
      ).toBe(false);
  },
);

it('expires identity and hides group charts after a dynamic history read returns401', async () => {
  fetchMock.mockImplementation(async (input) =>
    String(input).includes('/measurement-runs') ? json({}, 401) : read(input),
  );
  mountBrowser();
  expect(await screen.findByRole('alert')).toHaveTextContent('no longer accessible');
  expect(session.expire).toHaveBeenCalledWith(1);
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});
