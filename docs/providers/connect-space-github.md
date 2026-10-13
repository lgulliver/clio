# Connect GitHub pull requests to SPACE

Clio collects repository activity and conditional timing signals separately from confidential pulse surveys and deployment metrics. GitHub login supplies identity only. Collection uses a separate GitHub App, an operator grant, a team-owned repository connection and a durable worker.

## Register and install a separate App

Register a GitHub App with repository **Pull requests: read-only** and **Metadata: read-only**. Install it only on selected repositories. Do not add deployment, content, administration or user permissions. This slice uses REST collection; it does not require a webhook receiver or user OAuth authorization.

In GitHub account or organization settings, open **Developer settings → GitHub Apps → New GitHub App**. Set a unique name and your project/account homepage. Leave user OAuth authorization and device flow off; clear webhook **Active**. Select only the repository permissions above, create the App, then generate/download its private key and install it on the chosen account with selected repositories. Keep the downloaded PEM private. GitHub's [registration guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) explains these fields; its [review endpoint documentation](https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request) confirms the required read permission.

Record App ID, installation ID, installation account ID/type and stable repository IDs. Use a different App ID from Clio's deployment collection App. Installation scope and Clio workspace grants are separate checks: knowing an installation ID does not grant access.

Use the numeric **App ID** from App settings, not its OAuth client ID. The installation settings URL contains its numeric installation ID. With your own authorized GitHub CLI session, these read-only commands return repository and account metadata; replace `OWNER` and `REPO`:

```sh
gh api repos/OWNER/REPO --jq '.id'
gh api users/OWNER --jq '{id,type}'
```

For the Clio workspace UUID, inspect the signed-in browser's read-only `/api/workspaces` response as described in [GitHub provider setup](connect-github.md#prepare-the-provider-and-choose-scope). Keep session cookies in the browser; the grants file uses IDs, not login tokens.

Create your workspace and teams through [getting started](../getting-started.md). Choose one owning team per repository. Repository activity is not attributed to services or products, and Clio does not pool counts or average repository medians into a team score.

## Configure private files

Keep the App PEM and grants file outside every Git checkout, owned by the API/worker user, with mode `600`. Paths must be absolute, regular files without symlinks. Keep signing keys, grants and tokens out of browser fields, chat and `VITE_` configuration.

```sh
(
  umask 077
  mkdir -p "$HOME/.local/share/clio-provider-credentials"
  chmod 700 "$HOME/.local/share/clio-provider-credentials"
)
```

Move your downloaded PEM into that directory. Create `space-github-grants.json` using your real IDs; replace every illustrative value below:

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

Use `User` for a personal installation. Each installation belongs to one Clio workspace; each grant permits at most 100 repositories, with at most 100 grants. Restrict both files with `chmod 600`.

Add these server-only settings to your existing ignored `apps/api/.env`, preserving identity and database configuration. Dotenv does not expand `$HOME`:

```dotenv
GITHUB_SPACE_APP_ID=YOUR_NUMERIC_APP_ID
GITHUB_SPACE_APP_PRIVATE_KEY_FILE=/home/YOUR_USER/.local/share/clio-provider-credentials/space-app-key.pem
GITHUB_SPACE_APP_GRANTS_FILE=/home/YOUR_USER/.local/share/clio-provider-credentials/space-github-grants.json
```

All three absent disables setup and collection. Partial, malformed or unsafe configuration prevents startup. API and worker read configuration at startup; restart both after key or grant changes. Grant changes fence existing jobs. Collection credentials remain separate from login OAuth and deployment collection credentials.

## Start and connect

From the repository root, apply migrations explicitly and start PostgreSQL, API, web and the separate worker:

```sh
pnpm db:up
pnpm db:migrate
pnpm dev:api
```

In separate terminals:

```sh
pnpm --filter @clio/web dev --port 5173 --strictPort
pnpm worker:space-github
```

API startup does not run migrations or workers. `pnpm worker:space-github --once` processes at most one eligible slice; it may leave a job queued for continuation, lease expiry or cooldown. Continuous mode resumes eligible jobs. Ctrl+C aborts acquisition safely.

Workspace owners use **Developer experience** to select a granted repository and one owning team, review collection scope and limits, then explicitly save and collect. Members can read saved results and run history. Collection requires a closed UTC calendar-day window, start inclusive and end exclusive, at most 90 days. Refresh reads saved state; it does not enqueue collection.

Only one active connection per repository/workspace and one active run per connection are allowed. Saves and collection use connection revisions. Request IDs make identical enqueue retries idempotent; changed input under the same ID is a conflict. Disconnect fences active work and retains saved history. Disconnect does not uninstall the GitHub App; retire external access separately.

## Interpret observations

Every numeric signal is **provisional**. REST traversal does not establish complete historical population or coverage. Zero eligible observations produce an unavailable value, not a measured zero. Results freeze source identity, original owning team, connection revision, reporting window and acquisition interval.

| Signal | Cohort and qualification |
| --- | --- |
| Pull requests opened | Valid PR creation events in the window, including bot and unknown authors. |
| Pull requests merged | Valid merge events in the window, including bot and unknown authors. Invalid merge times remain gaps. |
| Human reviews submitted | Submitted reviews in the window by known human reviewers, excluding self reviews and unknown actor eligibility. |
| Time to first human review (open to first review) | Human-authored PRs opened in the window, with completed review traversal and a qualifying review before window end. |
| PR review time (open to merge) | Human-authored PRs merged in the window with valid creation-to-merge timestamps, independently of review traversal. |

Durations need at least three qualifying PRs. They include draft time, author work and queues; neither measures active reviewer effort. First-review timing is conditional on observed qualifying reviews, and open-to-merge timing is conditional on observed merges. Unreviewed and unfinished work can therefore be missing from duration samples. Actor classifications, self-review flags and timing facts are retained; person IDs, logins, PR titles, bodies and review content are not stored.

Charts show independently qualified points. They do not connect incomplete historical populations or join sources, team assignments, connection revisions or different window lengths. No personal rankings, productivity score, automatic collection or notifications are provided.

## Bounds and rate limits

Acquisition is bounded to 20 PR pages/1,000 PRs, 100 review pages per PR, 10,000 retained submitted reviews and 16 MiB of normalized facts. Reviews outside the reporting window still consume retained-fact capacity. Responses are capped at 2,000,000 bytes and 10 seconds. Discovery never stops early solely because an older PR was created before the window.

Each slice permits at most 60 active seconds and 40 requests, including scope verification and resumed author lookup. Claims last 120 seconds. A job permits 30 minutes cumulative active acquisition, expires after 24 hours and allows three retryable failures. Quota contention, provider cooldown and cooperative yielding do not spend failure attempts.

Recovering an expired running lease conservatively charges 120 seconds against the active budget. Interrupted work cannot reset that budget. Reaching the budget with validated retained facts saves a provisional result with an explicit active-time gap; no usable retained checkpoint fails safely.

Collection shares Clio's durable App/installation quota implementation and conservative one-request-per-second App pacing. Separate Apps have separate budgets. See [provider rate limits](rate-limits.md).

## Troubleshooting

| State | Action |
| --- | --- |
| Setup unavailable | Check all three settings, file permissions and workspace grant; restart API and worker. Saved history remains readable. |
| Save forbidden or access lost | Confirm current owner membership and trusted browser origin. Login does not authorize collection. |
| Conflict | Refresh connection revision/history. Replay uncertain enqueue only with unchanged request ID and inputs. |
| Pending run | Start the worker; allow quota cooldown, scheduling or lease recovery. Readiness does not prove provider access. |
| Partial observations | Inspect traversal flags and gaps; bounds and changing REST pagination leave incomplete populations. |
| Insufficient samples | At least three qualifying human PRs are required for each duration independently. |
| Grant changed | Restart API/worker together and reconnect with current grant; queued work cannot inherit new authorization. |

This is a local operator setup, not hosted self-service App installation. Real collection requires your own App and selected repository authorization. Controlled fixtures exercise transport and persistence without live credentials; they do not prove real-source completeness.

## Reproduce controlled verification

Ordinary tests do not require a live App. PostgreSQL checks create and remove only their own random schemas. For the documented local development database, run from the repository root:

```sh
CLIO_TEST_DATABASE_URL='postgres://clio_dev:clio_dev_password@127.0.0.1:5432/clio_dev' pnpm test:integration
CLIO_TEST_DATABASE_URL='postgres://clio_dev:clio_dev_password@127.0.0.1:5432/clio_dev' pnpm --filter @clio/web exec vitest run src/features/space-github/contract-parity.test.ts
```

Use your own private test-database environment for another database; do not put real credentials in documentation or chat. API integration cases exercise actual sessions, role changes, scoped paging, restart/lease recovery, quotas and immutable publication. The cross-boundary case injects verified scope and controlled REST responses, then runs the actual PR adapter and worker through PostgreSQL into the strict browser result parser. Scope verification itself has separate controlled App/token tests. No test starts a live collector or inserts fixture results into your development workspace.

Without `CLIO_TEST_DATABASE_URL`, the database cross-boundary case is skipped and the pure calculation/type/parser parity cases still run. Passing those pure cases alone is not storage verification. Live GitHub verification remains a separate deliberate connection using your selected repository.
