# Clio agent team

Clio is a personal open source project, independent of MaxContact. Liam Gulliver is sole maintainer and final product decision-maker. Agents are development specialists, not additional maintainers.

## Roles

| Shared role | Codex agent | Claude agent | Responsibility |
| --- | --- | --- | --- |
| coordinator | clio_coordinator | clio-coordinator | Scope, dependency order, contracts, integration |
| backend | clio_backend | clio-backend | Server, PostgreSQL, migrations, jobs |
| identity | clio_identity | clio-identity | Login, sessions, workspace authorization, credentials |
| oems | clio_oems | clio-oems | Pinned validation, calculations, fixture verification |
| providers | clio_providers | clio-providers | Collection, evidence mapping, reconciliation, coverage |
| frontend | clio_frontend | clio-frontend | Accessible application flows and metric presentation |
| reviewer | clio_reviewer | clio-reviewer | Independent correctness/security/contract review |

Role behavior lives in roles/*.md. Native definitions are thin pointers to these shared briefs. Models inherit the selected session settings; setup does not prescribe a paid tier or override user model preferences.

## Operating contract

- One coordinator owns the active milestone. A specialist receives a complete task brief using task-template.md; native subagents do not necessarily inherit conversation history.
- Keep at most three specialists active across both engines combined. Delegate ready, independent tasks. Sequential work is preferable when dependencies or shared files overlap.
- Every concurrent writer runs as a separate CLI session started inside its own worktree, with an assigned path scope. Native subagents are limited to read-only work or sequential writes in the parent checkout. Naming a worktree in a prompt does not change a native subagent's working directory or sandbox. Worktrees isolate files, not contract conflicts; agree shared interfaces first. Readers may share a stable checkout.
- Coordinator owns root package/workspace manifests, lockfile, CI, API contract coordination, and migration numbering unless assigned explicitly. Integrate one slice at a time and recheck after integration.
- Codex implements / Claude reviews, or Claude implements / Codex reviews. Roles are engine-neutral. Review is evidence about the diff, not a committee approval or a conformance claim.
- Native Codex agents are Codex; native Claude agents are Claude. Cross-engine tasks run through the other installed CLI. Written configuration does not start background workers or create a persistent mixed-engine swarm.
- Retain normal CLI permissions. Do not use --dangerously-skip-permissions or --dangerously-bypass-approvals-and-sandbox. If a headless run cannot obtain needed permissions, record the failure and rerun interactively with the required permission.
- Agent transcripts may contain private context: keep them in ignored .agent-runs/. Commit task decisions and concise handoffs, not raw transcripts or tokens.
- Specialists leave reviewable changes. Coordinator verifies, reviews, and commits with Conventional Commits; do not push, publish, deploy, choose a licence, or add paid/external services without relevant authorization.

## Start from the repository root

Codex coordinator:

```sh
codex "Read docs/agents/team.md and docs/agents/roles/coordinator.md. Act as Clio coordinator. Use named specialists for ready tasks in docs/agents/first-milestone.md; use Claude CLI for independent review. Start with a bounded backend foundation brief and OEMS fixture implementation brief."
```

Claude coordinator:

```sh
claude --agent clio-coordinator "Read docs/agents/first-milestone.md. Coordinate the next bounded milestone using project specialists and Codex CLI for independent review."
```

Within Codex, ask for a named custom agent explicitly for read-only work or a sequential slice, for example: "Spawn clio_oems to review this fixture contract; give it the exact OEMS checkout." Codex discovers .codex/agents/*.toml. Within Claude, delegate to the matching clio-* project agent under the same sequential/read-only restriction. For concurrent implementation, start separate Codex or Claude CLI sessions inside assigned worktrees and pass the role/task brief explicitly. Confirm the active CLI has loaded project configuration; Codex requires project trust. CLI config discovery does not prove the current desktop chat has reloaded agents.

## Cross-engine review

The coordinator supplies base revision, changed paths, acceptance criteria, and reported checks. The review must inspect actual files, not only the builder's summary.

Claude review of a Codex-authored working tree (run in the target checkout/worktree):

```sh
mkdir -p .agent-runs
claude --agent clio-reviewer --tools Read,Glob,Grep --strict-mcp-config --mcp-config '{"mcpServers":{}}' -p "Read docs/agents/team.md and docs/agents/roles/reviewer.md. Review the supplied task brief and changed files. Do not edit files. The coordinator must provide the precise base/diff and checks before you can conclude." > .agent-runs/claude-review.txt
```

The Read/Glob/Grep restriction prevents this review from running git or tests. Supply a diff artifact and task/handoff paths in the prompt before dispatch; the coordinator creates the artifact with git diff against the task's actual base. All reported test outcomes remain builder/coordinator evidence unless independently rerun.

Codex review of a Claude-authored tree (run in the target checkout/worktree):

```sh
codex exec --sandbox read-only "Read docs/agents/team.md, docs/agents/roles/reviewer.md, and the supplied task brief. Review the actual diff against the coordinator-supplied base. Do not edit files. Report actionable findings and unverified checks."
```

These are dispatch patterns, not ready-to-run reviews of an unspecified task. Substitute concrete brief/diff paths and base revision in each prompt. Headless runs use existing CLI authentication and consume account usage; login remains the user's normal local CLI workflow.

## Worktree discipline

Start from a clean committed base so both engines can read the same agent definitions. Coordinator creates task worktrees through the host's worktree tooling, then starts the target CLI inside the assigned worktree. Do not dispatch concurrent native writers from a shared parent checkout. Before each writer starts, verify its actual working directory and write permissions against the assigned worktree. Native subagents do not automatically have an isolated checkout. Claude agent-team behavior can differ from ordinary subagents; verify the actual working directory before writing. Avoid automatic worktree removal until patches/commits and handoffs are integrated.

## References

Native formats verified against installed Codex CLI 0.162.0 and Claude Code 2.1.286 help plus official documentation on 2026-10-09. Recheck discovery/configuration when upgrading.

- https://developers.openai.com/codex/subagents/
- https://developers.openai.com/codex/config-reference/
- https://code.claude.com/docs/en/sub-agents
