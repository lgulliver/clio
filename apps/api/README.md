# Clio API foundation

Local Node 24 TypeScript server with Fastify, node-postgres and PostgreSQL 17. Compose and CI use the same digest-pinned image. Native Node TypeScript execution needs no separate build. This package implements persistence and health checks only; it has no authentication, workspace HTTP routes, provider credentials, collectors, jobs or OEMS calculations. Repository calls are internal and require explicit workspace IDs. They do not authorize membership; future authenticated callers must enforce that boundary.

## Local setup

From the repository root, using Node 24 LTS and pnpm 12.10.1:

```sh
pnpm install --frozen-lockfile
docker compose up -d --wait postgres
export DATABASE_URL='postgres://clio_dev:clio_dev_password@127.0.0.1:5432/clio_dev'
pnpm --filter @clio/api migrate
pnpm --filter @clio/api dev
```

The Compose credentials are fictional development values. PostgreSQL binds to loopback and uses the named `clio_postgres_dev` volume. `docker compose stop postgres` stops the database while preserving local data. Migration is explicit; API startup never applies SQL. `start` runs without watching. `HOST` defaults to `127.0.0.1`; `PORT` defaults to `3000` and must be 1–65535. `DATABASE_URL` is required server configuration. Never use a `VITE_` variable for it.

Only `GET /health/live` and `GET /health/ready` are exposed. Liveness reports process health. Readiness checks connectivity, every expected migration checksum and required table columns. Missing/unavailable database, pending or changed migrations, unknown migration history and missing schema return `503 {"status":"unavailable"}` without database errors or credentials. SIGINT/SIGTERM close the HTTP server and pool. Readiness does not prove data quality, membership or OEMS conformance.

## Persistence and migrations

`src/features/workspaces/repository.ts` creates/reads workspaces and creates/reads/lists workspace-scoped services. UUIDs and names are parsed; SQL values are parameterized. Names are trimmed using ECMAScript whitespace, count Unicode code points, and are stored in normalized form. UUIDs normalize to lowercase. Service names are case-sensitive, unique within each workspace and may recur across workspaces. Foreign keys prevent orphan services. Workspaces have UUID identity, not globally unique display names. `withTransaction(pool, async client => ...)` binds related writes to one client; construct `createRepository(client)` inside it for atomic work. No network calls belong inside these transactions.

`migrations/0001_workspaces_services.sql` is coordinator-allocated. The runner takes a transaction-scoped PostgreSQL advisory lock, applies pending SQL and ledger writes in one transaction, and records SHA-256 checksums. Rerunning unchanged migrations is idempotent. Never edit applied SQL: add a newly allocated migration. Failed SQL rolls back the entire invocation. Migration history must be an ordered prefix of this application's files; unknown/changed applied revisions fail. Migration statements have a 60-second timeout and lock waits a 10-second timeout; API queries retain their separate 5-second timeout. Invalid SQL filenames or duplicate migration numbers fail explicitly. SQL checkouts preserve LF through .gitattributes. No ORM or automatic migration on server start.

## Verification

```sh
pnpm --filter @clio/api typecheck
pnpm --filter @clio/api test
pnpm exec biome check apps/api compose.yaml
```

Integration tests require a reachable PostgreSQL database and a role allowed to create schemas. They never fall back to `DATABASE_URL` and fail visibly without `CLIO_TEST_DATABASE_URL`. Each run creates a random `clio_test_<uuid>` schema, connects with that search path, and drops only its generated schema afterward. No existing schema or volume is deleted. Interrupted tests can leave their own disposable schema behind.

For the local Compose database:

```sh
docker compose up -d --wait postgres
CLIO_TEST_DATABASE_URL='postgres://clio_dev:clio_dev_password@127.0.0.1:5432/clio_dev' pnpm --filter @clio/api test:integration
```

Real PostgreSQL tests cover migration concurrency/idempotency/checksum drift, readiness before/after migrations and schema drift, persistence and workspace isolation, uniqueness/FK/check constraints, transaction commit/rollback and failed DDL rollback. Ordinary tests mock the readiness dependency and check health behavior, redaction, shutdown and configuration parsing. Integration tests are deliberately separate from the ordinary suite. Coordinator must run them plus full `pnpm check` before integrating this foundation.
