import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router';
import { AppShell } from '../components/app-shell';

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
  notFoundComponent: () => (
    <section>
      <h1 className="text-3xl font-semibold">Page not found</h1>
      <p className="mt-3 text-slate-600">This page is not available.</p>
      <Link to="/" className="mt-6 inline-block text-indigo-700 underline">
        Return to overview
      </Link>
    </section>
  ),
  errorComponent: ({ reset }) => (
    <section role="alert">
      <h1 className="text-3xl font-semibold">Something went wrong</h1>
      <button
        type="button"
        onClick={reset}
        className="mt-6 rounded bg-slate-900 px-4 py-2 text-white"
      >
        Try again
      </button>
    </section>
  ),
});
