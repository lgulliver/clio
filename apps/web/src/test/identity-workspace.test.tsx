import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as navigation from '../lib/navigation';
import { createQueryClient } from '../lib/query-client';
import { createAppRouter } from '../router';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const serviceId = '33333333-3333-4333-8333-333333333333';
const token = 'a'.repeat(43);
function identity(id = 'alice') {
  return {
    user: {
      id,
      name: id === 'alice' ? 'Alice' : 'Bob',
      email: `${id}@example.test`,
      emailVerified: true,
      image: null,
    },
  };
}
function workspace(id = first, name = 'First workspace', role: 'owner' | 'member' = 'owner') {
  return { id, name, role };
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
type Handler = (path: string, options: RequestInit | undefined) => Response | Promise<Response>;
let handler: Handler;
const fetchMock = vi.fn(async (input: string | URL | Request, options?: RequestInit) =>
  handler(
    new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      .pathname,
    options,
  ),
);
function renderApp(path = '/settings', strict = false) {
  const client = createQueryClient();
  const router = createAppRouter(client, createMemoryHistory({ initialEntries: [path] }));
  const content = (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  const view = render(strict ? <StrictMode>{content}</StrictMode> : content);
  return { client, router, ...view };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Not initialized');
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function choose(user: ReturnType<typeof userEvent.setup>, id = first) {
  await user.selectOptions(await screen.findByLabelText('Workspace'), id);
}
beforeEach(() => {
  fetchMock.mockClear();
  vi.restoreAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  handler = (path) => {
    if (path === '/api/me') return json(identity());
    if (path === '/api/workspaces') return json({ workspaces: [workspace()] });
    if (path.endsWith('/services')) return json({ services: [] });
    throw new Error(`Unexpected test request: ${path}`);
  };
});
describe('browser identity and workspace', () => {
  it('shows signed-out state, posts only allowed login fields and rejects untrusted redirect', async () => {
    handler = (path) =>
      path === '/api/me'
        ? json({}, 401)
        : json({ redirect: false, url: 'https://evil.test/?token=private' });
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign in with GitHub' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The response could not be verified.',
    );
    expect(screen.queryByText(/private/)).not.toBeInTheDocument();
    const login = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith('/api/auth/sign-in/social'),
    );
    expect(login?.[1]).toMatchObject({ method: 'POST', credentials: 'include', cache: 'no-store' });
    expect(JSON.parse(String(login?.[1]?.body))).toEqual({
      provider: 'github',
      disableRedirect: true,
      callbackURL: `${window.location.origin}/settings`,
    });
    expect(screen.queryByLabelText('Workspace name')).not.toBeInTheDocument();
  });
  it('reports auth unavailable and retries; malformed success is redacted', async () => {
    let attempts = 0;
    handler = (path) => {
      if (path === '/api/me') {
        attempts += 1;
        return attempts === 1 ? json({ error: 'private SQL' }, 503) : json({ user: 'private SQL' });
      }
      throw new Error(path);
    };
    renderApp();
    expect(await screen.findByRole('alert')).toHaveTextContent('Clio is unavailable.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry sign-in check' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The response could not be verified.',
    );
    expect(screen.queryByText(/private SQL/)).not.toBeInTheDocument();
  });
  it('creates and selects a workspace, creates services, then reads a member workspace', async () => {
    let created = false;
    let servicesCreated = false;
    handler = (path, options) => {
      if (path === '/api/me') return json(identity());
      if (path === '/api/workspaces') {
        if (options?.method === 'POST') {
          created = true;
          return json({ workspace: workspace() }, 201);
        }
        return json({
          workspaces: created ? [workspace(), workspace(second, 'Member workspace', 'member')] : [],
        });
      }
      if (path.endsWith('/services')) {
        if (options?.method === 'POST') {
          servicesCreated = true;
          return json(
            { service: { id: serviceId, workspaceId: first, name: 'Delivery API' } },
            201,
          );
        }
        return json({
          services:
            servicesCreated && path.includes(first)
              ? [{ id: serviceId, workspaceId: first, name: 'Delivery API' }]
              : [],
        });
      }
      throw new Error(path);
    };
    const { client } = renderApp();
    const user = userEvent.setup();
    expect(
      await screen.findByText('No workspaces yet. Create one or accept an invitation.'),
    ).toBeVisible();
    await user.type(screen.getByLabelText('Workspace name'), 'First workspace');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));
    expect(await screen.findByText('Your role: owner')).toBeVisible();
    await user.type(await screen.findByLabelText('Service name'), 'Delivery API');
    await user.click(screen.getByRole('button', { name: 'Create service' }));
    expect(await screen.findByText('Delivery API')).toBeVisible();
    await act(() => client.invalidateQueries({ queryKey: ['identity', 'alice'] }));
    await choose(user, second);
    expect(await screen.findByText('Your role: member')).toBeVisible();
    expect(screen.queryByLabelText('Service name')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Member email')).not.toBeInTheDocument();
    expect(screen.queryByText('Delivery API')).not.toBeInTheDocument();
    expect(
      client
        .getQueryCache()
        .getAll()
        .some((query) => query.queryKey.includes('services') && query.queryKey.includes(first)),
    ).toBe(false);
  });
  it('shows invitation token once, clears fields on switch, accepts a manual token', async () => {
    let accepted = false;
    handler = (path, options) => {
      if (path === '/api/me') return json(identity());
      if (path === '/api/workspaces')
        return json({ workspaces: [workspace(), workspace(second, 'Second workspace')] });
      if (path.endsWith('/services')) return json({ services: [] });
      if (path.endsWith('/invitations'))
        return json(
          {
            invitation: {
              id: serviceId,
              workspaceId: first,
              email: 'bob@example.test',
              expiresAt: '2026-10-17T00:00:00Z',
              token,
            },
          },
          201,
        );
      if (path === '/api/workspace-invitations/accept') {
        expect(JSON.parse(String(options?.body))).toEqual({ token });
        accepted = true;
        return json({ workspaceId: first });
      }
      throw new Error(path);
    };
    const { client } = renderApp();
    const user = userEvent.setup();
    await choose(user);
    await user.type(await screen.findByLabelText('Member email'), 'bob@example.test');
    await user.click(screen.getByRole('button', { name: 'Create invitation' }));
    expect(await screen.findByLabelText('Invitation token — copy and share once')).toHaveValue(
      token,
    );
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain(token);
    await user.type(screen.getByLabelText('Invitation token'), 'sensitive-draft');
    const checks = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith('/api/me'),
    ).length;
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/me')).length,
      ).toBe(checks + 1),
    );
    expect(screen.getByLabelText('Invitation token — copy and share once')).toHaveValue(token);
    expect(screen.getByLabelText('Invitation token')).toHaveValue('sensitive-draft');
    expect(screen.getByLabelText('Workspace')).toHaveValue(first);
    await choose(user, second);
    expect(
      screen.queryByLabelText('Invitation token — copy and share once'),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Invitation token')).toHaveValue('');
    await user.type(screen.getByLabelText('Invitation token'), token);
    await user.click(screen.getByRole('button', { name: 'Accept invitation' }));
    await waitFor(() => expect(accepted).toBe(true));
    expect(await screen.findByLabelText('Workspace')).toHaveValue(first);
    expect(screen.getByText('Invitation accepted.')).toBeVisible();
  });
  it('clears private data immediately on logout and ignores a late invitation mutation', async () => {
    const late = deferred<Response>();
    handler = (path) => {
      if (path === '/api/me') return json(identity());
      if (path === '/api/workspaces') return json({ workspaces: [workspace()] });
      if (path.endsWith('/services'))
        return json({ services: [{ id: serviceId, workspaceId: first, name: 'Private service' }] });
      if (path.endsWith('/invitations')) return late.promise;
      if (path === '/api/auth/sign-out') return json({ success: true });
      throw new Error(path);
    };
    const { client } = renderApp();
    const user = userEvent.setup();
    await choose(user);
    await user.type(await screen.findByLabelText('Member email'), 'bob@example.test');
    await user.click(screen.getByRole('button', { name: 'Create invitation' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
    expect(screen.queryByText('Private service')).not.toBeInTheDocument();
    await act(async () => {
      late.resolve(
        json(
          {
            invitation: {
              id: serviceId,
              workspaceId: first,
              email: 'bob@example.test',
              expiresAt: '2026-10-17T00:00:00Z',
              token,
            },
          },
          201,
        ),
      );
      await late.promise;
    });
    expect(
      screen.queryByLabelText('Invitation token — copy and share once'),
    ).not.toBeInTheDocument();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });
  it('clears prior identity after focus detects a different user; late queries cannot populate its cache', async () => {
    const lateServices = deferred<Response>();
    const nextIdentity = deferred<Response>();
    let bob = false;
    handler = (path) => {
      if (path === '/api/me') return bob ? nextIdentity.promise : json(identity());
      if (path === '/api/workspaces')
        return json({
          workspaces: bob ? [workspace(second, 'Bob workspace', 'member')] : [workspace()],
        });
      if (path.endsWith('/services'))
        return path.includes(first) ? lateServices.promise : json({ services: [] });
      throw new Error(path);
    };
    const { client } = renderApp();
    const user = userEvent.setup();
    await choose(user);
    expect(await screen.findByText('Loading services…')).toBeVisible();
    bob = true;
    act(() => window.dispatchEvent(new Event('focus')));
    expect(screen.getByLabelText('Workspace')).toHaveValue(first);
    await act(async () => {
      lateServices.resolve(
        json({ services: [{ id: serviceId, workspaceId: first, name: 'Alice private service' }] }),
      );
      nextIdentity.resolve(json(identity('bob')));
      await nextIdentity.promise;
    });
    expect(await screen.findByText('Signed in as Bob')).toBeVisible();
    await choose(user, second);
    expect(await screen.findByText('Your role: member')).toBeVisible();
    expect(screen.queryByText('Alice private service')).not.toBeInTheDocument();
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => ({ key: query.queryKey, data: query.state.data })),
      ),
    ).not.toContain('alice');
  });
  it('releases the accept form while its new workspace list is still loading', async () => {
    const nextList = deferred<Response>();
    let accepted = false;
    handler = (path) => {
      if (path === '/api/me') return json(identity());
      if (path === '/api/workspaces') return accepted ? nextList.promise : json({ workspaces: [] });
      if (path === '/api/workspace-invitations/accept') {
        accepted = true;
        return json({ workspaceId: first });
      }
      if (path.endsWith('/services')) return json({ services: [] });
      throw new Error(path);
    };
    renderApp();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Invitation token'), token);
    await user.click(screen.getByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByText('Invitation accepted.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Accept invitation' })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
    expect(screen.getByLabelText('Invitation token')).not.toHaveAttribute('readonly');
    await act(async () => {
      nextList.resolve(json({ workspaces: [workspace()] }));
      await nextList.promise;
    });
    await waitFor(() => expect(screen.getByLabelText('Workspace')).toHaveValue(first));
  });
  it('refreshes workspace list after a create completes in a different selected scope', async () => {
    const late = deferred<Response>();
    let created = false;
    handler = (path, options) => {
      if (path === '/api/me') return json(identity());
      if (path === '/api/workspaces') {
        if (options?.method === 'POST') return late.promise;
        return json({
          workspaces: [
            workspace(),
            workspace(second, 'Second workspace'),
            ...(created ? [workspace(serviceId, 'Created later')] : []),
          ],
        });
      }
      if (path.endsWith('/services')) return json({ services: [] });
      throw new Error(path);
    };
    renderApp();
    const user = userEvent.setup();
    await choose(user);
    await user.type(screen.getByLabelText('Workspace name'), 'Created later');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));
    expect(screen.getByRole('button', { name: 'Create workspace…' })).toHaveFocus();
    await choose(user, second);
    created = true;
    await act(async () => {
      late.resolve(json({ workspace: workspace(serviceId, 'Created later') }, 201));
      await late.promise;
    });
    expect(
      await screen.findByRole('option', { name: 'Created later (owner)' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Workspace')).toHaveValue(second);
  });
  it('rejects a late service mutation after workspace switch', async () => {
    const late = deferred<Response>();
    handler = (path, options) => {
      if (path === '/api/me') return json(identity());
      if (path === '/api/workspaces')
        return json({ workspaces: [workspace(), workspace(second, 'Second workspace')] });
      if (path.endsWith('/services'))
        return options?.method === 'POST' ? late.promise : json({ services: [] });
      throw new Error(path);
    };
    renderApp();
    const user = userEvent.setup();
    await choose(user);
    await user.type(await screen.findByLabelText('Service name'), 'Late service');
    await user.click(screen.getByRole('button', { name: 'Create service' }));
    await choose(user, second);
    await user.type(await screen.findByLabelText('Service name'), 'New scope draft');
    await act(async () => {
      late.resolve(
        json({ service: { id: serviceId, workspaceId: first, name: 'Late service' } }, 201),
      );
      await late.promise;
    });
    expect(screen.getByLabelText('Service name')).toHaveValue('New scope draft');
    expect(screen.queryByText('Late service')).not.toBeInTheDocument();
  });
  it('expires identity when scoped API reports 401', async () => {
    handler = (path) => (path === '/api/me' ? json(identity()) : json({}, 401));
    const { client } = renderApp();
    expect(await screen.findByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Your session ended.');
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });
  it('shows a generic callback failure and ignores provider error details', async () => {
    handler = () => json({}, 401);
    const { router } = renderApp(
      '/settings?authError=1&error_description=private-provider-details',
    );
    expect(await screen.findByText('GitHub sign-in failed. Please try again.')).toBeVisible();
    expect(screen.queryByText(/private-provider/)).not.toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });
  it('navigates only to the validated GitHub authorize URL', async () => {
    const destination = 'https://github.com/login/oauth/authorize?client_id=example&state=test';
    const navigate = vi.spyOn(navigation, 'navigateExternal').mockImplementation(() => {});
    handler = (path) =>
      path === '/api/me' ? json({}, 401) : json({ redirect: false, url: destination });
    renderApp();
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Sign in with GitHub' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith(destination));
  });
  it.each([403, 404, 409, 503])(
    'handles service mutation status %s without synthetic data',
    async (status) => {
      handler = (path, options) => {
        if (path === '/api/me') return json(identity());
        if (path === '/api/workspaces') return json({ workspaces: [workspace()] });
        if (path.endsWith('/services'))
          return options?.method === 'POST'
            ? json({ error: 'private payload' }, status)
            : json({ services: [] });
        throw new Error(path);
      };
      renderApp();
      const user = userEvent.setup();
      await choose(user);
      await user.type(await screen.findByLabelText('Service name'), 'Rejected service');
      await user.click(screen.getByRole('button', { name: 'Create service' }));
      const expected =
        status === 403
          ? 'You do not have permission'
          : status === 404
            ? 'no longer available'
            : status === 409
              ? 'conflicts with an existing record'
              : 'Clio is unavailable';
      expect(await screen.findByRole('alert')).toHaveTextContent(expected);
      expect(screen.queryByText('Rejected service')).not.toBeInTheDocument();
      expect(screen.queryByText(/private payload/)).not.toBeInTheDocument();
      if (status === 403 || status === 404)
        expect(screen.queryByLabelText('Member email')).not.toBeInTheDocument();
      else expect(screen.getByLabelText('Service name')).toHaveValue('Rejected service');
    },
  );
  it('keeps data hidden if server logout fails rather than claiming logout succeeded', async () => {
    handler = (path) => {
      if (path === '/api/me') return json(identity());
      if (path === '/api/workspaces') return json({ workspaces: [workspace()] });
      if (path.endsWith('/services')) return json({ services: [] });
      if (path === '/api/auth/sign-out') return json({}, 503);
      throw new Error(path);
    };
    const { client } = renderApp();
    await screen.findByLabelText('Workspace');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign out could not be confirmed.');
    expect(screen.queryByRole('button', { name: 'Sign in with GitHub' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Workspace')).not.toBeInTheDocument();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Retry sign out' })).toBeVisible();
    const checks = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith('/api/me'),
    ).length;
    act(() => window.dispatchEvent(new Event('focus')));
    expect(screen.getByRole('button', { name: 'Retry sign out' })).toBeVisible();
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/me')),
    ).toHaveLength(checks);
  });
  it('clears fields when hidden and detects session expiry when visible again', async () => {
    let expired = false;
    handler = (path) => {
      if (path === '/api/me') return expired ? json({}, 401) : json(identity());
      if (path === '/api/workspaces') return json({ workspaces: [workspace()] });
      if (path.endsWith('/services')) return json({ services: [] });
      throw new Error(path);
    };
    const { client } = renderApp();
    const user = userEvent.setup();
    await choose(user);
    await user.type(screen.getByLabelText('Invitation token'), 'private draft');
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(screen.queryByLabelText('Invitation token')).not.toBeInTheDocument();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expired = true;
    visibility.mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(await screen.findByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
  });
  it('drops late invitation creation after workspace switch', async () => {
    const late = deferred<Response>();
    handler = (path) => {
      if (path === '/api/me') return json(identity());
      if (path === '/api/workspaces')
        return json({ workspaces: [workspace(), workspace(second, 'Second workspace')] });
      if (path.endsWith('/services')) return json({ services: [] });
      if (path.endsWith('/invitations')) return late.promise;
      throw new Error(path);
    };
    renderApp();
    const user = userEvent.setup();
    await choose(user);
    await user.type(await screen.findByLabelText('Member email'), 'bob@example.test');
    await user.click(screen.getByRole('button', { name: 'Create invitation' }));
    await choose(user, second);
    await screen.findByLabelText('Member email');
    await act(async () => {
      late.resolve(
        json(
          {
            invitation: {
              id: serviceId,
              workspaceId: first,
              email: 'bob@example.test',
              expiresAt: '2026-10-17T00:00:00Z',
              token,
            },
          },
          201,
        ),
      );
      await late.promise;
    });
    expect(
      screen.queryByLabelText('Invitation token — copy and share once'),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Member email')).toHaveValue('');
  });
  it('supports StrictMode effect replay without dropping current workspace queries', async () => {
    renderApp('/settings', true);
    const user = userEvent.setup();
    await choose(user);
    expect(await screen.findByLabelText('Service name')).toBeVisible();
    expect(screen.getByText('No services yet.')).toBeVisible();
  });
  it('clears identity and sensitive fields on a mutation session-expiry response', async () => {
    handler = (path, options) => {
      if (path === '/api/me') return json(identity());
      if (path === '/api/workspaces') return json({ workspaces: [workspace()] });
      if (path.endsWith('/services'))
        return options?.method === 'POST' ? json({}, 401) : json({ services: [] });
      throw new Error(path);
    };
    const { client } = renderApp();
    const user = userEvent.setup();
    await choose(user);
    await user.type(screen.getByLabelText('Invitation token'), 'private draft');
    await user.type(await screen.findByLabelText('Service name'), 'Expired request');
    await user.click(screen.getByRole('button', { name: 'Create service' }));
    expect(await screen.findByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
    expect(screen.queryByLabelText('Invitation token')).not.toBeInTheDocument();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });
});
