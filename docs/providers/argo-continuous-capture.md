# Continuously capture one Argo Application

This Linux/Node 24 operator process watches one explicitly configured Application and writes contemporaneous native observations into the [durable source journal](argo-history.md) before Clio delivery. It runs until stopped. It requires an operator-managed process and local persistent storage; Clio does not install a controller or choose a production hosting platform.

List/watch observes current state and later changes. It cannot recover operations overwritten before startup or during expired watch history. Consumer exposure, application change linkage, complete deployment population, failure causation and restoration need their own evidence. All three OEMS coverage flags remain false.

## 1. Configure Clio and the journal

Follow [native Argo setup](connect-argocd.md) and [archive grant setup](argo-history.md#prepare-a-source). Bind one exact Application UID and full scope to the intended workspace and service. Generate a separate archive producer UUID, journal UUID and token; choose a policy reference describing capture clocks, storage, interruptions and retained independent proof. Select this archive producer in Settings.

Initialize a non-fictional journal with matching source, producer, journal and policy. Keep its directory outside every Git checkout, mode `0700`, on one local filesystem and Linux PID namespace. Keep private files mode `0600`. Do not reuse a fictional fixture journal for real acquisition. Storage is finite and acknowledged evidence remains retained.

## 2. Supply read-only Kubernetes access

Choose an absolute path to a trusted kubectl executable, a private kubeconfig outside Git and an explicit context. This process does not change the global context. Kubeconfig is trusted executable configuration: approved credential plugins may run with operator privileges. Review it before use. Keep TLS verification enabled for real sources; never substitute an arbitrary endpoint supplied through a browser.

The following namespace Role limits access to one Application. Replace namespace, Application name and ServiceAccount with your intended scope. Apply it through your normal cluster administration workflow; creating credentials and RBAC is separate from running capture.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: clio-application-reader
  namespace: argocd
rules:
  - apiGroups: [argoproj.io]
    resources: [applications]
    resourceNames: [your-application]
    verbs: [get, list, watch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: clio-application-reader
  namespace: argocd
subjects:
  - kind: ServiceAccount
    name: clio-capture
    namespace: argocd
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: clio-application-reader
```

Create that ServiceAccount and arrange short-lived credential renewal through your platform's approved mechanism. Do not grant secret reads, write access or cluster-wide access. The collector sends a `metadata.name` field selector on list/watch requests, required for resourceNames-scoped authorization. See [Kubernetes RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/).

## 3. Write private capture configuration

Create `/absolute/private/capture.json` with mode `0600`. Use actual IDs from your native and archive grants. `scope` must match the native grant exactly; `destinationServer` and `destinationName` retain their actual values or null. Repository URL identifies configuration provenance, not application source lineage.

```json
{
  "journalDirectory": "/absolute/private/argo-journal",
  "kubectlPath": "/absolute/trusted/bin/kubectl",
  "kubeconfig": "/absolute/private/argo.kubeconfig",
  "context": "explicit-cluster-context",
  "scope": {
    "sourceId": "SOURCE_UUID",
    "workspaceId": "WORKSPACE_UUID",
    "serviceId": "SERVICE_UUID",
    "instance": "your-argo-instance",
    "applicationUid": "ACTUAL_APPLICATION_UID",
    "applicationName": "your-application",
    "applicationNamespace": "argocd",
    "project": "default",
    "destinationClusterId": "your-stable-cluster-id",
    "destinationServer": "https://kubernetes.default.svc",
    "destinationName": null,
    "destinationNamespace": "your-workload-namespace",
    "configurationRepositoryId": "github:owner/manifests",
    "repoURL": "https://github.com/owner/manifests.git",
    "environment": "production"
  },
  "producerId": "ARCHIVE_PRODUCER_UUID",
  "journalId": "ARCHIVE_JOURNAL_UUID",
  "policyReference": "urn:your-organization:argo-watch:v1",
  "receiver": {
    "baseUrl": "https://your-clio-receiver.example",
    "tokenFile": "/absolute/private/archive.token"
  }
}
```

Tokens stay in files and authorization headers. Never put their values in command arguments, URLs or configuration JSON. Real receivers use trusted HTTPS; explicit loopback HTTP is permitted for development. Proxy environment is rejected. Configuration, kubeconfig, checkpoint and payloads never enter browser code or Git.

## 4. Run and inspect

From the Clio checkout:

```sh
pnpm argo:capture --config /absolute/private/capture.json
```

Run it under your chosen service supervisor, with a trusted clock and persistent private directory. Start only one capture process per journal. Sender ownership is separate: capture can append while receiver delivery waits, and a manual drain cannot race another sender. Inspect retained/acknowledged progress and capacity with:

```sh
pnpm argo:journal status --directory /absolute/private/argo-journal
```

Arrange explicit operation UUIDs and kinds in deployment automation before operations start. Running, unmarked and unsupported observations are retained for receiver diagnostics rather than invented rollout identity. Annotation-only churn does not append unchanged latest projected native evidence. A→B→A health transitions remain three observations even when transition timestamps are absent. A different UUID at the same revision remains distinct.

Use SIGINT or SIGTERM for normal shutdown. Abrupt process or host loss leaves an unsealed period; restart preserves conservative downtime. Keep journal files and checkpoint together. Do not copy one active journal between PID namespaces, edit immutable records, clear cooldowns or delete checkpoints to make progress appear complete.

## 5. Handle outages and scope changes

Receiver outage leaves capture running and delivery resumable until finite capacity is exhausted. Kubernetes acquisition outage differs: missed periods remain explicit, including expired resourceVersion history and relists. ResourceVersion is opaque cursor state, not operation identity. It resumes watches within the running process. Restart deliberately lists current state and records downtime; it resumes retained evidence/delivery rather than pretending the old cursor recovered every missed operation. Initial/relisted current state cannot fill overwritten operations. [Kubernetes API concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/) describe these watch limits.

Clean watch rollovers retain conservative gaps in the fixed checkpoint instead of appending a seal every thirty seconds. Overlapping gaps coalesce. Hourly cadence closes a seal; overflow beyond 32 separate gaps becomes one conservative union spanning every missing bound, including intervening contacts as uncertain. Restart closes an explicit period. All reconnect failures, including those separated by bookmarks or successful relists, extend durable pending uncertainty until hourly cadence instead of sealing each retry. Incremental seals describe retained periods and interruptions. They do not certify coverage. Restart, quiet streams, bookmarks and clean watch completion cannot prove that every deployment was observed. Reporting window, sealed capture interval and snapshot evidence cutoff remain separate bounds.

UID recreation, scope drift, malformed or oversized responses, clock rollback, corrupt storage and capacity exhaustion stop visibly. Preserve retained data and investigate redacted error codes. Changing Application scope or capture policy requires an explicitly configured new journal period; do not rebind existing history. Permanent receiver conflicts require operator diagnosis. Receiver `401`/`403` also stops this sender until restart: correct the grant/token, then restart the collector with its unchanged journal. Acquisition continues while delivery is paused. Temporary credential-file failures pause delivery while capture continues; malformed or unrepresentable `Retry-After` uses bounded fallback. Representable cooldowns are capped at the local one-day policy maximum; normal provider delays are honored up to that bound. Automatic retries cannot repair divergent records or a full store.

With one merged quiet gap per hour, periodic seals consume about 24 records/day: 5000 seal-only records last roughly 208 days. Entries and process restarts consume capacity faster; shared server native/enrichment budgets can exhaust earlier. This is capacity arithmetic, not a retention guarantee. Monitor and deliberately configure a new incomplete period before exhaustion.

After replay, enqueue a new closed-period snapshot and run the Argo worker using the same server-side grants as the API. Earlier saved snapshots stay unchanged. A successful drain or zero visible gaps does not promote OEMS coverage.

## Verified local proof, 2026-10-10

The dedicated `kind-clio-argocd` sandbox supplied an actual list and watch for `argocd/clio-evidence-demo`, bound to its existing UID. A temporary annotation generated one real Kubernetes watch event and was removed afterward. Both observations projected to identical native evidence: one immutable entry remained, with a durable opaque cursor and one conservative seal. Two records stayed pending while the deliberately unavailable loopback receiver could not acknowledge them. Existing Application workload, private source grants and subscriptions were preserved. This proves scoped acquisition and bookkeeping deduplication, not a new deployment or production installation.

A separate PostgreSQL integration test uses a controlled Kubernetes transport and a real stalled loopback HTTP receiver. Running and terminal observations are retained while delivery is blocked; later authenticated archive replay survives a lost committed acknowledgement, yields one retained operation through the Argo snapshot worker and leaves an earlier saved result identical. All three coverage flags remain false. Run `pnpm test:integration` with the disposable database setting from [getting started](../getting-started.md); tests create and remove only their own random schemas.

See [coverage evidence and next collection contracts](argo-coverage.md) for saved diagnostic counts and the separate deployment census, change-history and recovery boundaries needed after capture/replay.
