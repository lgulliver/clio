# Identity foundation handoff

Base: 32cf47b. Implementation: Codex CLI in isolated codex/identity-foundation worktree; coordinator integrates on main. Independent review uses Claude against the frozen diff and reported checks.

## Behavior and boundaries

Better Auth 1.7.7 handles GitHub OAuth and PostgreSQL sessions. Clio owns workspace membership, owner/member authorization and manually shared invitations. Auth transport allows only sign-in, callback, logout and a redacted error response. /api/me returns safe identity, never session tokens. Login requests identity/email scopes; supported account hooks discard OAuth tokens after provider lookup. Account linking and cookie caching are disabled. Exact trusted Origin is mandatory for state-changing cookie requests; production requires HTTPS and Secure HttpOnly cookies. All auth values absent leaves health available and protected routes unavailable; partial configuration fails startup.

Migration 0002 adds mapped auth models, stable user/provider account identities, memberships and hashed single-use seven-day invitations. Workspace creation and owner membership are atomic. Session/current-user checks and membership authorization happen inside repository transactions; revocation affects subsequent requests and cancels outstanding invitations to the target's current email in that workspace. Session cookie renewal is forwarded. Library failures bypass default raw error logging and reach Clio's redacted boundary. Callback URLs default to the browser origin; socket IP overrides untrusted client headers. Member invitations require current verified matching email. Existing workspaces receive no implicit ownership. ADR 0005 records bounded coordinator policy selections, rather than attributing them to an earlier maintainer decision.

## Verification

Coordinator ran pnpm check successfully after integration: lint, strict type checks, 116 OEMS tests, 10 API tests, 4 browser tests and production browser build. Real PostgreSQL suite passed all 16 tests, including controlled GitHub OAuth callbacks, state binding, token discard, stable identity, account collisions, session expiry/renewal/revocation/logout, returning-account email conflicts, atomic bootstrap, scoped permissions and invitation races. Native Node 24 HTTP smoke passed explicit migration, live/readiness, anonymous rejection, GitHub sign-in/state cookie and graceful SIGTERM. Frozen-lockfile installation and git diff --check passed. Claude independently reviewed actual source and pinned dependency behavior; four initial low defects were fixed and the final review found no remaining defects. Tests remain coordinator evidence; the reviewer did not rerun them.

## Remaining limits

No real OAuth app registration or credentials, interactive GitHub login, browser identity workflow, provider collection credentials, collectors, jobs, persisted OEMS results or hosted deployment. No email/notification service, member-list API, owner promotion/transfer or workspace deletion. Later frontend work must clear identity/workspace query caches on identity changes. Existing data ownership migration needs an explicit policy. CLI transcripts remain ignored under .agent-runs; main is the integrated authority, and retained source worktree may predate review fixes.
