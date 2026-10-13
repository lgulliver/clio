# SPACE GitHub Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Preserve the maintainer's committed coordinator/specialist workflow: bounded roles, isolated concurrent CLI writers, and opposite-engine review.

**Goal:** Connect explicitly selected team-owned GitHub repositories and show immutable, qualified activity, review and flow evidence alongside existing SPACE pulses.

**Architecture:** A separate PR-only GitHub App feeds a resumable server-only adapter and independent PostgreSQL jobs. Application calculations publish `clio.space.github.v1` results; Developer experience reads safe results and never imports adapters. Existing authorization transactions, shared quota implementation and identity/query fences remain authoritative.

**Tech Stack:** Existing Node 24, TypeScript, Fastify, PostgreSQL, React, TanStack Query/Router, Tailwind, Vitest and pnpm; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-13-space-github-operations-design.md` (approved 2026-10-13).

## Global Constraints

- Preserve existing deployment-only verification, pulse confidentiality and OEMS pin/semantics.
- Separate PR-only App: exact Pull requests read + Metadata read; selected repositories; reject identical deployment/SPACE App IDs.
- Private grants/keys outside Git, owner-only files; installation belongs to one workspace; capability profile enters grant fingerprint.
- One active mapping per repository/workspace, one explicit owning team; freeze original ownership/name/revision in results.
- Closed UTC calendar-day windows, end exclusive, at most 90 days; request-ID idempotency; one active job per mapping.
- Limits: 20 PR pages / 1,000 PRs, 100 review pages per PR, 10,000 reviews, 16 MiB normalized facts; response exactly 2,000,000 bytes / 10 seconds.
- Claims 120 seconds; acquisition slices at most 60 seconds / 40 requests including author re-fetch and verification; active acquisition at most 30 minutes; job lifetime at most 24 hours; three actual retryable failures.
- Reuse durable App/installation quota implementation and one request/second App pacing. Separate Apps have separate budgets; cooldown/contention/cooperative yields do not spend failure attempts.
- Person IDs transient only, including checkpoints. Re-fetch author each review claim; retain derived self/bot/known flags. Unknown actors are gaps.
- Every numeric signal stays provisional; empty cohorts display null/no observations. Three timed PRs required for duration; survey minimum remains independent.
- Repository rows stay separate; no pooled team/workspace metrics, personal rankings, product/service activity attribution, scores, notifications or scheduling.
- History pages at most 25; qualified chart points use window starts and never join across incomplete historical populations.
- Coordinator owns migration numbering, root manifests, wiring and final commits/push. Never edit applied migrations or generated routes manually.

## Review Focus

1. Actor deleted between discovery and resumed reviews: re-fetch identity, exclude unknown sample, never persist person IDs (Tasks 1–3).
2. Review time older than author re-fetch time but newer than reporting end: preserve observation context, exclude out-of-window review, never backdate a cutoff (Tasks 1–2).
3. Member role changes while setup/save finishes: backend revalidates, browser discards stale completion and clears owner-only grant choices (Tasks 4–5).
4. Mapping revoked during quota wait or worker checkpoint commit: fence every write and never revive a disconnected source through retry (Tasks 3–4).
5. Provider pagination changes or old PR merges in window: safe endpoint links, stable-ID deduplication, explicit conflicts, no creation/update-time early stop (Tasks 1–2).

## File ownership and dependency order

Coordinator: this plan/spec, `package.json`, `apps/api/package.json`, migration `0016_space_github.sql` (reserved after checking ledger), `apps/api/src/{main,server}.ts`, identity route wiring and readiness, organization deletion guard, final docs.

Provider specialist: new `packages/adapters/src/github-pulls-{contract,scope,checkpoint,pagination,collect}.ts`, adapter exports and tests. Existing deployment verifier/collector unchanged.

Backend specialist: new `apps/api/src/features/space-github/{config,input,contract,calculate,repository,jobs,provider,worker,routes}.ts`, worker entrypoint and API tests. Sequential native writes or isolated CLI worktree; no concurrent shared-file ownership.

Frontend specialist: new `apps/web/src/features/space-github/{api,operations-panel,setup-wizard,mapping-detail,result-cards,history,trends,trend-chart}.ts[x]`, tests, and the single assigned integration point in `features/space/space-page.tsx`. Existing SPACE scope helpers may be consumed; any changes require coordinator ownership.

Dependencies: Task 1 private transport contract → Task 2 safe calculation contract → Task 3 persistence/worker → Task 4 HTTP/wiring → Task 5 UI → Task 6 integration/docs/delivery. Frontend can begin isolated parser/fixture work after Task 2 contract is committed, using the HTTP signatures below; live workflow integration waits for Task 4.

## Shared interfaces

Define provider types in `github-pulls-contract.ts`, application types in API `space-github/contract.ts`, and matching strict browser types/parsers in web `space-github/api.ts`. Browser production code must not import either server package. Parity tests may import server types/calculation with test-only fixtures, as existing pulse parity tests do.

```ts
// Provider contract: all timestamps canonical UTC instants; all IDs positive safe integers.
export type AccountClass = 'human' | 'bot' | 'unknown';
export type PullFact = Readonly<{
  id: number; number: number; createdAt: string; mergedAt: string | null;
  authorClass: AccountClass; observedAt: string;
}>;
export type ReviewFact = Readonly<{
  id: number; pullId: number; submittedAt: string;
  state: 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED' | 'DISMISSED';
  authorClass: AccountClass; reviewerClass: AccountClass;
  actorEligibilityKnown: boolean; isSelfReview: boolean; observedAt: string;
}>;
export type AcquisitionGap =
  | 'discovery_limit' | 'review_limit' | 'fact_limit' | 'byte_limit'
  | 'active_time_limit' | 'record_conflict' | 'invalid_time' | 'unknown_actor';
export type PullCheckpoint = Readonly<{
  version: 1; phase: 'discovery' | 'reviews' | 'ready';
  repositoryId: number; repositoryOwner: string; repositoryName: string;
  nextPullPage: number | null; nextReviewIndex: number; nextReviewPage: number;
  pulls: readonly PullFact[]; reviews: readonly ReviewFact[];
  reviewTraversalComplete: readonly number[]; discoveryTraversalComplete: boolean;
  gaps: readonly AcquisitionGap[];
}>;
export type PullSlice = Readonly<{
  checkpoint: PullCheckpoint; done: boolean; activeMillis: number; requests: number;
}>;
```

Adapter exports `verifyGitHubPullScope` with the existing verifier's input/return shape but the new exact permission profile; `parsePullCheckpoint(value: unknown): PullCheckpoint`; and `collectGitHubPullSlice(input): Promise<PullSlice>`. Input contains verified `{repositoryId, repositoryOwner, repositoryName, token}`, reporting window, nullable checkpoint, already-spent active milliseconds, injected `FetchTransport`, clock and `AbortSignal`. Verification and author re-fetch requests use the same slice budget counter: the API provider owns a counter/deadline wrapper and passes remaining allowance into collection. No reset of verification costs before collection.

```ts
export type SignalId = 'pulls_opened' | 'pulls_merged' | 'reviews_submitted'
  | 'open_to_first_review' | 'open_to_merge';
export type Signal = Readonly<{
  id: SignalId; status: 'provisional' | 'no_observations' | 'insufficient_samples';
  value: number | null; unit: 'count' | 'hours'; sampleCount: number;
}>;
export type CalculatedSignals = Readonly<{
  calculationVersion: 'clio.space.github.calculation.v1';
  signals: readonly Signal[];
  reviewContext: Readonly<{ reviewed: number; noQualifyingReview: number;
    unknownTraversal: number; excludedActors: number }>;
}>;
```

`calculateSignals(checkpoint: PullCheckpoint, window: {windowStart: string; windowEnd: string}): CalculatedSignals` is pure. Exactly five unique signals in fixed ID order; counts use observed event cohorts, durations use qualified human cohorts. Published duration sample counts refer to timed PRs. Even medians average middle durations; calculate instants with microsecond-safe ordering before converting to hours.

The maintainer explicitly requested PR review time. Display `open_to_merge` as **PR review time (open to merge)** and `open_to_first_review` as **Time to first human review (open to first review)**. Both include draft time; open-to-merge includes author work and queues rather than measured active reviewing effort. Preserve separate timing cards, original populations, sample counts and compatible repository/team-scoped trends. No new signal ID or OEMS semantic change is required.

Safe `OperationResult`: `id`, `runId`, `workspaceId`, `mappingId`, `mappingRevision`, `appId`, `installationId`, `repositoryId`, `repositoryLabel`, copied `teamId/teamName`, `windowStart/windowEnd`, `acquisitionStartedAt/acquisitionEndedAt/completedAt`, `contractVersion: 'clio.space.github.v1'`, `calculated: CalculatedSignals`, traversal booleans and bounded gap reasons. Completion time is database time; acquisition bounds are observed interval, never atomic provider state.

Safe `OperationMapping`: `id`, `workspaceId`, `teamId/teamName`, `appId`, `installationId`, `repositoryId/repositoryLabel`, `revision`, `connected`. Safe `OperationRun`: `id`, `mappingId`, frozen mapping context/window, `state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'`, `queuedAt`, nullable `completedAt`, safe reason, nullable `resultId`. Do not expose checkpoints, leases, fingerprints, actor IDs or raw errors.

## Task 1: PR-only verification and resumable acquisition

**Files:** Create provider files listed above; modify only `packages/adapters/src/index.ts`; create `packages/adapters/tests/github-pulls.test.ts`. Read adapter AGENTS, current GitHub signing/scope/transport/rate helpers.

**Interfaces:** Produces provider types and three adapter exports above. Consumes existing `FetchTransport`, `signGitHubAppJwt`, API version, bounded transport and redacted `AdapterError`/rate-limit errors. No database, survey or OEMS dependencies.

- [x] Add controlled HTTP fixture helpers within the test file. Use realistic GitHub PR JSON with nested repositories/body fields to prove only allowlisted normalized fields survive.

```ts
const rawPull = { id: 101, number: 1, created_at: '2026-09-01T09:00:00Z',
  merged_at: '2026-09-02T09:00:00Z', user: { id: 9, type: 'User' },
  title: 'private-title', body: 'private-body' };
// After a real mocked slice, check serialized checkpoint excludes identity/content.
expect(JSON.stringify(slice.checkpoint)).not.toMatch(/private-title|private-body|"user"/);
expect(slice.checkpoint.pulls[0]?.id).toBe(rawPull.id);
```

- [x] Run `pnpm --filter @clio/adapters exec vitest run tests/github-pulls.test.ts`; observe RED before implementation, retaining failure output in ignored artifacts.
- [x] Implement exact PR/Metadata-read verification separately; prove App/account/installation/suspension/selected scope, narrowed repository token and metadata with existing safe helpers. Test deployment permissions rejected here and existing deployment verifier unchanged.
- [x] Implement strict checkpoint parser and endpoint-specific Link validator. Require matching origin/path/query, exact page size and monotonic next page. Reject embedded credentials, redirects, unrelated resources and duplicate pages before checkpoint advance.
- [x] Implement discovery, deterministic review ordering, current-author re-fetch per claim, transient actor comparison, deduplication/conflict gaps and limits. Keep pending reviews out of timed facts. Handle missing actor and time as declared gaps; malformed identity/path is a failed acquisition.
- [x] Test old-created/new-merged PR, old PR reviewed in window, review exactly at end excluded, bot/self/pending/dismissed/missing users, nested near-byte-cap pages, repeated reviews, conflict pages, quota-shaped errors, aborted bodies and restart mid-review. Assert no author/reviewer IDs persist in checkpoints.
- [x] Run focused adapter suite and typecheck GREEN. Coordinator reviews task diff and gets Claude read-only review; fixes receive regressions before integration. Commit only after repository-required checks, using `feat(adapters): collect bounded GitHub pull evidence`.

## Task 2: Application calculation and safe result contract

**Files:** Create API `space-github/{contract,calculate,input}.ts`; `apps/api/tests/space-github.test.ts`; web `space-github/api.ts` and `api.test.ts`, `contract-parity.test.ts`.

**Interfaces:** Consumes provider checkpoint types; produces `calculateSignals`, safe types above and unknown-input parsers. Browser exports `parseOperationResult`, `parseOperationMapping`, `parseOperationRun` and page parsers; endpoint transport uses existing credentialed identity helpers.

- [x] Add actual calculation fixtures with three human PRs, durations 1/3/5 hours, duplicate review observations and a bot PR. Assert median 3 hours, bot PR counted in activity but excluded from durations. Below-three timed samples stays null; empty counts stay null rather than zero.

```ts
const result = calculateSignals(checkpoint, {
  windowStart: '2026-09-01T00:00:00.000Z', windowEnd: '2026-09-15T00:00:00.000Z',
});
const duration = result.signals.find((signal) => signal.id === 'open_to_first_review');
expect(duration).toEqual({ id: 'open_to_first_review', status: 'provisional',
  value: 3, unit: 'hours', sampleCount: 3 });
```

- [x] Run `pnpm --filter @clio/api exec vitest run --config vitest.config.ts tests/space-github.test.ts`; observe RED.
- [x] Implement half-open event cohorts, safe-instant order, human eligibility, per-PR complete-review exclusion and conditional medians. Validate exact closed midnight bounds and maximum 90 days; reject future/noncanonical dates and unknown request fields.
- [x] Add a discriminating timing case: three human PRs opened at 09:00, first reviewed at 10:00 and merged at 14:00 on the same day produce first-review median 1 hour and PR-review-time median 5 hours. Prove review submission is not substituted for merge and that draft PRs remain eligible under the approved lifecycle definition.
- [x] Browser parsers reject missing/duplicate signals, numeric no-observation values, negative counts/hours, duration under minimum, wrong unit/version/source/mapping/window, invalid timestamps and cursor mismatches. They never accept private provider fields.
- [x] Parity test passes actual API calculation inside a real safe result to browser parser. Mutate context/version/status after serialization and prove rejection. Do not merely duplicate fixture constants across server/browser.
- [x] Run API focused suite, web parser/parity suites and both typechecks GREEN. Coordinator owns shared contract changes; opposite-engine review before commit `feat(space): define qualified GitHub operational signals`.

## Task 3: Private configuration, PostgreSQL mappings and durable worker

**Files:** Create `apps/api/migrations/0016_space_github.sql`, API `space-github/{config,repository,jobs,provider,worker}.ts`, `apps/api/src/worker-space-github.ts`, `apps/api/tests/space-github.integration.ts`. Modify existing GitHub config only to export/reuse secure private-file loading without changing its behavior; coordinator owns manifests/readiness and organization guard.

**Interfaces:** `readSpaceGitHubConfig(env: NodeJS.ProcessEnv, deploymentAppId: number | null): Promise<SpaceGitHubConfig | null>`; `SpaceGitHubConfig` has existing App/key/grant structure with explicit PR profile/fingerprint. `createSpaceGitHubRepository(pool, config)` produces authorized read/list/save/disconnect/enqueue/history/getResult methods returning safe types. `processOneSpaceGitHub(pool, config, {signal, provider?}): Promise<boolean>` processes at most one eligible job slice; injected provider uses actual adapter interfaces.

- [x] Build disposable random-schema integration harness following existing SPACE tests. Add migration/constraint tests, atomic snapshot/readback, request-ID replay and first worker slice before implementation; observe RED against new integration file.

```ts
expect(await repository.enqueue(actor, workspaceId, mapping.id, request)).toEqual(
  await repository.enqueue(actor, workspaceId, mapping.id, request),
);
// Different body under same scoped request ID rejects; it cannot enqueue new work.
await expect(repository.enqueue(actor, workspaceId, mapping.id, changedRequest))
  .rejects.toMatchObject({ statusCode: 409 });
```

- [x] Reserve migration after confirming 0015 latest. Add workspace-bound mapping/team keys, repository uniqueness, revisioned connection state; jobs with scoped request ID uniqueness and active-job partial index; bounded checkpoints; private evidence + safe result rows. Add immutable completion guards, claim/retry/refund guards, deadline/lease constraints and source-safe indexes. Historical team fields copied, not cascading through current teams.
- [x] Implement config absent/invalid/identical-App policies and grant profile fingerprints. Never read/print real grant contents during tests. Fixtures supply temporary owner-only files outside Git with teardown.
- [x] Repository uses `authorizedWorkspaceTransaction` for every member read/owner write, one checked-out client, parameterized SQL. Verification runs outside transaction with preflight and postflight fences. Explicit disconnect cancels/fences active work; deleteTeam refuses connected mappings/active jobs.
- [x] Implement claim/checkpoint/reschedule/complete/fail against database time and current grants/revision. Use existing `acquireQuota`, `paceQuota`, `observeQuota`, `releaseQuota`; wrap *all* requests in the shared deadline/request counter. Add App-independent cooldown tests and same-App contention across operational jobs. Never pace while holding database transaction.
- [x] Account elapsed active milliseconds on every slice path, including failed and cooperative work. Enforce 24-hour expiration even after long cooldown. Commit checkpoint/result only under live job lease/current grant/current connected revision; cancelled or expired jobs cannot complete.
- [x] Tests exercise restart mid-review/author re-fetch, deleted author, renamed/transferred repository, mapping revoked during quota wait, expired lease, concurrent claims, quota refund, byte/fact/time caps, idempotency and immutable original team/name after rename/move. Inspect JSON checkpoint/evidence for forbidden actor IDs/content.
- [x] Worker CLI supports `--once`, safe shutdown and redacted errors; identity missing disables live HTTP setup; migration checks precede work. Add `worker:space-github` scripts without dependency/lockfile changes.
- [x] Run `CLIO_TEST_DATABASE_URL=<existing test database> pnpm --filter @clio/api exec vitest run --config vitest.integration.config.ts tests/space-github.integration.ts` using inherited/private environment, never literal secrets. Preserve existing development schemas/volumes. Coordinator observes exit and opposite-engine review before commit `feat(api): persist and collect SPACE GitHub evidence`.

## Task 4: HTTP API and runtime wiring

**Files:** Create API `space-github/routes.ts`, `apps/api/tests/space-github-routes.test.ts`; coordinator modifies `main.ts`, `server.ts`, `features/identity/routes.ts`, `db/migrations.ts`, API README. Add `docs/space-github-api.md`.

**Interfaces:** Prefix `/api/workspaces/:workspaceId/space/github`; register through existing actor resolver. Endpoints:

| Endpoint | Policy/shape |
| --- | --- |
| GET `/availability` | Member reads `{enabled}`; owner additionally sees bounded safe granted App/installation/account/repository IDs, no keys/fingerprints |
| GET `/mappings?teamId&cursor` | Member read; page `{mappings,nextCursor}`, max 25; team filter optional and context-bound |
| POST `/mappings` | Owner/trusted Origin; `{teamId,installationId,repositoryId}`; verified create, 201 `{mapping}` |
| PATCH `/mappings/:mappingId` | Owner; `{revision,teamId}`; optimistic expected revision, returns `{mapping}` |
| POST `/mappings/:mappingId/disconnect` | Owner; `{revision}`, returns `{mapping}`; explicit idempotent disconnect replay |
| POST `/mappings/:mappingId/runs` | Owner; `{revision,requestId,windowStart,windowEnd}`, 202 `{run}` |
| GET `/mappings/:mappingId/runs?cursor` | Member; `{runs,nextCursor}`, max 25; independent pending/failed history |
| GET `/mappings/:mappingId/results?cursor` | Member; `{results,nextCursor}`, max 25; immutable success history |
| GET `/results/:resultId` | Member; `{result}`; readable after disconnect/team deletion |

- [x] Add fail-closed tests for missing identity/config, cross-workspace reads, revoked sessions/members, member writes, wrong Origin, unknown fields, stale revision and invalid cursor before routes; observe RED.

```ts
const denied = await server.inject({ method: 'POST',
  url: `/api/workspaces/${workspaceId}/space/github/mappings`,
  headers: { cookie: member.cookie, origin: 'http://localhost:5173' },
  payload: { teamId, installationId: 10, repositoryId: 20 },
});
expect(denied.statusCode).toBe(403);
expect(denied.headers['cache-control']).toBe('no-store');
```

- [x] Implement exact parsers and safe wrappers; current authorization covers successful/error responses and no-store. Resource/cursor 404 stays distinct from membership absence; SQL conflicts return safe 409 rather than raw provider diagnostics.
- [x] Wire config to startup/server/identity routes and read-only availability. Readiness verifies current migration and expected operational columns. Existing login, deployment, Argo, measurement and pulse routes stay active; adding optional feature must not require PR credentials for unrelated routes.
- [x] Test owner demotion/session revocation between preflight and network verification completion, safe grant choices only for owner, scope-specific pagination and no credentials in all success/error envelopes.
- [x] Run route/unit + real PostgreSQL HTTP tests and existing identity/GitHub regression suites GREEN. Publish actual HTTP contract; coordinator review and Conventional Commit `feat(api): expose scoped SPACE GitHub workflows`.

## Task 5: Guided setup, safe repository results and qualified trends

**Files:** Create web files listed in ownership map and `operations-panel.test.tsx`, `trends.test.ts`; modify only assigned integration point `space/space-page.tsx`, owned organization deletion confirmation and CSS if needed. Existing `/developer-experience` route stays thin; no manual generated-tree edits.

**Interfaces:** `OperationsPanel({workspaceId, teamId, role})` consumes existing SPACE scope provider/fences. Four-stage `OperationsSetupWizard`: source/team → scope/limits/privacy review → save/window/explicit collection → stored result. Browser API transport follows Task 4 exact request/envelope shapes. `buildOperationalPoints(results, signalId)` returns independently qualified points keyed by repository/team/revision/calculation/window length.

- [x] Add UI tests for unconfigured/no-result/pending/failed/latest-success states, setup confirmation and workspace change while requests resolve. Assert Refresh performs GET only, never queues work; observe RED.

```tsx
await user.click(screen.getByRole('button', { name: 'Refresh saved results' }));
expect(requests.filter((request) => request.method === 'POST')).toHaveLength(0);
expect(screen.getByText('No observations')).toBeVisible();
expect(screen.queryByText('0 pull requests')).not.toBeInTheDocument();
```

- [x] Mount operational context alongside pulses, retaining survey copy/minimum and current workspace/team scope. Owner grants/mapping controls are absent for members. Reuse scope/revision/query abort behavior and independently recheck metadata after resource/cursor 403/404 or role mismatch.
- [x] Wizard states source identity, one owning team, incomplete-discovery ceilings, draft-inclusive conditional durations and small-source attribution limits. Explicit Save and Collect confirmations; retain unsaved choices through safe refresh, clear owner data on access/role change. Back/Next controls semantic and keyboard accessible.
- [x] Show safe repository result cards with observed/provisional labels, sample counts, acquisition interval and stored copied ownership. No totals/averaged medians across rows. Surface per-signal gaps, insufficient samples, unknown traversal and conditional-duration bias. New failed run cannot hide prior success.
- [x] Render separate **PR review time (open to merge)** and **Time to first human review (open to first review)** cards and trend selections. Test both accessible labels and their different fixture values; show draft/lifecycle inclusion without implying measured active review effort.
- [x] Implement bounded mapping/run/result pages and copied deleted-team history. Disconnect and stale revision return local feedback; history remains readable. Align panel heights using existing responsive grid tokens.
- [x] Render timestamp-positioned qualified points without connecting lines for incomplete history. Separate series by exact repository/team/revision/calculation/signal/period length; null/no observations/under-minimum samples are gaps. Include accessible tabular values/labels and reduced-motion behavior.
- [x] Test mixed repositories/team moves/mapping revisions/window lengths; stale late mutations, owner→member transition during save, cursor recovery with unchanged membership, true access loss, unmount/abort and no fake evidence in unconfigured state. Parity uses actual server calculations.
- [x] Run focused web tests/typecheck and build GREEN. Native Codex reviews Claude-authored UI (or Claude reviews Codex-authored UI); coordinator runs final shared integration. Commit `feat(web): add guided GitHub SPACE insights` after required checks.

## Task 6: Operator guide, integration proof and delivery

**Files:** Create `docs/providers/connect-space-github.md`; update `README.md`, `docs/architecture.md`, `docs/space-getting-started.md`, API README, approved spec status and this plan. Add cross-boundary fixture cases to web parity tests and API integration tests rather than new demo dependency/toolchain.

- [x] Guide gives exact PR-only App permissions and selected-repository installation, private key/grant files, separate env keys, safe App-ID distinction, mapping wizard, worker command, explicit collection, cutoff/traversal/status interpretation, troubleshooting and disconnect behavior. Real registration/authorization are deliberate maintainer actions; do not operate account automatically.
- [x] Document controlled test fixtures and how to reproduce adapter → worker → safe result → browser parser evidence without live credentials. No fixture results presented as real source measurements; no fake/mock banner added to live UI.
- [x] Self-review approved spec section by section and mark tasks only when actual deliverable/checks observed. Supply opposite-engine reviewer exact base, complete added-file diff, acceptance criteria and real check outputs in ignored `.agent-runs/space-github-operations/` artifacts. Fix material findings with bounded regressions.
- [x] Run `pnpm check`, full `pnpm test:integration` with existing private test database environment, and `git diff --check`; observe exits. These commands include real test behavior, not claims copied from prior pulse delivery.
- [x] Explicitly apply reviewed new migration to development DB without touching prior migrations/data. Reload runtime if migration ledger cache requires it; verify readiness. Exercise controlled HTTP worker path. Browser/keyboard checks only through an allowed browser surface; if policy blocks it, record visuals unverified without alternate-browser/CDP workaround.
- [ ] Coordinator creates Conventional Commit(s), pushes existing authorized main after verified integration, then inspects exact-commit CI. Report shipped behavior, checks, source-access requirements, provisional coverage, no product/service attribution and any unverified visuals. Leave real App registration, notifications and automatic collection disabled unless separately authorized.

## Plan self-review and execution handoff

Spec coverage: independent permission profile (1,3,4); actor privacy/restarts/order/limits (1,3); all signal semantics and qualifications (2,5); scoped mappings/immutable context/durable quota/jobs (3,4); wizard/query fences/history/trends (4,5); real-source docs and review/checks (6). Review-focus cases appear in their owning tasks. All shared type/function names above are explicitly defined or point to existing verified repository exports; worker/HTTP implementation supplies the signatures defined here.

Status: approved for implementation by the maintainer on 2026-10-13, including explicit PR review time. Execution uses the committed coordinator/specialist workflow. Task checkboxes record observed delivery, not planned outcomes.

## Local verification record

Implemented all six slices. Independent opposite-engine reviews covered provider, calculations, storage/worker, identity routes, UI and coordinator integration; final source review required history filter cursor reset, accurate transient-payload disclosure and database-clock enqueue validation. Bounded regressions cover those fixes.

Observed local proof: full PostgreSQL suite 242/242; controlled REST adapter → worker → PostgreSQL safe result → strict browser parser 4/4. Migration 0016 applied explicitly to development PostgreSQL, API restarted, `/health/ready` returned 200 with `ready`. Signed-in browser showed the unconfigured GitHub repository state and saved-result Refresh correctly. Controlled fixture DOM checks at 640/1024/1440 confirmed equal card heights and contained expanded-table scrolling; native summary Enter and scroll-area Tab focus worked. Browser screenshots were unavailable, so pixel appearance remains unverified. No live PR App was registered or configured, no automatic collection enabled, and no fixture results inserted into the live workspace.
