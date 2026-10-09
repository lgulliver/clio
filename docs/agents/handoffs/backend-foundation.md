# Backend foundation handoff

Base: 502bd1423dfba2300454ab37321f17e9f8e38ab6.
Implementation: Codex backend specialist in agent/backend-foundation; coordinator integration in the main checkout.
Review: Claude, reading the actual diff and source. No medium-or-higher defects found. TCP health probe, digest parity, migration timeout and name-validation findings resolved; final review verified these fixes.

## Delivered boundary

apps/api implements native Node 24/Fastify health endpoints and internal PostgreSQL workspace/service persistence. Explicit transactional SQL migrations use advisory locking, checksums and ordered history. Health responses redact dependency failures. No workspace HTTP routes, identity tables, collectors, jobs or hosting are introduced. ADR 0004 records the scoped technical selections.

## Verification

Coordinator ran pnpm check (lint, all type checks, API/web behavior tests and browser production build), frozen-lockfile installation, git diff --check, Compose configuration validation and real PostgreSQL integration tests. The suite exercises isolation, Unicode/name constraints, duplicate/FK rejection, transaction rollback, migration races/checksums/order, failed DDL rollback and readiness/schema drift. Tests create and remove only their own random schemas. Native Node migration/start, real HTTP liveness/readiness and SIGTERM shutdown were also exercised against a disposable PostgreSQL container.

Both Compose and CI use the same inspected PostgreSQL 17 image digest. CI has a PostgreSQL service and explicit integration step; remote GitHub CI has not been run by this local task.

## Remaining work

Better Auth/GitHub login, sessions and workspace membership are selected but unimplemented. Repository IDs scope storage and do not authorize a user. Future routes must establish membership first. Provider mapping, credential storage, jobs, snapshots/results and hosting remain separate tasks. CLI startup/migration errors intentionally remain generic; more detailed safe operational diagnostics are future work. Concurrent migration runners fail after a bounded lock wait rather than waiting indefinitely.
