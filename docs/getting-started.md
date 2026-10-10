# Getting started locally

This guide brings up Clio's browser, API, PostgreSQL and separate mock worker. GitHub sign-in is real identity; deployment previews and collection runs use fictional evidence only. No live provider is connected and no real measurements appear on the overview.

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

All five unset permits health-only operation; login and workspace routes remain unavailable. A partially configured group prevents startup. There is no local login bypass or seeded owner. Login requests `read:user` and `user:email`; OAuth tokens are discarded after identity retrieval. This OAuth App cannot authorize deployment collection. Future collection uses a separate GitHub App.

The browser defaults to `http://localhost:3000`; no browser environment file is required. If needed, [apps/web/.env.example](../apps/web/.env.example) documents public `VITE_API_URL`. Never put credentials in `VITE_` values. Keep `localhost` consistent across browser URL, callback and auth origins; `127.0.0.1` is a different origin.

## Migrate and start

Apply migrations explicitly before starting API or worker. The mock queue/snapshots require `0004_mock_collection_runs.sql`, in addition to the identity and deployment-mapping migrations:

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

1. In Settings, sign in with GitHub. Create and select a workspace; its creator becomes owner.
2. Create and select a service. No example workspace or service is seeded.
3. Choose **GitHub (mock)** or **Argo CD (mock)** as primary deployment source. Enter `production` for the fixture's environment.
4. Optionally attest to exposure **for this mock example only**. Save settings to create an immutable mapping revision.
5. Choose **Preview saved mock settings**. The ephemeral preview calculates immediately through the API, needs no worker and is not stored as a collection run.
6. As owner, enqueue a mock collection run from the service's collection controls. Watch its pending/running status, then read the succeeded run's saved fictional result in its history entry. Members can read run history and results but cannot enqueue.

Both preview paths remain labelled mock. Editing settings clears the ephemeral preview; save before previewing again. A conflicting save or preview means the revision changed: reload current settings, inspect them, then reapply the intended edit. Unsaved drafts cannot be previewed. Collection always uses the last saved revision; save edits first if you want them included in the next run.

Owners save mappings, create services, manage invitations and enqueue runs. Members read settings, request ephemeral previews and view stored runs. Membership is rechecked on requests; revoked access or changed roles affect the next operation. Invitations are manually shared, grant member access only and require a verified matching GitHub email. See [workspace contract](../apps/api/README.md#workspace-http-contract) and [mapping contract](providers/mapping-contract.md).

## Durable mock runs and restarts

The local queue and succeeded snapshots live in PostgreSQL. A run captures its service name and saved mapping revision/observation; a later mapping save does not rewrite historical results. Processing stores fictional evidence, the validated OEMS snapshot, calculated results, the exact OEMS revision and a digest together. Public results omit raw evidence and worker internals.

One service can have at most one pending/running run, but can have multiple historical runs. Attempts are bounded to three. Expired worker leases can be reclaimed after roughly 30 seconds, with bounded retry backoff; exhausted attempts end in a redacted `mock_processing_failed`. Stale workers cannot finish another worker's lease. Restart the worker to recover abandoned jobs; restarting the API is insufficient. A database error stops the continuous worker with exit code 1; restore database readiness and restart it. This local worker has no process supervisor.

For API clients, the run base is `/api/workspaces/:workspaceId/services/:serviceId/mock-collection-runs`:

| Request | Behavior |
| --- | --- |
| POST with exactly `{revision, requestId}` | Owner, authenticated session and exact `APP_ORIGIN`; positive safe integer revision and UUID request ID; returns 202 `{run}` |
| GET base | Members/owners; returns `{runs}` with latest 25, newest first |
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

The fixture models one rollout in `production`. Without mock exposure attestation, or with a different environment, qualification stays unknown. All three coverage flags stay false: collection, deployment history and recovery evidence are incomplete. Deployment frequency retains a provisional count with unavailable per-day rate; change failure rate and failed deployment recovery time remain unavailable. Missing commit lineage, rework, causal failure or recovery evidence cannot become zero. All five OEMS calculations exist for pinned fixtures; that does not mean these sources support all five real metrics.

The OEMS profile is `0.1-draft`, revision `5908bb12cdf24e7528088237dff9dca4c10ff45f`. [Pin metadata](../packages/oems/src/contract.ts) and [OEMS boundary/limits](../packages/oems/README.md) are authoritative; normative semantics belong upstream. The optional [command-line mock demo](providers/mock-demo.md) needs neither login nor provider credentials:

```sh
pnpm demo:providers
pnpm demo:providers --source=argocd --attest-exposure
```

## Source support and future setup

| Source/workflow | Available locally | Future live requirements |
| --- | --- | --- |
| GitHub OAuth | Real sign-in and database sessions | Separate from collection credentials |
| GitHub deployments | Fictional adapter demo, saved mock settings, ephemeral preview and durable mock runs | Workspace-bound GitHub App installation and explicitly selected repository/environment scope |
| Argo CD operations | Fictional supplied-evidence normalization and the same mock workflows | Authenticated ingestion or collection client, cluster/application scope, immutable operation evidence and exposure policy |
| Optional Kind/Argo sandbox | Independent controller/UI learning environment | Does not connect to Clio or supply its mock runs |
| Live measurements | Unavailable | Verified collection, history/coverage and evidence for each supported metric |

For future GitHub access, select only intended repositories for a separate GitHub App. Initial permission design is **Deployments read-only**, with mandatory **Metadata read-only**; no source-code or commit-history access is assumed. Record stable repository IDs and explicit production environment names. A successful GitHub deployment status or `production_environment` flag alone cannot establish consumer exposure: choose and verify an exposure policy for the service. App signing keys and installation tokens stay server-side; storage/setup is not implemented by this guide.

For future Argo evidence, identify Argo instance, destination cluster and application UID/name, plus immutable operation/rollout identity and observation times. Keep the manifests repository/configuration revision distinct from the application's source repository and commit provenance. Preserve operation evidence before mutable application status/history is replaced. Synced/Healthy does not independently prove production exposure or source lineage. Map each source explicitly to a Clio service and correlate shared rollouts explicitly; equal SHAs never imply correlation automatically.

[Real-source setup](providers/real-sources.md) covers GitHub App registration, installation access checks, scoped Argo tokens, production mapping and rotation. These provider-side steps work independently of Clio; live connection UI, credential storage and ingestion endpoints remain unimplemented. [Provider setup status](providers/local-setup.md) summarizes that boundary. No live connector is enabled by selecting a mock source. The [optional local Argo guide](providers/local-argocd.md) uses a separate Docker-backed Kubernetes sandbox and no private repository credentials.

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
| Argo sandbox fails | Follow its context-bound diagnostics; it is independent of Clio/PostgreSQL. |

For repository verification, `pnpm check` runs lint, types, behavior tests and build. Database integration tests are separate and require `CLIO_TEST_DATABASE_URL`; see [API verification](../apps/api/README.md#verification). These checks do not collect live provider evidence.
