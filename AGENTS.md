# Clio agent instructions

Clio is an engineering-delivery application and an intended OEMS implementation. Liam Gulliver is the sole maintainer. Read README.md, docs/architecture.md and the relevant scoped AGENTS.md before changing an area. OEMS owns the standard; this repository owns application behaviour.

## Stack and structure

- Use TypeScript, React, Vite, TanStack Router/Query and Tailwind. Package versions are exact and pnpm-lock.yaml is committed.
- apps/web owns browser UI. packages/oems owns the integration boundary with the pinned standard. packages/adapters is reserved for server-side collection; packages/typescript-config owns shared compiler policy.
- Keep future features together under src/features/<feature>; promote code to a shared package only when there is a real shared boundary.
- Use pnpm with the version in packageManager and Node 24 LTS. Do not introduce npm/yarn lockfiles, another formatter or a second build system.

## Implementation contract

- Preserve strict typing. Do not add any, suppression comments or unsafe assertions to hide errors. Parse external data from unknown at the boundary.
- Keep provider credentials and private collection payloads server-side. VITE_ environment values are public browser configuration.
- Keep provider collection, evidence reconciliation, OEMS validation/calculation and presentation separate. Do not turn missing evidence into zero or claim complete coverage from an empty response.
- Keep UI accessible: semantic controls, keyboard navigation, visible focus, honest empty/error states. Do not invent data or show developer/tooling details as product features.
- Generated routeTree.gen.ts is committed for cold-clone type checks but is produced by the router plugin; never edit it manually.
- Never select Clio's licence, publish packages, deploy or add paid/external services just because the repository is public.

## Verification and delivery

- Use Conventional Commits for every commit, for example feat(web): add workspace navigation or fix(ci): repair dependency caching.
- Before committing, run pnpm check and git diff --check. When a route changes, run pnpm build to regenerate the route tree, then run the checks.
- Add tests for meaningful behaviour and regressions. Avoid tests that only repeat constants or implementation details.
- Report the behaviour changed, affected boundaries, checks actually run and remaining limitations. Do not claim a collector, conformance or production deployment exists before it does.
- Maintain the OEMS revision explicitly. Normative metric changes belong in the OEMS repository under its decision process; do not silently fork those semantics in Clio.
