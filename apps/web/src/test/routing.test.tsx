import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
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
  it('renders an honest empty state before evidence is connected', async () => {
    renderApp();
    expect(await screen.findByRole('heading', { name: 'No service evidence yet' })).toBeVisible();
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
        'Select a workspace and service to manage live GitHub connections or separate mock deployment settings.',
      ),
    ).toBeVisible();
  });

  it('offers a working recovery link for an unknown route', async () => {
    const user = userEvent.setup();
    renderApp('/missing');
    await user.click(await screen.findByRole('link', { name: 'Return to overview' }));
    expect(await screen.findByRole('heading', { name: 'No service evidence yet' })).toBeVisible();
  });
});
