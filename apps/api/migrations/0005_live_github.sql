CREATE TABLE github_connection_revisions (
  workspace_id uuid NOT NULL,
  service_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  connection jsonb NOT NULL CHECK (jsonb_typeof(connection)='object' AND octet_length(connection::text)<=16384),
  grant_fingerprint text NOT NULL CHECK (grant_fingerprint ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL,
  PRIMARY KEY(workspace_id,service_id,revision),
  FOREIGN KEY(workspace_id,service_id) REFERENCES services(workspace_id,id),
  CHECK (connection->>'workspaceId'=workspace_id::text AND connection->>'serviceId'=service_id::text AND (connection->>'revision')::bigint=revision)
);
CREATE TRIGGER immutable_github_connections BEFORE UPDATE OR DELETE ON github_connection_revisions FOR EACH ROW EXECUTE FUNCTION reject_deployment_mapping_mutation();
CREATE TABLE github_collection_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  service_id uuid NOT NULL,
  connection_revision bigint NOT NULL,
  request_id uuid NOT NULL,
  connection_input jsonb NOT NULL CHECK (jsonb_typeof(connection_input)='object' AND octet_length(connection_input::text)<=16384),
  grant_fingerprint text NOT NULL CHECK (grant_fingerprint ~ '^[0-9a-f]{64}$'),
  window_input jsonb NOT NULL CHECK (jsonb_typeof(window_input)='object' AND octet_length(window_input::text)<=1024),
  service_name text NOT NULL CHECK (length(service_name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  failure_code text CHECK (failure_code IN ('github_processing_failed','github_connection_revoked')),
  result jsonb CHECK (jsonb_typeof(result)='object' AND octet_length(result::text)<=65536),
  lease_token uuid,
  lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,service_id,request_id),
  UNIQUE(workspace_id,service_id,connection_revision,id),
  FOREIGN KEY(workspace_id,service_id,connection_revision) REFERENCES github_connection_revisions(workspace_id,service_id,revision),
  CHECK ((lease_token IS NULL)=(lease_until IS NULL)),
  CHECK (status<>'pending' OR attempts<3),
  CHECK ((status='running')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (status<>'running' OR attempts>0),
  CHECK ((status IN ('succeeded','failed'))=(completed_at IS NOT NULL)),
  CHECK ((status='succeeded')=(result IS NOT NULL)),
  CHECK ((status='failed')=(failure_code IS NOT NULL)),
  CHECK (updated_at>=created_at AND (completed_at IS NULL OR completed_at=updated_at))
);
CREATE UNIQUE INDEX one_active_github_collection_run ON github_collection_runs(workspace_id,service_id) WHERE status IN ('pending','running');
CREATE INDEX eligible_github_collection_runs ON github_collection_runs(available_at,created_at,id) WHERE status IN ('pending','running');
CREATE TABLE github_collection_history (
  workspace_id uuid NOT NULL,
  service_id uuid NOT NULL,
  installation_id bigint NOT NULL CHECK (installation_id>0),
  repository_id bigint NOT NULL CHECK (repository_id>0),
  kind text NOT NULL CHECK (kind IN ('deployment','status','traversal')),
  record_key text NOT NULL CHECK (length(record_key) BETWEEN 1 AND 2048),
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=16384),
  PRIMARY KEY(workspace_id,service_id,installation_id,repository_id,kind,record_key,observed_at),
  FOREIGN KEY(workspace_id,service_id) REFERENCES services(workspace_id,id)
);
CREATE TRIGGER immutable_github_history BEFORE UPDATE OR DELETE ON github_collection_history FOR EACH ROW EXECUTE FUNCTION reject_deployment_mapping_mutation();
CREATE TABLE github_collection_snapshots (
  run_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  service_id uuid NOT NULL,
  connection_revision bigint NOT NULL,
  connection_input jsonb NOT NULL,
  service_name text NOT NULL,
  evidence jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  metrics jsonb NOT NULL,
  oems_revision text NOT NULL,
  public_result jsonb NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY(workspace_id,service_id,connection_revision,run_id) REFERENCES github_collection_runs(workspace_id,service_id,connection_revision,id),
  CHECK (jsonb_typeof(connection_input)='object' AND jsonb_typeof(evidence)='object' AND jsonb_typeof(snapshot)='object' AND jsonb_typeof(metrics)='array' AND jsonb_typeof(public_result)='object'),
  CHECK (octet_length(connection_input::text)+octet_length(evidence::text)+octet_length(snapshot::text)+octet_length(metrics::text)+octet_length(public_result::text)<=8388608)
);
CREATE TRIGGER immutable_github_snapshots BEFORE UPDATE OR DELETE ON github_collection_snapshots FOR EACH ROW EXECUTE FUNCTION reject_deployment_mapping_mutation();
CREATE FUNCTION guard_github_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GitHub run inputs are immutable'; END IF;
  IF OLD.status IN ('succeeded','failed') THEN RAISE EXCEPTION 'GitHub terminal runs are immutable'; END IF;
  IF ROW(OLD.id,OLD.workspace_id,OLD.service_id,OLD.connection_revision,OLD.request_id,OLD.connection_input,OLD.grant_fingerprint,OLD.window_input,OLD.service_name,OLD.created_at)
    IS DISTINCT FROM ROW(NEW.id,NEW.workspace_id,NEW.service_id,NEW.connection_revision,NEW.request_id,NEW.connection_input,NEW.grant_fingerprint,NEW.window_input,NEW.service_name,NEW.created_at)
    THEN RAISE EXCEPTION 'GitHub run inputs are immutable'; END IF;
  IF NEW.attempts<OLD.attempts THEN RAISE EXCEPTION 'GitHub attempts cannot decrease'; END IF;
  IF NEW.status='succeeded' AND NOT EXISTS (SELECT 1 FROM github_collection_snapshots WHERE run_id=NEW.id AND public_result=NEW.result) THEN RAISE EXCEPTION 'GitHub completion requires snapshot'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_github_run_inputs BEFORE UPDATE OR DELETE ON github_collection_runs FOR EACH ROW EXECUTE FUNCTION guard_github_run();
CREATE FUNCTION guard_github_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM github_collection_runs r WHERE r.id=NEW.run_id AND r.status='running' AND r.lease_until>clock_timestamp() AND r.connection_input=NEW.connection_input AND r.service_name=NEW.service_name) THEN RAISE EXCEPTION 'GitHub snapshot requires current captured input'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guarded_github_snapshot_insert BEFORE INSERT ON github_collection_snapshots FOR EACH ROW EXECUTE FUNCTION guard_github_snapshot();
