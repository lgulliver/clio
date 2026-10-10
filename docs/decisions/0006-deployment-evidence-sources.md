# ADR 0006 Deployment evidence sources

Status: accepted source choices; mocked adapter foundation implemented
Date: 2026-10-10
Maintainer: Liam Gulliver

## Decision and boundary

Liam confirmed configurable source mappings and mocked evidence for now because no live deployment sources are set up. No registration, installation or live collection is required in this slice.

Liam selected a separate GitHub App for collection and GitHub Deployments as the first deployment source, with explicitly selected production environments. He also requires GitOps deployment tracking, including Argo CD. GitHub login remains identity-only; its OAuth token is never reused for collection.

Deployment sources and repository/change sources are separate service mappings. A service may take rollout evidence from Argo CD and change evidence from GitHub. A GitOps repository revision identifies configuration provenance; it does not establish the application-source commit represented by an image. Artifact provenance or an explicit verified mapping is required before linking those identities.

Start with one authoritative deployment source per service. Corroborating observations from another source require explicit shared rollout correlation. Revision SHA, environment name and timestamp proximity do not prove rollout identity. Repeated deployments of the same SHA, rollbacks, self-healing and regional rollout steps must not be silently merged or counted as separate production changes without the relevant evidence. Canonical rollout identity and classification remain governed by the pinned OEMS standard.

## Production exposure

Selecting a production environment establishes scope. It does not prove consumer exposure. GitHub deployment requests, successful workflow runs, Argo CD reconciliation and resource health have different meanings.

GitHub status evidence can qualify only under an explicit, versioned service policy stating that a trusted success signal records production-consumer exposure. Preserve the earliest accepted exposure and every relevant status; later failure or inactivity cannot erase an earlier rollout. Status-specific environments matter because a deployment status may change environment. Do not filter collection solely by the deployment's current environment and lose promotions.

Argo CD evidence retains instance/application/operation identity, reconciled revision, health and observation time. Successful reconciliation plus healthy resources is insufficient without the selected service's exposure policy. Current application state cannot reconstruct complete rollout history. Repeated notification delivery must deduplicate without treating revision SHA as universal operation identity.

Without exposure evidence, retain unknown qualification and missing effective time. Pipeline failures and degraded health do not establish production incident causality; success does not establish absence of failure. Failure, rework and recovery remain unknown or unavailable until their evidence contracts are implemented.

## Credentials and local implementation

Use GitHub App installation access tokens, restricted to selected repositories with read-only Deployments permissions and mandatory metadata. App signing material stays server-side. Short-lived installation tokens remain in memory; neither private keys nor provider tokens enter browser configuration, application identity or committed payloads. Installation ownership and workspace authorization must be established by the API before an adapter is invoked; possessing an installation ID is not authorization.

The first bounded adapter slice uses injected transports and fictional fixtures. It includes GitHub token/collection helpers, provider-neutral reconciliation and a narrow Argo CD evidence parser. It does not add a live Argo CD client, HTTP notification receiver, collection UI, persistent connection credentials, durable jobs or stored snapshots/results. Those require their own authenticated API/storage boundaries. Argo CD credentials and notification authentication remain unselected.

Declare transport completeness separately from metric coverage. Initial OEMS collection, deployment-history and recovery-evidence flags remain false. Empty responses do not establish complete history. Preserve trusted observation times; later-observed evidence cannot enter an earlier cutoff snapshot. Reconciliation never chooses truth from array order or arrival order.

## References

- [GitHub deployments](https://docs.github.com/en/rest/deployments/deployments?apiVersion=2026-03-10)
- [GitHub deployment statuses](https://docs.github.com/en/rest/deployments/statuses?apiVersion=2026-03-10)
- [GitHub App installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [Argo CD notification triggers](https://argo-cd.readthedocs.io/en/stable/operator-manual/notifications/triggers/)
- [Argo CD notification webhooks](https://argo-cd.readthedocs.io/en/stable/operator-manual/notifications/services/webhook/)
