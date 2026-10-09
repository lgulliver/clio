# API boundary instructions

Apply the root AGENTS.md and read README.md in this directory, docs/architecture.md and ADRs 0002–0005 before changes.

- Keep configuration, database access and future provider credentials server-side. Node 24 executes native TypeScript; retain explicit .ts imports and erasable syntax.
- Health and the narrowly allowed login/callback/logout endpoints are public. Workspace routes must authenticate through Better Auth and revalidate current sessions and membership inside storage transactions. Explicit workspace IDs alone are not authorization. Never expose the unrestricted Better Auth handler, login tokens or raw session tokens.
- Use parameterized SQL and one checked-out client per transaction. Network/provider calls do not belong inside database transactions.
- Coordinator allocates migration numbers. Never edit applied SQL; add a new migration. Preserve LF and checksums. Migrations run explicitly, not during server startup.
- Keep readiness errors redacted, queries bounded and shutdown orderly. Do not expose database connection strings or raw private payloads.
- Run real PostgreSQL integration checks for storage/migration changes. Tests create and remove only their own random schemas; never delete development volumes or existing schemas.
- Browser authentication integration, jobs, provider collection, snapshots/results and hosting remain separate slices. Keep metric semantics in packages/oems.
