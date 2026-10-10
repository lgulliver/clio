# Continuous Argo Capture Implementation Plan

**Goal:** Continuously retain one explicitly scoped Application's actual observations while Clio delivery is unavailable, with durable cursors and explicit missing periods.
**Architecture:** Kubernetes list/watch through explicitly configured kubectl feeds existing source journal. Separate capture/sender ownership and short storage transactions preserve concurrent ingestion and replay. No OEMS semantic or API schema change.
**Tech Stack:** Node24, strict TypeScript, pnpm12.10.1, existing journal/adapters, Vitest/PostgreSQL, pinned Argo3.5.4 sandbox.
**Spec:** docs/superpowers/specs/2026-10-10-continuous-argo-capture-design.md
**Execution:** Committed coordinator workflow, isolated Codex writer worktrees and opposite-engine Claude review. Existing maintainer execution authorization applies; no additional process confirmation.

## Global constraints

OEMS5908bb12cdf24e7528088237dff9dca4c10ff45f unchanged; all coverage false. No new dependencies, migrations, services, hosting or credential generation. Owner-only outside-Git private files; explicit Kubernetes context and immutable exact scope.5000records/8MiB journal ceilings; capture documents512KiB; list15s/watch30s/client35s. Bounded attempts/backoff and no storage lock across network/wait.

## Review focus

Capture must survive a receiver stall. Cursor durability follows evidence durability, not merely HTTP receipt. Restart/410/relist must not manufacture history or continuous coverage. Metadata/health changes must remain distinct while bookkeeping churn deduplicates. Shutdown, malformed/oversize events, scope drift and full storage must stop visibly.

### Task1: Concurrent journal writer/sender safety

Ownership: infra/argocd/journal/** and apps/api/tests/argo-journal-producer.test.ts. No watcher/docs/root edits.

- [x] Add RED meaningful tests: capture during blocked sender, two sender exclusion, fresh-state acknowledgement, dedup after checkpoint crash, independent named-lock recovery.
- [x] Add named crash-safe locks (`journal` default, `sender`, `capture`) and separate atomic capture checkpoint filename; preserve default API and old files.
- [x] Refactor drain into short writer transactions with network/backoff outside lock; verify exact pending body/index before acknowledgement, retain cooldown and crash replay semantics.
- [x] Add opt-in deduplicate to captureJournal; exact existing projected notification reuses durable entry, default behavior unchanged.
- [x] Run focused tests, typecheck and publish uncommitted handoff. Coordinator verifies actual HTTP/concurrency.

### Task2: Scoped list/watch collector

Ownership: infra/argocd/capture/**, apps/api/tests/argo-continuous-capture.test.ts. Dependency: Task1 shared interface below. No journal/root/API implementation edits.

- [x] Write RED tests for unknown input config, bounded JSON streaming, explicit kubectl argv/no shell, cursor order, restart/disconnect/410, duplicates, drift, shutdown and receiver outage.
- [x] Implement private config/scope parsing, bounded subprocess transport, fixed capture checkpoint and one capture owner. Project actual source observations and maintain conservative seals.
- [x] Run bounded background delivery independently from acquisition. Expose redacted progress/status/errors without payloads or credentials.
- [x] Verify CLI startup plus fake controlled transport, typecheck, handoff exact limitations. Coordinator executes real dedicated Kind read/watch proof.

Shared interfaces: `locked(directory,work,kind?:'journal'|'sender'|'capture')`; `atomicState(directory,value,file?:'state.json'|'capture-state.json')`; `captureJournal(directory,{input,format,evidenceRef,deduplicate?:boolean})` returns original/new ArchiveEntry. `statusJournal` unchanged shape includes startupAt/latest sealed interval. `sealJournal` and `drainJournal` preserve signatures. Task2 reads private capture-state.json itself, writes only through atomicState(file). No nested journal writer lock around public journal functions. Loader and protocol remain immutable.

### Task3: Integration, real proof and delivery

Coordinator ownership: root manifests/docs and additional API integration tests. Other writers isolated.

- [x] Register pnpm argo:capture command and compile new code through existing API test imports.
- [x] Document real least-privilege setup and fixed name watch, missed-period semantics, runtime trust, capacity and graceful shutdown.
- [x] Run meaningful PostgreSQL combined capture/outage/replay proof and controlled actual local Application list/watch observation, without changing unrelated credentials/resources.
- [x] Run pnpm check, real PostgreSQL suite and git diff --check. Review actual combined diff with Claude, fix findings, repeat affected/required checks.
- [x] Prepare verified Conventional Commit and authorized main delivery. Commit, push and CI outcome are tracked in the final delivery report with remaining deployment-history/recovery coverage limits.

## Coordinator verification

Specialist sandboxes blocked private journal fixture setup (`/tmp/.git`, read-only `/var/tmp`); safeguards stayed unchanged. Coordinator ran behavior checks on an owner-controlled private TMPDIR. Final `pnpm check` passed 845 unit/component tests (OEMS116, adapters267, web328, API134), strict typecheck, lint and build. PostgreSQL suite passed137, including a real stalled loopback receiver, subsequent authenticated archive replay and immutable earlier snapshot. Final forced shutdown/concurrent journal-corruption regression also passed after strengthening its injected clock to reach the cancelled transaction.

Actual dedicated Kind list/watch observed current Application plus one temporary annotation event, retained one projected entry, persisted opaque cursor and kept two records pending during deliberate receiver outage (one entry, one seal). Annotation was removed; existing workload/grants/subscriptions stayed intact. This is scoped acquisition proof, separate from controlled PostgreSQL transport fixtures and production installation. Coverage flags remain false.

## Independent review corrections

Claude identified idle and outage seal growth, history-wide A/B/A deduplication, writer contention and receiver-derived failure paths that stopped acquisition. Final corrections persist bounded/coalesced rollover gaps and seal hourly across all reconnect outcomes, conservatively union overflow beyond32 distinct gaps, and force only explicit collector restart. Deduplication compares latest entry. Capture retries writer contention with cancellation; sender caches cooldown/idle generation, separates credential faults from journal corruption, bounds Retry-After at24h, falls back for malformed values, and ignores discarded-response-body cancellation errors. Valid transient Kubernetes Status failures reconnect; restart relists instead of reusing previous process resourceVersion.

Meaningful regressions cover125 quiet rollovers,200 failed list/watch cycles,35 bookmarks with conservative gap union,3-second writer contention, three private credential rotation faults, A/B/A, response cancellation, malformed/long retry headers, startup cancellation, and simultaneous shutdown/fatal journal corruption. Writer-contention fixture now owns a separate sender lease before scheduling its manual writer, eliminating its test-only acquisition race. Sender fatal errors take precedence over normal requested acquisition shutdown. Receiver401/403 pauses delivery until corrected credentials and restart; acquisition remains independent.

Opposite-engine review used read-only Claude source inspection; tests and actual Kind proof are coordinator evidence. Final bounded review found no material defects. Main delivery and CI outcome are recorded in the delivery report. Deployment population, application-source change linkage, and failure/restoration evidence remain separate work; no OEMS completeness promotion.
