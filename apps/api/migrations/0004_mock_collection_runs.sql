CREATE TABLE mock_collection_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  service_id uuid NOT NULL,
  mapping_revision bigint NOT NULL,
  request_id uuid NOT NULL,
  mapping_input jsonb NOT NULL CHECK (jsonb_typeof(mapping_input) = 'object' AND octet_length(mapping_input::text) <= 16384),
  service_name text NOT NULL CHECK (length(service_name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  failure_code text CHECK (failure_code = 'mock_processing_failed'),
  result jsonb CHECK (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 65536),
  lease_token uuid,
  lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, service_id, request_id),
  UNIQUE (workspace_id, service_id, mapping_revision, id),
  FOREIGN KEY (workspace_id, service_id, mapping_revision) REFERENCES deployment_mapping_revisions(workspace_id, service_id, revision),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (status <> 'pending' OR attempts < 3),
  CHECK (status = 'pending' OR attempts > 0),
  CHECK ((status = 'running') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((status IN ('succeeded','failed')) = (completed_at IS NOT NULL)),
  CHECK ((status = 'succeeded') = (result IS NOT NULL)),
  CHECK ((status = 'failed') = (failure_code IS NOT NULL))
);
CREATE UNIQUE INDEX one_active_mock_collection_run ON mock_collection_runs(workspace_id,service_id) WHERE status IN ('pending','running');
CREATE INDEX eligible_mock_collection_runs ON mock_collection_runs(available_at,created_at,id) WHERE status IN ('pending','running');
CREATE TABLE mock_collection_snapshots (
  run_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  service_id uuid NOT NULL,
  mapping_revision bigint NOT NULL,
  mapping_input jsonb NOT NULL,
  service_name text NOT NULL,
  evidence jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  metrics jsonb NOT NULL,
  oems_revision text NOT NULL CHECK (length(oems_revision) BETWEEN 1 AND 200),
  public_result jsonb NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY (workspace_id,service_id,mapping_revision,run_id) REFERENCES mock_collection_runs(workspace_id,service_id,mapping_revision,id),
  FOREIGN KEY (workspace_id,service_id,mapping_revision) REFERENCES deployment_mapping_revisions(workspace_id,service_id,revision),
  CHECK (jsonb_typeof(mapping_input)='object' AND jsonb_typeof(evidence)='object' AND jsonb_typeof(snapshot)='object' AND jsonb_typeof(metrics)='array' AND jsonb_typeof(public_result)='object'),
  CHECK (octet_length(mapping_input::text) <= 16384 AND octet_length(evidence::text) <= 262144 AND octet_length(snapshot::text) <= 262144 AND octet_length(metrics::text) <= 262144 AND octet_length(public_result::text) <= 65536)
);
CREATE FUNCTION guard_mock_collection_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Mock run inputs are immutable'; END IF;
  IF OLD.status IN ('succeeded','failed') THEN RAISE EXCEPTION 'Mock terminal runs are immutable'; END IF;
  IF ROW(OLD.id,OLD.workspace_id,OLD.service_id,OLD.mapping_revision,OLD.request_id,OLD.mapping_input,OLD.service_name,OLD.created_at)
    IS DISTINCT FROM ROW(NEW.id,NEW.workspace_id,NEW.service_id,NEW.mapping_revision,NEW.request_id,NEW.mapping_input,NEW.service_name,NEW.created_at)
    THEN RAISE EXCEPTION 'Mock run inputs are immutable'; END IF;
  IF NEW.attempts < OLD.attempts THEN RAISE EXCEPTION 'Mock attempts cannot decrease'; END IF;
  IF NEW.status = 'succeeded' AND NOT EXISTS (SELECT 1 FROM mock_collection_snapshots WHERE run_id = NEW.id AND public_result = NEW.result) THEN RAISE EXCEPTION 'Mock completion requires snapshot'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_mock_run_inputs BEFORE UPDATE OR DELETE ON mock_collection_runs FOR EACH ROW EXECUTE FUNCTION guard_mock_collection_run();
CREATE TRIGGER immutable_mock_snapshots BEFORE UPDATE OR DELETE ON mock_collection_snapshots FOR EACH ROW EXECUTE FUNCTION reject_deployment_mapping_mutation();

CREATE FUNCTION guard_mock_snapshot_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM mock_collection_runs r WHERE r.id=NEW.run_id AND r.status='running'
    AND r.mapping_input=NEW.mapping_input AND r.service_name=NEW.service_name) THEN RAISE EXCEPTION 'Mock snapshot requires current captured input'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guarded_mock_snapshot_insert BEFORE INSERT ON mock_collection_snapshots FOR EACH ROW EXECUTE FUNCTION guard_mock_snapshot_insert();
