# Reproduce independent artifact evidence locally

This Linux/Node 24 walkthrough evaluates the full Clio path without a production source. Use the dedicated Kind cluster from [local Argo setup](local-argocd.md), a running development API/PostgreSQL, and an owner-signed-in browser. It does not install a production traffic observer or assert OEMS conformance. The artifact is committed HTML, not an OCI image digest. Both build provenance and consumer exposure use separate sandbox credentials and policies.

## Prepare an isolated source

Create a dedicated Clio service and a new `clio-evidence-demo` Application in `argocd`, with destination namespace `clio-evidence-demo`. Stop if either name already belongs to another workload. Create the namespace explicitly. Use `https://github.com/lgulliver/clio.git`, single-source path `infra/argocd/evidence-demo/manifests`, and a full committed configuration SHA that contains the generated manifest. Leave automated synchronization disabled. Every kubectl command must use the dedicated kubeconfig and `--context kind-clio-argocd`; never change the global context.

Record the actual Application UID and exact scope. Follow [native source configuration](connect-argocd.md) to generate a new source UUID, private native token and grant. Set its environment to `sandbox-evaluation`. Do not reuse a production service, source or environment. Keep existing grants intact. Follow [independent producer configuration](argo-enrichment.md) to add two distinct UUIDs and private tokens: exposure policy `urn:clio:sandbox:http-artifact:v1`, empty repository list; build policy `urn:clio:sandbox:git-artifact-build:v1`, explicit repository list containing `github:lgulliver/clio`. Both reference the new native source UUID. Restart API and worker with both private grant-file settings. In Clio Settings, select the new service, Live Argo source, both producers, confirm service assignment, and save.

Use a private working directory outside every Git checkout, mode `0700`, with private files mode `0600`. Set these shell variables to your own absolute paths and IDs; tokens themselves never become shell arguments:

```sh
export CLIO_ARGO_KUBECONFIG="$PWD/.agent-runs/clio-argocd.kubeconfig"
export CLIO_DEMO_PRIVATE="$HOME/.local/share/clio/evidence-demo"
export CLIO_DEMO_SOURCE='YOUR_SOURCE_UUID'
export CLIO_DEMO_BUILD_PRODUCER='YOUR_BUILD_PRODUCER_UUID'
export CLIO_DEMO_EXPOSURE_PRODUCER='YOUR_EXPOSURE_PRODUCER_UUID'
export CLIO_DEMO_CONFIG_SHA='FULL_CONFIGURATION_COMMIT_SHA'
export CLIO_DEMO_APP_SHA='FULL_APPLICATION_SOURCE_COMMIT_SHA'
umask 077
mkdir -p "$CLIO_DEMO_PRIVATE"
```

The application source commit supplies HTML. The configuration commit supplies Kubernetes resources. They can belong to the same repository but remain different facts. A configuration SHA never substitutes for application-source provenance.

## Build and commit immutable resources

The first source commit must contain `infra/argocd/evidence-demo/app/index.html`. Build it with the [producer CLI](../../infra/argocd/evidence-demo/README.md):

```sh
node infra/argocd/evidence-demo/cli.ts build "$PWD" "$CLIO_DEMO_APP_SHA" github:lgulliver/clio "$CLIO_DEMO_PRIVATE/artifact"
node infra/argocd/evidence-demo/cli.ts provenance "$CLIO_DEMO_PRIVATE/artifact" "$CLIO_DEMO_SOURCE" "$CLIO_DEMO_BUILD_PRODUCER" "$CLIO_DEMO_PRIVATE/build-evidence"
mkdir -p infra/argocd/evidence-demo/manifests
node infra/argocd/evidence-demo/cli.ts render "$CLIO_DEMO_PRIVATE/artifact" docker.io/library/nginx:1.29.3-alpine@sha256:b3c656d55d7ad751196f21b7fd2e8d4da9cb430e32f646adcf92441b72f82b14 > infra/argocd/evidence-demo/manifests/resources.json
```

Inspect and commit only the generated public Kubernetes resources, after repository checks. Push the configuration commit through your normal reviewed workflow. Set `CLIO_DEMO_CONFIG_SHA` to that commit and pin the Application to it. Private receipts and assertions stay outside Git.

For a fresh dedicated Application, create its namespace and render the public scope into a private setup file after setting the pushed configuration SHA:

```sh
kubectl --kubeconfig "$CLIO_ARGO_KUBECONFIG" --context kind-clio-argocd create namespace clio-evidence-demo
node --input-type=module - <<'JS' > "$CLIO_DEMO_PRIVATE/application-setup.json"
const revision = process.env.CLIO_DEMO_CONFIG_SHA;
if (!/^[0-9a-f]{40}$/.test(revision ?? '')) throw new Error('Set configuration commit first');
console.log(JSON.stringify({apiVersion:'argoproj.io/v1alpha1',kind:'Application',metadata:{name:'clio-evidence-demo',namespace:'argocd'},spec:{project:'default',source:{repoURL:'https://github.com/lgulliver/clio.git',targetRevision:revision,path:'infra/argocd/evidence-demo/manifests'},destination:{server:'https://kubernetes.default.svc',namespace:'clio-evidence-demo'}}}));
JS
kubectl --kubeconfig "$CLIO_ARGO_KUBECONFIG" --context kind-clio-argocd create -f "$CLIO_DEMO_PRIVATE/application-setup.json"
```

Before synchronization, finish the source grant and owner connection described above using this Application's actual UID. Never overwrite an existing Application to make this example run.
For the supplied committed sample, use the application commit recorded in the manifest README rather than rebuilding HTML from an unrelated configuration commit.

## Record the pre-rollout state

For a new sandbox only, bootstrap the dedicated workload with the pinned NGINX default page. This creates a real earlier HTTP state with different bytes, without claiming any qualifying deployment:

```sh
kubectl --kubeconfig "$CLIO_ARGO_KUBECONFIG" --context kind-clio-argocd create -f infra/argocd/evidence-demo/bootstrap/resources.json
kubectl --kubeconfig "$CLIO_ARGO_KUBECONFIG" --context kind-clio-argocd -n clio-evidence-demo rollout status deployment/sandbox-consumer --timeout=180s
kubectl --kubeconfig "$CLIO_ARGO_KUBECONFIG" --context kind-clio-argocd -n clio-evidence-demo port-forward --address 127.0.0.1 svc/sandbox-consumer 8099:80
```

Keep the forward running in its own terminal. Before starting the rollout, persist the actual response in a fresh private file:

```sh
export CLIO_DEMO_OPERATION_ID=$(node -e 'console.log(crypto.randomUUID())')
node infra/argocd/evidence-demo/cli.ts baseline http://127.0.0.1:8099/index.html "$CLIO_DEMO_OPERATION_ID" "$CLIO_DEMO_PRIVATE/baseline.json"
```
A valid baseline is a `404` or different bytes. A matching baseline cannot establish a consumer-visible change. Its planned operation UUID must match the captured native operation; reusing it for another operation is rejected. Never edit the baseline timestamp or replace its contents to make a repeated sync qualify. Endpoint continuity remains operator trust: this probe does not attest Pod identity or real consumer traffic.

## Trigger and capture one real operation

Use the exact operation UUID bound to the pre-rollout baseline, then synchronize the exact configuration commit with operation info `clio.operation-id` and `clio.operation-kind=rollout`. The [real-source guide](connect-argocd.md#4-give-each-operation-explicit-identity) shows the authorized Argo CLI method. In this disposable sandbox, an authorized Kubernetes operator may instead patch only this Application with an `operation.sync.revision` and those info fields. That direct patch proves neither Argo API role authorization nor API-account identity. Do not invent `initiatedBy`. For the dedicated sandbox only:

```sh
node --input-type=module - <<'JS' > "$CLIO_DEMO_PRIVATE/operation-patch.json"
const revision = process.env.CLIO_DEMO_CONFIG_SHA;
const operationId = process.env.CLIO_DEMO_OPERATION_ID;
if (!/^[0-9a-f]{40}$/.test(revision ?? '') || !operationId) throw new Error('Set and export revision and operation UUID first');
console.log(JSON.stringify({spec:{source:{targetRevision:revision}},operation:{sync:{revision},info:[{name:'clio.operation-id',value:operationId},{name:'clio.operation-kind',value:'rollout'}]}}));
JS
kubectl --kubeconfig "$CLIO_ARGO_KUBECONFIG" --context kind-clio-argocd -n argocd patch application clio-evidence-demo --type merge --patch-file "$CLIO_DEMO_PRIVATE/operation-patch.json"
```

Wait for this exact operation UUID in controller state; do not capture the previous operation.

Wait for the controller's actual operation state and workload rollout. A port-forward targets a particular Pod and can stop when that Pod is replaced: restart the same scoped forward after rollout if needed. Capture actual controller state:

```sh
kubectl --kubeconfig "$CLIO_ARGO_KUBECONFIG" --context kind-clio-argocd -n argocd get application clio-evidence-demo -o json > "$CLIO_DEMO_PRIVATE/application.json"
node infra/argocd/evidence-demo/cli.ts native "$CLIO_DEMO_PRIVATE/application.json" "$CLIO_DEMO_PRIVATE/native-notification.json" "$CLIO_DEMO_OPERATION_ID"
```

For this walkthrough the operator submits the generated native notification to the native endpoint with the private native token. This is an authenticated operator producer, not proof of automatic notifications-controller delivery. Configure the separate [notification service](connect-argocd.md#3-configure-the-trusted-notification-producer) for automated real sources. Do not overwrite the existing guestbook subscription or tunnel.

## Publish and compare immutable snapshots

Publish the build assertion first, then generate exposure from the saved baseline and exact artifact:

```sh
node infra/argocd/evidence-demo/cli.ts publish "$CLIO_DEMO_PRIVATE/build-evidence/event.json" http://localhost:3000 "$CLIO_DEMO_PRIVATE/build.token"
node infra/argocd/evidence-demo/cli.ts observe "$CLIO_DEMO_PRIVATE/artifact" "$CLIO_DEMO_PRIVATE/native-notification.json" "$CLIO_DEMO_PRIVATE/baseline.json" http://127.0.0.1:8099/index.html "$CLIO_DEMO_SOURCE" "$CLIO_DEMO_EXPOSURE_PRODUCER" "$CLIO_DEMO_PRIVATE/exposure-evidence"
```
Only exact bytes matching the artifact after a genuinely different pre-rollout observation produce an assertion. Its timestamp is current observed time; native health does not gate the independent probe.

Before publishing exposure, submit the actual native envelope with its own token:

```sh
node infra/argocd/evidence-demo/cli.ts native-publish "$CLIO_DEMO_PRIVATE/native-notification.json" http://localhost:3000 "$CLIO_DEMO_SOURCE" "$CLIO_DEMO_PRIVATE/native.token"
```
Then queue a closed UTC-day snapshot in Live Argo and process it with `pnpm worker:argo --once`, using the same grant-file configuration as the API. Native plus build inventory still leaves rollout qualification unknown.

Publish the saved exposure event with its distinct token:

```sh
node infra/argocd/evidence-demo/cli.ts publish "$CLIO_DEMO_PRIVATE/exposure-evidence/event.json" http://localhost:3000 "$CLIO_DEMO_PRIVATE/exposure.token"
```
Queue a new snapshot over the same closed period and run the worker again. The later result should retain one qualified rollout and attach application repository/commit provenance through the exact artifact digest. The earlier snapshot stays unchanged. `tip_provenance` remains empty and no change/lead-time evidence is inferred. Coverage remains incomplete; failure, recovery and rework metrics remain unavailable.

Today's fresh rollout is outside yesterday's closed reporting window. Retained qualified count can be one while that window's deployment-frequency count is zero. After UTC midnight, explicitly queue the closed period containing activation to calculate its window count. Never backdate evidence to populate a chart. Overview displays saved results with source, window and cutoff; select this sandbox service rather than guestbook or mock history.

## Failure checks

| Symptom | Required action |
| --- | --- |
| Matching baseline / unchanged re-sync | No exposure assertion. Keep the same facts; test a real new artifact change with a fresh pre-rollout baseline and operation. |
| Wrong HTTP bytes, redirect, compression, timeout or oversized response | No assertion is produced. Check the exact scoped endpoint and workload; do not disable validation. |
| Missing UUID, non-rollout or native retry | Fix deployment automation for a future operation. The demo intentionally supports fresh rollout operations with retry count zero. |
| Exposure before native anchor: `409` | Deliver the eligible native envelope, then retry the same persisted exposure event and UUID. |
| Changed content under an existing UUID: `409` | Preserve history and investigate the conflict; a new UUID cannot override a subject/provenance lock. |
| Rate limited | Respect `Retry-After` and source ingress budget; do not spin retries. |
| Build inventory but unknown qualification | Independent exposure was not delivered, selected, eligible or inside snapshot cutoff. |
| Qualified retained rollout but window count zero | Check actual activation time against the closed reporting period. |
| No controller notification | Check its own subscription/connectivity. This operator-pull demo does not verify that path. |

Keep private receipts for reproducibility. Stop only the demo port-forward when finished; cluster/workload/grants persist for inspection. Cluster deletion is a separate destructive operator action described in the sandbox guide.

The sandbox trusts the operator to prevent intervening deployments, manual resource changes and endpoint replacement between baseline capture and the planned rollout. UUID binding does not prove that causal link. Capture immediately before the rollout and keep the dedicated workload under one operator during the exercise.
