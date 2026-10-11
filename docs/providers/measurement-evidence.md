# Evidence-backed measurements

Clio now has a strict server-only report parser and a pure reconciliation engine for independent population, changes/history, classification and recovery evidence. The private native-basis reader binds these facts to a saved GitHub or Argo collection snapshot. Durable authenticated report ingestion, measurement jobs and browser measurement controls are the next slice; this document does not provide an available HTTP ingress endpoint yet.

Native provider results retain their original cutoff, coverage and classifications. Later evidence produces a separate validated snapshot at a new measurement cutoff, then the existing pinned OEMS calculator produces all five metrics. No metric semantics change. A synthetic test exercises actual GitHub capture through the private basis and four independent reports; it establishes implementation behavior, not real-source completeness or conformance.

## Required authorities

Configure each capability separately when durable ingress becomes available. Login OAuth credentials do not authorize evidence collection. An authority must have exact workspace/service/source scope, an explicit policy/version, allowed production paths and repositories, and a separate private producer credential. The API will supply receiver time and current grant eligibility; report claims cannot authenticate themselves.

| Capability | Evidence needed | Evidence that cannot substitute |
| --- | --- | --- |
| `population` | Exhaustive deployment census for actual service production paths and interval; exact native operation roster and every relevant retained gap resolved by independent evidence | An empty API response, successful transport, zero recorded gaps or one observed path when other paths exist |
| `change_links` | Complete actual deployed change sets, canonical repository/commit IDs, committer timestamps and sufficient service history origin | Deployed tip SHA alone, author time, first retained operation or nearby timestamps |
| `classification` | Independent failure and rework decisions with references for known positive and known negative decisions | Provider failure status, absent incident or failed workflow alone |
| `recovery` | Exhaustive onset-window episode census, exact causal qualifying failed native operation, service-restoration time or explicit open episode | Ticket closure time, source health or successful deployment alone |

Population is compared in both directions. An independent census finding a missing native operation blocks completeness and requires fresh collection; its report cannot create or qualify a deployment. Unknown native qualification remains unknown even with a reconciled census. Collection, history and recovery declarations remain independent.

## Report envelope

`parseMeasurementReport(unknown)` accepts exactly the `clio.measurement.evidence.v1` envelope: `contract`, `eventId`, `producerId`, `workspaceId`, `serviceId`, `capability`, `policyRef`, `evidenceRef`, `basis` and `payload`. Extra fields are rejected. UUID identities, pinned OEMS revision, UTC timestamps, SHA-256 basis digests, repository allowlists and exact operation identities are checked at their respective boundaries. Payloads are bounded to 8 MiB and 5,000 records per category; durable ingress must additionally enforce stable source-lifetime budgets.

The server-derived basis includes provider/run, normalized native source identity, connection revision, pinned OEMS revision and snapshot/evidence/gap-manifest digests. The whole private capture digest binds the exact repository/Application, service and saved connection input. Native operations use normalized `sourceId` plus `sourceDeploymentId`; the server maps these to existing canonical deployment IDs. Never derive identity by parsing provenance URIs, matching SHAs or matching timestamps.

Reports use opaque evidence references. References become valid hashed OEMS URNs; original report and receiver lineage remains in private snapshot extensions. Safe browser results must expose only validated metric objects and static assessment/context fields, never these extensions, private references or raw manifests.

## Immutable reconciliation

`deriveMeasurementEvidence` accepts a genuine validated native snapshot, server-owned context/native index/gap manifest, authenticated internal authority scopes, received reports and a new measurement cutoff. It does not authenticate transport, authorize a workspace, compute native digests or enforce durable revocation/storage. Its caller must perform those checks before invoking it.

A null gap manifest means exact retained gap identity is unavailable; an empty array means an exact empty manifest. New Argo worker snapshots retain private gap identities for native unsupported receipts, connection interruptions, archive entry gaps and recorded capture intervals. Every new Argo basis includes an unbounded transport-uncertainty gap, including live-only sources and periods before observation/archive startup. Gaps with uncertain time remain unbounded. Identical recorded archive intervals share one gap identity. A complete gap manifest means its uncertainty inventory is exact; it does not establish complete transport or collection. Truncated manifests or omitted capture intervals block completeness. Older Argo snapshots without the manifest cannot acquire complete collection coverage through this engine; collect a fresh basis first. GitHub partial transport becomes an explicit unbounded uncertainty requiring independent exhaustive reconciliation.

Select one immutable report per capability/basis. Exact replay is idempotent; conflicting reports or authorities fail closed. Corrections require a fresh provider basis and measurement. Known baseline facts and references remain; contradictory classifications, change timestamps/sets or recovery episodes fail. Missing reports keep unsupported coverage false and classifications unknown.

Pre-window deployments participate in first-deployment history. Redeploying the same commit creates no new lead-time observation. A configuration-only rollout may have an explicitly complete empty change set. Recovery onset selects the reporting window; a causal deployment may precede it, and restoration may follow it if known by the new cutoff. A nonempty recovery report arriving before its failure classification produces a recovery-classification blocker while unrelated population/history metrics remain usable. Open and approximate episodes follow pinned OEMS semantics and remain distinct from exact completed recoveries.

## Verification and remaining integration

Adapter tests cover complete five-metric fixture parity, independent empty census, missing/extra native operations, exact gaps, unknown qualification, pre-window history, redeployments, configuration-only sets, classification conflicts, recovery/open/approximate cases, cutoff availability, replay, source/repository scope and immutable basis data. API tests cover actual capture identity/digest binding; PostgreSQL tests verify private Argo gap retention, public-result exclusion and preservation after later receipts.

The next integration must authenticate machine credentials, recheck native and authority grants at admission/queue/completion, pin accepted report IDs/digests in durable jobs and retain immutable safe measurement results. Until that path exists and real operators supply valid authorities, native live coverage remains incomplete. Follow the [local feature-completion scope](../agents/feature-completion.md) for delivery status.
