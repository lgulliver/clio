# Draft schemas

JSON Schemas use Draft 2020-12. dataset.schema.json references the four entity schemas locally; metric-result.schema.json defines the per-service output. Configure RFC 3339 date-time and URI format checks explicitly. No hosted schema endpoint is promised.

Structural validation checks required fields, coverage declarations, evidence arrays, enums, positive day counts and result context. Semantic validation separately checks window arithmetic, canonical identities, duplicates, references, timestamp order, cutoff eligibility and causal consistency. Calculation fixtures compare complete outputs, including quality states. Passing one layer does not imply the others.

The envelope schema describes draft ingestion syntax. Its payload needs separate validation against record_type. Envelope ingestion/revision conformance is outside the reconciled-snapshot metric profile. Validators must resolve only local schemas and must not fetch evidence URLs.

Run all checked layers with python tools/validate_v0_1.py after installing requirements-dev.txt.
