# Contributing

Liam Gulliver is the sole maintainer. Repository changes can progress directly with a documented rationale; there is no committee or second-maintainer approval requirement. Architecture decisions belong in docs/decisions; normative standard changes belong in OEMS.

Read AGENTS.md and scoped instructions before implementation. Use Node/pnpm versions from .node-version and packageManager. Install with pnpm install --frozen-lockfile; do not create another lockfile. Exact direct versions and the lockfile make dependency upgrades deliberate.

Use Conventional Commits, including optional scopes: feat(web): add a service page, fix(oems): preserve cutoff metadata, or chore(deps): update Vite. Keep every commit independently reviewable.

Run pnpm check and git diff --check before committing. Route changes must regenerate src/routeTree.gen.ts with pnpm build or pnpm dev. Commit the generated file; CI verifies generation does not leave a diff.

Write tests for behaviour and regressions, not repeated constants. Production UI must distinguish missing evidence, provisional results and complete measurements. Use only fictional data in fixtures; never commit tokens or private source payloads.

Clio licensing remains undecided. Do not import upstream code without reviewing its licence and retaining required attribution.
