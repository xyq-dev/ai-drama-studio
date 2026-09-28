-- Fine dependencies are immutable input facts; the original revision FK is never rebased.
CREATE TABLE script_source_dependency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  script_revision_id uuid NOT NULL,
  consumer_type text NOT NULL CHECK (consumer_type IN ('scene_revision','shot_revision','character_revision','location_revision')),
  consumer_revision_id uuid NOT NULL,
  scene_revision_id uuid,
  shot_revision_id uuid,
  character_revision_id uuid,
  location_revision_id uuid,
  source_path text[] NOT NULL CHECK (cardinality(source_path) <= 32 AND array_position(source_path, NULL) IS NULL),
  source_value jsonb NOT NULL,
  source_value_hash text NOT NULL CHECK (source_value_hash = encode(digest(source_value::text, 'sha256'), 'hex')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT script_source_dependency_consumer_path_key UNIQUE (consumer_type, consumer_revision_id, script_revision_id, source_path),
  CHECK (num_nonnulls(scene_revision_id, shot_revision_id, character_revision_id, location_revision_id) = 1),
  CHECK ((
    (consumer_type = 'scene_revision' AND scene_revision_id = consumer_revision_id)
    OR (consumer_type = 'shot_revision' AND shot_revision_id = consumer_revision_id)
    OR (consumer_type = 'character_revision' AND character_revision_id = consumer_revision_id)
    OR (consumer_type = 'location_revision' AND location_revision_id = consumer_revision_id)
  ) IS TRUE),
  FOREIGN KEY (script_revision_id, project_id, workspace_id) REFERENCES script_revision (id, project_id, workspace_id),
  FOREIGN KEY (scene_revision_id, project_id, workspace_id) REFERENCES scene_revision (id, project_id, workspace_id),
  FOREIGN KEY (shot_revision_id, project_id, workspace_id) REFERENCES shot_revision (id, project_id, workspace_id),
  FOREIGN KEY (character_revision_id, project_id, workspace_id) REFERENCES character_revision (id, project_id, workspace_id),
  FOREIGN KEY (location_revision_id, project_id, workspace_id) REFERENCES location_revision (id, project_id, workspace_id)
);
CREATE INDEX script_source_dependency_source_idx ON script_source_dependency (workspace_id, project_id, script_revision_id);

CREATE FUNCTION m2_validate_script_source_dependency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  source_episode_id uuid;
  source_content jsonb;
  selected_script_id uuid;
  source_freshness text;
  consumer_review text;
  consumer_freshness text;
  consumer_current_id uuid;
  consumer_parent_id uuid;
  consumer_parent_table text;
  consumer_parent_column text;
  original_script_id uuid;
  consumer_episode_id uuid;
BEGIN
  PERFORM id FROM project WHERE id = NEW.project_id AND workspace_id = NEW.workspace_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM stale_recalculation WHERE project_id = NEW.project_id AND workspace_id = NEW.workspace_id
               AND status IN ('PENDING', 'RUNNING')) THEN
    RAISE EXCEPTION 'script dependencies cannot bind while stale propagation is pending';
  END IF;
  SELECT episode_id INTO source_episode_id FROM script_revision
   WHERE id = NEW.script_revision_id AND workspace_id = NEW.workspace_id AND project_id = NEW.project_id;
  SELECT current_script_revision_id INTO selected_script_id FROM episode
   WHERE id = source_episode_id AND workspace_id = NEW.workspace_id AND project_id = NEW.project_id FOR SHARE;
  SELECT content_json, freshness_status INTO source_content, source_freshness FROM script_revision
   WHERE id = NEW.script_revision_id AND workspace_id = NEW.workspace_id AND project_id = NEW.project_id FOR SHARE;
  IF selected_script_id IS DISTINCT FROM NEW.script_revision_id OR source_freshness IS DISTINCT FROM 'CURRENT' THEN
    RAISE EXCEPTION 'script dependency source must be current and fresh';
  END IF;
  IF NEW.consumer_type NOT IN ('scene_revision','shot_revision','character_revision','location_revision') THEN
    RAISE EXCEPTION 'unsupported script dependency consumer';
  END IF;
  consumer_parent_table := replace(NEW.consumer_type, '_revision', '');
  consumer_parent_column := consumer_parent_table || '_id';
  EXECUTE format('SELECT %I FROM %I WHERE id = $1 AND workspace_id = $2 AND project_id = $3',
    consumer_parent_column, NEW.consumer_type)
    INTO consumer_parent_id USING NEW.consumer_revision_id, NEW.workspace_id, NEW.project_id;
  EXECUTE format('SELECT current_revision_id FROM %I WHERE id = $1 AND workspace_id = $2 AND project_id = $3 FOR UPDATE',
    consumer_parent_table)
    INTO consumer_current_id USING consumer_parent_id, NEW.workspace_id, NEW.project_id;
  EXECUTE format('SELECT review_status, freshness_status FROM %I WHERE id = $1 AND workspace_id = $2 AND project_id = $3 FOR UPDATE',
    NEW.consumer_type)
    INTO consumer_review, consumer_freshness USING NEW.consumer_revision_id, NEW.workspace_id, NEW.project_id;
  IF consumer_current_id IS DISTINCT FROM NEW.consumer_revision_id
     OR consumer_review IS DISTINCT FROM 'DRAFT' OR consumer_freshness IS DISTINCT FROM 'CURRENT' THEN
    RAISE EXCEPTION 'script dependencies can only bind a current fresh draft';
  END IF;
  IF NEW.consumer_type = 'scene_revision' THEN
    SELECT source_script_revision_id INTO original_script_id FROM scene_revision WHERE id = NEW.consumer_revision_id;
    IF original_script_id IS DISTINCT FROM NEW.script_revision_id THEN
      RAISE EXCEPTION 'script dependency does not match scene provenance';
    END IF;
  ELSIF NEW.consumer_type = 'shot_revision' THEN
    SELECT scene.episode_id INTO consumer_episode_id FROM shot_revision shot
      JOIN scene_revision scene ON scene.id = shot.source_scene_revision_id
     WHERE shot.id = NEW.consumer_revision_id;
    IF consumer_episode_id IS DISTINCT FROM source_episode_id THEN
      RAISE EXCEPTION 'script dependency belongs to another episode';
    END IF;
  ELSIF NEW.consumer_type = 'character_revision' THEN
    IF NOT EXISTS (SELECT 1 FROM character_revision_script_source
      WHERE character_revision_id = NEW.consumer_revision_id AND script_revision_id = NEW.script_revision_id
        AND workspace_id = NEW.workspace_id AND project_id = NEW.project_id) THEN
      RAISE EXCEPTION 'script dependency does not match character provenance';
    END IF;
  ELSIF NEW.consumer_type = 'location_revision' THEN
    IF NOT EXISTS (SELECT 1 FROM location_revision_script_source
      WHERE location_revision_id = NEW.consumer_revision_id AND script_revision_id = NEW.script_revision_id
        AND workspace_id = NEW.workspace_id AND project_id = NEW.project_id) THEN
      RAISE EXCEPTION 'script dependency does not match location provenance';
    END IF;
  END IF;
  NEW.source_value := source_content #> NEW.source_path;
  IF NEW.source_value IS NULL THEN RAISE EXCEPTION 'script dependency path does not exist'; END IF;
  NEW.source_value_hash := encode(digest(NEW.source_value::text, 'sha256'), 'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER script_source_dependency_validate BEFORE INSERT ON script_source_dependency
  FOR EACH ROW EXECUTE FUNCTION m2_validate_script_source_dependency();
CREATE TRIGGER script_source_dependency_immutable BEFORE UPDATE OR DELETE ON script_source_dependency
  FOR EACH ROW EXECUTE FUNCTION m2_reject_provenance_mutation();

-- A continuation always compares against this particular replacement, never a later selection.
CREATE TABLE script_revision_replacement (
  previous_script_revision_id uuid PRIMARY KEY,
  new_script_revision_id uuid NOT NULL UNIQUE,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (previous_script_revision_id <> new_script_revision_id),
  FOREIGN KEY (previous_script_revision_id, episode_id, project_id, workspace_id)
    REFERENCES script_revision (id, episode_id, project_id, workspace_id),
  FOREIGN KEY (new_script_revision_id, episode_id, project_id, workspace_id)
    REFERENCES script_revision (id, episode_id, project_id, workspace_id)
);
CREATE FUNCTION m2_validate_script_replacement() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE selected_id uuid; previous_no integer; next_no integer;
BEGIN
  SELECT current_script_revision_id INTO selected_id FROM episode
   WHERE id = NEW.episode_id AND workspace_id = NEW.workspace_id AND project_id = NEW.project_id FOR SHARE;
  SELECT revision_no INTO previous_no FROM script_revision WHERE id = NEW.previous_script_revision_id;
  SELECT revision_no INTO next_no FROM script_revision WHERE id = NEW.new_script_revision_id;
  IF selected_id IS DISTINCT FROM NEW.previous_script_revision_id OR next_no <= previous_no THEN
    RAISE EXCEPTION 'script replacement must advance the currently selected revision';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER script_revision_replacement_validate BEFORE INSERT ON script_revision_replacement
  FOR EACH ROW EXECUTE FUNCTION m2_validate_script_replacement();
CREATE TRIGGER script_revision_replacement_immutable BEFORE UPDATE OR DELETE ON script_revision_replacement
  FOR EACH ROW EXECUTE FUNCTION m2_reject_provenance_mutation();

-- Each source edge remains relational. Missing fine edges retain the whole-script dependency.
CREATE VIEW script_revision_consumer_source AS
  SELECT workspace_id, project_id, 'scene_revision'::text AS consumer_type,
         id AS consumer_revision_id, source_script_revision_id AS script_revision_id, created_at
    FROM scene_revision
  UNION ALL
  SELECT revision.workspace_id, revision.project_id, 'character_revision', revision.id, edge.script_revision_id, revision.created_at
    FROM character_revision revision JOIN character_revision_script_source edge ON edge.character_revision_id = revision.id
  UNION ALL
  SELECT revision.workspace_id, revision.project_id, 'location_revision', revision.id, edge.script_revision_id, revision.created_at
    FROM location_revision revision JOIN location_revision_script_source edge ON edge.location_revision_id = revision.id
  UNION ALL
  SELECT shot.workspace_id, shot.project_id, 'shot_revision', shot.id,
         COALESCE(edge.script_revision_id, scene.source_script_revision_id), shot.created_at
    FROM shot_revision shot JOIN scene_revision scene ON scene.id = shot.source_scene_revision_id
    LEFT JOIN (SELECT DISTINCT consumer_revision_id, script_revision_id FROM script_source_dependency
               WHERE consumer_type = 'shot_revision') edge ON edge.consumer_revision_id = shot.id;

CREATE FUNCTION m2_script_source_matches(
  scope_workspace uuid, scope_project uuid, consumer_kind text, consumer_id uuid, original_id uuid, selected_id uuid
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT original.source_story_revision_id = selected.source_story_revision_id AND
    CASE WHEN EXISTS (
      SELECT 1 FROM script_source_dependency dependency
       WHERE dependency.workspace_id = scope_workspace AND dependency.project_id = scope_project
         AND dependency.consumer_type = consumer_kind AND dependency.consumer_revision_id = consumer_id
         AND dependency.script_revision_id = original_id
    ) THEN NOT EXISTS (
      SELECT 1 FROM script_source_dependency dependency
       WHERE dependency.workspace_id = scope_workspace AND dependency.project_id = scope_project
         AND dependency.consumer_type = consumer_kind AND dependency.consumer_revision_id = consumer_id
         AND dependency.script_revision_id = original_id
         AND (selected.content_json #> dependency.source_path) IS DISTINCT FROM dependency.source_value
    ) ELSE original.content_json = selected.content_json END
    FROM script_revision original JOIN script_revision selected
      ON selected.episode_id = original.episode_id AND selected.project_id = original.project_id
     AND selected.workspace_id = original.workspace_id
   WHERE original.id = original_id AND selected.id = selected_id
     AND original.workspace_id = scope_workspace AND original.project_id = scope_project
$$;

CREATE FUNCTION m2_script_source_is_usable(
  scope_workspace uuid, scope_project uuid, consumer_kind text, consumer_id uuid, original_id uuid
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT original.freshness_status = 'CURRENT'
     AND episode.current_script_revision_id = episode.approved_script_revision_id
     AND selected.review_status = 'APPROVED' AND selected.freshness_status = 'CURRENT'
     AND project.current_story_revision_id = selected.source_story_revision_id
     AND project.approved_story_revision_id = selected.source_story_revision_id
     AND story.review_status = 'APPROVED' AND story.freshness_status = 'CURRENT'
     AND m2_script_source_matches(scope_workspace, scope_project, consumer_kind, consumer_id, original_id, selected.id)
    FROM script_revision original
    JOIN episode ON episode.id = original.episode_id AND episode.workspace_id = original.workspace_id
    JOIN script_revision selected ON selected.id = episode.current_script_revision_id
    JOIN project ON project.id = episode.project_id AND project.workspace_id = episode.workspace_id
    JOIN story_revision story ON story.id = selected.source_story_revision_id
   WHERE original.id = original_id AND original.workspace_id = scope_workspace AND original.project_id = scope_project
$$;
