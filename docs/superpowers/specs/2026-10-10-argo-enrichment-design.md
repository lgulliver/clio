# Argo consumer exposure and application provenance

Status: proposed implementation contract, prepared for the maintainer's requested design slice. Enrichment ingestion and qualification are not implemented. Native notification ingress remains unchanged.

Base: `d8d6d742da3aebd87a6c280c6b8cf71153b50466`. OEMS remains pinned to `5908bb12cdf24e7528088237dff9dca4c10ff45f`.

## Outcome and scope

Allow an explicitly trusted producer to establish that one retained Argo rollout changed the version or configuration experienced by production consumers. Allow a separately trusted build producer to associate immutable artifact content with an application-source commit. Only an operation-bound artifact exposure can attach that build provenance to a rollout. These are independent assertions. Keep native notifications, provider credentials, snapshot reconciliation, standard calculation and browser presentation separate.

This document defines the contract and its implementation acceptance tests. It does not configure a real producer, deploy an ingress, add a receiver, grant access or change existing metric behavior. No real source or exposure policy is available yet; the first implementation should use controlled fictional producers before operator-selected live integration.

## Standard constraints

The pinned [canonical model](../../../packages/oems/vendor/specification/v0.1/canonical-data-model.md) defines qualification by confirmed production consumer experience and `effective_at` by its earliest confirmed instant. Canary exposure qualifies; later partial failure does not erase it. A rollback that changes consumer experience is a distinct rollout. Argo sync completion and health do not establish exposure. GitOps configuration revision is not an application commit.

Exposure without application provenance can qualify a configuration rollout. Provenance without exposure cannot qualify one. Application tip provenance alone does not establish OEMS changes, committer timestamps, complete commit linkage, complete history, failure causation, rework or recovery. Preserve provisional quality and null unsupported measurements under the pinned metric definitions.

## Approaches and selected recommendation

1. **Separate capability-scoped enrichment producer, recommended.** A release gateway, traffic controller or audited release hook reports consumer activation; a CI/build attestation producer reports artifact provenance. Exact operation binding, independent credentials and private evidence references make authority explicit. More receiver/storage work, but no mutation of native truth.
2. **Add assertions to native operation info.** Easy to transport, but native notification authentication does not prove that an arbitrary operation-info writer controls production traffic or knows artifact provenance. Reject this as an automatic qualification mechanism.
3. **Poll health or infer from GitHub/Argo SHA equality.** Does not establish consumer experience or canonical rollout correlation. Leave unsupported.

The first implementation should accept a generic operator-controlled release-hook producer and a generic build-attestation producer. Actual tools and deployment topology remain configurable; no particular Argo extension, registry, CI vendor, paid service or hosting model is selected.

## Authority and configuration

Each private operator grant binds a producer UUID and separate random credential to a native source UUID, workspace/service, stable Argo instance, complete Application UID/name/namespace/project/destination scope, configuration repository, environment and versioned evidence policy. Each grant allows exactly one capability: `consumer_exposure` or `application_provenance`. V1 requires distinct producer IDs and credentials for these capabilities; native ingestion credentials cannot authorize either. The same system may hold both credentials only through explicit separate grants; credential separation does not prove organizational independence.

An exposure policy describes the consumer-visible activation signal and what the producer can verify: for example routing to the newly deployed immutable artifact, or activation of changed production configuration. Deployment hooks must emit only after that signal is confirmed. Merely observing Healthy, Succeeded, an environment label, a pipeline completion or an unchanged traffic heartbeat does not satisfy this policy. Operator grants establish trust in this producer; a bearer credential is not cryptographic proof of the claimed external event.

Provenance grants additionally allow explicit namespaced application repositories and artifact digest algorithms. A build statement must identify immutable artifact content and the source commit from which it was built. It does not claim an Argo operation deployed that artifact and may arrive before any native operation exists. A mutable image tag, GitOps SHA, matching names or timing cannot establish this binding. Evidence references point to retained operator-managed proof; Clio must not dereference arbitrary supplied URLs.

API and worker load immutable private configurations, validate owner-only files outside Git and restart together after changes. Future connection revisions must pin selected policy/producer grants and fingerprints. Browser owners select only granted capabilities; members read safe configuration/results. No arbitrary endpoint, credential or raw attestation form.

## Proposed wire contract

Proposed machine route: `POST /api/argo/sources/:sourceId/enrichments/:producerId`. Authenticate the exact source/producer capability before parsing JSON. Look up the per-producer credential digest and compare in constant time, using a fixed dummy digest for unknown IDs; unknown source/producer, absent configuration and incorrect credential produce the same redacted 401. There is no cookie, query-token or login-OAuth authorization path.

Every object rejects unknown keys. The 64 KiB body limit is enforced at transport without JSON parsing; header authentication is early and parsing never precedes authorization. Body is at most 64 KiB; evidence reference and opaque identifiers are nonempty strings bounded to 200 Unicode code points, repository identity to 2048. Event/source/producer/operation IDs are canonical UUIDs; Application UID must exactly match the native grant. UTC timestamps preserve up to six fractional digits. SHA-256 artifact digests use `sha256:` followed by 64 lowercase hex digits; initial application commit SHA uses 40 lowercase hex digits. Configuration revisions remain opaque nonempty strings.

```ts
type Enrichment = {
  contract: 'clio.argocd.enrichment.v1';
  event_id: string;
  source_id: string;
  producer_id: string;
  policy_reference: string;
  evidence_ref: string;
} & (
  | {
      kind: 'consumer_exposure';
      application_uid: string;
      operation_id: string;
      configuration_revision: string;
      effective_at: string;
      subject:
        | { kind: 'artifact'; digest: string }
        | { kind: 'configuration'; revision: string };
    }
  | {
      kind: 'application_provenance';
      repository_id: string;
      commit_sha: string;
      artifact_digest: string;
    }
);
```

Source/producer IDs must match the route and grant; policy reference must match the capability's versioned policy. Workspace/service/environment/instance and receiver observation are assigned from trusted configuration/database, never chosen by the body. For configuration exposure, subject revision must also match `configuration_revision`. Artifact exposure binds only that digest. Build provenance is identified by namespaced repository, commit and immutable artifact digest; it has no Application/operation/configuration fields. Attach it to a rollout only through an accepted artifact-subject exposure with an identical digest. A configuration-subject exposure, or missing exposure, attaches no build provenance in v1. Independently attesting an artifact deployed without consumer exposure would require a separate deployed-artifact capability, outside this version. This first version intentionally supports one exposure subject per operation; multi-artifact rollouts need a separate contract.

Both event kinds require a current authorized native source connection and their selected producer grant. Exposure additionally requires a retained supported native operation with exactly matching source, Application UID, immutable operation UUID and configuration revision under the current native scope/fingerprint. Build provenance can be accepted before a deployment and remains unbound until matching artifact exposure exists. Exposure requires native explicit `operationKind: rollout`; retry, self-heal and unknown do not become a rollout through enrichment. Subject activation/change evidence belongs to that operation, not merely that configuration SHA.

If an exposure event's native binding is not yet retained, return a redacted retryable binding conflict. Do not create a synthetic operation or retain an unbounded pending mailbox. A producer retains the original event and retries after the native receipt exists. This also handles exposure during a running operation: publication may occur after terminal anchoring while retaining the earlier true exposure time. Native terminal-only delivery remains an acquisition limitation, not an OEMS rule about effectiveness.

For exposure, enforce native `started_at <= effective_at <= database observed_at`. Do not impose the native ten-minute terminal horizon on independent activation: consumer exposure may follow reconciliation substantially later. Do not substitute native finish/health transition time or collection time for effectiveness. A failed/degraded terminal operation can qualify when independent policy-backed exposure occurred; the enrichment path must not forge Succeeded/Healthy or require those native conditions. Failure classification still remains unknown without separate causal evidence. Do not automatically impose the next retained operation's start as an upper bound: overlapping reconciliations can activate out of start order. Exact operation/subject attribution and consumer-visible change remain the trusted exposure producer's responsibility. Later operation timing alone cannot prove or change that attribution; false assertions by an authorized producer remain a trust limitation.

## Immutable storage, replay and conflicts

Store append-only normalized enrichment and a canonical digest, capability/scope fingerprints, policy identity, trusted database receiver observation, event identity and, for exposure, exact native operation binding. No credential or private-file path enters SQL or public results. Native receipts retain `consumerExposure:false` and null application provenance exactly as acquired.

Exact authorized event replay returns the original acknowledgement and observation, including after elapsed publication time. A reused producer/event UUID with different content conflicts. Removing/revoking a grant, disconnecting or changing current scope blocks replay too. Revalidate current native connection and producer capability inside the acceptance transaction. Authorized replay requires the original receipt fingerprint to remain eligible; it never relabels an old receipt with a new credential fingerprint.

The first accepted exposure locks its subject for that source/Application/operation across producers, policy or credential rotations. A different artifact digest, different configuration subject or artifact/configuration kind switch conflicts. Multiple valid observations of the same subject for that operation can confirm different instants; select the earliest confirmed instant available at cutoff. They never create additional canonical deployments. Heartbeats without evidence of consumer-visible change are not valid exposure events. For a digest within one native source lifetime, across producer grants and rotations, a different repository/commit assertion conflicts with existing provenance. This conservative v1 contract rejects ambiguous artifact-to-source mappings even if identical bits could legitimately arise from different builds; it has no build-selection or correction protocol. Reject the new incompatible assertion; never select by array order or last write wins. Retain original evidence and prior snapshots. Explicit correction/invalidation is outside v1; rotating a credential does not declare previously recorded facts false. Enforce subject and provenance locks transactionally with unique keys and serialized checks: `(source_id, application_uid, operation_id)` maps to one subject; `(source_id, artifact_digest)` maps to one repository/commit assertion. Lock creation, budget reservation and receipt insertion are atomic; concurrent conflicting requests cannot both pass a read-then-insert check.

Use the implemented PostgreSQL source token bucket before JSON parsing, shared across all native and enrichment producers and API instances. Return the native redacted throttle response with `Retry-After`; retries must respect it. Use native source-lifetime rate/storage budgets for combined native receipts, normalized evidence and enrichment rows/bytes. New enrichment acceptance cannot reset exhausted budgets through another producer or token. Exact retries consume no extra budget; owner disconnect remains available at exhaustion. No pruning or automatic cross-source merge.

Grant rotation is an explicit interrupted period. New connection revisions pin current native and enrichment fingerprints; receipt eligibility requires those exact fingerprints and full scope. Credential changes cannot mix old/new truth automatically. Prior snapshots remain readable and immutable. An unchanged authorized grant may reuse matching prior evidence; a fresh source UUID starts a separate incomplete period. Record interruption boundaries with the existing one-per-boundary rule. After rotation, retained subject/provenance locks still reject conflicting claims, while old-fingerprint receipts are ineligible for new joins. Re-assert unchanged facts with a fresh event UUID under the current grant; never change their original effectiveness. Exposure still requires an eligible native anchor, so native-grant rotation can also require a fresh supported native observation or a newly identified rollout. Re-assertion is not automatic replay or history retagging.

## Snapshot join and OEMS mapping

Read native and enrichment receipts under the same database cutoff and transaction/lease fences. Select both by original receiver observation, not producer event time. A valid old event observed after cutoff is unavailable to that snapshot. Its later arrival can enrich a new result only.

Do not insert a competing native deployment revision or mutate native repository fields: Argo deployment core is immutable, and current native history parsing deliberately rejects true exposure and non-null application provenance. Introduce a separate validated enrichment collection at the reconciliation boundary. Join exposure by exact source/Application/operation/configuration binding, then join eligible build provenance by that exposure's immutable artifact digest within the same source and pinned grants. Provenance does not independently assert a deployed-artifact binding. SHA equality never correlates other operations or providers.

Maintain the same canonical `(service_id, rollout_group_id)` derived from the native operation. Independent eligible exposure sets environment production, qualification qualifying and earliest confirmed `effective_at`. Combine every eligible native/policy/exposure/attached-provenance reference, deduplicate and sort references lexicographically. Preserve all agreeing eligible producer assertions, ordered by `(producer_id, event_id)` rather than selecting a single publisher by row order. Use the latest selected mapping/native/exposure/attached-provenance receiver observation for canonical `observed_at`. Unbound inventory does not affect a deployment's observation. Native success/health remain provenance, not requirements for this independent decision.

Attached provenance is a separate artifact/source extension with build producer, artifact-exposure reference and build evidence reference. Unbound build inventory and configuration-subject exposure do not populate this extension. Do not replace GitOps configuration provenance or invent `changes`. Keep `change_ids:[]`, `change_links_complete:false`, `failure:unknown`, `rework:unknown`, no incidents and all three coverage flags false. Provisional observed deployment count may increase; normalized deployment rate, lead-time median, failure/rework ratios and recovery time stay unavailable where their evidence requirements are unmet.

Completed snapshots/results remain immutable. Claim, cutoff capture and atomic completion must revalidate current native/enrichment grants and connection revision under an unexpired worker lease. Unsupported/missing enrichment preserves native unknown qualification; zero enrichment events proves neither no exposure nor complete delivery.

## Implementation and fixture acceptance

Before a live producer is advertised, implement private capability parsing, a new append-only migration (never alter 0006), authenticated bounded ingress, exact binding/replay/conflict guards, snapshot join and safe result/UI policy labels. An operator must deliberately configure a real evidence producer and reachable trusted HTTPS receiver. Native notification ConfigMap alone is insufficient.

Required fixtures and PostgreSQL regressions:

| Evidence | Required result |
| --- | --- |
| Healthy/Succeeded without enrichment | Unknown qualification |
| Build provenance before any native operation, or without exposure | Accepted unbound inventory; native qualification unknown; no deployment attachment or changes/linkage |
| Matching artifact exposure after build provenance | Attach exact-digest provenance only; no new rollout or complete linkage |
| Build provenance arrives after matching exposure | Later snapshot attaches exact-digest provenance; earlier exposure decision unchanged |
| Exposure before cutoff, matching provenance after cutoff | Earlier snapshot qualifies without provenance; later snapshot attaches it; old snapshot immutable |
| Configuration-subject exposure with build inventory | Qualifying configuration rollout; no application provenance attached |
| Confirmed configuration-only production activation | Qualifying; no application commit required |
| Canary exposure before completion, then Failed/Degraded | Qualifying at first exposure; failure unknown |
| Same configuration SHA, two operation UUIDs | Separate canonical operation identities; qualification requires independent consumer-visible change for each; replay does not add one |
| Exposure/native anchor arrive in reverse order | Binding conflict then successful original retry; no fabricated operation |
| Evidence received after cutoff | Earlier snapshot unchanged; later snapshot can qualify |
| Wrong UID/configuration/subject/policy or capability | Rejected before evidence can join |
| Provenance-only credential attempts exposure | Rejected |
| Same digest/source lifetime, incompatible repository or commit across producers | Conflict, including rotation; no last-write-wins |
| Same operation, different artifact digest or artifact/configuration subject switch | Conflict; existing subject remains immutable |
| Concurrent conflicting exposure subjects or digest→commit assertions | Exactly one accepted under database uniqueness/serialization; other conflicts atomically |
| Agreeing producers arrive in opposite orders | Same sorted references/assertions and effective instant at fixed cutoff |
| Rotated credential, old receipt and new conflicting assertion | Old receipt ineligible; lock still conflicts; unchanged fresh-UUID re-assertion needs eligible native anchor |
| Earlier-started operation activates after a later operation starts | No timing-based reassignment; only exact trusted operation/subject activation evidence can qualify |
| Future exposure or exposure before operation start | Rejected without clamping |
| Revocation/disconnect during acceptance or job completion | Current transaction/lease fence rejects |
| Retry/self-heal/unknown native operation | No qualifying rollout from enrichment |
| Complete native REST/notification transport, incomplete metric evidence | Coverage remains false; unsupported metrics null |

Controlled producer tests must demonstrate evidence timing/subject assertions independently of Argo health, bounded retries and native/enrichment identity propagation. A mocked parser or a manually set true boolean is not live exposure proof.
