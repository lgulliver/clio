# Browser identity handoff

Base: aab0292. Codex frontend specialist wrote apps/web in isolated codex/browser-identity worktree; coordinator integrated serially on main and owns API/docs/config changes. Claude independently reviews the frozen source and reported checks.

## Behavior and boundaries

Browser GitHub login/logout uses cookie-backed /api/me and validated unknown JSON, never provider SDK credentials. Workspaces can be created/selected; owners create services and manually shared member invitations, members read services, authenticated users accept invitation tokens. Existing overview/source states retain unavailable measurements. No collector or provider credential workflow is introduced.

Identity checking hides private UI; query caches reset on identity transitions, identity changes detected on focus, visibility transitions and logout. User/revision/workspace keys and mutation guards prevent stale asynchronous results exposing prior data or invitations. Workspace selection and invitation tokens stay in memory. Accessible forms expose loading/error states, owner restrictions and manual token dismissal.

API OAuth failures redirect to configured trusted browser settings with a generic authError flag, discarding private provider errors. Backend package commands load ignored .env when present; exported environment values take precedence. Secrets remain server-only, ignored and untracked; never copied to the writer worktree or review artifacts.

## Verification

Coordinator pnpm check passed: lint, strict typechecks, 116 OEMS tests, 10 API tests, 27 browser tests and production build. Real PostgreSQL integration passed 16 tests after callback changes. Frozen install and whitespace checks passed. Native local API health/readiness and anonymous rejection passed; explicit local migrations succeeded. Real browser completed GitHub sign-in for Clio Local after maintainer consent, returned to authenticated Clio, and created an owner workspace and service. PostgreSQL confirmed persistence; coordinator removed only the exact temporary verification records.

Claude initial review found focus checks erased invitation tokens and drafts; follow-up fixes preserve same-user state during background focus checks, retain acceptance notices, refresh lists after scoped mutations, expose logout retry, and retain keyboard focus while saving. Follow-up review confirmed those fixes with no security defect. Final refinements keep signed-out/error controls stable on focus, release acceptance forms before list refetch completes, and clear acceptance notices on manual selection. Hidden-tab transitions and failed session checks still clear private state immediately; one-time invitation tokens cannot be recovered after such a clear. Live sign-out remained signed out after reload; returning GitHub login succeeded.

Final Claude refinement review found no regressions or security defects; test results and frozen hash verification remain coordinator evidence.

## Limits

No member listing/revocation UI, stored workspace choice, email delivery, collectors, results API or hosting. Reverse-proxy trust and production cookie/hosting policy remain future decisions. Retained writer worktree may predate integrated review fixes; committed main is authoritative.
