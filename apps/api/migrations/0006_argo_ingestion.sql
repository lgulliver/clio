CREATE TABLE argo_connection_revisions (
  workspace_id uuid NOT NULL,
  service_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  connection jsonb NOT NULL CHECK (jsonb_typeof(connection)='object' AND octet_length(connection::text)<=16384),
  grant_fingerprint text NOT NULL CHECK (grant_fingerprint ~ '^[0-9a-f]{64}$'),
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope)='object' AND octet_length(scope::text)<=16384),
  created_by text NOT NULL,
  PRIMARY KEY(workspace_id,service_id,revision),
  FOREIGN KEY(workspace_id,service_id) REFERENCES services(workspace_id,id),
  CHECK (connection->>'workspaceId'=workspace_id::text AND connection->>'serviceId'=service_id::text AND (connection->>'revision')::bigint=revision)
);
CREATE TRIGGER immutable_argo_connections BEFORE UPDATE OR DELETE ON argo_connection_revisions FOR EACH ROW EXECUTE FUNCTION reject_deployment_mapping_mutation();
CREATE TABLE argo_collection_runs (
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
  failure_code text CHECK (failure_code IN ('argo_processing_failed','argo_connection_revoked')),
  result jsonb CHECK (jsonb_typeof(result)='object' AND octet_length(result::text)<=65536),
  lease_token uuid,
  lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,service_id,request_id),
  UNIQUE(workspace_id,service_id,connection_revision,id),
  FOREIGN KEY(workspace_id,service_id,connection_revision) REFERENCES argo_connection_revisions(workspace_id,service_id,revision),
  CHECK ((lease_token IS NULL)=(lease_until IS NULL)),
  CHECK (status<>'pending' OR attempts<3),
  CHECK ((status='running')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (status<>'running' OR attempts>0),
  CHECK ((status IN ('succeeded','failed'))=(completed_at IS NOT NULL)),
  CHECK ((status='succeeded')=(result IS NOT NULL)),
  CHECK ((status='failed')=(failure_code IS NOT NULL)),
  CHECK (updated_at>=created_at AND (completed_at IS NULL OR completed_at=updated_at))
);
CREATE UNIQUE INDEX one_active_argo_collection_run ON argo_collection_runs(workspace_id,service_id) WHERE status IN ('pending','running');
CREATE INDEX eligible_argo_collection_runs ON argo_collection_runs(available_at,created_at,id) WHERE status IN ('pending','running');
CREATE TABLE argo_collection_snapshots (
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
  FOREIGN KEY(workspace_id,service_id,connection_revision,run_id) REFERENCES argo_collection_runs(workspace_id,service_id,connection_revision,id),
  CHECK (jsonb_typeof(connection_input)='object' AND jsonb_typeof(evidence)='object' AND jsonb_typeof(snapshot)='object' AND jsonb_typeof(metrics)='array' AND jsonb_typeof(public_result)='object'),
  CHECK (octet_length(connection_input::text)+octet_length(evidence::text)+octet_length(snapshot::text)+octet_length(metrics::text)+octet_length(public_result::text)<=8388608)
);
CREATE TRIGGER immutable_argo_snapshots BEFORE UPDATE OR DELETE ON argo_collection_snapshots FOR EACH ROW EXECUTE FUNCTION reject_deployment_mapping_mutation();
CREATE FUNCTION guard_argo_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Argo run inputs are immutable'; END IF;
  IF OLD.status IN ('succeeded','failed') THEN RAISE EXCEPTION 'Argo terminal runs are immutable'; END IF;
  IF ROW(OLD.id,OLD.workspace_id,OLD.service_id,OLD.connection_revision,OLD.request_id,OLD.connection_input,OLD.grant_fingerprint,OLD.window_input,OLD.service_name,OLD.created_at)
    IS DISTINCT FROM ROW(NEW.id,NEW.workspace_id,NEW.service_id,NEW.connection_revision,NEW.request_id,NEW.connection_input,NEW.grant_fingerprint,NEW.window_input,NEW.service_name,NEW.created_at)
    THEN RAISE EXCEPTION 'Argo run inputs are immutable'; END IF;
  IF NEW.attempts<OLD.attempts THEN RAISE EXCEPTION 'Argo attempts cannot decrease'; END IF;
  IF NEW.status='succeeded' AND NOT EXISTS (SELECT 1 FROM argo_collection_snapshots WHERE run_id=NEW.id AND public_result=NEW.result) THEN RAISE EXCEPTION 'Argo completion requires snapshot'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_argo_run_inputs BEFORE UPDATE OR DELETE ON argo_collection_runs FOR EACH ROW EXECUTE FUNCTION guard_argo_run();
CREATE FUNCTION guard_argo_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM argo_collection_runs r WHERE r.id=NEW.run_id AND r.status='running' AND r.lease_until>clock_timestamp() AND r.connection_input=NEW.connection_input AND r.service_name=NEW.service_name) THEN RAISE EXCEPTION 'Argo snapshot requires current captured input'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guarded_argo_snapshot_insert BEFORE INSERT ON argo_collection_snapshots FOR EACH ROW EXECUTE FUNCTION guard_argo_snapshot();

CREATE TABLE argo_source_state (
 source_id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL,
 service_id uuid NOT NULL,
 retained_rows integer NOT NULL DEFAULT 0 CHECK(retained_rows BETWEEN 0 AND 5000),
 retained_bytes integer NOT NULL DEFAULT 0 CHECK(retained_bytes BETWEEN 0 AND 8388608),
 rejection_count integer NOT NULL DEFAULT 0 CHECK(rejection_count BETWEEN 0 AND 2147483647),
 scope_drift_count integer NOT NULL DEFAULT 0 CHECK(scope_drift_count BETWEEN 0 AND 2147483647),
 first_observed_at timestamptz,
 FOREIGN KEY(workspace_id,service_id) REFERENCES services(workspace_id,id)
);
CREATE TABLE argo_operation_metadata (
 source_id uuid NOT NULL REFERENCES argo_source_state(source_id),
 application_uid text NOT NULL CHECK(length(application_uid) BETWEEN 1 AND 200),
 operation_id uuid NOT NULL,
 metadata_digest text NOT NULL CHECK(metadata_digest ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(source_id,application_uid,operation_id)
);
CREATE TRIGGER immutable_argo_operations BEFORE UPDATE OR DELETE ON argo_operation_metadata FOR EACH ROW EXECUTE FUNCTION reject_deployment_mapping_mutation();
CREATE TABLE argo_receipts (
 id uuid PRIMARY KEY,
 source_id uuid NOT NULL REFERENCES argo_source_state(source_id),
 workspace_id uuid NOT NULL,
 service_id uuid NOT NULL,
 connection_revision bigint NOT NULL,
 application_uid text NOT NULL,
 grant_fingerprint text NOT NULL CHECK(grant_fingerprint ~ '^[0-9a-f]{64}$'),
 scope jsonb NOT NULL CHECK(jsonb_typeof(scope)='object' AND octet_length(scope::text)<=16384),
 digest text NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),
 observed_at timestamptz NOT NULL,
 started_at timestamptz,
 operation_id uuid,
 notification_revision text CHECK(notification_revision ~ '^[0-9a-f]{64}$'),
 phase text,
 health text,
 reason text CHECK(reason IN ('unmarked_operation','non_terminal','missing_sync_result','missing_health_timestamp','multi_source','source_hydrator','future_timestamp','invalid_operation_info','observation_horizon','status_combination_repeated','status_combination_limit','connection_interruption')),
 canonical_json text CHECK(octet_length(canonical_json)<=65536),
 evidence jsonb CHECK(jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=65536),
 UNIQUE(source_id,grant_fingerprint,digest),
 FOREIGN KEY(workspace_id,service_id,connection_revision) REFERENCES argo_connection_revisions(workspace_id,service_id,revision),
 CHECK((reason IS NULL)=(evidence IS NOT NULL)),
 CHECK(reason IS NOT NULL OR (operation_id IS NOT NULL AND notification_revision IS NOT NULL AND phase IS NOT NULL AND health IS NOT NULL AND canonical_json IS NOT NULL))
);
CREATE UNIQUE INDEX argo_notification_identity ON argo_receipts(source_id,application_uid,operation_id,notification_revision) WHERE evidence IS NOT NULL;
CREATE INDEX argo_receipt_cutoff ON argo_receipts(source_id,observed_at,id);
CREATE TRIGGER immutable_argo_receipts BEFORE UPDATE OR DELETE ON argo_receipts FOR EACH ROW EXECUTE FUNCTION reject_deployment_mapping_mutation();
CREATE TABLE argo_interruptions (
 source_id uuid NOT NULL REFERENCES argo_source_state(source_id),
 grant_fingerprint text NOT NULL CHECK(grant_fingerprint ~ '^[0-9a-f]{64}$'),
 workspace_id uuid NOT NULL,
 service_id uuid NOT NULL,
 connection_revision bigint NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(source_id,grant_fingerprint,connection_revision),
 FOREIGN KEY(workspace_id,service_id,connection_revision) REFERENCES argo_connection_revisions(workspace_id,service_id,revision)
);
CREATE TRIGGER immutable_argo_interruptions BEFORE UPDATE OR DELETE ON argo_interruptions FOR EACH ROW EXECUTE FUNCTION reject_deployment_mapping_mutation();
