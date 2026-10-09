# Clio API

Local Node 24 TypeScript server with Fastify, node-postgres and PostgreSQL 17. Compose and CI use the same digest-pinned image. Native Node TypeScript execution needs no separate build. This package implements persistence, health checks, GitHub login through Better Auth 1.7.7, and workspace authorization. It has no collection credentials, collectors, jobs or OEMS calculations. The browser shell remains unconnected. Internal workspace repositories require explicit scope; public routes use the separate identity repository, which checks current sessions and memberships in the storage transaction.

## Local setup

From the repository root, using Node 24 LTS and pnpm 12.10.1:

```sh
pnpm install --frozen-lockfile
docker compose up -d --wait postgres
export DATABASE_URL='postgres://clio_dev:clio_dev_password@127.0.0.1:5432/clio_dev'
pnpm --filter @clio/api migrate
pnpm --filter @clio/api dev
```

The Compose credentials are fictional development values. PostgreSQL binds to loopback and uses the named `clio_postgres_dev` volume. `docker compose stop postgres` stops the database while preserving local data. Migration is explicit; API startup never applies SQL. `start` runs without watching. `HOST` defaults to `127.0.0.1`; `PORT` defaults to `3000` and must be 1–65535. `DATABASE_URL` is required server configuration. Never use a `VITE_` variable for it.

`GET /health/live` and `GET /health/ready` are public. Liveness reports process health. Readiness checks connectivity, every expected migration checksum and required table columns. Missing/unavailable database, pending or changed migrations, unknown migration history and missing schema return `503 {"status":"unavailable"}` without database errors or credentials. SIGINT/SIGTERM close the HTTP server and pool. Readiness does not prove data quality, membership or OEMS conformance.

## Persistence and migrations

`src/features/workspaces/repository.ts` creates/reads workspaces and creates/reads/lists workspace-scoped services. UUIDs and names are parsed; SQL values are parameterized. Names are trimmed using ECMAScript whitespace, count Unicode code points, and are stored in normalized form. UUIDs normalize to lowercase. Service names are case-sensitive, unique within each workspace and may recur across workspaces. Foreign keys prevent orphan services. Workspaces have UUID identity, not globally unique display names. `withTransaction(pool, async client => ...)` binds related writes to one client; construct `createRepository(client)` inside it for atomic work. No network calls belong inside these transactions.

`migrations/0001_workspaces_services.sql` is coordinator-allocated. The runner takes a transaction-scoped PostgreSQL advisory lock, applies pending SQL and ledger writes in one transaction, and records SHA-256 checksums. Rerunning unchanged migrations is idempotent. Never edit applied SQL: add a newly allocated migration. Failed SQL rolls back the entire invocation. Migration history must be an ordered prefix of this application's files; unknown/changed applied revisions fail. Migration statements have a 60-second timeout and lock waits a 10-second timeout; API queries retain their separate 5-second timeout. Invalid SQL filenames or duplicate migration numbers fail explicitly. SQL checkouts preserve LF through .gitattributes. No ORM or automatic migration on server start.

## Verification

```sh
pnpm --filter @clio/api typecheck
pnpm --filter @clio/api test
pnpm exec biome check apps/api compose.yaml
```

Integration tests require a reachable PostgreSQL database and a role allowed to create schemas. They never fall back to `DATABASE_URL` and fail visibly without `CLIO_TEST_DATABASE_URL`. Each run creates a random `clio_test_<uuid>` schema, connects with that search path, and drops only its generated schema afterward. No existing schema or volume is deleted. Interrupted tests can leave their own disposable schema behind.

For the local Compose database:

```sh
docker compose up -d --wait postgres
CLIO_TEST_DATABASE_URL='postgres://clio_dev:clio_dev_password@127.0.0.1:5432/clio_dev' pnpm --filter @clio/api test:integration
```

Real PostgreSQL tests cover migration concurrency/idempotency/checksum drift, readiness before/after migrations and schema drift, persistence and workspace isolation, uniqueness/FK/check constraints, transaction commit/rollback and failed DDL rollback. Ordinary tests mock the readiness dependency and check health behavior, redaction, shutdown and configuration parsing. Integration tests are deliberately separate from the ordinary suite. Coordinator must run them plus full `pnpm check` before integrating this foundation.


## GitHub login and server configuration

Authentication is optional only when all five auth values are absent: `AUTH_SECRET`, `AUTH_BASE_URL`, `APP_ORIGIN`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`. Health endpoints remain available; auth and protected routes return `503 {"error":"unavailable"}`. Partial or invalid configuration fails startup. `AUTH_SECRET` must contain at least 32 random characters; generate with `openssl rand -base64 32`. `AUTH_BASE_URL` and `APP_ORIGIN` must be explicit HTTP origins without paths, query strings, credentials or wildcards. Production requires HTTPS for both. These are server-only values, never `VITE_` configuration.

Copy [`.env.example`](.env.example) values into your environment. Native Node does not load `.env` automatically; start with `node --env-file=.env src/main.ts` from this package if using an ignored file. Register a separate development GitHub OAuth application with callback `http://localhost:3000/api/auth/callback/github` when `AUTH_BASE_URL=http://localhost:3000`. No OAuth app registration or real credentials are included. Development login uses real GitHub; there is no bypass or seeded owner.

Better Auth owns OAuth state/callback checks and PostgreSQL session cookies. Login requests only `read:user` and `user:email`. Account linking is disabled; stable provider/account IDs bind identities, while current provider profile updates retain the Clio user ID. Supported account create/update hooks discard access, refresh and ID tokens before SQL storage. Tokens remain transient on the server during OAuth; they cannot be retrieved through this HTTP surface or reused for collection. Cookie and secondary session caching are disabled. Protected requests forward session renewal cookies to the browser. Cookies are HttpOnly, SameSite=Lax, Secure under HTTPS or production. Explicit credentialed CORS allows `APP_ORIGIN`; every custom state-changing route also requires that exact Origin header. Missing/untrusted Origin fails with 403. Server-to-server authentication is not selected.

The public Better Auth bridge allowlists only `POST /api/auth/sign-in/social` (body `{"provider":"github","callbackURL":"http://localhost:5173","disableRedirect":true}`, optional callbackURL/disableRedirect; omitted callbackURL defaults to APP_ORIGIN), `GET /api/auth/callback/github`, `POST /api/auth/sign-out` (empty object), and a redacted `GET /api/auth/error`. Extra sign-in fields, scopes and ID tokens are rejected. No raw session, account-linking, account-listing or OAuth token endpoints are exposed. Callback URLs are constructed against configured `AUTH_BASE_URL`, never Host/forwarded headers. Multiple Set-Cookie headers remain separate. Clio redacts library errors before the underlying router can log private SQL payloads. Direct Fastify socket IP replaces client-supplied IP headers for Better Auth tracking/rate limits; reverse-proxy trust remains a hosting decision. Logout verifies database revocation because the pinned library catches session deletion failures internally. Use `/api/me` for public identity.

## Workspace HTTP contract

All requests below require a real database-backed session. JSON bodies allow only listed fields. Names trim whitespace and contain 1–200 Unicode code points. Workspace/invitation IDs are UUIDs; user IDs remain opaque Better Auth text IDs. All responses use `Cache-Control: no-store`.

| Method/path | Body | Success |
| --- | --- | --- |
| GET /api/me | — | 200 `{user:{id,name,email,emailVerified,image}}` |
| GET /api/workspaces | — | 200 `{workspaces:[{id,name,role}]}` |
| POST /api/workspaces | `{name}` | 201 `{workspace:{id,name,role:"owner"}}` |
| GET /api/workspaces/:workspaceId/services | — | 200 `{services:[{id,workspaceId,name}]}` |
| POST /api/workspaces/:workspaceId/services | `{name}` | 201 `{service:{id,workspaceId,name}}` |
| POST /api/workspaces/:workspaceId/invitations | `{email}` | 201 `{invitation:{id,workspaceId,email,expiresAt,token}}` |
| DELETE /api/workspaces/:workspaceId/invitations/:invitationId | — | 204 |
| POST /api/workspace-invitations/accept | `{token}` | 200 `{workspaceId}` |
| DELETE /api/workspaces/:workspaceId/members/:userId | — | 204 |

Any authenticated GitHub user can create a workspace; its owner membership is inserted atomically. Owners and members read services. Owners create services, invite and revoke. No client-supplied role/user ID authorizes access. No owner promotion/transfer, workspace deletion or member list API is selected. Last owner removal returns 409.

Invitations grant member only, expire after seven days, and store only SHA-256 hashes of random 256-bit tokens. The creation response returns the manually shareable token once; there is no invitation list or email/notification service. Acceptance checks the current database user has a verified matching email (case-insensitive), consumes the invitation and creates membership in one transaction. Replay, expired/cancelled invitations and wrong/unverified identities return the same scoped denial. Accepting an invite for an existing owner does not downgrade their role.

Membership writes serialize on the workspace row. Session existence/expiry and current database user are checked and locked inside every identity storage transaction; membership checks participate in that transaction. Revocation affects the next request and cancels outstanding invitations addressed to the target's current email in that workspace. A later explicit invitation can grant access again; this is not a permanent user ban. Invitations to historical email addresses remain email grants, so ownership migration/account-email policy must be considered before hosted use. Health readiness additionally verifies core auth, membership and invitation columns from migration `0002_identity.sql`. Existing workspaces receive no implicit membership; ownership migration for pre-existing data is not part of this slice.

Errors are redacted: 400 `{error:"invalid_request"}`, 401 `{error:"unauthorized"}`, 403 `{error:"forbidden"}`, 404 `{error:"not_found"}` for missing/non-member workspace scope or invalid invitation acceptance, 409 `{error:"last_owner"}` / `{error:"conflict"}`, 413/415 `{error:"invalid_request"}` for oversized/unsupported bodies, 503 `{error:"unavailable"}` for dependencies or absent auth. An owner attempting to cancel an already cancelled/consumed invitation receives 404. A returning GitHub account whose new email conflicts with another Clio user fails closed with redacted 409; stable accounts/memberships are not merged. Correct the provider email before retrying. No SQL, OAuth token, session token or connection string appears in custom responses or logs.

## Identity verification

Ordinary tests cover optional/partial/production configuration, unavailable routes, exact Origin/CORS, sign-in scope escalation, endpoint allowlist, cookie/status forwarding, safe identity JSON and failure redaction. The PostgreSQL suite runs actual Better Auth handlers against controlled GitHub fetch responses, schema mapping, account creation/update token discard, stable account/user IDs, account-link collision, state-cookie binding, redirect rejection, DB session expiry/revocation/logout, atomic workspace creation, transaction-bound membership revocation, owner/member permissions, cross-workspace reads/writes, hashed invitations, wrong/unverified emails, cancellation, expiry and concurrent single-use acceptance. No live provider calls are made in tests.

Better Auth organization plugin was reviewed and remains disabled: its organization/member/invitation tables and organization deletion/role editing endpoints exceed the selected Clio workspace lifecycle. Revisit only with an explicit migration and role policy. Sources reviewed: [Fastify integration](https://better-auth.com/docs/integrations/fastify), [GitHub](https://better-auth.com/docs/authentication/github), [sessions](https://better-auth.com/docs/concepts/session-management), [accounts](https://better-auth.com/docs/concepts/users-accounts), [organization plugin](https://better-auth.com/docs/plugins/organization), plus installed 1.7.7 schema, account hooks, session/logout and GitHub provider source.
