import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { IdentityControls } from '../features/identity/session';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      <a
        href="#main-content"
        className="sr-only rounded bg-white p-3 focus:not-sr-only focus:absolute focus:z-10"
      >
        Skip to content
      </a>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-5">
          <Link to="/" className="text-xl font-semibold tracking-tight">
            Clio
          </Link>
          <nav aria-label="Main navigation" className="flex gap-5 text-sm font-medium">
            <Link
              to="/"
              activeOptions={{ exact: true }}
              activeProps={{ className: 'text-indigo-700', 'aria-current': 'page' }}
            >
              Overview
            </Link>
            <Link
              to="/settings"
              activeProps={{ className: 'text-indigo-700', 'aria-current': 'page' }}
            >
              Workspace
            </Link>
          </nav>
          <IdentityControls />
        </div>
      </header>
      <main id="main-content" className="mx-auto max-w-6xl px-6 py-12">
        {children}
      </main>
    </div>
  );
}
