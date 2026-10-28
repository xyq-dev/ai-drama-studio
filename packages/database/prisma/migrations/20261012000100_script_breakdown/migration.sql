-- Script breakdown (docs/SCRIPT_BREAKDOWN.md): one approved script revision of one episode -> scenes and proposed shots.
-- Expand only. It adds four nullable or defaulted columns to title_writing_run, one nullable column to shot_revision,
-- one new table, and replaces two title_writing_step CHECKs and the shot_revision immutability function with wider ones.
-- No row is written, rewritten or deleted. Every existing run reads as run_kind 'title' with no breakdown columns, which
-- the new CHECK requires; every existing step and shot revision satisfies the wider constraints.
-- Read by packages/database/src/title-writing-store.ts. Until this migration is recorded in schema_migration and its
-- columns and table exist, breakdown starts are refused before any write or provider send; title writing is unchanged.
-- Locks: ALTER TABLE takes ACCESS EXCLUSIVE on title_writing_run, title_writing_step and shot_revision for the length
-- of this one migration transaction; the new CHECKs scan those tables once while validating. Run it in a quiet window.
-- No down migration. A code rollback keeps the columns, the table and the wider ranges; forward-fix only. Do not roll
-- the API back while a breakdown run is running: older code would not recognise the run kind.

ALTER TABLE title_writing_run ADD COLUMN run_kind text NOT NULL DEFAULT 'title';
ALTER TABLE title_writing_run ADD COLUMN episode_id uuid;
ALTER TABLE title_writing_run ADD COLUMN source_script_revision_id uuid;
ALTER TABLE title_writing_run ADD COLUMN breakdown_save text;
ALTER TABLE title_writing_run ADD CONSTRAINT title_writing_run_kind_check CHECK (run_kind IN ('title', 'script_breakdown'));
ALTER TABLE title_writing_run ADD CONSTRAINT title_writing_run_breakdown_save_check
  CHECK (breakdown_save IS NULL OR breakdown_save IN ('pending', 'saved', 'source_changed', 'conflict'));
-- A breakdown run names its episode, its frozen script revision and its save state; a title run names none of them and
-- never saves a story.
ALTER TABLE title_writing_run ADD CONSTRAINT title_writing_run_breakdown_shape_check CHECK (
  (run_kind = 'title' AND episode_id IS NULL AND source_script_revision_id IS NULL AND breakdown_save IS NULL)
  OR (run_kind = 'script_breakdown' AND episode_id IS NOT NULL AND source_script_revision_id IS NOT NULL
      AND breakdown_save IS NOT NULL AND story_save = 'pending' AND story_revision_id IS NULL)
);
ALTER TABLE title_writing_run ADD CONSTRAINT title_writing_run_breakdown_source_fk
  FOREIGN KEY (source_script_revision_id, episode_id, project_id, workspace_id)
  REFERENCES script_revision (id, episode_id, project_id, workspace_id);
CREATE INDEX title_writing_run_breakdown_idx ON title_writing_run (workspace_id, episode_id, created_at DESC)
  WHERE run_kind = 'script_breakdown';

-- The step CHECKs of 20261011000100_episode_plan under their names, widened by the single 'breakdown' step.
ALTER TABLE title_writing_step DROP CONSTRAINT title_writing_step_step_key_check;
ALTER TABLE title_writing_step ADD CONSTRAINT title_writing_step_step_key_check CHECK (step_key IN (
  'concept', 'outline', 'episode:1', 'episode:2', 'episode:3', 'episode:4', 'episode:5', 'episode:6', 'breakdown'));
-- The unnamed table CHECK of 20261008000100_title_writing that gives only episode steps a script_save. It is found by
-- its definition, not by a generated name, and the migration stops unless exactly one such constraint exists.
DO $$
DECLARE
  found text[];
BEGIN
  SELECT array_agg(conname ORDER BY conname) INTO found
    FROM pg_constraint
   WHERE conrelid = 'title_writing_step'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%script_save IS NULL%'
     AND pg_get_constraintdef(oid) LIKE '%concept%'
     AND pg_get_constraintdef(oid) LIKE '%outline%'
     AND pg_get_constraintdef(oid) NOT LIKE '%breakdown%';
  IF found IS NULL OR array_length(found, 1) <> 1 THEN
    RAISE EXCEPTION 'expected exactly one script_save step CHECK, found %', found;
  END IF;
  EXECUTE format('ALTER TABLE title_writing_step DROP CONSTRAINT %I', found[1]);
END $$;
ALTER TABLE title_writing_step ADD CONSTRAINT title_writing_step_script_save_scope_check
  CHECK ((script_save IS NULL) = (step_key IN ('concept', 'outline', 'breakdown')));

-- Planned seconds of a shot, as a whole number of milliseconds. A writing plan, never a measured media length.
ALTER TABLE shot_revision ADD COLUMN planned_duration_ms integer;
ALTER TABLE shot_revision ADD CONSTRAINT shot_revision_planned_duration_ms_check
  CHECK (planned_duration_ms IS NULL OR planned_duration_ms BETWEEN 1000 AND 15000);

-- The m2a immutability function, with the new column compared like every other content column.
CREATE OR REPLACE FUNCTION m2_reject_shot_content_update() RETURNS trigger
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
     OR NEW.planned_duration_ms IS DISTINCT FROM OLD.planned_duration_ms
     OR NEW.prompt_text IS DISTINCT FROM OLD.prompt_text
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'revision content is immutable';
  END IF;
  RETURN NEW;
END $$;

-- Which scene each breakdown wrote, and whether its proposed shots were written. Shots are written only under an
-- approved scene revision (placed_scene_revision_id), never under a draft one.
CREATE TABLE script_breakdown_scene (
  run_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  scene_key text NOT NULL CHECK (scene_key ~ '^S[1-8]$'),
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 8),
  scene_id uuid NOT NULL,
  scene_revision_id uuid NOT NULL,
  shot_save text NOT NULL DEFAULT 'pending' CHECK (shot_save IN ('pending', 'saved')),
  placed_scene_revision_id uuid,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, scene_key),
  UNIQUE (run_id, ordinal),
  UNIQUE (scene_revision_id),
  CHECK ((shot_save = 'saved') = (placed_scene_revision_id IS NOT NULL)),
  FOREIGN KEY (run_id, workspace_id) REFERENCES title_writing_run (id, workspace_id),
  FOREIGN KEY (scene_revision_id, scene_id, project_id, workspace_id)
    REFERENCES scene_revision (id, scene_id, project_id, workspace_id),
  FOREIGN KEY (placed_scene_revision_id, scene_id, project_id, workspace_id)
    REFERENCES scene_revision (id, scene_id, project_id, workspace_id)
);
CREATE INDEX script_breakdown_scene_scene_idx ON script_breakdown_scene (workspace_id, scene_id);
