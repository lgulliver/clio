# Getting started locally

This guide brings up Clio's browser, API, PostgreSQL and separate mock worker. GitHub sign-in is real identity; mock deployment previews and mock collection runs use fictional evidence only. Mock setup does not connect a live provider. Overview keeps saved fictional results separate from live-source histories. Separate [live GitHub](providers/connect-github.md) and [native Argo notification](providers/connect-argocd.md) workflows use private operator grants and their own workers. For independent production activation and application artifact provenance, follow the [Argo evidence producer guide](providers/argo-enrichment.md). The separate [measurement producer guide](providers/connect-measurement-evidence.md) covers evidence for all five metrics; it does not modify native collection results.

## Prerequisites and clone

Use Git, Node **24.21.0** (the [.node-version](../.node-version) pin), pnpm **12.10.1** (the [packageManager](../package.json) pin), and Docker with the Compose plugin. The supported Node range is 24.15.0 or later within Node 24. Install these tools yourself before continuing; Docker must be running.

```sh
git clone https://github.com/lgulliver/clio.git
cd clio
node --version
npm install --global pnpm@12.10.1
pnpm --version
docker compose version
pnpm install --frozen-lockfile
```

Run subsequent commands from this repository root unless stated otherwise. The lockfile pins dependencies; do not replace it with an npm or yarn lockfile.

## PostgreSQL and private server configuration

```sh
pnpm db:up
# Run only if apps/api/.env does not already exist; preserve existing local settings.
test -e apps/api/.env || cp apps/api/.env.example apps/api/.env
chmod 600 apps/api/.env
```

Compose runs the digest-pinned PostgreSQL 17 image in [compose.yaml](../compose.yaml), binds `127.0.0.1:5432`, and preserves data in its named volume. The example's database credentials are fictional local development values, unsuitable for hosting.

Edit `apps/api/.env` locally. It is ignored by Git. Keep `DATABASE_URL`, `HOST=127.0.0.1` and `PORT=3000` from the [server example](../apps/api/.env.example). Never commit, paste or put server values in browser configuration. Package commands load this file when present; exported shell values override it.

## GitHub OAuth for identity

Register a separate development **GitHub OAuth App**, using GitHub Settings → Developer settings → OAuth Apps. Set:

| Setting | Local value |
| --- | --- |
| Homepage URL | `http://localhost:5173` |
| Authorization callback URL | `http://localhost:3000/api/auth/callback/github` |
| Server `AUTH_BASE_URL` | `http://localhost:3000` |
| Server `APP_ORIGIN` | `http://localhost:5173` |

Uncomment and fill all five authentication values in the ignored server file: `AUTH_SECRET`, `AUTH_BASE_URL`, `APP_ORIGIN`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`. Generate the secret in your own terminal with `openssl rand -base64 32`, then save it locally. Do not share the output. The secret must contain at least 32 random characters.

All five unset permits health-only operation; login and workspace routes remain unavailable. A partially configured group prevents startup. There is no local login bypass or seeded owner. Login requests `read:user` and `user:email`; OAuth tokens are discarded after identity retrieval. This OAuth App cannot authorize deployment collection. GitHub collection uses a separate GitHub App; Argo notification ingress uses its own scoped source credential.

The browser defaults to `http://localhost:3000`; no browser environment file is required. If needed, [apps/web/.env.example](../apps/web/.env.example) documents public `VITE_API_URL`. Never put credentials in `VITE_` values. Keep `localhost` consistent across browser URL, callback and auth origins; `127.0.0.1` is a different origin.

## Migrate and start

Apply all committed migrations explicitly before starting API or workers. These include the identity, native/mock collection and evidence tables; independent measurements require `0011_measurement_evidence.sql`. Do not apply selected migration files manually:

```sh
pnpm db:migrate
pnpm dev:api
```

Leave the API terminal running. In another terminal at the root:

```sh
curl --fail http://localhost:3000/health/live
curl --fail http://localhost:3000/health/ready
pnpm --filter @clio/web dev --port 5173 --strictPort
```

Open `http://localhost:5173/settings`. Strict port selection prevents Vite silently moving to a port that differs from `APP_ORIGIN`. The API binds loopback on port 3000. Readiness verifies database connectivity, migration history/checksums and expected schema; it does not verify login or evidence coverage. Neither API nor worker applies migrations at startup. See [API operations and auth contract](../apps/api/README.md).

In a third terminal, start the separate worker:

```sh
pnpm worker:mock
```

The worker loads the ignored API `.env` when present and requires only `DATABASE_URL`; OAuth configuration is needed by the API, not the worker. It checks migrations before claiming jobs and makes no provider network calls. Default mode polls for mock jobs until Ctrl+C; SIGINT/SIGTERM shut it down orderly. To handle at most one eligible job and exit instead:

```sh
pnpm worker:mock --once
```

`--once` may finalize one exhausted lease instead of processing another waiting run; invoke it again or use the continuous worker to continue. Enqueue first when using `--once`: with no eligible job it exits without waiting for a future request. Retry backoff or an unexpired lease can make a pending/running run temporarily ineligible. Run it again later or use the continuous worker. API startup alone does not process jobs.

## Workspace, service and mock settings

Owners can use **Set up a data source** in Workspace for the guided wizard: select or create a service, choose GitHub Deployments, Argo CD or a fictional demo, save the source configuration, collect a reporting window, then review independent evidence requirements. Back/Next preserves source drafts. Continue to Collection only after saving; continue to Evidence only after a successful result exists for the current saved revision. A queued request still needs its separate worker. Finish means the setup was reviewed, not that coverage is complete. See the [wizard guide](providers/source-setup-wizard.md) for real-source prerequisites and evidence expectations. Existing service controls remain available for ongoing source management.

1. In Settings, sign in with GitHub. Create and select a workspace; its creator becomes owner.
2. Create and select a service. No example workspace or service is seeded.
3. Choose **Partial — fictional** to preserve the original sample, or create a separate **Fictional lifecycle demo** service and choose **Complete lifecycle — fictional** for all five metrics. See [exact fixture, setup and expected values](providers/synthetic-lifecycle-demo.md). Choose **GitHub (mock)** or **Argo CD (mock)** as primary deployment source. Enter `production` for the fixture's environment.
4. In Partial, optionally attest to exposure **for this mock example only**. Complete lifecycle fixes production environment and fictional exposure; contradictory API inputs are rejected. Save settings to create an immutable mapping revision.
5. Choose **Preview saved mock settings**. The ephemeral preview calculates immediately through the API, needs no worker and is not stored as a collection run.
6. As owner, enqueue a mock collection run from the service's collection controls. Watch its pending/running status, then read the succeeded run's saved fictional result in its history entry. Members can read run history and results but cannot enqueue.

Both preview paths remain labelled mock. Editing settings clears the ephemeral preview; save before previewing again. A conflicting save or preview means the revision changed: reload current settings, inspect them, then reapply the intended edit. Unsaved drafts cannot be previewed. Collection always uses the last saved revision; save edits first if you want them included in the next run.

Owners save mappings, create services, manage invitations and enqueue runs. In Workspace, open access management to inspect members and pending invitations, revoke member access or cancel an invitation. Owner memberships remain protected. Lists show up to 100 records per page with separate First/Next controls and page labels. Each page replaces the previous page. An expired or removed page position returns to the first page; current access is checked again. Older servers without cursors show an explicit incomplete-list warning. Members read settings, request ephemeral previews and view stored runs. Membership is rechecked on requests; revoked access or changed roles affect the next operation. Invitations are manually shared, grant member access only and require a verified matching GitHub email. See [workspace contract](../apps/api/README.md#workspace-http-contract) and [mapping contract](providers/mapping-contract.md).

## Durable mock runs and restarts

The local queue and succeeded snapshots live in PostgreSQL. A run captures its service name and saved mapping revision/observation; a later mapping save does not rewrite historical results. Processing stores fictional evidence, the validated OEMS snapshot, calculated results, the exact OEMS revision and a digest together. Public results omit raw evidence and worker internals.

One service can have at most one pending/running run, but can have multiple historical runs. Attempts are bounded to three. Expired worker leases can be reclaimed after roughly 30 seconds, with bounded retry backoff; exhausted attempts end in a redacted `mock_processing_failed`. Stale workers cannot finish another worker's lease. Restart the worker to recover abandoned jobs; restarting the API is insufficient. A database error stops the continuous worker with exit code 1; restore database readiness and restart it. This local worker has no process supervisor.

For API clients, the run base is `/api/workspaces/:workspaceId/services/:serviceId/mock-collection-runs`:

| Request | Behavior |
| --- | --- |
| POST with exactly `{revision, requestId}` | Owner, authenticated session and exact `APP_ORIGIN`; positive safe integer revision and UUID request ID; returns 202 `{run}` |
| GET base | Members/owners; returns `{runs,nextCursor}` with up to 25, newest first; optional `cursor` and `status=succeeded` |
| GET base + `/:runId` | Members/owners; returns scoped `{run}` |

Use the current saved revision for a new request. Stale revision or another active run returns 409; unset mapping returns 404. Reusing the same request ID in the same workspace/service with the same revision returns the original run, even after settings change. Reusing it with a different revision returns 409. A deliberate new run needs a new request ID. Responses are no-store; missing/nonmember/wrong scopes return 404. Use the authenticated browser workflow without copying session cookies into examples.

Run statuses are `pending`, `running`, `succeeded`, `failed`. Only success has a result; terminal runs have completion timestamps. Stored runs are historical mock records, not live collection or a conformance designation. Hosted scheduling, runtime and retention remain undecided.

Ctrl+C stops API, web and worker. Preserve the database with:

```sh
docker compose stop postgres
```

To resume: `pnpm db:up`, `pnpm db:migrate`, then restart API, web and worker in separate terminals. Workspace/service/settings/run data and unexpired database sessions survive process restarts if the database volume and auth configuration remain intact. Browser selections are held in memory: select the workspace/service again after reload. Do not remove volumes to fix startup errors.

## What the evidence supports

The initial mock window is fixed: **2026-01-01T00:00:00Z inclusive to 2026-01-03T00:00:00Z exclusive**, two UTC calendar days. Running today does not collect today's deployments. The cutoff includes mapping observation and fixture evidence; it does not enlarge that reporting window.

The default **Partial — fictional** fixture models one rollout in `production`. Without mock exposure attestation, or with a different environment, qualification stays unknown. All three coverage flags stay false: collection, deployment history and recovery evidence are incomplete. Deployment frequency retains a provisional count with unavailable per-day rate; change failure rate and failed deployment recovery time remain unavailable. Missing commit lineage, rework, causal failure or recovery evidence cannot become zero. The selectable **Complete lifecycle — fictional** scenario supplies an explicit fictional census, source history, classifications and exact recovery episode, producing all five complete metrics only within that fixture. Apply migration `0013_mock_lifecycle_scenario.sql` before saving the new scenario. Historical mappings and results remain partial unless explicitly saved as a new complete scenario revision. All five OEMS calculations exist for pinned fixtures; that does not mean these sources support all five real metrics.

The OEMS profile is `0.1-draft`, revision `5908bb12cdf24e7528088237dff9dca4c10ff45f`. [Pin metadata](../packages/oems/src/contract.ts) and [OEMS boundary/limits](../packages/oems/README.md) are authoritative; normative semantics belong upstream. The optional [command-line mock demo](providers/mock-demo.md) needs neither login nor provider credentials:

```sh
pnpm demo:providers
pnpm demo:providers --source=argocd --attest-exposure
```

For a reproducible independent Argo evidence path, use the [local artifact demo](../infra/argocd/evidence-demo/README.md). It checks build provenance and HTTP activation under explicit sandbox policies; it does not assert real production exposure.

## Inspect stored results in Overview

After a worker succeeds, open **Overview**, select a workspace, then select a service. Workspace and service selections remain in memory and reset on navigation, identity changes or session rechecks, including when the browser tab is hidden. Owners and members can read authorized stored results; this page never starts collection.

**Live GitHub**, **Live Argo CD**, **Mock — fictional evidence** and **Independent measurements** have separate histories. Each card reads a bounded recent-request page and independently finds successful saved results. Newer pending, running or failed requests cannot hide an older success. Choose a saved window, use **Older saved results** to fetch the next successful page, and use **Newest saved result** to return to the first page. Each page replaces the previous page; requests stay bounded and evidence is not accumulated indefinitely. Use each card's **Refresh history** control to check progress; Overview does not poll automatically.

Saved results retain their original UTC window (end exclusive), evidence cutoff, completion time, connection or mapping revision, and OEMS revision. These can differ from current settings. Provider labels identify GitHub or Argo CD; historical repository/Application names are not included in the safe result contract. Do not add counts across sources: evidence may overlap.

Live deployment counts are provisional. Unknown qualification and incomplete collection, deployment history and recovery coverage remain visible. Argo cards also show receipt observation periods, recorded gaps, rejected receipts and scope drift; observation does not establish continuous coverage. A recorded count of zero does not establish that no production deployments occurred. New saved GitHub and Argo results show all five metric statuses, quality reasons and evidence counts. Ratios show their bounds and population scope; lead time distinguishes confirmed observations from observed candidates, and recovery distinguishes exact, approximate and open episodes. Deployment rates and unsupported metrics stay unavailable. Older saved results retain their original summaries without recomputation. Fictional mock results never measure live delivery. Expired sessions or revoked service access hide stored results; select another accessible service or refresh your session before retrying.

## Save an independent measurement

First configure a real native source using [GitHub Deployments](providers/connect-github.md) or [Argo CD](providers/connect-argocd.md), then save a successful collection for a closed UTC reporting window. A fictional mock run cannot serve as the measurement basis.

For independently supported evidence, follow [connect measurement evidence](providers/connect-measurement-evidence.md). Configure private capability grants outside Git, supply producer reports against the exact authenticated native basis, and restart API and measurement worker together after configuration changes. Login credentials and native provider credentials do not authorize these reports. Complete coverage needs actual exhaustive population, change/history, classification and recovery evidence under reviewed policies; submitting a report alone is insufficient.

Start the separate worker in another root terminal:

```sh
pnpm worker:measurement
# Alternatively, after enqueueing a job:
pnpm worker:measurement --once
```

The worker loads the ignored API configuration and checks current migrations. Keep the same current native source and measurement grant configuration in API and worker. No measurement grants or received reports are required to save a partial measurement, but the successful native basis and its current source access are still required. Run workers under an operator-selected supervisor when ongoing availability matters; an infrastructure error stops the process and requires recovery/restart.

As workspace owner, select a service in Settings and open **Independent measurement evidence**. Choose GitHub or Argo CD and a successful saved collection, refresh received evidence, then select at most one received authority per capability. Choose **Calculate saved measurement**. With no selected reports, the saved result retains missing-evidence blockers and incomplete coverage. **Refresh measurement requests** finds recent requests after a lost response or selection change; **Refresh measurement status** checks a selected request. API startup does not process the queue, and the browser does not poll automatically.

Jobs pin the basis and selected report receipts, use 120-second leases and allow three attempts. Later reports cannot alter a queued or completed result. A changed native source, producer grant or report eligibility can invalidate work; correct configuration and collect a fresh basis where required. A conflict can also mean another measurement for that source is active, so inspect recent requests before retrying.

Owners and members read **Independent measurements** in Overview, including older saved windows. Results show both the original native basis cutoff and the later database measurement cutoff, all five metric statuses/quality reasons, coverage and missing-evidence blockers. Original native results and their coverage stay unchanged. Current workspace access is required even when the measurement predates source or producer revocation.

## Source support and future setup

| Source/workflow | Available locally | Future live requirements |
| --- | --- | --- |
| GitHub OAuth | Real sign-in and database sessions | Separate from collection credentials |
| GitHub deployments | Mock workflows plus separate operator-granted live connection and worker | Hosted self-service installation flow and scheduling; independent metric evidence uses separate producers |
| Argo CD operations | Scoped native notifications, opt-in scoped list/watch capture, durable source journal/historical import, immutable receipt/gap history, closed UTC snapshots and browser reporting bounds | Production installation/supervision, automatic operation UUIDs and actual independent producers; complete coverage requires reviewed exhaustive evidence |
| Optional Kind/Argo sandbox | Independent controller and native producer verification environment | Requires deliberate private grant/producer setup to connect; never supplies mock runs |
| Live GitHub results | Scoped stored all-five results, provisional deployment count, incomplete native coverage | Actual independent evidence and historical repository labels |
| Independent measurements | Private four-capability report ingress, durable worker, owner queue and member-readable all-five history | Operator-built real producers and exhaustive supported evidence; no fixture establishes live completeness |

For live GitHub access, select only intended repositories for a separate GitHub App. Initial permission design is **Deployments read-only**, with mandatory **Metadata read-only**; no source-code or commit-history access is assumed. Record stable repository IDs and explicit production environment names. A successful GitHub deployment status or `production_environment` flag alone cannot establish consumer exposure: choose and verify an exposure policy for the service. App signing keys and installation tokens stay server-side; use the [live connection guide](providers/connect-github.md) for operator grants and worker configuration.

For native Argo evidence, identify Argo instance, destination cluster and application UID/name, plus immutable operation/rollout identity and observation times. Keep the manifests repository/configuration revision distinct from the application's source repository and commit provenance. Preserve operation evidence before mutable application status/history is replaced. Synced/Healthy does not independently prove production exposure or source lineage. Map each source explicitly to a Clio service and correlate shared rollouts explicitly; equal SHAs never imply correlation automatically.

[Real-source setup](providers/real-sources.md) covers GitHub App registration, installation access checks, scoped Argo tokens, production mapping and rotation. These provider-side steps work independently of Clio; the [local GitHub connection](providers/connect-github.md) provides a separate service workflow; [native Argo ingestion](providers/connect-argocd.md) adds scoped notification receipts and snapshots. Hosted credential storage remains unimplemented. [Provider setup status](providers/local-setup.md) summarizes that boundary. No live connector is enabled by selecting a mock source. The [optional local Argo guide](providers/local-argocd.md) uses a separate Docker-backed Kubernetes sandbox and no private repository credentials.

## Troubleshooting

| Symptom | Check/action |
| --- | --- |
| Install or native TypeScript startup fails | Check Node and pnpm against pins, then use `pnpm install --frozen-lockfile`. Do not change the lockfile to accommodate another runtime. |
| PostgreSQL cannot start / port 5432 busy | Check Docker is running and `docker compose ps postgres`. Resolve the conflicting local listener; preserve the Compose volume. |
| API unavailable or readiness 503 | Confirm database started, server `DATABASE_URL` targets it, and run `pnpm db:migrate`. Liveness alone is insufficient. |
| Migration checksum/history failure | Restore the matching checkout/applied migrations; never modify applied SQL or wipe data as a repair. See API migration guidance. |
| Startup rejects auth / protected routes 503 | Fill all five auth values for login, or leave all five unset for health-only use. Restart API after changes. |
| OAuth callback fails | Check GitHub callback ends `/api/auth/callback/github` on port 3000, `AUTH_BASE_URL` matches API, and browser/`APP_ORIGIN` use localhost:5173. Start login again to obtain fresh state. |
| Browser requests denied / CORS / 403 | Check exact origin, port and hostname. Stop a stray Vite process; use the strict-port command. Confirm current owner role for writes. |
| Invitation rejected | Use the invited account with verified matching email; check expiry/cancellation. There is no email delivery service. |
| Save, preview or enqueue returns 409 | Reload current mapping; preserve/review draft before saving. For enqueue, wait for active run to finish. Keep request ID/revision unchanged only when replaying the same enqueue. |
| Run remains pending / no jobs processed | Start `pnpm worker:mock` separately with database configuration and current migrations. `--once` before enqueue handles no future job. Check lease expiry/backoff before retrying. |
| Run remains running after worker interruption | Restart worker and allow lease expiry/reclaim. Three exhausted attempts produce terminal failure; inspect the redacted status and enqueue a new run after correcting local setup. |
| Exposure unknown / metric unavailable | Use fixture environment `production` and decide whether to attest to mock exposure. False coverage and missing evidence remain; this never verifies real exposure. |
| Measurement remains pending | Start `pnpm worker:measurement` separately with current migrations and the same native/measurement grants as API; check active leases and retry backoff. |
| Measurement evidence unavailable or conflict | Check current native source and producer eligibility; refresh recent requests and received evidence. Corrections to immutable reports require a fresh basis. |
| Argo sandbox fails | Follow its context-bound diagnostics; it is independent of Clio/PostgreSQL. |

For repository verification, `pnpm check` runs lint, types, behavior tests and build. Database integration tests are separate and require `CLIO_TEST_DATABASE_URL`; see [API verification](../apps/api/README.md#verification). These checks do not collect live provider evidence.

For a reproducible independent build/activation exercise, follow the [Argo artifact evidence walkthrough](providers/argo-evidence-demo.md). It uses a dedicated sandbox service and separate producer credentials.

For retained original operation observations and receiver-outage replay, follow [Argo source history](providers/argo-history.md). Configure a separate archive producer, retain observations before delivery, select it in Settings and inspect sealed capture bounds separately from the reporting window and evidence cutoff. For continuous acquisition, follow [scoped Application capture](providers/argo-continuous-capture.md): supply explicit private kubeconfig/context and read-only RBAC, then run the collector under your supervisor. Missed periods and finite capacity remain explicit; journal replay does not make metric coverage complete.

To exercise real local Argo rollouts plus independently observed consumer failure and recovery, use the [controlled lifecycle demo](providers/argo-lifecycle-demo.md). Its sandbox evidence remains separate from production sources and requires closed UTC reporting windows.
