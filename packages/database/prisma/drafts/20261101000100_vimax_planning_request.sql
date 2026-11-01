-- DRAFT ONLY: opt-in ViMax single-scene text planning. Never discovered by runMigrations or applied at startup.
-- No business database execution is authorized by this file. Requires the reviewed E2-B candidate draft plus base
-- migrations/script breakdown. Expansion only; keep permanent receipts on rollback and use forward fixes.
-- Reservations (including proven-unsent canceled/rejected) conservatively occupy the shared 24h cap. This is not a
-- sent/charged counter. Unknown results never release their slot, resume, retry or switch providers.
DO $$ BEGIN
  IF obj_description(to_regclass('vimax_storyboard_candidate'), 'pg_class') IS DISTINCT FROM 'ads.vimax-candidate.storage.v1'
    OR (SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema()
      AND table_name='title_writing_run' AND column_name IN ('run_kind','episode_id')) <> 2 THEN
    RAISE EXCEPTION 'ViMax planning draft requires E2-B candidate storage and script breakdown' USING ERRCODE='check_violation';
  END IF;
END $$;
CREATE TABLE vimax_planning_request (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  frozen_hash text NOT NULL CHECK (frozen_hash ~ '^[a-f0-9]{64}$'),
  frozen_json jsonb NOT NULL CHECK (jsonb_typeof(frozen_json) IS NOT DISTINCT FROM 'object'
    AND (frozen_json->>'schema') IS NOT DISTINCT FROM 'ads.vimax-planning.frozen.v1'
    AND (frozen_json->>'promptVersion') IS NOT DISTINCT FROM 'ads.vimax-planning.prompt.v1'
    AND frozen_json->'budget' IS NOT DISTINCT FROM '{"maxCalls":1,"maxOutputTokens":4096,"timeoutMs":120000}'::jsonb
    AND octet_length(frozen_json::text)<=1572864),
  source_script_revision_id uuid NOT NULL,
  scene_id uuid NOT NULL,
  baseline_scene_revision_id uuid NOT NULL,
  baseline_scene_row_version integer NOT NULL CHECK (baseline_scene_row_version>0),
  provider_key text NOT NULL CHECK (provider_key IN ('openai','anthropic','deepseek')),
  model text NOT NULL CHECK (model ~ '^[A-Za-z0-9._:-]{1,128}$'),
  state text NOT NULL CHECK (state IN ('reserved','submitted','completed','rejected','unknown')),
  executor_id text,
  lease_until timestamptz,
  submitted_at timestamptz,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Za-z0-9_]{1,200}$'),
  provider_request_id text CHECK (provider_request_id IS NULL OR provider_request_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  response_model text CHECK (response_model IS NULL OR response_model ~ '^[A-Za-z0-9_.:/-]{1,128}$'),
  usage_json jsonb NOT NULL CHECK (jsonb_typeof(usage_json) IS NOT DISTINCT FROM 'object'
    AND usage_json ?& ARRAY['status','inputTokens','outputTokens','totalTokens']
    AND usage_json-ARRAY['status','inputTokens','outputTokens','totalTokens']::text[] = '{}'::jsonb
    AND ((usage_json->>'status') IS NOT DISTINCT FROM 'present' OR (usage_json->>'status') IS NOT DISTINCT FROM 'unknown')
    AND (usage_json->'inputTokens'='null'::jsonb OR (usage_json->>'inputTokens') ~ '^[0-9]+$')
    AND (usage_json->'outputTokens'='null'::jsonb OR (usage_json->>'outputTokens') ~ '^[0-9]+$')
    AND (usage_json->'totalTokens'='null'::jsonb OR (usage_json->>'totalTokens') ~ '^[0-9]+$')),
  billing_status text NOT NULL DEFAULT 'unknown' CHECK (billing_status='unknown'),
  output_json jsonb CHECK (output_json IS NULL OR (jsonb_typeof(output_json) IS NOT DISTINCT FROM 'object'
    AND (output_json->>'schema') IS NOT DISTINCT FROM 'ads.vimax-candidate.create.v1' AND octet_length(output_json::text)<=1572864)),
  created_at timestamptz NOT NULL,
  finished_at timestamptz,
  UNIQUE (workspace_id,actor_id,idempotency_key),
  FOREIGN KEY (source_script_revision_id,episode_id,project_id,workspace_id) REFERENCES script_revision(id,episode_id,project_id,workspace_id),
  FOREIGN KEY (scene_id,episode_id,project_id,workspace_id) REFERENCES scene(id,episode_id,project_id,workspace_id),
  FOREIGN KEY (baseline_scene_revision_id,scene_id,project_id,workspace_id) REFERENCES scene_revision(id,scene_id,project_id,workspace_id),
  CHECK ((frozen_json#>>'{source,projectId}') IS NOT DISTINCT FROM project_id::text
    AND (frozen_json#>>'{source,episodeId}') IS NOT DISTINCT FROM episode_id::text
    AND (frozen_json#>>'{source,scriptRevisionId}') IS NOT DISTINCT FROM source_script_revision_id::text
    AND (frozen_json#>>'{target,sceneId}') IS NOT DISTINCT FROM scene_id::text
    AND (frozen_json#>>'{target,sceneRevisionId}') IS NOT DISTINCT FROM baseline_scene_revision_id::text
    AND (frozen_json#>>'{target,rowVersion}') IS NOT DISTINCT FROM baseline_scene_row_version::text
    AND (frozen_json#>>'{request,target,sceneId}') IS NOT DISTINCT FROM scene_id::text
    AND (frozen_json#>>'{request,target,sceneRevisionId}') IS NOT DISTINCT FROM baseline_scene_revision_id::text
    AND (frozen_json#>>'{request,target,rowVersion}') IS NOT DISTINCT FROM baseline_scene_row_version::text
    AND (frozen_json#>>'{request,source,scriptRevisionId}') IS NOT DISTINCT FROM source_script_revision_id::text
    AND (frozen_json#>>'{request,confirmedTextSend}') IS NOT DISTINCT FROM 'true'
    AND (frozen_json->>'providerKey') IS NOT DISTINCT FROM provider_key AND (frozen_json->>'model') IS NOT DISTINCT FROM model),
  CHECK ((state IN ('reserved','submitted')) = (executor_id IS NOT NULL)),
  CHECK ((executor_id IS NULL) = (lease_until IS NULL)),
  CHECK ((state IN ('reserved','submitted')) = (finished_at IS NULL)),
  CHECK ((state='completed') = (output_json IS NOT NULL)),
  CHECK ((state='completed') = (error_code IS NULL) OR state IN ('reserved','submitted')),
  CHECK (state<>'reserved' OR submitted_at IS NULL),
  CHECK (state NOT IN ('submitted','completed','unknown') OR submitted_at IS NOT NULL),
  CHECK (submitted_at IS NULL OR submitted_at>=created_at),
  CHECK (finished_at IS NULL OR finished_at>=created_at),
  CHECK (state<>'rejected' OR submitted_at IS NOT NULL OR error_code IN
    ('invalid_input_before_send','provider_unconfigured_before_send','source_changed_before_send','executor_lost_before_send','canceled_before_send'))
);
CREATE UNIQUE INDEX vimax_planning_request_open ON vimax_planning_request(workspace_id,project_id,episode_id,scene_id) WHERE state IN ('reserved','submitted');
CREATE INDEX vimax_planning_request_recent ON vimax_planning_request(workspace_id,created_at);
CREATE INDEX vimax_planning_request_target ON vimax_planning_request(workspace_id,project_id,episode_id,scene_id,created_at DESC,id DESC);
CREATE INDEX vimax_planning_request_lease ON vimax_planning_request(workspace_id,lease_until) WHERE state IN ('reserved','submitted');
CREATE FUNCTION guard_vimax_planning_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Planning receipts are permanent' USING ERRCODE='check_violation'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'reserved' OR NEW.submitted_at IS NOT NULL OR NEW.error_code IS NOT NULL OR NEW.output_json IS NOT NULL
      OR NEW.provider_request_id IS NOT NULL OR NEW.response_model IS NOT NULL THEN
      RAISE EXCEPTION 'Planning starts reserved and unsent' USING ERRCODE='check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.workspace_id,NEW.project_id,NEW.episode_id,NEW.actor_id,NEW.idempotency_key,NEW.request_hash,NEW.frozen_hash,NEW.frozen_json,
      NEW.source_script_revision_id,NEW.scene_id,NEW.baseline_scene_revision_id,NEW.baseline_scene_row_version,NEW.provider_key,NEW.model,NEW.created_at,NEW.billing_status)
    IS DISTINCT FROM
     (OLD.id,OLD.workspace_id,OLD.project_id,OLD.episode_id,OLD.actor_id,OLD.idempotency_key,OLD.request_hash,OLD.frozen_hash,OLD.frozen_json,
      OLD.source_script_revision_id,OLD.scene_id,OLD.baseline_scene_revision_id,OLD.baseline_scene_row_version,OLD.provider_key,OLD.model,OLD.created_at,OLD.billing_status) THEN
    RAISE EXCEPTION 'Planning identity and budget are immutable' USING ERRCODE='check_violation';
  END IF;
  IF OLD.state='reserved' AND NEW.state='submitted' AND NEW.executor_id=OLD.executor_id AND NEW.submitted_at IS NOT NULL
    AND NEW.error_code IS NULL AND NEW.provider_request_id IS NULL AND NEW.response_model IS NULL AND NEW.usage_json=OLD.usage_json THEN RETURN NEW; END IF;
  IF OLD.state='reserved' AND NEW.state='rejected' AND NEW.submitted_at IS NULL AND NEW.provider_request_id IS NULL
    AND NEW.response_model IS NULL AND NEW.usage_json=OLD.usage_json AND NEW.error_code IN
    ('invalid_input_before_send','provider_unconfigured_before_send','source_changed_before_send','executor_lost_before_send','canceled_before_send') THEN RETURN NEW; END IF;
  IF OLD.state='submitted' AND NEW.state IN ('completed','rejected','unknown') AND NEW.submitted_at IS NOT DISTINCT FROM OLD.submitted_at
    AND (NEW.error_code IS NULL OR NEW.error_code !~ '_before_send$') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Planning state transition is not permitted' USING ERRCODE='check_violation';
END $$;
CREATE TRIGGER vimax_planning_request_guard BEFORE INSERT OR UPDATE OR DELETE ON vimax_planning_request FOR EACH ROW EXECUTE FUNCTION guard_vimax_planning_request();
COMMENT ON TABLE vimax_planning_request IS 'ads.vimax-planning.storage.v1';
