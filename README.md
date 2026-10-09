# Clio

Clio is an engineering-delivery application built around traceable evidence and the [Open Engineering Metrics Standard](https://github.com/lgulliver/oems).

Status: local backend foundation and browser shell. PostgreSQL workspace/service persistence, explicit migrations and health/readiness are implemented. Pinned OEMS snapshot validation and all five fixture-backed metric calculations are implemented. GitHub authentication, PostgreSQL sessions and workspace authorization are implemented in the API; browser login remains unconnected. Provider collection is not implemented. Liam Gulliver is the sole maintainer.

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
| pnpm dev:api | Start the local API with native Node TypeScript |
| pnpm db:up | Start local PostgreSQL through Docker Compose |
| pnpm db:migrate | Apply database migrations explicitly |
| pnpm test:integration | Check persistence against PostgreSQL (CLIO_TEST_DATABASE_URL required) |
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
apps/api/                  Local API, GitHub sessions, workspace authorization and persistence
packages/oems/             Pinned schemas, snapshot validation and five metric calculations
packages/adapters/         Reserved server-side provider boundary (documentation only)
packages/typescript-config/ Shared strict TypeScript configurations
docs/                      Architecture and recorded decisions
.github/workflows/         CI checks and production artifact
```

For PostgreSQL and API setup, read [apps/api/README.md](apps/api/README.md). API configuration is server-only; the browser remains an unconnected shell. CI runs the ordinary checks plus real PostgreSQL integration tests.

Read [AGENTS.md](AGENTS.md), [architecture](docs/architecture.md), [stack decision](docs/decisions/0001-typescript-workspace.md) and [contribution guide](CONTRIBUTING.md). Scoped agent instructions describe the web and integration boundaries.

## Agentic development

Codex and Claude project specialists share [team guidance](docs/agents/team.md), [role briefs](docs/agents/roles/), a [task/handoff template](docs/agents/task-template.md), and the [planned first milestone](docs/agents/first-milestone.md). Agent definitions do not start a persistent swarm. Backend foundation implementation is recorded separately in ADR 0004.

## OEMS and licensing

The OEMS revision is explicitly pinned in packages/oems/src/index.ts. The package validates reconciled snapshots and calculates all five metrics against the pinned fixtures; read [its API and limits](packages/oems/README.md). Fixture parity does not establish a conformance designation or prove provider coverage. Do not duplicate metric semantics in application code.

Clio's licence has not been selected. Public visibility does not grant an open licence; workspace packages are private and marked UNLICENSED. OEMS is separately licensed under Apache 2.0.
