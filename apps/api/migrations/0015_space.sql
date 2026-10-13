CREATE TABLE space_preferences (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  minimum_respondents integer NOT NULL DEFAULT 3 CHECK (minimum_respondents BETWEEN 3 AND 1000)
);
CREATE TABLE space_assignments (
  workspace_id uuid NOT NULL,
  user_id text NOT NULL,
  team_id uuid,
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id) ON DELETE SET NULL (team_id)
);
CREATE INDEX space_assignments_team_idx ON space_assignments(workspace_id, team_id);
CREATE TABLE space_assignment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES auth_users(id),
  team_id uuid,
  team_name text,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((team_id IS NULL) = (team_name IS NULL))
);
CREATE INDEX space_assignment_history_actor_idx ON space_assignment_history(workspace_id, user_id, changed_at DESC, id DESC);
CREATE FUNCTION space_record_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.team_id IS NOT NULL THEN
      INSERT INTO space_assignment_history(workspace_id,user_id,team_id,team_name)
      VALUES (OLD.workspace_id,OLD.user_id,NULL,NULL);
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.team_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.team_id IS NOT DISTINCT FROM OLD.team_id THEN RETURN NEW; END IF;
  INSERT INTO space_assignment_history(workspace_id,user_id,team_id,team_name)
  VALUES (NEW.workspace_id,NEW.user_id,NEW.team_id,
    (SELECT name FROM teams WHERE workspace_id=NEW.workspace_id AND id=NEW.team_id));
  RETURN NEW;
END;
$$;
CREATE TRIGGER space_assignment_history_trigger AFTER INSERT OR UPDATE OR DELETE ON space_assignments
FOR EACH ROW EXECUTE FUNCTION space_record_assignment();

CREATE TABLE space_pulses (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id uuid NOT NULL,
  current_team_id uuid,
  team_name text NOT NULL,
  instrument_version text NOT NULL CHECK (instrument_version = 'clio.space.pulse.v1'),
  reference_start timestamptz NOT NULL,
  reference_end timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','open','closed','cancelled')),
  minimum_respondents integer CHECK (minimum_respondents BETWEEN 3 AND 1000),
  roster_size integer CHECK (roster_size >= 0),
  submitted_count integer CHECK (submitted_count >= 0 AND submitted_count <= roster_size),
  questions jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  opened_at timestamptz,
  closed_at timestamptz,
  cancelled_at timestamptz,
  UNIQUE (workspace_id,id),
  FOREIGN KEY (workspace_id,current_team_id) REFERENCES teams(workspace_id,id) ON DELETE SET NULL (current_team_id),
  CHECK (current_team_id IS NULL OR current_team_id = team_id),
  CHECK (reference_start < reference_end),
  CHECK (reference_start = date_trunc('day',reference_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  CHECK (reference_end = date_trunc('day',reference_end AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  CHECK ((state = 'closed') = (questions IS NOT NULL)),
  CHECK ((state = 'closed') = (closed_at IS NOT NULL)),
  CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK ((state = 'closed') = (submitted_count IS NOT NULL)),
  CHECK (state = 'draft' OR (minimum_respondents IS NOT NULL AND roster_size IS NOT NULL)),
  CHECK (state NOT IN ('open','closed') OR (opened_at IS NOT NULL AND roster_size > 0))
);
CREATE UNIQUE INDEX space_one_open_team_idx ON space_pulses(workspace_id,team_id) WHERE state='open';
CREATE INDEX space_pulses_history_idx ON space_pulses(workspace_id,created_at DESC,id DESC);
CREATE TABLE space_roster (
  pulse_id uuid NOT NULL REFERENCES space_pulses(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES auth_users(id),
  PRIMARY KEY (pulse_id,user_id)
);
CREATE INDEX space_roster_user_idx ON space_roster(user_id,pulse_id);
CREATE TABLE space_receipts (
  pulse_id uuid NOT NULL,
  user_id text NOT NULL,
  PRIMARY KEY (pulse_id,user_id),
  FOREIGN KEY (pulse_id,user_id) REFERENCES space_roster(pulse_id,user_id) ON DELETE CASCADE
);
CREATE FUNCTION space_valid_answers(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(value) <> 'object' THEN false ELSE
    (SELECT count(*)=8 AND bool_and(key IN ('satisfaction','sustainable_workload','useful_outcomes','contribution_frequency','useful_help','shared_context','effective_tools','focus_time')
      AND (answer = 'null'::jsonb OR answer IN ('1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb,'5'::jsonb)))
    FROM jsonb_each(value) AS item(key,answer)) END;
$$;
CREATE TABLE space_answers (
  id uuid PRIMARY KEY,
  pulse_id uuid NOT NULL REFERENCES space_pulses(id) ON DELETE CASCADE,
  answers jsonb NOT NULL CHECK (space_valid_answers(answers))
);
CREATE INDEX space_answers_pulse_idx ON space_answers(pulse_id);
CREATE FUNCTION space_guard_team_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM space_pulses WHERE workspace_id=OLD.workspace_id AND team_id=OLD.id AND state IN ('draft','open')) THEN
    RAISE EXCEPTION 'conflict' USING ERRCODE='23503';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER space_team_delete_trigger BEFORE DELETE ON teams FOR EACH ROW EXECUTE FUNCTION space_guard_team_delete();
