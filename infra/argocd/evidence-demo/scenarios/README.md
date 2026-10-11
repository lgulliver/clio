# Controlled lifecycle profiles

Argo synchronizes one stage directory at a time into the dedicated `clio-lifecycle-demo` namespace. The stage changes HTML bytes and functional `/healthz` behaviour; `/index.html` continues serving the exact artifact even during the deliberately broken stage. Successful Argo synchronization is therefore separate from functional failure.

The embedded HTML artifacts came from three actual commits in a private local application Git repository named `local:clio-lifecycle-app`:

| Stage | Application commit | Artifact digest |
| --- | --- | --- |
| healthy | `14f81e04a6de482288e29d2081b14a0b16762ca0` | `sha256:98db8efd4d9bcfe0cbec4d4bdea5e2e826723c64c90e37e9ffd27f3936f9a089` |
| broken | `42218c0e80b147f9de00b16198b502146bc2203b` | `sha256:dccbb153616ec8cd80b726856a3b0ff0069ff360c8a513edc06b9f637f5da3b5` |
| recovery | `6a89e78dd342804ccf64db7ce5da42420ab6b67e` | `sha256:84e20e0266aeac84bfc14b3dfc75b3a46e550d8b69ea9d65b9bed687f199c8f0` |

These are application commits, not public Clio commit IDs. Public resources retain their exact HTML bytes. Reproduction creates a new local application repository and genuine commits, builds each artifact, then regenerates these manifests through `cli.ts render ... healthy|broken|recovery`. Retain the application repository and receipts outside Git. Do not relabel an old receipt with a newly created commit.

NGINX remains pinned to the image digest used by the original artifact demo. No Ingress, NodePort, automatic synchronization, pruning or production service is configured here. Follow the [lifecycle walkthrough](../../../../docs/providers/argo-lifecycle-demo.md).
