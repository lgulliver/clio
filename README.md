# Clio

Clio is an engineering-delivery application built around traceable evidence and the [Open Engineering Metrics Standard](https://github.com/lgulliver/oems).

Status: the scoped local MVP is implemented and verified. Clio provides GitHub sign-in, PostgreSQL sessions, workspace/service management, manual invitations and owner access controls. Separate GitHub Deployments, native Argo CD and fictional mock collectors retain immutable results through durable workers. Settings and Overview show all five pinned OEMS metrics, quality reasons, coverage and bounded saved-result history.

Independent service-scoped population, change/history, classification and recovery evidence can produce a new immutable measurement from an exact successful GitHub or Argo collection. Private producer grants and reports stay server-side. Owners select received evidence and queue measurements; members read saved results. Missing evidence produces partial results, never invented zeroes or complete coverage. Native collection results remain unchanged. Real source access and independently supported producer evidence require deliberate operator configuration. Hosting, automatic scheduling and hosted credential storage remain undecided. Liam Gulliver is the sole maintainer.

## Quick start

Use [Engineering drill-down](docs/engineering-drilldown.md) to organize teams, products and services, then compare saved service metrics within each scope.

Read [getting started and connecting data sources](docs/getting-started.md) for the full database, login, mock collection and source setup workflow. Use [real-source preparation and access checks](docs/providers/real-sources.md) for GitHub App registration and scoped Argo access; use [local live GitHub connection](docs/providers/connect-github.md) to configure private operator grants and collect GitHub Deployments. Use [connecting Argo CD](docs/providers/connect-argocd.md) for explicit Application scope, operation info, notification authentication and immutable results. Use [independent measurement evidence](docs/providers/connect-measurement-evidence.md) to configure private producer capabilities and save evidence-backed measurements. An [optional Argo CD sandbox](docs/providers/local-argocd.md) uses Kubernetes in Docker through Kind; it remains separate from Clio's mock mode.

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
| pnpm worker:argo | Process eligible native Argo snapshot jobs from previously accepted receipts |
| pnpm worker:github | Process eligible live GitHub collection jobs (private operator configuration required) |
| pnpm worker:measurement | Process queued independent measurements against saved native collections |
| pnpm worker:measurement --once | Process at most one eligible measurement job, then exit |
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

For saved mock settings, sign in, select a workspace and service in Settings, then configure the deployment source. Previews and durable runs use fictional evidence. Overview displays stored mock results separately from live GitHub and Argo results; it never combines their counts. Read [the mapping contract](docs/providers/mapping-contract.md) and [durable run contract](docs/providers/mock-collection-contract.md).

For mocked provider evidence, run `pnpm demo:providers` and read [the configurable demo](docs/providers/mock-demo.md). It performs no network requests and needs no provider credentials.

For PostgreSQL and API setup, read [apps/api/README.md](apps/api/README.md). API configuration is server-only; the browser consumes the authenticated API. CI runs the ordinary checks plus real PostgreSQL integration tests.

Read [AGENTS.md](AGENTS.md), [architecture](docs/architecture.md), [stack decision](docs/decisions/0001-typescript-workspace.md) and [contribution guide](CONTRIBUTING.md). Scoped agent instructions describe the web and integration boundaries.

## Agentic development

Codex and Claude project specialists share [team guidance](docs/agents/team.md), [role briefs](docs/agents/roles/), a [task/handoff template](docs/agents/task-template.md), and the [planned first milestone](docs/agents/first-milestone.md). Agent definitions do not start a persistent swarm. Backend foundation implementation is recorded separately in ADR 0004.

## OEMS and licensing

The OEMS revision is explicitly pinned in packages/oems/src/contract.ts. The package validates reconciled snapshots and calculates all five metrics against the pinned fixtures; read [its API and limits](packages/oems/README.md). Fixture parity does not establish a conformance designation or prove provider coverage. The [local MVP acceptance scope](docs/agents/feature-completion.md) records the verified local acceptance scope and operator-dependent limits; local feature completion does not imply hosted production readiness or complete live coverage. Do not duplicate metric semantics in application code.

Clio's licence has not been selected. Public visibility does not grant an open licence; workspace packages are private and marked UNLICENSED. OEMS is separately licensed under Apache 2.0.

Independent Argo consumer exposure and application build provenance use separately scoped producer grants, authenticated ingress, immutable storage and exact cutoff joins. Verification currently uses fictional producers; configure real sources through the [operator guide](docs/providers/argo-enrichment.md). Native health alone leaves production exposure unknown, and metric coverage remains incomplete.

Durable [Argo source journals](docs/providers/argo-history.md) retain original observations before delivery and support bounded outage replay through independently authorized historical import. Settings and Overview show sealed capture bounds separately from reporting windows and evidence cutoffs. Run `pnpm argo:journal help` for the local operator CLI. Use [continuous scoped capture](docs/providers/argo-continuous-capture.md) and `pnpm argo:capture --config /absolute/private/capture.json` to watch one explicitly bound Application with conservative missing periods. Operators supply private Kubernetes access, persistent storage and process supervision; replay does not establish complete coverage.

Argo results now include a saved [coverage evidence assessment](docs/providers/argo-coverage.md), shown in Settings and Overview. It separates reporting-window exposure from retained history, missing application change links and unknown failure/rework classifications. Assessments do not certify population or recovery completeness; older results remain readable without one.
