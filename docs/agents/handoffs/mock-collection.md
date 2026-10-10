# Durable mock collection and source onboarding

Status: complete; integrated from base `ce5fd7abe3ac37c2b59213eaaeabb8b3770e051e`.

## Behavior and boundaries

Owners enqueue service-scoped fictional runs against saved mapping revisions with idempotent request UUIDs. Members read the latest 25 runs and historical safe results. Current database sessions, membership, exact Origin and service scope are revalidated through the existing identity boundary. Later settings edits cannot rewrite captured inputs or stored results.

Migration 0004 adds PostgreSQL queue and immutable snapshots. A separate native Node mock worker uses database-clock leases, random fencing tokens, SKIP LOCKED and at most three attempts. Snapshot insertion and successful completion are atomic. Snapshots retain fictional normalized evidence, validated OEMS data, all calculated metric records, exact OEMS revision and deterministic SHA-256 independent of JSONB key ordering. Browser responses expose only safe stored preview fields. All terminal paths use one statement timestamp; server/browser parsers preserve microsecond ordering.

Browser Settings adds owner queueing, member history, replay after uncertain responses, bounded polling, explicit mock/incomplete coverage and stale-scope cancellation. No overview metrics are populated. New getting-started guide covers database, identity OAuth, mock sources, separate worker, restarts and troubleshooting. Optional Argo guide uses named Kind sandbox, isolated kubeconfig, loopback access and verified released pins: Kind v0.33.0, Kubernetes v1.36.4 digest, Argo CD v3.5.4 and pinned public guestbook revision. No cluster was created.

## Verification and review

- Coordinator `pnpm check`: lint, types, 339 unit tests and production build passed.
- Coordinator PostgreSQL integration: 33 tests passed in randomly generated disposable schemas; no existing data/schema/volume deletion.
- Frozen install, documentation relative links/shell syntax and whitespace passed.
- Native worker `--once` forwarding passed; continuous worker remained alive and exited cleanly on SIGTERM.
- Real authenticated local browser queued Argo mock revision 2, worker completed it, and saved result survived reload. API readiness passed after explicit migration and restart. API/web/continuous mock worker remain running locally.
- Codex specialists wrote isolated API/web/documentation slices. Sandbox dependency-store/socket restrictions blocked some specialist checks; coordinator reran integrated checks unrestricted. A PostgreSQL test initially selected the wrong transport actor; corrected fixture and full database suite passed.
- Independent read-only Claude review inspected frozen diff and actual files. Timestamp ordering concern fixed with shared statement timestamps and microsecond regression assertions. Worker database-error exit and one-run exhausted-lease behavior documented; Argo umask scoped to subshell. Final review: ready to commit, no regressions. Reported runtime/tests remain coordinator evidence.

## Limits and next boundary

Everything collected here is fictional, with fixed January 1–3, 2026 sample window and false collection/history/recovery coverage. OEMS pin remains `5908bb12cdf24e7528088237dff9dca4c10ff45f`. No live connection, provider credentials, Argo notification receiver/client, real history checkpoints, hosted worker supervision, production deployment or conformance designation exists. A transient database error exits the worker; local operator restarts it after readiness recovers. Retention/account-erasure and hosted scheduling need separate choices.

Argo guide release manifest, supported Kubernetes matrix, Kind digest and guestbook manifest were fetched/verified against official sources. Kind/kubectl are absent locally; installation and workload sync remain untested. Setting up that sandbox does not connect Clio. Next live slice must establish authenticated source scope/credential lifecycle and durable receipt before using real evidence.

Ignored `.agent-runs` contains task briefs, reviews, check logs, hashes and browser proof. Retained specialist worktrees predate coordinator fixes; main is authoritative.
