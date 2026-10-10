# Clio architecture

## Current boundary

The browser application is a client-side React SPA; a separate local Node 24 API owns PostgreSQL persistence. Vite builds it; TanStack Router owns file-based navigation and TanStack Query owns remote/server-state caching when data is introduced. Tailwind supplies styling. Biome owns linting, import organisation and formatting. Vitest and Testing Library check browser behaviour in jsdom.

The workspace has these boundaries:

- apps/web: presentation and user interaction. Routes are thin composition points. Identity/session and workspace flows live in src/features; shared UI stays in src/components, foundational client utilities in src/lib.
- apps/api: server-only Fastify JSON HTTP transport, explicit SQL migrations and node-postgres repositories for workspaces and scoped services. Native Node TypeScript runs the API; there is no separate server build pipeline. Better Auth owns GitHub login and PostgreSQL sessions; Clio owns transactional workspace membership, service authorization and member invitations. The auth transport exposes only login, callback and logout; /api/me returns safe identity.
- packages/oems: platform-neutral integration with the pinned standard. Implements pinned local schema checks, separate semantic validation, immutable validated snapshots and all five per-service calculations. Bigint microsecond timestamps preserve ordering; nulls and provisional quality retain missing evidence. Runtime supports native Node 24 and browser bundling; normative changes still belong upstream.
- packages/adapters: server-only GitHub App token/full-backfill helpers, supplied Argo CD operation normalization and pure deployment evidence reconciliation through the pinned OEMS validator. Configurable mock demo and fictional fixtures establish behavior; mock-only setting APIs/UI consume this foundation; no live Argo client or notification receiver exists. Separate mock-only API jobs persist fictional snapshots/results, with no live provider access.
- packages/typescript-config: shared strict compiler defaults; no runtime code.

Internal TypeScript packages expose source to the workspace bundler and have no separate publishing/build pipeline. All packages are private. Introduce distributable builds only when there is a real external consumer.

## Evidence flow to implement next

Provider collection on a trusted server -> reconciled evidence snapshot -> pinned OEMS validation/calculation -> result API -> TanStack Query -> UI.

Do not skip the validation/quality boundary or send provider credentials to the browser. The result must retain service, window, cutoff, version and provisional-quality information. Query clients must be scoped to an application/workspace/request rather than a cross-user global cache. Browser identity checks hide private workspace UI, cancel queries and clear caches on mount/focus identity changes and visibility transitions. Identity revisions and workspace scope guard late query and mutation results. Workspace selection and invitation tokens remain in memory, never browser storage.

PostgreSQL workspace/service persistence and transactional, checksummed migrations are implemented for local development. ADR 0004 selects Fastify and node-postgres; Docker Compose binds PostgreSQL 17 to loopback. API startup does not migrate. Readiness requires database connectivity, current migration history and expected table columns. Internal repositories require workspace IDs; callers must establish membership before using them. Better Auth with GitHub login, PostgreSQL-backed sessions, and workspace membership is selected in ADR 0003; the server integration is implemented with cookie caching and implicit account linking disabled. ADR 0005 records owner/member policy and hashed invitations. Login OAuth tokens are discarded after identity retrieval. ADR 0007 selects a separate local PostgreSQL-backed mock worker with leased claims and bounded retries. Deployment hosting and live collection scheduling remain undecided.

## Frontend operational requirements

The app is a SPA, so production hosting must serve index.html for navigable application paths such as /settings, while serving assets normally. Client error/unknown-route states are present. No external fonts, telemetry or credentials are loaded by the shell.

VITE_ values are public configuration. Keep browser/server TypeScript environments separate. The generated route tree is committed and ignored by the formatter; CI rebuilds and checks it remains in sync.

## Current limitations

The UI honestly displays unconnected/empty states. GitHub login/logout, workspace/service workflows and manually shared invitations are connected. It has no live measurements, collectors or conformance designation. The API has protected workspace/service routes, GitHub sessions, membership/invitation authorization and mock-only run/results APIs. OEMS validation/calculation is tested against pinned synthetic fixtures. ADR 0006 separates deployment sources from repository/change sources and selects configurable mocked evidence now. The adapter foundation preserves observation/cutoff identity, explicit rollout correlation and unknown classifications; all initial coverage flags remain false. Per-service mock settings persist in immutable PostgreSQL revisions with owner-only optimistic saves. Members read and request ephemeral fictional previews through the authorized API; OEMS validation/calculation runs server-side after storage transactions release. Browser preview states retain explicit mock labels and incomplete coverage. Owners can enqueue fictional collection against a pinned mapping; members read bounded run history and safe stored results. The separate local mock worker claims PostgreSQL leases, fences stale workers, and atomically saves an immutable evidence/OEMS/result snapshot on success. Public result fields retain the fixed sample window, observation cutoff, OEMS revision and false coverage flags. Raw evidence and lease tokens stay server-side. Live source scope/authorization, provider checkpoints and real results APIs remain future slices. No real provider evidence exists yet.
