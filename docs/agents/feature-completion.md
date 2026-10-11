# Local feature-completion scope

The maintainer requested continued implementation until feature complete on 2026-10-11. The working scope is the local Clio MVP; hosted onboarding, deployment, billing and automatic scheduling remain separate decisions. This expands the accepted first milestone without selecting a hosting model or changing the pinned OEMS standard.

## Acceptance

- Configure GitHub App/GitHub Deployments and Argo CD sources per service, with collection credentials separate from login.
- Collect and retain bounded native evidence durably, with rate-limit handling, replay protection, source-revocation fences and visible gaps.
- Present all five pinned OEMS metrics with their statuses, quality reasons, observations, bounds and coverage. Unsupported evidence remains unknown; saved legacy results remain readable without recomputation.
- Accept independently authorized, service-scoped population, change/history, classification and recovery evidence. Calculate a new immutable measurement at its own database cutoff; never add later facts to an earlier saved result.
- Browse saved measurement windows and collection results beyond the newest page. Workspace owners can inspect and manage members and pending invitations; revoked access takes effect immediately.
- Provide clear local startup, mock/demo, real-source configuration and troubleshooting guides. Verify positive and negative end-to-end cases and the actual PostgreSQL storage boundaries.

## Evidence-backed measurements

Provider collection results remain immutable native baselines. A separate measurement binds an exact successful provider run, workspace, service, source/connection identity, connection revision, OEMS revision, native snapshot digest, normalized evidence digest and retained gap-manifest digest. Server-derived native operation identities map to existing canonical deployment identities. Producers cannot create deployments, change qualification or infer identity from SHA/time proximity.

Four independently scoped capabilities support later evidence:

1. **Population:** an exhaustive census for explicit production paths and reporting interval. Its roster must reconcile both directions with relevant native records. Missing native operations require recollection. Every relevant retained gap needs an explicit independent evidence-backed reconciliation; an empty collector response is insufficient.
2. **Changes/history:** complete actual deployed change sets, canonical repository/commit identities and committer timestamps. Relevant pre-window deployments and sufficient history origin are explicit. Redeploying an already deployed commit creates no new first-deployment sample. Configuration-only complete empty sets are permitted.
3. **Classification:** independent failure and rework decisions for exact native operations. Known negative decisions need evidence; missing decisions remain unknown. Failed classification requires native production qualification.
4. **Recovery:** an exhaustive onset-window episode census with exact causal native operation, onset, restoration/open state and evidence. Restoration is service recovery, not ticket closure. Approximate onset follows pinned OEMS rules.

Admission, queueing and completion recheck current source and authority eligibility. Jobs pin accepted report IDs and digests. Receiver time determines report availability. Conflicting reports fail closed; initial protocol selects one immutable authority report per capability/basis. Corrections require a fresh basis and measurement. Previously completed measurements remain readable after authority revocation.

Authority configuration is private and capability scoped. Payloads, credentials, producer evidence references and native manifests remain server-side. Browser results expose safe context, assessment and the exact five calculated metric objects. Lifetime byte/count budgets belong to stable service/source identity, so rotating credentials or connection revisions cannot reset them.

The census proves collection scope only when independently exhaustive across actual service deployment paths. Unknown native qualification remains a metric-quality blocker even with a reconciled collection census. Collection, first-deployment history and recovery coverage are independent declarations. No fixture, transport success or unqualified empty response promotes live coverage.

## Delivery order and status

1. Five-metric presentation and workspace access management: implementation under integration.
2. Strict common evidence contracts, native basis manifests and pinned reconciliation: next bounded slice.
3. Durable private evidence ingress, measurement jobs/results and accessible application workflow.
4. Saved-result discovery/history, real-source/operator guides and complete local acceptance verification.

Each slice receives opposite-engine review and required checks before its Conventional Commit. Feature completion is established by verified acceptance, not by this plan or by source credentials being available.
