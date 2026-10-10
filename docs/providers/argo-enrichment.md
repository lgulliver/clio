# Independent Argo deployment evidence

Clio accepts two independent producer capabilities alongside native Argo notifications: `consumer_exposure` confirms production activation; `application_provenance` maps an immutable artifact digest to an application repository and commit. Native `Healthy`/`Succeeded` remains insufficient. A failed rollout can still expose a canary to consumers, and build provenance alone never qualifies a deployment.

The receiver, immutable storage, cutoff joins and owner selection are implemented. Tests use fictional producers. Clio does not supply a production traffic observer or build attestation service, establish your activation policy, or claim complete history. Start with [native Argo setup](connect-argocd.md); the exact admission contract is [documented here](../superpowers/specs/2026-10-10-argo-enrichment-design.md).

## Configure real producers

1. Establish the native Application grant and active Clio connection first. Use an operator-controlled source of production activation evidence: for example, a traffic observer confirming a particular immutable artifact serves consumers, or an application signal confirming a configuration revision became active. Do not translate Argo health into exposure. Document a versioned policy and the durable evidence reference that supports each assertion.
2. For provenance, configure your trusted build system to publish the exact `sha256:` artifact digest, namespaced application repository identity and full lowercase 40-character commit SHA. A GitOps configuration SHA is separate from the application commit. Tags, branch names, nearby timestamps and matching configuration revisions do not establish artifact provenance.
3. Generate distinct producer UUIDs and distinct 256-bit credentials for each capability. Keep grant/token files outside Git checkouts, owned by the API/worker user with mode `0600`, absolute paths and no symlinks. Follow the token-generation example in the native setup guide; never reuse its token. Configure producers through your existing secret-management workflow and trusted HTTPS receiver. No secrets belong in browser fields, query strings, committed JSON or `VITE_` settings.
4. Create a private enrichment grants file. Each entry references an existing native source UUID; Clio derives its exact workspace, service, instance, Application, destination, configuration repository and production environment scope. Exposure grants require an empty repository list; provenance grants require explicit namespaced repository identities. The following values are fictional:

```json
[
  {
    "sourceId": "11111111-1111-4111-8111-111111111111",
    "producerId": "55555555-5555-4555-8555-555555555555",
    "capability": "consumer_exposure",
    "policyReference": "urn:example:production-activation:v1",
    "repositoryIds": [],
    "tokenFile": "/home/operator/.local/share/clio/argo/exposure.token"
  },
  {
    "sourceId": "11111111-1111-4111-8111-111111111111",
    "producerId": "66666666-6666-4666-8666-666666666666",
    "capability": "application_provenance",
    "policyReference": "urn:example:build-provenance:v1",
    "repositoryIds": ["github:example/application"],
    "tokenFile": "/home/operator/.local/share/clio/argo/build.token"
  }
]
```

5. Export `ARGO_ENRICHMENT_GRANTS_FILE` alongside `ARGO_INGESTION_GRANTS_FILE` in the API and Argo worker environments. Apply migrations explicitly with `pnpm db:migrate`, then restart both processes. Configuration is loaded on startup, not hot-reloaded. In Clio, an owner selects the granted source and desired independent evidence producers, confirms service assignment and saves a new connection revision. Displayed policy labels are grant selection, not proof of delivered evidence.

## Publish assertions

Send `POST /api/argo/sources/SOURCE_UUID/enrichments/PRODUCER_UUID` with `Content-Type: application/json` and that producer's `Authorization: Bearer TOKEN`. Native notification credentials and GitHub login cannot authorize this route. Maximum body size is 64 KiB; unknown fields are rejected at every object boundary. Never include raw build logs, traffic payloads or credentials.

An artifact exposure assertion uses this shape. Replace the fictional values with observed facts; `effective_at` must be a UTC instant at or after the native operation start and no later than Clio's receiver clock:

```json
{
  "contract": "clio.argocd.enrichment.v1",
  "event_id": "77777777-7777-4777-8777-777777777777",
  "source_id": "11111111-1111-4111-8111-111111111111",
  "producer_id": "55555555-5555-4555-8555-555555555555",
  "policy_reference": "urn:example:production-activation:v1",
  "evidence_ref": "urn:example:activation:receipt-42",
  "kind": "consumer_exposure",
  "application_uid": "44444444-4444-4444-8444-444444444444",
  "operation_id": "88888888-8888-4888-8888-888888888888",
  "configuration_revision": "configuration-revision-42",
  "effective_at": "2026-10-10T10:00:01.000001Z",
  "subject": {
    "kind": "artifact",
    "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
}
```

For configuration activation, replace `subject` with `{"kind":"configuration","revision":"configuration-revision-42"}`. Its revision must exactly equal `configuration_revision`; it qualifies independently without attaching application build provenance.

A provenance assertion has no operation binding and can arrive before the rollout:

```json
{
  "contract": "clio.argocd.enrichment.v1",
  "event_id": "99999999-9999-4999-8999-999999999999",
  "source_id": "11111111-1111-4111-8111-111111111111",
  "producer_id": "66666666-6666-4666-8666-666666666666",
  "policy_reference": "urn:example:build-provenance:v1",
  "evidence_ref": "urn:example:build:receipt-42",
  "kind": "application_provenance",
  "repository_id": "github:example/application",
  "commit_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "artifact_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

Clio attaches provenance only through an exact artifact digest exposure for the same source. Repeated rollouts reference one shared service-level provenance assertion set per artifact, preserving all agreeing producer evidence without copying it into every rollout. Unbound inventory remains inventory. Evidence references are retained as strings; Clio never dereferences their URLs.

## Retry, rotate and interpret results

Retain a stable event UUID and identical content for retries. Exact authorized replay returns the original acknowledgement and receiver observation. Changed content under that UUID returns `409`. An exposure arriving before its eligible native rollout also returns `409`: deliver the native anchor, then retry the original event. A missing-anchor conflict includes `Retry-After: 2`; other conflicts do not. There is no pending exposure mailbox. Unsupported operations such as retry/self-heal cannot be qualified through this route.

One immutable artifact/configuration subject is allowed per source/Application/operation. One repository/commit mapping is allowed per source/artifact digest. These locks survive producer changes and credential rotation; a new UUID cannot override conflicting facts. Agreeing assertions from independent producers are retained separately.

Native and enrichment ingress share the source token bucket (30/minute, burst 10) and finite lifetime history budget (5000 rows, 8 MiB). Enrichment receipts and new subject/provenance lock rows count toward that budget; rotating or adding producers does not create new capacity. Replay consumes rate capacity but no new storage. Follow the native guide's exhaustion recovery; do not delete retained evidence to make a conflicting assertion succeed.

After any scope, credential or policy change, restart API and worker together and save a reviewed connection revision. Public producer labels cannot reveal credential rotation: unchanged labels may still be fenced server-side, so an enqueue rejection after rotation requires an owner to review and resave. Legacy native policy metadata is retained on same-source saves but cannot authorize independent exposure. Old fingerprints cannot replay or join current snapshots. Reassert compatible facts with new event UUIDs under the current grants and an eligible current native anchor. Rotation/interruption periods remain incomplete.

Snapshots use one database cutoff for native and enrichment receipts. A late assertion can affect a later snapshot while its confirmed activation time remains unchanged; earlier snapshots stay immutable. Result summaries count eligible received assertions, including unbound inventory, rather than qualified deployments. All coverage flags remain false. Deployment frequency can show a provisional qualifying count; change lead time, change failure, recovery and rework remain unavailable without their separate required evidence. This capability does not establish conformance.

## Reproduce the fictional workflow

With development PostgreSQL running, run the controlled HTTP/storage/worker fixture suite:

```sh
CLIO_TEST_DATABASE_URL='postgres://clio_dev:clio_dev_password@127.0.0.1:5432/clio_dev' pnpm test:integration
pnpm --filter @clio/adapters test
```

Integration fixtures create and remove only random test schemas. They exercise separate producer authentication, native notification admission, missing-anchor retry, failed-rollout exposure, immutable storage, cutoff capture and actual OEMS calculations. No real producer or Application is modified. Adapter fixtures also demonstrate build-only inventory, configuration activation, exact digest provenance, conflicting assertions and deterministic joins.

Enrichment admission also reserves serialized snapshot headroom in the shared 8 MiB byte budget. This accounts for repeated evidence/policy references by their encoded byte lengths, independently of grant size. Artifact exposure reserves the maximum application-repository representation until an immutable digest mapping is known; an existing digest lock permits a smaller exact reservation. The 5000-row ceiling is an additional limit, not a promise that 5000 assertions fit. Exact replay consumes no new storage or headroom. Reservations are not refunded by rotation or later captures.

Producer policy and evidence references are opaque text. Canonical OEMS source references use stable namespaced SHA-256 URI aliases; original text remains in the exposure/provenance assertions and private receipts. Unicode labels cannot invalidate a stored OEMS snapshot and are never dereferenced.
