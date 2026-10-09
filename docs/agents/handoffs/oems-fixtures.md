# OEMS fixture implementation handoff

Base: 502bd1423dfba2300454ab37321f17e9f8e38ab6. Integration follows the backend foundation commit.
Implementation: Codex OEMS specialist in agent/oems-fixtures, with coordinator integration corrections.
Pin: 5908bb12cdf24e7528088237dff9dca4c10ff45f, unchanged.

## Delivered boundary

packages/oems now exports schema validation, semantic snapshot validation, immutable validated snapshots and all five per-service metric calculations. Calculations require a process-local validated capability; input/output mutations cannot alter validated evidence. Record ordering does not select revisions. UTC half-open whole-day windows, exact microsecond ordering, original context, counts/candidates, null values, observed bounds and sorted provisional reasons follow the pinned standard.

Seven schemas and the upstream fixture/specification/reference/licensing corpus are vendored at the pin. Coordinator checked all 119 upstream files byte-for-byte using git show at that revision. Local provenance and formatting metadata are separate. No upstream files or normative semantics were changed.

## Verification and review

Tests compare all fields for 32 valid fixtures (33 service results), reverse record collections, reject all 29 invalid cases at the declared layer/semantic error code, and exercise precision, identity, multi-service coverage, immutable input/output and forged capabilities. A native Node subprocess compares the complete fixture result; JSON import attributes and erasable syntax support the selected backend runtime. A separate browser bundle verifies the platform-neutral runtime without importing Node test fixtures.

Coordinator runs full pnpm check and git diff --check after integration, reconciles the lockfile and verifies frozen installation. Backend PostgreSQL integration remains a separate check. Claude independently reviewed actual runtime and tests against the pinned specification/reference; first review found no high-or-critical runtime defect and requested refreshed evidence after coordinator corrections. Final Claude review of the frozen integrated runtime found no medium-or-higher defects and verified the prior corrections. Four additional semantic rejection regressions were added from its test-coverage suggestions; runtime source did not change afterward.

## Remaining limits

This is reconciled-snapshot fixture implementation, not provider collection, revision selection, source-coverage proof, persisted snapshots/results or a conformance designation. Dataset-level coverage applies to every declared service; differing coverage requires separate datasets. Results need the OEMS revision recorded alongside them by future persistence. Native capability must be reissued by validation after deserialization.

Schema/result TypeScript types were derived from the pinned schemas during implementation; pin updates must review and regenerate those types as well as fixtures/specs. Schema validation reports all errors and metric calculation follows the reference's straightforward population scans; request size/CPU limits belong to the future result API. Ajv runtime compilation uses dynamic code generation; a strict browser CSP requires standalone validators before deploying calculation in that browser context. Duration JSON numbers retain normal floating-point limits for very large intervals.

Browser compatibility is an explicit manual gate when OEMS runtime changes, separate from pnpm check. Run from repository root:

```sh
pnpm --filter @clio/web exec vite build --config "$PWD/packages/oems/test/browser.config.ts"
```

This reuses the web package's Vite tooling; it is not a publishing pipeline. Its temporary output is a verification artifact. Native Node compatibility remains an automated subprocess regression in pnpm check. Final local verification passed 116 OEMS tests, 3 API tests and 4 web tests, plus 7 PostgreSQL integration tests.
