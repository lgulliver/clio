import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../lib/query-client';
import { createAppRouter } from '../router';

function renderApp(path = '/') {
  const queryClient = createQueryClient();
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

describe('application routing', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 })),
    );
  });
  it('asks signed-out visitors to sign in before inspecting evidence', async () => {
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Stored service evidence' })).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  });

  it('navigates to workspace through the overview action', async () => {
    const user = userEvent.setup();
    const { router } = renderApp();
    await user.click(await screen.findByRole('link', { name: 'View workspace' }));
    expect(await screen.findByRole('heading', { name: 'Workspace', level: 1 })).toBeVisible();
    expect(router.state.location.pathname).toBe('/settings');
  });

  it('renders workspace on a direct visit', async () => {
    renderApp('/settings');
    expect(await screen.findByRole('heading', { name: 'Workspace', level: 1 })).toBeVisible();
    expect(
      screen.getByText(
        'Select a workspace and service to manage live GitHub or Argo connections, or demo deployment settings.',
      ),
    ).toBeVisible();
  });

  it('navigates to developer experience from the main navigation', async () => {
    const user = userEvent.setup();
    const { router } = renderApp();
    const navigation = await screen.findByRole('navigation', { name: 'Main navigation' });
    await user.click(within(navigation).getByRole('link', { name: 'Developer experience' }));
    expect(
      await screen.findByRole('heading', { name: 'Developer experience', level: 1 }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/developer-experience');
    expect(within(navigation).getByRole('link', { name: 'Developer experience' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('renders developer experience on a direct visit', async () => {
    renderApp('/developer-experience');
    expect(
      await screen.findByRole('heading', { name: 'Developer experience', level: 1 }),
    ).toBeVisible();
    expect(await screen.findByText('Sign in with GitHub to view team pulses.')).toBeVisible();
  });

  it('offers a working recovery link for an unknown route', async () => {
    const user = userEvent.setup();
    renderApp('/missing');
    await user.click(await screen.findByRole('link', { name: 'Return to overview' }));
    expect(await screen.findByRole('heading', { name: 'Stored service evidence' })).toBeVisible();
  });
});
