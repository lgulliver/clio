# Optional local Argo CD sandbox

This sandbox is optional and independent of Clio's [mock workflow](../getting-started.md). Kind runs Kubernetes nodes in Docker; Argo CD is a Kubernetes controller, not a standalone docker-compose service. Installing it does not enable a Clio live connector, populate collection runs or prove real production exposure.

## Tools and verified pins

Install prerequisites manually: [Docker Engine](https://docs.docker.com/engine/install/), [Kind release binaries](https://kind.sigs.k8s.io/docs/user/quick-start/#installation), and [kubectl](https://kubernetes.io/docs/tasks/tools/) matching Kubernetes 1.36. This guide uses kubectl and the browser; the Argo CLI is not required. Docker must be running, with enough resources for Kubernetes and the non-HA Argo controllers, and public registry/GitHub access.

Pins checked against official sources on 2026-10-10:

| Component | Selected pin | Verification |
| --- | --- | --- |
| Kind | `v0.33.0` | [Released tag and node image list](https://github.com/kubernetes-sigs/kind/releases/tag/v0.33.0) |
| Kubernetes node | `kindest/node:v1.36.4@sha256:099e049362a1526b2db71494e1947aae99bd16290d7c895f2b7ea312e3cbfaed` | Digest listed for that Kind release |
| Argo CD | `v3.5.4`, non-HA `manifests/install.yaml` | [Released tag](https://github.com/argoproj/argo-cd/releases/tag/v3.5.4) and [released manifest](https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.4/manifests/install.yaml) |
| Guestbook Git revision | `f58c7ed8cfe28ad70701c5923fdbd0154388ea9f` | [Official example repository commit](https://github.com/argoproj/argocd-example-apps/commit/f58c7ed8cfe28ad70701c5923fdbd0154388ea9f) |

Argo's [3.5 tested-version matrix](https://github.com/argoproj/argo-cd/blob/v3.5.4/docs/operator-manual/tested-kubernetes-versions.md) includes Kubernetes 1.36. These are selected compatible releases, not a claim of latest versions or current production suitability. Node digest and release manifest are fixed; guestbook container images use upstream tags, so this is not a fully image-digest-reproducible workload. Runtime installation/sync was verified on 2026-10-10: all seven Argo pods Ready, server/repo-server/controller rollout checks passed, and the pinned guestbook reached Synced/Healthy in a dedicated Kind cluster. This does not verify Clio ingestion, notification templates, production exposure or full image reproducibility.

Upstream references: [Try Argo CD locally](https://argo-cd.readthedocs.io/en/stable/try_argo_cd_locally/), [Argo getting started](https://argo-cd.readthedocs.io/en/stable/getting_started/), [Kind quick start](https://kind.sigs.k8s.io/docs/user/quick-start/). Their floating examples may shift; use the explicit pins below.

## Create only the named sandbox

Run from the Clio repository root. First inspect:

```sh
kind version
kubectl version --client
docker info
kind get clusters
```

If `clio-argocd` already exists, stop and identify its owner/purpose before proceeding. Do not reuse or delete an unrelated cluster bearing that name. The following setup keeps credentials under ignored `.agent-runs`, never merges into the global kubeconfig, and forces Docker as the Kind provider. Run each command only after its predecessor succeeds.

```sh
mkdir -p .agent-runs
export CLIO_ARGO_KUBECONFIG="$PWD/.agent-runs/clio-argocd.kubeconfig"
(
  set -e
  umask 077
  test ! -e "$CLIO_ARGO_KUBECONFIG"
  KIND_EXPERIMENTAL_PROVIDER=docker kind create cluster \
  --name clio-argocd \
  --kubeconfig "$CLIO_ARGO_KUBECONFIG" \
  --image kindest/node:v1.36.4@sha256:099e049362a1526b2db71494e1947aae99bd16290d7c895f2b7ea312e3cbfaed \
  --wait 120s
)
kubectl --kubeconfig "$CLIO_ARGO_KUBECONFIG" --context kind-clio-argocd cluster-info
```

Do not continue if the `test` fails. Use this dedicated path and `kind-clio-argocd` on every kubectl command. In each new terminal, return to this root and set `CLIO_ARGO_KUBECONFIG` to the same absolute path. Do not use `kubectl config use-context` or export global `KUBECONFIG`.

## Install Argo and reach its UI

The release's non-HA manifest grants controller permissions, including cluster administration, inside this disposable sandbox. It is an evaluation installation.

```sh
kubectl --kubeconfig "$CLIO_ARGO_KUBECONFIG" --context kind-clio-argocd create namespace argocd
kubectl --kubeconfig "$CLIO_ARGO_KUBECONFIG" --context kind-clio-argocd apply --server-side -n argocd \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.4/manifests/install.yaml
kubectl --kubeconfig "$CLIO_ARGO_KUBECONFIG" --context kind-clio-argocd -n argocd \
  rollout status deployment/argocd-server --timeout=300s
kubectl --kubeconfig "$CLIO_ARGO_KUBECONFIG" --context kind-clio-argocd -n argocd \
  rollout status deployment/argocd-repo-server --timeout=300s
kubectl --kubeconfig "$CLIO_ARGO_KUBECONFIG" --context kind-clio-argocd -n argocd \
  rollout status statefulset/argocd-application-controller --timeout=300s
kubectl --kubeconfig "$CLIO_ARGO_KUBECONFIG" --context kind-clio-argocd -n argocd \
  port-forward --address 127.0.0.1 svc/argocd-server 8080:443
```

Keep that terminal running. Open **https://127.0.0.1:8080**. The default server certificate is self-signed; a browser certificate exception is appropriate only for this verified loopback sandbox. Do not disable browser certificate validation globally or change Argo's TLS/auth settings to accommodate it. No ingress, LoadBalancer or externally listening port is needed. Upstream documents [port-forwarded access and bootstrap login](https://argo-cd.readthedocs.io/en/stable/getting_started/#port-forwarding).

In another local terminal, set the same path and display the bootstrap password **only there**:

```sh
export CLIO_ARGO_KUBECONFIG="$PWD/.agent-runs/clio-argocd.kubeconfig"
kubectl --kubeconfig "$CLIO_ARGO_KUBECONFIG" --context kind-clio-argocd -n argocd \
  get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 --decode
printf '\n'
```

Log in as `admin`. Do not collect the password in chat, screenshots or handoff files. Change it locally through the UI's user/password settings. After confirming the changed password works, remove only the bootstrap secret as recommended by [Argo's bootstrap instructions](https://argo-cd.readthedocs.io/en/stable/getting_started/#log-in-using-the-cli):

```sh
kubectl --kubeconfig "$CLIO_ARGO_KUBECONFIG" --context kind-clio-argocd -n argocd \
  delete secret argocd-initial-admin-secret
```

## Optional public guestbook sync

This uses the [official plain-YAML guestbook example](https://github.com/argoproj/argocd-example-apps/tree/master/guestbook), pinned to the Git commit above. No private repository, GitHub token or new credentials are required. It deploys only into this sandbox's `clio-guestbook` namespace; it does not register another cluster.

```sh
kubectl --kubeconfig "$CLIO_ARGO_KUBECONFIG" --context kind-clio-argocd create namespace clio-guestbook
kubectl --kubeconfig "$CLIO_ARGO_KUBECONFIG" --context kind-clio-argocd apply -f - <<'YAML'
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: clio-guestbook
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/argoproj/argocd-example-apps.git
    targetRevision: f58c7ed8cfe28ad70701c5923fdbd0154388ea9f
    path: guestbook
  destination:
    server: https://kubernetes.default.svc
    namespace: clio-guestbook
YAML
```

Application creation and controller reconciliation are asynchronous. Wait until the Application exists and the sync creates the workload before running deployment rollout checks; an immediate NotFound does not mean sync failed.

In the Argo UI, open `clio-guestbook`, inspect the pinned revision and resources, then choose **Sync** and synchronize that revision. Automatic sync is not configured. Check the resulting controller operation and workload:

```sh
kubectl --kubeconfig "$CLIO_ARGO_KUBECONFIG" --context kind-clio-argocd -n argocd get application clio-guestbook
kubectl --kubeconfig "$CLIO_ARGO_KUBECONFIG" --context kind-clio-argocd -n clio-guestbook get deployments,pods,services
```

Synced/Healthy reports reconciliation and health, not customer exposure. Guestbook is not production; a configuration Git SHA is not application-source provenance. Native Clio ingestion requires explicit instance/cluster/application/service mapping, authenticated receipts and immutable operation identity/history. Exposure enrichment and cross-provider rollout correlation remain separate future contracts. Matching SHAs never establish that correlation automatically. Connect this sandbox deliberately using [native Argo notification setup](connect-argocd.md), including a private source grant, operation UUID info, custom notification trigger and separate snapshot worker. Selecting a mock Argo source does not connect the controller.

## Verified connection to Clio

On 2026-10-10 this sandbox was deliberately connected through a private scoped ingestion
grant and an owner-saved service connection. Two native Argo API sync operations at the same
configuration SHA produced separate durable Clio receipts; an unmarked sync produced a gap.
The separate Argo snapshot worker completed a closed UTC-day capture, and the authenticated
Live Argo panel showed three retained receipts, two deployments with unknown qualification,
one missing-identity gap and incomplete coverage. Counts span all retained dates at cutoff;
the prior-day reporting window does not include today's evaluation operations. Mock history
and GitHub operator setup remained separate. See [detailed producer and receiver proof](../../infra/argocd/README.md).

Docker Desktop's Kind network could not reach host loopback directly. This proof used a
temporary source-scoped, bounded and independently authenticated tunnel on the isolated
Kind network, with its host transport published only on loopback. Clio's API remained
`127.0.0.1:3000`. This tunnel is evaluation tooling, not a supported hosted ingress or a
portable local installation step. For your installation, provide a trusted HTTPS receiver
reachable by the notification controller as described in [connecting Argo CD](connect-argocd.md).
Do not assume that a successful localhost request proves controller connectivity.

## Diagnostics and cleanup

If installation stalls, check resources, pull access and events only in the sandbox:

```sh
kubectl --kubeconfig "$CLIO_ARGO_KUBECONFIG" --context kind-clio-argocd -n argocd get pods
kubectl --kubeconfig "$CLIO_ARGO_KUBECONFIG" --context kind-clio-argocd -n argocd get events --sort-by=.metadata.creationTimestamp
```

A connection refusal means port-forward stopped or server is not ready. Port 8080 busy: stop the conflicting local process or choose another loopback port in the forward/browser URL. A context error means the dedicated file/path is wrong; do not fall back to global context. Repository or ImagePullBackOff errors need public Git/registry connectivity; do not introduce private credentials as a workaround. Keep logs local because Kubernetes diagnostics can contain sensitive configuration.

Stop port-forward with Ctrl+C. To destroy the sandbox, first confirm `clio-argocd` is the cluster created above. **The command below permanently deletes that cluster and all its applications, workloads and stored sandbox data.** It does not stop Clio's PostgreSQL Compose service or remove its volume. The explicit kubeconfig keeps other kube contexts untouched.

```sh
KIND_EXPERIMENTAL_PROVIDER=docker kind delete cluster \
  --name clio-argocd --kubeconfig "$CLIO_ARGO_KUBECONFIG"
```

After successful deletion, remove only its local credential file:

```sh
rm -- "$CLIO_ARGO_KUBECONFIG"
unset CLIO_ARGO_KUBECONFIG
```

Do not use Docker pruning, unscoped cluster deletion or `docker compose down --volumes` for sandbox cleanup.
