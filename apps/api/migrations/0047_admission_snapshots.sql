-- Admission epochs are independent of PostgreSQL configuration and power generations.
CREATE TABLE database_admission_epochs (
  database_id TEXT PRIMARY KEY REFERENCES databases(id) ON DELETE CASCADE,
  admission_revision INTEGER NOT NULL DEFAULT 1 CHECK(admission_revision>0),
  route_revision INTEGER NOT NULL DEFAULT 1 CHECK(route_revision>0),
  mutation_id TEXT,
  mutation_started_at TEXT,
  mutation_status TEXT CHECK(mutation_status IN('pending','fenced')),
  completed_mutation_id TEXT,
  mutation_outcome TEXT CHECK(mutation_outcome IN('committed','fenced')),
  CHECK((mutation_id IS NULL)=(mutation_started_at IS NULL))
);
INSERT INTO database_admission_epochs(database_id) SELECT id FROM databases;

-- A scope fence prevents new membership while its existing Actors are being closed.
CREATE TABLE admission_scope_fences (
  kind TEXT NOT NULL CHECK(kind IN('project','region','node')),
  scope_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  region_id TEXT REFERENCES regions(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  mutation_id TEXT,
  mutation_started_at TEXT,
  mutation_status TEXT CHECK(mutation_status IN('pending','fenced')),
  PRIMARY KEY(kind,scope_id),
  CHECK((kind='project' AND project_id=scope_id AND region_id IS NULL AND node_id IS NULL)
    OR (kind='region' AND region_id=scope_id AND project_id IS NULL AND node_id IS NULL)
    OR (kind='node' AND node_id=scope_id AND project_id IS NULL AND region_id IS NULL)),
  CHECK((mutation_id IS NULL)=(mutation_started_at IS NULL))
);
INSERT INTO admission_scope_fences(kind,scope_id,project_id) SELECT 'project',id,id FROM projects;
INSERT INTO admission_scope_fences(kind,scope_id,region_id) SELECT 'region',id,id FROM regions;
INSERT INTO admission_scope_fences(kind,scope_id,node_id) SELECT 'node',id,id FROM nodes;
