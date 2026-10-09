# Canonical data model

Status: adopted v0.1 working-draft contract under [RFC 0002](../../rfcs/0002-v0.1-preview-contract.md). This is not a stable release.

IDs MUST be unique across record kinds in one dataset. Preserve namespaced provider identity in provenance; similar names and project-local numeric IDs are not safe join keys.

## Identity and production effectiveness

A service is a logical deployable unit. A deployment is one canonical rollout for one service, identified by (service_id, rollout_group_id). Subordinate region, tenant, host and job outcomes belong in extensions or source evidence, not separate canonical deployment records. Different deployment IDs for the same service/rollout MUST be rejected as unresolved aliases before calculation.

A qualifying rollout changes the version or configuration experienced by production consumers. effective_at is the earliest confirmed instant of that exposure. A canary serving real production consumers qualifies at first exposure. A dark release with no consumer effect is excluded until exposure is confirmed; builds and staging runs are excluded. A later partial rollout failure does not erase an effective rollout. A rollback is a separate rollout if it changes the effective production version/configuration. Adapters MUST document the source evidence used to confirm exposure.

A change is identified by (namespaced repository_id, commit_id), with one canonical change ID and committer timestamp. Different IDs for one repository/commit MUST be rejected; collectors reconcile them before emitting the snapshot. The same change can have a distinct first-deployment observation for each service.

An incident is one service recovery episode. A shared incident may emit one episode per affected service with distinct IDs and a shared source incident reference.

## Snapshot and semantic constraints

- Each record carries observed_at: the time its selected revision/evidence became available. It MUST be no later than evidence_cutoff. Actual committed, effective, failure-onset and restoration timestamps MUST be no later than that record's observed_at.
- Repeated records with the same ID and identical content are deduplicated. Conflicting records MUST be rejected; array order never selects a revision. Array order is significant when deciding whether duplicate JSON records are identical; producers should canonicalise their arrays before emission.
- Service references MUST resolve; missing scope is invalid. Missing change or causal-deployment references are disclosed as unresolved evidence and make the affected metric provisional.
- A qualifying deployment MUST have environment=production and a non-null effective_at. An excluded attempt MUST have effective_at=null. A failed classification requires a qualifying deployment.
- qualification_window MUST be null for known qualification. For unknown qualification it is either a half-open interval of possible production effectiveness or null. A non-null effective_at MUST fall inside a supplied qualification_window. Unknown qualification is never counted as qualifying.
- To assign unknown qualification to a reporting window, use overlapping qualification_window if present, otherwise effective_at if known, otherwise unbounded scope. Unbounded records affect every requested window for that service. Do not substitute collection time for production effectiveness.
- change_links_complete is an explicit evidence assertion per deployment. A complete empty change list means no commit observations, for example a configuration-only rollout. An incomplete empty list means missing linkage. Unknown or missing linkage in relevant history can hide a first deployment.
- A resolved change's committed_at MUST NOT follow any qualifying deployment that links it.
- failure_evidence_refs and rework_evidence_refs MUST be non-empty for known classifications. These reference the classification decision or evidence, rather than merely the existence of a pipeline run.
- A causal deployment, when resolved, MUST name the same service, MUST NOT be excluded and MUST NOT assert no_recorded_failure. Unknown qualification/failure leaves eligibility unresolved. An eligible episode requires qualifying and failed classifications.
- Failure onset MUST NOT precede a resolved causal deployment's effective_at. Restoration MUST NOT precede onset.

Source references need not be public. Semantic validators MUST NOT dereference arbitrary URLs. Full provider payloads and personal contributor identity are not required.
