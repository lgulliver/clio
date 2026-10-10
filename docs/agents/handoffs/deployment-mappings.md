# Mock deployment mappings handoff

Base: a228e2d914c5e110911e94d03b76a6fa337642a7. Codex backend and frontend specialists wrote isolated codex/deployment-mappings-api and codex/deployment-mappings-web worktrees. Coordinator owns HTTP contract, manifests/lock/docs, serial integration and verification. Coordinator added bigint with a JavaScript-safe revision constraint and PostgreSQL overflow regression; browser imports authoritative OEMS revision.

## Behavior and boundaries

Owners save per-service mock GitHub/Argo CD settings, production environment and explicit mock-only exposure consent. Immutable PostgreSQL revisions retain actor/time; expected revision prevents stale/concurrent overwrites. Members read and preview. Transactions revalidate session, membership and service/workspace scope; origin checks, redacted errors and renewal/no-store handling apply. Migration 0003 is explicit; readiness checks required columns.

Fictional previews run through server-side reconciliation and pinned OEMS calculation after transactions release. Saved settings only, no network or credentials. Unknown exposure and unavailable failure/recovery remain honest; all coverage flags are false. Browser queries/mutations are identity/workspace/service scoped, cancel on unmount and ignore late replies. Draft conflicts require explicit reload; edits/saves clear previews. Actual overview metrics remain unchanged.

## Verification

Specialist API typecheck/13 unit tests/Biome/whitespace passed; its full checks and PostgreSQL execution were blocked by sandbox EPERM. Coordinator full pnpm check passed lint, strict types, 116 OEMS + 70 adapter + 13 API + 91 web tests (290 total), and production build. Coordinator PostgreSQL integration passed 24 tests in random disposable schemas. Frozen install/whitespace passed. No applied migrations changed; development migration 0003 applied explicitly and API restarted without exposing .env values.

Signed-in browser created local Clio mock sandbox / Example service, saved Argo mock revision 1 without consent, observed unknown qualification/count 0, saved revision 2 with mock consent, observed qualifying fictional count 1 with provisional/incomplete coverage. Reload retained settings; selectors stayed ephemeral. Initial independent Claude review found no blocking defects. Coordinator fixes preserve stored microsecond observations, retain read access after edit denial, clarify member conflicts and document actor retention; targeted follow-up reviews cleared fixes, including remounting the editor after edit access disappears; final Claude verdict is ready to commit with no new defects.

## Limits

No live connection, repository/application selector, credential store, durable collection, Argo receiver, persisted preview/result or production deployment. Mock consent cannot authorize live exposure policy. Exact operations are fictional fixture bindings. Revision row deletion is deliberately blocked; future service/workspace deletion needs explicit policy/migration. Actor foreign keys also retain account identity; account deletion/erasure requires an explicit retention/anonymization policy. Specialist worktrees can predate coordinator fixes; committed main is authoritative.
