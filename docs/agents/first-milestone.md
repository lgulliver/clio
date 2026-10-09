# First Clio milestone

Status: backend foundation, OEMS fixtures and server/browser identity foundations complete; remaining slices planned. Agent setup itself did not implement application behavior. Provider collectors are not implemented yet. All five OEMS calculations are exercised against the pinned fixtures.

Accepted: PostgreSQL; local is the development phase of a future hosted application. Clio is a personal open source project and Liam is sole maintainer. Better Auth with GitHub login, PostgreSQL sessions, and workspace membership is accepted in ADR 0003. Licence selection remains separate and pending.

Selected in ADR 0004: Node 24/TypeScript + Fastify API, node-postgres, explicit transactional SQL migrations, local PostgreSQL 17. Implemented: health/readiness, workspace/service persistence, GitHub sessions, protected membership/invitation APIs and browser workspace/service/invitation workflows. Proposed: separate worker entry point, PostgreSQL-backed jobs, GitHub-first collection. ADR 0005 selects initial owner/member and invitation policy. Collection credential storage, production evidence source and hosting need documented choices before dependent implementation. Do not treat previous suggestions about PATs or auth bypass as accepted decisions.

## Sequence

1. PostgreSQL is recorded in ADR 0002; coordinator defines first backend task, API boundaries, and workspace identity assumptions. Backend specialist builds local database/migrations, server health/readiness, and testable persistence. No hosted deployment.
2. In parallel, OEMS specialist implements pinned schema/semantic validation and calculations against upstream fixtures. This work does not need real provider credentials. Coordinator serializes shared workspace/lockfile edits.
3. Identity specialist implements accepted Better Auth/GitHub login and PostgreSQL sessions, establishing workspace access and provider credential contracts before real connections. Use a separate development OAuth application locally; test auth with controlled mocks. OAuth app registration and real credentials remain maintainer actions.
4. Provider specialist designs the first source mapping and explains what evidence can establish production exposure and metric coverage. Once selected, implement backfill, checkpoints, and reconciliation against mocks, then assigned repositories.
5. Backend integrates immutable cutoff snapshots/results; frontend adds connection/service mapping, sync status, and measurements from agreed API contracts.
6. Opposite-engine review checks each slice. Coordinator runs full checks and makes small Conventional Commits after integration.

## Initial acceptance

One explicitly selected workspace/service/provider can produce a validated snapshot and reproducible OEMS result for a closed UTC reporting window. UI exposes coverage and provisional/unavailable states. Collection gaps and later evidence cannot rewrite an earlier cutoff snapshot. Real data access requires explicitly supplied scope/credentials.

All five OEMS calculations are implemented against fixtures; initial live provider evidence may only support some metrics. Unsupported evidence remains unavailable or provisional according to the standard.
