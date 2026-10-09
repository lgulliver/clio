# First Clio milestone

Status: planned; no server, authentication, persistence, collector, or calculation is implemented by the agent setup.

Accepted: PostgreSQL; local is the development phase of a future hosted application. Clio is a personal open source project and Liam is sole maintainer. Better Auth with GitHub login, PostgreSQL sessions, and workspace membership is accepted in ADR 0003. Licence selection remains separate and pending.

Proposed: Node 24/TypeScript + Fastify backend, separate API/worker entry points, PostgreSQL-backed jobs, GitHub-first collection. Credential storage, SQL tooling, production evidence source, hosting, and detailed tenancy/role policy need documented choices before dependent implementation. Do not treat previous suggestions about PATs or auth bypass as accepted decisions.

## Sequence

1. Coordinator records PostgreSQL decision and defines first backend task, API boundaries, and workspace identity assumptions. Backend specialist builds local database/migrations, server health/readiness, and testable persistence. No hosted deployment.
2. In parallel, OEMS specialist implements pinned schema/semantic validation and calculations against upstream fixtures. This work does not need real provider credentials. Coordinator serializes shared workspace/lockfile edits.
3. Identity specialist implements accepted Better Auth/GitHub login and PostgreSQL sessions, establishing workspace access and provider credential contracts before real connections. Use a separate development OAuth application locally; test auth with controlled mocks. OAuth app registration and real credentials remain maintainer actions.
4. Provider specialist designs the first source mapping and explains what evidence can establish production exposure and metric coverage. Once selected, implement backfill, checkpoints, and reconciliation against mocks, then assigned repositories.
5. Backend integrates immutable cutoff snapshots/results; frontend adds connection/service mapping, sync status, and measurements from agreed API contracts.
6. Opposite-engine review checks each slice. Coordinator runs full checks and makes small Conventional Commits after integration.

## Initial acceptance

One explicitly selected workspace/service/provider can produce a validated snapshot and reproducible OEMS result for a closed UTC reporting window. UI exposes coverage and provisional/unavailable states. Collection gaps and later evidence cannot rewrite an earlier cutoff snapshot. Real data access requires explicitly supplied scope/credentials.

Build all five OEMS calculations against fixtures; initial live provider evidence may only support some metrics. Unsupported evidence remains unavailable or provisional according to the standard.
