CREATE TABLE github_quota_state (
  app_id bigint NOT NULL CHECK (app_id>0),
  installation_id bigint NOT NULL CHECK (installation_id>=0),
  next_request_at timestamptz NOT NULL DEFAULT '-infinity',
  blocked_until timestamptz NOT NULL DEFAULT '-infinity',
  consecutive_throttles integer NOT NULL DEFAULT 0 CHECK (consecutive_throttles BETWEEN 0 AND 30),
  lease_token uuid,
  lease_until timestamptz,
  PRIMARY KEY(app_id,installation_id),
  CHECK ((lease_token IS NULL)=(lease_until IS NULL))
);
-- installation_id=0 represents the App-authenticated request budget.
CREATE TABLE argo_ingress_buckets (
  source_id uuid PRIMARY KEY,
  tokens double precision NOT NULL CHECK (tokens>=0 AND tokens<=10),
  refilled_at timestamptz NOT NULL
);

ALTER TABLE github_collection_runs ADD COLUMN quota_app_id bigint CHECK (quota_app_id>0);
CREATE OR REPLACE FUNCTION guard_github_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GitHub run inputs are immutable'; END IF;
  IF OLD.status IN ('succeeded','failed') THEN RAISE EXCEPTION 'GitHub terminal runs are immutable'; END IF;
  IF ROW(OLD.id,OLD.workspace_id,OLD.service_id,OLD.connection_revision,OLD.request_id,OLD.connection_input,OLD.grant_fingerprint,OLD.window_input,OLD.service_name,OLD.created_at)
    IS DISTINCT FROM ROW(NEW.id,NEW.workspace_id,NEW.service_id,NEW.connection_revision,NEW.request_id,NEW.connection_input,NEW.grant_fingerprint,NEW.window_input,NEW.service_name,NEW.created_at)
    THEN RAISE EXCEPTION 'GitHub run inputs are immutable'; END IF;
  IF NEW.attempts<OLD.attempts AND NOT COALESCE((
    OLD.status='running' AND NEW.status='pending' AND NEW.attempts=OLD.attempts-1 AND
    OLD.lease_until>clock_timestamp() AND NEW.quota_app_id=OLD.quota_app_id AND
    EXISTS(SELECT 1 FROM github_quota_state q WHERE q.app_id=OLD.quota_app_id AND
      q.installation_id IN (0,(OLD.connection_input->>'installationId')::bigint) AND q.blocked_until>clock_timestamp())
  ),false) THEN RAISE EXCEPTION 'GitHub attempts cannot decrease'; END IF;
  IF NEW.status='succeeded' AND NOT EXISTS (SELECT 1 FROM github_collection_snapshots WHERE run_id=NEW.id AND public_result=NEW.result) THEN RAISE EXCEPTION 'GitHub completion requires snapshot'; END IF;
  RETURN NEW;
END;
$$;
