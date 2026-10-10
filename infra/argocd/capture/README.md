# Scoped Argo capture process

Node 24 on Linux runs `node infra/argocd/capture/cli.ts --config /absolute/private/capture.json`.
The coordinator registers the corresponding pnpm command. The process reads one Application;
it does not reconstruct history or claim complete coverage.

Create an empty matching journal with the journal CLI first. The capture configuration, kubeconfig,
and receiver token must be real owner-only `0600` files outside every Git checkout. The journal
must be an owner-only `0700` directory outside Git. The absolute kubectl executable and kubeconfig
are trusted operator inputs. Kubeconfig credential exec plugins execute with the operator's privileges;
only use approved plugins and endpoints. Proxy environment variables are rejected. TLS behavior
comes from the explicitly selected trusted context; the collector adds no insecure TLS flag.

Configuration has exactly these keys (replace all example values with the existing private bindings):

```json
{
  "journalDirectory": "/private/clio/journal",
  "kubectlPath": "/usr/local/bin/kubectl",
  "kubeconfig": "/private/clio/kubeconfig",
  "context": "explicit-context",
  "scope": {
    "sourceId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "workspaceId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "serviceId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "instance": "operator-instance",
    "applicationUid": "actual-application-uid",
    "applicationName": "clio-evidence-demo",
    "applicationNamespace": "argocd",
    "project": "default",
    "destinationClusterId": "operator-cluster-id",
    "destinationServer": "https://kubernetes.default.svc",
    "destinationName": null,
    "destinationNamespace": "clio-evidence-demo",
    "configurationRepositoryId": "operator-repository-id",
    "repoURL": "https://example.com/operator/repository.git",
    "environment": "production"
  },
  "producerId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  "journalId": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  "policyReference": "urn:operator:existing-policy",
  "receiver": {
    "baseUrl": "https://clio.example.com",
    "tokenFile": "/private/clio/archive-token"
  }
}
```

All configuration fields and native scope are bound immutably in `capture-state.json`. Changing
scope or rotating configuration paths requires an explicitly separate collector checkpoint/journal;
do not delete checkpoints to bypass drift checks. Application recreation, deletion and scope drift
stop capture. Unsupported multi-source/hydrator operation shapes remain original observations for
receiver gaps, subject to the same source-scope rules as native ingestion.

List is bounded to 15 seconds and 512 KiB. Watch is bounded to a 30-second server request and a
35-second child lifetime. Events and framing buffers are capped at 512 KiB. Journal's smaller
immutable envelope limit still applies; oversized evidence stops rather than being truncated.
Opaque resourceVersion is checkpointed after journal fsync. Bookmarks update contact/cursor only.
Repeated latest projected payloads reuse the exact retained entry; A→B→A, changed operation IDs or phases append.

Clean watch rollover gaps persist in the bounded checkpoint, with hourly seals. Overlapping gaps coalesce; overflow beyond 32 separate gaps becomes one conservative union without dropping any bound. Restart closes a positive period; all reconnect failures, including contact-separated flapping, retain pending uncertainty until hourly cadence.
Cursor resumes within a running process; restart deliberately relists and records downtime. Current list after an expired cursor cannot recover overwritten operations. SIGINT/SIGTERM cancels
watch and stops sender scheduling; bounded in-flight sender work finishes, leaving honest unsealed
uncertainty. Journal remains finite (at most 5000 records/8 MiB); capacity, corruption, malformed input
and backward clocks stop visibly. No pruning or budget resets occur.

Independent one-attempt sender batches cache durable receiver cooldown, avoiding repeated full journal reads. Temporary credential faults pause delivery; malformed/unrepresentable Retry-After falls back safely; representable values are capped at one day. Writer contention waits with cancellation instead of discarding an observation. Receiver outage does not block
acquisition. A permanent receiver conflict stops sender retries and is reported while acquisition
continues retaining until capacity. Progress contains counts and redacted delivery codes only.
