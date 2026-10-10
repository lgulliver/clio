# Connect a real Argo CD source

Clio's local notification path binds one explicitly granted Argo Application to one workspace/service. GitHub login establishes Clio identity; it grants no Argo access. Notifications and snapshots remain separate from mock data and live GitHub collection. Read the [wire/API contract](live-argo-contract.md) and [real-source preparation](real-sources.md).

## 1. Establish the application scope

Sign in to Clio, create/select your workspace and service, and record their UUIDs. Use an authorized Argo administrator or deployment operator to inspect the intended Application. Record its immutable UID, name, namespace, AppProject, exact destination server/name/namespace and single-source repoURL. A recreated Application has a different UID and needs a new grant. Supply stable instance, destination cluster and configuration-repository identities. `https://kubernetes.default.svc` is a destination address shared by many clusters, not a global cluster identity.

Choose the production environment deliberately. The Docker guestbook is an evaluation workload, even when a test mapping exercises production classification. Applications with `sources` or `sourceHydrator` are unsupported in this first contract; do not flatten them into a guessed repository. A changed project/repository/destination on the same UID is scope drift and is rejected.

## 2. Keep ingestion credentials in private files

Use files owned by the API/worker operating-system user with permissions `0600`, outside every Git checkout. Direct paths must be absolute and contain no symlinks. Do not use `.env` for token contents, put credentials into `VITE_` values, send them in query strings, or paste them into chat. The private grants file and token paths are server configuration, never browser inputs.

Generate a 256-bit credential locally:

```sh
(
  set -e
  umask 077
  mkdir -p "$HOME/.local/share/clio/argo"
  openssl rand -hex 32 > "$HOME/.local/share/clio/argo/guestbook.token"
)
```

Create `grants.json` in the same private directory. The following is a fictional example; replace every identity and scope field with the selected Application and Clio workspace/service. `destinationName` is null when Argo selects the cluster by server; conversely server may be null when destination uses a name. `tokenFile` is an absolute real path, not a shell expression embedded in JSON.

```json
[
  {
    "sourceId": "11111111-1111-4111-8111-111111111111",
    "workspaceId": "22222222-2222-4222-8222-222222222222",
    "serviceId": "33333333-3333-4333-8333-333333333333",
    "instance": "delivery-argo",
    "applicationUid": "44444444-4444-4444-8444-444444444444",
    "applicationName": "example-service",
    "applicationNamespace": "argocd",
    "project": "delivery",
    "destinationClusterId": "production-eu",
    "destinationServer": "https://kubernetes.default.svc",
    "destinationName": null,
    "destinationNamespace": "example-service",
    "configurationRepositoryId": "example/gitops",
    "repoURL": "https://github.com/example/gitops.git",
    "environment": "production",
    "tokenFile": "/home/operator/.local/share/clio/argo/guestbook.token"
  }
]
```

Generate a fresh source UUID locally for each new source, for example `node -e 'console.log(crypto.randomUUID())'`. Restrict `grants.json` to `0600`. Duplicate source/application bindings and shared token digests are rejected; maximum 100 grants. The fingerprint includes the entire scope and credential digest. Changing a file while processes run does not hot-reload permissions: API and worker load immutable configurations on startup and must restart together.

Configure the server-only setting in exported environment or ignored `apps/api/.env`:

```sh
export ARGO_INGESTION_GRANTS_FILE="$HOME/.local/share/clio/argo/grants.json"
pnpm db:migrate
pnpm dev:api
```

Migration is explicit and preserves existing identity, GitHub and mock tables. Invalid/partial private configuration fails startup with a redacted message. Absent configuration disables Argo ingestion. Identity configuration remains required for owner-managed connections.

## 3. Configure the trusted notification producer

The endpoint is `POST /api/argo/sources/SOURCE_UUID/operations`. Supply `Authorization: Bearer TOKEN` and `Content-Type: application/json`. Real Argo-to-Clio delivery requires trusted HTTPS at your chosen ingress; Clio does not choose or deploy that ingress. Keep certificate verification enabled. Bearer access trusts the operator-controlled notification producer, Secret readers and ConfigMap editors; it does not cryptographically attest the controller. Restrict these Kubernetes permissions and the destination network.

Use the committed [notification ConfigMap](../../infra/argocd/clio-notifications.yaml) as the native-contract template. Configure its source UUID, trusted receiver URL and secret reference for this Application. Merge keys into your operator-managed notification ConfigMap rather than overwriting unrelated services/triggers. Add the ingestion credential as Secret key `clio-token` in `argocd-notifications-secret` through your existing secret-management workflow, reading the private token file locally. Do not commit rendered Secrets or credential-bearing YAML. Prepare these settings now; subscribe only the granted Application after saving its active Clio connection in step 5.

The example's `context.sourceId`, `clio-token` and service/template/trigger names describe **one source**. For additional Applications on the same Argo instance, give every source its own named set. For a second source named `billing`:

| Setting | Second-source value |
| --- | --- |
| Service key and template webhook key | `service.webhook.clio-billing` and `webhook.clio-billing` |
| Credential reference and Secret key | `Bearer $clio-token-billing` and `clio-token-billing` |
| Template key | `template.clio-native-operation-billing` |
| Template request path | `/api/argo/sources/BILLING_SOURCE_UUID/operations`, using that grant's literal UUID |
| Trigger key and send list | `trigger.clio-operation-billing` and `[clio-native-operation-billing]` |
| Billing Application subscription | `notifications.argoproj.io/subscribe.clio-operation-billing.clio-billing: ""` |

Copy the native body and trigger predicate unchanged for this set. Hardcode that set's public source UUID in its request path instead of sharing `context.sourceId`; each credential must match only its own grant. Preserve the first source's settings and subscription. Both services can use the same trusted Clio ingress origin. Repeat with unique names for each Application, within the 100-grant bound.

The custom `oncePer` includes operation UUID, phase, health and health-transition time. A Git SHA key would collapse distinct syncs at the same revision; resourceVersion would risk loops from notification bookkeeping. Unmarked operations use start time only to deliver an unsupported-operation gap. Never change that fallback into rollout identity. Native values are JSON encoded, not interpolated into quoted strings. The first native trigger emits terminal observations within the completion horizon, so health churn days after an old operation does not keep growing its history. Terminal unmarked operations and supported-period health changes still consume immutable history; neither suppression nor zero gaps proves complete delivery.

Argo supports webhook retry for network/5xx failures with bounded retry settings. Retrying cannot establish complete history; outages can outlast retries. See the [pinned webhook retry contract](https://github.com/argoproj/argo-cd/blob/v3.5.4/docs/operator-manual/notifications/services/webhook.md). Validate supported template behaviour against your Argo version before adoption.

Argo CD 3.5.4 can skip trigger processing for terminal state missing `finishedAt` because its controller considers synchronization status stale. The predicate admits the missing field, but that does not prove native delivery. Another authenticated producer's missing-completion payload becomes a receiver gap; Clio cannot count a notification the controller never sends.

## 4. Give each operation explicit identity

Your deployment automation must generate a fresh UUID for each operation and supply it through Argo's authorized sync API/CLI as operation info. Run this after saving the active connection and subscription in step 5:

```sh
CLIO_OPERATION_ID=$(node -e 'console.log(crypto.randomUUID())')
argocd --argocd-context YOUR_CONTEXT app sync YOUR_APPLICATION \
  --info "clio.operation-id=$CLIO_OPERATION_ID" \
  --info 'clio.operation-kind=rollout'
```

Use an appropriately scoped Argo sync role in your deployment automation; the receiver token provides no Argo API permissions. Do not infer role authorization from a direct Kubernetes Application patch. Argo preserves original `operation.info` and `initiatedBy` in operation state. Inspect that state locally after sync, keeping tokens/private resource bodies out of logs. The [pinned sync command](https://github.com/argoproj/argo-cd/blob/v3.5.4/docs/user-guide/commands/argocd_app_sync.md) documents `--info`.

Allowed kinds: `rollout`, `self_heal`, `retry`, `unknown`; absent kind remains unknown. Native retryCount remains provenance on the same operation, not a second rollout. Reusing a UUID with different start/configuration/kind is a conflict. Autonomous/self-heal operations without explicit UUID become recorded gaps. Successful synchronization alone does not imply rollout kind, application commit provenance or consumer exposure.

## 5. Connect, receive and create a result

In Clio Workspace, select the service and open **Live Argo**. As owner, select the granted source and attest that its operations belong to this service. Save the connection. Then subscribe only that Application with `notifications.argoproj.io/subscribe.clio-operation.clio: ""`. Members can read configuration/history/results; they cannot change bindings or enqueue jobs.

An optional versioned exposure-policy reference records your intended Succeeded signal policy. The first native template always supplies false consumer exposure and null application provenance. The policy cannot make those observations qualify. The GitOps SHA identifies configuration, not the deployed application commit.

Send a newly identified operation after enabling the connection. The standard trigger suppresses old terminal state beyond 10 minutes; an authenticated late arrival from another producer becomes a horizon gap. Native completion and health-transition timestamps must exist and be valid UTC. Missing timestamps and future event times become gaps; malformed timestamps or completion before operation start are rejected. Future starts are omitted from minimal gap records. Keep controller/API/database clocks synchronized. Receiver observations come from the database clock; payloads cannot choose them.

Run the separate worker:

```sh
pnpm worker:argo
# Or process at most one eligible job:
pnpm worker:argo --once
```

Select a closed UTC whole-day period of 1–90 days and queue a snapshot. End is exclusive and cannot be in the future. For an operation received today, the closed period containing today becomes available after the next UTC midnight. Retained receipt/evidence counts and gap/counter observations cover retained dates at the snapshot cutoff, even when the reporting window contains no operations. Their presence is not a nonzero window metric.

The worker reads previously authenticated immutable receipts; it performs no outbound Argo requests. Results pin connection revision, reporting window, receiver cutoff and OEMS revision. Later receipts do not rewrite saved snapshots. Native deployment frequency remains provisional; incomplete coverage and unknown qualification stay visible. Unsupported failure/recovery metrics remain unavailable.

## Rotation, interruptions and storage limits

Disconnect first, then stop API and Argo worker. Replace the private token and producer Secret through your managed workflow; restart both processes, owner re-save and reconnect. Each disconnect and reconnect boundary contributes one recorded gap; a disconnect/reconnect pair contributes two boundaries. An active policy-only re-save contributes none. Source/grant switches record a boundary for each affected binding, and an already-disconnected connection cannot be disconnected again. This path does not support overlapping tokens or zero-loss rotation. Removing a grant and restarting revokes ingress and fences pending work while preserving old results. Disconnected/revoked duplicate deliveries are rejected too.

Retained receipt/evidence counts and gap totals include only the current grant fingerprint and exact scope. Rejection/drift counters and observation-period start describe the entire source lifetime, including previous grant revisions; they are operational counters, not metric evidence. Operation identity and phase/health acceptance limits also persist across credential rotation. Begin new operations with fresh UUIDs after reconnect; for a completely separate history/counter period, register a new source UUID instead of reusing an old source. A source UUID cannot be reassigned to another workspace/service.

Per source: 30 requests/minute, burst 10; 5000 total immutable producer receipts plus normalized evidence records and 8 MiB canonical/normalized data; at most 30 distinct phase/health combinations per operation. Changing an already accepted combination becomes a gap. Exact retries retain their first receiver observation and consume no extra history budget. Exhaustion returns retryable redacted 503 and increments a bounded scalar rejection counter. Retrying forever cannot clear a full store. Frequent automatic unmarked syncs and health changes within the supported horizon consume this budget through gap records too. Monitor retained receipts plus retained evidence records, rejection counters and source activity; this local path has finite history, not automatic retention management. Owner interruption markers are retained separately, so disconnect remains available at producer-history exhaustion.

Recovery: disconnect the exhausted source, preserve its history/results, register a fresh source/grant and deliberately start a new incomplete period. No destructive pruning or automatic cross-source history merge exists. A reconnect can reuse evidence only with an identical fingerprint and scope.

| Symptom | Check |
| --- | --- |
| Setup needed | Matching workspace/service grant, file permissions and API restart. |
| 401 | Correct source UUID/Bearer credential; grants snapshot current; no query token. |
| 409 | Current connection revision, active state, or conflicting reused operation UUID. |
| 503 | Worker/database/readiness, rate limit or retained history budget; inspect only redacted local diagnostics. |
| Recorded gap | Missing UUID/health timestamp, unsupported phase/source mode, clock skew or delivery beyond completion horizon. |
| No receipt despite Healthy | Subscription/template/destination connectivity, notification retry exhaustion and active connection. Healthy is not delivery proof. |
| Provisional zero / unknown | Native exposure remains false; reporting window may exclude retained operations; coverage stays incomplete. |

Polling/backfill, automatic UUID enrichment, exposure attestation, application-source provenance, complete delivery coverage and hosted onboarding remain future capabilities.
