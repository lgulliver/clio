# Connect independent measurement evidence

Connect the service's native deployment source first: [GitHub Deployments](connect-github.md) or [Argo CD](connect-argocd.md). Save a successful collection for the desired closed UTC reporting window. Independent evidence then creates a separate saved measurement at a later database cutoff. Original provider results do not change.

This is operator-managed local configuration. GitHub login, GitHub App installation credentials, Argo native/enrichment/archive tokens and measurement-producer tokens have separate purposes. Configuring a producer authorizes its scoped statements; it does not prove their accuracy or promote coverage automatically. Review its evidence policy and actual service deployment paths before granting a capability.

## Choose four independently supported capabilities

| Capability | Real producer must establish |
| --- | --- |
| `population` | Exhaustive census of the service's actual deployment paths and interval; exact native operation roster; independently resolved retained gaps. An additional operation absent from the native snapshot requires fresh collection. |
| `change_links` | Complete deployed changes, canonical repository identities, exact commit IDs and committer timestamps; service history origin sufficient to establish first deployment. Keep application changes separate from GitOps manifests. |
| `classification` | Evidence-based failure and incident-driven rework decisions for exact native operations, including evidence for known negative decisions. Missing incident records do not establish a negative decision. |
| `recovery` | Exhaustive onset-window recovery episode census, exact causal production deployment, incident onset, service restoration or explicit open episode, and approximation status. Ticket closure is not service restoration. |

Different capabilities can come from different internal systems or reviewed exports. Clio's common protocol does not fetch incident-management systems or manufacture their evidence. Build a producer that maps independently retained source facts into the exact [evidence contract](measurement-evidence.md). Do not derive classification from a failed workflow, history completeness from the first retained deployment, or exposure from Synced/Healthy alone.

## Private grants

Create an owner-only directory outside every Git checkout. Keep all source evidence private too. Use distinct 64-character lowercase hexadecimal tokens per producer (for example `openssl rand -hex 32` redirected into a new mode-0600 file). Never put tokens in command arguments, browser configuration, screenshots or chat.

The API and measurement worker read `CLIO_MEASUREMENT_GRANTS_FILE`, an absolute path to a regular owner-only JSON file. Its array holds at most 100 grants. Example values below are fictional; replace workspace/service/source/producer IDs, policy, paths and repositories:

```json
[
  {
    "workspaceId": "11111111-1111-4111-8111-111111111111",
    "serviceId": "22222222-2222-4222-8222-222222222222",
    "provider": "github",
    "source": { "installationId": 123, "repositoryId": 456 },
    "producerId": "33333333-3333-4333-8333-333333333333",
    "capability": "population",
    "name": "Deployment census",
    "policyRef": "deployment-census/v1",
    "productionPaths": ["github-production:123:456:production"],
    "repositoryIds": [],
    "tokenFile": "/absolute/private/clio/census.token"
  }
]
```

Add separate grants for `change_links`, `classification` and `recovery`, each with its own producer UUID, name, policy and token file. Changes require nonempty explicit repository allowlists; other capabilities can use an empty list when repositories are irrelevant. Use canonical namespaced repository identities agreed with the producer and any retained application provenance.

For Argo use `"provider":"argocd"` and `"source":{"sourceId":"YOUR-NATIVE-ARGO-SOURCE-UUID"}`. Production path is `argo-production:SOURCE_UUID:ENVIRONMENT`. GitHub path is `github-production:INSTALLATION_ID:REPOSITORY_ID:ENVIRONMENT`. Each component uses `encodeURIComponent`; an environment such as `prod/eu` becomes `prod%2Feu`. These are exact service deployment paths, not free-form display names. Obtain actual paths from the authenticated basis projection rather than parsing provenance URIs or guessing them.

Grant and token files must be regular, owned by the API/worker OS user, mode 0600 and outside Git; symlinks are rejected. Restart API and measurement worker together after configuration changes. Remove a grant or rotate its token to revoke that producer's ability to admit reports or complete queued work. Rotation does not reset lifetime storage budgets. Previously completed measurements remain readable to current workspace members.

## Fetch a genuine saved basis

In Settings, select the workspace and service, choose a basis provider under Independent measurement evidence, then select a successful saved collection and choose Use selected saved collection. Copy its displayed Saved basis reference for `BASIS_RUN_UUID`. This selects existing storage without triggering a provider collection.

Machine endpoints use scoped Bearer tokens; browser cookies cannot authorize them:

```text
GET /api/measurement/bases/{github|argocd}/{BASIS_RUN_UUID}/producers/{PRODUCER_UUID}
POST /api/measurement/bases/{github|argocd}/{BASIS_RUN_UUID}/producers/{PRODUCER_UUID}/reports
```

Use a trusted HTTPS API endpoint, or loopback HTTP for local development. Store an Authorization header in a private file instead of passing the token directly to curl. Example uses placeholders for the header file and URL:



Create the header file once from the private token file, without printing it:

```sh
node --input-type=module - /absolute/private/clio/census.token /absolute/private/clio/producer.headers <<'JS'
import { constants, openSync, closeSync, readFileSync, fstatSync, writeFileSync } from 'node:fs';
const [tokenPath, headerPath] = process.argv.slice(2);
const fd = openSync(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
try {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 65)
    throw new Error('Invalid private token file');
  const token = readFileSync(fd, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid producer token');
  writeFileSync(headerPath, 'Authorization: Bearer ' + token + '\n', { mode: 0o600, flag: 'wx' });
} finally { closeSync(fd); }
JS
```

```sh
umask 077
curl --fail --silent --show-error \
  --header @/absolute/private/clio/producer.headers \
  'http://127.0.0.1:3000/api/measurement/bases/github/BASIS_RUN_UUID/producers/PRODUCER_UUID' \
  > /absolute/private/clio/basis.json
```

Use a new private header path after rotating credentials. Do not follow redirects carrying this credential. Keep the projection private: it contains exact operation identities and retained gap inventory.

Copy the returned `basis` unchanged into every report. It binds provider/run, native source identity, connection revision, pinned OEMS revision and snapshot/evidence/gap digests. Copy workspace/service IDs and native operation identities exactly. Producer identities, capabilities and policy references must match grants. A stale connection, source grant or native evidence digest requires collecting a new basis, not editing fields to make an old report appear current.

New Argo bases retain an explicit unbounded transport gap, including periods before capture/archive startup. An exact manifest is an inventory of uncertainty; it is not proof that uncertainty is resolved. Older Argo snapshots without exact manifests cannot acquire complete collection coverage through this protocol. Collect a fresh basis first.

## Build and submit reports

Each report has exactly these envelope fields:

```json
{
  "contract": "clio.measurement.evidence.v1",
  "eventId": "44444444-4444-4444-8444-444444444444",
  "producerId": "33333333-3333-4333-8333-333333333333",
  "workspaceId": "11111111-1111-4111-8111-111111111111",
  "serviceId": "22222222-2222-4222-8222-222222222222",
  "capability": "population",
  "policyRef": "deployment-census/v1",
  "evidenceRef": "opaque-reference-to-independent-export",
  "basis": {},
  "payload": {}
}
```

The empty objects above mark fields to replace with the genuine fetched basis and independently supported payload; this skeleton is not an admissible complete report. Use a fresh event UUID for each original report; retries reuse the identical event and body.

| Payload | Exact shape |
| --- | --- |
| Population | `{interval:{start,end}, exhaustive:true, productionPaths:[...], operations:[{sourceId,sourceDeploymentId}], gapResolutions:[{gap:{gapId,sourceId,reason,bounds},scope:{start,end},evidenceRef}]}` |
| Changes/history | `{history:{kind:"service_history_origin",interval:{start,end},evidenceRef} OR null, operations:[{sourceId,sourceDeploymentId,changes:[{repositoryId,commitId,committedAt,evidenceRef}],evidenceRef}]}` |
| Classification | `{operations:[{sourceId,sourceDeploymentId,failure,rework,failureEvidenceRef,reworkEvidenceRef}]}` |
| Recovery | `{interval:{start,end}, exhaustive:true, episodes:[{sourceId,sourceDeploymentId,episodeId,onset,restored,approximate,evidenceRef}]}` |

`failure` is `failed`, `no_recorded_failure` or `unknown`; `rework` is `incident_driven`, `not_incident_driven` or `unknown`. Known classifications require independent references; unknown references can be null. Restoration can be null for open episodes. Commit IDs use full 40-character SHA values; timestamps use UTC. Refer to the typed contract and parser for exact validation, not this compact shape table alone.

Empty change sets are valid for independently confirmed configuration-only deployments. An independently exhaustive empty deployment/episode census can establish its own bounded population, but an empty API response cannot. Unknown native qualification remains unknown. Do not resolve an unbounded gap by claiming a finite interval covers every possible time; supply independent census support for the relevant measurement scope.

Submit the report as a private file, retaining its exact contents for replay:

```sh
curl --fail --silent --show-error --request POST \
  --header @/absolute/private/clio/producer.headers \
  --header 'Content-Type: application/json' \
  --data-binary @/absolute/private/clio/population-report.json \
  'http://127.0.0.1:3000/api/measurement/bases/github/BASIS_RUN_UUID/producers/PRODUCER_UUID/reports'
```

Actual database receiver time controls availability. A basis cutoff at or ahead of the database clock returns a conflict; correct clock drift or retry later instead of assigning artificial observation times. Do not include client receiver time or a measurement cutoff. Conflicting replacements fail; corrections require a fresh collected basis and new reports. Recovery evidence arriving before its required failure classification remains partial until a new measurement pins the available classification.

## Calculate, read and operate

The browser owner workflow selects a saved native basis, shows configured capabilities and available receipts, and queues a new saved measurement. Select at most one received authority per capability. Missing reports can still produce an honest partial result. Current workspace members can browse completed measurement history without access to producer credentials or raw reports.

Run `pnpm worker:measurement` separately from API and native collection workers; `--once` handles at most one queued job. A measurement job pins report IDs/digests and current native/producer grant fingerprints. Later reports cannot change that job or any completed result. Evidence cutoff comes from the database after the selected facts; the original basis cutoff remains separately visible. Lease loss, revocation or invalid evidence cannot publish a successful result.

Source-lifetime admission is bounded by 5,000 retained fact records and 8 MiB across producer/token/basis/revision rotations. Exact report replay retains the original receiver time and consumes no additional retained facts/bytes. Database-clock request windows bound every authenticated basis read and report attempt, including malformed/conflicting reports and exact replays; wait when rate limited rather than retrying in a hot loop. These bounds do not claim an unbounded historical warehouse or permit deleting old evidence to fabricate coverage.

If measurements stay partial, inspect their static blockers and native quality reasons. Add real missing evidence and collect a new basis when required. All five complete metrics, authoritative no-observation results and partial results have distinct meanings. A local synthetic fixture verifies behavior; it does not certify a real deployment source or OEMS conformance.

A rotated producer whose retained report no longer matches its grant is omitted from the authority selector for that basis. Collect a fresh basis before submitting a replacement report. Other current authorities remain selectable. Without configured authorities, owners can still save an honest partial measurement and run `pnpm worker:measurement`; complete evidence requires the private producer setup above.

An ambiguous browser queue response keeps its request ID for retry. The server deliberately rechecks current native and producer eligibility before replaying an existing request: rotation or a changed basis can return 409. Refresh Recent measurement requests to discover the already-created run across both providers; do not weaken those fences or assume the request never committed.
