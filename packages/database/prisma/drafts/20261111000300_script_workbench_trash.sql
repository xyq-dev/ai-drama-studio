-- DRAFT ONLY. Explicit isolated acceptance is permitted; no business or production migration is authorized.
-- Not discovered by runMigrations. Requires the base text, workflow and asset migrations.
-- Reversible archive only. Revision content and permanent production provenance stay immutable.
ALTER TABLE script_revision ADD COLUMN deleted_at timestamptz;
ALTER TABLE script_revision ADD COLUMN deleted_by text;
ALTER TABLE script_revision ADD CONSTRAINT script_revision_deleted_actor_check
  CHECK ((deleted_at IS NULL) = (deleted_by IS NULL));
CREATE INDEX script_revision_trash_idx ON script_revision (workspace_id, deleted_at DESC, id) WHERE deleted_at IS NOT NULL;
CREATE INDEX project_trash_idx ON project (workspace_id, archived_at DESC, id) WHERE archived_at IS NOT NULL;

-- Serialize new work against the same project lock used by archive. Archiving is refused while any work is active.
-- This also prevents alternate API paths or a background resume from starting work after archive.
CREATE FUNCTION script_workbench_require_active_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM project WHERE id = NEW.project_id AND workspace_id = NEW.workspace_id
    AND archived_at IS NULL AND status = 'ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Project is archived or unavailable' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE relation_name text; BEGIN
  FOREACH relation_name IN ARRAY ARRAY['workflow_run', 'generation_job', 'title_writing_run', 'auto_creation_run',
    'series_writing_run', 'writing_candidate_request', 'vimax_planning_request', 'story_revision', 'script_revision'] LOOP
    IF to_regclass(relation_name) IS NOT NULL THEN
      EXECUTE format('CREATE TRIGGER workbench_active_project_insert BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION script_workbench_require_active_project()', relation_name);
    END IF;
  END LOOP;
  FOREACH relation_name IN ARRAY ARRAY['title_writing_run', 'auto_creation_run', 'series_writing_run', 'writing_candidate_request', 'vimax_planning_request'] LOOP
    IF to_regclass(relation_name) IS NOT NULL THEN
      EXECUTE format('CREATE TRIGGER workbench_active_project_resume BEFORE UPDATE OF state ON %I FOR EACH ROW WHEN (NEW.state IN (''running'', ''reserved'', ''submitted'')) EXECUTE FUNCTION script_workbench_require_active_project()', relation_name);
    END IF;
  END LOOP;
END $$;
