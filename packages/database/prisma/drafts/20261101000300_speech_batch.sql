-- DRAFT ONLY. Explicit separate review/execution required; never an ordinary migration.
-- A bounded episode command receipt. Existing GenerationJob/Attempt/Asset remain the only task truth.
CREATE TABLE speech_batch_command (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, project_id uuid NOT NULL, episode_id uuid NOT NULL,
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200), idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'), source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  frozen_hash text NOT NULL CHECK (frozen_hash ~ '^[a-f0-9]{64}$'), frozen_json jsonb NOT NULL CHECK (octet_length(frozen_json::text) <= 2097152),
  state text NOT NULL DEFAULT 'quoted' CHECK (state IN ('quoted','dispatching','needs_attention','dispatched','canceled')),
  confirmation_json jsonb, confirmed_by text, confirmed_at timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false, cancel_requested_at timestamptz,
  dispatch_token uuid, lease_until timestamptz, row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id), UNIQUE (id, project_id, workspace_id), UNIQUE (workspace_id, project_id, episode_id, idempotency_key),
  FOREIGN KEY (episode_id, project_id, workspace_id) REFERENCES episode(id, project_id, workspace_id),
  CHECK ((dispatch_token IS NULL) = (lease_until IS NULL)),
  CHECK ((confirmation_json IS NULL) = (confirmed_by IS NULL) AND (confirmation_json IS NULL) = (confirmed_at IS NULL)),
  CHECK (state IN ('quoted','canceled') OR confirmation_json IS NOT NULL),
  CHECK ((state = 'canceled') = cancel_requested), CHECK (cancel_requested = (cancel_requested_at IS NOT NULL))
);
CREATE UNIQUE INDEX speech_batch_one_active_episode ON speech_batch_command(workspace_id,project_id,episode_id)
  WHERE state IN ('dispatching','needs_attention') AND NOT cancel_requested;
CREATE TABLE speech_batch_operation (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL, project_id uuid NOT NULL, batch_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 100), shot_revision_id uuid NOT NULL, line_input_revision_id uuid NOT NULL,
  quote_id uuid NOT NULL UNIQUE, idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  operation_hash text NOT NULL CHECK (operation_hash ~ '^[a-f0-9]{64}$'), frozen_json jsonb NOT NULL CHECK (octet_length(frozen_json::text) <= 2097152),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','working','job_created','unknown','blocked','canceled')),
  authorization_id uuid, job_id uuid UNIQUE, workflow_run_id uuid, error_code text CHECK (error_code IS NULL OR length(error_code) <= 100),
  dispatch_token uuid, lease_until timestamptz, row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, batch_id, workspace_id), UNIQUE (batch_id, ordinal), UNIQUE (batch_id, line_input_revision_id), UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (batch_id, project_id, workspace_id) REFERENCES speech_batch_command(id, project_id, workspace_id),
  FOREIGN KEY (shot_revision_id, project_id, workspace_id) REFERENCES shot_revision(id, project_id, workspace_id),
  FOREIGN KEY (line_input_revision_id, project_id, workspace_id) REFERENCES speech_line_input_revision(id, project_id, workspace_id),
  FOREIGN KEY (job_id, project_id, workspace_id) REFERENCES generation_job(id, project_id, workspace_id),
  FOREIGN KEY (job_id, workflow_run_id, workspace_id) REFERENCES generation_job(id, workflow_run_id, workspace_id),
  CHECK ((job_id IS NULL) = (workflow_run_id IS NULL)), CHECK ((state = 'job_created') = (job_id IS NOT NULL)),
  CHECK (job_id IS NULL OR authorization_id IS NOT NULL),
  CHECK ((dispatch_token IS NULL) = (lease_until IS NULL)), CHECK ((state = 'working') = (dispatch_token IS NOT NULL))
);
CREATE INDEX speech_batch_operation_dispatch_idx ON speech_batch_operation(workspace_id,batch_id,ordinal);
CREATE FUNCTION speech_batch_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'speech batch command receipts are retained'; END IF;
  IF NEW.row_version<>OLD.row_version+1 THEN RAISE EXCEPTION 'speech batch row version must advance'; END IF;
  IF TG_TABLE_NAME='speech_batch_command' THEN
    IF (to_jsonb(NEW)-ARRAY['state','confirmation_json','confirmed_by','confirmed_at','cancel_requested','cancel_requested_at','dispatch_token','lease_until','row_version','updated_at']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['state','confirmation_json','confirmed_by','confirmed_at','cancel_requested','cancel_requested_at','dispatch_token','lease_until','row_version','updated_at'])
       OR (OLD.confirmation_json IS NOT NULL AND (NEW.confirmation_json IS DISTINCT FROM OLD.confirmation_json
         OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at))
       OR (OLD.cancel_requested AND NOT NEW.cancel_requested)
       OR (OLD.cancel_requested_at IS NOT NULL AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at)
       OR (OLD.state IN ('dispatched','canceled') AND NEW.state<>OLD.state) THEN RAISE EXCEPTION 'speech batch frozen identity is immutable'; END IF;
    IF (OLD.state='quoted' AND NEW.state NOT IN ('quoted','dispatching','canceled'))
       OR (OLD.state IN ('dispatching','needs_attention') AND NEW.state NOT IN ('dispatching','needs_attention','dispatched','canceled')) THEN
      RAISE EXCEPTION 'speech batch state cannot skip confirmation or reopen';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['state','authorization_id','job_id','workflow_run_id','error_code','dispatch_token','lease_until','row_version','updated_at']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['state','authorization_id','job_id','workflow_run_id','error_code','dispatch_token','lease_until','row_version','updated_at'])
       OR (OLD.authorization_id IS NOT NULL AND NEW.authorization_id IS DISTINCT FROM OLD.authorization_id)
       OR (OLD.job_id IS NOT NULL AND (NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.workflow_run_id IS DISTINCT FROM OLD.workflow_run_id OR NEW.state<>'job_created'))
       OR (OLD.state='canceled' AND NEW.state<>'canceled') THEN RAISE EXCEPTION 'speech batch operation identity is immutable'; END IF;
    IF (OLD.state='pending' AND NEW.state NOT IN ('pending','working','canceled'))
       OR (OLD.state='working' AND NEW.state NOT IN ('working','job_created','unknown','blocked','canceled'))
       OR (OLD.state='unknown' AND NEW.state NOT IN ('unknown','working','canceled'))
       OR (OLD.state='blocked' AND NEW.state NOT IN ('blocked','canceled')) THEN
      RAISE EXCEPTION 'speech batch operation state cannot be reset or silently retried';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER speech_batch_identity_guard BEFORE UPDATE OR DELETE ON speech_batch_command FOR EACH ROW EXECUTE FUNCTION speech_batch_identity_guard();
CREATE TRIGGER speech_batch_identity_guard BEFORE UPDATE OR DELETE ON speech_batch_operation FOR EACH ROW EXECUTE FUNCTION speech_batch_identity_guard();
COMMENT ON TABLE speech_batch_command IS 'ads.speech.batch.storage.v1';
COMMENT ON TABLE speech_batch_operation IS 'ads.speech.batch.storage.v1';
-- No paid submission, existing Job cancellation, business backfill, provisioning or automatic execution.
