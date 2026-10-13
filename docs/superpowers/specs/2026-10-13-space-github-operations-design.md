# SPACE operational GitHub signals

Status: implemented and locally verified on 2026-10-13. Live GitHub App setup and source verification remain manual.
Date: 2026-10-13
Base: `4c1297c1749c1527e4c11e2aacfd6544c86220fe`

## Intent

Complement the shipped SPACE pulses with observed repository activity, review collaboration and pull-request flow. Owners connect selected GitHub repositories; workspace members inspect aggregate evidence in Developer experience. Preserve confidential survey reporting, existing DORA collection and the pinned OEMS contract.

The maintainer approved this written design on 2026-10-13, including signal definitions, separate App and attribution policy. Repository ownership describes where work occurs, not the team membership of everyone contributing to it.

## Approaches considered

1. **Separate PR-only GitHub App and operational collection (recommended).** Reuse signing, bounded HTTP and persisted quota helpers, while preserving the deployment-only App verifier and deployment jobs. Requires an additional operator-managed App, but existing DORA connections keep their permissions and behavior.
2. **One App with explicit capability profiles.** Could reduce setup, but the existing verifier deliberately requires exactly Deployments/Metadata read on both installation and narrowed token. Supporting an installation with more capabilities changes an established authorization contract and needs its own migration/design. Defer.
3. **Derive activity from saved deployments.** Cheap, but deployments cannot establish PR or review populations. Reject as a source of operational SPACE measurements.

No App registration, installation authorization or external permission change happens automatically. Controlled fixtures validate the flow while real access remains operator-dependent.

## Scope and standard boundary

Add separate application contract `clio.space.github.v1`. Provider collection produces private normalized facts; application calculations produce safe immutable results. Do not pass these facts through OEMS deployment validation or add fields to `clio.space.pulse.v1`.

Deliver manual owner connection/setup, durable collection, immutable repository results, workspace/team browsing, bounded history and compatible-window trends. Exclude personal rankings, contributor-to-member linking, commit/line counts, scores, notifications, scheduling, webhooks, arbitrary subgroups and survey/result joins. Product/service activity attribution is deferred: a shared repository cannot identify its products/services without a reviewed path or event partition.

SPACE is multidimensional. Repository activity is contextual evidence, not measured productivity or independently established customer value. Satisfaction remains self-reported; existing delivery results remain separate performance context.

## Identity, scope and ownership

Private configuration uses separate `GITHUB_SPACE_APP_ID`, `GITHUB_SPACE_APP_PRIVATE_KEY_FILE` and `GITHUB_SPACE_APP_GRANTS_FILE`. Reuse the existing private-file security policy; no keys, OAuth tokens or provider payloads enter browser configuration or PostgreSQL credential storage. Configuration absent disables operational collection; partial/invalid configuration fails startup with redacted errors. When both collectors are configured, reject identical App IDs. Preserve the grants-file rule that one installation belongs to one workspace.

Grants bind workspace UUID, App, installation, stable account ID/type, exact repository IDs and operational permission profile. Fingerprints include capability profile. Require selected-repository installation scope, unsuspended installation and exact **Pull requests read + Metadata read** permissions; narrowed token must independently prove exactly one granted repository. Existing Deployments-only helpers retain their current behavior.

Owner maps each repository to exactly one current team, independently of primary member assignments and service deployment connections. Enforce one active mapping per `(workspace, App, installation, repository)` and reject a second active source for the same GitHub repository in that workspace. Shared repositories require one explicit owning team; never infer ownership from author, email, branch or duplicated service connections.

Mapping revisions increment on changes. Enqueue captures revision, original team ID/name, repository identity, permission/grant fingerprint and reporting window. Renames do not rewrite history. Reassignment/disconnection/grant removal fences pending jobs; previously completed results remain readable with current workspace authorization. Team deletion is blocked while operational mappings remain connected or jobs remain active; owner must explicitly disconnect first. Disconnection cancels/fences pending jobs and preserves completed history. This keeps destructive lifecycle choices explicit, alongside existing pulse deletion guards.

Workspace view shows repository rows grouped by their frozen teams. Team view shows its repository rows. First slice does **not** publish pooled team/workspace counts or average repository medians; selected repositories are not an exhaustive engineering population. Copied context for deleted teams stays selectable as history without becoming a target for new connections.

## Acquisition and durable jobs

Add independent operational connections/jobs/checkpoints/results; do not repurpose deployment tables or checkpoint schemas. Allocate next migration only at implementation, after checking the current ledger. Never modify applied `0015_space.sql`.

Manual collection accepts closed UTC calendar-day windows, end exclusive, at most 90 days, plus a scoped request ID for idempotent enqueue. One active job per mapping. Owners enqueue; members read. Save performs authorized preflight, provider verification outside transactions, then transactional role/session/grant/revision revalidation.

Resolve current repository metadata through `/repositories/{repository_id}` and verify stable owner/repository identity. Enumerate `/repos/{verified_owner}/{verified_name}/pulls?state=all&sort=created&direction=desc&per_page=50`, constructing only allowlisted GitHub paths. Validate stable repository/PR identity and supported fields. Never follow arbitrary provider URLs. Use a new endpoint-specific pagination validator preserving state/sort/direction/page size; do not loosen the deployment pagination guard. Fetch reviews for every discovered PR created before window end, including old closed PRs, because they can receive reviews inside the window. A PR created before the window can merge or receive reviews inside it; creation time alone never permits excluding it. Repository rename/transfer during acquisition invalidates that acquisition rather than following a redirect or rebinding silently.

Bound each run to 20 PR pages / 1,000 unique PRs, 100 review pages per PR, 10,000 retained unique valid submitted reviews overall (including reviews outside the reporting window), and 16 MiB normalized retained facts. Each network response is bounded to exactly 2,000,000 bytes and 10 seconds, redirect-free; validate realistic nested GitHub fixtures near the cap. These are independent ceilings, not a promise every ceiling is reachable within the time budget. Larger repository histories deliberately produce incomplete discovery. There is no safe early-stop assumption based on PR creation or update time: the checked provider contract does not establish that every submitted review advances PR `updated_at`. Setup must disclose this bounded full-history pilot and its limits before collection.

Normalized storage excludes titles, descriptions, branches, code, comments, review bodies, emails and usernames. Author/reviewer IDs are compared only in transient acquisition memory. Persist derived `isSelfReview`, author/reviewer account classes and `actorEligibilityKnown` instead of person IDs, sufficient for this fixed calculation version. Before starting or resuming a PR's review traversal in each claim, re-fetch that PR's details, verifying repository/PR identity and retained creation timestamp, to obtain its current author ID for transient self-review comparison. Count this extra request inside all request/time/byte budgets. Missing/deleted authors or conflicting retained actor classes produce unknown eligibility; never guess an identity across slices or save actor IDs in checkpoints. Exclude unknown-actor records from human duration/review cohorts with explicit gap reasons. Opened/merged observed counts still include their valid events, independent of actor eligibility. No person-level output or contributor identity roster is stored.

Finish bounded PR discovery before review traversal, then process discovered candidates by descending `(created_at, provider PR ID)` and each PR's validated review pages in ascending page order. Resume that explicit ordering from checkpoints. Acquisition subsets remain dependent on mutable provider responses and active budget, with a disclosed bias toward newer-created PRs when review traversal stops early.

Each worker claim lasts 120 seconds; provider work ends within 60 seconds and at most 40 requests, including verification. Persist bounded validated checkpoints between slices; cooperative budget exhaustion releases and reschedules without spending failure attempts. Enforce a 30-minute total active-acquisition budget, counting elapsed provider work and pacing inside claims, excluding queue/cooldown time. Jobs expire 24 hours after enqueue regardless of active time; expired jobs fail rather than publish stale partial input. An exhausted page/fact/byte/active-time budget produces explicit incomplete acquisition, never silent truncation or complete population claims. Three actual retryable failures exhaust a job; no synthetic success from a failed traversal.

Reuse existing PostgreSQL quota implementation keyed by App/installation, App-wide one-request/second pacing, installation leases, provider reset/Retry-After cooldowns and positive jitter. Separate deployment/SPACE App IDs have independent quota rows; concurrent operational jobs within the same App share one budget. Every verification, token and page request uses the guarded transport. Quota contention/cooldowns reschedule rather than burn attempts or hold network/database transactions open. New operational jobs need their own attempt/refund storage guard; existing deployment-table triggers do not apply automatically. Interrupted acquisitions resume validated cursor/facts, not raw response bodies. Expired tokens are reacquired after current-scope verification.

Deduplicate immutable provider identities. Conflicting records across resumed pages become explicit acquisition gaps; do not arbitrarily pick conflicting timestamps. GitHub listings are mutable and offset-paginated: even traversing every page is not evidence of an atomic historical population. Save acquisition start/end and trusted database completion cutoff separately; never describe saved fields as a provider state exactly at the cutoff.

Completion atomically saves private normalized evidence, safe calculation and snapshot context after claim/session-independent grant/mapping fences. Collection workers have no browser actor authorization; current operator grant and connection eligibility govern completion. Credentials remain ephemeral. Failed attempts retain safe job status only; newer failure does not hide prior success.

## Signal definitions

Every event uses provider timestamp membership in `[windowStart, windowEnd)`. Reject impossible orderings and future timestamps as gaps. Counts deduplicate stable IDs; retries and repeated observations never add activity. Do not infer missing events from current state.

| Signal | Definition | Qualification |
| --- | --- | --- |
| PRs opened observed | Distinct discovered PR IDs with `created_at` inside window | Includes draft and bot PRs; state explicitly describes repository activity |
| PRs merged observed | Distinct discovered PR IDs with non-null `merged_at` inside window | Includes draft-time history and bot/unknown-author PRs; creation may precede window; closed-unmerged is excluded |
| Review records submitted observed | Distinct review IDs with `submitted_at` inside window | Exclude pending reviews, self reviews, Bot accounts and unknown actors; include submitted commented/approved/changes-requested/dismissed records with valid timestamps. Repeated reviews/comments by one person are not distinct reviewers or necessarily distinct review sessions |
| Time to first human review (open to first review) | Median of earliest observed qualifying non-self/non-bot submitted review time minus PR creation time | Cohort: human-authored PRs opened in window; follow-up bounded by that window end. Includes draft time and incomplete follow-up; never call it ready-for-review wait time |
| PR review time (open to merge) | Median `merged_at - created_at` for discovered human-authored PRs merged in window | Includes draft time and possibly PRs opened long before window; excludes still-open, closed-unmerged, bot-authored and unknown-author PRs. Never call it deployment lead time |

The maintainer explicitly requested PR review time. Present both timing indicators with the boundaries above, sample sizes and repository/team-scoped trends. Keep internal signal IDs `open_to_first_review` and `open_to_merge`. PR review time here is elapsed lifecycle time, including author changes, queues and drafts; these API events cannot establish minutes spent actively reviewing code. It remains separate from pinned OEMS calculations and their deployment-linked populations.

Durations publish only with at least three valid timed PRs: three PRs with a qualifying observed first review, or three PRs with a valid merge duration respectively. Below that minimum publish null with `insufficient_samples`. This is a fixed operational sample guard, separate from configurable survey respondent suppression. Missing timestamps, excluded invalid samples and incomplete review traversal remain explicit qualification reasons. No duration treats an unanswered/unreviewed PR as zero; show reviewed sample count alongside limitations, without identities. An observed no-qualifying-review count covers only discovered human cohort PRs whose review traversal finished; incomplete review traversal produces unknown context rather than classifying those PRs as unreviewed. The first-review median is conditional on observing a review within the reference period: later-opened PRs have shorter follow-up and absent/slower responses are censored, biasing observed durations toward shorter waits. Show this limitation explicitly; do not compare it as an unconditional waiting-time improvement.

Counts are explicitly **observed** counts, not complete historical totals. Metric states are `provisional`, `no_observations`, or `insufficient_samples`; all numeric values are provisional regardless of traversal exhaustion. No saved acquisition is a separate `not_collected` UI state; job failure is separate from metric status. An empty observed event cohort yields `no_observations` and null displayed values, not a completeness-certified zero. Traversal completion is separate metadata, never a promotion to historical completeness. Incomplete review traversal excludes that PR only from first-review duration calculation in this conservative first profile; valid open-to-merge durations remain independent of review traversal; expose excluded-sample context so selection bias remains visible. Future validated chronological-prefix calculation would require a new calculation version.

Operational source activity is not survey-confidential reporting. A small or single-contributor repository can make aggregate activity attributable to one person even without exposed identities. Disclose this during owner setup and in results. Do not claim operational anonymity or borrow the survey respondent threshold; excluding stored identities limits person analytics but cannot guarantee confidentiality of public/source activity.

## Safe results, browsing and trends

Safe results contain contract/calculation version, source/mapping revision, copied team identity/name, repository identity/display label, window, acquisition bounds, completion time, transport traversal flags, bounded gap reasons, observed signal values/sample counts and qualifications. They exclude provider actor IDs and raw facts. Repository labels are explicit authorized setup metadata, unlike existing DORA safe-result contracts; do not retrofit labels into those contracts.

Developer experience retains pulses and adds clearly labelled GitHub activity/collaboration/flow context. Owner wizard: choose granted repository and owning team, review permission/scope, save verified connection, select window and explicitly collect, inspect saved results. Refresh reads saved history and never queues collection.

History pages contain at most 25 rows with context-bound cursors; a next cursor requires a full 25-row page. Optional team filters use frozen run/result ownership, and the mapping list includes current or captured historical ownership. Pending/failed/latest-success states are independent. Workspace/team repository lists are bounded; show page context, never page totals as global totals. Strict browser parsers reject malformed result contexts; use existing workspace/identity revision, query-abort, mutation and role/access revalidation fences.

Charts split series by exact repository, original team ID, mapping revision, calculation version, signal and period length. Points use window starts; suppressed/null/missing or mismatched periods break continuity. Observed provisional points remain visibly qualified. First release uses points without connecting lines for incomplete historical populations, avoiding implied continuous measurement. No better/worse grading for activity counts, no combined productivity score.

## Verification and delivery

Controlled HTTP fixtures cover token scope, private-field stripping including checkpoint actor IDs, pagination/redirect guards, realistic near-cap response bodies, old-created/new-merged PRs, exact boundary timestamps, bots/self/pending reviews, null/deleted actors, dismissed reviews, multiple review records from one reviewer and repeated observations of the same record, deduplication/conflicts, odd/even medians, insufficient samples, mutable/limited traversal and empty observations. Restart partway through one PR's reviews must prove author re-fetch, transient identity handling, ordering and correct extra-request accounting. Fixtures must exercise the actual adapter → calculation → safe-result → browser-parser path; do not invent a reply-to-review-record mapping that the chosen API has not established.

Real PostgreSQL tests cover immutable snapshots/checkpoints, idempotent enqueue, claim contention, shared quota across operational jobs, isolation from the separate deployment App budget, identical-App configuration rejection, attempt refunds, restart, grant/revision/disconnection fences, team deletion/rename/reassignment, current membership/role/no-store policy and scoped pagination. UI tests cover wizard confirmation, result gaps, qualified charts, saved context, late requests, resource-vs-membership 404 handling and role transitions. Visual/keyboard verification must be reported separately from jsdom/HTTP availability.

Coordinator integrates bounded specialists using committed team guidance and opposite-engine review. Run `pnpm check`, real PostgreSQL integration and `git diff --check` before commit. Add real-source and controlled-fixture setup guides. Real registration/access remain maintainer-operated, not test success claims. Push authorized main only after implementation verification; report observed CI status separately.

## Sources checked during design

- [SPACE research](https://www.microsoft.com/en-us/research/publication/the-space-of-developer-productivity-theres-more-to-it-than-you-think/): multiple dimensions and limitations of individual activity measures.
- [GitHub pull requests](https://docs.github.com/en/rest/pulls/pulls): read permission, all-state listing, sorting and pagination; API version `2026-03-10` matches the current pinned helper.
- [GitHub reviews](https://docs.github.com/en/rest/pulls/reviews): submitted reviews and list-review permission requirements.
- [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api): primary/secondary budgets and provider retry guidance.

These definitions are Clio application semantics; they do not assert OEMS or SPACE conformance.
