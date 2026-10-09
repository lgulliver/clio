# ADR 0003 Application authentication and workspace access

Status: accepted; server and browser foundations implemented
Date: 2026-10-09
Maintainer: Liam Gulliver

## Context and decision

Clio is intended to become a hosted application, with local development first. Liam selected Better Auth with GitHub login initially, PostgreSQL-backed sessions, and explicit workspace membership. GitHub login authenticates a Clio user; it does not authorize provider collection or implicitly grant access to a Clio workspace.

Use Better Auth's server integration, cookie-based sessions with PostgreSQL as the session authority, and server-side authorization for every workspace-scoped API/resource. Keep session cookie caching disabled initially so authorization/revocation does not depend on a stale client cache. Use HttpOnly cookies and Secure cookies under production HTTPS, with explicit trusted origins and the library's callback/CSRF protections. Clear user/workspace query caches when identity changes.

Use a separate GitHub OAuth application for development login and configure its callback to the actual local backend route. Login needs identity/email permissions only; do not request repository collection scopes in the login flow. Provider connection credentials, permissions, storage, revocation, and lifecycle are separate. The application must not reuse a login access token as a collector credential.

Local interactive development uses real login; automated tests use controlled auth/provider mocks. No development login bypass is selected. Missing auth configuration must fail closed for protected routes. Store secrets only in server-side ignored environment configuration; do not commit tokens or expose them through VITE_ variables.

## Consequences and remaining choices

Better Auth avoids hand-written OAuth/session protocols and supports the existing TypeScript/PostgreSQL direction. Its Fastify integration now runs in the selected local backend. GitHub-first login narrows initial sign-in options; generic OIDC, email/password, and additional identity providers can be considered later.

Workspace membership is a Clio authorization boundary, independent from GitHub organisation membership. Bind membership to the stable Clio user ID and GitHub provider identity to its stable account ID, never email or username. Email-addressed invitations require verified ownership of the invited email before acceptance. Do not enable implicit account linking by email; email/username changes must not change membership. ADR 0005 selects the initial role matrix, membership/invitation flows and ownership bootstrap; Clio retains its workspace model instead of enabling the organization plugin. Do not infer a hosted single-user product from local development. The implementation must test cross-workspace access, expired/revoked sessions, logout, invalid callbacks, missing configuration, email/username changes, unverified invitation acceptance, and attempted account-link collisions.

The server foundation pins Better Auth 1.7.7 and uses controlled OAuth/provider mocks for automated checks. Real OAuth application registration, credentials and interactive login remain maintainer setup; deployment is pending. The browser foundation integrates the safe identity and workspace APIs.

## Sources

- https://better-auth.com/docs/authentication/github
- https://better-auth.com/docs/concepts/session-management
- https://better-auth.com/docs/plugins/organization
- https://better-auth.com/docs/integrations/fastify
