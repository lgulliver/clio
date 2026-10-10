ALTER TABLE services ADD CONSTRAINT services_workspace_id_id_key UNIQUE (workspace_id, id);

CREATE TABLE deployment_mapping_revisions (
  workspace_id uuid NOT NULL,
  service_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode = 'mock'),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  primary_provider text NOT NULL CHECK (primary_provider IN ('github', 'argocd')),
  production_environment text NOT NULL CHECK (length(production_environment) BETWEEN 1 AND 200 AND production_environment = btrim(production_environment, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')),
  exposure_attested boolean NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by text NOT NULL REFERENCES auth_users(id),
  PRIMARY KEY (workspace_id, service_id, revision),
  FOREIGN KEY (workspace_id, service_id) REFERENCES services(workspace_id, id)
);

CREATE FUNCTION reject_deployment_mapping_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Deployment mapping revisions are immutable';
END;
$$;
CREATE TRIGGER immutable_deployment_mapping_revisions
BEFORE UPDATE OR DELETE ON deployment_mapping_revisions
FOR EACH ROW EXECUTE FUNCTION reject_deployment_mapping_mutation();
