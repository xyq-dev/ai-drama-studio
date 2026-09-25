ALTER TABLE project
  ADD COLUMN current_story_revision_id uuid,
  ADD COLUMN approved_story_revision_id uuid,
  ADD CONSTRAINT project_version_positive CHECK (version > 0);

CREATE TABLE story_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  content_json jsonb NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  review_status text NOT NULL DEFAULT 'DRAFT' CHECK (review_status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED')),
  freshness_status text NOT NULL DEFAULT 'CURRENT' CHECK (freshness_status IN ('CURRENT', 'STALE')),
  stale_reason text,
  stale_from_ref text,
  review_version integer NOT NULL DEFAULT 1 CHECK (review_version > 0),
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  reviewed_content_hash text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, revision_no),
  UNIQUE (id, project_id, workspace_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES project (id, workspace_id),
  CHECK (review_status <> 'STALE'),
  CHECK (
    review_status NOT IN ('APPROVED', 'REJECTED')
    OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND reviewed_content_hash IS NOT NULL)
  )
);

ALTER TABLE project
  ADD CONSTRAINT project_current_story_revision_fk
  FOREIGN KEY (current_story_revision_id, id, workspace_id)
  REFERENCES story_revision (id, project_id, workspace_id),
  ADD CONSTRAINT project_approved_story_revision_fk
  FOREIGN KEY (approved_story_revision_id, id, workspace_id)
  REFERENCES story_revision (id, project_id, workspace_id);

CREATE TABLE episode (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  episode_no smallint NOT NULL CHECK (episode_no BETWEEN 1 AND 3),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  current_script_revision_id uuid,
  approved_script_revision_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, episode_no),
  UNIQUE (id, workspace_id),
  UNIQUE (id, project_id, workspace_id),
  UNIQUE (id, project_id, episode_no, workspace_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES project (id, workspace_id)
);

CREATE TABLE script_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  source_story_revision_id uuid NOT NULL,
  content_json jsonb NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  review_status text NOT NULL DEFAULT 'DRAFT' CHECK (review_status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED')),
  freshness_status text NOT NULL DEFAULT 'CURRENT' CHECK (freshness_status IN ('CURRENT', 'STALE')),
  stale_reason text,
  stale_from_ref text,
  review_version integer NOT NULL DEFAULT 1 CHECK (review_version > 0),
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  reviewed_content_hash text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (episode_id, revision_no),
  UNIQUE (id, episode_id, workspace_id),
  UNIQUE (id, project_id, workspace_id),
  UNIQUE (id, episode_id, project_id, workspace_id),
  FOREIGN KEY (episode_id, project_id, workspace_id) REFERENCES episode (id, project_id, workspace_id),
  FOREIGN KEY (source_story_revision_id, project_id, workspace_id) REFERENCES story_revision (id, project_id, workspace_id),
  CHECK (review_status <> 'STALE'),
  CHECK (
    review_status NOT IN ('APPROVED', 'REJECTED')
    OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND reviewed_content_hash IS NOT NULL)
  )
);

ALTER TABLE episode
  ADD CONSTRAINT episode_current_script_revision_fk
  FOREIGN KEY (current_script_revision_id, id, workspace_id)
  REFERENCES script_revision (id, episode_id, workspace_id),
  ADD CONSTRAINT episode_approved_script_revision_fk
  FOREIGN KEY (approved_script_revision_id, id, workspace_id)
  REFERENCES script_revision (id, episode_id, workspace_id);

CREATE TABLE character (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  current_revision_id uuid,
  approved_revision_id uuid,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  UNIQUE (id, project_id, workspace_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES project (id, workspace_id)
);
CREATE UNIQUE INDEX character_active_name_idx ON character (project_id, name) WHERE archived_at IS NULL;

CREATE TABLE character_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  character_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  content_json jsonb NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  review_status text NOT NULL DEFAULT 'DRAFT' CHECK (review_status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED')),
  freshness_status text NOT NULL DEFAULT 'CURRENT' CHECK (freshness_status IN ('CURRENT', 'STALE')),
  stale_reason text,
  stale_from_ref text,
  review_version integer NOT NULL DEFAULT 1 CHECK (review_version > 0),
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  reviewed_content_hash text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (character_id, revision_no),
  UNIQUE (id, character_id, workspace_id),
  UNIQUE (id, project_id, workspace_id),
  FOREIGN KEY (character_id, project_id, workspace_id) REFERENCES character (id, project_id, workspace_id),
  CHECK (review_status <> 'STALE'),
  CHECK (
    review_status NOT IN ('APPROVED', 'REJECTED')
    OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND reviewed_content_hash IS NOT NULL)
  )
);

ALTER TABLE character
  ADD CONSTRAINT character_current_revision_fk
  FOREIGN KEY (current_revision_id, id, workspace_id)
  REFERENCES character_revision (id, character_id, workspace_id),
  ADD CONSTRAINT character_approved_revision_fk
  FOREIGN KEY (approved_revision_id, id, workspace_id)
  REFERENCES character_revision (id, character_id, workspace_id);

CREATE TABLE character_revision_script_source (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  character_revision_id uuid NOT NULL,
  script_revision_id uuid NOT NULL,
  PRIMARY KEY (character_revision_id, script_revision_id),
  FOREIGN KEY (character_revision_id, project_id, workspace_id)
    REFERENCES character_revision (id, project_id, workspace_id),
  FOREIGN KEY (script_revision_id, project_id, workspace_id)
    REFERENCES script_revision (id, project_id, workspace_id)
);

CREATE TABLE location (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  current_revision_id uuid,
  approved_revision_id uuid,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  UNIQUE (id, project_id, workspace_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES project (id, workspace_id)
);

CREATE TABLE location_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  location_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  content_json jsonb NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  review_status text NOT NULL DEFAULT 'DRAFT' CHECK (review_status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED')),
  freshness_status text NOT NULL DEFAULT 'CURRENT' CHECK (freshness_status IN ('CURRENT', 'STALE')),
  stale_reason text,
  stale_from_ref text,
  review_version integer NOT NULL DEFAULT 1 CHECK (review_version > 0),
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  reviewed_content_hash text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, revision_no),
  UNIQUE (id, location_id, workspace_id),
  UNIQUE (id, project_id, workspace_id),
  FOREIGN KEY (location_id, project_id, workspace_id) REFERENCES location (id, project_id, workspace_id),
  CHECK (review_status <> 'STALE'),
  CHECK (
    review_status NOT IN ('APPROVED', 'REJECTED')
    OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND reviewed_content_hash IS NOT NULL)
  )
);

ALTER TABLE location
  ADD CONSTRAINT location_current_revision_fk
  FOREIGN KEY (current_revision_id, id, workspace_id)
  REFERENCES location_revision (id, location_id, workspace_id),
  ADD CONSTRAINT location_approved_revision_fk
  FOREIGN KEY (approved_revision_id, id, workspace_id)
  REFERENCES location_revision (id, location_id, workspace_id);

CREATE TABLE location_revision_script_source (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  location_revision_id uuid NOT NULL,
  script_revision_id uuid NOT NULL,
  PRIMARY KEY (location_revision_id, script_revision_id),
  FOREIGN KEY (location_revision_id, project_id, workspace_id)
    REFERENCES location_revision (id, project_id, workspace_id),
  FOREIGN KEY (script_revision_id, project_id, workspace_id)
    REFERENCES script_revision (id, project_id, workspace_id)
);

CREATE TABLE scene (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  current_revision_id uuid,
  approved_revision_id uuid,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  UNIQUE (id, episode_id, project_id, workspace_id),
  FOREIGN KEY (episode_id, project_id, workspace_id) REFERENCES episode (id, project_id, workspace_id)
);

CREATE TABLE scene_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  scene_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  source_script_revision_id uuid NOT NULL,
  location_revision_id uuid,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  heading text NOT NULL,
  time_of_day text,
  summary text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  review_status text NOT NULL DEFAULT 'DRAFT' CHECK (review_status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED')),
  freshness_status text NOT NULL DEFAULT 'CURRENT' CHECK (freshness_status IN ('CURRENT', 'STALE')),
  stale_reason text,
  stale_from_ref text,
  review_version integer NOT NULL DEFAULT 1 CHECK (review_version > 0),
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  reviewed_content_hash text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scene_id, revision_no),
  UNIQUE (id, scene_id, workspace_id),
  UNIQUE (id, project_id, workspace_id),
  UNIQUE (id, scene_id, project_id, workspace_id),
  FOREIGN KEY (scene_id, episode_id, project_id, workspace_id) REFERENCES scene (id, episode_id, project_id, workspace_id),
  FOREIGN KEY (source_script_revision_id, episode_id, project_id, workspace_id)
    REFERENCES script_revision (id, episode_id, project_id, workspace_id),
  FOREIGN KEY (location_revision_id, project_id, workspace_id)
    REFERENCES location_revision (id, project_id, workspace_id),
  CHECK (review_status <> 'STALE'),
  CHECK (
    review_status NOT IN ('APPROVED', 'REJECTED')
    OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND reviewed_content_hash IS NOT NULL)
  )
);

ALTER TABLE scene
  ADD CONSTRAINT scene_current_revision_fk
  FOREIGN KEY (current_revision_id, id, workspace_id)
  REFERENCES scene_revision (id, scene_id, workspace_id),
  ADD CONSTRAINT scene_approved_revision_fk
  FOREIGN KEY (approved_revision_id, id, workspace_id)
  REFERENCES scene_revision (id, scene_id, workspace_id);

CREATE TABLE shot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  scene_id uuid NOT NULL,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  current_revision_id uuid,
  approved_revision_id uuid,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  UNIQUE (id, scene_id, workspace_id),
  UNIQUE (id, project_id, workspace_id),
  FOREIGN KEY (scene_id, episode_id, project_id, workspace_id) REFERENCES scene (id, episode_id, project_id, workspace_id)
);

CREATE TABLE shot_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  scene_id uuid NOT NULL,
  shot_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  source_scene_revision_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  shot_type text NOT NULL,
  camera text NOT NULL,
  action text NOT NULL,
  dialogue text,
  duration_hint text,
  prompt_text text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  review_status text NOT NULL DEFAULT 'DRAFT' CHECK (review_status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED')),
  freshness_status text NOT NULL DEFAULT 'CURRENT' CHECK (freshness_status IN ('CURRENT', 'STALE')),
  stale_reason text,
  stale_from_ref text,
  review_version integer NOT NULL DEFAULT 1 CHECK (review_version > 0),
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  reviewed_content_hash text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shot_id, revision_no),
  UNIQUE (id, shot_id, workspace_id),
  UNIQUE (id, project_id, workspace_id),
  FOREIGN KEY (shot_id, scene_id, workspace_id) REFERENCES shot (id, scene_id, workspace_id),
  FOREIGN KEY (source_scene_revision_id, scene_id, project_id, workspace_id)
    REFERENCES scene_revision (id, scene_id, project_id, workspace_id),
  CHECK (review_status <> 'STALE'),
  CHECK (
    review_status NOT IN ('APPROVED', 'REJECTED')
    OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND reviewed_content_hash IS NOT NULL)
  )
);

ALTER TABLE shot
  ADD CONSTRAINT shot_current_revision_fk
  FOREIGN KEY (current_revision_id, id, workspace_id)
  REFERENCES shot_revision (id, shot_id, workspace_id),
  ADD CONSTRAINT shot_approved_revision_fk
  FOREIGN KEY (approved_revision_id, id, workspace_id)
  REFERENCES shot_revision (id, shot_id, workspace_id);

CREATE TABLE shot_character_reference (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  shot_revision_id uuid NOT NULL,
  character_revision_id uuid NOT NULL,
  role text NOT NULL CHECK (length(role) BETWEEN 1 AND 100),
  PRIMARY KEY (shot_revision_id, character_revision_id),
  FOREIGN KEY (shot_revision_id, project_id, workspace_id)
    REFERENCES shot_revision (id, project_id, workspace_id),
  FOREIGN KEY (character_revision_id, project_id, workspace_id)
    REFERENCES character_revision (id, project_id, workspace_id)
);

CREATE FUNCTION m2_reject_provenance_mutation() RETURNS trigger
LANGUAGE plpgsql AS $
BEGIN
  RAISE EXCEPTION 'revision provenance is immutable';
END $;

CREATE TRIGGER character_revision_script_source_immutable
  BEFORE UPDATE OR DELETE ON character_revision_script_source
  FOR EACH ROW EXECUTE FUNCTION m2_reject_provenance_mutation();

CREATE TRIGGER location_revision_script_source_immutable
  BEFORE UPDATE OR DELETE ON location_revision_script_source
  FOR EACH ROW EXECUTE FUNCTION m2_reject_provenance_mutation();

CREATE TRIGGER shot_character_reference_immutable
  BEFORE UPDATE OR DELETE ON shot_character_reference
  FOR EACH ROW EXECUTE FUNCTION m2_reject_provenance_mutation();

CREATE FUNCTION m2_reject_revision_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'revision history cannot be deleted';
END $$;

CREATE FUNCTION m2_reject_story_content_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.revision_no IS DISTINCT FROM OLD.revision_no
     OR NEW.content_json IS DISTINCT FROM OLD.content_json
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'revision content is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION m2_reject_script_content_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.episode_id IS DISTINCT FROM OLD.episode_id
     OR NEW.revision_no IS DISTINCT FROM OLD.revision_no
     OR NEW.source_story_revision_id IS DISTINCT FROM OLD.source_story_revision_id
     OR NEW.content_json IS DISTINCT FROM OLD.content_json
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'revision content is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION m2_reject_entity_revision_content_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR (TG_TABLE_NAME = 'character_revision' AND NEW.character_id IS DISTINCT FROM OLD.character_id)
     OR (TG_TABLE_NAME = 'location_revision' AND NEW.location_id IS DISTINCT FROM OLD.location_id)
     OR NEW.revision_no IS DISTINCT FROM OLD.revision_no
     OR NEW.content_json IS DISTINCT FROM OLD.content_json
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'revision content is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION m2_reject_scene_content_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.episode_id IS DISTINCT FROM OLD.episode_id
     OR NEW.scene_id IS DISTINCT FROM OLD.scene_id
     OR NEW.revision_no IS DISTINCT FROM OLD.revision_no
     OR NEW.source_script_revision_id IS DISTINCT FROM OLD.source_script_revision_id
     OR NEW.location_revision_id IS DISTINCT FROM OLD.location_revision_id
     OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
     OR NEW.heading IS DISTINCT FROM OLD.heading
     OR NEW.time_of_day IS DISTINCT FROM OLD.time_of_day
     OR NEW.summary IS DISTINCT FROM OLD.summary
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'revision content is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION m2_reject_shot_content_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.scene_id IS DISTINCT FROM OLD.scene_id
     OR NEW.shot_id IS DISTINCT FROM OLD.shot_id
     OR NEW.revision_no IS DISTINCT FROM OLD.revision_no
     OR NEW.source_scene_revision_id IS DISTINCT FROM OLD.source_scene_revision_id
     OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
     OR NEW.shot_type IS DISTINCT FROM OLD.shot_type
     OR NEW.camera IS DISTINCT FROM OLD.camera
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.dialogue IS DISTINCT FROM OLD.dialogue
     OR NEW.duration_hint IS DISTINCT FROM OLD.duration_hint
     OR NEW.prompt_text IS DISTINCT FROM OLD.prompt_text
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'revision content is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER story_revision_content_immutable
  BEFORE UPDATE ON story_revision
  FOR EACH ROW EXECUTE FUNCTION m2_reject_story_content_update();
CREATE TRIGGER story_revision_no_delete
  BEFORE DELETE ON story_revision
  FOR EACH ROW EXECUTE FUNCTION m2_reject_revision_delete();

CREATE TRIGGER script_revision_content_immutable
  BEFORE UPDATE ON script_revision
  FOR EACH ROW EXECUTE FUNCTION m2_reject_script_content_update();
CREATE TRIGGER script_revision_no_delete
  BEFORE DELETE ON script_revision
  FOR EACH ROW EXECUTE FUNCTION m2_reject_revision_delete();

CREATE TRIGGER character_revision_content_immutable
  BEFORE UPDATE ON character_revision
  FOR EACH ROW EXECUTE FUNCTION m2_reject_entity_revision_content_update();
CREATE TRIGGER character_revision_no_delete
  BEFORE DELETE ON character_revision
  FOR EACH ROW EXECUTE FUNCTION m2_reject_revision_delete();

CREATE TRIGGER location_revision_content_immutable
  BEFORE UPDATE ON location_revision
  FOR EACH ROW EXECUTE FUNCTION m2_reject_entity_revision_content_update();
CREATE TRIGGER location_revision_no_delete
  BEFORE DELETE ON location_revision
  FOR EACH ROW EXECUTE FUNCTION m2_reject_revision_delete();

CREATE TRIGGER scene_revision_content_immutable
  BEFORE UPDATE ON scene_revision
  FOR EACH ROW EXECUTE FUNCTION m2_reject_scene_content_update();
CREATE TRIGGER scene_revision_no_delete
  BEFORE DELETE ON scene_revision
  FOR EACH ROW EXECUTE FUNCTION m2_reject_revision_delete();

CREATE TRIGGER shot_revision_content_immutable
  BEFORE UPDATE ON shot_revision
  FOR EACH ROW EXECUTE FUNCTION m2_reject_shot_content_update();
CREATE TRIGGER shot_revision_no_delete
  BEFORE DELETE ON shot_revision
  FOR EACH ROW EXECUTE FUNCTION m2_reject_revision_delete();
