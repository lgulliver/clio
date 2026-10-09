# ADR 0002 PostgreSQL persistence

Status: accepted; local persistence foundation implemented
Date: 2026-10-09
Maintainer: Liam Gulliver

## Context and decision

Clio is a personal open source project intended to become a hosted web application. Local execution is the development phase, not a local-only product requirement. Use PostgreSQL in development and production, with a local Docker Compose service and versioned migrations. ADRs 0004 and 0005 record the implemented workspace/service and server identity foundations.

Store core identities, connections, evidence revisions, snapshot/result relationships, and collection checkpoints relationally. Variable provider evidence may use JSONB; that does not replace typed relational keys and constraints. Durable PostgreSQL jobs are the initial proposed queue approach, to be selected with worker requirements.

## Alternatives and consequences

SQLite would lower initial setup cost but introduce a later database migration if hosted concurrency requires PostgreSQL. Using PostgreSQL from the start exercises the intended database semantics locally. Do not build dual-database support upfront. ADR 0004 selects node-postgres and explicit SQL migrations. Core workspace/service and identity schemas exist; connections/evidence/checkpoints and jobs remain future slices. Hosting vendor, job library and operational deployment remain separate choices.
