# ADR 0008 Local live GitHub collection

Status: implemented locally; actual provider acquisition requires operator credentials and selected repository
Date: 2026-10-10

## Credential and authorization boundary

The local operator configures one GitHub App ID, an owner-only PEM file outside the checkout, and a private JSON grants file. Grants bind workspace UUID, installation ID, stable account ID/type and exact numeric repository allowlist. No signing keys or installation tokens are stored in PostgreSQL, accepted from browser requests or reused from identity OAuth. Short-lived installation tokens live only in worker/request memory. All provider configuration absent disables live connections; partial or malformed configuration fails startup with redacted errors.

An App JWT proves an installation belongs to the App, not that the current browser user controls its organization. An explicit local operator grant supplies that authorization separately. Only current workspace owners can save a service connection within granted scope. Hosted self-service installation ownership proof and encrypted credential management remain future decisions. Installation metadata must match App/account identity, use selected repositories and minimal Deployments/Metadata read permissions, and be unsuspended. A narrowed token must verify the exact selected repository.

Provider requests run outside database transactions. Save performs owner/session/service preflight, network verification, then transactional owner/session/revision/grant revalidation. Collection revalidates active connection, revision and current grant before credential issuance and terminal commit. Removing a grant, changing scope or disconnecting fences outstanding jobs; historical snapshots remain immutable. Disconnect stops Clio collection, not the GitHub installation itself.

## Service mapping and evidence

One live GitHub deployment connection per service is versioned independently of mock settings. Owner explicitly selects one repository, exact production environment, whole-repository deployment binding, and optional versioned consumer-exposure policy reference. No mock attestation transfers. Whole-repository selection is an explicit service assignment; future task filters require their own contract. Null exposure policy leaves qualification unknown.

Runs pin connection revision, service name and a closed UTC calendar-day window (at most 90 days). Owners enqueue; members read. Separate PostgreSQL jobs use bounded retries and fenced leases. Network requests and streamed bodies are time/size bounded; the total collection deadline stays shorter than the lease. Shutdown aborts in-flight provider work. HTTP errors and private evidence never become browser diagnostics.

Normalized source history persists per workspace/service/installation/repository. Repeated records preserve earliest observations, deployment metadata revisions follow the existing GitHub ordering policy, and conflicts fail closed. Later backfills cannot erase earlier success because records disappeared. Atomic completion persists merged history, immutable validated OEMS snapshot, metric calculation and safe result. Evidence cutoff is assigned after acquisition and includes mapping/database observation precision. Transport completion remains separate from metric coverage: all initial OEMS coverage flags stay false, missing failures/recovery/changes remain unavailable, and empty evidence supplies no coverage proof.

## Limits

This local authorization model requires a trusted operator and process restart for credential/grant changes. It does not provide hosted self-service installation flow, scheduled collection, incident/change evidence or an Argo transport. Real external registration/permission grants remain maintainer actions. Argo stays a separate subsequent transport rather than a guessed webhook endpoint.
