# Clio

Clio is an engineering-delivery application built around traceable evidence and the [Open Engineering Metrics Standard](https://github.com/lgulliver/oems).

Status: local backend foundation and browser shell. PostgreSQL workspace/service persistence, explicit migrations and health/readiness are implemented. Pinned OEMS snapshot validation and all five fixture-backed metric calculations are implemented. GitHub authentication, PostgreSQL sessions and workspace authorization are implemented in the API; browser login, workspace/service workflows and manual invitations are connected. Server-only GitHub and Argo CD adapter foundations are tested against fictional evidence with configurable service/source mappings and pinned OEMS reconciliation. Workspace service deployment settings persist as immutable mock-only revisions. Owners configure GitHub or Argo CD plus production environment, queue durable fictional collection runs, and inspect saved snapshots through safe results. Members can read history and run clearly labelled ephemeral previews. A separate PostgreSQL-backed mock worker processes leased jobs with bounded retries. Live provider connections and credential storage are not implemented. Liam Gulliver is the sole maintainer.

## Quick start

Read [getting started and connecting data sources](docs/getting-started.md) for the full database, login, mock collection and source setup workflow. An [optional Argo CD sandbox](docs/providers/local-argocd.md) uses Kubernetes in Docker through Kind; it remains separate from Clio's mock mode.

Use Node 24 LTS (24.21.0 is pinned in .node-version) and pnpm 12.10.1:

```sh
npm install --global pnpm@12.10.1
pnpm install --frozen-lockfile
pnpm dev
```

Vite prints the local development URL, normally http://localhost:5173. The supported runtime is Node 24.15.0 or later within the Node 24 line; CI uses the pinned current LTS patch. The overview remains viewable without a provider connection. Login and workspace flows require the local API with server-only GitHub OAuth configuration; see apps/api/README.md.

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
| pnpm worker:mock | Process queued fictional collection runs (separate local worker) |
| pnpm worker:mock --once | Process at most one eligible fictional run, then exit |
| pnpm demo:providers | Run configurable fictional GitHub/Argo CD evidence through OEMS |

## Repository layout

```text
apps/web/                  React SPA, routing, query state and Tailwind
apps/api/                  Local API, GitHub sessions, workspace authorization and persistence
packages/oems/             Pinned schemas, snapshot validation and five metric calculations
packages/adapters/         Server-only GitHub/Argo CD evidence and reconciliation
packages/typescript-config/ Shared strict TypeScript configurations
docs/                      Architecture and recorded decisions
.github/workflows/         CI checks and production artifact
```

For saved mock settings, sign in, select a workspace and service in Settings, then configure the deployment source. Previews and durable runs use fictional evidence; they do not populate actual overview metrics. Read [the mapping contract](docs/providers/mapping-contract.md) and [durable run contract](docs/providers/mock-collection-contract.md).

For mocked provider evidence, run `pnpm demo:providers` and read [the configurable demo](docs/providers/mock-demo.md). It performs no network requests and needs no provider credentials.

For PostgreSQL and API setup, read [apps/api/README.md](apps/api/README.md). API configuration is server-only; the browser consumes the authenticated API. CI runs the ordinary checks plus real PostgreSQL integration tests.

Read [AGENTS.md](AGENTS.md), [architecture](docs/architecture.md), [stack decision](docs/decisions/0001-typescript-workspace.md) and [contribution guide](CONTRIBUTING.md). Scoped agent instructions describe the web and integration boundaries.

## Agentic development

Codex and Claude project specialists share [team guidance](docs/agents/team.md), [role briefs](docs/agents/roles/), a [task/handoff template](docs/agents/task-template.md), and the [planned first milestone](docs/agents/first-milestone.md). Agent definitions do not start a persistent swarm. Backend foundation implementation is recorded separately in ADR 0004.

## OEMS and licensing

The OEMS revision is explicitly pinned in packages/oems/src/contract.ts. The package validates reconciled snapshots and calculates all five metrics against the pinned fixtures; read [its API and limits](packages/oems/README.md). Fixture parity does not establish a conformance designation or prove provider coverage. Do not duplicate metric semantics in application code.

Clio's licence has not been selected. Public visibility does not grant an open licence; workspace packages are private and marked UNLICENSED. OEMS is separately licensed under Apache 2.0.
