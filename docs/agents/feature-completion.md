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

1. Five-metric presentation and workspace access management: delivered in `c18da86`, with full checks, PostgreSQL verification and opposite-engine review.
2. Strict common evidence contracts, private native basis binding and pinned reconciliation: delivered in `7b7289e`; new Argo snapshots retain exact private gap manifests and explicit unbounded transport uncertainty.
3. Durable private evidence ingress, measurement jobs/results and accessible application workflow: implemented and locally verified. Private capability grants, authenticated basis projection/report ingress, lifetime storage/pacing budgets, fenced leased jobs, immutable all-five results and owner/member browser workflows are present. Integrated checks, PostgreSQL verification and opposite-engine review pass; delivery is recorded by the accompanying commit.
4. Saved-result discovery/history: delivered with independent successful-result lookup and bounded cursor navigation. Measurement history extends that workflow. Real-source/operator setup is documented in [getting started](../getting-started.md) and [measurement evidence setup](../providers/connect-measurement-evidence.md); the integrated guide and local acceptance workflow have been reviewed and verified.

## Verified acceptance on 2026-10-11

- `pnpm check`: strict lint, all package type checks, 1,107 unit/component tests and the production browser build passed. `git diff --check` passed.
- Real PostgreSQL: 177 integration tests passed, covering authenticated ingress, immutable replay/conflict handling, all-attempt pacing, lifetime budgets, revoked source/producer/member fences, worker leases, history and invitation lineage.
- The actual GitHub collector exercised against controlled fictional GitHub responses, retained native basis and all four independent reports produces all five complete metric results with expected lead-time, failure and recovery values. This verifies application mapping, not live repository coverage or OEMS conformance.
- Running local application: signed-in owner selected the existing Argo sandbox basis, queued an independent measurement without authorities, ran `worker:measurement --once`, refreshed success and read the same saved result in Overview. Both cutoffs and the original window/revision are preserved; all five metrics correctly remain provisional with missing-evidence reasons. Member reads and owner-only actions are verified against real PostgreSQL; no new real member was invited for this smoke test.
- Claude independently reviewed Codex changes and final integration: no Critical, High or Medium findings. Request replay deliberately rechecks current authority/source eligibility; a retry after rotation can return 409, while recent-request discovery exposes the previously created run. The setup guide documents this fence.

The local MVP acceptance scope is complete. GitHub App verification, real producer activation and complete live coverage remain operator-dependent. Hosted deployment, hosted onboarding, automatic scheduling, incremental GitHub acquisition and OEMS conformance are outside this local MVP scope.


Each slice receives opposite-engine review and required checks before its Conventional Commit. Feature completion is established by verified acceptance, not by this plan or by source credentials being available.
