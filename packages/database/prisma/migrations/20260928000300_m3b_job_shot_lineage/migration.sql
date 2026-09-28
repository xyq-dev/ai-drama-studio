ALTER TABLE generation_job
  ADD COLUMN source_shot_revision_id uuid,
  ADD CONSTRAINT generation_job_source_shot_revision_fk
    FOREIGN KEY (source_shot_revision_id, project_id, workspace_id)
    REFERENCES shot_revision(id, project_id, workspace_id);

CREATE INDEX generation_job_source_shot_revision_idx
  ON generation_job (workspace_id, source_shot_revision_id)
  WHERE source_shot_revision_id IS NOT NULL;

CREATE OR REPLACE FUNCTION m3b_reject_job_shot_lineage_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_shot_revision_id IS DISTINCT FROM OLD.source_shot_revision_id THEN
    RAISE EXCEPTION 'generation job shot lineage is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER generation_job_shot_lineage_immutable
BEFORE UPDATE OF source_shot_revision_id ON generation_job
FOR EACH ROW EXECUTE FUNCTION m3b_reject_job_shot_lineage_change();
