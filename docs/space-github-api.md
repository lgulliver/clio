# SPACE GitHub HTTP contract

These routes use database-backed GitHub login sessions and current workspace membership. Provider credentials are separate server-only configuration. Responses, including errors, use `Cache-Control: no-store`. Writes require current owner membership and the configured exact browser Origin. SQL authorization is rechecked after provider verification; preflight admission alone cannot authorize a save.

Base: `/api/workspaces/:workspaceId/space/github`.

| Method and suffix | Request | Response |
| --- | --- | --- |
| GET `/availability` | No query fields | `{workspaceId,enabled}` for members; owners additionally receive `grants`. |
| GET `/mappings` | Optional `teamId`, `cursor` | `{workspaceId,teamId,mappings,nextCursor}`. |
| POST `/mappings` | `{teamId,installationId,repositoryId}` | 201 `{mapping}` after selected-source verification. |
| PATCH `/mappings/:mappingId` | `{revision,teamId}` | `{mapping}` with revised ownership. |
| POST `/mappings/:mappingId/disconnect` | `{revision}` | `{mapping}`; retained historical team context, disconnected state. |
| POST `/mappings/:mappingId/runs` | `{revision,requestId,windowStart,windowEnd}` | 202 `{run}`; identical scoped request replay returns the same run. |
| GET `/mappings/:mappingId/runs` | Optional `teamId`, `cursor` | `{workspaceId,mappingId,teamId,runs,nextCursor}`. |
| GET `/mappings/:mappingId/results` | Optional `teamId`, `cursor` | `{workspaceId,mappingId,teamId,results,nextCursor}`. |
| GET `/results/:resultId` | No query fields | `{result}`; readable after disconnect or team deletion. |

Bodies and queries reject unknown keys. Workspace, team, mapping, run, result and request IDs are UUIDs. Provider IDs and revisions are positive safe integers. Reporting windows are canonical UTC midnight instants, start inclusive and end exclusive, closed and no longer than 90 days.

Owner grants expose only App, installation, installation account identity/type and explicitly granted repository IDs. They expose no key, token, private grant fingerprint or repository label before selected-source verification. An absent PR App disables new setup/collection, while saved history remains readable. Pulse surveys and deployment providers remain independent.

## Immutable context and paging

Mappings contain `id`, `workspaceId`, `appId`, `installationId`, `repositoryId`, verified `repositoryLabel`, copied `teamId`/`teamName`, `revision` and `connected`. Results and runs freeze original source, mapping revision, team ID/name and reporting window. Current team names or connection assignments must not be used as expected context when parsing historical results.

Mapping filters include current ownership or captured historical run/result ownership. Run/result filters use copied historical team identity. Each page contains at most 25 rows; `nextCursor` is non-null only on a full page. Cursors are opaque and context-bound. Page length never establishes a workspace total. Deleted or stale page anchors may return a resource error; clients independently recheck membership before treating this as workspace access loss.

Runs expose safe state (`queued`, `running`, `succeeded`, `failed`, `cancelled`), queue/completion timestamps, reason and optional result ID. Pending and failed run history is independent of success history; a newer failure cannot erase an older saved result.

Results expose acquisition start/end, completion time, `contractVersion: "clio.space.github.v1"`, five calculated signals, review context, traversal flags and explicit acquisition gaps. Private checkpoints and normalized evidence are not HTTP fields. No person IDs, raw provider bodies, review content or credentials are returned.

## Signal semantics

Counts are observed events. Empty counts have `no_observations` and `value: null`. Both timing medians require three qualifying human-authored PRs; below that minimum they have `insufficient_samples` and `value: null`. All numeric values have `provisional` status.

**Time to first human review (open to first review)** uses PRs opened in the reporting window whose review traversal completed and whose earliest eligible human non-self review occurred before window end. **PR review time (open to merge)** uses valid human-authored PRs merged in the window, independently of review traversal. Timing includes drafts, author work and queues; it does not measure active review effort.

Traversal flags describe bounded REST acquisition, not complete history or metric coverage. No personal metrics, pooled team scores, product/service attribution or OEMS semantic changes are supplied by this contract. See [source setup and interpretation](providers/connect-space-github.md) for detailed cohorts and limits.

## Errors and replay

Authentication failure returns 401; current member without write permission or untrusted Origin returns 403. Missing workspace access or scoped resource returns 404. Invalid shapes/windows/cursors return 400 or a scoped cursor error; stale revisions, conflicting active work and changed input under an existing request ID return 409. Unavailable identity/config/provider/storage returns a redacted 503. Error responses contain safe codes, never private provider diagnostics.

An uncertain enqueue must replay the same request ID, revision and window. A fresh ID requests new work. Refresh is read-only and does not start acquisition. Explicit disconnect cancels/fences active jobs and preserves history; GitHub App uninstall/revocation remains an operator action.
