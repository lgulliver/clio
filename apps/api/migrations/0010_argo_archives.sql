ALTER TABLE argo_receipts ADD COLUMN origin_transport text NOT NULL DEFAULT 'live' CHECK(origin_transport IN ('live','archive'));
ALTER TABLE argo_connection_revisions ADD COLUMN archive_grant jsonb CHECK(archive_grant IS NULL OR (jsonb_typeof(archive_grant)='object' AND octet_length(archive_grant::text)<=32768));
CREATE TABLE argo_archive_buckets (
 source_id uuid PRIMARY KEY,
 tokens double precision NOT NULL CHECK(tokens BETWEEN 0 AND 2),
 refilled_at timestamptz NOT NULL
);
CREATE TABLE argo_archive_journals (
 source_id uuid NOT NULL REFERENCES argo_source_state(source_id),
 journal_id uuid NOT NULL,
 producer_id uuid NOT NULL,
 scope jsonb NOT NULL CHECK(jsonb_typeof(scope)='object' AND octet_length(scope::text)<=32768),
 policy_reference text NOT NULL CHECK(length(policy_reference) BETWEEN 1 AND 200),
 startup_at timestamptz NOT NULL,
 registered_at timestamptz NOT NULL,
 last_sequence bigint NOT NULL DEFAULT 0 CHECK(last_sequence BETWEEN 0 AND 9007199254740991),
 last_digest text NOT NULL DEFAULT repeat('0',64) CHECK(last_digest ~ '^[0-9a-f]{64}$'),
 last_capture_at timestamptz,
 sealed_sequence bigint NOT NULL DEFAULT 0,
 sealed_end timestamptz,
 PRIMARY KEY(source_id,journal_id),
 CHECK(sealed_sequence BETWEEN 0 AND last_sequence)
);
CREATE TABLE argo_archive_records (
 id uuid PRIMARY KEY,
 source_id uuid NOT NULL,
 journal_id uuid NOT NULL,
 producer_id uuid NOT NULL,
 native_fingerprint text NOT NULL CHECK(native_fingerprint ~ '^[0-9a-f]{64}$'),
 archive_fingerprint text NOT NULL CHECK(archive_fingerprint ~ '^[0-9a-f]{64}$'),
 connection_revision bigint NOT NULL,
 kind text NOT NULL CHECK(kind IN ('entry','seal')),
 sequence bigint,
 seal_id uuid,
 digest text NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object' AND octet_length(record::text)<=131072),
 captured_at timestamptz,
 received_at timestamptz NOT NULL,
 receipt_id uuid REFERENCES argo_receipts(id),
 remaining_rows integer NOT NULL CHECK(remaining_rows BETWEEN 0 AND 5000),
 remaining_bytes integer NOT NULL CHECK(remaining_bytes BETWEEN 0 AND 8388608),
 gap_reason text CHECK(gap_reason IN ('payload_invalid','payload_scope','payload_temporal','payload_metadata','cross_native_fingerprint','status_combination_repeated','status_combination_limit','unmarked_operation','non_terminal','missing_sync_result','missing_health_timestamp','multi_source','source_hydrator','future_timestamp','invalid_operation_info','observation_horizon')),
 FOREIGN KEY(source_id,journal_id) REFERENCES argo_archive_journals(source_id,journal_id),
 UNIQUE(source_id,journal_id,sequence),
 UNIQUE(source_id,journal_id,seal_id),
 CHECK((kind='entry')=(sequence IS NOT NULL AND captured_at IS NOT NULL)),
 CHECK((kind='seal')=(seal_id IS NOT NULL)),
 CHECK(kind<>'entry' OR (receipt_id IS NOT NULL)<>(gap_reason IS NOT NULL))
);
CREATE INDEX argo_archive_cutoff ON argo_archive_records(source_id,journal_id,received_at);
CREATE TRIGGER immutable_argo_archive_records BEFORE UPDATE OR DELETE ON argo_archive_records FOR EACH ROW EXECUTE FUNCTION reject_deployment_mapping_mutation();
CREATE TABLE argo_receipt_authorities (
 receipt_id uuid NOT NULL REFERENCES argo_receipts(id),
 kind text NOT NULL CHECK(kind IN ('live','archive')),
 authority_id uuid NOT NULL,
 native_fingerprint text NOT NULL CHECK(native_fingerprint ~ '^[0-9a-f]{64}$'),
 archive_fingerprint text CHECK(archive_fingerprint ~ '^[0-9a-f]{64}$'),
 journal_id uuid,
 producer_id uuid,
 observed_at timestamptz NOT NULL,
 PRIMARY KEY(receipt_id,kind,authority_id),
 CHECK((kind='archive')=(archive_fingerprint IS NOT NULL AND journal_id IS NOT NULL AND producer_id IS NOT NULL))
);
CREATE UNIQUE INDEX one_live_argo_authority ON argo_receipt_authorities(receipt_id) WHERE kind='live';
CREATE TRIGGER immutable_argo_receipt_authorities BEFORE UPDATE OR DELETE ON argo_receipt_authorities FOR EACH ROW EXECUTE FUNCTION reject_deployment_mapping_mutation();
CREATE FUNCTION guard_argo_archive_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Archive journals are retained'; END IF;
 IF ROW(OLD.source_id,OLD.journal_id,OLD.producer_id,OLD.scope,OLD.policy_reference,OLD.startup_at,OLD.registered_at)
 IS DISTINCT FROM ROW(NEW.source_id,NEW.journal_id,NEW.producer_id,NEW.scope,NEW.policy_reference,NEW.startup_at,NEW.registered_at)
 THEN RAISE EXCEPTION 'Archive journal identity is immutable'; END IF;
 IF NEW.last_sequence<OLD.last_sequence OR NEW.sealed_sequence<OLD.sealed_sequence
 OR (OLD.last_capture_at IS NOT NULL AND (NEW.last_capture_at IS NULL OR NEW.last_capture_at<OLD.last_capture_at))
 OR (OLD.sealed_end IS NOT NULL AND (NEW.sealed_end IS NULL OR NEW.sealed_end<OLD.sealed_end))
 THEN RAISE EXCEPTION 'Archive journal progress cannot decrease'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER guarded_argo_archive_journal BEFORE UPDATE OR DELETE ON argo_archive_journals FOR EACH ROW EXECUTE FUNCTION guard_argo_archive_journal();
