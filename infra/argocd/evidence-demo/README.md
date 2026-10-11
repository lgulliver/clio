# Independent sandbox evidence producers

Run these Node 24 native TypeScript commands from the repository root. They produce local evidence for explicitly selected sandbox consumers. They are not production build attestations, traffic observers, OCI image digests, or coverage proof.

The artifact is the exact UTF-8 bytes of `infra/argocd/evidence-demo/app/index.html` from a full 40-character committed Git SHA. A dirty checkout cannot change those bytes. The receipt records the explicitly supplied application repository identity, application commit, source path and `sha256:` digest of the HTML bytes. The operator must verify that repository identity matches the selected Git repository; this helper does not verify remote ownership or signatures.

```sh
node infra/argocd/evidence-demo/cli.ts build /absolute/git/repo FULL_COMMIT_SHA github:owner/repository /outside/git/build-unique
node infra/argocd/evidence-demo/cli.ts provenance /outside/git/build-unique SOURCE_UUID BUILD_PRODUCER_UUID /outside/git/build-evidence-unique
node infra/argocd/evidence-demo/cli.ts render /outside/git/build-unique docker.io/library/nginx:1.29.3-alpine@sha256:b3c656d55d7ad751196f21b7fd2e8d4da9cb430e32f646adcf92441b72f82b14 > /outside/git/resources.json
```

The renderer creates a Kubernetes List with a dedicated `clio-evidence-demo` namespace, immutable content-addressed ConfigMap, digest-pinned NGINX Deployment, and ClusterIP Service. HTML uses a read-only `subPath` mount; new artifact means a new ConfigMap and Pod template. It creates no Ingress or NodePort. Cluster application and an explicitly scoped localhost port-forward are separate operator actions.

Generate one operation UUID before baseline capture. Reuse that exact UUID for the authorized Argo rollout and native capture; do not generate another UUID after the baseline. Before initiating the rollout, record the current reachable sandbox endpoint. A prior different artifact (HTTP 200) or initial HTTP 404 is required; an already identical artifact cannot establish a fresh activation. Keep the endpoint and port-forward stable across baseline and rollout:

```sh
export CLIO_DEMO_OPERATION_ID="$(node -e 'console.log(require("node:crypto").randomUUID())')"
node infra/argocd/evidence-demo/cli.ts baseline http://127.0.0.1:8099/index.html "$CLIO_DEMO_OPERATION_ID" /outside/git/pre-rollout-baseline.json
```

Initiate the explicitly marked rollout with `clio.operation-id=$CLIO_DEMO_OPERATION_ID` after that capture using the authorized Argo sync procedure in `docs/providers/connect-argocd.md`. This observer supports `retryCount: 0` only. Use the explicitly named `sandbox-evaluation` environment for this demo; never assign it to a production service/environment.

Capture the actual Application JSON and convert it into the notification envelope described in `docs/providers/connect-argocd.md`:

```sh
kubectl --kubeconfig "$PWD/.agent-runs/clio-argocd.kubeconfig" --context kind-clio-argocd -n argocd get application clio-evidence-demo -o json > /outside/git/application.json
node infra/argocd/evidence-demo/cli.ts native /outside/git/application.json /outside/git/native-notification.json "$CLIO_DEMO_OPERATION_ID"
node infra/argocd/evidence-demo/cli.ts native-publish /outside/git/native-notification.json http://localhost:3000 SOURCE_UUID /outside/git/native.token
```

Use a fresh output filename for each capture. The transformer selects actual Kubernetes fields without copying unrelated metadata or resources. It requires a real explicit rollout operation UUID; missing identity fails without generating a substitute. Missing native timestamps, completion or health remain `null` and can be recorded as receiver gaps rather than completed rollouts. Default zero retry count and false automated flag match the native notification template. It does not create, sync or modify an Application. Preserve its exact Application UID, rollout operation UUID, configuration revision and start timestamp. Save it outside Git and submit the native notification to Clio before enrichment. The demo checks binding fields from the supplied native envelope; Clio performs full native receiver validation independently. The observer requires an explicit `rollout` marker and observes current time; it cannot backdate activation. It has no Argo health gate: independent exact-byte observation can succeed even when native health is degraded.

```sh
node infra/argocd/evidence-demo/cli.ts observe /outside/git/build-unique /outside/git/native-notification.json /outside/git/pre-rollout-baseline.json http://127.0.0.1:8099/index.html SOURCE_UUID EXPOSURE_PRODUCER_UUID /outside/git/exposure-evidence-unique
node infra/argocd/evidence-demo/cli.ts publish /outside/git/build-evidence-unique/event.json http://localhost:3000 /outside/git/build.token
node infra/argocd/evidence-demo/cli.ts publish /outside/git/exposure-evidence-unique/event.json http://localhost:3000 /outside/git/exposure.token
```

Use distinct capability-scoped grants with policies `urn:clio:sandbox:git-artifact-build:v1` and `urn:clio:sandbox:http-artifact:v1`. Producer and source UUIDs must match deliberately selected operator grants. Token files must contain the Clio lowercase 64-character hexadecimal credential and must be absolute, owned by the current user, regular non-symlink files with mode `0600`, outside Git. Never pass credentials as command arguments or commit generated evidence containing private source scope.

The observer permits HTTP loopback `/index.html` only, rejects redirects and compressed responses, limits work to five seconds and 64 KiB, and requires exact artifact bytes plus a same-endpoint baseline bound to that exact operation UUID and strictly before operation start with different served bytes or HTTP 404. It records the baseline in the observation receipt. Unchanged heartbeats and baselines from another operation UUID are rejected. The optional expected UUID argument on `native` checks actual captured operation info without rewriting it. Failure creates no assertion. Its receipt records endpoint, timestamp, digest and byte count. These prove only that this sandbox HTTP probe received those bytes under the stated sandbox policy; they do not establish real production traffic, pod identity or end-user reachability.

Evidence directories are created exclusively. Publication never changes persisted events or generates retry UUIDs. Retry the same `publish` command after a missing-anchor `409`; inspect source setup when `409` persists. Non-2xx sets a failure exit code and prints status only, preserving evidence for operator inspection. Never resolve conflicting facts by changing UUIDs or deleting history.

Network commands reject configured proxy environment variables so private credentials and localhost probes cannot be redirected through an environment proxy. Run them in a shell without proxy variables. Git build commands strip inherited `GIT_*` overrides and reject symlink tree entries.

Follow the [complete sandbox walkthrough](../../../docs/providers/argo-evidence-demo.md) for grants, bootstrap, synchronization and snapshot comparison. Output locations outside Git are an operator requirement; the CLI enforces this restriction for token files only.

The sandbox trusts the operator to prevent intervening deployments, manual resource changes and endpoint replacement between baseline capture and the planned rollout. UUID binding does not prove that causal link. Capture immediately before the rollout and keep the dedicated workload under one operator during the exercise.

The separate [controlled lifecycle exercise](../../../docs/providers/argo-lifecycle-demo.md) adds healthy/broken/recovery manifest profiles, artifact-bound functional probes, and `lifecycle-cli.ts` report generation. It defaults to partial coverage, preserves observed times, and keeps approximate recovery separate from exact recovery.
