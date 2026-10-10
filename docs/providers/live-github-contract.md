# Live GitHub implementation contract

Implementation target for ADR 0008; mock APIs remain unchanged. API responses omit keys, tokens, raw source payloads and lease tokens. Errors use existing authorized route redaction. Every write requires exact configured Origin and current owner/session revalidation.

## Configuration

`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_FILE`, `GITHUB_APP_GRANTS_FILE`: all optional as a group, server-only. Private key/grants files must be regular owner-only files, outside repository/browser configuration. App ID is numeric. Grants JSON is an array of `{workspaceId,installationId,accountId,accountType,repositoryIds}` where accountType is `User` or `Organization`. No duplicate installation across workspaces, duplicate grant pair or empty/duplicate repository list. At most 100 repositories per grant and 100 grants. Configuration snapshot is immutable per process; restart API and worker together after changes. Grant identity is fingerprinted without secret material and pinned at save; current config is rechecked at run claim/completion.

## Connection routes

Base: `/api/workspaces/:workspaceId/services/:serviceId`.

- GET `/github-connection`: `{connection: Connection|null, configured: boolean}`; member read, configured means this workspace has operator-granted access and provider configured, never global installation enumeration.
- POST `/github-connection`: `{expectedRevision:number|null,installationId:number,repositoryId:number,productionEnvironment:string,exposurePolicyReference:string|null,repositoryDeploymentsBelongToService:true}`. Production environment and exposure-policy reference are trimmed nonempty strings bounded to 200 Unicode characters (reference may be null). Owner explicitly assigns all deployment operations in this repository to service. Save only after bounded provider verification. Response `{connection: Connection}`. Stale revision 409; ungranted scope 403 without provider call.
- POST `/github-connection/disconnect`: `{expectedRevision:number}`. Owner appends inactive revision and fences active jobs, response `{connection: Connection}`. No GitHub uninstall/revocation claim.

`Connection`: `{workspaceId,serviceId,mode:'live',provider:'github',revision:number,active:boolean,installationId:number,repositoryId:number,repositoryName:string,accountLogin:string,productionEnvironment:string,exposurePolicyReference:string|null,repositoryDeploymentsBelongToService:true,observedAt:string,verifiedAt:string}`. Times ISO UTC with up to six fraction digits. First revision 1, each successful save/disconnect increments by one. Immutable revisions; no credential fields.

## Collection routes

- POST `/github-collection-runs`: `{connectionRevision:number,requestId:UUID,window:{start:UTC-midnight-ISO,end:UTC-midnight-ISO}}`; closed end <= server now, start < end, at most 90 UTC calendar days. Owner; pinned revision must be active/current and authorized. Replay same request with identical inputs returns original safe run; different input 409. One active run/service. Response 202 `{run: Run}`.
- GET `/github-collection-runs`: member, `{runs: Run[]}`, newest 25.
- GET `/github-collection-runs/:runId`: member, `{run: Run}`, scope checked.

`Run`: `{id,workspaceId,serviceId,mode:'live',provider:'github',connectionRevision:number,status:'pending'|'running'|'succeeded'|'failed',attempts:number,createdAt:string,updatedAt:string,completedAt:string|null,failureCode:string|null,result:Result|null}`. Terminal failure redacted bounded codes; no raw provider reasons. Only successful completion has result; partial traversal can complete with provisional result and explicit gap.

`Result`: `{mode:'live',workspaceId,serviceId,connectionRevision:number,oemsRevision:string,window:{start:string,end:string,timezone:'UTC',calendarDays:number},evidenceCutoff:string,transportComplete:boolean,deploymentCount:number,qualifyingCount:number,unknownCount:number,coverage:{collectionComplete:false,deploymentHistoryComplete:false,recoveryEvidenceComplete:false},deploymentFrequency:{count:number,status:'provisional',deploymentsPerDay:null,qualityReasons:string[]},changeFailureRate:null,failedDeploymentRecoveryTime:null}`. Counts refer to reconciled snapshot deployments and qualifying/unknown classifications; deployment frequency count is pinned OEMS calculation, never invented from source-array length. No actual overview metrics added in this slice.

## Adapter helper contract

Provider writer exports `createBoundedGitHubTransport({fetch,timeoutMs?,maxBytes?}): FetchTransport` and `verifyGitHubScope({appId,privateKey,installationId,accountId,accountType,repositoryId,clock,fetch,signal?})` returning `{accountLogin,repositoryName,token,expiresAt}` (token server-only, never serialize). Fixed HTTPS GitHub origin, redirects refused, streamed body bounded including missing Content-Length, caller cancellation plus timeout through body read. Verification asserts matching installation/App/account, selected/minimal permissions, unsuspended state, and narrowed repository token access. Shared JWT signing avoids duplication. Controlled mocked tests only.

## Worker and persistence

Migration 0005 allocated to live GitHub tables only. Existing migrations never edited. Backend writer owns new feature, migration, readiness and tests; coordinator wires main/server/routes/root scripts after integration. Worker `worker-github.ts` entry point, `processOne` exported for controlled integration testing. Use lease >= total run deadline + commit budget (e.g. 120s lease, 60s acquisition), bounded maxPages/maxRecords/evidence bytes. No provider calls in storage transactions. Retry at most three; respect bounded provider retry delays, generic fallback where token exchange gives no delay. Preserve prior scoped normalized history and trusted original observation times. Validate conflicts before commit; immutable snapshots and terminal records, stale worker/config/revision cannot commit. Partial evidence must remain visibly incomplete and never silently disappear. Stored public results strictly parsed; no raw evidence route.


## Resumable acquisition

Migration `0008_github_checkpoints.sql` stores revision-scoped bounded traversal cursors, with App/installation/repository/grant identity and committing run/lease provenance. Preflight reads strictly parsed retained context. Completion commits cursor, retained evidence, immutable snapshot and terminal result atomically. Expired leases, revoked grants, conflicts and failed retention checks cannot advance progress. Cursors are private server state; public HTTP shapes are unchanged. See [checkpoint behavior and limitations](github-checkpoints.md).
