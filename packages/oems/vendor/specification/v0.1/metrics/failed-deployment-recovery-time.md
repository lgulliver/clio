# Failed deployment recovery time

Status: adopted OEMS v0.1 draft measurement profile; not a stable release.

## Research framing

DORA describes this measure as restoration time after a deployment-related failure. See [the primary research guide](https://dora.dev/guides/dora-metrics/). The detailed rules below are OEMS policies, not an assertion that DORA prescribes these calculations.

## Calculation and evidence

Select service episodes whose failure_started_at lies in [start,end). This onset cohort is OEMS policy. The causal deployment may precede the window, but it must be resolved, for the same service, qualifying and failed. Missing causal references or unknown causal qualification/failure give unresolved_count and are excluded from duration/open/approximate populations. Contradictory resolved relationships are semantic errors.

For eligible completed episodes with start_is_approximate=false, subtract onset from restoration and compute median_seconds. observation_count counts these exact completed episodes. Eligible open episodes are excluded and disclosed in open_count. An approximation is allowed only when onset was estimated as the causal production-effective time and is explicitly flagged. approximate_count includes eligible open and completed approximate episodes; approximate_median_seconds uses completed approximate episodes separately. Approximate observations never enter the main median.

Add open_recovery_episodes, approximate_recovery_start and unresolved_causal_links when the respective counts are positive. Add incomplete_recovery_evidence when its coverage declaration is false. unknown_failure_count counts qualifying historical deployments effective before end with unknown failure classification; these can hide eligible episodes, so any such count adds unknown_failure_classification conservatively. This includes history before start. Shared population reasons also apply. Missing data can therefore make recovery provisional even if the completed exact median is calculable.

Restoration is confirmed return of service, not alert acknowledgement or ticket closure. Use only evidence available at cutoff. Restoration learned later leaves the snapshot episode open. Empty exact completed observations yield null median_seconds; quality precedence still applies.

Apply [shared measurement rules](../measurement-rules.md) and [canonical constraints](../canonical-data-model.md). Check the [conformance fixtures](../../../conformance/v0.1/README.md). Passing these fixtures does not establish certification.
