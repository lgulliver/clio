# @clio/adapters

Server-only deployment evidence foundation. GitHub App installation-token issuance,
GitHub REST full backfill, supplied Argo CD operation normalization, strict native Argo
notification parsing, and pure one-service OEMS reconciliation are implemented. This package
owns no API route, credential store, notification receiver or durable job. Fictional fixtures
cover normalization; the committed native producer was also exercised against the dedicated
public-repository Argo CD 3.5.4 sandbox. That probe proves producer behavior, not Clio receiver
integration or complete source history.

## Authorization and credentials

Import this package only on trusted servers; never from `apps/web`. Node crypto signs an
RS256 GitHub App JWT with an RSA key of at least 2048 bits, a 60-second clock-skew allowance
and a maximum ten-minute claim lifetime. `createInstallationToken` receives the app ID,
private key, installation ID and selected positive repository IDs in memory. It requests
only those repositories and `deployments: read` (GitHub metadata permission is implicit).
Responses are parsed from unknown; empty/invalid tokens and tokens expiring within 60 seconds are rejected. This helper requests narrow permissions but does not independently inspect granted permissions or repository lists in the response; live callers use `verifyGitHubScope` below and the API operator-grant boundary to verify installation ownership and scope. Errors contain
fixed codes/HTTP status numbers, without provider bodies, keys, JWTs or tokens. Nothing is
persisted or logged. The returned token is a secret and must remain server-side.

**Caller authorization is mandatory:** establish workspace ownership, installation ownership,
and authorized repository selection before issuance or collection. These functions do not
perform that authorization. GitHub login/OAuth credentials must never be passed to this
collector; supply a separate installation token. Installation selection, ownership proof,
renewal orchestration and encrypted credential storage are outside this slice.

Both token issuance and collection accept injected `clock`, `fetch` and optional `signal`.
Production transports must honor Fetch `redirect: 'error'` and cancellation, use validated TLS
and avoid logging request authorization/body or raw response bodies. Requests use fixed
`https://api.github.com` and API version `2026-03-10`.

## GitHub collection and replay

`collectGitHubDeployments` resolves a selected stable numeric repository ID through
`/repositories/{id}`. An optional selected owner/name binding must match that metadata;
otherwise the current name is used. Repository identity is namespaced by GitHub installation
instance and numeric ID, rather than mutable owner/name. Requests traverse **all** repository
deployments without an environment filter, then every deployment's status pages. This retains
historical promotion evidence even when the deployment's current environment is staging.
Deployment task is retained as provenance; it never automatically classifies service or exposure. Payload, description, creator and arbitrary provider URLs are discarded. Stable URN references use installation and numeric source IDs, so repository renames do not alter evidence identity.

Next links must target the exact same resource on `api.github.com`, have only `page` and
`per_page=100`, and advance exactly one page. Credentials, fragments, extra filters, foreign
hosts/resources, malformed links, loops, skipped pages and duplicated next links fail safely.
Default whole-run limits are 1,000 HTTP requests (including metadata) and 100,000 parsed records;
callers can supply positive limits. Accepted pages are atomic: malformed/conflicting/unsafe
pages do not replace prior evidence. 401/403/404, rate limiting, invalid JSON, transport errors,
limits and cancellation return `transportComplete: false` with safe diagnostics. Earlier
accepted records remain available. Numeric Retry-After seconds or exhausted primary rate-limit reset times are retained when supplied. The request limit includes every status page, so large repositories need an explicit higher limit; no durable continuation is implemented.
Completed per-operation status traversals retain trusted observation timestamps. Reconciliation requires a completed traversal at or after the selected deployment observation and within cutoff before excluding a GitHub rollout as non-production; partial or absent status collection remains unknown. This transport marker grants no OEMS coverage. Known production/exposure evidence remains usable from partial batches. No automatic retry is performed.

This is a **full backfill batch**, not an incremental cursor. Replay the entire backfill after
interruption; retain original observations in an eventual evidence store. No failed-page
checkpoint can advance because no checkpoint is exposed. REST traversal completeness means
only that this traversal finished; paginated provider state is not an atomic historical
snapshot. It never proves OEMS collection/history coverage, even for an empty response.

GitHub deployment versions retain each `(id, updated_at)` observation. Reconciliation first filters by trusted observation cutoff, deduplicates each version using its earliest observation, then selects greatest parsed `updated_at` for each operation. Delivery order never chooses truth. Environment may change across versions; changed immutable creation/provenance/task fields or conflicting content at the same source revision reject. This assumes a semantic change advances `updated_at`; unchanged revision with changed content fails conservatively. Status identities remain append-only and deduplicate strictly. Opaque Argo operation revisions have no ordering policy and conflicting revisions reject.

## Neutral identity and service mapping

`EvidenceBatch` holds normalized deployment operations and status observations separately.
`DeploymentSource` distinguishes provider/connection instance from repository provenance.
`identity(...parts)` URI-encodes each part to avoid delimiter collisions. For GitHub use
`identity('github', instance)` as source ID and
`identity('repository', repositoryId, 'deployment', deploymentId)` as source deployment ID.
For Argo use `identity('argocd', instance)` and
`identity('application', applicationUid, 'operation', operationId)`.

`ServiceMapping` is a trusted, versioned mapping known by its `observedAt`. It selects one
primary deployment source, exact operation bindings for this service, explicit environment
classifications, and optional exposure policies. This slice requires explicit operation binding;
repository/application-to-service selection expansion belongs to later server configuration.
Repository/tip SHA is provenance, never universal rollout identity or a service assignment.
A service may use Argo as its primary deployment source with GitHub as its change source.

Only explicit `correlations` can join operations across providers. A correlation group must
include a selected primary source operation. Cutoff-known secondary-only evidence emits `missing_primary_evidence` in reconciliation diagnostics and leaves that group uncounted; other valid groups remain available. Uncorrelated secondary evidence is ignored. Only primary-source exposure evidence can qualify a correlated rollout. Same SHA or nearby timestamps never join operations. OEMS
canonical identity remains `(service_id, rollout_group_id)`; ordinary groups are namespaced
source operations, explicit shared groups use provider-neutral rollout IDs. Repeated SHA
operations remain distinct. Correlated observations with conflicting app commits for the same
namespaced repository, or incompatible production/non-production classifications, reject.
Independent config repositories/revisions do not pretend to be app commits. Caller must establish
cross-provider correlation/provenance identities; no heuristic resolver exists.

## Argo CD supplied contract

`normalizeArgoOperation(unknown, { instance, observedAt })` accepts this narrow fictional
notification contract, not a complete Kubernetes Application object:

```json
{
  "contract": "clio.argocd.operation.v1",
  "application_uid": "fictional-app-uid",
  "operation_id": "fictional-operation-1",
  "operation_revision": "immutable-operation-revision-1",
  "notification_revision": "notification-revision-1",
  "environment": "prod",
  "started_at": "2026-01-01T10:00:00Z",
  "status_at": "2026-01-01T11:00:00Z",
  "operation_kind": "rollout",
  "phase": "Succeeded",
  "health": "Healthy",
  "consumer_exposure": false,
  "configuration_repository_id": "git:fictional-config-repository",
  "reconciled_revision": "fictional-config-revision",
  "application_provenance": null
}
```

All fields shown are required. Operation kinds are `rollout`, `self_heal`, `retry`, `unknown`;
phases are `Running`, `Succeeded`, `Failed`, `Error`, `Terminating`; health values are `Healthy`,
`Progressing`, `Degraded`, `Suspended`, `Missing`, `Unknown`. `application_provenance` is either
null or `{ "repository_id": "namespaced stable app repository", "commit_sha": "40 hex digits" }`.
Caller supplies stable namespaced repository identities; config and app repositories are
separate. Config `reconciled_revision` is retained independently from proved app commit
provenance. Image/artifact-to-commit resolution is deferred; leave app provenance null when
unknown. Extra payload fields (including payload `observed_at`) are discarded.

Caller must authenticate the supplied notification, establish instance/application scope, assign
stable operation and notification revisions, and supply trusted receiver observation time.
There is **no inbound HTTP receiver** and no authentication mechanism for such a receiver here.
Operation core fields/revision must remain stable across notifications. Distinct status revisions
can append observations, but conflicting content for the same notification revision rejects.
Repeated notification revisions deduplicate; different operations using the same SHA stay distinct.
Never use `oncePer: revision` as operation identity. Sync success/healthy alone does not prove
consumer exposure. Self-heal/retry/unknown operations remain unqualified in this slice.

## Native Argo notification boundary

`parseArgoNotification(input: unknown, scope: ArgoScope, observedAt: string): ArgoNotification`
and `argoNotificationDigest(input: unknown, scope: ArgoScope): string` implement the exact
[native wire contract](../../docs/providers/live-argo-contract.md). Exported types are
`NativeArgoNotification`, `ArgoScope`, `ArgoNotification`, `ArgoOperationNotification`,
`ArgoGapNotification`, and `ArgoGapReason`. The caller authenticates the source before calling
these helpers and supplies trusted UTC observation time. Scope mismatches and malformed
shapes throw redacted `AdapterError`; scope-valid unsupported events return explicit gaps.

Parsing rejects unknown or missing keys, nonboolean flags, unsafe retry counts, invalid UTC
calendar timestamps, completion before start, strings over 4096 characters, arrays over 100
entries, and normalized envelopes over 64 KiB of UTF-8. Valid native timestamps retain up to
six fractional digits. Canonical receipt JSON contains only explicitly selected public scope
fields and the normalized envelope: deterministic key ordering, sorted operation info and
normalized fractional padding. Private grant extensions and observation time are excluded.
The receipt digest is SHA-256. The digest-only entry validates timestamps and exact scope but
skips arrival age checks, allowing authorized storage to find replay before horizon checks.

Supported terminal operations require explicit UUID info, recognized operation kind (missing
kind remains `unknown`), single-source configuration revision, completion time and recorded
health transition time. New arrivals more than ten minutes after completion become gaps.
Status time is the later of completion and health transition, with future native timestamps
reported as gaps. Health predating operation start is allowed, without exposure inference.
Operation metadata digest binds public scope, normalized UUID, start, configuration revision,
kind, immutable `v1` revision, original initiatedBy and sorted operation info. Retry count and
mutable terminal/health status are excluded. Notification revisions hash phase, health,
conjunction timestamp, false exposure and namespaced source reference. They are opaque
identities, not chronology. Native evidence always has false consumer exposure and null
application provenance; configuration revisions remain opaque strings.

The [native YAML](../../infra/argocd/clio-notifications.yaml) uses safe JSON encoding and custom
UUID/phase/health/transition-time oncePer; native start time only discriminates unmarked gap
delivery. See [producer notes](../../infra/argocd/README.md) for actual runtime facts and setup
requirements. Storage owns replay authorization, UUID conflicts, combination/retention limits,
gap persistence and first observation; this pure parser does not implement those controls.

## Snapshot policy and limits

`reconcileDeployments` accepts only normalized trusted evidence plus a trusted service mapping,
cutoff and OEMS window. It filters observations after cutoff **before** deduplication and rejects
mapping observations after cutoff. Replayed data does not redate observations. Output uses
`@clio/oems` `validateSnapshot`, pin `5908bb12cdf24e7528088237dff9dca4c10ff45f`, preserving
its validation result/capability. Window/calendar validation stays with OEMS. Validated data is
copied and deeply frozen; later batches or caller mutations cannot alter earlier snapshots.

Selected production evidence defaults to `qualification: unknown`, `effective_at: null` and
`qualification_window: null`. Unmapped environments remain unknown; exclusion requires an
explicit non-production mapping. GitHub status environments govern historical classification;
current deployment environment is only a fallback when no status evidence exists. Production
success qualifies only when the mapping explicitly attests that `success` establishes actual
production consumer exposure. Argo additionally requires `Succeeded`, `Healthy`, `rollout`,
`consumer_exposure: true` and an explicit `Succeeded` exposure policy. Policy references enter
provenance. Earliest accepted exposure time wins; later inactive/failure never erases a rollout.

Failure/rework always remain unknown, their evidence refs empty. No incidents are inferred from
pipeline/health errors or success. All three coverage flags remain false. Tip SHAs/config revisions
are extensions only; no committer timestamps/cohort evidence are available, so changes/incidents
are empty and `change_links_complete: false`. Calculated metrics remain provisional, preserving
nulls and observed counts. This foundation claims neither complete history nor OEMS conformance.

## Configurable fictional demo

Run `pnpm demo:providers` from the repository root. Add `--source=github`, `--source=argocd` or `--source=both`, select `--environment=production`, and use `--attest-exposure` only for the explicit fictional exposure-policy example. No network or provider credentials are used. Read [the demo guide](../../docs/providers/mock-demo.md); no browser source-configuration flow is implemented.

## Scoped verification

```sh
pnpm --filter @clio/adapters typecheck
pnpm --filter @clio/adapters test
pnpm exec biome check packages/adapters/src packages/adapters/test
git diff --check
```

Tests cover scoped token permissions and redaction, controlled pagination and replay, unsafe URLs,
partial/rate-limit/cancelled collection, production promotion/earliest exposure, empty coverage,
cutoffs/immutability, repeated SHA operations, Argo unknown/self-heal/retry evidence, explicit
cross-provider correlation and conflicts, and pinned provisional/null metric outcomes.

## Local live GitHub scope helpers

`createBoundedGitHubTransport({fetch, timeoutMs?, maxBytes?})` wraps an injected
server transport. Only HTTPS `api.github.com` requests are accepted; redirects
are refused. Default limits are 10 seconds and 2,000,000 streamed bytes per
request. One deadline includes fetch and body acquisition. Returned native
responses contain buffered bodies. Caller abort and timeout settle even when
injected fetch, body reads or stream cancellation ignore abort; such underlying
work cannot be forcibly terminated by JavaScript.

`verifyGitHubScope({appId, privateKey, installationId, accountId, accountType,
repositoryId, clock, fetch, signal?})` validates App installation identity,
unsuspended selected scope and exact Deployments/Metadata read permissions,
issues a single-repository token, then checks numeric repository metadata and
exact token repository listing. It uses the shared App JWT signer and bounded
transport internally. Returns `{accountLogin, repositoryName, token, expiresAt}`;
`repositoryName` is the repository name without owner (pair with `accountLogin`).
Token stays server-only. Failures contain sanitized adapter codes.

Operator grants, workspace ownership, persistence, collection deadlines and
credential-file policy remain caller responsibilities. Helpers perform no
network work until called. Controlled tests use fictional responses and an
ephemeral signing key; they do not prove live access or complete evidence coverage.


Scope-verification token lifecycle: if verification fails after token issuance, the unread/unreturned token may remain valid at GitHub until its one-hour expiry. This bounded read-only token is never logged or persisted. Verification does not promise remote token revocation; retirement/key rotation follows the provider setup guide. Live orchestration owns active-scope and revision fencing independently of token lifetime.
