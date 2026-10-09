# OEMS integration instructions

Apply the root AGENTS.md first. Read the exact upstream revision referenced by src/index.ts before implementing schema or metric work.

- Normative schemas, populations and formulas belong to lgulliver/oems. This package adapts and validates; it does not create an alternative standard.
- Pin upstream material to a commit, retain licence/provenance when copying it and record compatibility changes. Do not fetch mutable main at runtime.
- Treat inbound JSON as unknown until structurally and semantically checked. Keep those checks distinct from metric calculation and output quality.
- Keep this boundary platform-neutral; no React, provider SDK, DOM or browser state.
- Preserve explicit provisional quality, scope and cutoff information. Do not infer complete linkage or history.
