# ADR 0005 Workspace identity foundation

Status: implemented in server and browser foundations
Date: 2026-10-09
Maintainer: Liam Gulliver

## Context and decision

ADR 0003 selects Better Auth with GitHub login, PostgreSQL-backed sessions and explicit workspace membership. ADR 0004 establishes Fastify, node-postgres and UUID workspaces. This task selects the application authorization policy needed to connect those boundaries. These are scoped coordinator selections, not pre-existing maintainer decisions.

Pin Better Auth 1.7.7 and integrate its server handler under /api/auth. PostgreSQL is the session authority, with cookie caching and secondary session caches disabled. Forward renewed session cookies on protected requests. Expose only the login/callback/logout handler routes needed by this slice; use /api/me for safe public identity and block provider-token/account-linking endpoints. Reject client-supplied extra scopes or token-based sign-in overrides. Use explicit server base URL and trusted browser origin; default omitted login callback URLs to the browser origin. Direct Fastify socket IP supplies the only trusted IP header for library tracking/rate limits; reverse-proxy trust remains a hosting decision. Preserve Better Auth's callback/state and origin/CSRF protections. Login uses GitHub identity/email scopes only. Implicit account linking by email is disabled. Login OAuth tokens are transient and server-side. Discard access, refresh and ID tokens after provider identity retrieval through supported account creation/update hooks rather than storing credentials the application does not need. Retain the provider and stable account ID. Tokens are never collection credentials or public API fields. Route library failures through Clio's redacted error boundary before router fallback logging. A returning provider identity with an email uniqueness conflict fails closed without merging accounts or memberships. OAuth callback failures redirect to the configured browser settings page with a generic authError flag; private provider errors are not forwarded.

Review the organization plugin but retain Clio's existing workspace/service schema and implement application membership relationally. The plugin would add a second organization identity/model and expose a larger role/organization API than this bounded slice needs. Better Auth still owns authentication and session protocols; Clio owns workspace authorization. Revisit the plugin if its lifecycle features justify an explicit migration.

## Workspace policy

Any authenticated GitHub user can create a workspace and becomes its owner in the same database transaction. There is no environment-driven default owner, email allowlist, development login bypass or implicit access through a GitHub organization.

Initial roles are owner and member. Both can read workspace services. Owners can create services, issue member invitations and revoke other members. This slice does not expose owner promotion, ownership transfer, workspace deletion or arbitrary role editing. The sole owner cannot be removed. All membership keys reference the stable Clio user ID; display name, email and GitHub username are not authorization keys.

Invitations grant member access only. An owner receives a manually shareable invitation token; no email/notification service is selected. Store only a cryptographic token hash, with a bounded expiry and single-use/cancellation state. Acceptance requires an authenticated user whose currently verified email matches the addressed invitation. Acquire membership and consume the invitation atomically. Prevent replay, expiry, cross-workspace owner actions and acceptance by unverified or different identities. Revoking membership must affect the next authorized request and cancel pending invitations addressed to that user's current email within the workspace. A later explicit invitation may grant access again. Invitations remain email-addressed grants; historical email ownership is not a permanent identity ban.

Protected reads and writes require a database-validated session and current workspace membership. A chosen workspace ID or client role never authorizes access. Check membership in the storage operation/transaction rather than authorizing a disconnected write. Browser state-changing operations require the explicit trusted Origin; cookie-based authentication alone does not prevent CSRF.

## Configuration and limits

OAuth application registration and real credentials remain maintainer actions. Local login uses a separate development GitHub OAuth application. Missing auth configuration fails closed for protected routes; health endpoints remain useful. Partial or invalid configuration fails explicitly. Production requires HTTPS and Secure HttpOnly cookies, with exact trusted origins. Secrets stay in ignored server configuration, outside VITE_ values and logs.

The browser now implements login/logout, workspace/service workflows and manual invitation creation/acceptance. Identity checks hide private UI and clear identity/workspace caches; revisions and scope checks reject stale asynchronous results. Member-list/revocation UI is not implemented because that API is outside the selected initial surface. Provider credential storage/revocation and GitHub collection access remain separate decisions; this task does not introduce PATs, repository scopes, collectors or hosted deployment.

## Sources

- https://better-auth.com/docs/integrations/fastify
- https://better-auth.com/docs/concepts/session-management
- https://better-auth.com/docs/concepts/users-accounts
- https://better-auth.com/docs/plugins/organization
