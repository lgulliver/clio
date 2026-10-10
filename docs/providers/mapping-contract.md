# Mock deployment mapping contract

This slice adds saved mock-only workspace service settings and a fictional preview. It never registers provider access, accepts secrets, collects live evidence, or changes overview metrics. GitHub login remains identity-only. Real repository/application scopes require a later verified connection contract; mock exposure consent must never silently become live consent.

## HTTP surface

Base path: `/api/workspaces/:workspaceId/services/:serviceId`.

- `GET /deployment-mapping` returns 200 `{mapping: null}` when unset, otherwise `{mapping}`. Owners and members read.
- `POST /deployment-mapping` accepts exactly `{expectedRevision: number|null, primaryProvider: "github"|"argocd", productionEnvironment: string, exposureAttested: boolean}`. Owner only. Null revision creates; existing positive revision edits. Missing/stale expected revision returns 409. Return 200 `{mapping}`. Environment trims ECMAScript whitespace and contains 1–200 Unicode code points. Reject unknown fields and malformed booleans/revisions.
- `POST /deployment-preview` accepts exactly `{revision: number}`. Owners and members may preview saved revision only; mismatch returns 409, unset mapping returns 404. Return 200 `{preview}`.

Mapping response: `{workspaceId: UUID, serviceId: UUID, mode: "mock", revision: positive integer, primaryProvider: "github"|"argocd", productionEnvironment: string, exposureAttested: boolean, observedAt: ISO timestamp}`. Server assigns mode, revision, observation time and actor. Store immutable revisions; HTTP reads latest only. No create/save automatically seeds a workspace or service.

Preview response: `{mode: "mock", workspaceId: UUID, serviceId: UUID, mappingRevision: positive integer, oemsRevision: string, window: {start: ISO timestamp, end: ISO timestamp, timezone: "UTC", calendarDays: positive integer}, evidenceCutoff: ISO timestamp, qualification: "qualifying"|"unknown"|"excluded", rolloutCount: nonnegative integer, coverage: {collectionComplete: false, deploymentHistoryComplete: false, recoveryEvidenceComplete: false}, deploymentFrequency: {count: nonnegative integer, status: "provisional", deploymentsPerDay: null, qualityReasons: string[]}, changeFailureRate: null, failedDeploymentRecoveryTime: null}`. OEMS-derived fields come from validated fictional evidence and pinned calculations, never browser arithmetic or invented live measurements. No raw payload, token, snapshot persistence or network calls. The fixture uses one rollout in environment `production`; selecting another environment yields unknown qualification. Attestation is required for fictional exposure qualification. Argo config revision remains separate from application provenance. Server assigns stable fictional IDs, operation binding and policy reference. Preview cutoff must include saved mapping observation and fixture observations.

## Authorization and storage

Every route uses the existing database-backed session and transaction-bound membership checks. Service must belong to requested workspace. Members cannot write; cross-workspace/non-member reads return scoped 404. State-changing/POST requests require exact trusted Origin; responses use no-store and redacted errors. Revalidate expiry/revocation in storage transaction. Compute preview after transaction releases; no network/provider work inside transactions.

Coordinator allocates migration `0003_deployment_mappings.sql`. Add composite service/workspace foreign key, immutable revision rows, database constraints and readiness column checks. Never edit migrations 0001/0002. Session, membership and optimistic conflict tests use random disposable PostgreSQL schemas.

## Browser behavior

Within selected workspace, choose service and configure mock deployment settings. Semantic labels, loading/error/unconfigured states, owner-only form and member read-only view. Display "Mock data" and "No live provider connected" prominently; previews never appear as actual workspace metrics. Preview always reflects saved revision; editing/saving clears prior preview. On 409 retain draft and provide explicit reload, never silently overwrite it. Workspace/identity/service changes cancel/remove scoped queries and ignore late query/mutation responses using current identity revision and mounted scope guards. Never persist selections or private data in browser storage.
