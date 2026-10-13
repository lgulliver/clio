# SPACE foundation: team pulse surveys

Status: approved by the maintainer on 2026-10-13; implemented. Local verification is recorded in the accompanying plan; browser visual acceptance remains pending.
Date: 2026-10-13
Owner: Liam Gulliver

## Intent and accepted choices

Extend Clio from delivery evidence into developer experience while live DORA source activation is pending. Start with a usable team pulse workflow, then add operational signals that complement self-reported experience. Retain the existing workspace, team, product and service hierarchy.

The maintainer selected:

- Team aggregate reporting; no individual answer view.
- Workspace-owner configuration of the minimum respondent count.
- Default minimum: **3** respondents.

The remaining policies below are proposed application decisions, not already implemented behavior or OEMS requirements.

## Research and standard boundary

SPACE describes satisfaction and well-being, performance, activity, communication and collaboration, and efficiency and flow. Its researchers explicitly reject a single productivity metric or dimension. This design uses that framing, not a universal scoring formula or a proprietary survey instrument.

Primary sources:

- [The SPACE of Developer Productivity, Microsoft Research / ACM Queue, February 2021](https://www.microsoft.com/en-us/research/publication/the-space-of-developer-productivity-theres-more-to-it-than-you-think/).
- [Nicole Forsgren: Navigating the SPACE between productivity and developer happiness, Microsoft, May 2023](https://azure.microsoft.com/en-us/blog/navigating-the-space-between-productivity-and-developer-happiness/).

OEMS's current pinned contract contains five delivery metrics. At the pinned upstream revision `5908bb12cdf24e7528088237dff9dca4c10ff45f`, [OEMS ROADMAP.md](https://github.com/lgulliver/oems/blob/5908bb12cdf24e7528088237dff9dca4c10ff45f/ROADMAP.md#later-profiles) calls protected developer-experience aggregates a future extension and requires survey privacy design before interchange. Clio therefore owns a separate `clio.space.pulse.v1` application contract for this slice. It will not add fields to OEMS delivery results, claim SPACE conformance, or silently define an OEMS extension. Future standardized interchange needs a separate upstream decision and explicit pin update.

## First slice and exclusions

Deliver:

1. Primary team assignment for workspace members, separate from workspace authorization and product/service ownership.
2. Configurable survey reporting minimum, default 3.
3. Owner-created team pulses with a fixed reference period and frozen participant roster.
4. Eligible members submitting a confidential response once.
5. Owner closure and immutable, threshold-protected team results.
6. A Developer experience page with dimension cards, participation context and trends across compatible closed pulses.

All five dimensions receive explicitly self-reported indicators. Activity frequency is a reported perception, not measured commits or pull requests. Perceived performance is not independently established customer value. Existing DORA service results remain separate delivery context.

Exclude from this first slice: a composite SPACE score, individual rankings, person-level answer/history APIs, free-text answers, product/service survey drill-down, automated reminders, email/Slack delivery, automatic scheduling, imported survey instruments, and new live GitHub PR/review collection. Operational activity/collaboration/flow evidence follows as a separate slice once provider access is available.

## Participants and ownership

Existing teams group products and services but do not currently contain people. Add one optional primary team per workspace member. Owners manage these assignments using existing member identities; team assignment does not grant workspace membership or new roles. Multiple team membership is deferred, matching the initial ownership model. Members can inspect their own primary-team assignment and change history; owner changes must not be invisible to the affected person.

Opening a pulse captures its team identity/name and the IDs of eligible, currently authorized workspace members assigned to that team. The roster and its size freeze at opening. A participant who subsequently moves teams may still answer the pulse whose roster included them, while current workspace membership and session validity remain mandatory. New team members wait for a later pulse. Revoked members cannot submit; previously accepted responses remain part of the original cohort. Removing workspace membership clears the current primary-team assignment through its membership foreign key. Rejoining as the same stable Clio user restores frozen-roster eligibility while the pulse is open, but never permits a second response; a different account with the same email is not a roster match.

A pulse cannot open with an empty roster. It may open below the reporting minimum, but setup must explain that results will stay suppressed unless enough frozen-roster members answer. Owners cannot add respondents to an open pulse or submit on behalf of another member.

Team rename or deletion must not alter historical pulse context. Archived pulse results retain their original team ID/name and roster denominator. Team deletion returns 409 while draft or open pulses exist; owners must close or cancel them first. Deletion clears current primary-team assignments and preserves closed/cancelled pulse context. A deleted team cannot receive a new pulse. Product/service grouping and immutable delivery results remain unchanged.

## Original pulse instrument v1

Reference period defaults to the preceding 14 UTC calendar days; owners may choose a different explicit past period before opening. Opening is rejected when its reference period overlaps any open or closed pulse in the workspace with at least one shared roster member, including pulses for different teams. At most one pulse can be open per team. Drafts reserve no period, and cancelled pulses publish nothing and do not block a replacement. The reference period is distinct from the time the pulse is open for responses.

The initial questions are original Clio items, intended as a pilot instrument rather than a psychometrically validated scale:

| Dimension | Question ID | Prompt | Scale |
| --- | --- | --- | --- |
| Satisfaction and well-being | satisfaction | I felt satisfied with my work. | Agreement 1–5 |
| Satisfaction and well-being | sustainable_workload | My workload felt sustainable. | Agreement 1–5 |
| Performance | useful_outcomes | My work contributed to useful outcomes for users or stakeholders. | Agreement 1–5 |
| Activity | contribution_frequency | How frequently did you contribute to implementation, design, testing, reviews, documentation or operational support? | Frequency 1–5 |
| Communication and collaboration | useful_help | I could get useful help when I needed it. | Agreement 1–5 |
| Communication and collaboration | shared_context | People shared enough context for us to work effectively. | Agreement 1–5 |
| Efficiency and flow | effective_tools | Our tools and processes helped me make progress. | Agreement 1–5 |
| Efficiency and flow | focus_time | I had enough uninterrupted time for focused work. | Agreement 1–5 |

Agreement labels: strongly disagree, disagree, neither agree nor disagree, agree, strongly agree. Frequency labels: never, rarely, sometimes, often, very often. Every item permits **Prefer not to answer / not applicable**, stored as null. Null is excluded from that question's denominator, never treated as zero.

The UI groups question results under their SPACE dimension but does not average questions into a dimension score or combine dimensions into a productivity score. Activity frequency has no better/worse color grading.

## Reporting and confidentiality

Accepted configuration bounds: integer minimum **3–1000**, default **3**. The lower bound follows the selected default of three and prevents two-person reports; the maximum is a validation limit, not a claim about supported cohort size. Changing configuration applies only to pulses opened afterwards.

Opening captures the configured minimum, reference period, instrument version and exact roster. Once opened, neither owner edits nor workspace preference changes can alter these captured values. Drafts remain editable until opening; the freeze occurs at opening, before any response is accepted.

No aggregates are published while the pulse is open. Closure freezes responses and computes results in one authorized transaction. A result never changes because another response arrives, settings change or ownership moves.

Suppression applies **per question**:

- Fewer than the frozen minimum, including zero non-null answers: `suppressed`, value null, exact answered count omitted. The result does not distinguish zero from another below-minimum count or reveal which questions a small cohort skipped.
- At least the frozen minimum: `published`, arithmetic mean on that question's original 1–5 scale, answered count and reference period visible.

An all-null response may count as submitted participation but cannot release any question. Questions never borrow respondents from another question, team or period. No arbitrary filters, subgroup exports, partial open-pulse aggregates or per-person response metadata are exposed.

Read visibility is explicit; no API lists named responders or non-responders:

| State/data | Owner | Eligible member | Other workspace member |
| --- | --- | --- | --- |
| Draft | Full safe draft metadata and live roster-size preview; no answers exist | Not listed/readable | Not listed/readable |
| Open team/reference period/instrument/minimum/frozen roster size | Visible | Visible before responding | Visible, including frozen roster size; no roster IDs |
| Open submitted count | Exact aggregate count | Hidden | Hidden |
| Open own eligibility/submitted flag | Actor's own flag only | Actor's own flag only | Own eligibility false; no other people's flags |
| Open answer values or question counts | Hidden | Hidden | Hidden |
| Closed total submitted count | Exact aggregate count | Exact only at/above frozen minimum; otherwise null/suppressed | Same as eligible member |
| Closed per-question mean and answered count | Published only at/above minimum; otherwise null, with count omitted below minimum | Same protected result | Same protected result |
| Cancelled participation/results | State/context only; no answer values or counts | Same, plus own submitted flag if a receipt exists | State/context only |

Owners do not receive additional answer aggregates when results are suppressed. A role change immediately changes count visibility on the next read. Roster IDs and other people's receipt flags stay private in every state.

This is confidential aggregate reporting, not a guarantee of anonymity against database administrators or people who know others' answers. Authentication is required to enforce eligibility and one response per person. Default-three cohorts are small. Owners who manipulate assignments, colluding respondents and knowledge of other answers can still undermine confidentiality; these controls do not promise resistance to a malicious workspace owner. Participants must see frozen roster size, minimum and their own team-assignment history before answering. UI wording must describe aggregate reporting without promising anonymous answers.

Engineering shows published team results side by side; it does not include suppressed teams in a combined total that could reveal them by subtraction. No workspace-wide aggregate score is calculated in this slice.

## Lifecycle and authorization

States: `draft -> open -> closed`; `draft/open -> cancelled`. Closed pulses cannot reopen. A cancelled pulse never publishes results. Owners explicitly open, close or cancel; no scheduler is implied. Closing an already closed pulse returns its existing immutable safe result; opening cannot overwrite an existing frozen roster.

- Owners: manage primary team assignments, minimum setting and pulse drafts; open, close and cancel pulses.
- Current workspace members: read safe pulse/closed-result lists and submit their own response only if present in the frozen roster.
- Any response write: real current session, current workspace membership, frozen-roster eligibility, open pulse, exact instrument/body validation and trusted Origin.
- Any result read: current session and workspace membership; a URL or team ID never grants access.

The existing authorized workspace transaction serializes membership changes, hierarchy changes, pulse transitions and submissions. Closure and submission must resolve deterministically: a response committed before closure is included; one admitted after closure is rejected. Unique `(pulse_id, user_id)` receipts enforce one response even under concurrent duplicate requests. A retry with an already accepted receipt returns the same safe submitted state, even if its supplied answers differ. It never changes the original response, echoes original answers or discloses whether the bodies matched.

Answer rows contain only a random answer ID, pulse ID and validated answers: no user ID, receipt ID, timestamp or monotonic insertion sequence. Receipts contain only pulse/user identity and submitted state, without an answer ID or matching timestamp. Both are inserted atomically, but there is no application-level respondent-to-answer join. Database transaction/WAL inspection is outside this confidentiality guarantee.

Closure computes the safe immutable aggregates and deletes every raw answer row in that same transaction, including values/counts for suppressed questions. Cancellation also deletes raw answers and retains no aggregate values. Raw answers exist only during the open pulse. Safe immutable results, frozen roster IDs and submission receipts remain for the archived pulse's lifetime to preserve cohort context, duplicate fences and overlap checks; account/workspace deletion and backup retention require a separate policy before hosting.

No browser endpoint returns raw answers, respondent-to-answer mapping or private roster IDs for an archived pulse. Database administrators remain outside the application's read-visibility guarantee. Logs and errors must redact response payloads and private identity mappings.

## Storage and API boundaries

Use PostgreSQL, native TypeScript API and existing session/membership handling. Coordinator allocates the next migration only when implementation begins; applied migrations remain unchanged.

Keep implementation in `apps/api/src/features/space` and `apps/web/src/features/space`. Provider adapters and `packages/oems` stay unchanged. Separate application contracts and pure aggregation from transport/storage/presentation.

Storage responsibilities:

- Workspace SPACE preferences, including minimum.
- Current primary team assignment keyed by workspace/member identity, with workspace-scoped team constraints.
- Pulse draft/frozen metadata, reference period, state, opening/closing times and copied team context.
- Private frozen participant roster and unique submission receipts.
- Private immutable answer rows while open, with no respondent link; deleted transactionally on closure/cancellation.
- Immutable question aggregates and publication/suppression metadata at closure.

Historical pulse team context must survive team deletion without weakening current assignment foreign keys or allowing cross-workspace joins. No table should cascade-delete accepted historical results when a team is removed.

Protected APIs cover owner configuration/assignments, pulse create/list/read/open/close/cancel, member eligibility/submission status and response submission. Bodies accept only documented fields; IDs derive from the authenticated actor where relevant. History uses bounded cursor pages. Request/response contracts must distinguish open, cancelled, suppressed and published states explicitly. Zero answered counts are not disclosed as a separate question state.

## UI and trends

Add **Developer experience** navigation beside delivery views. Reuse workspace and team selectors, safe read/query cancellation and current session revision fences. Engineering starts with team summaries; selecting a team shows its closed pulses and question-level history. Product/service delivery context may be linked, but cannot subdivide survey cohorts.

Owner setup is a short wizard: choose team, review roster/minimum and reference period, preview questions, open pulse. Response form shows the team/reference period, confidentiality statement, frozen roster size/minimum and own team-assignment history, eight labelled items and a confirmation before final submission. Participants navigate to the pulse in Clio; opening does not send messages to others.

Question trends compare only published values with the same original team ID, instrument/question ID, scale and reference-period length. The x-axis is reference-period start; points expose closure time separately. Display the team name copied at opening for each point, with the current name only as a separate present-day label when the team still exists. Overlapping reference periods are rejected on opening for shared participants; unmatched instruments/lengths remain separate series. Each point shows cohort size, answered count, minimum, reference period and closure time. Cohort changes remain visible; changes are descriptive, not causal. Suppressed/open/cancelled periods produce gaps, not zeroes or connected invented intervals. There are no individual rankings, leaderboards or combined productivity percentages.

## Verification and implementation sequence

1. Contract and privacy tests: versioned original instrument, unknown-body rejection, null handling, per-question threshold, below-minimum count suppression, frozen settings and no composite score.
2. Backend foundation: primary team assignments/preferences, pulse lifecycle and frozen roster, safe eligibility/status, immutable response admission and close-time aggregates.
3. Real PostgreSQL regressions: owner/member/outsider scopes; current session/membership revocation; duplicate submissions; close/submit races; changing settings after opening; archived team deletion; one answered question among otherwise sufficient participation; zero-versus-small-count indistinguishability and skipped-item privacy; repeated/overlapping cohort periods; draft/open team deletion refusal and archived-context preservation; raw answer purging and unlinked receipt/answer rows; owner/member count visibility; revoked/rejoined identities; changed-body retry equivalence; no raw answer disclosure from success/errors/history.
4. Frontend: owner wizard, member response, protected result/history/trends and explicit suppression. Verify keyboard/focus, query aborts, workspace/account changes and late responses. Browser visual evidence remains separately required.
5. Local getting-started guide and controlled fixtures. Fixture participants and results remain test/demo data; no real invitations, pulses or notifications are created automatically.
6. Opposite-engine review, full `pnpm check`, `git diff --check`, real PostgreSQL suite for storage changes and Conventional Commits.

This document defines the approved first delivery. Operational signals and broader developer-experience measurement remain later work. Implementation and verification progress is tracked in the accompanying plan.
