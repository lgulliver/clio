# ADR 0007 Durable mock collection runs

Status: selected for the bounded local mock slice
Date: 2026-10-10
Maintainer: Liam Gulliver

## Context and decision

Saved service mappings and ephemeral previews now exist. Liam authorized continuing with durable mock collection runs and stored evidence snapshots. The coordinator selects a PostgreSQL-backed queue and separate native Node worker for this local slice, using the existing database and runtime. This does not select hosted scheduling, production exposure policy or live provider authentication.

An owner enqueues a fictional collection against the current immutable mapping revision with a client-generated request UUID. Idempotent replay returns the existing scoped run; reusing the request ID for another revision conflicts. Only one active run per service is permitted. Members can read run history and stored public results, but cannot enqueue. Session and membership checks remain transactional; cookies and exact Origin remain the HTTP authorization boundary.

Each run pins mapping revision, observation, service identity/name and mock provider. A later setting change cannot rewrite that input or its output. The worker claims jobs atomically with PostgreSQL row locks and SKIP LOCKED, uses expiring leases and random fencing tokens, bounds attempts and retry delays, and computes fictional evidence outside transactions. An expired lease can be reclaimed; its prior token cannot complete or fail the reclaimed run. Completion inserts one immutable snapshot and marks success atomically.

Snapshots retain normalized fictional evidence, validated OEMS dataset, calculated metrics, public result, explicit pinned OEMS revision and SHA-256 content digest. Only safe result fields reach the browser. The initial sample uses the existing fixed January 1–3, 2026 reporting window and incomplete collection/history/recovery flags. Storage demonstrates reproducibility across restart; it does not establish live provider coverage or conformance.

Use `pnpm worker:mock` for local polling and `pnpm worker:mock --once` to process at most one eligible run. Worker startup checks existing migrations and never applies them. No OAuth credentials are required by the worker. API startup does not start a worker implicitly. Local manual start is the selected scheduling mechanism for this slice.

## Consequences and limits

No queue library, Redis, hosted worker service or live source connection is introduced. Manual local operation is sufficient for testing durability, claims, retries and cutoffs. Mock-only consent cannot authorize real production exposure. Failed runs expose a generic failure code, not provider or database details. Completed inputs and snapshots remain immutable.

Retention, erasure, user-account deletion, hosted worker supervision, live credential storage/revocation, provider checkpoints and source history reconciliation remain separate choices. Snapshot and actor foreign keys intentionally preserve audit identity; do not promise account deletion before defining its policy. Optional Argo CD in a Docker-hosted Kind cluster is a separate source sandbox; it is not a Clio connection or production deployment.

Read [the run contract](../providers/mock-collection-contract.md) and [getting started](../getting-started.md).
