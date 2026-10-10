# Durable Argo history and outage reconciliation

Status: approved by maintainer, 2026-10-10. The maintainer instructed continuous implementation. This document defines the historical acquisition boundary; verification is recorded separately and no complete coverage is claimed.

Base: `5b9a70633c38b9bd79ba92861e6032404161366a`. OEMS remains pinned to `5908bb12cdf24e7528088237dff9dca4c10ff45f`.

## Intended outcome

Retain authentic Argo operation observations before delivery to Clio, recover them after a receiver outage, and show which reporting interval the retained source history supports. Configuration must work without an existing real deployment source. The first implementation uses controlled local producers and fixtures; a real operator can subsequently connect the same journal protocol.

This is the first sub-project toward documented collection, deployment-history and recovery coverage. It does not make all three flags true. Failure classification, incident onset/restoration and complete change linkage require separate evidence contracts. The existing activation/provenance demo remains useful evidence for one rollout, not proof of a reporting population.

## Existing constraints and approaches

Clio already retains immutable received native/enrichment evidence, interruptions, operation metadata locks and cutoff-fenced snapshots. GitHub already has leased collection with atomic history/checkpoint commits and durable rate-limit cooldowns. Reuse those patterns instead of adding another job framework.

Argo's [pinned 3.5.4 Application types](https://github.com/argoproj/argo-cd/blob/v3.5.4/pkg/apis/application/v1alpha1/types.go) define a bounded revision history, default ten entries, whose entries do not preserve the original operation-info UUID or historical health observations. Polling that history cannot reconstruct the native contract.

| Approach | Assessment |
| --- | --- |
| Source-side durable journal plus distinct historical import | Recommended. Retains original observations and explicit omission evidence; supports outage recovery without weakening live admission. Requires an operator-controlled producer. |
| Poll current Application and retain history observations | Useful future diagnostic fallback, but overwritten operations and missing original identity remain unknowable. Cannot establish complete deployment history. |
| Widen live terminal observation horizon | Rejected. Makes historical current-health observations look like contemporaneous native evidence and still cannot recover missing operations. |

Keep the existing ten-minute horizon for new live terminal receipts. Never fabricate operation UUIDs, infer historical health from current state, treat GitOps revisions as application commits, infer consumer exposure from health, or backdate database receiver observations.

## Authority and journal boundary

Introduce a separate `operation_archive` capability. Its private operator grant binds one producer UUID, independent credential, policy reference, journal UUID, native source UUID and the exact workspace/service/Application UID/Argo instance/environment/repository/destination scope. Native, exposure and build credentials do not authorize historical import. Credentials remain in owner-only files outside Git; browser users select only preconfigured sources.

The producer records each original observation durably before attempting delivery. Entries are append-only, strictly sequenced from one and scoped to one journal. Each entry contains contract version, journal/producer/source identity, sequence, previous entry digest, original capture time, original native notification payload and an opaque retained evidence reference. Its digest covers the canonical envelope including the payload and previous digest. Sequence reuse with different content conflicts permanently. A digest chain checks retained integrity; it does not prove that the source recorded every event.

The first producer is a local journal fixture CLI using an owner-only directory outside Git. It atomically persists and flushes entries before sending them, preserves entries after acknowledgement and stops on storage exhaustion. Its fixture mode is visibly fictional. An optional capture command accepts contemporaneous Application JSON through a local file, preserving actual operation metadata and unsupported outcomes; it never reconstructs old notifications from `status.history`. No arbitrary Argo API endpoint, Kubernetes credential or new service is introduced in this slice.

One exclusive writer lock covers append and send state. Preflight the complete serialized envelope against the 64 KiB request ceiling before append; wrapping a near-limit native payload may exceed that ceiling. Create entries exclusively, flush the file and containing directory before delivery, and recover an entry persisted before the local checkpoint update by validating its chain. Torn or divergent files stop processing with an explicit diagnostic; never skip or overwrite them. The initial local capacity is 5000 retained entries/seals and 8 MiB of serialized content; operators may lower it but cannot enable unbounded retention.

A journal seal is an immutable producer assertion about a closed UTC capture interval. It contains a seal UUID, journal startup time, interval start/end, first/last sequence, entry count, last digest, policy reference, capture interruptions and a retained evidence reference. Intervals use `[start,end)` and must end no later than server receipt time. Each seal starts at or after journal startup and the preceding sealed interval's end. Gaps between intervals remain explicit missing bounds; overlaps conflict. The sequence range starts immediately after the preceding sealed prefix and `count = last - first + 1`. An empty interval uses the next sequence as `first`, the previous sequence as `last` (zero before any entry), count zero and the preceding prefix digest (a defined all-zero digest before any entry). Every covered entry's capture time falls within that interval and the server requires the complete contiguous prefix before accepting a seal. Reusing a seal UUID with identical canonical content returns its original receipt; divergent reuse conflicts. Seals cannot erase interruptions or certify intervals before journal startup. The authenticated seal is an operator-trusted assertion, not independent proof of source completeness. In this first slice it remains diagnostic evidence and cannot promote OEMS coverage.

Journal startup is fixed at its first accepted record. Capture times must be nondecreasing with sequence. After sealing, a new entry whose capture time precedes the last sealed end conflicts; it cannot silently revise a prior seal. Seals contain at most 32 interruption intervals, each with bounded reason/reference fields, and the producer must split longer intervals into additional nonoverlapping seals. Seal count applies to that seal's incremental range, not the whole journal prefix.

Seal acceptance also checks already accepted entries beyond its range: if entry `last + 1` exists and its capture time precedes the proposed interval end, reject the seal. This covers delayed and empty seals; a prefix seal cannot claim an interval that already contains a later accepted entry.

## Historical import contract

Use a distinct machine route, `POST /api/argo/sources/:sourceId/archives/:producerId`, with early capability authentication, constant-time credential comparison, redacted failures, strict unknown-key rejection and a 64 KiB transport body ceiling. One request carries one entry or one seal. Required identifiers and timestamps use the existing UUID/UTC precision rules; references and payload fields retain existing bounded string limits.

Unconfigured archive routes use the same redacted 401 fallback as other machine routes. Configuration rejects credential reuse across native, enrichment and archive grants. Policy/journal identity is selected through trusted private configuration, not caller-controlled endpoints.

The server verifies full grant scope, journal identity, envelope digest and strictly contiguous sequence/previous digest. A later sequence returns an explicit predecessor conflict so the sender retries the missing prefix. An identical canonical retry returns the original receipt; divergent content conflicts. Seal acceptance requires its entire contiguous prefix and matching count/digest. No acknowledgement precedes durable commit.

Separate envelope integrity from native payload eligibility. An authenticated in-sequence entry with a valid envelope is retained and advances the archive checkpoint even if its native payload has invalid temporal metadata, scope drift or conflicts with a retained operation lock. Record an explicit bounded archive gap and create no native anchor; never overwrite the lock. This prevents one unsupported captured event from blocking all later history. Invalid authentication, envelope scope/digest/sequence/capture interval or exhausted storage does not advance the checkpoint. A permanently invalid entry envelope blocks that journal; the operator records an interruption in safe source diagnostics/configuration and starts a new explicitly configured journal period, preserving the old gap rather than rewriting committed entries. A blocked prefix cannot be certified by a seal. Rejected seals do not reserve their UUID/content and may be corrected before acceptance. Future capture caused by clock skew is a retryable rejection until trusted database time reaches it, not an instruction to abandon the journal.

Historical parsing uses a separate adapter entry point. Original capture time is the producer observation used to validate temporal consistency of the archived native payload. It must be no later than current database receiver time, no earlier than its operation start, and within the existing terminal observation horizon relative to finish when the payload contains terminal evidence. A trusted archive permits late delivery, not late reconstruction. The original capture clock remains a producer assertion; timestamp precision and ordering checks cannot prove it was honest.

Persist both original capture time and current database `received_at`. Canonical OEMS availability and snapshot selection use current receipt time. An archived event received after a cutoff is absent from that snapshot even when its deployment occurred before the reporting window. Exact retries do not change either timestamp. Native evidence references retain archive producer/policy/entry lineage through safe namespaced aliases.

The historical adapter accepts capture time and receiver time separately: only capture time validates the original terminal horizon; normalized deployment/status `observedAt` uses receiver time. A trusted producer could fabricate a seemingly valid old capture and operation ID; admission cannot detect that fabrication. Durable-before-send obligations and retained external proof belong to the selected producer's trust policy.

Archived and live observations share source-lifetime operation metadata and subject locks. Conflicting UUID scope/start/revision/kind/info/initiator is rejected across both transports. An identical native payload under the same current native fingerprint reuses its existing native receipt and earliest receiver availability, while appending the distinct archive entry/lineage at its own receipt time. It must not create a repeated-status gap, downgrade evidence or reserve normalized native rows twice. New archive storage still consumes its actual rows/bytes. Archive lineage and bounds cannot appear in a snapshot before the archive receipt time even when native evidence was already available. Preserve existing unsupported-shape/missing-identity gaps and valid retry/self-heal/unknown operation kinds; those kinds cannot independently confirm rollout exposure. Historical import does not synthesize enrichment; existing exact operation-bound exposure and artifact provenance rules still apply.

Connections explicitly select and pin the archive producer/journal policy and fingerprint as well as the native source fingerprint. Acceptance and snapshot completion revalidate the current selected archive grant, native grant, scope and connection revision. A valid archive import may create a new native anchor under those current pins without a prior live receipt; otherwise outage recovery would be impossible. Later enrichment may bind to that eligible archived anchor. Archive-derived receipts require both fingerprints for eligibility; previously live receipts retain their independent native eligibility. Do not retag old receipts after grant rotation. Retained immutable operation locks still prevent conflicts. Prior snapshots remain readable. This slice does not introduce cross-fingerprint continuity certification or correction of accepted facts.

New archive-derived native receipts explicitly store the native fingerprint current at admission and the archive fingerprint separately. A native token rotation between original capture and first archive delivery can admit a new receipt under current authority when exact scope still matches; it cannot relabel a previously stored receipt. Scope drift produces a retained archive gap. Exposure received before recovery returns the existing retryable missing-anchor conflict; retry after an eligible archived anchor succeeds without creating a fabricated operation.

If the same `(source, Application UID, operation UUID, notification revision)` already exists under a different native fingerprint, retain an explicit cross-fingerprint archive gap and advance the journal checkpoint; create no new native receipt or authority. Preserve the existing notification identity index and source-lifetime repeated-status checks. This conservative rule also applies when archive-first/live-second delivery crosses a native rotation: live admission retains existing conflict behavior, not authority relabeling. Document that rotating an archive credential removes its archived-only observations from new snapshot eligibility; prior snapshots remain immutable. Recovery of history across rotations is outside this version.

For archive-first then live-second delivery, preserve a separate immutable live-arrival authority record with its actual database receipt time. Reuse normalized content, but independently parse that first live arrival against the current live observation horizon; an old terminal payload cannot gain native-only authority through the replay shortcut. A valid live arrival makes native-only eligibility available from that later time, never retroactively. Subsequent exact live retries return that live authority record without creating another. If archive authority is revoked, only independently eligible live observations remain usable; an archived-only observation cannot survive by being relabeled as live.

Reconciliation derives canonical `observed_at` from the earliest eligible authority lineage at the selected cutoff, not an ineligible transport's earlier timestamp. Archive-first/live-second with revoked archive authority therefore uses the later live availability time. Stored arrival timestamps and already completed snapshots never change.

## Durable reconciliation and bounded storage

Add archive entries/seals and source journal checkpoints through new append-only migrations. Keep inbound archive admission separate from the existing snapshot worker. A local journal sender holds an exclusive journal-directory lock, persists attempt/acknowledgement state atomically, resumes from the last acknowledged sequence and retries the same immutable entry after timeout or lost acknowledgement. It releases its lock on process exit and retains resumable state after a crash. Clio's existing snapshot worker consumes accepted history with its existing database lease and no outbound network requests. No second server acquisition worker is needed for this push protocol.

Entry acceptance, current scope/grant checks, lock reservation, shared budget reservation, normalized native receipt or explicit archive gap and contiguous checkpoint advancement commit atomically. A failed transaction leaves no acknowledged prefix. Server restart recovers the committed prefix. A sender crash before recording an acknowledgement causes an exact retry, not a second receipt. Incomplete prefixes/seals remain visible diagnostics. Database leases remain on snapshot capture/completion, not inbound admission.

Use the existing per-source durable token bucket, shared with native and enrichment ingress, and respect `Retry-After`. Archive admission additionally uses a source-lifetime sub-bucket capped at 15 requests/minute with burst two, and can consume a shared token only while leaving at least two shared tokens available. Both reservations are atomic; rotating archive credentials cannot reset this pacing state. Backlog drain is at most 15 entries/seals per minute, slower when live traffic competes. This reserves headroom against archive drain, not a guarantee against arbitrary live bursts. Journal senders use bounded exponential retries with jitter and a finite per-run attempt budget. A throttled or interrupted attempt remains resumable; it never declares successful reconciliation. The archive capability cannot bypass rate admission by calling receipt internals directly.

All new retained entry/seal/diagnostic bytes and rows, including serialized snapshot headroom, count against the existing shared source-lifetime 5000-row/8 MiB ceilings. No silent pruning, budget reset through producer rotation or automatic unbounded backfill. Admission stops explicitly on exhaustion; exact replay adds no storage. A fresh source starts a separate incomplete period. Source journal files also have configured finite local capacity and must fail visibly before accepting an entry they cannot retain.

Charge one retained row for journal registration and one per entry/seal, plus existing native/evidence rows only when newly inserted. Charge persisted canonical JSON byte length and an explicit bounded metadata representation for those rows; checkpoints use one fixed-size current state rather than append-only attempt logs. Reserve the archive contribution to one serialized snapshot at admission, as existing enrichment does; do not charge each future snapshot again against source lifetime. Public diagnostics contain only latest seal/status, total missing-interval count and at most 32 interval summaries with an explicit omitted count. All references/interval fields are bounded and diagnostics remain within the existing 64 KiB result ceiling; no truncation may be presented as absence of gaps.

The archive envelope and existing native canonical representation may both be retained. Charge both actual representations rather than promising 5000 operations fit; typical new operations also reserve entry, receipt, deployment and status rows plus metadata/headroom. Source capacity can therefore exhaust earlier than the row ceiling. Report remaining row/byte budget safely to operators before drain; do not advertise indefinite historical retention.

## Reporting and OEMS boundary

Expose safe archive status: journal identity, policy label, last acknowledged sequence, latest sealed capture interval, last successful reconciliation time and missing/interrupted intervals. Do not expose tokens, raw notifications or private evidence references. Distinguish the reporting window, evidence cutoff and journal capture bounds; none is a synonym for another. Browser owners cannot toggle completeness.

Last successful reconciliation means the database receipt time of the latest accepted seal whose claimed prefix is retained, including any explicitly recorded payload gaps. It is transport progress, not complete source or metric coverage. A partial unsealed drain has checkpoint progress but no new successful sealed interval.

Snapshot archive diagnostics are copied at the snapshot cutoff and remain immutable. Current source status may advance independently. Existing result readers must continue to accept older stored results without archive fields; absence means unknown archive coverage, not an empty complete journal.

All three OEMS coverage flags remain false in this sub-project. Per-deployment change linkage stays incomplete. Failure and rework remain unknown unless already supported by independent evidence. Archive delivery can recover native observations; it does not establish consumer exposure, population completeness, first deployment of changes or service restoration. Zero gaps, a contiguous journal, an empty response or a completed sender run cannot alone establish any coverage flag.

Later coverage work must record documented reporting population and interval/policy authority independently for collection, deployment history and recovery. Deployment-history evidence must support first-deployment decisions, including relevant history before the reporting window. Recovery evidence must cover the failure-onset cohort and causally correlated qualifying deployments, including relevant deployments before window start. Dataset-level flags cannot represent mixed service coverage without separating datasets.

The subsequent failure/recovery contract must preserve explicit deployment correlation, unknown versus failed/not-failed decisions, actual versus approximate onset, nullable restoration and receiver-time revisions. Argo Failed/Error/Degraded does not prove a failed production deployment; closing a ticket does not prove restored service. Later restoration may enrich a new snapshot only. That contract and complete-coverage promotion require their own written design before implementation.

## Acceptance and operator documentation

Required behavior tests include PostgreSQL persistence and real transaction/lease boundaries, not only parser constants:

| Scenario | Required result |
| --- | --- |
| Receiver unavailable while producer retains an operation | Entry survives; later historical import succeeds with current receiver time; live horizon unchanged. |
| Crash after commit but before sender acknowledgement | Original retry returns original receipt and timestamp; one canonical rollout. |
| Missing sequence, divergent duplicate, wrong chain/count/seal | Visible conflict; no checkpoint advancement or completeness claim. |
| Old event reconstructed from current Application/history without original identity | Explicit unsupported payload gap; no fabricated identity or historical health. Producer fabrication remains a documented trust limit. |
| Archived observation captured within horizon but delivered later | Historical import eligible; identical live new arrival still fails its horizon. |
| Future envelope capture time | Envelope rejected, checkpoint unchanged; no clamping/backdating. |
| Valid envelope with capture before native start or late terminal capture | Retained temporal payload gap, checkpoint advances; no native anchor. |
| Live/archive UUID metadata disagreement | Retained archive conflict gap and advanced checkpoint; native lock unchanged across transport/rotation. |
| Scope/revision/grant changes during commit or capture | Fence prevents mixing evidence; prior snapshots unchanged. |
| Concurrent admission, rate throttle, finite storage exhaustion | Shared budgets enforced; retry resumable; no silent loss or reset. |
| Event arrives after cutoff; later snapshot requested | Earlier result unchanged; later snapshot may include event. |
| Empty sealed interval, complete chain or zero visible gaps | Archive diagnostics available; all OEMS coverage flags still false. |
| Older result lacking archive diagnostics | Readable with unknown archive state. |
| Native credential rotated between capture and first historical import | New receipt uses current native plus independent archive fingerprint; existing receipts never retagged. |
| Exposure arrives before archived operation | Retryable missing-anchor conflict; original exposure retry succeeds after eligible recovery. |
| Archive backlog draining while shared bucket has reserved headroom | Archive pacing preserves two tokens; a live request can use them under existing admission rules. |
| Unsupported payload followed by valid operation/seal | Payload gap retained; later sequence and seal still accepted. |
| Existing live receipt, native rotation, identical archive delivery | Cross-fingerprint archive gap, checkpoint advances; no index violation, authority relabeling or indefinite retry. |
| Delayed prefix/empty seal excludes an already accepted entry inside its interval | Seal rejected; existing journal entries preserved. |

Also cover native-first versus archive-first exact payload delivery, separate lineage cutoffs, multiple/empty seals, capture after seal with a backdated timestamp, envelope-size overflow, crash before local checkpoint update, torn files and concurrent local writers. Database admission must preserve existing workspace/source lock order and serialize concurrent journal registration/sequence claims.

Test archive-first/live-second authority with archive grant revocation, cutoffs before/after the live receipt, stale first live arrivals and exact live replay. Immutable live-authority rows and their snapshot admission reserve count against shared lifetime budgets.

Document both fictional setup and real source obligations: original operation identity, producer capture clock/trust, durable-before-send storage, explicit scope/policy, bounded capacity, failure handling, recovery after receiver outage and inability to recover pre-journal history. Include one local outage walkthrough with retained entries and immutable before/after snapshots. Do not advertise real-source history capture until an actual producer and its capture mechanism have been verified.

No incident tool, hosted topology, outbound polling authority, scheduling service, retention deletion policy or new dependency is selected here. Implementation planning follows maintainer approval of this written contract.
