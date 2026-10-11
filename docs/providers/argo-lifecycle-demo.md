# Controlled Argo failure and recovery exercise

This exercise extends the [artifact demo](argo-evidence-demo.md) with three real sandbox rollouts: healthy application, broken consumer behaviour, and an incident-driven corrective rollout. Use a separate Application, namespace and Clio service; the committed example uses `clio-lifecycle-verified`. Choose a fresh `clio-lifecycle-*` namespace for every new exercise. Keep the original guestbook and evidence demo unchanged. This is a controlled evaluation, not production traffic or proof of production coverage.

## What the scenario observes

All three Argo synchronizations can succeed and remain Healthy. The broken application still serves its exact committed HTML at `/index.html`, but its separate `/healthz` functional endpoint returns `503 unavailable`. Healthy and recovery profiles return `200 ok`. Independent artifact exposure qualifies a rollout under the explicit sandbox policy; the functional probe supplies failure/restoration evidence. Argo sync status never supplies failure classification by itself.

The three profiles live in `infra/argocd/evidence-demo/scenarios/{healthy,broken,recovery}`. They contain immutable content-addressed HTML ConfigMaps, a digest-pinned NGINX Deployment, a separate immutable HTTP configuration and a ClusterIP Service. They create no public ingress. Each embeds a different application artifact from a genuine commit in the deliberately local repository `local:clio-lifecycle-app`; the Clio Git commit used by Argo identifies configuration, not application source. Keep the actual local Git repository and build receipts for change-history evidence. Do not claim these application commits exist in the public Clio repository.

## Prepare and connect

Use the dedicated Kind kubeconfig and `--context kind-clio-argocd` on every cluster command. Check that the new Application/namespace names are unused. Create a new sandbox-only Clio service through Workspace. Follow [Argo connection setup](connect-argocd.md) for the exact new Application UID, `sandbox-evaluation` environment, scoped native token and two separate enrichment producers. Build provenance must allow the actual application repository identity. Preserve existing grants and keep tokens outside Git in owner-only files.

Create a new local Git application repository outside all existing checkouts. Each version must contain `infra/argocd/evidence-demo/app/index.html`. Commit three deliberately different healthy, broken and recovered HTML versions with normal current Git timestamps; record each full SHA and its actual committer time. Never assign artificial timestamps or fabricate SHA values. The corrective artifact may be prepared before the incident, but its rollout must be explicitly triggered to recover from that incident.

For each stage, build its committed artifact and render the matching profile using the existing CLI:

```sh
node infra/argocd/evidence-demo/cli.ts build "$CLIO_LIFECYCLE_GIT" "$CLIO_STAGE_SHA" local:clio-lifecycle-app "$CLIO_STAGE_ARTIFACT"
node infra/argocd/evidence-demo/cli.ts render "$CLIO_STAGE_ARTIFACT" docker.io/library/nginx:1.29.3-alpine@sha256:b3c656d55d7ad751196f21b7fd2e8d4da9cb430e32f646adcf92441b72f82b14 "$CLIO_STAGE" "$CLIO_LIFECYCLE_NAMESPACE" > "$CLIO_STAGE_MANIFEST"
```

The optional namespace argument must begin `clio-lifecycle-`; without it, render defaults to `clio-lifecycle-demo`. Set `CLIO_LIFECYCLE_NAMESPACE` explicitly for this command. Use the same value in Application `spec.destination.namespace`, grant `destinationNamespace`, bootstrap resource `metadata.namespace`, port-forward namespace and generated manifests. Substitute it in every hardcoded namespace from the original artifact walkthrough, including its Namespace resource; do not apply that bootstrap literally to the original demo. In the existing local setup, default `clio-lifecycle-demo` holds the preserved uncertain first attempt and must not be reused. `CLIO_STAGE` is exactly `healthy`, `broken` or `recovery`. Inspect generated resources, copy each to its matching public scenario directory, run repository checks and commit/push through the normal reviewed workflow. Pin the new Application to that full configuration commit. Change only its source path for the next stage; its repository, destination, project and UID must remain unchanged.

Bootstrap only the new namespace with a different initial NGINX page, as in the artifact demo. Record namespace/Application creation and the bootstrap explicitly; bootstrap is not a qualifying production deployment. Run a loopback-only forward to this namespace's Service at a dedicated port, for example `8100:80`. A forward binds to a Pod and can stop when that Pod is replaced; restart the same scoped forward after each rollout. Endpoint continuity and absence of intervening changes remain explicit operator responsibilities. Without pruning, older immutable ConfigMaps remain and Argo may show OutOfSync after a successful, Healthy operation; this does not supply failure classification.

## Capture each rollout

For each stage, generate one operation UUID, persist a genuine pre-rollout different-byte baseline, then synchronize the exact configuration SHA and stage path with that UUID and `clio.operation-kind=rollout`. Follow the artifact demo's direct sandbox operator procedure. Argo start times have whole-second precision. After persisting the baseline, wait until a later whole UTC second before submitting the operation; verify the resulting start is strictly later than baseline. An ambiguous baseline produces no exposure assertion. Preserve that attempt and use a fresh isolated exercise rather than altering timestamps or deleting native history. Wait for that exact operation in the actual controller state, capture the Application JSON, and use `native` with the expected UUID. Never overwrite receipts or substitute the previous operation.

Publish native and build evidence with their distinct credentials. Capture and publish exact-byte consumer exposure using the original operation-bound baseline. After exposure, record functional state in a fresh private file:

```sh
node infra/argocd/evidence-demo/cli.ts health http://127.0.0.1:8100/healthz "$CLIO_OPERATION_ID" "$CLIO_ARTIFACT_DIGEST" "$CLIO_HEALTH_RECEIPT"
```

The health response must carry the expected artifact digest, so an old Pod cannot satisfy a new artifact probe. This probe accepts only loopback `/healthz`, exact `200 ok` or `503 unavailable` bodies, no redirects/compression/proxies, and bounded work. It records current observation time. Polling does not establish the exact instant failure began: recovery derived from these probes must remain approximate. Connection failures and unrelated error bodies produce no classification assertion.

Capture `healthy` with HTTP 200, `broken` with HTTP 503, and `recovery` with HTTP 200, in that order. The incident is caused by the broken rollout; the recovery rollout is incident-driven rework. Save native envelopes, committed artifact receipts, baseline/exposure receipts, functional observations and operator scenario records privately. These facts feed separate measurement reports; they do not alter native snapshots.

## Reporting limits

Fresh events belong to their actual UTC day. Clio's API accepts only closed whole-day reporting windows. Capture now, then collect the day containing these events after its UTC midnight. Before that point, a closed earlier window can retain the operations but cannot display them as that window's deployment or recovery observations. Never backdate evidence to populate metrics.

A three-operation count, failure rate of `1/3`, and rework rate of `1/3` require a supported complete population for the selected window. Lead-time samples require actual deployed change sets and sufficient service history; the first retained deployment does not prove that history. A fresh ledger beginning mid-day does not automatically cover that whole day's prior absence. Exact retained transport gaps require independently supported resolutions, not a copied gap inventory labelled resolved.

Follow [independent measurement evidence setup](connect-measurement-evidence.md). Partial evidence remains valid and visible.

## Generate separate measurement reports

Configure four distinct sandbox measurement producer UUIDs, policies and token files through [the measurement guide](connect-measurement-evidence.md). Use the new service/source and exact path returned by its genuine authenticated basis. The change-link producer must allow `local:clio-lifecycle-app`. Save the native collection first, then fetch its private basis projection. Configuration grants authorize statements; they do not verify their truth.

Construct a private `clio.sandbox.lifecycle.v1` ledger with exactly `contract`, `workspaceId`, `serviceId`, `applicationUid`, `repositoryId`, `startedAt`, `closedAt` and `operations`. `startedAt`/`closedAt` bound the controlled scenario observations, not an invented whole-day census. Each of the three ordered operations has exactly:

```json
{
  "stage": "healthy",
  "operationId": "ACTUAL_OPERATION_UUID",
  "commitSha": "FULL_APPLICATION_COMMIT_SHA",
  "committedAt": "ACTUAL_GIT_COMMITTER_TIME_UTC",
  "effectiveAt": "ACTUAL_EXPOSURE_TIME_UTC",
  "healthObservedAt": "ACTUAL_FUNCTIONAL_PROBE_TIME_UTC",
  "healthStatus": 200,
  "evidenceRef": "REFERENCE_TO_RETAINED_INDEPENDENT_SCENARIO_RECEIPTS"
}
```

Use `broken`/503 and `recovery`/200 for subsequent stages. Preserve actual probe timestamps; they normally occur after activation. Earlier application commits are valid. The helper uses the pinned approximate-onset fallback at the broken deployment's activation time while retaining its later functional observation. Restoration is the recovered functional observation. Exact recovery median remains null; approximate median is reported separately.

Producer descriptors are a private array of four objects with exactly `capability`, `producerId` and `policyRef`, matching the configured grants. Capabilities are `population`, `change_links`, `classification`, `recovery`.

```sh
node infra/argocd/evidence-demo/lifecycle-cli.ts "$CLIO_LEDGER_JSON" "$CLIO_BASIS_JSON" "$CLIO_PRODUCERS_JSON" "$CLIO_NEW_REPORT_DIRECTORY"
```

The default creates three reports: change links with `history:null`, classifications, and one approximate recovery episode scoped to the ledger interval. It creates no population report. Output is a fresh owner-only directory outside Git; existing paths, symlinks and oversized JSON are rejected. Preserve these exact files and event UUIDs for retries. Submit each file through its capability's authenticated report endpoint, then select received reports in the wizard's Evidence step and run the separate measurement worker. A ledger does not create native operations: all three must match the saved basis's exact identities, qualification and activation timestamps, with no extra native operation.

For a fully reviewed population/history, an optional fifth CLI argument identifies a private review object with exactly `interval`, `productionPath`, `historyEvidenceRef`, `populationEvidenceRef`, `recoveryEvidenceRef`, and `gapResolutions`. Only gaps overlapping the reviewed interval (and every unbounded gap) require resolution; unrelated bounded gaps must be omitted. Every resolution contains exact fetched `gap`, supported `scope` and independent `evidenceRef`. The interval must cover the reporting window and ledger, and its end must equal the ledger's genuinely observed closure. Missing manifests, omitted/mutated gaps and incorrect paths are rejected. Supply this review only after establishing the actual deployment-path census, change history, prior service absence and relevant gap resolution. Copying the native roster or observing no errors is insufficient.

After midnight, a reviewed closed-day scenario with three qualified operations gives deployment count three, failure rate `1/3` and rework rate `1/3`. Lead time uses each genuine committer timestamp and first activation. Recovery stays approximate under polling even with complete supporting coverage. If observation stopped before midnight, extend coverage only from independently retained evidence; do not edit `closedAt` to imply unseen coverage.

The helper validates the supplied ledger against native identities and timing, but does not open its referenced health/exposure/Git receipts. Operators must verify and retain those actual source records before constructing the ledger. A reviewed recovery reference must include the restoring probe and causal scenario evidence; it replaces the default probe reference in the report lineage.
