# GitHub ingestion and pinned OEMS mapping

Verified in the integration working tree on top of Clio base `d8d6d74` and OEMS revision `5908bb12cdf24e7528088237dff9dca4c10ff45f` on 2026-10-10. The checked path is GitHub Deployments/status HTTP parsing → normalized stored-history parsing/merge → the actual API snapshot capture → pinned validation and all five calculations. Controlled fictional HTTP responses are used; this is not a credentialed live repository run or a conformance designation.

## Evidence mapping

| GitHub evidence | Clio/OEMS meaning | Guard |
| --- | --- | --- |
| Installation/repository/deployment IDs | Namespaced source and canonical service rollout identity | Whole-repository service assignment required; SHA does not identify a rollout |
| Deployment creation/update times | Native event and ordered metadata revision | Receiver observation/cutoff retained separately |
| Historical status environments | Production promotion or non-production evidence | Fetch all environments; requested staging can later expose production |
| Production success with explicit audited exposure policy | Qualifying with earliest successful production status as effectiveness | No policy means unknown; later inactive/failure does not erase prior exposure |
| Deployment SHA | Repository tip provenance extension | No invented commits, committer timestamps, changes or complete linkage |
| Deployment task | Private provenance | No automatic monorepo task→service assignment |
| Workflow success | No deployment ingestion route | GitHub Actions success alone does not become a deployment |
| Error/failure status | Provider status history | OEMS causal failure/rework/recovery stays unknown/unavailable |
| Full, partial or empty REST traversal | Transport progress | Never complete collection/history/recovery coverage |
| Persisted run | Immutable evidence, OEMS snapshot, metrics, result and pin | Connection/grant/lease/cutoff fences; old results never rewritten |

GitHub's [deployment API](https://docs.github.com/en/rest/deployments/deployments?apiVersion=2026-03-10) defines deployment requests and external status reporting; [deployment statuses](https://docs.github.com/en/rest/deployments/statuses?apiVersion=2026-03-10) are retained history. Clio's policy-backed exposure interpretation requires a deliberate agreement that the selected publisher reports success after consumer-visible activation. GitHub's default environment name or production flag cannot establish that agreement. See [connecting GitHub](connect-github.md).

## Defect found and repaired

General reconciliation previously compared completed status traversal time only with the deployment's original observation. An unchanged deployment observed January 4 with complete staging history, followed by a newly observed January 5 staging status and an incomplete next page, could incorrectly remain excluded. Missing pages might contain production evidence.

Completion must now be at least as recent as both the selected deployment observation and every selected status observation. The controlled regression proves January 4 cutoff remains excluded, January 5 partial history becomes unknown, reverse batch ordering has the same result and a later complete traversal restores exclusion. Positive recorded production exposure remains available. Current live connections select only a production environment, so this defect affected explicit non-production adapter mappings rather than the current live production-only mapping.

## Executable verification

- `packages/adapters/test/reconcile.test.ts`: full/partial/cutoff history, stable operation identity, classification, exposure, ordering, conflicts and the stale-completion regression.
- `apps/api/tests/github-oems.test.ts`: bounded HTTP collection and strict stored-history round trip through the actual capture and all five OEMS outputs. A staging deployment promoted to production retains earliest exposure despite later failure/inactive statuses. Same-SHA IDs remain separate; a third qualified deployment outside the reporting window remains in retained counts but does not inflate window frequency. A failed-only operation remains unknown. Missing policy and complete empty transport remain conservative. Later backfill omission/replay does not erase or redate prior evidence or mutate earlier snapshots.
- Existing PostgreSQL integration: provider scope/session, retained history, immutable snapshots, atomic completion, leases and revocation. Its provider batches are controlled normalized evidence; no live App credential claim.

For the main fixture, four retained deployments include three qualifying records and one unknown. Only two qualify inside the requested two-day window. Deployment frequency is therefore provisional count 2, not retained record count 4 or qualifying record count 3. Normalized deployments/day is null. Lead-time median, change-failure ratio, rework ratio and recovery median remain null because their supporting evidence is absent. All coverage flags remain false.

Run:

```sh
pnpm --filter @clio/adapters test test/reconcile.test.ts
pnpm --filter @clio/api test tests/github-oems.test.ts
pnpm check
CLIO_TEST_DATABASE_URL=postgres://clio_dev:clio_dev_password@127.0.0.1:5432/clio_dev pnpm test:integration
```

Real-source verification still requires separate GitHub App credentials, explicit repository/environment selection and a deployment publisher whose exposure policy is valid. Login OAuth is insufficient. The audit verifies implemented mapping and controlled ingestion behavior, not the truth of a real organization's status signals.
