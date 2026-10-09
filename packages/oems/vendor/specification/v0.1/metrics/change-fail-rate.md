# Change fail rate

Status: adopted OEMS v0.1 draft measurement profile; not a stable release.

## Research framing

DORA describes this measure as share of production deployments requiring immediate intervention. See [the primary research guide](https://dora.dev/guides/dora-metrics/). The detailed rules below are OEMS policies, not an assertion that DORA prescribes these calculations.

## Calculation and evidence

Use qualifying deployments in [start,end) as the observed denominator. Count distinct deployments with failure=failed as the numerator. failed means a production-effective rollout required immediate remedial intervention because of its production impact, such as a rollback or corrective hotfix. Immediate intervention describes a response needed to remediate the deployment, not scheduled improvement work; no universal elapsed-time threshold is imposed. Adapters MUST document the decision and its evidence reference. CI/build failure alone is insufficient.

Unknown classifications remain in the denominator. Bounds are numerator/denominator and (numerator+unknown_count)/denominator. Add unknown_failure_classification to quality_reasons when unknown_count>0. Apply the shared bounds_scope and settled ratio rules. no_recorded_failure means no confirmed failure found in the stated evidence, not guaranteed absence of failure.

Apply [shared measurement rules](../measurement-rules.md) and [canonical constraints](../canonical-data-model.md). Check the [conformance fixtures](../../../conformance/v0.1/README.md). Passing these fixtures does not establish certification.
