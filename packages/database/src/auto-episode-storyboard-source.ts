import { PersistenceError, type DatabasePool } from "./job-service";

type StoryboardQueryClient = Pick<Awaited<ReturnType<DatabasePool["connect"]>>, "query">;

export interface AutoEpisodeStoryboardScope {
  workspaceId: string;
  projectId: string;
  runId: string;
}

export type AutoEpisodeStoryboardBlocker = "writing_not_finished" | "story_not_saved" | "story_review_required"
  | "script_not_placed" | "script_review_required" | "shots_not_ready" | "shot_source_stale";

interface AutoEpisodeStoryboardShot {
  shotRevisionId: string;
  shotId: string;
  caption: string;
}

export interface AutoEpisodeStoryboardSource {
  episodeNo: number;
  episodeId: string | null;
  blocked: AutoEpisodeStoryboardBlocker | null;
  shots: AutoEpisodeStoryboardShot[];
}

interface SourceRow {
  episode_no: number;
  episode_id: string | null;
  package_complete: boolean;
  story_saved: boolean;
  story_approved: boolean;
  script_placed: boolean;
  script_approved: boolean;
  scene_id: string | null;
  scene_ready: boolean;
  scene_source_stale: boolean;
  shot_id: string | null;
  shot_revision_id: string | null;
  shot_usable: boolean;
  action: string | null;
  actor_names: string[] | null;
  location_name: string | null;
}

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

const SOURCE_QUERY = `
  WITH RECURSIVE scoped AS (
    SELECT run.id, run.workspace_id, run.project_id, project.approved_story_revision_id,
           CASE WHEN run.input_json->>'episodeCount' ~ '^[1-6]$'
                THEN (run.input_json->>'episodeCount')::int ELSE 0 END AS episode_count,
           run.state <> 'running' AND EXISTS (
             SELECT 1 FROM auto_creation_stage review
             WHERE review.workspace_id = run.workspace_id AND review.run_id = run.id AND review.stage_key LIKE 'review:%'
           ) AND NOT EXISTS (
             SELECT 1 FROM auto_creation_stage unfinished
             WHERE unfinished.workspace_id = run.workspace_id AND unfinished.run_id = run.id AND unfinished.state <> 'completed'
           ) AS stages_complete,
           run.story_save = 'saved' AND own_story.id IS NOT NULL AS story_saved,
           project.current_story_revision_id = approved_story.id AND approved_story.review_status = 'APPROVED'
             AND approved_story.freshness_status = 'CURRENT' AS story_approved,
           NOT EXISTS (
             SELECT 1 FROM stale_recalculation pending WHERE pending.workspace_id = run.workspace_id AND pending.project_id = run.project_id
               AND pending.status IN ('PENDING', 'RUNNING')
           ) AS propagation_settled
    FROM auto_creation_run run
    JOIN project ON project.id = run.project_id AND project.workspace_id = run.workspace_id
      AND project.archived_at IS NULL AND project.status = 'ACTIVE'
    LEFT JOIN story_revision own_story ON own_story.id = run.story_revision_id
      AND own_story.workspace_id = run.workspace_id AND own_story.project_id = run.project_id
    LEFT JOIN story_revision approved_story ON approved_story.id = project.approved_story_revision_id
      AND approved_story.workspace_id = run.workspace_id AND approved_story.project_id = run.project_id
    WHERE run.workspace_id = $1 AND run.project_id = $2 AND run.id = $3
  ), episodes AS (
    SELECT numbers.episode_no, episode.id, episode.current_script_revision_id, episode.approved_script_revision_id,
           stage.stage_key, stage.script_save, stage.script_revision_id
    FROM scoped CROSS JOIN LATERAL generate_series(1, scoped.episode_count) numbers(episode_no)
    LEFT JOIN episode ON episode.workspace_id = scoped.workspace_id AND episode.project_id = scoped.project_id
      AND episode.episode_no = numbers.episode_no
    LEFT JOIN auto_creation_stage stage ON stage.workspace_id = scoped.workspace_id AND stage.run_id = scoped.id
      AND stage.stage_key = 'episode:' || numbers.episode_no::text
  ), target_episode AS (
    SELECT episode.id
    FROM episodes episode CROSS JOIN scoped
    JOIN shot target ON target.episode_id = episode.id AND target.workspace_id = scoped.workspace_id AND target.project_id = scoped.project_id
    WHERE target.current_revision_id = $4::uuid AND target.archived_at IS NULL
  ), script_lineage(episode_id, revision_id, story_revision_id) AS (
    SELECT episode.id, placed.id, placed.source_story_revision_id
    FROM episodes episode CROSS JOIN scoped
    JOIN script_revision placed ON placed.workspace_id = scoped.workspace_id AND placed.project_id = scoped.project_id
    WHERE placed.id = episode.script_revision_id AND placed.episode_id = episode.id AND episode.script_save = 'saved'
      AND placed.stale_reason IS DISTINCT FROM 'SCRIPT_TRASHED'
    UNION ALL
    SELECT lineage.episode_id, next_script.id, lineage.story_revision_id
    FROM script_lineage lineage CROSS JOIN scoped
    JOIN script_revision_replacement replacement ON replacement.workspace_id = scoped.workspace_id AND replacement.project_id = scoped.project_id
    JOIN script_revision next_script ON next_script.id = replacement.new_script_revision_id
      AND next_script.workspace_id = scoped.workspace_id AND next_script.project_id = scoped.project_id
    WHERE replacement.previous_script_revision_id = lineage.revision_id AND replacement.episode_id = lineage.episode_id
      AND next_script.source_story_revision_id = lineage.story_revision_id
      AND next_script.stale_reason IS DISTINCT FROM 'SCRIPT_TRASHED'
  )
  SELECT episode.episode_no, episode.id AS episode_id,
         scoped.stages_complete AND NOT EXISTS (SELECT 1 FROM episodes missing WHERE missing.stage_key IS NULL) AS package_complete,
         scoped.story_saved, scoped.story_approved,
         EXISTS (
           SELECT 1 FROM script_lineage lineage
           WHERE lineage.episode_id = episode.id AND lineage.revision_id = episode.current_script_revision_id
         ) AS script_placed,
         current_script.id = episode.approved_script_revision_id AND current_script.review_status = 'APPROVED'
           AND current_script.freshness_status = 'CURRENT'
           AND current_script.source_story_revision_id = scoped.approved_story_revision_id AS script_approved,
         scene.id AS scene_id,
         scene.approved_revision_id = scene_revision.id AND scene_revision.review_status = 'APPROVED' AS scene_ready,
         scene_revision.id IS NOT NULL AND (
           scene_revision.freshness_status IS DISTINCT FROM 'CURRENT'
           OR scene_revision.source_script_revision_id IS DISTINCT FROM episode.current_script_revision_id
         ) AS scene_source_stale,
         shot.id AS shot_id, revision.id AS shot_revision_id,
         scoped.propagation_settled AND revision.source_scene_revision_id = scene_revision.id
           AND revision.review_status IN ('DRAFT', 'IN_REVIEW', 'APPROVED') AND revision.freshness_status = 'CURRENT'
           AND scene.approved_revision_id = scene_revision.id
           AND scene_revision.review_status = 'APPROVED' AND scene_revision.freshness_status = 'CURRENT'
           AND scene_revision.source_script_revision_id = episode.current_script_revision_id
           AND NOT EXISTS (
             SELECT 1 FROM script_revision_consumer_source source
             WHERE source.workspace_id = scoped.workspace_id AND source.project_id = scoped.project_id
               AND source.consumer_type = 'shot_revision' AND source.consumer_revision_id = revision.id
               AND (source.script_revision_id IS DISTINCT FROM episode.current_script_revision_id
                 OR m2_script_source_is_usable(source.workspace_id, source.project_id, source.consumer_type,
                       source.consumer_revision_id, source.script_revision_id) IS DISTINCT FROM true)
           ) AND NOT EXISTS (
             SELECT 1 FROM shot_character_reference ref
             JOIN character_revision cr ON cr.id = ref.character_revision_id AND cr.workspace_id = ref.workspace_id AND cr.project_id = ref.project_id
             JOIN character actor ON actor.id = cr.character_id AND actor.workspace_id = ref.workspace_id AND actor.project_id = ref.project_id
             WHERE ref.workspace_id = scoped.workspace_id AND ref.project_id = scoped.project_id AND ref.shot_revision_id = revision.id
               AND (actor.archived_at IS NOT NULL OR actor.current_revision_id IS DISTINCT FROM cr.id
                 OR actor.approved_revision_id IS DISTINCT FROM cr.id OR cr.review_status <> 'APPROVED' OR cr.freshness_status <> 'CURRENT')
           ) AS shot_usable,
         left(revision.action, 136) AS action, cast_names.actor_names, left(location.name, 30) AS location_name
  FROM episodes episode CROSS JOIN scoped
  LEFT JOIN script_revision current_script ON current_script.id = episode.current_script_revision_id
    AND current_script.episode_id = episode.id AND current_script.workspace_id = scoped.workspace_id AND current_script.project_id = scoped.project_id
  LEFT JOIN scene ON scene.episode_id = episode.id AND scene.workspace_id = scoped.workspace_id AND scene.project_id = scoped.project_id
    AND scene.archived_at IS NULL AND ($4::uuid IS NULL OR episode.id = (SELECT id FROM target_episode))
  LEFT JOIN scene_revision ON scene_revision.id = scene.current_revision_id AND scene_revision.scene_id = scene.id
    AND scene_revision.episode_id = episode.id AND scene_revision.workspace_id = scoped.workspace_id AND scene_revision.project_id = scoped.project_id
  LEFT JOIN shot ON shot.scene_id = scene.id AND shot.episode_id = episode.id
    AND shot.workspace_id = scoped.workspace_id AND shot.project_id = scoped.project_id
    AND shot.archived_at IS NULL AND shot.current_revision_id IS NOT NULL
  LEFT JOIN shot_revision revision ON revision.id = shot.current_revision_id AND revision.shot_id = shot.id
    AND revision.workspace_id = scoped.workspace_id AND revision.project_id = scoped.project_id
  LEFT JOIN location_revision lr ON lr.id = scene_revision.location_revision_id
    AND lr.workspace_id = scoped.workspace_id AND lr.project_id = scoped.project_id
  LEFT JOIN location ON location.id = lr.location_id AND location.workspace_id = scoped.workspace_id AND location.project_id = scoped.project_id
  LEFT JOIN LATERAL (
    SELECT array_agg(names.name ORDER BY names.name) AS actor_names FROM (
      SELECT DISTINCT left(actor.name, 16) AS name FROM shot_character_reference ref
      JOIN character_revision cr ON cr.id = ref.character_revision_id AND cr.workspace_id = ref.workspace_id AND cr.project_id = ref.project_id
      JOIN character actor ON actor.id = cr.character_id AND actor.workspace_id = ref.workspace_id AND actor.project_id = ref.project_id
      WHERE ref.workspace_id = scoped.workspace_id AND ref.project_id = scoped.project_id AND ref.shot_revision_id = revision.id
      ORDER BY name LIMIT 3
    ) names
  ) cast_names ON true
  ORDER BY episode.episode_no, scene_revision.ordinal, revision.ordinal, shot.id`;

function episodeBlocker(row: SourceRow): AutoEpisodeStoryboardBlocker | null {
  if (!row.package_complete) return "writing_not_finished";
  if (!row.story_saved) return "story_not_saved";
  if (!row.story_approved) return "story_review_required";
  if (!row.episode_id || !row.script_placed) return "script_not_placed";
  if (!row.script_approved) return "script_review_required";
  return null;
}

function caption(row: SourceRow): string {
  const clean = (value: string | null | undefined) => value?.replace(/\s+/gu, " ").trim();
  const actors = row.actor_names?.slice(0, 3).map(clean).filter(Boolean).join("、");
  const line = [clean(row.location_name), actors, clean(row.action)].filter(Boolean).join(" · ");
  const chars = Array.from(line);
  return chars.length > 216 ? `${chars.slice(0, 216).join("")}…` : line || "已保存镜头";
}

function scopeValues(scope: AutoEpisodeStoryboardScope): [string, string, string] {
  const values: [string, string, string] = [scope.workspaceId, scope.projectId, scope.runId];
  if (!values.every((value) => UUID.test(value))) throw new PersistenceError("NOT_FOUND", "Automatic writing run not found");
  return values;
}

async function findSources(client: StoryboardQueryClient, values: [string, string, string], target: string | null): Promise<AutoEpisodeStoryboardSource[]> {
  const { rows } = await client.query<SourceRow>(SOURCE_QUERY, [...values, target]);
  if (!rows.length) throw new PersistenceError("NOT_FOUND", "Automatic writing run not found");
  const episodes = new Map<number, { source: AutoEpisodeStoryboardSource; missingShot: boolean; staleSource: boolean }>();
  for (const row of rows) {
    let episode = episodes.get(row.episode_no);
    if (!episode) {
      episode = { source: { episodeNo: row.episode_no, episodeId: row.episode_id, blocked: episodeBlocker(row), shots: [] },
        missingShot: false, staleSource: false };
      episodes.set(row.episode_no, episode);
    }
    if (episode.source.blocked) continue;
    if (!row.scene_id || !row.scene_ready || !row.shot_id) episode.missingShot = true;
    if (row.scene_source_stale || (row.shot_id && (!row.shot_usable || !row.shot_revision_id))) episode.staleSource = true;
    if (row.shot_usable && row.shot_id && row.shot_revision_id) {
      episode.source.shots.push({ shotRevisionId: row.shot_revision_id, shotId: row.shot_id, caption: caption(row) });
    }
  }
  return Array.from(episodes.values(), ({ source, missingShot, staleSource }) => {
    const blocked = source.blocked ?? (staleSource ? "shot_source_stale" : missingShot ? "shots_not_ready" : null);
    return { ...source, blocked, shots: blocked ? [] : source.shots };
  });
}

/** A read-only projection of the writing run's saved episode/shot lineage. */
export function readAutoEpisodeStoryboardSources(client: StoryboardQueryClient, scope: AutoEpisodeStoryboardScope): Promise<AutoEpisodeStoryboardSource[]> {
  return findSources(client, scopeValues(scope), null);
}

/** Call inside the existing media transaction. Text-chain revisions and stale propagation use the same project lock. */
export async function requireAutoEpisodeStoryboardShot(
  client: StoryboardQueryClient, scope: AutoEpisodeStoryboardScope, shotRevisionId: string,
): Promise<AutoEpisodeStoryboardShot & { episodeNo: number; episodeId: string }> {
  const values = scopeValues(scope);
  const lock = await client.query(`SELECT id FROM project WHERE workspace_id = $1 AND id = $2
    AND archived_at IS NULL AND status = 'ACTIVE' FOR UPDATE`, values.slice(0, 2));
  if (!lock.rows[0]) throw new PersistenceError("NOT_FOUND", "Automatic writing run not found");
  const target = UUID.test(shotRevisionId) ? shotRevisionId.toLowerCase() : null;
  const episodes = await findSources(client, values, target);
  for (const episode of episodes) {
    const shot = episode.shots.find((item) => item.shotRevisionId === target);
    if (shot && episode.episodeId) return { ...shot, episodeNo: episode.episodeNo, episodeId: episode.episodeId };
  }
  throw new PersistenceError("AUTO_STORYBOARD_SOURCE_NOT_READY", "Storyboard shot is not a current source of this automatic writing run");
}
