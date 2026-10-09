# Terminology

Status: adopted v0.1 working-draft terminology.

| Term | Meaning |
| --- | --- |
| Service | Logical deployable unit and default measurement scope |
| Deployment attempt | Execution that may or may not change production |
| Qualifying deployment | One canonical service rollout at first confirmed production-consumer exposure |
| Rollout group | Canonical rollout identity within a service; subordinate outcomes do not count separately |
| Change | Version-control commit, identified with repository provenance |
| Incident | Confirmed production-impact episode |
| Recovery episode | A service's failure onset and confirmed restoration |
| Classification | Evidence-backed failure or rework assertion |
| Unknown | Required evidence has not established a value |
| Complete collection | Stated sources cover the defined population/window; not proof of flawless incident discovery |
| Snapshot | Results frozen with their period, scope, rule version and evidence cutoff |

A pipeline run, alert, ticket and deployment are separate concepts. No recorded failure means no confirmed failure found in the configured evidence, not proof that no failure occurred.
