# Argo notification ingestion implementation plan

**Goal:** Durable authenticated Argo operation receipts and owner-requested OEMS snapshots with honest browser results and real-source onboarding.
**Architecture:** Native notification → scoped authenticated ingress → immutable receipt/gap history → leased snapshot worker → pinned OEMS → safe API → Live Argo panel.
**Tech Stack:** Node 24, TypeScript, Fastify, PostgreSQL, React/TanStack Query, pinned Argo CD 3.5.4 sandbox.
**Spec:** [Approved design](../specs/2026-10-10-argo-ingestion-design.md).
**Global Constraints:** Existing identity/GitHub/mock behaviour preserved; provider secrets server-only; migration 0006; no missing coverage converted to zero; unchanged OEMS pin; isolated CLI writers, maximum three; Claude independent review before authorized main push.
**Review Focus:** Authentication before parsing; replay after revocation; scope and fingerprint fencing; cutoff consistency under concurrent inserts/counters; controller notification loop/retry behaviour; out-of-order opaque status history.

Contract authority: [exact wire, API and integration interfaces](../../providers/live-argo-contract.md). Maintainer approved design and execution with “Approved. Go”; no additional execution authorization is needed.

### Task 1: Native parser and real producer (provider specialist)

Files: packages/adapters/src/argo-notification.ts, packages/adapters/src/index.ts, native parser tests, infra/argocd/clio-notifications.yaml. Interfaces: `parseArgoNotification`, `argoNotificationDigest`, exported scope/result/gap types from contract.

- [x] Write fixture-driven tests for two UUIDs at one SHA, immutable metadata, missing info, unknown kind, safe JSON, future/horizon gaps, native health time conjunction, source/hydrator scope and unknown keys. Example invariant: `expect(parsed.evidence.statuses[0]?.consumerExposure).toBe(false)` for native Succeeded/Healthy.
- [x] Run `pnpm --filter @clio/adapters test`; expected new parser tests fail before implementation.
- [x] Implement strict bounded parsing and canonical digest with replay identity independent of observation time; keep opaque revision semantics separate from GitHub history.
- [x] Run adapter test/typecheck; expected all pass.
- [x] Verify native template against real controller: scoped Argo API sync info/initiatedBy, custom oncePer, two same-SHA UUIDs, first response 503 then retry, settled bookkeeping without repeat loop. Explicit sandbox kubeconfig/context only. Record public evidence and limitations, never tokens.

### Task 2: Durable API and jobs (backend specialist)

Files: apps/api/src/features/argo-collection/*, apps/api/migrations/0006_argo_ingestion.sql (use actual existing migration directory), API unit/integration tests. Interfaces from contract; no shared startup edits.

- [x] Add failing integration tests using random PostgreSQL schema for owner/member/session/Origin isolation, credentials before malformed JSON, inactive/grant-drift replay rejection, immutable metadata conflict, exact first observation replay, bounds, gaps and counters, cutoff, stale lease and rollback.
- [x] Implement private config, connection revisions, receipt deduplication, minimal gaps, operation metadata conflict, source budgets and rate limit. UUID reuse conflict yields 409; unknown source/bad credential yields same 401.
- [x] Implement snapshot enqueue/history and worker with fresh connection/grant fencing. Derive exact deployment bindings under application-to-service attestation. First-arrival horizon checked only after authorized replay lookup. Record interruption gaps without fabricated deployments.
- [x] Parse stored opaque Argo evidence independently; reconcile and calculate through unchanged imported OEMS pin. Null unsupported metrics, provisional frequency, false coverage.
- [x] Run API tests/typecheck and `CLIO_TEST_DATABASE_URL=postgres://clio_dev:clio_dev_password@127.0.0.1:5432/clio_dev pnpm --filter @clio/api test:integration`; expected green, development tables untouched.

### Task 3: Live Argo browser workflow (frontend specialist)

Files: apps/web/src/features/argo-collection/*, existing settings composition. Interfaces: exact public DTOs; `ArgoCollection` component follows existing GitHub component props and identity fences.

- [x] Add tests for setup-needed, owner configuration/disconnect/date enqueue, member read-only, unknown response rejection, retained-history count labels, recorded gaps, unavailable metric labels, uncertain replay and late responses after identity/service switch.
- [x] Implement strict response parsing and scoped queries; expose granted source selection only. No credentials or endpoint form fields.
- [x] Run web tests/typecheck; expected green. Run build when route files change; never manually edit generated route tree.

### Task 4: Coordinator integration, real delivery, docs and ship

Files: API main/server/identity registration/readiness, worker-argo.ts, package scripts, docs/providers/connect-argocd.md, real-sources/getting-started/local-argocd, README, architecture, ADR 0009.

- [x] Integrate verified isolated slices one at a time; resolve each shared interface against contract.
- [x] Wire optional Argo config separately from login; separate machine ingress outside session plugin; worker startup and orderly shutdown. Update expected readiness columns without editing applied migrations.
- [x] Run `pnpm check`, actual PostgreSQL integration, `git diff --check`; expected all pass.
- [x] Supply Claude reviewer exact base, complete diff including added files, spec/contract and actual checks. Fix material findings with regression tests.
- [x] Explicitly migrate local development schema, restart API preserving OAuth/session config. Configure sandbox-only private grant/token outside Git; owner connect through authenticated UI. Native controller delivers identified operations to receiver; worker saves result; browser shows safe result and existing mock/GitHub states remain.
- [x] Document actual producer setup, source grant/UID/scope binding, token handling/rotation, trusted HTTPS, operation info automation, native unsupported gaps, storage recovery and incomplete coverage. Avoid claiming API RBAC proof from Kubernetes patch.
- [ ] Repeat relevant checks after final edits; Conventional Commit, authorized push main, exact-commit CI success, concise sitrep with runtime proof and remaining limits.

Self-review: Each approved design requirement is assigned above and exact shared names are in contract. Producer runtime and actual PostgreSQL verification are required completion evidence; a listener-only probe is insufficient.


Execution evidence: three isolated Codex writer slices integrated; Claude reviewed native producer, browser and complete integration. Material findings received regression tests and fixes: terminal/horizon delivery bounds, cached form preservation on refetch failure, valid interruption-gap counts, exact disconnect/reconnect boundaries and database-clock closure. `pnpm check` passed 602 unit tests plus typing/lint/build; actual PostgreSQL integration passed 64 tests. Migration 0006 applied to local development and readiness passed. Native controller → scoped receiver → immutable snapshot worker → signed-in browser proof passed; mock history and GitHub setup-needed state remained readable. Local public evidence and screenshot stay in ignored `.agent-runs/`; concise reproducible source setup and runtime limitations are committed in the provider guides. Shipping checkbox is completed only after exact pushed-commit CI succeeds.
