# Connect GitHub Deployments to local Clio

This workflow uses a separate collection GitHub App, a trusted local operator grant, an owner-authorized service connection and a separate collection worker. GitHub login OAuth remains identity-only. Argo evidence and mock collection have separate workflows; no Argo ingestion endpoint is provided here.

## Prepare the provider and choose scope

Follow [real-source preparation](real-sources.md) to register the collection App with **Deployments read-only** and **Metadata read-only**, selected repositories, and no user OAuth or webhook receiver. Record App ID, installation ID, installation account ID/type and stable repository ID. Check the installation account against the intended organization/user; the operator authorizes that installation for a Clio workspace separately.

Create/select your Clio workspace and service using [getting started](../getting-started.md). Obtain the workspace UUID from the authenticated workspace API, not its display name. In the signed-in browser's developer tools, a read-only request to `http://localhost:3000/api/workspaces` with credentials includes each accessible workspace's `id`. Keep the response private; there is no need to copy session cookies into shell commands.

Only connect a repository if **all deployment operations in that repository belong to this service**. Shared monorepository deployments need a future narrower task/binding contract; do not assign unrelated deployments to one service. Select an exact production environment and document which trusted success signal proves consumer exposure. A successful job or a production label alone does not prove exposure. Leave the exposure-policy reference blank if that agreement does not exist; qualification stays unknown.

## Operator: configure private files

Keep files outside the checkout. Do not paste signing keys or provider tokens into Clio's browser, chat, `VITE_` variables or login OAuth configuration. Commands below create a private directory, not an external service:

```sh
(
  umask 077
  mkdir -p "$HOME/.local/share/clio-provider-credentials"
  chmod 700 "$HOME/.local/share/clio-provider-credentials"
)
```

Move the downloaded App PEM into that directory using your local file manager. Create `github-grants.json` there with your real non-secret IDs. This example is fictional; replace every value:

```json
[
  {
    "workspaceId": "11111111-1111-4111-8111-111111111111",
    "installationId": 12345,
    "accountId": 67890,
    "accountType": "Organization",
    "repositoryIds": [24680]
  }
]
```

Use `User` for a personal account. Grants have at most 100 repositories each and 100 entries. An installation cannot be assigned across different workspaces in this local model. Repository IDs must be explicitly listed; login identity or knowing an installation ID supplies no grant. Restrict both PEM and grants file to owner read/write (`chmod 600`); no symlinks or group/world-readable files. Grants are private authorization configuration even though their identifiers are not tokens.

Add all three server-only values to your existing ignored `apps/api/.env`, preserving OAuth/database values. Use absolute paths with your own username; dotenv values do not expand `$HOME`:

```dotenv
GITHUB_APP_ID=YOUR_NUMERIC_APP_ID
GITHUB_APP_PRIVATE_KEY_FILE=/home/YOUR_USER/.local/share/clio-provider-credentials/app-key.pem
GITHUB_APP_GRANTS_FILE=/home/YOUR_USER/.local/share/clio-provider-credentials/github-grants.json
```

All three absent disables live connections. Partial/invalid configuration prevents startup. API and worker load the same configuration snapshot; restart both together after grants or key changes. Tokens are minted for the selected repository, retained only in server memory, and never saved in PostgreSQL. This is a local operator authorization model, not a hosted self-service installation flow.

## Migrate and start both processes

From the repository root:

```sh
pnpm db:up
pnpm db:migrate
pnpm dev:api
```

Apply `0005_live_github.sql` explicitly before using live routes. In separate terminals:

```sh
pnpm --filter @clio/web dev --port 5173 --strictPort
pnpm worker:github
```

API startup does not start workers or apply migrations. The GitHub worker is separate from `pnpm worker:mock`; mock runs remain fictional. To process at most one eligible live job and exit, use `pnpm worker:github --once` after enqueueing. A lease/backoff may defer eligibility; continuous mode resumes work. Stop with Ctrl+C; shutdown aborts acquisition and leaves durable jobs for bounded recovery. No hosted scheduler or supervisor is installed.

## Owner: connect and collect

1. Sign in at `http://localhost:5173/settings`; select the granted workspace and service.
2. In the live GitHub section, enter installation and numeric repository ID, exact production environment and optional exposure-policy reference. Explicitly confirm the whole repository's deployments belong to the selected service.
3. Save. Clio verifies installation/App/account, selected minimal permissions, suspension state and narrow repository access before storing an immutable connection revision. Guessed/ungranted installations fail before provider requests. Losing session/owner access during verification prevents the save.
4. Select a closed UTC reporting period: start inclusive, end exclusive, midnight boundaries, at most 90 days. End must be in the past; collecting a period does not claim its history is complete.
5. Enqueue collection and inspect saved run history. Owners configure/enqueue/disconnect; workspace members read connections and results. Only one pending/running live run per service is allowed. Retry an uncertain enqueue with the same request ID and same inputs; use a new request for a new collection.

Uncertain enqueue retains its request ID while this panel stays mounted. Switching panels, navigating away or reloading discards that local replay state; inspect history before enqueueing again. Successful history refresh allows explicit abandonment of an uncertain replay, with acknowledgement that a completed collection could be repeated. HTTP 408/429 preserve the replay inputs.

Runs pin connection revision and reporting period. Editing/disconnecting a connection fences jobs using an older revision. Historical snapshots remain readable. Disconnect stops Clio collection; it does not uninstall the App or revoke GitHub access. The operator must retire provider access separately using [rotation and revocation](real-sources.md#rotation-revocation-and-connection-handoff).

## Read results honestly

Deployment requests and every status are collected without filtering only on the deployment's current environment, so status promotions are retained. Persisted normalized history keeps earliest observations and earlier exposure when later responses omit or deactivate records. Conflicting source content fails closed; revisions never rewrite saved snapshots. Each result records reporting window, evidence cutoff, connection revision and OEMS pin.

Interrupted acquisitions consume an attempt; three interruptions/failures can exhaust a run. Completion shares the acquisition deadline and can await lease expiry if that budget runs out. Keep local API/worker/PostgreSQL clocks synchronized: an API clock ahead of PostgreSQL can temporarily reject immediate enqueue after save. Hosted clock and shutdown policy remain follow-up work.

Acquisition is bounded to 100 pages, 5000 records, 1 MiB per response and 8 MiB per traversal. Repeated unchanged traversals do not append redundant history rows; genuinely new metadata/status observations do. Stored normalized history also has a 5000-record/8 MiB ceiling; there is no automatic pruning policy. Hitting these bounds fails closed.

REST traversal completion is shown separately from metric coverage. Initial collection/history/recovery coverage remains false, including empty or fully traversed responses. Deployment frequency has a provisional count and unavailable per-day rate; change failure rate and failed deployment recovery time remain unavailable. Missing commit lineage, causal failure and recovery evidence do not become zero. A policy-free connection retains unknown qualification. No live workspace overview metrics are added by this connection workflow.

## Troubleshooting and revocation

| Symptom | Action |
| --- | --- |
| Live setup unavailable | Check all three server settings, private file ownership/permissions, and an operator grant for the current workspace; restart API and worker together. |
| Save forbidden | Confirm current workspace owner, exact browser origin and granted installation/repository/account IDs. Login OAuth is not collection authorization. |
| Verification unavailable | Check App key, provider availability, suspension and minimal selected permissions. Errors redact provider bodies and credentials. |
| Save/enqueue conflict | Reload current connection; do not reuse an old revision for a new run. Preserve a request ID only for replaying the identical enqueue. |
| Run pending/running | Start the separate GitHub worker; allow lease expiry/backoff after interruption. Readiness verifies migrations, not provider access or completeness. |
| Partial transport/result | Inspect incomplete state; page/record/body/deadline/rate limits can leave gaps. Do not treat result as complete history. |
| Empty observations | Verify repository publishes real Deployments/status records; workflow success alone supplies none. |
| Grant/key changed | Stop both processes, update files privately, restart both, then re-save every connection using the changed installation grant. Any repository allowlist change changes its grant fingerprint and fences queued work. Remove/retire old provider credentials independently; old jobs cannot inherit new grants. |

The current transport is tested with controlled GitHub responses and actual PostgreSQL. A real App/installation run still requires your own configured credentials and deliberate repository selection. Argo transport, automatic scheduling, task-level monorepo binding and incident/change collectors remain subsequent slices.
