# Argo coverage evidence and next collection contracts

Clio retains observations, reconciles independent exposure and build provenance, and calculates pinned OEMS results. Continuous acquisition and historical replay are implemented. Complete metric coverage is not established.

New Argo results save a coverage assessment alongside the immutable reporting window and database evidence cutoff. Settings and Overview show that saved assessment. Reading or refreshing an old result never recomputes it against newer receipts; old results without an assessment remain readable and explicitly show that limitation. Save another collection result to assess newer evidence. No migration or operator configuration change is required for this diagnostic feature.

## What the assessment measures

| Saved count | Scope | Meaning |
| --- | --- | --- |
| Recorded qualifying deployments | Reporting window `[start,end)` | Actual independently confirmed consumer exposure within the window; provisional observed population, not the total production population |
| Unknown qualification | All retained deployment history at cutoff | A retained operation has unresolved qualification; not a count restricted to the reporting window |
| Qualifying history | Effective exposure before reporting window end | Includes pre-window deployments needed for first-deployment decisions; excludes exposure exactly at the exclusive end |
| Incomplete change links | Qualifying history before window end | An exhaustive application change set has not been established; artifact→commit provenance alone is insufficient |
| Unknown failure/rework classification | Recorded qualifying window population | Actual production failure or incident-driven rework classification remains unknown; Argo phase and health do not decide these classifications |

Current population, first-deployment history and recovery authorities are not supplied by an implemented collection contract. The assessment describes those missing boundaries; it is not a new assertion API or a completeness toggle. Counts remain separate from retained receipt totals, source-lifetime gap counts, archive bounds and policy labels. No private operation IDs, native payloads, producer references or credentials enter the assessment.

Independent exposure can resolve a retained operation's qualification in a later result. Build provenance can establish an artifact's repository/commit without enumerating its complete change set. Neither supplies the reporting population or relevant first-deployment history. Zero qualifying deployments, zero unknown classifications, a contiguous journal or an empty watch/list cannot prove completeness. All three OEMS coverage flags remain false.

## Next boundary: authoritative deployment census

The next population contract must be independently authorized and scoped. It needs:

- A documented authority covering every production deployment path for the selected service/environment, including other Applications, manual deployments and traffic changes. One selected Application does not establish exclusivity.
- A closed census interval with exact Application UID/source/producer/policy lineage and retained evidence. Population is based on effective exposure time, including operations started before the interval that become effective inside it.
- A bounded explicit operation roster with exact native metadata/configuration binding and retained/excluded/unresolved dispositions. Matching SHA or nearby timestamps cannot substitute rollout identity.
- An explicit start baseline, acquisition mechanism and missing-period declarations. Empty roster needs positive authority/evidence; it cannot be derived from an empty response.
- Immutable authenticated admission, exact replay/conflict handling, shared source rate/storage limits and database receiver-time cutoff eligibility. Rotation and source drift remain explicit interrupted periods.
- Reconciliation blockers for missing anchors, incomplete or conflicting rosters, acquisition gaps and unavailable authority. Journal seals remain capture assertions rather than population authority.

That contract is not implemented by the diagnostic assessment. A later reviewed population collector can establish collection coverage only after positive, negative and empty-population proofs pass. First-deployment history/change linkage and causal failure/service-restoration coverage require separate evidence contracts. Normative OEMS semantics and revision remain unchanged.

## Verification

Tests cover half-open window boundaries at microsecond precision, pre-window qualifying history, build-only evidence, independent exposure, contradictory/private wire fields and older-result compatibility. Real PostgreSQL verification checks exposure arriving during cutoff capture: only the later result's assessment changes, while the earlier saved result remains identical. Settings and Overview consume the same safe assessment under existing workspace/session authorization.
