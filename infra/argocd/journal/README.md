# Durable Argo source journal

Local Linux operator tool. Invoke from the repository root:

```sh
node infra/argocd/journal/cli.ts help
```

The coordinator maintains the operator setup/outage guide and root package script. This directory owns durable source storage and delivery only. It does not fetch providers, change live admission, reconstruct Application history, supply enrichment, or establish metric coverage.

## Storage and locks

Use one local filesystem, host and Linux PID namespace. Journal directory must be an absolute canonical path outside Git, owned by the current UID with mode `0700`. Token must be a regular non-symlink file, mode `0600`, current UID, outside Git, containing one 64-character lowercase hex credential. Ancestor symlinks are rejected. Do not share journals through network filesystems or containers with different PID namespaces.

Short writer locks cover reads, capture, append, seal and durable sender transactions. Independent `.sender.lock` ownership spans each drain; HTTP and backoff run outside writer ownership, so capture can continue while delivery stalls. Independent `.capture.lock` ownership admits one continuous collector. Owner identity includes Linux boot ID, PID and `/proc/PID/stat` start ticks. A complete nonempty claim directory is atomically renamed to `.lock`; competing owners cannot replace it. Stale reclamation unlinks only the old nonce-specific owner file, then removes the empty directory. A new nonempty owner prevents that removal. PID reuse and host reboot therefore do not strand a valid journal. Unreadable process identity and malformed locks fail closed. Empty locks left during release may be replaced by a prepared claim. A crash before claim publication may leave an unused `.claim-*` directory; these contain lock metadata only, never evidence or credentials. After checking that its owner is dead, operators may remove that abandoned claim; it does not block normal acquisition.

Immutable `records/0000000001.json` files order both entries and seals. Entry sequences count entries only. Exact bytes, shared adapter digest, previous digest, scope, startup, capture chronology and incremental seal bounds are checked on every open. Holes, torn files, changed digest/content, unexpected record names, oversized records and divergent chronology stop visibly. Retained evidence is never pruned or rewritten. The digest chain detects corruption; an operator controlling the journal can fabricate or recompute evidence, so this is not independent proof of capture completeness.

Exclusive file creation plus file and containing-directory fsync precede checkpoint updates and HTTP. Recovery derives the retained prefix from immutable files, including an entry whose fsync completed before checkpoint update. `state.json` is a fixed-size sender checkpoint replaced through a flushed `state.pending` and directory fsync. The continuous collector uses separate `capture-state.json`/`capture-state.pending` under capture ownership; neither checkpoint overwrites the other. An abandoned pending state is ignored; persisted acknowledgements alone advance the sender. Lost acknowledgement causes the same retained request bytes to be resent. Only HTTP `202` advances acknowledgement, and acknowledged files remain retained.

Default ceilings are 5000 combined entries/seals and 8 MiB serialized retained records. Operators may lower both ceilings during init; they cannot increase them. Complete envelopes are preflighted against 65536 UTF8 bytes before creation. Metadata/config/checkpoint files are separately small and bounded. Backend shared budgets also charge native/evidence rows and snapshot headroom, so server exhaustion may precede local capacity.

## Capture and drain

`append` accepts original native notification JSON; `capture --format notification` records it unchanged. `capture --format application` selects actual Application UID, scope, operation metadata, start/finish, retry count, info, initiator, configuration revision and current health fields into the native notification contract. No rollout marker gate, invented UUID, operation-kind rewrite or `status.history` reconstruction exists. Multi-source/source-hydrator flags and malformed metadata are preserved for receiver-side unsupported gaps. A contemporaneous file is an operator capture assertion; file contents alone cannot prove when the Application was observed.

Capture records the current local clock. Caller-supplied capture/startup times require `init --fictional` and remain visibly fictional in status. Startup/capture chronology and future-time checks fail instead of clamping. Seals describe `[start,end)` incremental prefixes, including empty intervals, and reject overlapping intervals, late captures and a delayed prefix whose next entry already falls before seal end. Interruptions are ordered, bounded to 32 and contained within seal bounds.

Drain sends one retained entry/seal per POST to the fixed `/api/argo/sources/:sourceId/archives/:producerId` path. Base origin is explicit trusted HTTPS or loopback development HTTP; URL credentials, query/fragment (including empty), non-root paths, non-loopback HTTP, redirects and proxy environment variables are rejected. Tokens and receiver response bodies are never printed. This tool has no provider API URL or Kubernetes credential option.

Attempts are capped per run (default 15, allowed 1–100), request timeout is five seconds, and all attempts have four-second pacing persisted across restarts. Transient failure uses bounded exponential backoff with jitter and respects `Retry-After`. The wait ceiling is at most 60 seconds per attempt; a longer receiver cooldown is persisted and ends the run with pending records. Sender completion means transport acknowledgement, never coverage or completeness. `drain` exits `2` when records remain pending, `1` on validation/storage failure, and `0` after all retained records are acknowledged. `status` shows retained/acknowledged progress and local remaining capacity without payloads, tokens or evidence references.

Coordinator must run the actual loopback HTTP regression outside restricted networking. See [continuous capture setup](../../../docs/providers/argo-continuous-capture.md) for the separately configured scoped list/watch process. DB admission, actual cluster integration and independent review remain separate verification.
