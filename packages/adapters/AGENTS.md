# Adapter boundary instructions

Apply the root AGENTS.md first. This directory reserves the next server-side integration boundary; no provider has been selected or implemented yet.

- Create a workspace package only when the first adapter is built. Keep all credentials and source API clients server-side.
- Preserve namespaced provider identity, observation times and evidence for classifications. Explicitly declare collection, history and recovery coverage.
- Separate raw collection from reconciliation and standard validation. Emit a pinned OEMS snapshot; do not reinterpret the standard.
- Use fictional fixtures and controlled API mocks. Never commit customer payloads, private incident details or tokens.
