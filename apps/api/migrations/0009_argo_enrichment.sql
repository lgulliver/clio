ALTER TABLE argo_connection_revisions ADD COLUMN enrichment_grants jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(enrichment_grants)='array' AND octet_length(enrichment_grants::text)<=131072);
CREATE TABLE argo_enrichment_subjects (
 source_id uuid NOT NULL REFERENCES argo_source_state(source_id),
 application_uid text NOT NULL,
 operation_id uuid NOT NULL,
 subject jsonb NOT NULL CHECK(jsonb_typeof(subject)='object' AND octet_length(subject::text)<=2048),
 PRIMARY KEY(source_id,application_uid,operation_id)
);
CREATE TABLE argo_enrichment_artifacts (
 source_id uuid NOT NULL REFERENCES argo_source_state(source_id),
 artifact_digest text NOT NULL CHECK(artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
 repository_id text NOT NULL CHECK(length(repository_id) BETWEEN 1 AND 2048),
 commit_sha text NOT NULL CHECK(commit_sha ~ '^[0-9a-f]{40}$'),
 PRIMARY KEY(source_id,artifact_digest)
);
CREATE TABLE argo_enrichment_receipts (
 id uuid PRIMARY KEY,
 source_id uuid NOT NULL REFERENCES argo_source_state(source_id),
 workspace_id uuid NOT NULL,
 service_id uuid NOT NULL,
 connection_revision bigint NOT NULL,
 producer_id uuid NOT NULL,
 event_id uuid NOT NULL,
 native_fingerprint text NOT NULL CHECK(native_fingerprint ~ '^[0-9a-f]{64}$'),
 producer_fingerprint text NOT NULL CHECK(producer_fingerprint ~ '^[0-9a-f]{64}$'),
 scope jsonb NOT NULL CHECK(jsonb_typeof(scope)='object' AND octet_length(scope::text)<=32768),
 event jsonb NOT NULL CHECK(jsonb_typeof(event)='object' AND octet_length(event::text)<=65536),
 digest text NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),
 observed_at timestamptz NOT NULL,
 UNIQUE(source_id,producer_id,event_id),
 FOREIGN KEY(workspace_id,service_id,connection_revision) REFERENCES argo_connection_revisions(workspace_id,service_id,revision)
);
CREATE INDEX argo_enrichment_cutoff ON argo_enrichment_receipts(source_id,observed_at,id);
CREATE TRIGGER immutable_argo_enrichment_receipts BEFORE UPDATE OR DELETE ON argo_enrichment_receipts FOR EACH ROW EXECUTE FUNCTION reject_deployment_mapping_mutation();
CREATE TRIGGER immutable_argo_enrichment_subjects BEFORE UPDATE OR DELETE ON argo_enrichment_subjects FOR EACH ROW EXECUTE FUNCTION reject_deployment_mapping_mutation();
CREATE TRIGGER immutable_argo_enrichment_artifacts BEFORE UPDATE OR DELETE ON argo_enrichment_artifacts FOR EACH ROW EXECUTE FUNCTION reject_deployment_mapping_mutation();
