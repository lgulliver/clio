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
    (() => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      return url.pathname + url.search;
    })(),
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

const accessMember = {
  userId: 'bob/id',
  name: 'Bob',
  email: 'bob@example.test',
  role: 'member',
  createdAt: '2026-10-11T00:00:00Z',
};
const accessInvite = {
  id: serviceId,
  email: 'invited@example.test',
  status: 'pending',
  createdAt: '2026-10-11T00:00:00Z',
  expiresAt: '2026-10-18T00:00:00Z',
};
function accessHandler(overrides?: Handler): Handler {
  return (path, options) => {
    if (path === '/api/me') return json(identity());
    if (path === '/api/workspaces')
      return json({ workspaces: [workspace(), workspace(second, 'Second workspace')] });
    if (path.endsWith('/services')) return json({ services: [] });
    if (overrides) return overrides(path, options);
    if (path.endsWith('/members'))
      return json({
        workspaceId: first,
        members: [accessMember, { ...accessMember, userId: 'alice', name: 'Alice', role: 'owner' }],
        hasMore: false,
      });
    if (path.endsWith('/invitations'))
      return json({ workspaceId: first, invitations: [accessInvite], hasMore: false });
    throw new Error(path);
  };
}
async function openAccess(user: ReturnType<typeof userEvent.setup>) {
  await choose(user);
  await user.click(await screen.findByRole('button', { name: 'Manage workspace access' }));
}
describe('owner workspace access', () => {
  it('revalidates after targeted revocation/cancellation, handles 204 and omits owner actions', async () => {
    let revoked = false;
    let cancelled = false;
    handler = accessHandler((path, options) => {
      if (options?.method === 'DELETE') {
        if (path.endsWith('/members/bob%2Fid')) revoked = true;
        else if (path.endsWith(`/invitations/${serviceId}`)) cancelled = true;
        else throw new Error(path);
        return new Response(null, { status: 204 });
      }
      if (path.endsWith('/members'))
        return json({
          workspaceId: first,
          members: revoked
            ? []
            : [accessMember, { ...accessMember, userId: 'alice', name: 'Alice', role: 'owner' }],
          hasMore: false,
        });
      return json({
        workspaceId: first,
        invitations: cancelled ? [] : [accessInvite],
        hasMore: false,
      });
    });
    renderApp();
    const user = userEvent.setup();
    await openAccess(user);
    expect(await screen.findByText('Alice (bob@example.test) — owner')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /Revoke access for Alice/ }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Revoke access for Bob (bob@example.test)' }),
    );
    expect(await screen.findByText('No members found.')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Workspace access' })).toHaveFocus();
    await user.click(
      screen.getByRole('button', { name: /Cancel invitation for invited@example.test/ }),
    );
    expect(await screen.findByText('No pending invitations.')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Workspace access' })).toHaveFocus();
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toHaveLength(
      2,
    );
  });
  it.each(['bob@example.test', 'BOB@example.test', 'unrelated@example.test'])(
    'clears only matching displayed invitation after revocation: %s',
    async (email) => {
      handler = accessHandler((path, options) => {
        if (options?.method === 'POST' && path.endsWith('/invitations'))
          return json(
            {
              invitation: {
                id: serviceId,
                workspaceId: first,
                email,
                expiresAt: accessInvite.expiresAt,
                token,
              },
            },
            201,
          );
        if (options?.method === 'DELETE') return new Response(null, { status: 204 });
        if (path.endsWith('/members'))
          return json({ workspaceId: first, members: [accessMember], hasMore: false });
        return json({ workspaceId: first, invitations: [], hasMore: false });
      });
      renderApp();
      const user = userEvent.setup();
      await openAccess(user);
      await user.type(await screen.findByLabelText('Member email'), email);
      await user.click(screen.getByRole('button', { name: 'Create invitation' }));
      expect(await screen.findByLabelText('Invitation token — copy and share once')).toHaveValue(
        token,
      );
      await user.click(
        await screen.findByRole('button', { name: 'Revoke access for Bob (bob@example.test)' }),
      );
      await screen.findByText('Access revoked for Bob.');
      if (email.toLowerCase() === 'bob@example.test')
        expect(
          screen.queryByLabelText('Invitation token — copy and share once'),
        ).not.toBeInTheDocument();
      else
        expect(screen.getByLabelText('Invitation token — copy and share once')).toHaveValue(token);
    },
  );
  it('shows loading, retryable error, empty lists and honest overflow', async () => {
    const late = deferred<Response>();
    let failed = true;
    handler = accessHandler((path) =>
      path.endsWith('/members')
        ? failed
          ? late.promise
          : json({ workspaceId: first, members: [], hasMore: true })
        : json({ workspaceId: first, invitations: [], hasMore: false }),
    );
    renderApp();
    const user = userEvent.setup();
    await openAccess(user);
    expect(screen.getByText('Loading workspace access…')).toBeVisible();
    await act(async () => {
      late.resolve(json({}, 503));
      await late.promise;
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Clio is unavailable');
    failed = false;
    await user.click(screen.getByRole('button', { name: 'Retry workspace access' }));
    expect(await screen.findByText('No members found.')).toBeVisible();
    expect(screen.getByText(/this list is incomplete/)).toBeVisible();
    expect(screen.getByText('No pending invitations.')).toBeVisible();
  });
  it.each(['read', 'write'])('drops late %s after workspace change', async (kind) => {
    const late = deferred<Response>();
    handler = accessHandler((path, options) => {
      if (options?.method === 'DELETE') return late.promise;
      if (path.endsWith('/members'))
        return kind === 'read'
          ? late.promise
          : json({ workspaceId: first, members: [accessMember], hasMore: false });
      return json({ workspaceId: first, invitations: [], hasMore: false });
    });
    renderApp();
    const user = userEvent.setup();
    await openAccess(user);
    if (kind === 'write') {
      await user.click(
        await screen.findByRole('button', { name: 'Revoke access for Bob (bob@example.test)' }),
      );
      expect(screen.getByText('Updating access…')).toBeVisible();
      expect(screen.queryByRole('button', { name: /Revoke access for/ })).not.toBeInTheDocument();
    }
    await choose(user, second);
    await act(async () => {
      late.resolve(
        kind === 'read'
          ? json({ workspaceId: first, members: [accessMember], hasMore: false })
          : new Response(null, { status: 204 }),
      );
      await late.promise;
    });
    expect(screen.queryByText(/Access revoked for Bob/)).not.toBeInTheDocument();
    expect(screen.queryByText(/bob@example.test/)).not.toBeInTheDocument();
  });
  it('expires identity and drops late reads when identity changes', async () => {
    const late = deferred<Response>();
    let expired = false;
    const original = accessHandler((path) =>
      path.endsWith('/members')
        ? late.promise
        : json({ workspaceId: first, invitations: [], hasMore: false }),
    );
    handler = (path, options) =>
      path === '/api/me' && expired ? json({}, 401) : original(path, options);
    const { client } = renderApp();
    const user = userEvent.setup();
    await openAccess(user);
    expired = true;
    act(() => window.dispatchEvent(new Event('focus')));
    await screen.findByRole('button', { name: 'Sign in with GitHub' });
    await act(async () => {
      late.resolve(json({ workspaceId: first, members: [accessMember], hasMore: false }));
      await late.promise;
    });
    expect(screen.queryByText(/bob@example.test/)).not.toBeInTheDocument();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });
  it('hides owner controls for members without issuing access reads', async () => {
    handler = (path) => {
      if (path === '/api/me') return json(identity());
      if (path === '/api/workspaces')
        return json({ workspaces: [workspace(first, 'Member workspace', 'member')] });
      if (path.endsWith('/services')) return json({ services: [] });
      throw new Error(path);
    };
    renderApp();
    await choose(userEvent.setup());
    await screen.findByText('No services yet.');
    expect(
      screen.queryByRole('button', { name: 'Manage workspace access' }),
    ).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([input]) => String(input).endsWith('/members') || String(input).endsWith('/invitations'),
      ),
    ).toBe(false);
  });
  it.each([401, 403, 404])('fails closed on access read status %s', async (status) => {
    handler = accessHandler(() => json({}, status));
    renderApp();
    await openAccess(userEvent.setup());
    if (status === 401) await screen.findByRole('button', { name: 'Sign in with GitHub' });
    else await screen.findByRole('button', { name: 'Refresh access' });
    expect(
      screen.queryByRole('button', { name: 'Manage workspace access' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Member email')).not.toBeInTheDocument();
  });
});

it.each([401, 403, 404, 503])(
  'handles access write status %s without retaining stale controls',
  async (status) => {
    handler = accessHandler((path, options) => {
      if (options?.method === 'DELETE') return json({ error: 'private-payload' }, status);
      if (path.endsWith('/members'))
        return json({ workspaceId: first, members: [accessMember], hasMore: false });
      return json({ workspaceId: first, invitations: [], hasMore: false });
    });
    renderApp();
    const user = userEvent.setup();
    await openAccess(user);
    await user.click(
      await screen.findByRole('button', { name: 'Revoke access for Bob (bob@example.test)' }),
    );
    if (status === 401) await screen.findByRole('button', { name: 'Sign in with GitHub' });
    else if (status === 503) {
      expect(await screen.findByRole('alert')).toHaveTextContent('Clio is unavailable');
      expect(
        screen.getByRole('button', { name: 'Revoke access for Bob (bob@example.test)' }),
      ).toBeEnabled();
    } else {
      await screen.findByRole('button', { name: 'Refresh access' });
      expect(screen.queryByText(/bob@example.test/)).not.toBeInTheDocument();
    }
    expect(screen.queryByText(/private-payload/)).not.toBeInTheDocument();
  },
);
it('drops late access write after identity changes', async () => {
  const late = deferred<Response>();
  let expired = false;
  const original = accessHandler((path, options) => {
    if (options?.method === 'DELETE') return late.promise;
    if (path.endsWith('/members'))
      return json({ workspaceId: first, members: [accessMember], hasMore: false });
    return json({ workspaceId: first, invitations: [], hasMore: false });
  });
  handler = (path, options) =>
    path === '/api/me' && expired ? json({}, 401) : original(path, options);
  const { client } = renderApp();
  const user = userEvent.setup();
  await openAccess(user);
  await user.click(
    await screen.findByRole('button', { name: 'Revoke access for Bob (bob@example.test)' }),
  );
  expired = true;
  act(() => window.dispatchEvent(new Event('focus')));
  await screen.findByRole('button', { name: 'Sign in with GitHub' });
  await act(async () => {
    late.resolve(new Response(null, { status: 204 }));
    await late.promise;
  });
  expect(screen.queryByText(/Access revoked/)).not.toBeInTheDocument();
  expect(client.getQueryCache().getAll()).toHaveLength(0);
});
it('loads owner access during StrictMode effect replay', async () => {
  handler = accessHandler();
  renderApp('/settings', true);
  await openAccess(userEvent.setup());
  expect(
    await screen.findByRole('button', { name: 'Revoke access for Bob (bob@example.test)' }),
  ).toBeVisible();
});

function pagedAccessHandler(overrides?: Handler): Handler {
  const members = Array.from({ length: 100 }, (_, index) => ({
    ...accessMember,
    userId: `opaque/${index}`,
    name: `Page member ${index}`,
  }));
  const invitations = Array.from({ length: 100 }, (_, index) => ({
    ...accessInvite,
    id: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
    email: `page-invite-${index}@example.test`,
  }));
  return accessHandler((path, options) => {
    if (path.includes('?cursor=') || options?.method === 'DELETE') {
      if (overrides) return overrides(path, options);
      return path.includes('/members')
        ? json({ workspaceId: first, members: [accessMember], hasMore: false, nextCursor: null })
        : json({
            workspaceId: first,
            invitations: [accessInvite],
            hasMore: false,
            nextCursor: null,
          });
    }
    return path.endsWith('/members')
      ? json({ workspaceId: first, members, hasMore: true, nextCursor: 'opaque/99' })
      : json({ workspaceId: first, invitations, hasMore: true, nextCursor: invitations[99]?.id });
  });
}
it('navigates independent bounded member/invitation pages, first pages and refresh with stable focus', async () => {
  handler = pagedAccessHandler();
  renderApp();
  const user = userEvent.setup();
  await openAccess(user);
  await user.click(await screen.findByRole('button', { name: 'Next members page' }));
  expect(
    await screen.findByRole('button', { name: 'Revoke access for Bob (bob@example.test)' }),
  ).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Workspace access' })).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Next members page' })).toBeDisabled();
  expect(screen.getByText(/page-invite-99@example.test/)).toBeVisible();
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/invitations'))).toHaveLength(
    1,
  );
  await user.click(screen.getByRole('button', { name: 'Next invitations page' }));
  expect(
    await screen.findByRole('button', { name: /Cancel invitation for invited@example.test/ }),
  ).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Workspace access' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Refresh workspace access' }));
  await screen.findByRole('button', { name: /Cancel invitation for invited@example.test/ });
  expect(screen.getByRole('heading', { name: 'Workspace access' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'First members page' }));
  expect(await screen.findByText(/Page member 99/)).toBeVisible();
  expect(screen.queryByText(/Page member 100/)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'First invitations page' }));
  expect(await screen.findByText(/page-invite-99@example.test/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'First members page' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'First invitations page' })).toBeDisabled();
});
it('cancels/removes abandoned pages and drops late data when returning to first page', async () => {
  const late = deferred<Response>();
  handler = pagedAccessHandler(() => late.promise);
  const { client } = renderApp();
  const user = userEvent.setup();
  await openAccess(user);
  await user.click(await screen.findByRole('button', { name: 'Next members page' }));
  expect(screen.getByText('Loading workspace access…')).toBeVisible();
  const call = fetchMock.mock.calls.find(([url]) => String(url).includes('?cursor=opaque%2F99'));
  await user.click(screen.getByRole('button', { name: 'First members page' }));
  await screen.findByText(/Page member 99/);
  expect(call?.[1]?.signal?.aborted).toBe(true);
  await act(async () => {
    late.resolve(
      json({ workspaceId: first, members: [accessMember], hasMore: false, nextCursor: null }),
    );
    await late.promise;
  });
  expect(
    screen.queryByRole('button', { name: 'Revoke access for Bob (bob@example.test)' }),
  ).not.toBeInTheDocument();
  expect(
    client
      .getQueryCache()
      .getAll()
      .some((query) => query.queryKey.includes('opaque/99')),
  ).toBe(false);
  expect(screen.getByRole('heading', { name: 'Workspace access' })).toHaveFocus();
});
it('retries page errors with focus and resets both cursors after successful revocation', async () => {
  let fail = true;
  handler = pagedAccessHandler((path, options) => {
    if (options?.method === 'DELETE') return new Response(null, { status: 204 });
    if (fail) return json({}, 503);
    return path.includes('/members')
      ? json({ workspaceId: first, members: [accessMember], hasMore: false, nextCursor: null })
      : json({ workspaceId: first, invitations: [accessInvite], hasMore: false, nextCursor: null });
  });
  renderApp();
  const user = userEvent.setup();
  await openAccess(user);
  await user.click(await screen.findByRole('button', { name: 'Next members page' }));
  await screen.findByRole('button', { name: 'Retry workspace access' });
  fail = false;
  await user.click(screen.getByRole('button', { name: 'Retry workspace access' }));
  await screen.findByRole('button', { name: 'Revoke access for Bob (bob@example.test)' });
  expect(screen.getByRole('heading', { name: 'Workspace access' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Next invitations page' }));
  await screen.findByRole('button', { name: /Cancel invitation for invited@example.test/ });
  await user.click(
    screen.getByRole('button', { name: 'Revoke access for Bob (bob@example.test)' }),
  );
  await screen.findByText(/Page member 99/);
  expect(screen.getByRole('button', { name: 'First members page' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'First invitations page' })).toBeDisabled();
  expect(screen.getByRole('heading', { name: 'Workspace access' })).toHaveFocus();
});

it.each([401, 403])('hides protected pages after next-page status %s', async (status) => {
  handler = pagedAccessHandler(() => json({}, status));
  renderApp();
  const user = userEvent.setup();
  await openAccess(user);
  await user.click(await screen.findByRole('button', { name: 'Next members page' }));
  if (status === 401) await screen.findByRole('button', { name: 'Sign in with GitHub' });
  else await screen.findByRole('button', { name: 'Refresh access' });
  expect(screen.queryByRole('button', { name: 'Next members page' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Page member 99/)).not.toBeInTheDocument();
});
it.each(['members', 'invitations'])(
  'recovers stale %s cursor without hiding workspace',
  async (kind) => {
    handler = pagedAccessHandler(() => json({}, 404));
    renderApp();
    const user = userEvent.setup();
    await openAccess(user);
    await user.click(await screen.findByRole('button', { name: `Next ${kind} page` }));
    await screen.findByText('Saved page position is no longer available. Returned to first page.');
    expect(
      await screen.findByText(
        kind === 'members' ? /Page member 99/ : /page-invite-99@example.test/,
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Refresh access' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: `First ${kind} page` })).toBeDisabled();
    expect(screen.getByRole('heading', { name: 'Workspace access' })).toHaveFocus();
  },
);
it('confirms first-page access after stale cursor and hides workspace if revoked', async () => {
  let stale = false;
  const original = pagedAccessHandler(() => {
    stale = true;
    return json({}, 404);
  });
  handler = (path, options) =>
    stale && path === `/api/workspaces/${first}/members` ? json({}, 404) : original(path, options);
  renderApp();
  const user = userEvent.setup();
  await openAccess(user);
  await user.click(await screen.findByRole('button', { name: 'Next members page' }));
  await screen.findByRole('button', { name: 'Refresh access' });
  expect(screen.queryByRole('button', { name: 'Next members page' })).not.toBeInTheDocument();
});
it.each(['workspace', 'identity'])('drops next-page completion after %s changes', async (kind) => {
  const late = deferred<Response>();
  const original = pagedAccessHandler(() => late.promise);
  let changed = false;
  handler = (path, options) =>
    path === '/api/me' && changed ? json(identity('bob')) : original(path, options);
  const { client } = renderApp();
  const user = userEvent.setup();
  await openAccess(user);
  await user.click(await screen.findByRole('button', { name: 'Next members page' }));
  const call = fetchMock.mock.calls.find(([url]) => String(url).includes('?cursor=opaque%2F99'));
  if (kind === 'workspace') await choose(user, second);
  else {
    changed = true;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await screen.findByText('Signed in as Bob');
  }
  await waitFor(() => expect(call?.[1]?.signal?.aborted).toBe(true));
  await act(async () => {
    late.resolve(
      json({ workspaceId: first, members: [accessMember], hasMore: false, nextCursor: null }),
    );
    await late.promise;
  });
  expect(
    screen.queryByRole('button', { name: 'Revoke access for Bob (bob@example.test)' }),
  ).not.toBeInTheDocument();
  expect(
    client
      .getQueryCache()
      .getAll()
      .some((query) => query.queryKey.includes('opaque/99')),
  ).toBe(false);
});
it.each([true, false])(
  'resets invitation paging and clears token only for matching ID: %s',
  async (matching) => {
    let cancelled = false;
    handler = pagedAccessHandler((_path, options) => {
      if (options?.method === 'DELETE') {
        cancelled = true;
        return new Response(null, { status: 204 });
      }
      return json({
        workspaceId: first,
        invitations: [accessInvite],
        hasMore: false,
        nextCursor: null,
      });
    });
    const original = handler;
    handler = (path, options) =>
      options?.method === 'POST'
        ? json(
            {
              invitation: {
                id: matching ? serviceId : second,
                workspaceId: first,
                email: accessInvite.email,
                expiresAt: accessInvite.expiresAt,
                token,
              },
            },
            201,
          )
        : original(path, options);
    renderApp();
    const user = userEvent.setup();
    await openAccess(user);
    await user.type(screen.getByLabelText('Member email'), accessInvite.email);
    await user.click(screen.getByRole('button', { name: 'Create invitation' }));
    await screen.findByLabelText('Invitation token — copy and share once');
    await user.click(screen.getByRole('button', { name: 'Next invitations page' }));
    await user.click(
      await screen.findByRole('button', { name: /Cancel invitation for invited@example.test/ }),
    );
    await screen.findByText(/page-invite-99@example.test/);
    expect(cancelled).toBe(true);
    expect(screen.getByRole('button', { name: 'First invitations page' })).toBeDisabled();
    if (matching)
      expect(
        screen.queryByLabelText('Invitation token — copy and share once'),
      ).not.toBeInTheDocument();
    else expect(screen.getByLabelText('Invitation token — copy and share once')).toHaveValue(token);
    expect(screen.getByRole('heading', { name: 'Workspace access' })).toHaveFocus();
  },
);
