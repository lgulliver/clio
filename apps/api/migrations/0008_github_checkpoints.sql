CREATE TABLE github_collection_checkpoints (
  workspace_id uuid NOT NULL,
  service_id uuid NOT NULL,
  connection_revision bigint NOT NULL,
  app_id bigint NOT NULL CHECK (app_id BETWEEN 1 AND 9007199254740991),
  installation_id bigint NOT NULL CHECK (installation_id BETWEEN 1 AND 9007199254740991),
  repository_id bigint NOT NULL CHECK (repository_id BETWEEN 1 AND 9007199254740991),
  grant_fingerprint text NOT NULL CHECK (grant_fingerprint ~ '^[0-9a-f]{64}$'),
  run_id uuid NOT NULL,
  lease_token uuid NOT NULL,
  cursor jsonb CHECK (jsonb_typeof(cursor)='object' AND octet_length(cursor::text)<=16384),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,service_id,connection_revision),
  FOREIGN KEY(workspace_id,service_id,connection_revision,run_id) REFERENCES github_collection_runs(workspace_id,service_id,connection_revision,id)
);
CREATE FUNCTION guard_github_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND ROW(OLD.workspace_id,OLD.service_id,OLD.connection_revision)
    IS DISTINCT FROM ROW(NEW.workspace_id,NEW.service_id,NEW.connection_revision)
    THEN RAISE EXCEPTION 'GitHub checkpoint scope is immutable'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM github_collection_runs r JOIN github_collection_snapshots s ON s.run_id=r.id
    WHERE r.id=NEW.run_id AND r.workspace_id=NEW.workspace_id AND r.service_id=NEW.service_id
      AND r.connection_revision=NEW.connection_revision AND r.grant_fingerprint=NEW.grant_fingerprint
      AND r.quota_app_id=NEW.app_id AND r.status='running' AND r.lease_token=NEW.lease_token
      AND r.lease_until>clock_timestamp()
      AND (r.connection_input->>'installationId')::bigint=NEW.installation_id
      AND (r.connection_input->>'repositoryId')::bigint=NEW.repository_id
  ) THEN RAISE EXCEPTION 'GitHub checkpoint requires current captured snapshot'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guarded_github_checkpoint BEFORE INSERT OR UPDATE ON github_collection_checkpoints FOR EACH ROW EXECUTE FUNCTION guard_github_checkpoint();
