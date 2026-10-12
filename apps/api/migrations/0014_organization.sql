CREATE TABLE teams (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200 AND name = btrim(name, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, name)
);

CREATE TABLE products (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  team_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200 AND name = btrim(name, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, name),
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id)
);

ALTER TABLE services ADD COLUMN product_id uuid;
ALTER TABLE services ADD CONSTRAINT services_product_workspace_fk
  FOREIGN KEY (workspace_id, product_id) REFERENCES products(workspace_id, id);
CREATE INDEX products_team_idx ON products(workspace_id, team_id);
CREATE INDEX services_product_idx ON services(workspace_id, product_id);
