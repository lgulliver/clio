# Clio architecture

## Current boundary

The initial application is a client-side React SPA. Vite builds it; TanStack Router owns file-based navigation and TanStack Query owns remote/server-state caching when data is introduced. Tailwind supplies styling. Biome owns linting, import organisation and formatting. Vitest and Testing Library check browser behaviour in jsdom.

The workspace has these boundaries:

- apps/web: presentation and user interaction. Routes are thin composition points. Feature code will live together in src/features/<feature> when implemented; shared UI stays in src/components, foundational client utilities in src/lib.
- packages/oems: platform-neutral integration with the pinned standard. Initially exposes provenance only. Future schema/semantic checks and standard result handling belong here; normative changes still belong upstream.
- packages/adapters: reserved server-side source collection/reconciliation boundary. Currently documentation only, not an implemented collector or package.
- packages/typescript-config: shared strict compiler defaults; no runtime code.

Internal TypeScript packages expose source to the workspace bundler and have no separate publishing/build pipeline. All packages are private. Introduce distributable builds only when there is a real external consumer.

## Evidence flow to implement next

Provider collection on a trusted server -> reconciled evidence snapshot -> pinned OEMS validation/calculation -> result API -> TanStack Query -> UI.

Do not skip the validation/quality boundary or send provider credentials to the browser. The result must retain service, window, cutoff, version and provisional-quality information. Query clients must be scoped to an application/workspace/request rather than a cross-user global cache.

PostgreSQL is selected for intended hosted use; local execution is the development phase. Persistence is not implemented. Better Auth with GitHub login, PostgreSQL-backed sessions, and workspace membership is selected in ADR 0003; authentication is not implemented. No backend runtime, API transport or deployment host has been selected yet. Select those against the first provider/workspace requirements rather than embed placeholders that imply a working service.

## Frontend operational requirements

The app is a SPA, so production hosting must serve index.html for navigable application paths such as /settings, while serving assets normally. Client error/unknown-route states are present. No external fonts, telemetry or credentials are loaded by the shell.

VITE_ values are public configuration. Keep browser/server TypeScript environments separate. The generated route tree is committed and ignored by the formatter; CI rebuilds and checks it remains in sync.

## Current limitations

The UI honestly displays unconnected/empty states. It has no live measurements, collectors, authentication, persistence or conformance designation. The first adapter will establish the server/service boundary and exercise real evidence against OEMS fixtures.
