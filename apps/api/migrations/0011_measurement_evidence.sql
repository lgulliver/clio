CREATE TABLE measurement_source_budgets (
 workspace_id uuid NOT NULL,
 service_id uuid NOT NULL,
 provider text NOT NULL CHECK (provider IN ('github','argocd')),
 source_scope text NOT NULL CHECK (length(source_scope) BETWEEN 1 AND 4096),
 retained_facts integer NOT NULL DEFAULT 0 CHECK (retained_facts BETWEEN 0 AND 5000),
 retained_bytes integer NOT NULL DEFAULT 0 CHECK (retained_bytes BETWEEN 0 AND 8388608),
 rate_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 rate_requests integer NOT NULL DEFAULT 0 CHECK (rate_requests BETWEEN 0 AND 120),
 PRIMARY KEY (workspace_id,service_id,provider,source_scope),
 FOREIGN KEY (workspace_id,service_id) REFERENCES services(workspace_id,id)
);
CREATE TABLE measurement_reports (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL,
 service_id uuid NOT NULL,
 provider text NOT NULL CHECK (provider IN ('github','argocd')),
 source_scope text NOT NULL,
 basis_run_id uuid NOT NULL,
 producer_id uuid NOT NULL,
 capability text NOT NULL CHECK (capability IN ('population','change_links','classification','recovery')),
 event_id uuid NOT NULL,
 report jsonb NOT NULL CHECK (jsonb_typeof(report)='object' AND octet_length(report::text)<=8388608),
 digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
 basis jsonb NOT NULL CHECK (jsonb_typeof(basis)='object' AND octet_length(basis::text)<=16384),
 native_fingerprint text NOT NULL CHECK (native_fingerprint ~ '^[a-f0-9]{64}$'),
 authority_fingerprint text NOT NULL CHECK (authority_fingerprint ~ '^[a-f0-9]{64}$'),
 fact_count integer NOT NULL CHECK (fact_count BETWEEN 1 AND 5000),
 payload_bytes integer NOT NULL CHECK (payload_bytes BETWEEN 1 AND 8388608),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (workspace_id,service_id,provider,source_scope,basis_run_id,capability),
 UNIQUE (workspace_id,service_id,provider,source_scope,producer_id,event_id),
 UNIQUE (workspace_id,service_id,id),
 FOREIGN KEY (workspace_id,service_id,provider,source_scope) REFERENCES measurement_source_budgets(workspace_id,service_id,provider,source_scope)
);
CREATE TRIGGER immutable_measurement_reports BEFORE UPDATE OR DELETE ON measurement_reports FOR EACH ROW EXECUTE FUNCTION reject_deployment_mapping_mutation();
CREATE FUNCTION guard_measurement_budget() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR ROW(OLD.workspace_id,OLD.service_id,OLD.provider,OLD.source_scope) IS DISTINCT FROM ROW(NEW.workspace_id,NEW.service_id,NEW.provider,NEW.source_scope) OR NEW.retained_facts<OLD.retained_facts OR NEW.retained_bytes<OLD.retained_bytes THEN RAISE EXCEPTION 'Measurement lifetime budgets cannot reset'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER guarded_measurement_budget BEFORE UPDATE OR DELETE ON measurement_source_budgets FOR EACH ROW EXECUTE FUNCTION guard_measurement_budget();
CREATE TABLE measurement_runs (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL,
 service_id uuid NOT NULL,
 provider text NOT NULL CHECK (provider IN ('github','argocd')),
 source_scope text NOT NULL CHECK (length(source_scope) BETWEEN 1 AND 4096),
 basis_run_id uuid NOT NULL,
 request_id uuid NOT NULL,
 input jsonb NOT NULL CHECK (jsonb_typeof(input)='object' AND octet_length(input::text)<=131072),
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz,
 failure_code text CHECK (failure_code IN ('measurement_revoked','measurement_processing_failed')),
 result jsonb CHECK (jsonb_typeof(result)='object' AND octet_length(result::text)<=131072),
 lease_token uuid,
 lease_until timestamptz,
 UNIQUE (workspace_id,service_id,request_id),
 UNIQUE (workspace_id,service_id,id),
 FOREIGN KEY (workspace_id,service_id) REFERENCES services(workspace_id,id),
 CHECK ((status='running')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK ((lease_token IS NULL)=(lease_until IS NULL)),
 CHECK (status<>'pending' OR attempts<3),
 CHECK (status='pending' OR attempts>0),
 CHECK ((status IN ('succeeded','failed'))=(completed_at IS NOT NULL)),
 CHECK ((status='succeeded')=(result IS NOT NULL)),
 CHECK ((status='failed')=(failure_code IS NOT NULL))
);
CREATE UNIQUE INDEX one_active_measurement_run ON measurement_runs(workspace_id,service_id,provider,source_scope) WHERE status IN ('pending','running');
CREATE INDEX measurement_history ON measurement_runs(workspace_id,service_id,created_at DESC,id DESC);
CREATE INDEX eligible_measurement_runs ON measurement_runs(available_at,created_at,id) WHERE status IN ('pending','running');
CREATE TABLE measurement_snapshots (
 run_id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL,
 service_id uuid NOT NULL,
 snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=67108864),
 metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics)='array' AND octet_length(metrics::text)<=131072),
 lineage jsonb NOT NULL CHECK (jsonb_typeof(lineage)='object' AND octet_length(lineage::text)<=131072),
 public_result jsonb NOT NULL CHECK (jsonb_typeof(public_result)='object' AND octet_length(public_result::text)<=131072),
 digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
 FOREIGN KEY (workspace_id,service_id,run_id) REFERENCES measurement_runs(workspace_id,service_id,id)
);
CREATE TRIGGER immutable_measurement_snapshots BEFORE UPDATE OR DELETE ON measurement_snapshots FOR EACH ROW EXECUTE FUNCTION reject_deployment_mapping_mutation();
CREATE FUNCTION guard_measurement_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status IN ('succeeded','failed') THEN RAISE EXCEPTION 'Measurement terminal runs are immutable'; END IF;
 IF ROW(OLD.id,OLD.workspace_id,OLD.service_id,OLD.provider,OLD.source_scope,OLD.basis_run_id,OLD.request_id,OLD.input,OLD.created_at) IS DISTINCT FROM ROW(NEW.id,NEW.workspace_id,NEW.service_id,NEW.provider,NEW.source_scope,NEW.basis_run_id,NEW.request_id,NEW.input,NEW.created_at) OR NEW.attempts<OLD.attempts THEN RAISE EXCEPTION 'Measurement inputs are immutable'; END IF;
 IF NEW.status='succeeded' AND NOT EXISTS (SELECT 1 FROM measurement_snapshots s WHERE s.run_id=NEW.id AND s.public_result=NEW.result) THEN RAISE EXCEPTION 'Measurement completion requires snapshot'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_measurement_run_inputs BEFORE UPDATE OR DELETE ON measurement_runs FOR EACH ROW EXECUTE FUNCTION guard_measurement_run();
CREATE FUNCTION guard_measurement_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM measurement_runs r WHERE r.id=NEW.run_id AND r.workspace_id=NEW.workspace_id AND r.service_id=NEW.service_id AND r.status='running' AND r.lease_until>clock_timestamp() AND NEW.lineage=r.input) THEN RAISE EXCEPTION 'Measurement snapshot requires leased input'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER guarded_measurement_snapshot BEFORE INSERT ON measurement_snapshots FOR EACH ROW EXECUTE FUNCTION guard_measurement_snapshot();

CREATE FUNCTION guard_measurement_basis_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 b jsonb;
BEGIN
 b := CASE WHEN TG_TABLE_NAME='measurement_reports' THEN to_jsonb(NEW)->'basis' ELSE to_jsonb(NEW)->'input'->'basis' END;
 IF b->>'provider' IS DISTINCT FROM NEW.provider OR b->>'runId' IS DISTINCT FROM NEW.basis_run_id::text THEN RAISE EXCEPTION 'Measurement basis scope mismatch'; END IF;
 IF NEW.provider='github' THEN
  IF NOT EXISTS (SELECT 1 FROM github_collection_runs r JOIN github_collection_snapshots s ON s.run_id=r.id WHERE r.id=NEW.basis_run_id AND r.workspace_id=NEW.workspace_id AND r.service_id=NEW.service_id AND r.status='succeeded' AND s.workspace_id=NEW.workspace_id AND s.service_id=NEW.service_id AND s.connection_revision::text=b->>'connectionRevision' AND s.digest=b->>'snapshotDigest') THEN RAISE EXCEPTION 'Measurement requires successful scoped native basis'; END IF;
 ELSE
  IF NOT EXISTS (SELECT 1 FROM argo_collection_runs r JOIN argo_collection_snapshots s ON s.run_id=r.id WHERE r.id=NEW.basis_run_id AND r.workspace_id=NEW.workspace_id AND r.service_id=NEW.service_id AND r.status='succeeded' AND s.workspace_id=NEW.workspace_id AND s.service_id=NEW.service_id AND s.connection_revision::text=b->>'connectionRevision' AND s.digest=b->>'snapshotDigest') THEN RAISE EXCEPTION 'Measurement requires successful scoped native basis'; END IF;
 END IF;
 IF TG_TABLE_NAME='measurement_reports' THEN
  IF NEW.report->'basis' IS DISTINCT FROM NEW.basis OR NEW.report->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text OR NEW.report->>'serviceId' IS DISTINCT FROM NEW.service_id::text OR NEW.report->>'producerId' IS DISTINCT FROM NEW.producer_id::text OR NEW.report->>'capability' IS DISTINCT FROM NEW.capability OR NEW.report->>'eventId' IS DISTINCT FROM NEW.event_id::text THEN RAISE EXCEPTION 'Measurement report scope mismatch'; END IF;
 ELSE
  IF NEW.input->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text OR NEW.input->>'serviceId' IS DISTINCT FROM NEW.service_id::text OR NEW.input->>'sourceScope' IS DISTINCT FROM NEW.source_scope OR jsonb_typeof(NEW.input->'receipts') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.input->'receipts')>4 THEN RAISE EXCEPTION 'Measurement job scope mismatch'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.input->'receipts') p WHERE NOT EXISTS (SELECT 1 FROM measurement_reports r WHERE r.id::text=p->>'id' AND r.digest=p->>'digest' AND r.producer_id::text=p->>'producerId' AND r.workspace_id=NEW.workspace_id AND r.service_id=NEW.service_id AND r.provider=NEW.provider AND r.source_scope=NEW.source_scope AND r.basis_run_id=NEW.basis_run_id)) THEN RAISE EXCEPTION 'Measurement job receipt mismatch'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER guarded_measurement_report_basis BEFORE INSERT ON measurement_reports FOR EACH ROW EXECUTE FUNCTION guard_measurement_basis_insert();
CREATE TRIGGER guarded_measurement_run_basis BEFORE INSERT ON measurement_runs FOR EACH ROW EXECUTE FUNCTION guard_measurement_basis_insert();
