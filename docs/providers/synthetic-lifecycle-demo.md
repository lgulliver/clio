# Complete lifecycle — fictional

This selectable mock scenario demonstrates all five metrics using an exhaustive, invented fixture. It makes no GitHub or Argo requests. **Complete within fictional fixture** means the fixture's entire deployment census, application change history, classifications and recovery episode are declared and validated. It proves no live coverage and cannot be used as a native measurement basis. Real GitHub/Argo records and the pinned OEMS standard remain unchanged.

## Setup

1. Stop existing API and mock worker processes, apply migrations explicitly with `pnpm db:migrate`, including coordinator-allocated `0013_mock_lifecycle_scenario.sql`, then restart both with the updated code. An old worker cannot process the new scenario contract. Use the existing [local setup](../getting-started.md) for identity, PostgreSQL and API configuration.
2. Create a separate service named **Fictional lifecycle demo**. Keep real services and connections separate.
3. Open **Set up a data source**, select this service, then **Fictional demo**. In Connection, select **Complete lifecycle — fictional** under **Fictional scenario**. Choose either mock primary provider.
4. Production environment `production` and exposure attestation are fixed for this fictional profile. Disabled controls explain that they attest only fictional exposure. The API rejects contradictory complete-profile inputs with 400. Save the mapping.
5. **Preview saved mock settings** calculates all five immediately on the API, without a worker. Preview is ephemeral.
6. Continue to Collection and queue the saved revision. Run `pnpm worker:mock --once` in a separate terminal, after queueing, or run `pnpm worker:mock` continuously. The worker uses the existing database leases, retries and immutable snapshots; no provider credentials are required.
7. Refresh runs, then open Overview and select the workspace and **Fictional lifecycle demo** service. The **Mock — fictional evidence** history shows all five server-returned metric cards after success. Overview does not start collection.

The scenario is saved per immutable mapping revision and captured in queued input. Changing back to **Partial — fictional** does not change queued jobs or historical successful results. Inputs and saved snapshots without a scenario remain partial. The partial scenario keeps its original exposure/environment controls and honest unavailable metrics. New unknown scenario values are rejected.

## Fixed fixture and computed values

Window: **2026-01-01T00:00:00.000Z inclusive to 2026-01-03T00:00:00.000Z exclusive**, two closed UTC calendar days. Fixture observation is January 3; the result cutoff also includes the saved mapping observation, rounded up to include microseconds. Running today does not collect today's deployments.

| Rollout | Application commit time (UTC) | First production exposure (UTC) | Independent failure | Independent rework |
| --- | --- | --- | --- | --- |
| Healthy | January 1, 08:05 | January 1, 10:05 | No recorded failure | Not incident driven |
| Broken | January 2, 09:05 | January 2, 10:05 | Failed | Not incident driven |
| Recovery | January 2, 10:05 | January 2, 10:35 | No recorded failure | Incident driven |

Each deployment has its own fictional application repository and distinct 40-character source commit. Argo configuration revisions are retained separately and never treated as application commits. All three are qualifying production rollouts. Exhaustive fixture history starts at January 1 with no prior deployments; every change first deploys in this window. Independent invented classifications explicitly include negative values. One exact synthetic incident starts at the broken rollout's exposure, January 2 at 10:05, and restores at 10:35 through the recovery rollout. Provider success/health establishes the fictional exposure under its fixed policy; it does not supply failure or recovery classifications.

| Metric | Pinned OEMS computed result |
| --- | --- |
| Deployment frequency | 3 deployments / 2 calendar days = **1.5 deployments/day** |
| Change lead time | Observations 7,200, 3,600, 1,800 seconds; median **3,600 seconds** |
| Change failure rate | **1/3**, displayed as 33.33% |
| Deployment rework rate | **1/3**, displayed as 33.33% |
| Failed deployment recovery time | One exact completed episode; median **1,800 seconds** |

The API reconciles fixture operations, attaches explicitly scoped fictional census/history/classification/recovery facts, validates the resulting snapshot through pinned OEMS and calls its calculator. No calculated output is overridden. Safe public result version `clio.mock.lifecycle.v1` carries the complete five-metric object with its original service, window, cutoff and OEMS revision. Private references and snapshots remain server-side. Browser code parses the pinned metric-result schema and uses existing metric cards; it performs no metric calculation.

This scenario is bounded fixture version 1, not an editable incident simulator, live measurement, collector certification or production deployment. Live source completeness still requires independent exhaustive real evidence. Legacy partial results remain readable with their original unavailable metrics and false coverage.
