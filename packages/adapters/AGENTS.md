# Adapter boundary instructions

Apply the root AGENTS.md first. This directory owns server-side provider collection and evidence mapping. ADR 0006 selects GitHub App/GitHub Deployments first, configurable deployment sources including Argo CD, and mocked evidence for now. Implementation status is recorded in README.md.

- Create a workspace package only when the first adapter is built. Keep all credentials and source API clients server-side.
- Keep deployment sources separate from repository/change sources. Use explicit rollout correlation across providers; matching SHA or nearby timestamps cannot establish canonical identity. Production-environment selection, successful sync and resource health cannot silently establish consumer exposure.
- Preserve namespaced provider identity, observation times and evidence for classifications. Explicitly declare collection, history and recovery coverage.
- Separate raw collection from reconciliation and standard validation. Emit a pinned OEMS snapshot; do not reinterpret the standard.
- Use fictional fixtures and controlled API mocks. Never commit customer payloads, private incident details or tokens.
