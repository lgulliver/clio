# ADR 0009: Scoped Argo notification ingestion

Status: accepted by maintainer, 2026-10-10. Implementation verification is recorded separately.

Clio needs GitOps deployment evidence even when GitHub Deployments is not the production source. Use authenticated native Argo notifications first, with immutable scoped receipts, explicit unsupported-operation gaps and owner-requested closed UTC snapshots. Private operator grants bind an Application UID and complete scope tuple to one workspace/service. Login OAuth remains identity-only. No arbitrary outbound Argo URL client or hosted ingress model is selected.

Require explicit operation UUID info because native current operation state has no universal operation identifier. SHA equality cannot establish operation identity. Preserve operation kind, retry provenance and trusted receiver observations; configuration revision is not application-source provenance. Native consumer exposure is false and all initial coverage remains incomplete. OEMS semantics and the existing contract revision remain unchanged.

Notifications may be lost and native health reflects Application state. Retain authenticated unsupported events as bounded gaps, use a short terminal observation horizon and never infer complete delivery from zero gaps. Bound immutable storage/rate and fail closed on exhaustion; preserve history rather than automatically prune it. Snapshot workers use database leases, revision/grant fences and atomic completion.

See [approved design](../superpowers/specs/2026-10-10-argo-ingestion-design.md), [exact contract](../providers/live-argo-contract.md) and [operator setup](../providers/connect-argocd.md). Polling/backfill and enriched exposure/provenance remain later reviewed contracts.
