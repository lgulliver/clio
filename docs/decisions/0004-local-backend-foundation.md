# ADR 0004 Local backend foundation

Status: selected for the local foundation; implemented
Date: 2026-10-09
Maintainer: Liam Gulliver

## Context and decision

ADR 0002 selects PostgreSQL; ADR 0003 selects Better Auth and workspace membership. The first backend slice needs a real local persistence boundary without exposing unauthenticated workspace data or deciding provider collection behavior.

Use Node 24 and TypeScript in `apps/api`, Fastify for JSON HTTP transport, and node-postgres (`pg`) for parameterized SQL and transactions. Keep migrations as numbered SQL files applied explicitly through a transactional, advisory-locked runner. Record applied migration checksums and reject modified historical migrations. A digest-pinned PostgreSQL 17 image shared by development and CI runs locally through Docker Compose with a loopback-only port and a named development volume.

Fastify fits the existing TypeScript workspace, supports in-process HTTP testing, and has a documented Better Auth integration. Direct SQL keeps transaction and database constraint behavior explicit; the small initial schema does not justify an ORM. The coordinator selected this bounded implementation stack under the project task guidance. These selections replace the corresponding proposals in the first milestone. Exact dependency versions live in the package manifest and committed lockfile.

Initial persistence includes workspaces and workspace-scoped services. Internal repository calls require an explicit workspace ID. This is a storage boundary, not user authorization: future authenticated routes must establish membership before invoking it. Only liveness and readiness endpoints are public. Readiness requires connectivity and the expected migration state; responses must not disclose connection strings or database errors.

The API binds to loopback by default. Migrations run separately from server startup. Tests use controlled health dependencies and a separate disposable PostgreSQL test database, with real checks of rollback, uniqueness and cross-workspace isolation.

## Consequences and limits

No protected workspace HTTP routes, identity tables, authentication bypass, provider credentials, collectors, job queue, immutable snapshots, results API or deployment host are introduced here. Better Auth remains the accepted identity decision and is implemented in a later slice. Durable job design remains proposed until worker requirements exist. PostgreSQL integration tests are explicit and must fail if their required database configuration is absent.

Local development credentials are fictional and must not be reused for hosting. Docker volumes remain developer-owned; test cleanup must only remove resources created by the test run.

## Sources

- https://fastify.dev/docs/latest/Reference/Server/
- https://node-postgres.com/features/transactions
- docs/decisions/0002-postgresql.md
- docs/decisions/0003-authentication.md
