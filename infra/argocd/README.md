# Clio native Argo producer

`clio-notifications.yaml` targets Argo CD 3.5.4 and emits the exact
[notification contract](../../docs/providers/live-argo-contract.md). Merge its data keys into
the existing `argocd-notifications-cm`; preserve unrelated services and context entries. Set
`context.sourceId` to the granted source UUID and service URL to the operator-selected trusted
HTTPS ingress. Set the matching random bearer credential as `clio-token` in
`argocd-notifications-secret` through a private operator workflow. Subscribe only the granted
Application with `notifications.argoproj.io/subscribe.clio-operation.clio: ""`.

Automation must supply fresh `clio.operation-id` UUID in API sync `infos`, optionally
`clio.operation-kind` (`rollout`, `self_heal`, `retry`, `unknown`). These become native
`status.operationState.operation.info`; authenticated API preserves initiatedBy. Missing UUID
is a gap, not a deployment. Same configuration SHA does not identify operations. The template
encodes a constructed object with `toJson`, preserving quotes, backslashes, newlines and HTML
characters. It emits nullable absent fields, explicit boolean flags and empty arrays.

The custom expression extracts UUID from native info with `filter`; `sync.GetInfoItem` is
available in templates but was absent from the pinned controller's trigger environment.
The trigger uses pinned expression helpers `time.Now()` and `time.Parse()` (not template
helpers) and sends only `Succeeded`, `Failed` or `Error` while completion age is at most 600
seconds. The predicate admits missing `finishedAt` for terminal gaps. Argo CD 3.5.4's controller,
however, skips those applications as "sync status out of date" before evaluating triggers;
its runtime CLI evaluates the nullable branch, but native delivery cannot be claimed. Another
authenticated producer can deliver that explicit gap. Missing completion cannot establish an
age bound; such exceptional producer observations can consume budgets on health changes.
Ordinary completed operations stop delivering health churn after ten minutes. `Running`
from another authenticated producer remains an unsupported receiver gap. This predicate does
not guarantee delivery or backfill. Clock skew can still produce receiver temporal gaps.
`oncePer` combines UUID, phase, health and health transition timestamp. Unmarked operations
use `startedAt` only to distinguish gap notifications. SHA/resourceVersion never participates.
Unsupported scope-valid multi-source/hydrator shapes with nullable `repoURL` produce gaps;
all other identity bindings remain mandatory and non-null repository mismatches are drift.
Malformed native timestamps, finish-before-start order and unknown health statuses reject
before gap classification, including unmarked operations. Syntactically valid past gap start
times remain available; future gap starts become null. Canonical identity retains validated
original fields for metadata conflict checks. Storage uses receiver time for observation
periods and must not persist private gap canonical payloads.

This file configures one source. Multiple sources require distinct namespaced service,
template, trigger, Secret key and source path; follow coordinator's integrated runbook.

Webhook retry delays use integer nanoseconds: the pinned runtime rejected `1s`/`5s` strings
when decoding native `time.Duration`. Configured first retry waits one second, with three
maximum retries and five-second maximum delay. Retry exhaustion still permits lost evidence.

## Controlled producer proof

On 2026-10-10 the existing dedicated Kind `clio-argocd` sandbox ran Kubernetes 1.36.4 and
Argo CD 3.5.4, with public guestbook configuration at
`f58c7ed8cfe28ad70701c5923fdbd0154388ea9f`. TLS verification used the existing public CA
`.agent-runs/argo-public-ca.pem`; verification was never disabled.
A dedicated `clio-eval` API-key account had only get/sync for `default/clio-guestbook`.
Actual authenticated application read/sync succeeded. Actual application patch and other-app
sync returned 403; authorization queries denied update/delete and foreign get/sync.

Two API syncs at that SHA completed with UUIDs
`0d1ccb3c-4ba8-435e-9c5f-3352c734a53b` and
`d9a1150d-db37-4b38-b512-2e4dab9c7134`, each preserving `initiatedBy.username: clio-eval`.
The real notification controller delivered terminal notifications to the scoped Docker probe.
Each first terminal request received 503, then an identical authenticated body retried to 200.
Quote/backslash/newline/HTML operation-info round trips passed. Both envelopes parsed as
operations, with false exposure and null application provenance. Native notified bookkeeping,
periodic reconciliation and an unrelated annotation update produced no repeat delivery. A
third unmarked API sync proved native startedAt fallback bookkeeping and an explicit
`unmarked_operation` gap with no deployment evidence; its terminal 503 also retried to 200.

Probe is attached to the dedicated Kind Docker network, with summary published only on
`127.0.0.1:8090`. The sandbox-only HTTP hop is isolated probe delivery; Clio API stays loopback.
No real Clio receiver, persistence, worker or results integration is proved by this test.
Private bootstrap credential stayed in memory; evaluation/probe credentials stayed in
owner-only files outside Git and the Kubernetes notification Secret. Evaluation token expires
after one hour; account policy remains until operator removes it. Secret and probe remain for
coordinator inspection and deliberate receiver cutover. That cutover requires changing both
scoped operator grant/credential and producer destination, not treating these probe credentials
as a connected Clio source.

Public artifacts and probe scripts live in this assigned checkout's ignored `.agent-runs/`;
`provider-handoff.md` lists exact paths and commands. Runtime artifacts are local observations,
not committed fixtures or a completeness claim.

## Review-fix producer proof

The same pinned controller was retested with terminal-only final predicate. For horizon
suppression, only the sandbox trigger limit changed temporarily from 600 to 5 seconds;
two health/status timestamp changes after completion produced no additional requests
(14 before and 14 after). Original operation/health state and exact 600-second trigger were
restored, then read back from the running ConfigMap. Controlled status edits prove producer
suppression only; authenticated API sync evidence comes from separate real get/sync calls.
The pinned runtime CLI also checked Succeeded/Failed/Error, Running exclusion, one-day-old
completion exclusion and nullable completion. Missing-finish controller gating remains the
limitation described above.

Two new real API operations, `9c0f320c-ddf9-4bbf-a04b-bc87887872f9` and
`72a354d4-def3-4c0b-b1ba-6e022ba44792`, used the same pinned guestbook SHA with `clio-eval`
initiator and safe JSON info. Each terminal envelope received 503 then identical-body 200;
no Running notification was emitted. A separate unmarked API operation retained its terminal
gap. Final proof includes parser receipt digests and checks annotation/bookkeeping plus
70 seconds of periodic reconciliation for no delivery loop. See ignored
`.agent-runs/provider-review-fix-proof-public.json` and `provider-review-fix-handoff.md`.
These are scoped probe receipts, not Clio database receipt IDs or receiver integration.

## Integrated Clio receiver proof

The coordinator then connected the same sandbox Application to a real Clio service with
an owner-saved connection revision, a private scoped grant and a separate random ingestion
credential. Docker Desktop's Kind network cannot reach the host's loopback API directly;
a temporary bounded tunnel on the isolated Kind network forwarded only this source's
operation endpoint to `127.0.0.1:3000`. Its host transport was published only on loopback,
authenticated independently, and returned Clio's actual HTTP response to the controller.
This evaluation transport is not a hosted ingress or a production deployment recipe.

Native sync UUIDs `6bf8c68e-edd5-4bba-bd18-6ab85dbfa841` and
`2be20862-1a01-4092-8497-2f700d0cc7c1` used the same pinned configuration SHA.
The notification controller received HTTP 202 with durable Clio receipt IDs for both,
followed by another 202 for an unmarked-operation gap. PostgreSQL retained three receipts,
four evidence records and two distinct deployments. The worker completed a closed UTC-day
capture under OEMS revision `5908bb12cdf24e7528088237dff9dca4c10ff45f`; the authenticated
browser showed two unknown qualifications, one missing-identity gap, incomplete coverage,
provisional frequency count zero and unavailable rates/recovery time. These retained counts
span all dates; the reporting window was the previous day, not today's sandbox operations.
Existing mock history and GitHub setup-needed state remained separate and readable.

Public proof is in the coordinator checkout's ignored `.agent-runs/argo-runtime-proof-public.json`;
the producer probe artifacts above remain independent retry/trigger evidence. Start with
[connecting Argo CD](../../docs/providers/connect-argocd.md) for reproducible operator setup
against a trusted reachable HTTPS receiver, including the private grant and snapshot worker.
