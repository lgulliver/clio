# Retained Argo history and outage recovery

Clio accepts a separately authorized operation archive so observations captured before delivery can be replayed after a receiver outage. Native notifications still use their ten-minute terminal observation horizon. Historical import trusts the configured journal producer's original capture clock and durable-before-send policy; it does not reconstruct past operations from the current Application or its bounded revision history.

## What this supplies

A journal retains original native notification payloads, operation identity, capture time, sequence and digest chain. A seal records an operator-trusted closed capture interval and interruptions. Clio acknowledges only committed entries, preserves unsupported payloads as explicit archive gaps and stores current receiver time independently from producer capture time. Snapshot availability uses receiver time. Old saved results remain unchanged after late replay.

Archive delivery does not establish production consumer exposure, application provenance, complete change linkage, failure causation or service restoration. Those require separate evidence. All three OEMS coverage flags remain incomplete. A successful drain, empty sealed interval or zero visible gaps does not prove population completeness.

## Prepare a source

1. Follow [connecting Argo CD](connect-argocd.md). Configure a native source bound to one workspace, service and exact Application UID/scope. Assign explicit operation UUIDs and kinds before operations start. Reusing a configuration revision is not operation identity.
2. Create a separate archive producer UUID and journal UUID. Choose a versioned policy reference describing who captures operations, the capture mechanism and clock, retained external proof, interruptions and durable storage limits. Generate an independent random token; native, exposure and provenance tokens cannot be reused.
3. Keep the token and grant files outside the repository, owner-only and inaccessible to browser code. The archive grant file is a JSON array. Each object uses the full native scope plus `producerId`, `journalId`, `policyReference`, `capability: "operation_archive"` and `tokenFile`, an absolute path to its separate token file. Do not place the token value inside the grant JSON. Token files contain exactly 64 lowercase hexadecimal characters, with an optional final newline. Configure the server-only `ARGO_ARCHIVE_GRANTS_FILE`; restart API and snapshot worker together after changing private configuration.
4. In Settings, select the granted source history archive and save the service connection. Owners choose only preconfigured producers. Members can read archive diagnostics and saved results.
5. Arrange for the producer to durably append each original observation before attempting delivery. Sending a notification directly to Clio without retaining it first does not supply this recovery guarantee.

No outbound Argo API credential or arbitrary provider endpoint is required by this push protocol. Login OAuth remains identity-only. The archive route is separate from native/enrichment routes: `POST /api/argo/sources/:sourceId/archives/:producerId`.

## Local journal commands

Use Node 24 on Linux. Set `CLIO_SOURCE_ID`, `CLIO_ARCHIVE_PRODUCER_ID` and `CLIO_ARCHIVE_JOURNAL_ID` to the UUIDs in your private grant, and `CLIO_ARCHIVE_POLICY` to its exact policy reference. The directory and token file below must be outside Git; store the token with mode 0600. The journal directory is created with mode 0700.

```sh
mkdir -p -m 700 "$HOME/.local/share/clio"
CLIO_JOURNAL_DIRECTORY="$HOME/.local/share/clio/argo-journal"
pnpm argo:journal init --directory "$CLIO_JOURNAL_DIRECTORY" \
  --source "$CLIO_SOURCE_ID" --producer "$CLIO_ARCHIVE_PRODUCER_ID" \
  --journal "$CLIO_ARCHIVE_JOURNAL_ID" --policy "$CLIO_ARCHIVE_POLICY"
pnpm argo:journal capture --directory "$CLIO_JOURNAL_DIRECTORY" \
  --input /absolute/private/current-application.json --format application \
  --evidence-ref urn:operator:retained-observation:1
pnpm argo:journal status --directory "$CLIO_JOURNAL_DIRECTORY"
pnpm argo:journal drain --directory "$CLIO_JOURNAL_DIRECTORY" \
  --base-url http://127.0.0.1:3000 --token-file /absolute/private/archive.token \
  --max-attempts 10 --max-wait-ms 30000
```

Capture accepts an original native notification with `--format notification` as well. Capture uses current local clock. Supply only contemporaneous, authenticated-source material under your policy; a stale Application snapshot is not reconstructed history.

After a closed capture interval, use `seal --start UTC --end UTC --evidence-ref REF`. Optional `--last-sequence N` selects a retained prefix; `--interruptions /absolute/private/intervals.json` reports `{start,end,reason}` intervals within the seal. Capture bounds must respect startup, chronological entries and previous seals. Drain again, then request a new saved Clio snapshot to see its receipt-time-fenced diagnostics. A seal acknowledges the producer's retained prefix; it does not declare complete OEMS coverage.

For controlled fictional experiments only, initialize a separate journal with `--fictional --startup-at UTC`, then use `append --input FILE --evidence-ref REF --captured-at UTC`. Explicit historical time overrides are unavailable to non-fictional capture. Fictional records must use a deliberately configured evaluation source; never present them as real deployment evidence.

## Real producer obligations

The journal CLI supports operator capture and controlled fixtures. For continuous acquisition, run the separately configured [scoped Application list/watch collector](argo-continuous-capture.md). It durably retains contemporaneous observations before delivery and records conservative interruption bounds. Operators must install/supervise this process, keep its capture clock trustworthy and retain independent proof under the policy. Occasional reads of the current Application cannot recover overwritten operations. Never certify intervals before the journal started.

Retain exact Application UID, scope, operation UUID, kind, start, revision, info and initiator. Capture terminal evidence within ten minutes of finish. Preserve the observed health timestamp rather than replacing it with the time a historical import is attempted. Trusted producer fabrication cannot be detected merely by validating UUIDs, timestamps or digest chains; retain independently auditable evidence under the policy.

Use a fixed trusted HTTPS Clio receiver for real integrations. Local HTTP is for explicit loopback development only. Tokens stay in private files and authorization headers, never command arguments, URLs, browser forms or logs. Proxy settings and URL credentials/query/fragment are rejected by the producer.

## Delivery, interruption and rotation

The producer resends the same immutable entry after lost acknowledgement. Clio returns the original committed receipt for exact retry. Missing predecessors or divergent envelope content do not advance the checkpoint. Valid envelopes containing unsupported or conflicting native payloads advance the journal while recording gaps; they do not create a fabricated native anchor.

Envelope strings containing NUL or malformed Unicode are rejected before local append and database admission. Seal interruptions must be ordered and nonoverlapping. A permanently invalid entry blocks its journal. Record that interruption and explicitly configure a new journal period; do not overwrite committed records or silently skip sequences. A future startup, capture or seal time returns HTTP 409. The CLI stops that drain rather than automatically retrying a conflict; after verifying the clocks and waiting for trusted receiver time to catch up, run drain again with the unchanged retained record. Missing predecessors and divergent content also return 409 and require operator diagnosis. A rejected seal can be corrected before acceptance; an accepted seal is immutable.

A registered journal keeps its original full native scope, startup, producer and policy. Changing scope or policy requires a new journal period; exact replay cannot rebind it. Native and archive grants remain independently pinned. Rotating archive credentials makes archived-only observations under the old fingerprint ineligible for new snapshots. Old saved snapshots remain readable. If identical native observation identity already exists under another native fingerprint, archive import records a cross-fingerprint gap and advances, preserving existing identity locks. Journal progress and seal diagnostics retain the journal lifetime assertion across credential periods, while eligible metric evidence uses current grant fingerprints. Those progress counts do not certify continuity or current metric eligibility across rotations.

An observation first received through archive can gain independent live authority only through a later genuine live arrival that passes the live horizon. Its live availability starts at that later receipt time. Replaying an old terminal payload cannot relabel archived-only evidence as live.

## Bounds and capacity

Sealed capture interval, reporting window and evidence cutoff are different:

| Bound | Meaning |
| --- | --- |
| Sealed capture interval | Producer assertion about the retained capture period, including reported interruptions |
| Reporting window | Closed UTC period requested for metrics |
| Evidence cutoff | Latest receiver availability included in one immutable snapshot |

Archive diagnostics show acknowledged sequence, retained entries, payload gaps, latest sealed interval, last successful sealed reconciliation and missing intervals. Long missing-interval lists show an explicit omitted count. Absence of archive fields in an older saved result means unknown archive state.

Archive ingress drains at most 15 entries/seals per minute, burst two, and preserves two tokens in the shared source bucket for competing ingress. Live bursts can still throttle. Respect `Retry-After` and bounded retry attempts; unfinished drains remain resumable.

Native, archive and enrichment storage share 5000 retained rows and 8 MiB per source lifetime. Entries may retain both archive and normalized native representations, so 5000 rows is not a promise of 5000 operations. Source journal storage is bounded too. Neither side silently prunes evidence or resets budgets through credential rotation. Use `status` to inspect local remaining capacity before draining a backlog. Archive acknowledgements include `remainingRows` and `remainingBytes` for server capacity at that commit; exact retries return the original values, so they are not a current global capacity reading. The CLI reports local capacity and does not print acknowledgement bodies. Real producer integrations should retain these safe budget fields for operator monitoring. Exhaustion needs an explicit operator decision.

## Verification limits

Controlled tests must cover receiver outage, persisted journal replay, lost acknowledgements, invalid payloads followed by valid entries, empty/delayed seals, grant rotation, storage exhaustion and cutoff immutability. Production capture is established only after its configured acquisition mechanism and permissions have been connected and verified. Failure/recovery evidence and complete-coverage promotion remain separate work.

## Controlled outage verification

`apps/api/tests/argo-archive.integration.ts` includes an executable journal-to-database walkthrough: retain an original operation and seal, make delivery unavailable, capture a snapshot without that operation, restore delivery, lose the first committed acknowledgement, replay identical bytes, then request a new snapshot. It verifies one canonical receipt, retained journal files, archived capture bounds, unchanged earlier result and all three false coverage flags. Run the API PostgreSQL integration suite against a disposable development database as described in [getting started](../getting-started.md); tests create and remove only their own random schemas. This is controlled fixture evidence. The separately configured [continuous collector](argo-continuous-capture.md#verified-local-proof-2026-10-10) also has a scoped local Kind list/watch proof; production installation and complete population remain unverified.
