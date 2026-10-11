-- Constant default preserves historical partial mappings without rewriting saved JSON inputs/results.
ALTER TABLE deployment_mapping_revisions
  ADD COLUMN scenario text NOT NULL DEFAULT 'partial'
    CHECK (scenario IN ('partial', 'complete-lifecycle')),
  ADD CONSTRAINT mock_lifecycle_profile CHECK
    (scenario <> 'complete-lifecycle' OR (production_environment = 'production' AND exposure_attested));
