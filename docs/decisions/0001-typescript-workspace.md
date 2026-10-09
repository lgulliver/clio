# ADR 0001 TypeScript workspace foundation

Status: implemented
Date: 2026-10-09
Maintainer: Liam Gulliver

## Context and decision

The maintainer requested repository setup using TypeScript and the latest stable Vite, TanStack and Tailwind tooling. Use a pnpm workspace with a React/Vite SPA, TanStack Router for navigation, TanStack Query for server state, Tailwind 4 for CSS, strict shared TypeScript configs, Biome and Vitest/Testing Library.

Versions were read from each package's official npm latest dist-tag on the decision date, then checked by installation, peer validation, type checks, tests and build. Direct versions are exact; pnpm-lock.yaml pins transitive dependencies. TanStack Router and its generator/plugin have independent published version numbers; use their latest compatible tags rather than force matching numbers. Node uses the current Node 24 LTS patch from nodejs.org/dist/index.json; Node type declarations track runtime major 24 instead of npm's Node 26 type tag.

| Package | Selected stable version |
| --- | --- |
| typescript | 7.0.2 |
| vite | 8.3.4 |
| @vitejs/plugin-react | 6.1.2 |
| react | 19.3.0 |
| @tanstack/react-router | 1.170.41 |
| @tanstack/router-plugin | 1.168.42 |
| @tanstack/react-query | 5.104.1 |
| tailwindcss | 4.3.3 |
| vitest | 5.0.3 |
| @biomejs/biome | 2.5.15 |
| pnpm | 12.10.1 |

Node 24.21.0 is pinned; engines permit compatible Node 24 patches from 24.15.0. Latest package releases are a setup decision, not a promise of automatic unreviewed upgrades. Upgrade related packages together, refresh the lockfile and run the same checks.

## Alternatives and consequences

A single package would reduce workspace setup but mix browser presentation, provider credentials and the standard boundary as the app grows. A small workspace establishes those boundaries now without adding a task orchestrator or publishing infrastructure.

TanStack Start/SSR is not selected: the requested Vite foundation can be a client SPA, and server/auth/collection requirements have not yet been established. Choose the server boundary with the first adapter rather than assume browser-side provider collection. Internal packages currently expose TypeScript source for Vite; they are not published libraries.

The shell intentionally contains no invented metric data. The OEMS package initially pins provenance without claiming validation. Clio licensing is a separate maintainer decision; this setup grants no application licence.
