-- ViMax E2-B DRAFT ONLY. Not discovered by runMigrations, never applied at application startup.
-- Requires the existing base migrations and 20261012000100_script_breakdown.
-- Business/production execution requires separate authorization. Isolated acceptance uses a new, named empty DB.
DO $$
BEGIN
  IF (SELECT count(*) FROM schema_migration WHERE name IN (
    '20260924000100_m1b_job_core', '20260925000100_m2a_text_chain', '20260928000100_script_dependency_scopes',
    '20260928000200_m3a_media_assets', '20260928000300_m3b_job_shot_lineage', '20261008000100_title_writing',
    '20261011000100_episode_plan', '20261012000100_script_breakdown')) <> 8
    OR (SELECT count(*) FROM information_schema.columns WHERE table_schema = current_schema()
      AND ((table_name = 'shot_revision' AND column_name = 'planned_duration_ms')
        OR (table_name = 'title_writing_run' AND column_name IN ('run_kind','episode_id')))) <> 3 THEN
    RAISE EXCEPTION 'ViMax candidate draft requires the existing base and script breakdown migrations' USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE TABLE vimax_storyboard_candidate (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  frozen_hash text NOT NULL CHECK (frozen_hash ~ '^[a-f0-9]{64}$'),
  frozen_json jsonb NOT NULL CHECK (
    jsonb_typeof(frozen_json) = 'object'
    AND (frozen_json ->> 'schema') IS NOT DISTINCT FROM 'ads.vimax-candidate.frozen.v1'
    AND octet_length(frozen_json::text) <= 786432
  ),
  source_script_revision_id uuid NOT NULL,
  scene_id uuid NOT NULL,
  baseline_scene_revision_id uuid NOT NULL,
  baseline_scene_row_version integer NOT NULL CHECK (baseline_scene_row_version > 0),
  shot_count smallint NOT NULL CHECK (shot_count BETWEEN 1 AND 8),
  state text NOT NULL DEFAULT 'stored' CHECK (state IN ('stored','scene_saved','shots_saved')),
  row_version integer NOT NULL DEFAULT 1,
  saved_scene_revision_id uuid,
  scene_request_key text,
  scene_request_hash text CHECK (scene_request_hash ~ '^[a-f0-9]{64}$'),
  scene_receipt jsonb,
  scene_saved_at timestamptz,
  shots_request_key text,
  shots_request_hash text CHECK (shots_request_hash ~ '^[a-f0-9]{64}$'),
  shots_receipt jsonb,
  shots_saved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, actor_id, idempotency_key),
  UNIQUE (id, saved_scene_revision_id, scene_id, project_id, workspace_id),
  FOREIGN KEY (source_script_revision_id, episode_id, project_id, workspace_id)
    REFERENCES script_revision(id, episode_id, project_id, workspace_id),
  FOREIGN KEY (scene_id, episode_id, project_id, workspace_id)
    REFERENCES scene(id, episode_id, project_id, workspace_id),
  FOREIGN KEY (baseline_scene_revision_id, scene_id, project_id, workspace_id)
    REFERENCES scene_revision(id, scene_id, project_id, workspace_id),
  FOREIGN KEY (saved_scene_revision_id, scene_id, project_id, workspace_id)
    REFERENCES scene_revision(id, scene_id, project_id, workspace_id),
  CHECK ((frozen_json #>> '{source,projectId}') IS NOT DISTINCT FROM project_id::text
    AND (frozen_json #>> '{source,episodeId}') IS NOT DISTINCT FROM episode_id::text
    AND (frozen_json #>> '{source,scriptRevisionId}') IS NOT DISTINCT FROM source_script_revision_id::text
    AND (frozen_json #>> '{target,sceneId}') IS NOT DISTINCT FROM scene_id::text
    AND (frozen_json #>> '{target,sceneRevisionId}') IS NOT DISTINCT FROM baseline_scene_revision_id::text
    AND (frozen_json #>> '{target,rowVersion}') IS NOT DISTINCT FROM baseline_scene_row_version::text
    AND jsonb_typeof(frozen_json #> '{request,supplements,shots}') IS NOT DISTINCT FROM 'array'
    AND jsonb_array_length(frozen_json #> '{request,supplements,shots}') = shot_count),
  CHECK ((state = 'stored' AND row_version = 1 AND saved_scene_revision_id IS NULL
       AND scene_request_key IS NULL AND scene_request_hash IS NULL AND scene_receipt IS NULL AND scene_saved_at IS NULL
       AND shots_request_key IS NULL AND shots_request_hash IS NULL AND shots_receipt IS NULL AND shots_saved_at IS NULL)
    OR (state = 'scene_saved' AND row_version = 2 AND saved_scene_revision_id IS NOT NULL
       AND scene_request_key IS NOT NULL AND scene_request_hash IS NOT NULL AND scene_receipt IS NOT NULL AND scene_saved_at IS NOT NULL
       AND shots_request_key IS NULL AND shots_request_hash IS NULL AND shots_receipt IS NULL AND shots_saved_at IS NULL)
    OR (state = 'shots_saved' AND row_version = 3 AND saved_scene_revision_id IS NOT NULL
       AND scene_request_key IS NOT NULL AND scene_request_hash IS NOT NULL AND scene_receipt IS NOT NULL AND scene_saved_at IS NOT NULL
       AND shots_request_key IS NOT NULL AND shots_request_hash IS NOT NULL AND shots_receipt IS NOT NULL AND shots_saved_at IS NOT NULL)),
  CHECK (scene_request_key IS NULL OR length(scene_request_key) BETWEEN 1 AND 200),
  CHECK (shots_request_key IS NULL OR length(shots_request_key) BETWEEN 1 AND 200),
  CHECK (scene_receipt IS NULL OR (jsonb_typeof(scene_receipt) = 'object'
    AND (scene_receipt ->> 'schema') IS NOT DISTINCT FROM 'ads.vimax-candidate.receipt.v1'
    AND (scene_receipt ->> 'operation') IS NOT DISTINCT FROM 'save_scene'
    AND (scene_receipt ->> 'state') IS NOT DISTINCT FROM 'scene_saved'
    AND (scene_receipt ->> 'rowVersion') IS NOT DISTINCT FROM '2'
    AND (scene_receipt ->> 'candidateId') IS NOT DISTINCT FROM id::text
    AND (scene_receipt ->> 'projectId') IS NOT DISTINCT FROM project_id::text
    AND (scene_receipt ->> 'episodeId') IS NOT DISTINCT FROM episode_id::text
    AND (scene_receipt ->> 'sceneId') IS NOT DISTINCT FROM scene_id::text
    AND (scene_receipt ->> 'sceneRevisionId') IS NOT DISTINCT FROM saved_scene_revision_id::text
    AND (scene_receipt ->> 'idempotencyKey') IS NOT DISTINCT FROM scene_request_key
    AND (scene_receipt ->> 'requestHash') IS NOT DISTINCT FROM scene_request_hash
    AND (scene_receipt -> 'shots') IS NOT DISTINCT FROM '[]'::jsonb
    AND octet_length(scene_receipt::text) <= 16384)),
  CHECK (shots_receipt IS NULL OR (jsonb_typeof(shots_receipt) = 'object'
    AND (shots_receipt ->> 'schema') IS NOT DISTINCT FROM 'ads.vimax-candidate.receipt.v1'
    AND (shots_receipt ->> 'operation') IS NOT DISTINCT FROM 'place_shots'
    AND (shots_receipt ->> 'state') IS NOT DISTINCT FROM 'shots_saved'
    AND (shots_receipt ->> 'rowVersion') IS NOT DISTINCT FROM '3'
    AND (shots_receipt ->> 'candidateId') IS NOT DISTINCT FROM id::text
    AND (shots_receipt ->> 'projectId') IS NOT DISTINCT FROM project_id::text
    AND (shots_receipt ->> 'episodeId') IS NOT DISTINCT FROM episode_id::text
    AND (shots_receipt ->> 'sceneId') IS NOT DISTINCT FROM scene_id::text
    AND (shots_receipt ->> 'sceneRevisionId') IS NOT DISTINCT FROM saved_scene_revision_id::text
    AND (shots_receipt ->> 'idempotencyKey') IS NOT DISTINCT FROM shots_request_key
    AND (shots_receipt ->> 'requestHash') IS NOT DISTINCT FROM shots_request_hash
    AND jsonb_typeof(shots_receipt -> 'shots') IS NOT DISTINCT FROM 'array'
    AND jsonb_array_length(shots_receipt -> 'shots') = shot_count
    AND octet_length(shots_receipt::text) <= 16384))
);
COMMENT ON TABLE vimax_storyboard_candidate IS 'ads.vimax-candidate.storage.v1';
CREATE INDEX vimax_storyboard_candidate_listing_idx
  ON vimax_storyboard_candidate(workspace_id, project_id, episode_id, actor_id, created_at DESC, id DESC);

CREATE TABLE vimax_storyboard_candidate_shot (
  candidate_id uuid NOT NULL,
  shot_index smallint NOT NULL CHECK (shot_index BETWEEN 0 AND 7),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  scene_id uuid NOT NULL,
  source_scene_revision_id uuid NOT NULL,
  shot_id uuid NOT NULL UNIQUE,
  shot_revision_id uuid NOT NULL UNIQUE,
  PRIMARY KEY(candidate_id, shot_index),
  FOREIGN KEY(candidate_id, source_scene_revision_id, scene_id, project_id, workspace_id)
    REFERENCES vimax_storyboard_candidate(id, saved_scene_revision_id, scene_id, project_id, workspace_id),
  FOREIGN KEY(shot_id, scene_id, workspace_id) REFERENCES shot(id, scene_id, workspace_id),
  FOREIGN KEY(shot_id, project_id, workspace_id) REFERENCES shot(id, project_id, workspace_id),
  FOREIGN KEY(shot_revision_id, shot_id, workspace_id) REFERENCES shot_revision(id, shot_id, workspace_id),
  FOREIGN KEY(shot_revision_id, project_id, workspace_id) REFERENCES shot_revision(id, project_id, workspace_id)
);

CREATE FUNCTION vimax_storyboard_candidate_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mapped integer; low_index integer; high_index integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ViMax candidate permanent history cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'stored' OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'ViMax candidate must start stored' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.workspace_id, NEW.project_id, NEW.episode_id, NEW.actor_id, NEW.idempotency_key,
         NEW.request_hash, NEW.frozen_hash, NEW.frozen_json, NEW.source_script_revision_id, NEW.scene_id,
         NEW.baseline_scene_revision_id, NEW.baseline_scene_row_version, NEW.shot_count, NEW.created_at)
    IS DISTINCT FROM
     ROW(OLD.id, OLD.workspace_id, OLD.project_id, OLD.episode_id, OLD.actor_id, OLD.idempotency_key,
         OLD.request_hash, OLD.frozen_hash, OLD.frozen_json, OLD.source_script_revision_id, OLD.scene_id,
         OLD.baseline_scene_revision_id, OLD.baseline_scene_row_version, OLD.shot_count, OLD.created_at) THEN
    RAISE EXCEPTION 'ViMax candidate frozen input is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state = 'stored' AND NEW.state = 'scene_saved' AND NEW.row_version = 2 THEN
    IF NOT EXISTS (
      SELECT 1 FROM scene_revision r JOIN scene s ON s.id = r.scene_id AND s.workspace_id = r.workspace_id
      WHERE r.id = NEW.saved_scene_revision_id AND r.scene_id = OLD.scene_id
        AND r.workspace_id = OLD.workspace_id AND r.project_id = OLD.project_id AND r.episode_id = OLD.episode_id
        AND r.source_script_revision_id = OLD.source_script_revision_id
        AND r.review_status = 'DRAFT' AND r.freshness_status = 'CURRENT'
        AND s.current_revision_id = r.id AND s.archived_at IS NULL
    ) THEN RAISE EXCEPTION 'ViMax candidate must save its exact current fresh scene draft' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'scene_saved' AND NEW.state = 'shots_saved' AND NEW.row_version = 3
    AND ROW(NEW.saved_scene_revision_id, NEW.scene_request_key, NEW.scene_request_hash, NEW.scene_receipt, NEW.scene_saved_at)
      IS NOT DISTINCT FROM ROW(OLD.saved_scene_revision_id, OLD.scene_request_key, OLD.scene_request_hash, OLD.scene_receipt, OLD.scene_saved_at) THEN
    SELECT count(*)::int, min(shot_index), max(shot_index) INTO mapped, low_index, high_index
      FROM vimax_storyboard_candidate_shot WHERE candidate_id = OLD.id;
    IF mapped <> OLD.shot_count OR low_index <> 0 OR high_index <> OLD.shot_count - 1 THEN
      RAISE EXCEPTION 'ViMax candidate shots must be complete and contiguous' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM vimax_storyboard_candidate_shot link
      WHERE link.candidate_id = OLD.id AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.shots_receipt -> 'shots') item
        WHERE (item ->> 'index') IS NOT DISTINCT FROM link.shot_index::text
          AND (item ->> 'shotId') IS NOT DISTINCT FROM link.shot_id::text
          AND (item ->> 'shotRevisionId') IS NOT DISTINCT FROM link.shot_revision_id::text
      )
    ) THEN RAISE EXCEPTION 'ViMax candidate receipt does not match shot mapping' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ViMax candidate save stages are permanent and forward only' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER vimax_storyboard_candidate_guard
  BEFORE INSERT OR UPDATE OR DELETE ON vimax_storyboard_candidate
  FOR EACH ROW EXECUTE FUNCTION vimax_storyboard_candidate_guard();

CREATE FUNCTION vimax_storyboard_candidate_shot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent vimax_storyboard_candidate%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'ViMax candidate shot history is immutable' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO parent FROM vimax_storyboard_candidate WHERE id = NEW.candidate_id;
  IF parent.state IS DISTINCT FROM 'scene_saved' OR NEW.shot_index >= parent.shot_count THEN
    RAISE EXCEPTION 'ViMax shot mapping requires the saved candidate scene' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM shot_revision r JOIN shot s ON s.id = r.shot_id AND s.workspace_id = r.workspace_id
    WHERE r.id = NEW.shot_revision_id AND r.shot_id = NEW.shot_id AND r.workspace_id = NEW.workspace_id
      AND r.project_id = NEW.project_id AND r.scene_id = NEW.scene_id
      AND r.source_scene_revision_id = NEW.source_scene_revision_id AND r.ordinal = NEW.shot_index + 1
      AND r.review_status = 'DRAFT' AND r.freshness_status = 'CURRENT'
      AND s.current_revision_id = r.id AND s.archived_at IS NULL
  ) THEN RAISE EXCEPTION 'ViMax mapping must reference its exact fresh shot draft' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vimax_storyboard_candidate_shot_guard
  BEFORE INSERT OR UPDATE OR DELETE ON vimax_storyboard_candidate_shot
  FOR EACH ROW EXECUTE FUNCTION vimax_storyboard_candidate_shot_guard();
