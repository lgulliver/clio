# Deployment frequency

Status: adopted OEMS v0.1 draft measurement profile; not a stable release.

## Research framing

DORA describes this measure as production deployment rate. See [the primary research guide](https://dora.dev/guides/dora-metrics/). The detailed rules below are OEMS policies, not an assertion that DORA prescribes these calculations.

## Calculation and evidence

Count distinct canonical qualifying service rollouts with effective_at in [start,end). Divide by window.calendar_days only when collection_complete=true and qualification_unknown_count=0. Otherwise keep the observed count, status=provisional and deployments_per_day=null. A rollout that became effective then failed remains eligible. Build success, dark release without consumer effect and staging attempts are not deployments in this population.

Complete empty collection gives count=0 and deployments_per_day=0. Never infer complete coverage from an empty API response.

Apply [shared measurement rules](../measurement-rules.md) and [canonical constraints](../canonical-data-model.md). Check the [conformance fixtures](../../../conformance/v0.1/README.md). Passing these fixtures does not establish certification.
