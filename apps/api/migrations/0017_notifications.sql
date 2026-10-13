-- Logical events/deduplication outlive private transport attempts. No answers or
-- respondent-to-answer mapping is added by this subsystem.
CREATE TABLE notification_policies (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  enabled boolean NOT NULL DEFAULT false,
  invitations boolean NOT NULL DEFAULT true,
  closures boolean NOT NULL DEFAULT true,
  reminders boolean NOT NULL DEFAULT true,
  first_reminder_hours integer NOT NULL DEFAULT 48 CHECK (first_reminder_hours BETWEEN 24 AND 168),
  repeat_hours integer NOT NULL DEFAULT 72 CHECK (repeat_hours BETWEEN 24 AND 168),
  maximum_reminders integer NOT NULL DEFAULT 2 CHECK (maximum_reminders BETWEEN 1 AND 3),
  grant_fingerprint text CHECK (grant_fingerprint ~ '^[0-9a-f]{64}$'),
  slack_team_id text CHECK (slack_team_id ~ '^T[A-Z0-9]+$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (NOT enabled OR grant_fingerprint IS NOT NULL),
  CHECK (slack_team_id IS NULL OR grant_fingerprint IS NOT NULL)
);
CREATE TABLE notification_pulse_policies (
  workspace_id uuid NOT NULL,
  pulse_id uuid NOT NULL,
  policy_revision integer NOT NULL CHECK (policy_revision >= 0),
  enabled boolean NOT NULL,
  invitations boolean NOT NULL,
  closures boolean NOT NULL,
  reminders boolean NOT NULL,
  first_reminder_hours integer NOT NULL CHECK (first_reminder_hours BETWEEN 24 AND 168),
  repeat_hours integer NOT NULL CHECK (repeat_hours BETWEEN 24 AND 168),
  maximum_reminders integer NOT NULL CHECK (maximum_reminders BETWEEN 1 AND 3),
  grant_fingerprint text CHECK (grant_fingerprint ~ '^[0-9a-f]{64}$'),
  opened_at timestamptz NOT NULL,
  reminders_enabled boolean NOT NULL,
  reminder_revision integer NOT NULL DEFAULT 0 CHECK (reminder_revision >= 0),
  scheduler_slot integer NOT NULL DEFAULT 0 CHECK (scheduler_slot BETWEEN 0 AND 3),
  scheduler_active_slot integer CHECK (scheduler_active_slot BETWEEN 1 AND 3),
  scheduler_recipient_cursor text CHECK (length(scheduler_recipient_cursor) BETWEEN 1 AND 512 AND scheduler_recipient_cursor !~ '[[:cntrl:][:space:]]'),
  last_manual_at timestamptz,
  cancelled_at timestamptz,
  PRIMARY KEY (workspace_id,pulse_id),
  UNIQUE (workspace_id,pulse_id,policy_revision,grant_fingerprint),
  FOREIGN KEY (workspace_id,pulse_id) REFERENCES space_pulses(workspace_id,id) ON DELETE CASCADE,
  CHECK (NOT enabled OR grant_fingerprint IS NOT NULL),
  CHECK (NOT reminders_enabled OR (enabled AND reminders AND cancelled_at IS NULL)),
  CHECK (scheduler_slot <= maximum_reminders),
  CHECK (scheduler_active_slot IS NULL OR (scheduler_active_slot > scheduler_slot AND scheduler_active_slot <= maximum_reminders)),
  CHECK (scheduler_active_slot IS NOT NULL OR scheduler_recipient_cursor IS NULL)
);
CREATE FUNCTION notification_freeze_pulse_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.workspace_id,NEW.pulse_id,NEW.policy_revision,NEW.enabled,NEW.invitations,NEW.closures,NEW.reminders,NEW.first_reminder_hours,NEW.repeat_hours,NEW.maximum_reminders,NEW.grant_fingerprint,NEW.opened_at)
    IS DISTINCT FROM ROW(OLD.workspace_id,OLD.pulse_id,OLD.policy_revision,OLD.enabled,OLD.invitations,OLD.closures,OLD.reminders,OLD.first_reminder_hours,OLD.repeat_hours,OLD.maximum_reminders,OLD.grant_fingerprint,OLD.opened_at)
    OR (NOT OLD.reminders_enabled AND NEW.reminders_enabled)
    OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at)
    OR NEW.scheduler_slot < OLD.scheduler_slot OR NEW.reminder_revision < OLD.reminder_revision
    OR (NEW.scheduler_active_slot < OLD.scheduler_active_slot)
    OR (NEW.scheduler_active_slot=OLD.scheduler_active_slot AND OLD.scheduler_recipient_cursor IS NOT NULL AND (NEW.scheduler_recipient_cursor IS NULL OR NEW.scheduler_recipient_cursor<OLD.scheduler_recipient_cursor))
    OR (NEW.scheduler_active_slot IS DISTINCT FROM OLD.scheduler_active_slot AND NEW.scheduler_recipient_cursor IS NOT NULL) THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER notification_freeze_pulse_policy_trigger BEFORE UPDATE ON notification_pulse_policies
FOR EACH ROW EXECUTE FUNCTION notification_freeze_pulse_policy();
CREATE TABLE notification_batches (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  pulse_id uuid,
  created_by text NOT NULL REFERENCES auth_users(id),
  kind text NOT NULL CHECK (kind IN ('remind','retry','test')),
  channel text CHECK (channel IN ('slack','email')),
  input jsonb NOT NULL CHECK (jsonb_typeof(input)='object'),
  queued boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,request_id),
  UNIQUE (workspace_id,request_id,created_by,channel),
  FOREIGN KEY (workspace_id,pulse_id) REFERENCES notification_pulse_policies(workspace_id,pulse_id) ON DELETE CASCADE,
  CHECK ((kind='test') = (pulse_id IS NULL)),
  CHECK ((kind='test') = (channel IS NOT NULL))
);
CREATE FUNCTION notification_freeze_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.workspace_id,NEW.request_id,NEW.pulse_id,NEW.created_by,NEW.kind,NEW.channel,NEW.input,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.workspace_id,OLD.request_id,OLD.pulse_id,OLD.created_by,OLD.kind,OLD.channel,OLD.input,OLD.created_at)
    OR (OLD.queued AND NOT NEW.queued) THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER notification_freeze_batch_trigger BEFORE UPDATE ON notification_batches
FOR EACH ROW EXECUTE FUNCTION notification_freeze_batch();
CREATE INDEX notification_test_cooldown_idx ON notification_batches(workspace_id,created_by,channel,created_at DESC) WHERE kind='test';
CREATE TABLE notification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pulse_id uuid,
  user_id text NOT NULL REFERENCES auth_users(id),
  kind text NOT NULL CHECK (kind IN ('invitation','reminder','closure','test')),
  occurrence_key text NOT NULL CHECK (length(occurrence_key) BETWEEN 1 AND 64),
  reminder_slot integer CHECK (reminder_slot BETWEEN 1 AND 3),
  policy_revision integer NOT NULL CHECK (policy_revision >= 0),
  grant_fingerprint text NOT NULL CHECK (grant_fingerprint ~ '^[0-9a-f]{64}$'),
  request_id uuid,
  test_request_id uuid,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','retry_scheduled','provider_accepted','skipped','failed','uncertain')),
  channel text CHECK (channel IN ('slack','email')),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  terminal_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  slack_attempts integer NOT NULL DEFAULT 0 CHECK (slack_attempts BETWEEN 0 AND 3),
  email_attempts integer NOT NULL DEFAULT 0 CHECK (email_attempts BETWEEN 0 AND 3),
  uncertain_replays integer NOT NULL DEFAULT 0 CHECK (uncertain_replays BETWEEN 0 AND 1),
  reason text CHECK (reason IN ('response_received','access_removed','pulse_inactive','integration_disabled','reminders_disabled','expired','no_destination','missed_slot','recipient_unavailable','provider_unavailable','configuration_invalid','acceptance_unknown')),
  UNIQUE (workspace_id,id),
  UNIQUE (workspace_id,pulse_id,user_id,kind,occurrence_key),
  UNIQUE (workspace_id,pulse_id,user_id,reminder_slot),
  FOREIGN KEY (workspace_id,pulse_id,policy_revision,grant_fingerprint) REFERENCES notification_pulse_policies(workspace_id,pulse_id,policy_revision,grant_fingerprint) ON DELETE CASCADE,
  FOREIGN KEY (pulse_id,user_id) REFERENCES space_roster(pulse_id,user_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,request_id) REFERENCES notification_batches(workspace_id,request_id),
  FOREIGN KEY (workspace_id,test_request_id,user_id,channel) REFERENCES notification_batches(workspace_id,request_id,created_by,channel),
  CHECK ((kind='test') = (pulse_id IS NULL)),
  CHECK (expires_at IS NOT NULL OR kind='invitation'),
  CHECK (kind<>'test' OR (test_request_id IS NOT NULL AND request_id IS NOT NULL AND test_request_id=request_id)),
  CHECK (kind='test' OR test_request_id IS NULL),
  CHECK ((state='leased') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (lease_until IS NULL OR (lease_until > created_at AND lease_until <= updated_at+interval '120 seconds')),
  CHECK ((state IN ('provider_accepted','skipped','failed','uncertain')) = (terminal_at IS NOT NULL)),
  CHECK (state NOT IN ('provider_accepted','uncertain') OR channel IS NOT NULL),
  CHECK (kind<>'test' OR channel IS NOT NULL),
  CHECK (kind='reminder' OR reminder_slot IS NULL),
  CHECK (kind<>'reminder' OR reminder_slot IS NOT NULL OR (state='skipped' AND reason IS NOT NULL AND reason='missed_slot')),
  CHECK ((kind='invitation' AND occurrence_key='open') OR (kind='closure' AND occurrence_key='close') OR
    (kind='test' AND occurrence_key='manual:'||request_id::text) OR
    (kind='reminder' AND (occurrence_key ~ '^auto:[1-3]$' OR (request_id IS NOT NULL AND occurrence_key='manual:'||request_id::text))))
);
CREATE FUNCTION notification_guard_reminder() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE maximum integer;
BEGIN
  IF NEW.kind='reminder' THEN
    SELECT maximum_reminders INTO maximum FROM notification_pulse_policies
      WHERE workspace_id=NEW.workspace_id AND pulse_id=NEW.pulse_id;
    IF maximum IS NULL OR NEW.reminder_slot > maximum
      OR (NEW.occurrence_key ~ '^auto:[1-3]$' AND split_part(NEW.occurrence_key,':',2)::integer > maximum) THEN
      RAISE EXCEPTION 'conflict' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER notification_guard_reminder_trigger BEFORE INSERT ON notification_events
FOR EACH ROW EXECUTE FUNCTION notification_guard_reminder();
CREATE UNIQUE INDEX notification_test_request_idx ON notification_events(workspace_id,request_id) WHERE kind='test';
CREATE INDEX notification_events_claim_idx ON notification_events(available_at,id) WHERE state IN ('pending','retry_scheduled');
CREATE INDEX notification_events_lease_idx ON notification_events(lease_until,id) WHERE state='leased';
CREATE INDEX notification_events_terminal_idx ON notification_events(terminal_at,id) WHERE terminal_at IS NOT NULL;
CREATE INDEX notification_events_own_idx ON notification_events(workspace_id,user_id,created_at DESC,id DESC);
CREATE INDEX notification_events_pulse_idx ON notification_events(workspace_id,pulse_id,state);
CREATE FUNCTION notification_freeze_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.workspace_id,NEW.pulse_id,NEW.user_id,NEW.kind,NEW.occurrence_key,NEW.reminder_slot,NEW.policy_revision,NEW.grant_fingerprint,NEW.request_id,NEW.test_request_id,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.pulse_id,OLD.user_id,OLD.kind,OLD.occurrence_key,OLD.reminder_slot,OLD.policy_revision,OLD.grant_fingerprint,OLD.request_id,OLD.test_request_id,OLD.created_at,OLD.expires_at)
    OR (OLD.state IN ('provider_accepted','skipped') AND NEW.state IS DISTINCT FROM OLD.state)
    OR (OLD.kind='test' AND NEW.channel IS DISTINCT FROM OLD.channel)
    OR (OLD.state='uncertain' AND NEW.state='failed')
    OR (OLD.state='uncertain' AND NEW.state IN ('pending','leased','retry_scheduled') AND NEW.uncertain_replays<>OLD.uncertain_replays+1)
    OR NEW.slack_attempts < OLD.slack_attempts OR NEW.email_attempts < OLD.email_attempts OR NEW.uncertain_replays < OLD.uncertain_replays THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER notification_freeze_event_trigger BEFORE UPDATE ON notification_events
FOR EACH ROW EXECUTE FUNCTION notification_freeze_event();
CREATE TABLE notification_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  event_id uuid NOT NULL,
  lease_token uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('slack','email')),
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  grant_fingerprint text NOT NULL CHECK (grant_fingerprint ~ '^[0-9a-f]{64}$'),
  credential_fingerprint text NOT NULL CHECK (credential_fingerprint ~ '^[0-9a-f]{64}$'),
  binding_revision integer CHECK (binding_revision >= 1),
  slack_team_id text CHECK (slack_team_id ~ '^T[A-Z0-9]+$'),
  slack_user_id text CHECK (slack_user_id ~ '^[UW][A-Z0-9]+$'),
  email text CHECK (length(email) BETWEEN 3 AND 254 AND email !~ '[[:cntrl:][:space:]]' AND email ~ '^[^@]+@[^@]+\.[^@]+$'),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  outcome text CHECK (outcome IN ('accepted','not_accepted','uncertain','not_submitted')),
  reason text CHECK (reason IN ('recipient_unavailable','provider_unavailable','configuration_invalid','acceptance_unknown')),
  retryable boolean,
  retry_after_ms bigint CHECK (retry_after_ms >= 0),
  UNIQUE (event_id,channel,attempt_number),
  FOREIGN KEY (workspace_id,event_id) REFERENCES notification_events(workspace_id,id) ON DELETE CASCADE,
  CHECK ((completed_at IS NULL) = (outcome IS NULL)),
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  CHECK ((channel='slack' AND binding_revision IS NOT NULL AND slack_team_id IS NOT NULL AND slack_user_id IS NOT NULL AND email IS NULL)
    OR (channel='email' AND binding_revision IS NULL AND slack_team_id IS NULL AND slack_user_id IS NULL AND email IS NOT NULL)),
  CHECK (outcome IS NULL OR (outcome='accepted' AND reason IS NULL AND retryable IS NULL AND retry_after_ms IS NULL)
    OR (outcome='uncertain' AND reason IS NOT NULL AND reason='acceptance_unknown' AND retryable IS NULL AND retry_after_ms IS NULL)
    OR (outcome='not_accepted' AND reason IS NOT NULL AND reason<>'acceptance_unknown' AND retryable IS NOT NULL)
    OR (outcome='not_submitted' AND retry_after_ms IS NULL))
);
CREATE FUNCTION notification_guard_test_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM notification_events e WHERE e.workspace_id=NEW.workspace_id AND e.id=NEW.event_id AND e.kind='test' AND e.channel<>NEW.channel) THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER notification_guard_test_attempt_trigger BEFORE INSERT ON notification_attempts
FOR EACH ROW EXECUTE FUNCTION notification_guard_test_attempt();
CREATE INDEX notification_attempts_retention_idx ON notification_attempts(event_id,completed_at);
CREATE TABLE notification_slack_bindings (
  workspace_id uuid NOT NULL,
  user_id text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  team_id text CHECK (team_id ~ '^T[A-Z0-9]+$'),
  slack_user_id text CHECK (slack_user_id ~ '^[UW][A-Z0-9]+$'),
  grant_fingerprint text CHECK (grant_fingerprint ~ '^[0-9a-f]{64}$'),
  linked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,user_id),
  UNIQUE (workspace_id,team_id,slack_user_id),
  FOREIGN KEY (workspace_id,user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE CASCADE,
  CHECK ((team_id IS NULL AND slack_user_id IS NULL AND grant_fingerprint IS NULL AND linked_at IS NULL)
    OR (team_id IS NOT NULL AND slack_user_id IS NOT NULL AND grant_fingerprint IS NOT NULL AND linked_at IS NOT NULL))
);
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_id_user_unique UNIQUE(id,user_id);
CREATE TABLE notification_oauth_states (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  nonce_hash text NOT NULL CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  workspace_id uuid NOT NULL,
  user_id text NOT NULL,
  session_id text NOT NULL,
  team_id text NOT NULL CHECK (team_id ~ '^T[A-Z0-9]+$'),
  grant_fingerprint text NOT NULL CHECK (grant_fingerprint ~ '^[0-9a-f]{64}$'),
  credential_fingerprint text NOT NULL CHECK (credential_fingerprint ~ '^[0-9a-f]{64}$'),
  binding_revision integer NOT NULL CHECK (binding_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (statement_timestamp()+interval '5 minutes'),
  consumed_at timestamptz,
  FOREIGN KEY (workspace_id,user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id,user_id) REFERENCES auth_sessions(id,user_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at AND expires_at <= created_at+interval '5 minutes'),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);
CREATE INDEX notification_oauth_expiry_idx ON notification_oauth_states(expires_at);
-- Stable provider pacing survives grant/password rotation and worker restarts.
CREATE TABLE notification_slack_budgets (
  team_id text PRIMARY KEY CHECK (team_id ~ '^T[A-Z0-9]+$'),
  next_send_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE notification_slack_cooldowns (
  team_id text NOT NULL REFERENCES notification_slack_budgets(team_id),
  method text NOT NULL CHECK (method IN ('conversations.open','chat.postMessage','auth.test')),
  blocked_until timestamptz NOT NULL,
  PRIMARY KEY (team_id,method)
);
CREATE TABLE notification_smtp_budgets (
  pacing_key text PRIMARY KEY CHECK (pacing_key ~ '^[0-9a-f]{64}$'),
  window_start timestamptz NOT NULL DEFAULT clock_timestamp(),
  used integer NOT NULL DEFAULT 0 CHECK (used BETWEEN 0 AND 60),
  next_send_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
