# Change lead time

Status: adopted OEMS v0.1 draft measurement profile; not a stable release.

## Research framing

DORA describes this measure as commit to production elapsed time. See [the primary research guide](https://dora.dev/guides/dora-metrics/). The detailed rules below are OEMS policies, not an assertion that DORA prescribes these calculations.

## Calculation and evidence

Use the first qualifying production-effective deployment of each canonical repository/commit to the service. If that first time lies in [start,end), subtract the committer timestamp and take the median. A repeat deployment or rollback to the same commit does not create another lead-time observation for that service. A deployed squash commit is the unit; PR-first-commit elapsed time is a separate flow metric.

Inspect all qualifying history before end, including records before start. Missing history, unresolved qualification before end, incomplete linkage, unresolved change IDs or incomplete collection prevent confirmation of first deployment. Missing qualification before the window still affects history. In that situation observation_count=0 and median_seconds=null; candidate_count records linked changes whose earliest known qualifying deployment is in the window. Candidates are not confirmed observations. unresolved_change_count counts distinct missing change IDs in that history; linkage_unknown_count counts qualifying historical deployments with change_links_complete=false.

Quality reasons are the shared population reasons plus incomplete_history, incomplete_change_linkage and unresolved_change_links as applicable. With complete evidence, a configuration-only deployment with complete empty linkage supplies no duration, not a zero duration. Negative durations are invalid semantic evidence.

Apply [shared measurement rules](../measurement-rules.md) and [canonical constraints](../canonical-data-model.md). Check the [conformance fixtures](../../../conformance/v0.1/README.md). Passing these fixtures does not establish certification.
