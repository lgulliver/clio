# @clio/oems

Platform-neutral integration for OEMS `0.1-draft`, pinned to commit
`5908bb12cdf24e7528088237dff9dca4c10ff45f` of
[lgulliver/oems](https://github.com/lgulliver/oems/tree/5908bb12cdf24e7528088237dff9dca4c10ff45f).
The standard owns normative semantics; this package consumes reconciled snapshots.

## API

```ts
import { calculate, oemsContract, validateSnapshot } from '@clio/oems';

// Inbound JSON is unknown until validated. Snapshot construction belongs to adapters.
const validation = validateSnapshot(inboundJson);
if (!validation.ok) {
  // Each issue has layer, code, path and message. Structural and semantic failures
  // are distinguished; semantic failures preserve upstream error codes.
  handleErrors(validation.errors);
} else {
  const results = calculate(validation.data);
  // One complete MetricResult per service, sorted by service_id.
  // Persist results together with oemsContract.revision.
  persist(results, oemsContract.revision);
}
```

`validateSnapshot(input: unknown)` returns a discriminated `ValidationResult<ValidatedSnapshot>`.
It copies JSON input, checks the pinned dataset schema, then checks relationships,
canonical identity, UTC calendar boundaries and event/observation/cutoff ordering.
Identical duplicate records are deduplicated; conflicting revisions or canonical
aliases are rejected. Input arrays never choose the winning revision.

Successful snapshots expose `data` as deeply readonly, recursively frozen,
deduplicated data. They retain no references to caller objects. `calculate(snapshot)`
requires this validated capability, with a runtime authenticity check as well as
TypeScript checking. Constructor/prototype forgery cannot authorize unchecked input.
Calculations do not mutate snapshots, and each call returns independent results.
Revalidate deserialized snapshots; the capability is process-local, not serializable.

`validateStructure(kind, input: unknown)` returns typed schema-validated JSON for
`dataset`, `service`, `change`, `deployment`, `incident`, `metric-result` or
`event-envelope`. This function checks structure only; its dataset output cannot
be passed directly to `calculate`. An envelope's payload must separately validate
against its `record_type` schema; no envelope ingestion/reconciliation is implemented.
Ajv 8.20.0 uses locally registered draft-2020-12 schemas with ajv-formats 3.0.1 for
mandatory date-time/URI checks. Validation never dereferences evidence URLs.
Ajv compiles schemas at module initialization; browser deployments with a CSP
that forbids dynamic code generation need a future standalone-validator build.

Structural issue paths are JSON pointers. Semantic paths identify the affected
collection/record ID or context field, with slash/tilde escaped as RFC 6901 segments (record IDs are labels, not array indexes). Semantic checks return the first failure;
schema validation reports all discovered schema failures. Non-JSON values, cycles,
non-finite numbers and class instances return structural `invalid_json` errors.

Exported record/result types describe the pinned schemas. `oemsContract` preserves
profile, upstream revision, repository and supported input/calendar profiles.

## Calculations and precision

All five metrics are calculated per service: deployment frequency, change lead
time, change fail rate, deployment rework rate and failed deployment recovery time.
Outputs preserve counts, candidates, nulls, bounds scope, sorted unique quality
reasons, approximate/open/unresolved recovery populations and full measurement
context. Duration units are seconds; ratios are fractions, frequency deployments
per UTC calendar day. Do not average service medians or percentages.

RFC 3339 timestamps support up to six fractional digits. Ordering and differences
use exact bigint microseconds; JavaScript Date only converts whole-second calendar
coordinates. Duration results and medians are JSON numbers, with ordinary floating
point precision for large durations. Original timestamp strings/offsets remain in
snapshot/result context. Reporting windows are half-open UTC whole days. A snapshot
cannot include events after their observation or observations after cutoff.

Coverage assertions are inputs, never inferred from an empty response.
`collection_complete`, `deployment_history_complete` and
`recovery_evidence_complete` apply to every service in one dataset. Emit separate
datasets when coverage differs by service. Validation checks declared evidence,
not whether a provider's coverage assertion is truthful.

## Verification and limits

`pnpm --filter @clio/oems test` checks every vendored valid fixture against all
expected fields, output schemas and record order invariance, every invalid fixture
at its declared layer/error code, plus precision, identity, quality and immutable
snapshot regressions. `pnpm --filter @clio/oems typecheck` checks browser-neutral
runtime source and a separate Node test configuration.

Runtime imports only the seven pinned schemas and platform-neutral TypeScript. JSON imports use standard import attributes; runtime syntax supports native Node 24 TypeScript as well as the browser bundler.
No fs/path, provider SDK, fixture corpus or upstream Python runtime is imported.
Vendored specifications, schemas, fixtures, examples and reference helper are
unchanged upstream materials; see [provenance](vendor/PROVENANCE.md),
[licence](vendor/LICENSE) and [licensing scope](vendor/LICENSING.md).

This package does not collect evidence, select source revisions, prove source
coverage, persist snapshots, provide authentication or establish a conformance
designation. Other calendars, ingestion profiles and p75 are outside this pin.
