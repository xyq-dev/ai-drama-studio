-- DRAFT ONLY: separately reviewed authorization is required before applying to a business database.
-- Additive library metadata. It does not rewrite projects, project versions, or existing classifications.
BEGIN;

CREATE TABLE project_library_category (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40 AND name = btrim(name)),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)
);
CREATE UNIQUE INDEX project_library_category_name_unique
  ON project_library_category (workspace_id, lower(name));

CREATE TABLE project_library_assignment (
  project_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  category_id uuid,
  revision integer NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, workspace_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES project(id, workspace_id),
  FOREIGN KEY (category_id, workspace_id) REFERENCES project_library_category(id, workspace_id)
);
CREATE INDEX project_library_assignment_category_idx
  ON project_library_assignment (workspace_id, category_id, project_id);
CREATE INDEX project_library_updated_idx ON project (workspace_id, updated_at DESC, id DESC);

COMMIT;
