-- Private audit records. Unlike domain events, these are never delivered to creator SSE clients.
CREATE TABLE admin_work_action (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  project_version integer NOT NULL CHECK (project_version > 1),
  archived_at timestamptz NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  title text NOT NULL,
  action text NOT NULL CHECK (action IN ('trash', 'restore')),
  actor_kind text NOT NULL CHECK (actor_kind IN ('admin', 'creator')),
  actor text NOT NULL CHECK (length(btrim(actor)) BETWEEN 1 AND 200),
  reason text CHECK (length(btrim(reason)) BETWEEN 1 AND 400),
  CHECK (action <> 'trash' OR actor_kind <> 'admin' OR reason IS NOT NULL),
  UNIQUE(workspace_id, project_id, project_version),
  FOREIGN KEY (project_id, workspace_id) REFERENCES project(id, workspace_id)
);
CREATE INDEX admin_work_action_archive_idx ON admin_work_action(workspace_id, project_id, archived_at)
  WHERE action = 'trash';
CREATE INDEX admin_work_action_recent_idx ON admin_work_action(workspace_id, occurred_at DESC, id DESC)
  WHERE actor_kind = 'admin';

-- A task racing with a delete must take the same project row lock. Install on standard
-- and already installed optional producers; the workbench draft uses the same guards.
CREATE OR REPLACE FUNCTION script_workbench_require_active_project() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active boolean;
BEGIN
  SELECT status='ACTIVE' AND archived_at IS NULL INTO active FROM project
    WHERE id=NEW.project_id AND workspace_id=NEW.workspace_id FOR UPDATE;
  -- Leave a missing/mismatched parent to the original composite foreign key.
  IF active IS FALSE THEN RAISE EXCEPTION 'Project is archived' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE rel text; BEGIN
  FOREACH rel IN ARRAY ARRAY['workflow_run','generation_job','title_writing_run','auto_creation_run',
    'series_writing_run','writing_candidate_request','vimax_planning_request','story_revision','script_revision'] LOOP
    IF to_regclass(rel) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('CREATE OR REPLACE TRIGGER workbench_active_project_insert BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION script_workbench_require_active_project()', rel);
    IF rel IN ('title_writing_run','auto_creation_run','series_writing_run','writing_candidate_request','vimax_planning_request') THEN
      EXECUTE format('CREATE OR REPLACE TRIGGER workbench_active_project_resume BEFORE UPDATE OF state ON %I FOR EACH ROW WHEN (NEW.state IN (''running'',''reserved'',''submitted'')) EXECUTE FUNCTION script_workbench_require_active_project()', rel);
    END IF;
  END LOOP;
END $$;
CREATE TRIGGER admin_workflow_resume BEFORE UPDATE OF status ON workflow_run
  FOR EACH ROW WHEN (NEW.status IN ('PENDING','RUNNING') AND OLD.status NOT IN ('PENDING','RUNNING'))
  EXECUTE FUNCTION script_workbench_require_active_project();
CREATE TRIGGER admin_generation_resume BEFORE UPDATE OF state ON generation_job
  FOR EACH ROW WHEN (NEW.state IN ('PENDING','QUEUED','RUNNING','WAITING_EXTERNAL') AND OLD.state NOT IN ('PENDING','QUEUED','RUNNING','WAITING_EXTERNAL'))
  EXECUTE FUNCTION script_workbench_require_active_project();

-- Only existing built-in super administrators receive destructive work management access.
UPDATE staff_role
SET permissions = array_append(permissions, 'manage_works'), updated_at = now()
WHERE built_in AND code = 'super_admin' AND NOT ('manage_works' = ANY(permissions));
