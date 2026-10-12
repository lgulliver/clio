import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/query-client';
import { createAppRouter } from '../../router';

const workspace = '11111111-1111-4111-8111-111111111111';
const secondWorkspace = '99999999-9999-4999-8999-999999999999';
const team = '22222222-2222-4222-8222-222222222222';
const product = '33333333-3333-4333-8333-333333333333';
const service = '44444444-4444-4444-8444-444444444444';
const otherTeam = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function organization(id = workspace) {
  return {
    workspaceId: id,
    teams: [
      { id: team, workspaceId: id, name: 'Platform' },
      { id: otherTeam, workspaceId: id, name: 'Commerce' },
    ],
    products: [{ id: product, workspaceId: id, name: 'Payments', teamId: team }],
    services: [{ id: service, workspaceId: id, name: 'Payments API' }],
    assignments: [{ serviceId: service, productId: product }],
  };
}
const json = (value: unknown, status = 200) => Response.json(value, { status });
let handler: (path: string, options?: RequestInit) => Response | Promise<Response>;
const fetchMock = vi.fn((input: string | URL | Request, options?: RequestInit) =>
  handler(
    new URL(input instanceof Request ? input.url : String(input)).pathname +
      new URL(input instanceof Request ? input.url : String(input)).search,
    options,
  ),
);
function mount(path: string) {
  const client = createQueryClient();
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter(client, history);
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, history, client, ...view };
}
beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: vi.fn(async () => {
        throw new Error('Clipboard unavailable');
      }),
    },
  });
  handler = (path) => {
    if (path === '/api/me')
      return json({
        user: {
          id: 'alice',
          name: 'Alice',
          email: 'alice@example.test',
          emailVerified: true,
          image: null,
        },
      });
    if (path === '/api/workspaces')
      return json({
        workspaces: [
          { id: workspace, name: 'Engineering', role: 'owner' },
          { id: secondWorkspace, name: 'Second', role: 'member' },
        ],
      });
    if (path.endsWith('/organization'))
      return json(organization(path.includes(secondWorkspace) ? secondWorkspace : workspace));
    return json({ runs: [], nextCursor: null });
  };
});
describe('shareable overview views', () => {
  it('restores linked product, source and unloaded windows, copies only whitelisted view and autoopens service comparison', async () => {
    const { router } = mount(
      `/?workspace=${workspace}&team=${otherTeam}&product=${product}&source=argo&window=2025-11-01_2025-11-03&previous=2025-10-01_2025-10-03&secret=discard-me`,
    );
    await screen.findByRole('heading', { name: 'Payments' });
    expect(screen.getByLabelText('Team')).toHaveValue(team);
    expect(screen.getByLabelText('Result source')).toHaveValue('argo');
    expect(screen.getByLabelText('Reporting window')).toHaveValue(
      '2025-11-01T00:00:00.000Z|2025-11-03T00:00:00.000Z',
    );
    expect(screen.getByLabelText('Previous reporting window')).toHaveValue(
      '2025-10-01T00:00:00.000Z|2025-10-03T00:00:00.000Z',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy view link' }));
    const field = await screen.findByLabelText('View link — select and copy');
    expect(field).toHaveFocus();
    if (!(field instanceof HTMLInputElement)) throw new Error('Missing link field');
    const copied = new URL(field.value);
    expect(copied.searchParams.get('team')).toBe(team);
    expect(copied.searchParams.has('secret')).toBe(false);
    expect(copied.searchParams.get('previous')).toBe('2025-10-01_2025-10-03');
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: service } });
    await waitFor(() => expect(router.state.location.search).toMatchObject({ service }));
    await screen.findByRole('region', { name: 'Reporting window comparison' });
    expect(screen.getByText('Compare saved windows').closest('details')).toHaveAttribute('open');
  });
  it('refuses inaccessible workspaces and invalid filters without private scope reads', async () => {
    const unknown = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const { router } = mount(
      `/?workspace=${unknown}&service=${service}&source=evil&window=2025-02-30_2025-03-02`,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Linked workspace is unavailable');
    expect(screen.getByText('Some view filters were invalid and have been ignored.')).toBeVisible();
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes('/organization'))).toBe(
      false,
    );
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes('-runs'))).toBe(false);
    expect(screen.queryByRole('button', { name: 'Copy view link' })).not.toBeInTheDocument();
    await act(async () => {
      await router.navigate({ to: '/', search: { workspace, service: unknown } });
    });
    expect(
      await screen.findByText(
        'Linked selection is unavailable. Showing the closest accessible scope.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Engineering' })).toBeVisible();
    expect(
      fetchMock.mock.calls.some(([path]) => String(path).includes(`/services/${unknown}/`)),
    ).toBe(false);
  });
  it('updates URLs atomically, restores Back/Forward, and resets descendants on workspace change', async () => {
    const { router, history } = mount(`/?workspace=${workspace}`);
    await screen.findByRole('heading', { name: 'Engineering' });
    fireEvent.change(screen.getByLabelText('Product'), { target: { value: product } });
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ workspace, team, product }),
    );
    fireEvent.change(screen.getByLabelText('Result source'), { target: { value: 'mock' } });
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ source: 'mock', product }),
    );
    await act(async () => history.back());
    await waitFor(() => expect(screen.getByLabelText('Result source')).toHaveValue('measurement'));
    expect(screen.getByLabelText('Product')).toHaveValue(product);
    await act(async () => history.forward());
    await waitFor(() => expect(screen.getByLabelText('Result source')).toHaveValue('mock'));
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: secondWorkspace } });
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ workspace: secondWorkspace }),
    );
    expect(await screen.findByLabelText('Product')).toHaveValue('');
    expect(screen.getByLabelText('Team')).toHaveValue('');
  });
  it('keeps copy unavailable during pending organization and ignores late responses after workspace navigation', async () => {
    let resolve: (response: Response) => void = () => {
      throw new Error('Missing organization resolver');
    };
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    const read = handler;
    handler = (path, options) =>
      path === `/api/workspaces/${workspace}/organization` ? pending : read(path, options);
    const { router } = mount(`/?workspace=${workspace}`);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([path]) => String(path).endsWith(`/${workspace}/organization`)),
      ).toBe(true),
    );
    expect(screen.queryByRole('button', { name: 'Copy view link' })).not.toBeInTheDocument();
    await act(async () => {
      await router.navigate({ to: '/', search: { workspace: secondWorkspace } });
    });
    await screen.findByRole('button', { name: 'Copy view link' });
    await act(async () =>
      resolve(
        json({
          ...organization(),
          teams: [{ id: team, workspaceId: workspace, name: 'Old private team' }],
          products: [],
        }),
      ),
    );
    expect(screen.queryByText('Old private team')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Workspace')).toHaveValue(secondWorkspace);
    const old = fetchMock.mock.calls.find(([path]) =>
      String(path).endsWith(`/${workspace}/organization`),
    );
    expect(old?.[1]?.signal?.aborted).toBe(true);
  });
  it('uses current ownership for moved products and unassigned services in copied links', async () => {
    const read = handler;
    handler = (path, options) =>
      path.endsWith('/organization')
        ? json({
            ...organization(),
            products: [
              { id: product, workspaceId: workspace, name: 'Payments', teamId: otherTeam },
            ],
            assignments: [{ serviceId: service, productId: null }],
          })
        : read(path, options);
    const { router } = mount(`/?workspace=${workspace}&team=${team}&product=${product}`);
    await screen.findByRole('heading', { name: 'Payments' });
    expect(screen.getByLabelText('Team')).toHaveValue(otherTeam);
    await act(async () => {
      await router.navigate({ to: '/', search: { workspace, team, product, service } });
    });
    await waitFor(() => expect(screen.getByLabelText('Product')).toHaveValue('unassigned'));
    expect(screen.getByLabelText('Team')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Copy view link' }));
    const input = await screen.findByLabelText('View link — select and copy');
    if (!(input instanceof HTMLInputElement)) throw new Error('Missing link field');
    const url = new URL(input.value);
    expect(url.searchParams.get('service')).toBe(service);
    expect(url.searchParams.get('product')).toBe('unassigned');
    expect(url.searchParams.has('team')).toBe(false);
  });
});

it('does not treat linked IDs as authorization before sign-in', async () => {
  const read = handler;
  handler = (path, options) => (path === '/api/me' ? json({}, 401) : read(path, options));
  mount(`/?workspace=${workspace}&service=${service}&source=argo`);
  expect(
    await screen.findByText('Sign in with GitHub to inspect stored service evidence.'),
  ).toBeVisible();
  expect(fetchMock.mock.calls.some(([path]) => String(path).includes('/api/workspaces'))).toBe(
    false,
  );
  expect(screen.queryByRole('button', { name: 'Copy view link' })).not.toBeInTheDocument();
});

it('preserves unloaded windows on Back/Forward without extra reads and clears previous atomically on Latest/source changes', async () => {
  const { router, history } = mount(
    `/?workspace=${workspace}&window=2025-11-01_2025-11-03&previous=2025-10-01_2025-10-03`,
  );
  await screen.findByRole('region', { name: 'Reporting window comparison' });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Refresh comparisons' })).toHaveAttribute(
      'aria-disabled',
      'false',
    ),
  );
  const reads = fetchMock.mock.calls.length;
  await act(async () => {
    await router.navigate({
      to: '/',
      search: { workspace, window: '2025-12-01_2025-12-03', previous: '2025-11-01_2025-11-03' },
    });
  });
  expect(screen.getByLabelText('Reporting window')).toHaveValue(
    '2025-12-01T00:00:00.000Z|2025-12-03T00:00:00.000Z',
  );
  expect(fetchMock.mock.calls.length).toBe(reads);
  await act(async () => history.back());
  await waitFor(() =>
    expect(screen.getByLabelText('Previous reporting window')).toHaveValue(
      '2025-10-01T00:00:00.000Z|2025-10-03T00:00:00.000Z',
    ),
  );
  await act(async () => history.forward());
  await waitFor(() =>
    expect(screen.getByLabelText('Previous reporting window')).toHaveValue(
      '2025-11-01T00:00:00.000Z|2025-11-03T00:00:00.000Z',
    ),
  );
  expect(fetchMock.mock.calls.length).toBe(reads);
  fireEvent.change(screen.getByLabelText('Reporting window'), { target: { value: 'latest' } });
  await waitFor(() => expect(router.state.location.search).toEqual({ workspace }));
  expect(screen.getByLabelText('Previous reporting window')).toHaveValue('');
  await act(async () => {
    await router.navigate({
      to: '/',
      search: { workspace, window: '2025-11-01_2025-11-03', previous: '2025-10-01_2025-10-03' },
    });
  });
  fireEvent.change(screen.getByLabelText('Result source'), { target: { value: 'github' } });
  await waitFor(() =>
    expect(router.state.location.search).toEqual({ workspace, source: 'github' }),
  );
  expect(screen.getByLabelText('Reporting window')).toHaveValue('latest');
  expect(screen.getByLabelText('Previous reporting window')).toHaveValue('');
});

it('copies sanitized current view and removes copy when result access is lost', async () => {
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const { client } = mount(`/?workspace=${workspace}&product=${product}&unused=discard`);
  await screen.findByRole('heading', { name: 'Payments' });
  fireEvent.click(screen.getByRole('button', { name: 'Copy view link' }));
  await screen.findByText('View link copied.');
  const copied = writeText.mock.calls[0]?.[0];
  if (!copied) throw new Error('No copied link');
  expect(new URL(copied).searchParams.has('unused')).toBe(false);
  const read = handler;
  handler = (path, options) =>
    path.includes('/measurement-runs') ? json({}, 403) : read(path, options);
  await act(async () => {
    await client.invalidateQueries({
      predicate: (entry) =>
        entry.queryKey.some(
          (part) => typeof part === 'string' && part.includes('/measurement-runs'),
        ),
    });
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('no longer accessible');
  expect(screen.queryByRole('button', { name: 'Copy view link' })).not.toBeInTheDocument();
});

it('removes copy and hierarchy when service history loses access with comparison closed', async () => {
  const read = handler;
  let denied = false;
  handler = (path, options) =>
    denied && path.includes('/github-collection-runs') ? json({}, 404) : read(path, options);
  const { client } = mount(`/?workspace=${workspace}&service=${service}`);
  await screen.findByRole('button', { name: 'Copy view link' });
  expect(screen.getByText('Compare saved windows').closest('details')).not.toHaveAttribute('open');
  denied = true;
  await act(async () => {
    await client.invalidateQueries({
      predicate: (entry) =>
        entry.queryKey.some(
          (part) => typeof part === 'string' && part.includes('/github-collection-runs'),
        ),
    });
  });
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Stored results are no longer accessible',
  );
  expect(screen.queryByRole('button', { name: 'Copy view link' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Service')).not.toBeInTheDocument();
});

it('resets shared pagination before new-source queries and on history/filter changes', async () => {
  const many = Array.from({ length: 11 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    workspaceId: workspace,
    name: `Service ${index}`,
  }));
  const pageTwo = many[10];
  if (!pageTwo) throw new Error('Missing page-two service');
  const read = handler;
  handler = (path, options) =>
    path.endsWith('/organization')
      ? json({
          ...organization(),
          services: many,
          assignments: many.map((item) => ({ serviceId: item.id, productId: null })),
        })
      : read(path, options);
  const { router, history } = mount(`/?workspace=${workspace}`);
  await screen.findByRole('button', { name: 'Next services' });
  fireEvent.click(screen.getByRole('button', { name: 'Next services' }));
  await screen.findByText('Page 2 of 2');
  fireEvent.change(screen.getByLabelText('Result source'), { target: { value: 'github' } });
  await waitFor(() =>
    expect(router.state.location.search).toEqual({ workspace, source: 'github' }),
  );
  expect(screen.getByText('Page 1 of 2')).toBeVisible();
  expect(
    fetchMock.mock.calls.some(([path]) =>
      String(path).includes(`/services/${pageTwo.id}/github-collection-runs`),
    ),
  ).toBe(false);
  await act(async () => history.back());
  await waitFor(() => expect(screen.getByLabelText('Result source')).toHaveValue('measurement'));
  expect(screen.getByText('Page 1 of 2')).toBeVisible();
  await act(async () => history.forward());
  await waitFor(() => expect(screen.getByLabelText('Result source')).toHaveValue('github'));
  fireEvent.click(screen.getByRole('button', { name: 'Next services' }));
  await screen.findByText('Page 2 of 2');
  await act(async () => {
    await router.navigate({
      to: '/',
      search: { workspace, source: 'github', window: '2025-11-01_2025-11-03' },
    });
  });
  expect(screen.getByText('Page 1 of 2')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Next services' }));
  await screen.findByText('Page 2 of 2');
  fireEvent.change(screen.getByLabelText('Reporting window'), { target: { value: 'latest' } });
  await waitFor(() =>
    expect(router.state.location.search).toEqual({ workspace, source: 'github' }),
  );
  expect(screen.getByText('Page 1 of 2')).toBeVisible();
});
