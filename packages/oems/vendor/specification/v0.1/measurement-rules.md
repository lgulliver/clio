# Shared measurement rules

Status: adopted v0.1 working-draft contract under [RFC 0002](../../rfcs/0002-v0.1-preview-contract.md).

## Supported profile and evidence snapshots

This profile accepts reconciled snapshots only. dataset.schema.json defines inputs; metric-result.schema.json defines one result per service. profile_version remains 0.1-draft; implementations MUST also identify the exact draft commit. snapshot_as_of_cutoff=true asserts that every record is the selected revision known by evidence_cutoff. observed_at MUST be no later than the cutoff. A restoration learned later is absent in that snapshot: retain restored_at=null. Snapshot construction/revision reconciliation is an adapter responsibility, not an ingestion-conformance claim.

The reporting window is half-open [start,end), timezone=UTC, with UTC midnight boundaries. start MUST precede end, calendar_days MUST equal the positive number of whole UTC days, and evidence_cutoff MUST be no earlier than end. Reject partial-day/non-UTC windows rather than silently use another denominator. Record timestamps may use equivalent explicit RFC 3339 offsets; boundary instants must have offset zero. This profile supports seconds with up to six fractional digits and known offsets only; reject leap-second notation, excess precision and the unknown-offset marker -00:00 rather than silently round or reinterpret them. Other calendar profiles are deferred.

collection_complete declares source coverage for all services in the dataset's reporting population. deployment_history_complete separately declares sufficient historical coverage to identify first deployments. recovery_evidence_complete declares episode evidence coverage for every service in the requested onset window. These declarations do not prove flawless incident discovery; adapters MUST document sources and coverage. If coverage differs by service, emit separate datasets with truthful declarations.

## Populations and quality

Deduplicate records, resolve canonical identities and enforce the canonical-model constraints before calculating. Count only qualifying deployments whose effective_at is in the window. qualification_unknown_count counts unresolved qualification records whose declared time coverage affects that service/window.

Metric quality_reasons are unique and sorted lexicographically. Status precedence is:

1. Any applicable quality reason gives provisional, including an observed empty set.
2. With no quality reasons and no eligible observations, ratios and durations give no_observations.
3. Otherwise complete applies. Complete empty collection gives deployment frequency complete with count=0 and deployments_per_day=0.

Incomplete collection and unresolved qualification affect all five metrics. Unknown classification affects its corresponding ratio. Missing linkage/history affects lead time. Missing episode coverage, unresolved eligibility, unknown failure classifications, open episodes and approximate starts affect recovery. Each metric definition specifies its extra reasons.

Unknown failure/rework classifications remain in the observed qualifying denominator. Classification bounds are numerator/denominator and (numerator+unknown_count)/denominator. They do not account for unobserved or unresolved-qualification deployments: bounds_scope is observed_population if population coverage is provisional, otherwise full_population. A settled ratio is emitted only when both population and classification are complete. Zero denominator gives null bounds and ratio.

## Statistics and output context

Durations use seconds. Use the median; for even populations it is the mean of the two middle values. Empty eligible observations yield null. p75 is deferred. Ratios are fractions in [0,1]. Frequency is qualifying deployments per whole UTC reporting day.

Every result MUST include dataset_id, service_id, profile_version, window, evidence_cutoff and qualification_unknown_count, alongside metric counts and quality. An observed value with provisional quality is not a settled population statistic.

Results are service-level. Pooled ratios require summed populations; pooled duration medians require underlying observations. Implementations MUST NOT average service percentages or medians.
