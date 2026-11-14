import type { ScriptWorkbenchPlan } from "@ai-drama/contracts";
import { canonicalJson, completedShortSequelOutline, inheritShortSequelPlan } from "@ai-drama/domain";
import type { PoolClient } from "pg";
import { PersistenceError } from "./job-service";
import { shortSequelContextIn, shortSequelEpisodesIn } from "./short-sequel";
import { readWorkbenchPlan } from "./script-workbench-validation";

type Scope = { workspaceId: string; projectId: string };
type PlanImpact = { storyRevisionId: string; episodes: number[] | null };

function sameSetting(before: ScriptWorkbenchPlan, after: ScriptWorkbenchPlan): boolean {
  return canonicalJson({ brief: before.brief, bible: before.bible }) === canonicalJson({ brief: after.brief, bible: after.bible });
}

function changedOutline(before: ScriptWorkbenchPlan, after: ScriptWorkbenchPlan): number[] {
  const current = new Map(after.outline.episodes.map(item => [item.episodeNo, item]));
  return before.outline.episodes.filter(old => completedShortSequelOutline(old)
    && canonicalJson(old) !== canonicalJson(current.get(old.episodeNo) ?? null)).map(item => item.episodeNo);
}

export async function assertInheritedSequelPlan(
  client: PoolClient, scope: Scope, episodeNo: number, previous: ScriptWorkbenchPlan | null, next: ScriptWorkbenchPlan,
): Promise<void> {
  const context = await shortSequelContextIn(client, scope, episodeNo);
  const inherited = previous ?? inheritShortSequelPlan(context.original, context.targetEpisodeSeconds, episodeNo - 1);
  if (!inherited) throw new PersistenceError("SOURCE_STALE", "原作设定与大纲不可用，请先在原作品确认设定。");
  if (!sameSetting(inherited, next) || changedOutline(inherited, next).some(number => number < episodeNo)) {
    throw new PersistenceError("SOURCE_STALE", "续写大纲须沿用原设定与已完成的前集大纲；需要修改时请进入设定修订。");
  }
}

/** A plan may still have usable production rooted in an older approved outline. Compare all such roots. */
export async function affectedSequelStoryPlans(
  client: PoolClient, scope: Scope, approvedStoryRevisionId: string,
): Promise<PlanImpact[]> {
  const added = await shortSequelEpisodesIn(client, scope);
  if (!added.length) return [];
  const result = await client.query<{ id: string; content_json: unknown; episode_nos: number[] }>(`
    SELECT story.id, story.content_json, ARRAY(
      SELECT DISTINCT e.episode_no FROM script_revision r JOIN episode e
        ON e.id = r.episode_id AND e.workspace_id = r.workspace_id AND e.project_id = r.project_id
      WHERE r.workspace_id = story.workspace_id AND r.project_id = story.project_id AND r.source_story_revision_id = story.id
        AND to_jsonb(r)->>'deleted_at' IS NULL
    ) AS episode_nos
    FROM story_revision story
    WHERE story.workspace_id = $1 AND story.project_id = $2
      AND (story.id = $3 OR EXISTS (SELECT 1 FROM script_revision r WHERE r.workspace_id = story.workspace_id
        AND r.project_id = story.project_id AND r.source_story_revision_id = story.id))
    ORDER BY story.revision_no`, [scope.workspaceId, scope.projectId, approvedStoryRevisionId]);
  const approved = result.rows.find(row => row.id === approvedStoryRevisionId);
  const next = readWorkbenchPlan(approved?.content_json);
  if (!next) throw new PersistenceError("REVIEW_REQUIRED", "请先确认新版设定与大纲。");

  const legacy = result.rows.some(row => row.id !== approvedStoryRevisionId && row.episode_nos.length && !readWorkbenchPlan(row.content_json));
  let originalStoryId: string | null = null;
  let originalPlan: ScriptWorkbenchPlan | null = null;
  if (legacy) {
    const first = added[0]!;
    const context = await shortSequelContextIn(client, scope, first.episodeNo);
    originalStoryId = (await client.query<{ story_revision_id: string | null }>(
      "SELECT story_revision_id FROM auto_creation_run WHERE id = $1 AND workspace_id = $2 AND project_id = $3",
      [first.originalRunId, scope.workspaceId, scope.projectId],
    )).rows[0]?.story_revision_id ?? null;
    originalPlan = inheritShortSequelPlan(context.original, context.targetEpisodeSeconds, first.episodeNo - 1);
  }

  return result.rows.flatMap((row): PlanImpact[] => {
    if (row.id === approvedStoryRevisionId || !row.episode_nos.length) return [];
    const previous = readWorkbenchPlan(row.content_json) ?? (row.id === originalStoryId ? originalPlan : null);
    if (!previous || !sameSetting(previous, next)) return [{ storyRevisionId: row.id, episodes: null }];
    const edited = changedOutline(previous, next);
    const firstAffected = edited.length ? Math.min(...edited) : Infinity;
    const episodes = row.episode_nos.filter(number => number >= firstAffected).sort((a, b) => a - b);
    return episodes.length ? [{ storyRevisionId: row.id, episodes }] : [];
  });
}
