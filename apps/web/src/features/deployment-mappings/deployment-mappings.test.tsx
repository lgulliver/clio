import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/query-client';
import { createAppRouter } from '../../router';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const otherWorkspace = '22222222-2222-4222-8222-222222222222';
const serviceId = '33333333-3333-4333-8333-333333333333';
const otherService = '44444444-4444-4444-8444-444444444444';
const scope = { workspaceId, serviceId };
const initial = {
  ...scope,
  mode: 'mock',
  revision: 1,
  primaryProvider: 'github',
  productionEnvironment: 'production',
  exposureAttested: false,
  observedAt: '2026-10-10T00:00:00Z',
};
const preview = {
  ...scope,
  mode: 'mock',
  mappingRevision: 1,
  oemsRevision: '5908bb12cdf24e7528088237dff9dca4c10ff45f',
  window: {
    start: '2026-10-01T00:00:00Z',
    end: '2026-10-09T00:00:00Z',
    timezone: 'UTC',
    calendarDays: 8,
  },
  evidenceCutoff: '2026-10-11T00:00:00Z',
  qualification: 'unknown',
  rolloutCount: 1,
  coverage: {
    collectionComplete: false,
    deploymentHistoryComplete: false,
    recoveryEvidenceComplete: false,
  },
  deploymentFrequency: {
    count: 0,
    status: 'provisional',
    deploymentsPerDay: null,
    qualityReasons: ['incomplete'],
  },
  changeFailureRate: null,
  failedDeploymentRecoveryTime: null,
};
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
type Handler = (path: string, options?: RequestInit) => Response | Promise<Response>;
let mappingHandler: Handler;
let role: 'owner' | 'member';
let identity: string;
const fetchMock = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
  const path = new URL(String(input)).pathname;
  if (path === '/api/me')
    return json({
      user: {
        id: identity,
        name: identity,
        email: `${identity}@example.test`,
        emailVerified: true,
        image: null,
      },
    });
  if (path === '/api/auth/sign-out') return json({ success: true });
  if (path === '/api/workspaces')
    return json({
      workspaces: [
        { id: workspaceId, name: 'First', role },
        { id: otherWorkspace, name: 'Second', role },
      ],
    });
  if (path.endsWith('/services'))
    return json({
      services: [
        {
          id: serviceId,
          name: 'Delivery',
          workspaceId: path.includes(otherWorkspace) ? otherWorkspace : workspaceId,
        },
        {
          id: otherService,
          name: 'Billing',
          workspaceId: path.includes(otherWorkspace) ? otherWorkspace : workspaceId,
        },
      ],
    });
  if (path.endsWith('/mock-collection-runs')) return json({ runs: [] });
  return mappingHandler(path, options);
});
function mount(strict = false) {
  const client = createQueryClient();
  const router = createAppRouter(client, createMemoryHistory({ initialEntries: ['/settings'] }));
  const content = (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  const view = render(strict ? <StrictMode>{content}</StrictMode> : content);
  return { client, ...view };
}
async function select(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(await screen.findByLabelText('Workspace'), workspaceId);
  await user.click(await screen.findByRole('button', { name: 'Mock settings for Delivery' }));
}
function deferred() {
  let resolve: (response: Response) => void = () => {
    throw new Error('Missing resolver');
  };
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.restoreAllMocks();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  role = 'owner';
  identity = 'alice';
  mappingHandler = (path) =>
    path.endsWith('/deployment-preview') ? json({ preview }) : json({ mapping: initial });
});
describe('mock deployment settings', () => {
  it('creates unset settings with explicit mock attestation/provider/environment and exact body', async () => {
    let stored = false;
    mappingHandler = (_path, options) => {
      if (options?.method === 'POST') {
        expect(JSON.parse(String(options.body))).toEqual({
          expectedRevision: null,
          primaryProvider: 'argocd',
          productionEnvironment: 'prod-eu',
          exposureAttested: true,
        });
        stored = true;
        return json({
          mapping: {
            ...initial,
            primaryProvider: 'argocd',
            productionEnvironment: 'prod-eu',
            exposureAttested: true,
          },
        });
      }
      return json({ mapping: null });
    };
    mount();
    const user = userEvent.setup();
    await select(user);
    expect(await screen.findByText('No mock settings saved for this service.')).toBeVisible();
    expect(screen.getByText('Mock data · No live provider connected')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Preview saved mock settings' }),
    ).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Mock primary provider'), 'argocd');
    await user.clear(screen.getByLabelText('Production environment (mock)'));
    await user.type(screen.getByLabelText('Production environment (mock)'), ' prod-eu ');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Save mock settings' }));
    expect(await screen.findByText('Mock settings saved.')).toBeVisible();
    expect(stored).toBe(true);
    expect(screen.getByRole('checkbox')).toBeChecked();
  });
  it('previews only saved revision, preserves nulls, clears on edit/save and posts no draft', async () => {
    let savedRevision = 1;
    mappingHandler = (path, options) => {
      if (path.endsWith('/deployment-preview')) {
        expect(JSON.parse(String(options?.body))).toEqual({ revision: savedRevision });
        return json({ preview: { ...preview, mappingRevision: savedRevision } });
      }
      if (options?.method === 'POST') {
        savedRevision = 2;
        return json({ mapping: { ...initial, revision: 2, exposureAttested: true } });
      }
      return json({ mapping: initial });
    };
    mount();
    const user = userEvent.setup();
    await select(user);
    await user.click(await screen.findByRole('button', { name: 'Preview saved mock settings' }));
    expect(
      await screen.findByRole('region', { name: 'Fictional deployment preview' }),
    ).toHaveTextContent('Coverage is incomplete');
    expect(screen.getByText(/change failure rate and recovery time are unavailable/)).toBeVisible();
    expect(screen.getByText(/Evidence cutoff:/)).toHaveTextContent('2026-10-11');
    await user.click(screen.getByRole('checkbox'));
    expect(
      screen.queryByRole('region', { name: 'Fictional deployment preview' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview saved mock settings' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save mock settings' }));
    expect(await screen.findByText('Mock settings saved.')).toBeVisible();
    expect(
      screen.queryByRole('region', { name: 'Fictional deployment preview' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Preview saved mock settings' }));
    expect(await screen.findByText('Fictional preview · Saved mock revision 2')).toBeVisible();
  });
  it('allows member read/preview, with no editable controls or save request', async () => {
    role = 'member';
    mount();
    const user = userEvent.setup();
    await select(user);
    expect(await screen.findByText('Only workspace owners can edit mock settings.')).toBeVisible();
    expect(screen.getByText('Not attested')).toBeVisible();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save mock settings' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview saved mock settings' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Preview saved mock settings' }));
    expect(
      await screen.findByRole('region', { name: 'Fictional deployment preview' }),
    ).toBeVisible();
    expect(
      fetchMock.mock.calls.filter(
        ([url, options]) =>
          String(url).endsWith('/deployment-mapping') && options?.method === 'POST',
      ),
    ).toHaveLength(0);
  });
  it('retains member read and preview access after a save loses edit permission', async () => {
    mappingHandler = (path, options) => {
      if (path.endsWith('/deployment-preview')) return json({ preview });
      if (options?.method === 'POST') {
        role = 'member';
        return json({}, 403);
      }
      return json({ mapping: initial });
    };
    mount();
    const user = userEvent.setup();
    await select(user);
    const environment = await screen.findByLabelText('Production environment (mock)');
    await user.clear(environment);
    await user.type(environment, 'unsaved-production');
    await user.click(await screen.findByRole('button', { name: 'Save mock settings' }));
    expect(
      await screen.findByText(
        'You can no longer edit these settings. Saved settings remain available.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save mock settings' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview saved mock settings' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Preview saved mock settings' }));
    expect(
      await screen.findByRole('region', { name: 'Fictional deployment preview' }),
    ).toBeVisible();
  });
  it('gives members a reload conflict message without claiming a draft', async () => {
    role = 'member';
    mappingHandler = (path) =>
      path.endsWith('/deployment-preview') ? json({}, 409) : json({ mapping: initial });
    mount();
    const user = userEvent.setup();
    await select(user);
    await user.click(await screen.findByRole('button', { name: 'Preview saved mock settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Reload saved settings before previewing',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('draft');
  });
  it('retains conflict draft through failed reload, then explicitly reloads saved settings', async () => {
    let gets = 0;
    mappingHandler = (_path, options) => {
      if (options?.method === 'POST') return json({}, 409);
      gets += 1;
      if (gets === 2) return json({}, 503);
      return json({
        mapping: { ...initial, revision: gets === 1 ? 1 : 2, productionEnvironment: 'saved-prod' },
      });
    };
    mount();
    const user = userEvent.setup();
    await select(user);
    const environment = await screen.findByLabelText('Production environment (mock)');
    await user.clear(environment);
    await user.type(environment, 'my-draft');
    await user.click(screen.getByRole('button', { name: 'Save mock settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your draft is kept');
    expect(environment).toHaveValue('my-draft');
    expect(screen.getByRole('button', { name: 'Save mock settings' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Reload saved settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Clio is unavailable');
    expect(environment).toHaveValue('my-draft');
    await user.click(screen.getByRole('button', { name: 'Reload saved settings' }));
    expect(await screen.findByText('Saved settings reloaded.')).toBeVisible();
    expect(screen.getByLabelText('Production environment (mock)')).toHaveValue('saved-prod');
  });
  it('shows loading and retries failed reads without exposing response details', async () => {
    const late = deferred();
    let retry = false;
    mappingHandler = () => (retry ? json({ mapping: initial }) : late.promise);
    mount();
    const user = userEvent.setup();
    await select(user);
    expect(await screen.findByText('Loading deployment settings…')).toBeVisible();
    await act(async () => {
      late.resolve(json({ private: 'secret payload' }, 503));
      await late.promise;
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Clio is unavailable');
    expect(screen.queryByText(/secret payload/)).not.toBeInTheDocument();
    retry = true;
    await user.click(screen.getByRole('button', { name: 'Retry deployment settings' }));
    expect(await screen.findByLabelText('Mock primary provider')).toHaveValue('github');
  });
  it.each(['read', 'save', 'preview'])('expires identity on %s 401', async (operation) => {
    mappingHandler = (path, options) =>
      operation === 'read' ||
      (operation === 'save' && options?.method === 'POST') ||
      (operation === 'preview' && path.endsWith('/deployment-preview'))
        ? json({}, 401)
        : json({ mapping: initial });
    const { client } = mount();
    const user = userEvent.setup();
    await select(user);
    if (operation !== 'read')
      await user.click(
        await screen.findByRole('button', {
          name: operation === 'save' ? 'Save mock settings' : 'Preview saved mock settings',
        }),
      );
    expect(await screen.findByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
    expect(
      screen.queryByRole('region', { name: 'Mock deployment settings' }),
    ).not.toBeInTheDocument();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });
  it.each(['read', 'save', 'preview'])(
    'hides inaccessible settings on %s 404',
    async (operation) => {
      mappingHandler = (path, options) =>
        operation === 'read' ||
        (operation === 'save' && options?.method === 'POST') ||
        (operation === 'preview' && path.endsWith('/deployment-preview'))
          ? json({}, 404)
          : json({ mapping: initial });
      mount();
      const user = userEvent.setup();
      await select(user);
      if (operation !== 'read')
        await user.click(
          await screen.findByRole('button', {
            name: operation === 'save' ? 'Save mock settings' : 'Preview saved mock settings',
          }),
        );
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'These service settings are no longer available',
      );
      expect(screen.queryByLabelText('Mock primary provider')).not.toBeInTheDocument();
    },
  );
  it.each(['read', 'save', 'preview'])(
    'ignores late %s replies after service switch and clears old cache',
    async (operation) => {
      const late = deferred();
      mappingHandler = (path, options) => {
        if (path.includes(otherService))
          return json({
            mapping: { ...initial, serviceId: otherService, productionEnvironment: 'billing-prod' },
          });
        if (
          operation === 'read' ||
          (operation === 'save' && options?.method === 'POST') ||
          (operation === 'preview' && path.endsWith('/deployment-preview'))
        )
          return late.promise;
        return json({ mapping: initial });
      };
      const { client } = mount();
      const user = userEvent.setup();
      await select(user);
      if (operation !== 'read')
        await user.click(
          await screen.findByRole('button', {
            name: operation === 'save' ? 'Save mock settings' : 'Preview saved mock settings',
          }),
        );
      await user.click(screen.getByRole('button', { name: 'Mock settings for Billing' }));
      expect(await screen.findByLabelText('Production environment (mock)')).toHaveValue(
        'billing-prod',
      );
      await act(async () => {
        late.resolve(
          operation === 'preview'
            ? json({ preview })
            : json({ mapping: { ...initial, revision: operation === 'save' ? 2 : 1 } }),
        );
        await late.promise;
      });
      expect(screen.getByLabelText('Production environment (mock)')).toHaveValue('billing-prod');
      expect(
        screen.queryByRole('region', { name: 'Fictional deployment preview' }),
      ).not.toBeInTheDocument();
      expect(
        client
          .getQueryCache()
          .getAll()
          .some(
            (item) =>
              item.queryKey.includes('deployment-mapping') && item.queryKey.includes(serviceId),
          ),
      ).toBe(false);
      const previous = fetchMock.mock.calls.find(
        ([url, options]) =>
          String(url).includes(serviceId) &&
          String(url).includes(
            operation === 'preview' ? '/deployment-preview' : '/deployment-mapping',
          ) &&
          (operation === 'read' || options?.method === 'POST'),
      );
      expect(previous?.[1]?.signal?.aborted).toBe(true);
    },
  );
  it('ignores late save after identity changes and keeps new identity cache clean', async () => {
    const late = deferred();
    mappingHandler = (_path, options) =>
      options?.method === 'POST' ? late.promise : json({ mapping: initial });
    const { client } = mount();
    const user = userEvent.setup();
    await select(user);
    await user.click(await screen.findByRole('button', { name: 'Save mock settings' }));
    identity = 'bob';
    act(() => window.dispatchEvent(new Event('focus')));
    expect(await screen.findByText('Signed in as bob')).toBeVisible();
    await act(async () => {
      late.resolve(json({ mapping: { ...initial, revision: 2 } }));
      await late.promise;
    });
    expect(screen.queryByText('Mock settings saved.')).not.toBeInTheDocument();
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((item) => ({ key: item.queryKey, data: item.state.data })),
      ),
    ).not.toContain('alice');
  });
  it('clears draft/preview and cache on workspace switch', async () => {
    const { client } = mount();
    const user = userEvent.setup();
    await select(user);
    await user.click(await screen.findByRole('button', { name: 'Preview saved mock settings' }));
    await screen.findByRole('region', { name: 'Fictional deployment preview' });
    await user.selectOptions(screen.getByLabelText('Workspace'), otherWorkspace);
    expect(
      screen.queryByRole('region', { name: 'Mock deployment settings' }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        client
          .getQueryCache()
          .getAll()
          .some((item) => item.queryKey.includes('deployment-mapping')),
      ).toBe(false),
    );
  });
  it('rejects mismatched preview and preserves saved controls for retry', async () => {
    mappingHandler = (path) =>
      path.endsWith('/deployment-preview')
        ? json({ preview: { ...preview, mappingRevision: 2 } })
        : json({ mapping: initial });
    mount();
    const user = userEvent.setup();
    await select(user);
    await user.click(await screen.findByRole('button', { name: 'Preview saved mock settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The response could not be verified',
    );
    expect(
      screen.queryByRole('region', { name: 'Fictional deployment preview' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview saved mock settings' })).toBeEnabled();
  });
  it('keeps draft after a failed save and retries with unattested exposure', async () => {
    let attempts = 0;
    mappingHandler = (_path, options) => {
      if (options?.method !== 'POST') return json({ mapping: initial });
      expect(JSON.parse(String(options.body))).toEqual({
        expectedRevision: 1,
        primaryProvider: 'github',
        productionEnvironment: 'prod-eu',
        exposureAttested: false,
      });
      attempts += 1;
      return attempts === 1
        ? json({}, 503)
        : json({ mapping: { ...initial, revision: 2, productionEnvironment: 'prod-eu' } });
    };
    mount();
    const user = userEvent.setup();
    await select(user);
    const environment = await screen.findByLabelText('Production environment (mock)');
    await user.clear(environment);
    await user.type(environment, 'prod-eu');
    await user.click(screen.getByRole('button', { name: 'Save mock settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Clio is unavailable');
    expect(environment).toHaveValue('prod-eu');
    await user.click(screen.getByRole('button', { name: 'Save mock settings' }));
    expect(await screen.findByText('Mock settings saved.')).toHaveFocus();
  });
  it('rejects overlong environment before request and associates validation error', async () => {
    mount();
    const user = userEvent.setup();
    await select(user);
    const environment = await screen.findByLabelText('Production environment (mock)');
    await user.clear(environment);
    await user.paste('😀'.repeat(201));
    await user.click(screen.getByRole('button', { name: 'Save mock settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('between 1 and 200 characters');
    expect(environment).toHaveAttribute('aria-invalid', 'true');
    expect(
      fetchMock.mock.calls.filter(
        ([url, options]) =>
          String(url).endsWith('/deployment-mapping') && options?.method === 'POST',
      ),
    ).toHaveLength(0);
  });
  it.each(['provider', 'environment'])('clears fictional preview on %s edit', async (field) => {
    mount();
    const user = userEvent.setup();
    await select(user);
    await user.click(await screen.findByRole('button', { name: 'Preview saved mock settings' }));
    await screen.findByRole('region', { name: 'Fictional deployment preview' });
    if (field === 'provider')
      await user.selectOptions(screen.getByLabelText('Mock primary provider'), 'argocd');
    else await user.type(screen.getByLabelText('Production environment (mock)'), '-eu');
    expect(
      screen.queryByRole('region', { name: 'Fictional deployment preview' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview saved mock settings' })).toBeDisabled();
  });
  it('clears existing preview immediately when saving starts and prevents duplicate saves', async () => {
    const late = deferred();
    mappingHandler = (path, options) =>
      path.endsWith('/deployment-preview')
        ? json({ preview })
        : options?.method === 'POST'
          ? late.promise
          : json({ mapping: initial });
    mount();
    const user = userEvent.setup();
    await select(user);
    await user.click(await screen.findByRole('button', { name: 'Preview saved mock settings' }));
    await screen.findByRole('region', { name: 'Fictional deployment preview' });
    const button = screen.getByRole('button', { name: 'Save mock settings' });
    await user.click(button);
    await user.click(button);
    expect(
      screen.queryByRole('region', { name: 'Fictional deployment preview' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Saving mock settings…')).toBeVisible();
    expect(
      fetchMock.mock.calls.filter(
        ([url, options]) =>
          String(url).endsWith('/deployment-mapping') && options?.method === 'POST',
      ),
    ).toHaveLength(1);
    await act(async () => {
      late.resolve(json({ mapping: { ...initial, revision: 2 } }));
      await late.promise;
    });
    expect(await screen.findByText('Mock settings saved.')).toBeVisible();
  });
  it('handles preview revision conflict with explicit reload', async () => {
    mappingHandler = (path) =>
      path.endsWith('/deployment-preview') ? json({}, 409) : json({ mapping: initial });
    mount();
    const user = userEvent.setup();
    await select(user);
    await user.click(await screen.findByRole('button', { name: 'Preview saved mock settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Saved settings changed');
    await user.click(screen.getByRole('button', { name: 'Reload saved settings' }));
    expect(await screen.findByText('Saved settings reloaded.')).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Preview saved mock settings' })).toBeEnabled();
  });
  it('shows member unconfigured state without mutation or preview controls', async () => {
    role = 'member';
    mappingHandler = () => json({ mapping: null });
    mount();
    const user = userEvent.setup();
    await select(user);
    expect(await screen.findByText('No mock settings saved for this service.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save mock settings' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Preview saved mock settings' }),
    ).not.toBeInTheDocument();
  });
  it('supports StrictMode query/effect replay and clears mapping cache on unmount', async () => {
    const { client, unmount } = mount(true);
    const user = userEvent.setup();
    await select(user);
    await user.click(await screen.findByRole('button', { name: 'Preview saved mock settings' }));
    expect(
      await screen.findByRole('region', { name: 'Fictional deployment preview' }),
    ).toBeVisible();
    unmount();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });
  it('ignores a late expiry response from previously selected service', async () => {
    const late = deferred();
    mappingHandler = (path) =>
      path.includes(otherService)
        ? json({ mapping: { ...initial, serviceId: otherService } })
        : path.endsWith('/deployment-preview')
          ? late.promise
          : json({ mapping: initial });
    mount();
    const user = userEvent.setup();
    await select(user);
    await user.click(await screen.findByRole('button', { name: 'Preview saved mock settings' }));
    await user.click(screen.getByRole('button', { name: 'Mock settings for Billing' }));
    await screen.findByLabelText('Mock primary provider');
    await act(async () => {
      late.resolve(json({}, 401));
      await late.promise;
    });
    expect(screen.getByText('Signed in as alice')).toBeVisible();
    expect(
      screen.getByRole('heading', { name: 'Mock deployment settings for Billing' }),
    ).toBeVisible();
  });
});
