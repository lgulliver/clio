# Preparing real deployment sources

This guide prepares and checks access to **real GitHub Deployments and Argo CD**. Provider-side setup prepares the scope and access checks. For the local GitHub connection workflow, continue with [connecting GitHub Deployments](connect-github.md): separate App key/grants files, service connection and live worker. `pnpm worker:mock` remains fictional. For native Argo notification ingestion, continue with [connecting Argo CD](connect-argocd.md): explicit Application/source grants, a separate receiver credential and snapshot worker. Keep collection secrets separate from login OAuth settings.

Start with [local Clio setup](../getting-started.md). For an independent Argo practice environment, use the [optional Kubernetes-in-Docker sandbox](local-argocd.md). That sandbox supplies no data to Clio until deliberately connected through the native notification workflow.

## Choose the service and evidence first

Record this connection plan privately; repository names, application configuration and deployment history can themselves be sensitive. The values below are examples, not Clio configuration keys.

| Field | Example / requirement |
| --- | --- |
| Clio workspace and service | Your existing workspace; `checkout` service |
| Authoritative deployment source | GitHub Deployments **or** Argo CD for this service |
| Production scope | Exact GitHub environment names, or Argo instance + cluster + namespace + application |
| Consumer-exposure policy | Versioned agreement describing which trusted signal proves the rollout reached consumers |
| Application source | Stable source repository ID and verified application commit lineage |
| Configuration source | Separate manifests repository/revision when using GitOps |
| Reporting history | Desired UTC window, earliest retained evidence, known gaps and collection start |
| Credential owner | Person responsible for scope review, expiry, rotation and revocation |

Choose one authoritative deployment source per service. If both systems describe a rollout, retain an explicit shared rollout identifier before treating the other as corroboration. Equal SHA, environment or nearby timestamps cannot establish identity. Redeployments, rollbacks, self-heal and retries need their own evidence. These are Clio's accepted [deployment evidence rules](../decisions/0006-deployment-evidence-sources.md), not changes to OEMS.

Production naming, GitHub `production_environment`, successful workflows and Argo Synced/Healthy alone do not prove consumer exposure. Document the actual delivery mechanism: for example, a trusted deployment controller's success signal **after** traffic promotion. A test namespace or healthy guestbook is not production evidence.

## GitHub: register and install a collection App

You need permission to register an App and approve its installation in the target account or organization. Organization restrictions may require an owner. Keep the existing **GitHub OAuth App for Clio login** separate.

1. In GitHub Settings → Developer settings → GitHub Apps, select **New GitHub App**. Use a unique collection name and a project homepage.
2. Leave user authorization callbacks and user OAuth authorization unused. Disable **Active** under Webhook for this polling preparation; Clio has no webhook receiver.
3. Set repository **Deployments: Read-only** and mandatory **Metadata: Read-only**. Leave other repository, organization and account permissions disabled.
4. Choose the intended installation availability, register, then **Install App** on the target account. Choose **Only select repositories** and select only repositories whose deployment records you need.
5. Record the **App ID**, installation ID from the installation settings URL, account and selected repositories. Use App ID, not OAuth client ID.
6. Generate a private key on the App settings page. Move the downloaded PEM outside the checkout into your private credential directory and restrict it with `chmod 600 /path/to/key.pem`. Do not paste or commit its contents.

See GitHub's [registration instructions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) and [permission reference](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app). This scope supports deployment records; it does not grant source-code or commit-history collection. Additional metric evidence needs a separately reviewed permission design.

### Check access using an installation token

Before narrowing the token, obtain each numeric repository ID from repository metadata using your authorized operator account (GitHub CLI is optional):

```sh
gh api repos/OWNER/REPOSITORY --jq '{id, full_name}'
```

This lookup identifies the repository; it does not verify the App's access. The installation-token checks below do that separately.

Use Node 24, Python 3, jq and curl for this provider-side token exchange. Replace the App ID, installation ID, PEM path and numeric repository IDs before running. This creates a temporary credential, not a Clio connection. GitHub's [installation-token procedure](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) describes the exchange; installation tokens expire after one hour.

```sh
(
  set -eu
  set +x
  umask 077
  private_dir="$HOME/.local/share/clio-source-preflight"
  mkdir -p "$private_dir"
  token_file="$private_dir/github-installation.token"
  if test -e "$token_file"; then
    echo 'Token file already exists; revoke/retire it before issuing a replacement.' >&2
    exit 1
  fi
  check_dir=$(mktemp -d "$private_dir/github-issue.XXXXXX")
  trap 'rm -rf "$check_dir"' EXIT
  node --input-type=module - 'APP_ID' '/PRIVATE/PATH/app-key.pem' \
    "$check_dir/app.headers" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';
const [appId, keyPath, outputPath] = process.argv.slice(2);
if (!/^\d+$/.test(appId)) throw new Error('Replace APP_ID with your numeric App ID');
const now = Math.floor(Date.now() / 1000);
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const input = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({ iat: now - 60, exp: now + 540, iss: appId });
const signature = sign('RSA-SHA256', Buffer.from(input), createPrivateKey(readFileSync(keyPath))).toString('base64url');
writeFileSync(outputPath, 'Authorization: Bearer ' + input + '.' + signature + '\n', { mode: 0o600 });
JS
  # Check INSTALLATION-level selection/permissions with the App JWT, before narrowing.
  curl --fail --silent --show-error --header "@$check_dir/app.headers" \
    --header 'Accept: application/vnd.github+json' \
    --header 'X-GitHub-Api-Version: 2026-03-10' \
    'https://api.github.com/app/installations/INSTALLATION_ID' \
    > "$check_dir/installation.json"
  jq '{account: {login: .account.login, id: .account.id, type: .account.type}, repository_selection, permissions}' \
    "$check_dir/installation.json"
  jq --exit-status \
    '.repository_selection == "selected" and .permissions == {"deployments":"read","metadata":"read"}' \
    "$check_dir/installation.json"
  # Replace 12345 with your selected repository ID; include only intended IDs.
  printf '%s' '{"repository_ids":[12345],"permissions":{"deployments":"read"}}' \
    > "$check_dir/request.json"
  curl --fail --silent --show-error --request POST \
    --header "@$check_dir/app.headers" --header 'Accept: application/vnd.github+json' \
    --header 'X-GitHub-Api-Version: 2026-03-10' --header 'Content-Type: application/json' \
    --data-binary "@$check_dir/request.json" \
    'https://api.github.com/app/installations/INSTALLATION_ID/access_tokens' \
    > "$check_dir/response.json"
  python3 - "$check_dir/response.json" "$token_file" <<'PY'
import json
import pathlib
import sys
response = json.loads(pathlib.Path(sys.argv[1]).read_text())
value = response.get('token')
if not isinstance(value, str) or not value or '\r' in value or '\n' in value:
    raise SystemExit('Missing or invalid installation token')
with pathlib.Path(sys.argv[2]).open('x') as output:
    output.write(value + '\n')
PY
  # Show scope/expiry only, never the full response or token.
  jq '{permissions, repository_selection, expires_at}' "$check_dir/response.json"
)
```

Confirm returned installation account matches your plan and review its exact repository list in GitHub installation settings. The App-JWT check verifies installation-level selection/permissions; the later list/denied checks verify token narrowing only. Inspect returned permissions and installation settings: only Deployments read and mandatory Metadata read should be present, with **Only select repositories** at installation level. A narrowed token does not prove the installation itself has no broader grant. Correct excess installation access before accepting the connection. Never paste the response, JWT, PEM or token into chat or shared logs.

The following **read-only provider checks** need curl, Python 3 and jq. Start a private terminal with shell tracing disabled. Replace owner/repository values; use a token issued for the App installation, not your personal login token. A human's `gh api` success would not prove App authorization.

```sh
(
  set -eu
  set +x
  umask 077
  check_dir=$(mktemp -d)
  trap 'rm -rf "$check_dir"' EXIT
  # Token stays out of command arguments and shell history.
  python3 - "$HOME/.local/share/clio-source-preflight/github-installation.token" \
    "$check_dir/github.headers" <<'PY'
import pathlib
import sys
value = pathlib.Path(sys.argv[1]).read_text().strip()
if not value or '\r' in value or '\n' in value:
    raise SystemExit('Invalid token input')
pathlib.Path(sys.argv[2]).write_text('Authorization: Bearer ' + value + '\n')
PY
  repo_api='https://api.github.com/repos/OWNER/REPOSITORY'
  curl --fail --silent --show-error --header "@$check_dir/github.headers" \
    --header 'Accept: application/vnd.github+json' \
    --header 'X-GitHub-Api-Version: 2026-03-10' \
    "$repo_api" > "$check_dir/repository.json"
  jq '{id, full_name}' "$check_dir/repository.json"
  curl --fail --silent --show-error --header "@$check_dir/github.headers" \
    --header 'Accept: application/vnd.github+json' \
    --header 'X-GitHub-Api-Version: 2026-03-10' --get \
    --data-urlencode 'per_page=100' \
    "$repo_api/deployments" > "$check_dir/deployments.json"
  jq 'map({id, sha, environment, created_at, statuses_url})' "$check_dir/deployments.json"
  deployment_id=$(jq -r '.[0].id // empty' "$check_dir/deployments.json")
  if test -n "$deployment_id"; then
    curl --fail --silent --show-error --header "@$check_dir/github.headers" \
      --header 'Accept: application/vnd.github+json' \
      --header 'X-GitHub-Api-Version: 2026-03-10' \
      "$repo_api/deployments/$deployment_id/statuses?per_page=100" \
      > "$check_dir/statuses.json"
    jq 'map({id, state, environment, created_at})' "$check_dir/statuses.json"
  else
    echo 'No deployment records found; status check skipped.'
  fi
  curl --fail --silent --show-error --header "@$check_dir/github.headers" \
    --header 'Accept: application/vnd.github+json' \
    --header 'X-GitHub-Api-Version: 2026-03-10' \
    'https://api.github.com/installation/repositories?per_page=100' \
    > "$check_dir/scope.json"
  jq '{total_count, repositories: [.repositories[] | {id, full_name}]}' "$check_dir/scope.json"
  # Match the ID list used for issuance; this example checks up to 100 selected repos.
  jq --exit-status --argjson expected '[12345]' \
    '(.total_count == ($expected | length)) and (([.repositories[].id] | sort) == ($expected | sort))' \
    "$check_dir/scope.json"
  # Replace with a KNOWN existing private repo outside the selected scope.
  denied_status=$(curl --silent --show-error --output "$check_dir/denied.json" \
    --write-out '%{http_code}' --header "@$check_dir/github.headers" \
    --header 'Accept: application/vnd.github+json' \
    --header 'X-GitHub-Api-Version: 2026-03-10' \
    'https://api.github.com/repos/OWNER/UNSELECTED_PRIVATE_REPOSITORY/deployments')
  test "$denied_status" = 404 || { echo "Unexpected out-of-scope status: $denied_status" >&2; exit 1; }
)
```

The status request skips empty history. The token-scope assertion compares the exact planned list and total count; it does not enumerate the installation's broader repository grant. Review that list in installation settings even when the token checks pass. The App-JWT assertion separately requires selected repositories and minimal installation permissions. For the token-list example, use at most 100 repository IDs for this example. For larger scopes, paginate the installation repository list before comparing. Deployment requests check one page, **not complete history**; follow pagination for deployments and every deployment's statuses when collecting. Read all deployment records and every status environment: a status can promote a deployment into production even when its initial environment differs. Keep status revisions and observation times, including later failure/inactivity. See GitHub's [Deployments API](https://docs.github.com/en/rest/deployments/deployments?apiVersion=2026-03-10) and [statuses API](https://docs.github.com/en/rest/deployments/statuses?apiVersion=2026-03-10).

Confirm the returned numeric repository ID, exact environment and real status records match the connection plan. An empty list can mean no records, a wrong repository or missing history. Check production environments in the printed deployment and status records. Workflow runs do not automatically create GitHub Deployments: if your delivery tooling emits no deployment/status records, adapt that tooling deliberately or choose Argo as the authoritative source. Never create fake production records to make the check pass.

## Argo CD: establish scoped read access

You need an existing Argo instance and permission to manage the relevant AppProject. Install an Argo CLI compatible with that instance, use trusted HTTPS, and log in interactively through your normal operator identity. Use explicit `--argocd-context` on each command so changes target the intended instance. Do not use an admin session token as the future Clio credential.

Record the instance URL/identity, AppProject, application name **and UID**, application namespace, destination cluster and destination namespace. Recreating an application changes its UID. For multi-source applications, inventory every source and distinguish configuration revisions, image digests and application commits; a GitOps commit is not automatically the application commit.

### Add a dedicated project role

Have the Argo operator merge this **role fragment** into the existing AppProject through its usual managed configuration process. Preserve all other roles, destinations and source restrictions; this is not a complete manifest to apply. Example project `delivery`, application `checkout`, application stored in the Argo control namespace:

```yaml
spec:
  roles:
    - name: clio-reader
      description: Read checkout application evidence
      policies:
        - p, proj:delivery:clio-reader, applications, get, delivery/checkout, allow
```

For applications outside the control namespace, use the documented object format `delivery/APPLICATION_NAMESPACE/checkout`. Do not grant sync, update, delete, exec, logs, repository credentials or cluster administration for evidence reading. Inspect global `argocd-rbac-cm` and effective access too: `policy.default` can grant broader rights that a narrower project role cannot remove. See [Argo RBAC](https://argo-cd.readthedocs.io/en/stable/operator-manual/rbac/) and [project roles](https://argo-cd.readthedocs.io/en/stable/user-guide/projects/).

If GitOps manages the AppProject, have its operator preserve controller/API-managed token registration fields during reconciliation; confirm the issued token still works after the next sync. Do not add broad ignore rules or disable self-heal merely to pass preflight.

After operator review, issue a short-lived preflight token into a private file **outside the checkout**. Choose your own context and directory; commands run locally, not in Clio:

```sh
(
  set -eu
  set +x
  umask 077
  private_dir="$HOME/.local/share/clio-source-preflight"
  mkdir -p "$private_dir"
  # Choose a fresh token ID and file name for each issuance; preserve existing files.
  token_file="$private_dir/argo-preflight-20261010.token"
  if test -e "$token_file"; then
    echo 'Token file already exists; revoke/retire it before issuing a replacement.' >&2
    exit 1
  fi
  pending_file=$(mktemp "$private_dir/argo-pending.XXXXXX")
  trap 'rm -f "$pending_file"' EXIT
  argocd --argocd-context YOUR_CONTEXT proj role create-token delivery clio-reader \
    --expires-in 24h --id clio-preflight-20261010 --token-only \
    > "$pending_file"
  test -s "$pending_file"
  mv "$pending_file" "$token_file"
)
```

The [token command](https://argo-cd.readthedocs.io/en/stable/user-guide/commands/argocd_proj_role_create-token/) supports explicit expiry and token-only output. Do not commit the token, give it to the browser or copy it into the mock worker's `.env`.

### Check the real application API

Use the created project token, not your operator login. Example uses a private header file and removes the response afterward. Replace URL/project/application; consult your instance's `/swagger-ui` for version-specific parameters, including `appNamespace` when needed. Use your trusted private CA via curl `--cacert` if required; do not disable certificate checks.

```sh
(
  set -eu
  set +x
  umask 077
  check_dir=$(mktemp -d)
  trap 'rm -rf "$check_dir"' EXIT
  python3 - "$HOME/.local/share/clio-source-preflight/argo-preflight-20261010.token" \
    "$check_dir/argo.headers" <<'PY'
import pathlib
import sys
value = pathlib.Path(sys.argv[1]).read_text().strip()
if not value or '\r' in value or '\n' in value:
    raise SystemExit('Invalid token input')
pathlib.Path(sys.argv[2]).write_text('Authorization: Bearer ' + value + '\n')
PY
  curl --fail --silent --show-error --header "@$check_dir/argo.headers" \
    'https://ARGO_HOST/api/v1/applications/checkout?project=delivery' \
    > "$check_dir/application.json"
  jq '{metadata: {name: .metadata.name, uid: .metadata.uid, namespace: .metadata.namespace},
       project: .spec.project, destination: .spec.destination,
       sync: .status.sync, health: .status.health,
       operationState: .status.operationState, history: .status.history}' \
    "$check_dir/application.json"
)
```

Argo's [Applications API](https://argo-cd.readthedocs.io/en/stable/developer-guide/api-docs/) accepts bearer authentication and project filtering. Confirm application UID and destination against your plan. With the same token, verify access to a known application outside the allowed scope is denied; an operator should also test effective write permissions with Argo's RBAC tooling without performing a production mutation. Broad inherited read/write access fails the scope check.

Application state and retained history are mutable and bounded. This preflight proves access to current records, not complete deployment history. Future ingestion must preserve operations durably, assign trusted receiver observation times, retain retries/self-heal, and identify missing periods. Native Argo API responses are **not** Clio's normalized evidence contract. Use the strict `clio.argocd.notification.v1` producer and exact authenticated source endpoint from [the Argo connection guide](connect-argocd.md).

## Rotation, revocation and connection handoff

GitHub: generate a replacement App key, verify it, switch the eventual server credential, then remove the old key. Use GitHub's [installation-token revocation endpoint](https://docs.github.com/en/rest/apps/installations?apiVersion=2026-03-10#revoke-an-installation-access-token) to revoke outstanding tokens when retiring access; removing a signing key alone does not establish that issued tokens stopped working. Remove repository access or uninstall the App when the connection is retired. Review permissions after repository transfers or installation changes.

Argo: issue a fresh expiring role token, check scope, switch the eventual collector, then revoke the old token using its issued-at Unix timestamp. The Argo 3.5 CLI deletion command expects that timestamp, not the custom `--id` string. Decode only the saved token's `iat` locally to match the issuance; this is identification, not token authenticity verification. For the example preflight, the operator lists role tokens, identifies the issuance corresponding to the saved token, then substitutes its numeric timestamp:

```sh
python3 - "$HOME/.local/share/clio-source-preflight/argo-preflight-20261010.token" <<'PY'
import base64
import json
import pathlib
import sys
payload = pathlib.Path(sys.argv[1]).read_text().strip().split('.')[1]
claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
issued_at = claims.get('iat')
if type(issued_at) is not int:
    raise SystemExit('Missing integer issued-at claim')
print(issued_at)
PY
argocd --argocd-context YOUR_CONTEXT proj role get delivery clio-reader
argocd --argocd-context YOUR_CONTEXT --prompts-enabled proj role delete-token delivery clio-reader ISSUED_AT_UNIX
```

See [token revocation](https://argo-cd.readthedocs.io/en/stable/user-guide/commands/argocd_proj_role_delete-token/). GitHub token revocation uses `DELETE /installation/token` authenticated with the token being retired. Delete local preflight token files after revocation. No long-lived credential is needed merely to keep a connection plan.

**GitHub:** when scope, identities, exposure policy and sample evidence have been checked, continue with [the local connection guide](connect-github.md). Keep secrets in private files and record only non-secret setup decisions in project notes. **Argo:** continue with [native notification ingestion](connect-argocd.md), using a separate scoped receiver credential and explicit operation UUIDs; the read-only API token above remains for preflight.

The [local GitHub contract](live-github-contract.md) binds operator-granted scope to an authorized workspace/service, verifies installation/account/repository scope, keeps secrets outside PostgreSQL, and preserves immutable evidence and explicit gaps through pinned OEMS validation. Hosted self-service ownership proof remains future work. Native Argo ingestion follows the [scoped notification contract](live-argo-contract.md). Results must expose incomplete/unknown states honestly. Successful access checks, empty responses or transport completion do not establish metric coverage; deployment sources alone do not supply change failures, recovery evidence or complete commit lineage.

## Troubleshooting

| Symptom | Next check |
| --- | --- |
| GitHub 401 | App JWT validity/signing identity or installation-token expiry; generate a fresh correctly scoped token. |
| GitHub 403/404 | Installation account, selected repository, permissions/organization approval; inspect rate-limit headers locally. Private resource access can appear as 404. |
| GitHub deployments empty | Correct repository, pagination/history retention, whether delivery tooling publishes Deployments records; inspect environments in returned records/statuses. |
| Argo TLS error | Correct hostname and trusted CA chain; do not use `--insecure` as a production fix. |
| Argo 401 | Token expiry/revocation and correct Argo instance. |
| Argo 403/404 | Project, application namespace/name, role object and effective RBAC; project filtering affects missing-resource responses. |
| Healthy app but no usable rollout | Check operation identity, retention, operation kind, consumer exposure and source provenance separately. |
| Clio still shows mocks | Mock workflows remain separate. Configure the local GitHub App/grant and live worker using the connection guide; Argo uses its separate native notification grant, source connection and snapshot worker. |
