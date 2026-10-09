# OEMS v0.1 overview

Status: adopted v0.1 working-draft contract. MUST, SHOULD and MAY express requirement strength in this draft; there is no stable released standard. RFC 0002 records the decisions and migration.

## Scope

This draft describes service-level production delivery records and an OEMS DORA measurement profile for reconciled snapshots and UTC whole-day windows. It defines data meanings, missing-data behaviour and reproducible calculations. It does not define an ingestion HTTP API.

Read [terminology](terminology.md), [the canonical model](canonical-data-model.md), [the event envelope](event-envelope.md) and [measurement rules](measurement-rules.md) before the individual metric definitions.

## Metric definitions

- [Deployment frequency](metrics/deployment-frequency.md)
- [Change lead time](metrics/change-lead-time.md)
- [Change fail rate](metrics/change-fail-rate.md)
- [Failed deployment recovery time](metrics/failed-deployment-recovery-time.md)
- [Deployment rework rate](metrics/deployment-rework-rate.md)

Research framing: [DORA's current five metrics](https://dora.dev/guides/dora-metrics/). Statistics, record shapes and timestamps specified here are OEMS draft policy choices.

## Compliance boundary

JSON Schema validates record shape. Semantic validation establishes meaningful relationships and valid timestamp ordering. Metric cases check expected calculations. Passing one layer does not establish the others.

No conformance designation or badge is authorised by this draft. Implementations should describe the exact draft commit and cases checked rather than claiming certification.
