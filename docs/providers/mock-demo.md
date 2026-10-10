# Mock deployment evidence

The provider demo uses fictional GitHub responses and a fictional Argo CD operation notification. Its injected transport performs no network requests, and no provider configuration or credentials are required. It is a command-line development example, not connected workspace data or a browser source-configuration flow.

```sh
# Both observations explicitly correlated into one rollout; exposure remains unknown.
pnpm demo:providers

# Select one deployment authority.
pnpm demo:providers --source=argocd
pnpm demo:providers --source=github

# Explicit fictional policy allows the fixture success/exposure evidence to qualify.
pnpm demo:providers --source=both --attest-exposure

# An unmatched selected environment remains unknown.
pnpm demo:providers --environment=other-production-environment --attest-exposure
```

The example prints the selected source/environment, canonical rollout count, false coverage flags and all five calculated OEMS results. Complete transport traversal never establishes complete metric coverage. Without explicit exposure evidence, qualification remains unknown. Missing failure/rework/commit/recovery evidence stays unknown or unavailable rather than becoming zero.

Service mapping is supplied separately from source normalization: stable service/source identity, selected operations and environments, primary deployment authority, versioned exposure policy and explicit cross-provider rollout correlation. The example has one fictional rollout seen through both providers; correlation makes it one canonical deployment. A matching SHA alone would not.

Argo CD configuration revision remains separate from application-source provenance. The fixture deliberately supplies no application provenance. This prevents a manifests SHA from silently becoming an application-source change link.

The example constructs and validates an immutable snapshot through @clio/oems before calculating results. Adapter tests cover additional gaps, pagination, cutoff/replay and conflicting evidence. The browser Settings page now saves mock-only service settings and requests authorized fictional previews. Owners can also queue durable fictional runs and read stored results; follow [getting started](../getting-started.md). Real connection scopes, Argo CD HTTP ingestion and live results remain later slices.
