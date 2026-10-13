import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { IdentityControls } from '../features/identity/session';

function NavigationIcon({ kind = 'overview' }: { kind?: 'overview' | 'experience' | 'settings' }) {
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      {kind === 'experience' ? (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M8.5 13.5c.9 1.3 2.1 2 3.5 2s2.6-.7 3.5-2" />
          <path d="M9 9.5h.01M15 9.5h.01" strokeLinecap="round" strokeWidth="2.4" />
        </>
      ) : kind === 'settings' ? (
        <>
          <path d="M4 7h16M4 17h16" />
          <rect x="7" y="4" width="4" height="6" rx="1" fill="currentColor" stroke="none" />
          <rect x="14" y="14" width="4" height="6" rx="1" fill="currentColor" stroke="none" />
        </>
      ) : (
        <>
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </>
      )}
    </svg>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-frame font-sans">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <aside className="app-sidebar">
        <Link to="/" className="app-brand">
          <span className="brand-mark" aria-hidden="true">
            c
          </span>
          Clio
        </Link>
        <nav aria-label="Main navigation" className="app-navigation">
          <Link
            to="/"
            className="navigation-link"
            activeOptions={{ exact: true }}
            activeProps={{
              className: 'navigation-link navigation-link-active',
              'aria-current': 'page',
            }}
          >
            <NavigationIcon /> Overview
          </Link>
          <Link
            to="/developer-experience"
            className="navigation-link"
            activeProps={{
              className: 'navigation-link navigation-link-active',
              'aria-current': 'page',
            }}
          >
            <NavigationIcon kind="experience" /> Developer experience
          </Link>
          <Link
            to="/settings"
            className="navigation-link"
            activeProps={{
              className: 'navigation-link navigation-link-active',
              'aria-current': 'page',
            }}
          >
            <NavigationIcon kind="settings" /> Workspace
          </Link>
        </nav>
        <div className="sidebar-note">
          <span className="sidebar-note-mark" aria-hidden="true" />
          Evidence-led delivery
        </div>
      </aside>
      <div className="app-content">
        <header className="app-topbar">
          <span className="topbar-title">Engineering delivery</span>
          <IdentityControls />
        </header>
        <main id="main-content" className="app-main">
          {children}
        </main>
      </div>
    </div>
  );
}
