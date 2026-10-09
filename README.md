# Clio

Clio is an engineering-delivery application built around traceable evidence and the [Open Engineering Metrics Standard](https://github.com/lgulliver/oems).

Status: repository foundation. A working browser shell and development tooling are implemented. Provider collection, authentication, persistence and metric calculation are not implemented yet. Liam Gulliver is the sole maintainer.

## Quick start

Use Node 24 LTS (24.21.0 is pinned in .node-version) and pnpm 12.10.1:

```sh
npm install --global pnpm@12.10.1
pnpm install --frozen-lockfile
pnpm dev
```

Vite prints the local development URL, normally http://localhost:5173. The supported runtime is Node 24.15.0 or later within the Node 24 line; CI uses the pinned current LTS patch. No environment variables or provider account are required for this shell.

## Commands

| Command | Purpose |
| --- | --- |
| pnpm dev | Start the web app with hot reload and route generation |
| pnpm check | Lint/format check, type checks, tests and production build |
| pnpm lint | Check formatting, imports and lint with Biome |
| pnpm format | Format source and configuration |
| pnpm typecheck | Type-check workspace packages, browser code, config and tests |
| pnpm test | Run behaviour tests once |
| pnpm test:watch | Watch web tests |
| pnpm build | Generate routes and build apps/web/dist |
| pnpm preview | Serve the production build locally |

## Repository layout

```text
apps/web/                  React SPA, routing, query state and Tailwind
packages/oems/             Pinned upstream provenance and future OEMS integration
packages/adapters/         Reserved server-side provider boundary (documentation only)
packages/typescript-config/ Shared strict TypeScript configurations
docs/                      Architecture and recorded decisions
.github/workflows/         CI checks and production artifact
```

Read [AGENTS.md](AGENTS.md), [architecture](docs/architecture.md), [stack decision](docs/decisions/0001-typescript-workspace.md) and [contribution guide](CONTRIBUTING.md). Scoped agent instructions describe the web and integration boundaries.

## Agentic development

Codex and Claude project specialists share [team guidance](docs/agents/team.md), [role briefs](docs/agents/roles/coordinator.md), a [task/handoff template](docs/agents/task-template.md), and the [planned first milestone](docs/agents/first-milestone.md). Agent setup does not implement the backend or start a persistent swarm.

## OEMS and licensing

The OEMS revision is explicitly pinned in packages/oems/src/index.ts. This metadata is not a schema validator or conformance claim. Do not duplicate metric semantics in application code.

Clio's licence has not been selected. Public visibility does not grant an open licence; workspace packages are private and marked UNLICENSED. OEMS is separately licensed under Apache 2.0.
