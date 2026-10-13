CREATE TABLE space_github_mappings (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 live_team_id uuid,
 team_id uuid NOT NULL,
 team_name text NOT NULL CHECK(length(team_name) BETWEEN 1 AND 200),
 app_id bigint NOT NULL CHECK(app_id BETWEEN 1 AND 9007199254740991),
 installation_id bigint NOT NULL CHECK(installation_id BETWEEN 1 AND 9007199254740991),
 repository_id bigint NOT NULL CHECK(repository_id BETWEEN 1 AND 9007199254740991),
 repository_label text NOT NULL CHECK(length(repository_label) BETWEEN 3 AND 201),
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 connected boolean NOT NULL,
 grant_fingerprint text NOT NULL CHECK(grant_fingerprint ~ '^[a-f0-9]{64}$'),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,repository_id),
 FOREIGN KEY(workspace_id,live_team_id) REFERENCES teams(workspace_id,id),
 CHECK((connected AND live_team_id IS NOT NULL) OR (NOT connected AND live_team_id IS NULL)),
 CHECK(live_team_id IS NULL OR live_team_id=team_id)
);
CREATE TABLE space_github_jobs (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL,
 mapping_id uuid NOT NULL,
 request_id uuid NOT NULL,
 context jsonb NOT NULL CHECK(jsonb_typeof(context)='object' AND octet_length(context::text)<=4096),
 grant_fingerprint text NOT NULL CHECK(grant_fingerprint ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','running','succeeded','failed','cancelled')),
 queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz,
 reason text CHECK(reason IN('scope_changed','disconnected','grant_removed','expired','provider_unavailable','invalid_provider_data','retry_exhausted')),
 result_id uuid,
 lease_token uuid,
 lease_until timestamptz,
 failures integer NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 3),
 active_millis integer NOT NULL DEFAULT 0 CHECK(active_millis BETWEEN 0 AND 1800000),
 checkpoint jsonb CHECK(checkpoint IS NULL OR (jsonb_typeof(checkpoint)='object' AND octet_length(checkpoint::text)<=16777216)),
 acquisition_started_at timestamptz,
 acquisition_ended_at timestamptz,
 UNIQUE(workspace_id,mapping_id,request_id), UNIQUE(workspace_id,mapping_id,id),
 FOREIGN KEY(workspace_id,mapping_id) REFERENCES space_github_mappings(workspace_id,id),
 CHECK(expires_at>queued_at AND expires_at<=queued_at+interval '24 hours 1 second'),
 CHECK((state='running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR (state<>'running' AND lease_token IS NULL AND lease_until IS NULL)),
 CHECK(lease_until IS NULL OR lease_until<=expires_at),
 CHECK((state IN('queued','running') AND completed_at IS NULL AND reason IS NULL AND result_id IS NULL) OR (state='succeeded' AND completed_at IS NOT NULL AND completed_at>=queued_at AND reason IS NULL AND result_id IS NOT NULL) OR (state='failed' AND completed_at IS NOT NULL AND completed_at>=queued_at AND reason IS NOT NULL AND reason IN('expired','provider_unavailable','invalid_provider_data','retry_exhausted') AND result_id IS NULL) OR (state='cancelled' AND completed_at IS NOT NULL AND completed_at>=queued_at AND reason IS NOT NULL AND reason IN('scope_changed','disconnected','grant_removed') AND result_id IS NULL)),
 CHECK((state IN('queued','running'))=(completed_at IS NULL)),
 CHECK((state IN('queued','running','succeeded'))=(reason IS NULL)),
 CHECK((state='succeeded')=(result_id IS NOT NULL)),
 CHECK(context ? 'workspaceId' AND context ? 'mappingId' AND COALESCE(context->>'workspaceId'=workspace_id::text AND context->>'mappingId'=mapping_id::text,false)),
 CHECK((acquisition_started_at IS NULL AND acquisition_ended_at IS NULL) OR (acquisition_started_at IS NOT NULL AND acquisition_ended_at IS NOT NULL AND acquisition_ended_at>=acquisition_started_at)),
 CHECK(completed_at IS NULL OR acquisition_ended_at IS NULL OR completed_at>=acquisition_ended_at)
);
CREATE UNIQUE INDEX space_github_active_idx ON space_github_jobs(workspace_id,mapping_id) WHERE state IN('queued','running');
CREATE INDEX space_github_claim_idx ON space_github_jobs(available_at,queued_at,id) WHERE state IN('queued','running');
CREATE INDEX space_github_history_idx ON space_github_jobs(workspace_id,mapping_id,queued_at DESC,id DESC);
CREATE INDEX space_github_team_history_idx ON space_github_jobs(workspace_id,(context->>'teamId'),mapping_id);
CREATE TABLE space_github_results (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL,
 mapping_id uuid NOT NULL,
 run_id uuid NOT NULL UNIQUE,
 completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=16777216),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object' AND octet_length(result::text)<=32768),
 UNIQUE(workspace_id,mapping_id,id),
 FOREIGN KEY(workspace_id,mapping_id,run_id) REFERENCES space_github_jobs(workspace_id,mapping_id,id)
);
ALTER TABLE space_github_jobs ADD CONSTRAINT space_github_job_result_fk FOREIGN KEY(workspace_id,mapping_id,result_id) REFERENCES space_github_results(workspace_id,mapping_id,id);
CREATE INDEX space_github_result_history_idx ON space_github_results(workspace_id,mapping_id,completed_at DESC,id DESC);
CREATE INDEX space_github_result_team_idx ON space_github_results(workspace_id,(result->>'teamId'),mapping_id);
CREATE FUNCTION guard_space_github_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable SPACE GitHub result'; END $$;
CREATE TRIGGER space_github_result_immutable BEFORE UPDATE OR DELETE ON space_github_results FOR EACH ROW EXECUTE FUNCTION guard_space_github_result();
CREATE FUNCTION guard_space_github_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state IN('succeeded','failed','cancelled') OR NEW.id<>OLD.id OR NEW.workspace_id<>OLD.workspace_id OR NEW.mapping_id<>OLD.mapping_id OR NEW.request_id<>OLD.request_id OR NEW.context<>OLD.context OR NEW.grant_fingerprint<>OLD.grant_fingerprint OR NEW.queued_at<>OLD.queued_at OR NEW.expires_at<>OLD.expires_at OR NEW.failures<OLD.failures OR NEW.failures>OLD.failures+1 OR NEW.active_millis<OLD.active_millis THEN
 RAISE EXCEPTION 'Invalid SPACE GitHub job transition'; END IF;
 IF NEW.state='running' AND (OLD.state NOT IN('queued','running') OR (OLD.state='running' AND OLD.lease_token IS DISTINCT FROM NEW.lease_token AND OLD.lease_until>clock_timestamp()) OR NEW.lease_until>clock_timestamp()+interval '120 seconds') THEN
 RAISE EXCEPTION 'Invalid SPACE GitHub claim'; END IF;
 IF OLD.state='running' AND NEW.state IN('running','queued','succeeded') AND OLD.lease_until<=clock_timestamp() AND (NEW.state<>'running' OR NEW.lease_token=OLD.lease_token) THEN
 RAISE EXCEPTION 'Expired SPACE GitHub write'; END IF;
 IF NEW.state='succeeded' AND (OLD.state<>'running' OR OLD.lease_until<=clock_timestamp() OR OLD.expires_at<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM space_github_results r WHERE r.id=NEW.result_id AND r.run_id=NEW.id)) THEN
 RAISE EXCEPTION 'Invalid SPACE GitHub completion'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER space_github_job_guard BEFORE UPDATE ON space_github_jobs FOR EACH ROW EXECUTE FUNCTION guard_space_github_job();

CREATE FUNCTION guard_space_github_result_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM space_github_jobs j JOIN space_github_mappings m ON m.workspace_id=j.workspace_id AND m.id=j.mapping_id WHERE j.id=NEW.run_id AND j.workspace_id=NEW.workspace_id AND j.mapping_id=NEW.mapping_id AND j.state='running' AND j.lease_until>clock_timestamp() AND j.expires_at>clock_timestamp() AND m.connected AND m.grant_fingerprint=j.grant_fingerprint AND m.revision=(j.context->>'mappingRevision')::bigint AND NEW.result->>'runId'=j.id::text AND NEW.result->>'id'=NEW.id::text AND NEW.result->>'workspaceId'=j.workspace_id::text AND NEW.result->>'mappingId'=j.mapping_id::text) THEN
 RAISE EXCEPTION 'Invalid SPACE GitHub result publication'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER space_github_result_publication BEFORE INSERT ON space_github_results FOR EACH ROW EXECUTE FUNCTION guard_space_github_result_insert();
