# SPACE Foundation Implementation Plan

> **For agentic workers:** Use the repository's bounded sequential specialist workflow. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Deliver confidential team pulse surveys with owner setup, member responses, protected question results and descriptive trends.

**Architecture:** PostgreSQL owns current primary-team assignments and immutable pulse cohorts. Existing authorized workspace transactions serialize lifecycle, membership and response admission. SPACE remains an application contract separate from OEMS; browser transport validates unknown responses and uses existing session-revision and query-abort fences.

**Tech Stack:** Node 24, TypeScript, Fastify, PostgreSQL, React, TanStack Router/Query, Tailwind, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-13-space-foundation-design.md` (approved 2026-10-13).

## Global Constraints

- Contract `clio.space.pulse.v1`; original eight questions and nullable integer answers 1–5.
- Minimum 3–1000, default 3; freeze at opening with reference period, instrument and exact roster.
- Below-minimum question counts, including zero, always suppressed with no exact count.
- No composite score, person-level results, free text, product/service subdivision or external notifications.
- No new dependencies, provider changes or OEMS changes. Allocate migration `0015_space.sql`.
- Concurrent writers require separate CLI worktrees. API writer uses the authorized main checkout; a concurrent Claude web writer uses an isolated managed worktree based on 3c022d3. Coordinator alone integrates, commits and pushes.

## Review Focus

- Changed-body response retry must not replace, echo or compare previously accepted answers.
- Membership removal/rejoin must follow stable user ID, never email.
- Shared participants across different teams must reject overlapping reference periods.
- Closed and cancelled storage must contain no raw answers, including suppressed questions.
- Late browser reads/writes after workspace, role or session changes must not display stale private state.

## Task 1: Server contract, lifecycle and confidentiality

**Owner:** backend specialist, sequential writes; coordinator allocates migration 0015.

**Files:** Create `apps/api/src/features/space/{contract,input,repository,routes}.ts`, unit tests and `apps/api/tests/space.integration.ts`; create `apps/api/migrations/0015_space.sql`; modify migration readiness, identity route registration and organization team deletion. Write exact safe HTTP contract in `docs/space-api.md` for Task 2.

**Interfaces:** `registerSpaceRoutes(server, {pool, actor})`; all endpoints under `/api/workspaces/:workspaceId/space`. Preferences GET/PATCH; assignment management and own history; bounded pulse list/detail/create/update and explicit open/close/cancel; response POST. Actor/session/current role derive server-side. Each pulse DTO carries workspace/original team IDs, copied name, instrument, reference bounds, state, minimum, roster size, own eligible/submitted flags, permitted total submitted count and protected closed questions. No roster IDs or raw answers in any DTO.

- [x] Write instrument/input/aggregation tests first. Pin all-null and two-answer results to identical suppressed representations; reject missing/extra keys, fractional/out-of-scale values, future or invalid UTC periods.

```ts
expect(aggregateQuestion([null, null, null], 3)).toEqual({status: 'suppressed', mean: null});
expect(aggregateQuestion([1, 5, null], 3)).toEqual({status: 'suppressed', mean: null});
expect(aggregateQuestion([1, 5, 3], 3)).toEqual({status: 'published', mean: 3, answeredCount: 3});
```

- [x] Run focused API tests and observe failure before implementation; implement versioned instrument, strict inputs and pure aggregation.
- [x] Add migration with workspace-scoped current assignment constraints, assignment audit history, private frozen roster, unlinked random answer rows, unique receipts and protected immutable results. Preserve archived team context after deletion.
- [x] Implement authorized repositories/routes. Validate body but check accepted receipts before changing any stored answer. Close/cancel purge raw answers in their transaction; prohibit open aggregates. Restrict draft reads to owners. Read current role each request.
- [x] Add PostgreSQL cases for all Review Focus server items plus owner/member/outsider/session scopes, preferences freeze, one-open-per-team, empty roster, per-question skips, archived deletion and draft/open deletion refusal, concurrent duplicate/close admission, pagination and no raw disclosure.
- [x] Run `pnpm --filter @clio/api test`, API typecheck and real PostgreSQL tests with the documented test database URL. Review actual changed files with Claude; fix blocking findings before Task 2.

## Task 2: Developer experience workflow

**Owner:** Claude web implementer in `/home/lgulliver/.codex/worktrees/space-pulse-web/clio`, after Task 1 wire contract was fixed.

**Files:** Create `apps/web/src/features/space/{api,space-page,pulse-wizard,pulse-response,pulse-results,trends}.ts[x]` and behavior tests; create `apps/web/src/routes/developer-experience.tsx`; modify `apps/web/src/components/app-shell.tsx`; regenerate route tree through Vite.

**Interfaces:** Consume `docs/space-api.md` exactly; parse all private responses from unknown, verify requested workspace/pulse identity. Reuse `request`, `useSession`, `useStoredRead`, workspace list and organization reads. Session revision, workspace and current role fence all mutations and abandoned queries.

- [x] Write failing tests for strict safe DTO parsing, suppression (including zero), incompatible trend contexts and gap continuity.
- [x] Implement parser/types and pure trend grouping: team/instrument/question/scale/reference length define series; only adjacent chronological published periods join; never interpolate suppressed/open/cancelled periods.
- [x] Write interaction tests for owner wizard stages, roster assignment/preferences, nullable response confirmation, submission retry and frozen context, closed result privacy and archive pagination.
- [x] Implement accessible workspace/team selectors, owner setup wizard, private own assignment history, eight-item response form and explicit close/cancel confirmations. Retain member-safe visibility; don't show raw or named response state.
- [x] Add dimension-grouped question results and reference-time trends with safe point context. Engineering shows teams separately; no combined score.
- [x] Add cancellation/session/access-loss tests: delayed completion after workspace/account changes stays hidden, role loss removes owner controls, server denial clears private detail. Test keyboard labels and semantic controls through jsdom. Browser visual verification remains unavailable under current browser policy.
- [x] Run focused web tests, `pnpm build` and web typecheck. Claude reviews actual UI changes against approved spec and HTTP contract.

## Task 3: Documentation and verified delivery

**Owner:** coordinator.

**Files:** Add `docs/space-getting-started.md`; update README, architecture and approved spec implementation status. Update plan checkboxes only after observed completion.

- [x] Document real sign-in/workspace prerequisites, owner roster assignments, minimum, manual pulse lifecycle, member response, per-question suppression, immutable archived context and confidentiality limits. No demo invitations or automatic real pulses.
- [x] Run `pnpm check`, `git diff --check` and full real PostgreSQL integration suite; capture actual outcomes in ignored review artifacts.
- [x] Final opposite-engine review of integrated source. Apply migration explicitly to development database once reviewed, preserving existing data; confirm API readiness through local health requests.

**Release action:** Commit with Conventional Commits and push authorized main after the completed implementation and verification gates. Report observed checks and remaining operational/visual limitations; the release commit is recorded in Git history.

## Verification record

API source and SQL received Claude review; Claude frontend received independent Codex review. All four UI findings were fixed and the bounded fix diff re-reviewed as addressed. The coordinator observed real PostgreSQL coverage (196 tests), server/browser instrument and aggregation parity (4 tests), and integrated SPACE/routing behavior (69 tests). Final `pnpm check` passed: 1,346 tests (116 OEMS, 309 adapters, 699 web, 222 API), type checks, lint and production build. The bounded final integration review reported no blocking defects. Both staged and working-tree whitespace checks passed. Migration 0015 was applied explicitly to the documented loopback development database; reloading the API restored readiness HTTP 200. No real pulses, responses or invitations were created automatically. Browser visual and assistive-technology acceptance remain unverified under the current browser policy.
