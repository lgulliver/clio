# Deployment rework rate

Status: adopted OEMS v0.1 draft measurement profile; not a stable release.

## Research framing

DORA describes this measure as share of unplanned deployments driven by production incidents. See [the primary research guide](https://dora.dev/guides/dora-metrics/). The detailed rules below are OEMS policies, not an assertion that DORA prescribes these calculations.

## Calculation and evidence

Use qualifying deployments in [start,end) as the observed denominator. Count incident_driven deployments as the numerator: these were unplanned and undertaken to remediate a production incident. A scheduled improvement following an incident is not automatically incident-driven rework. Adapters MUST preserve an intent decision/evidence reference; temporal proximity alone is insufficient.

Unknown classifications remain in the denominator. Bounds are numerator/denominator and (numerator+unknown_count)/denominator. Add unknown_rework_classification when unknown_count>0. Apply shared bounds_scope and settled ratio rules. Failure and rework are independent: a planned rollout can fail, while a successful unplanned hotfix can be rework.

Apply [shared measurement rules](../measurement-rules.md) and [canonical constraints](../canonical-data-model.md). Check the [conformance fixtures](../../../conformance/v0.1/README.md). Passing these fixtures does not establish certification.
