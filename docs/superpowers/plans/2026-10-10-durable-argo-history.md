# Durable Argo History Implementation Plan

> **For agentic workers:** Use the committed Clio coordinator/specialist workflow to implement these tasks. The maintainer instructed continuous execution without another process-confirmation stop.

**Goal:** Recover original Argo observations after receiver outages through a bounded durable source journal and distinct historical import.

**Architecture:** Separate strict archive envelopes from native evidence eligibility. Store journal checkpoints, authority lineage and reporting diagnostics transactionally; existing snapshot jobs retain their leases and no-network behavior. Independent archive credentials never authorize consumer exposure or complete metric coverage.

**Tech Stack:** Node 24, TypeScript, Fastify, PostgreSQL, React, Vitest, pnpm.

**Spec:** ../specs/2026-10-10-durable-argo-history-design.md

## Global Constraints

- OEMS revision `5908bb12cdf24e7528088237dff9dca4c10ff45f` unchanged; all three coverage flags remain false.
- Existing ten-minute live terminal observation horizon unchanged.
- Shared source-lifetime ceilings: 5000 retained rows and 8 MiB; archive transport 64 KiB.
- Archive pacing at most 15 requests/minute, burst two, retaining two shared ingress tokens.
- Private grants outside Git, owner-only; no browser credentials, new dependencies or arbitrary outbound provider URL.
- Isolate concurrent writers; coordinator integrates owned paths and Claude independently reviews.

## Review Focus

- Receiver outage and lost acknowledgement must resume the exact retained entry, not fabricate another operation.
- Unsupported native payload must retain a gap and advance a valid archive prefix, without bypassing operation locks.
- Archive/live arrival order, rotation and revocation must not backdate or relabel authority.
- Empty or delayed seals must not contradict already accepted entries or certify earlier startup history.
- Torn files, competing writers, full budgets and proxy/endpoint errors must stop visibly without pruning evidence.

### Task 1: Strict archive adapter

**Files:** packages/adapters/src/argo-archive.ts; src/index.ts; tests/argo-archive.test.ts.

**Interfaces:** Export ArchiveEntry/ArchiveSeal/ArchiveRecord, parseArchiveRecord(unknown), archiveRecordDigest(unknown), parseHistoricalArgoNotification(input,scope,capturedAt,receivedAt).

- [x] Write failing tests for strict digest/keys/size/sequence/seal parsing and delayed delivery with current normalized observation time.
- [x] Run `pnpm --filter @clio/adapters test -- argo-archive`; observe failure before implementation.
- [x] Implement sorted canonical envelopes, bounded parsing and separate capture/receiver clocks. Preserve existing native kinds and gaps.
- [x] Run adapter tests and typecheck; publish exact export handoff for dependent writers.

```ts
const parsed = parseHistoricalArgoNotification(notification, scope, capturedAt, receivedAt);
expect(parsed.kind).toBe('operation');
if (parsed.kind === 'operation') {
  expect(parsed.evidence.deployments[0]?.observedAt).toBe(receivedAt);
}
```

### Task 2: Authenticated immutable archive storage and capture

**Files:** apps/api/migrations/0010_argo_archives.sql; features/argo-collection/archive-*.ts; config.ts; ingress.ts; repository.ts; input.ts; worker.ts; capture.ts; result.ts; server.ts; identity config; database readiness; tests/argo-archive*.ts.

**Interfaces:** Consume Task1 exports. Public source archiveProducers, connection archiveProducer and optional archiveSummary use producerId/journalId/policyReference plus bounded capture/sequence/gap diagnostics. Private ARGO_ARCHIVE_GRANTS_FILE binds exact scope and independent capability.

- [x] Write real PostgreSQL regressions for outage replay, bad payload advancing prefix, strict envelopes, duplicate delivery orders, current grant fences, native/archive rotations and immutable old snapshots.
- [x] Add append-only migration0010; keep notification identity index and source lock order unchanged.
- [x] Implement early-auth archive route, unique cross-capability credentials, fixed checkpoints, transactional admission and explicit gap outcomes.
- [x] Preserve original native receipt reuse and separately timed authority lineage; first live arrival after archive must independently pass live horizon.
- [x] Add atomic archive/shared quota reservations, full byte/row/headroom accounting and bounded safe diagnostics. Check delayed/empty seals against next already accepted entry.
- [x] Integrate archive-selected connections, snapshot eligibility and optional backward-compatible result fields.
- [x] Run API unit tests plus integration tests using CLIO_TEST_DATABASE_URL and disposable test schemas only.

```ts
expect(await submitArchive(entry)).toMatchObject({statusCode: 202});
expect(await submitArchive(entry)).toMatchObject({statusCode: 202});
expect((await archiveCheckpoint()).lastSequence).toBe(1);
expect((await capturedSnapshot()).collection_complete).toBe(false);
```

### Task 3: Durable local journal producer

**Files:** infra/argocd/journal/**; apps/api/tests/argo-journal-producer.test.ts.

**Interfaces:** Consume Task1 envelope exports; send one entry/seal per request to `/api/argo/sources/:sourceId/archives/:producerId`. Credentials loaded from private token files; no dependency on API internals.

- [x] Write filesystem/HTTP tests for exclusive writers, torn files, write-before-checkpoint recovery, size/capacity limits, lost acknowledgement and bounded throttled retries.
- [x] Implement init/append/capture/seal/drain/status commands with owner-only directories, exclusive lock, file/directory fsync and immutable digest-chain entries.
- [x] Keep fixture capture clearly fictional; optional actual Application capture must preserve original identity and unsupported outcomes. Never reconstruct status.history.
- [x] Persist acknowledgements atomically; leave entries after success; enforce finite request/attempt budgets and Retry-After.
- [x] Run producer tests through API Vitest runner and verify TypeScript CLI startup/help.

```ts
await appendJournal(entry);
await drainJournal({maxAttempts: 1});
expect(await retainedEntryCount()).toBe(1);
await drainJournal({maxAttempts: 1});
expect(await acknowledgedSequence()).toBe(1);
```

### Task 4: Safe browser workflow, operator guide and integration

**Files:** apps/web/src/features/argo-collection/**; overview result presentation; docs/providers/argo-history.md; getting-started/connection/rate-limit guides; root README and package scripts.

**Interfaces:** Consume optional public archive producer/summary fields from Task2. Older records without them retain unknown archive state.

- [x] Write browser tests for owner archive selection, member read-only diagnostics, missing/omitted intervals and old result compatibility.
- [x] Implement strict browser DTO parsing and accessible source selection/reporting bounds. Keep reporting window, cutoff and sealed capture interval visibly distinct.
- [x] Document fictional and real source setup, producer trust/capture obligations, finite capacity, outage recovery, rotation limits and pre-journal gaps.
- [x] Integrate owned patches. Run `pnpm check`, `git diff --check`, real PostgreSQL integrations and local controlled outage proof.
- [x] Supply actual diff, base and verification evidence to independent Claude reviewer; fix material findings and recheck affected behavior.
- [x] Prepare verified Conventional Commit and authorized main delivery. Report changed behavior, checks and remaining coverage limits.

```ts
expect(screen.getByText(/Sealed capture interval/)).toBeVisible();
expect(screen.getByText(/Coverage remains incomplete/)).toBeVisible();
```

Execution tracking lives in ignored .agent-runs/durable-archive/progress.md. Checkboxes are updated from verified implementation evidence, not dispatch status.

Verification: `pnpm check` passed (796 unit/component tests, strict type checks, lint and production build). Real PostgreSQL suite passed 136 tests across nine files using disposable random schemas. The 29 archive regressions include persisted journal outage replay, lost committed acknowledgement, scope rebinding rejection and old snapshot immutability. Actual loopback HTTP producer tests passed. Independent Claude review identified incompatible Unicode admission and rotation/clock diagnostics. Coordinator fixes added envelope Unicode rejection, ordered seal interruptions, temporal gap reasons, explicit lifetime-journal labels, scope-pinned connection selection and serialized interruption-summary budget reservation. Follow-up review and delivery are tracked below when complete.

Independent Claude follow-up review found no remaining material defect. Delivery uses the maintainer's existing main-push authorization; CI status is checked after push rather than claimed from local tests. The 22 journal tests include actual loopback HTTP delivery, filesystem durability and incompatible Unicode rejection.
