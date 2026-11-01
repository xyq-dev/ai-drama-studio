-- DRAFT ONLY. Not authorized for execution. Never added to automatic migrations.
-- Requires the existing text-chain, media asset and asset dependency migrations.
-- AUDIO stays DRAFT: asset_approval_kind_check is deliberately unchanged.
CREATE TABLE speech_voice_binding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, project_id uuid NOT NULL,
  speaker_id text NOT NULL CHECK (speaker_id = 'narrator' OR speaker_id ~ '^[0-9a-f-]{36}$'),
  character_id uuid, current_revision_id uuid, row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id, workspace_id), UNIQUE (workspace_id, project_id, speaker_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES project(id, workspace_id),
  FOREIGN KEY (character_id, project_id, workspace_id) REFERENCES character(id, project_id, workspace_id),
  CHECK ((speaker_id = 'narrator' AND character_id IS NULL) OR (character_id IS NOT NULL AND speaker_id = character_id::text))
);
CREATE TABLE speech_voice_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, project_id uuid NOT NULL,
  binding_id uuid NOT NULL, provider_configuration_id uuid NOT NULL, content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  voice_json jsonb NOT NULL CHECK (octet_length(voice_json::text) <= 16384), created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (id, project_id, workspace_id), UNIQUE (id, binding_id, project_id, workspace_id),
  FOREIGN KEY (binding_id, project_id, workspace_id) REFERENCES speech_voice_binding(id, project_id, workspace_id),
  FOREIGN KEY (provider_configuration_id, workspace_id) REFERENCES provider_configuration(id, workspace_id)
);
ALTER TABLE speech_voice_binding ADD CONSTRAINT speech_voice_current_fk FOREIGN KEY (current_revision_id, id, project_id, workspace_id)
  REFERENCES speech_voice_revision(id, binding_id, project_id, workspace_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE speech_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, project_id uuid NOT NULL,
  shot_revision_id uuid NOT NULL, current_revision_id uuid, row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id, workspace_id), UNIQUE (workspace_id, shot_revision_id),
  FOREIGN KEY (shot_revision_id, project_id, workspace_id) REFERENCES shot_revision(id, project_id, workspace_id)
);
CREATE TABLE speech_plan_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, project_id uuid NOT NULL, plan_id uuid NOT NULL,
  source_dialogue_hash text NOT NULL CHECK (source_dialogue_hash ~ '^[a-f0-9]{64}$'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'), timing_policy text NOT NULL CHECK (timing_policy = 'sequential-reject-overflow'),
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id, workspace_id), UNIQUE (id, plan_id, project_id, workspace_id),
  FOREIGN KEY (plan_id, project_id, workspace_id) REFERENCES speech_plan(id, project_id, workspace_id)
);
ALTER TABLE speech_plan ADD CONSTRAINT speech_plan_current_fk FOREIGN KEY (current_revision_id, id, project_id, workspace_id)
  REFERENCES speech_plan_revision(id, plan_id, project_id, workspace_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE speech_line_input_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, project_id uuid NOT NULL, shot_revision_id uuid NOT NULL,
  line_id uuid NOT NULL, voice_revision_id uuid NOT NULL, input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  display_text text NOT NULL CHECK (length(display_text) BETWEEN 1 AND 2000), emotion text NOT NULL CHECK (length(emotion) BETWEEN 1 AND 40),
  speed double precision NOT NULL CHECK (speed >= 0.5 AND speed <= 2),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (id, project_id, workspace_id), UNIQUE (id, line_id, project_id, workspace_id),
  UNIQUE (workspace_id, shot_revision_id, line_id, input_hash),
  FOREIGN KEY (shot_revision_id, project_id, workspace_id) REFERENCES shot_revision(id, project_id, workspace_id),
  FOREIGN KEY (voice_revision_id, project_id, workspace_id) REFERENCES speech_voice_revision(id, project_id, workspace_id)
);
CREATE TABLE speech_plan_line (
  workspace_id uuid NOT NULL, project_id uuid NOT NULL, plan_revision_id uuid NOT NULL, line_id uuid NOT NULL,
  line_input_revision_id uuid NOT NULL, ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 100),
  source_start integer NOT NULL CHECK (source_start >= 0), source_end integer NOT NULL CHECK (source_end > source_start AND source_end <= 4000),
  pause_after_ms integer NOT NULL CHECK (pause_after_ms BETWEEN 0 AND 5000),
  PRIMARY KEY (plan_revision_id, line_id), UNIQUE (plan_revision_id, ordinal), UNIQUE (plan_revision_id, line_id, project_id, workspace_id),
  UNIQUE (plan_revision_id, line_id, line_input_revision_id, project_id, workspace_id),
  FOREIGN KEY (plan_revision_id, project_id, workspace_id) REFERENCES speech_plan_revision(id, project_id, workspace_id),
  FOREIGN KEY (line_input_revision_id, line_id, project_id, workspace_id) REFERENCES speech_line_input_revision(id, line_id, project_id, workspace_id)
);
CREATE TABLE speech_take (
  asset_id uuid PRIMARY KEY, workspace_id uuid NOT NULL, project_id uuid NOT NULL, line_input_revision_id uuid NOT NULL,
  job_id uuid NOT NULL, attempt_id uuid NOT NULL, alignment_version text NOT NULL DEFAULT 'sentence-duration-v1' CHECK (alignment_version = 'sentence-duration-v1'),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (asset_id, project_id, workspace_id),
  UNIQUE (asset_id, line_input_revision_id, project_id, workspace_id),
  FOREIGN KEY (asset_id, project_id, workspace_id) REFERENCES asset(id, project_id, workspace_id),
  FOREIGN KEY (line_input_revision_id, project_id, workspace_id) REFERENCES speech_line_input_revision(id, project_id, workspace_id),
  FOREIGN KEY (job_id, project_id, workspace_id) REFERENCES generation_job(id, project_id, workspace_id),
  FOREIGN KEY (attempt_id, job_id, workspace_id) REFERENCES job_attempt(id, generation_job_id, workspace_id)
);
CREATE TABLE speech_selection_slot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, project_id uuid NOT NULL,
  plan_revision_id uuid NOT NULL, line_id uuid NOT NULL, line_input_revision_id uuid NOT NULL, current_selection_id uuid,
  UNIQUE (plan_revision_id, line_id), UNIQUE (id, project_id, workspace_id), UNIQUE (id, line_input_revision_id, project_id, workspace_id),
  FOREIGN KEY (plan_revision_id, line_id, line_input_revision_id, project_id, workspace_id) REFERENCES speech_plan_line(plan_revision_id, line_id, line_input_revision_id, project_id, workspace_id)
);
CREATE TABLE speech_selection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, project_id uuid NOT NULL, slot_id uuid NOT NULL,
  take_asset_id uuid NOT NULL, line_input_revision_id uuid NOT NULL, checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  selected_by text NOT NULL, selected_at timestamptz NOT NULL DEFAULT now(), inherited_from_selection_id uuid,
  UNIQUE (id, project_id, workspace_id), UNIQUE (id, slot_id, project_id, workspace_id),
  FOREIGN KEY (slot_id, line_input_revision_id, project_id, workspace_id) REFERENCES speech_selection_slot(id, line_input_revision_id, project_id, workspace_id),
  FOREIGN KEY (take_asset_id, line_input_revision_id, project_id, workspace_id) REFERENCES speech_take(asset_id, line_input_revision_id, project_id, workspace_id),
  FOREIGN KEY (line_input_revision_id, project_id, workspace_id) REFERENCES speech_line_input_revision(id, project_id, workspace_id),
  FOREIGN KEY (inherited_from_selection_id, project_id, workspace_id) REFERENCES speech_selection(id, project_id, workspace_id)
);
ALTER TABLE speech_selection_slot ADD CONSTRAINT speech_selection_current_fk FOREIGN KEY (current_selection_id, id, project_id, workspace_id)
  REFERENCES speech_selection(id, slot_id, project_id, workspace_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE speech_mix_dependency (
  workspace_id uuid NOT NULL, project_id uuid NOT NULL, dependent_asset_id uuid NOT NULL, plan_revision_id uuid NOT NULL,
  PRIMARY KEY (dependent_asset_id, plan_revision_id),
  FOREIGN KEY (dependent_asset_id, project_id, workspace_id) REFERENCES asset(id, project_id, workspace_id),
  FOREIGN KEY (plan_revision_id, project_id, workspace_id) REFERENCES speech_plan_revision(id, project_id, workspace_id)
);
-- A separate row per selected sentence preserves exact choice dependencies.
CREATE TABLE speech_mix_selection_dependency (
  workspace_id uuid NOT NULL, project_id uuid NOT NULL, dependent_asset_id uuid NOT NULL, selection_id uuid NOT NULL,
  PRIMARY KEY (dependent_asset_id, selection_id),
  FOREIGN KEY (dependent_asset_id, project_id, workspace_id) REFERENCES asset(id, project_id, workspace_id),
  FOREIGN KEY (selection_id, project_id, workspace_id) REFERENCES speech_selection(id, project_id, workspace_id)
);
CREATE INDEX speech_line_voice_idx ON speech_line_input_revision(workspace_id, project_id, voice_revision_id);
CREATE INDEX speech_mix_plan_idx ON speech_mix_dependency(workspace_id, project_id, plan_revision_id);
CREATE INDEX speech_mix_selection_idx ON speech_mix_selection_dependency(workspace_id, project_id, selection_id);
COMMENT ON TABLE speech_voice_binding IS 'ads.speech.storage.v1';
-- Immutable source/selection histories reject in-place changes and deletion. Aggregates/slots alone are mutable.
CREATE FUNCTION speech_immutable_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'speech revisions and dependencies are immutable'; END $$;
DO $$ DECLARE relation_name text; BEGIN
  FOREACH relation_name IN ARRAY ARRAY['speech_voice_revision','speech_plan_revision','speech_line_input_revision','speech_plan_line','speech_take','speech_selection','speech_mix_dependency','speech_mix_selection_dependency'] LOOP
    EXECUTE format('CREATE TRIGGER speech_immutable_guard BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION speech_immutable_revision_guard()', relation_name);
  END LOOP;
END $$;
CREATE FUNCTION speech_pointer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'speech identities and history are retained'; END IF;
  IF TG_TABLE_NAME='speech_selection_slot' THEN
    IF (to_jsonb(NEW)-'current_selection_id') IS DISTINCT FROM (to_jsonb(OLD)-'current_selection_id') THEN
      RAISE EXCEPTION 'speech selection slot identity is immutable';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['current_revision_id','row_version','updated_at']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['current_revision_id','row_version','updated_at'])
       OR NOT (NEW.row_version=OLD.row_version+1 OR (OLD.current_revision_id IS NULL AND OLD.row_version=1 AND NEW.row_version=1)) THEN
      RAISE EXCEPTION 'speech aggregate identity is immutable and version must advance';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER speech_pointer_guard BEFORE UPDATE OR DELETE ON speech_voice_binding FOR EACH ROW EXECUTE FUNCTION speech_pointer_guard();
CREATE TRIGGER speech_pointer_guard BEFORE UPDATE OR DELETE ON speech_plan FOR EACH ROW EXECUTE FUNCTION speech_pointer_guard();
CREATE TRIGGER speech_pointer_guard BEFORE UPDATE OR DELETE ON speech_selection_slot FOR EACH ROW EXECUTE FUNCTION speech_pointer_guard();
-- No backfill, provider provisioning, credential changes, approval relaxation or paid operations are performed.
