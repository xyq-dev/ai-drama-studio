import {
  SCRIPT_WORKBENCH_SCHEMA, estimateScriptWorkbench, scriptWorkbenchPlanSchema, scriptWorkbenchScriptSchema,
  type ScriptWorkbenchPlan, type ScriptWorkbenchScript,
} from "@ai-drama/contracts";
import type { PoolClient } from "pg";
import { PersistenceError } from "./job-service";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function workbenchPart(content: unknown): Record<string, unknown> | null {
  return object(object(content)?.workbench);
}
export function readWorkbenchPlan(content: unknown): ScriptWorkbenchPlan | null {
  const wb = workbenchPart(content);
  if (!wb) return null;
  const parsed = scriptWorkbenchPlanSchema.safeParse(wb.plan);
  if (wb.schema !== SCRIPT_WORKBENCH_SCHEMA || !parsed.success) throw new PersistenceError("VALIDATION_ERROR", "工作台立项或大纲格式无效。");
  return parsed.data;
}
export function readWorkbenchScript(content: unknown): ScriptWorkbenchScript | null {
  const wb = workbenchPart(content);
  if (!wb) return null;
  const parsed = scriptWorkbenchScriptSchema.safeParse(wb.script);
  if (wb.schema !== SCRIPT_WORKBENCH_SCHEMA || !parsed.success) throw new PersistenceError("VALIDATION_ERROR", "工作台正文格式无效。");
  return parsed.data;
}
function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new PersistenceError("VALIDATION_ERROR", `${label}不能重复。`);
}
export function validateWorkbenchPlan(plan: ScriptWorkbenchPlan, episodeCount: number, approving = false): void {
  unique(plan.bible.characters.map(c => c.id), "角色 ID");
  unique(plan.outline.episodes.map(e => String(e.episodeNo)), "分集编号");
  if (plan.outline.episodes.some(e => e.episodeNo > episodeCount)) throw new PersistenceError("VALIDATION_ERROR", "分集编号超过作品设置。");
  if (approving && (!plan.brief.genre.trim() || !plan.brief.audience.trim() || !plan.brief.productionConstraints.trim()
    || !plan.brief.logline.trim() || !plan.bible.ending.trim() || plan.bible.characters.length === 0
    || plan.bible.characters.some(c => !c.appearance.trim() || !c.voice.trim())
    || plan.outline.episodes.length !== episodeCount
    || plan.outline.episodes.some(e => !e.title.trim() || !e.openingHook.trim() || !e.change.trim() || !e.endingHandoff.trim()))) {
    throw new PersistenceError("REVIEW_REQUIRED", "请补齐题材、受众、制作边界、一句话梗概、结局、角色定妆声线及每集的开场、改变和交接，再确认计划版本。");
  }
}

export async function assertWorkbenchStoryApproval(client: PoolClient, workspaceId: string, projectId: string, revisionId: string): Promise<void> {
  const result = await client.query<{ content_json: unknown; episode_count: number }>(
    `SELECT r.content_json, coalesce((to_jsonb(p)->>'episode_count')::int, 3) AS episode_count
       FROM story_revision r JOIN project p ON p.id = r.project_id AND p.workspace_id = r.workspace_id
      WHERE r.id = $1 AND r.project_id = $2 AND r.workspace_id = $3`, [revisionId, projectId, workspaceId]);
  const row = result.rows[0];
  if (!row) throw new PersistenceError("NOT_FOUND", "计划版本不存在。");
  const plan = readWorkbenchPlan(row.content_json);
  if (plan) validateWorkbenchPlan(plan, row.episode_count, true);
}

/** Called under the project's existing write lock; legacy projects keep their original contract. */
export async function assertWorkbenchScript(
  client: PoolClient, input: { workspaceId: string; projectId: string; episodeId: string; sourceStoryRevisionId: string; content: unknown },
  approving = false,
): Promise<void> {
  const rows = await client.query<{ content_json: unknown; episode_no: number }>(
    `SELECT s.content_json, e.episode_no FROM story_revision s JOIN episode e ON e.project_id = s.project_id AND e.workspace_id = s.workspace_id
      WHERE s.id = $1 AND s.project_id = $2 AND s.workspace_id = $3 AND e.id = $4`,
    [input.sourceStoryRevisionId, input.projectId, input.workspaceId, input.episodeId]);
  const row = rows.rows[0];
  if (!row) throw new PersistenceError("NOT_FOUND", "正文或故事来源不存在。");
  const plan = readWorkbenchPlan(row.content_json);
  const script = readWorkbenchScript(input.content);
  if (!plan && !script) return;
  if (!plan || !script) throw new PersistenceError("REVIEW_REQUIRED", "结构化工作台正文需要对应的已确认工作台计划，请先在剧本工作台保存计划和正文。");
  unique(script.scenes.map(s => s.id), "场次 ID");
  unique(script.scenes.flatMap(s => s.beats.map(b => b.id)), "动作或对白 ID");
  const characters = new Set(plan.bible.characters.map(c => c.id));
  for (const scene of script.scenes) {
    unique(scene.characterIds, "出场角色");
    if (scene.characterIds.some(id => !characters.has(id))) throw new PersistenceError("VALIDATION_ERROR", "出场角色必须使用系列圣经中的角色 ID。");
    for (const beat of scene.beats) {
      if (beat.kind === "dialogue" && (!beat.characterId || !characters.has(beat.characterId) || !scene.characterIds.includes(beat.characterId))) {
        throw new PersistenceError("VALIDATION_ERROR", "每句对白必须绑定本场出场且在系列圣经中的角色 ID。");
      }
    }
  }
  if (row.episode_no > 1) {
    const previous = await client.query<{ id: string; content_json: unknown }>(
      `SELECT s.id, s.content_json FROM episode e JOIN script_revision s ON s.id = e.current_script_revision_id
        AND s.workspace_id = e.workspace_id AND s.episode_id = e.id
       WHERE e.project_id = $1 AND e.workspace_id = $2 AND e.episode_no = $3
         AND e.approved_script_revision_id = s.id AND s.review_status = 'APPROVED' AND s.freshness_status = 'CURRENT'
         AND to_jsonb(s)->>'deleted_at' IS NULL`, [input.projectId, input.workspaceId, row.episode_no - 1]);
    const prev = previous.rows[0];
    if (!prev || prev.id !== script.previousRevisionId) throw new PersistenceError("SOURCE_STALE", "请先锁定上一集，并核对、选择上一集当前锁定的具体版本。");
    const prevScript = readWorkbenchScript(prev.content_json);
    if (prevScript && script.previousHandoff.trim() !== prevScript.endingHandoff.trim()) {
      throw new PersistenceError("SOURCE_STALE", "接上集内容与上一集已锁版本的集尾交接不一致，请重新核对。");
    }
  } else if (script.previousRevisionId !== null) throw new PersistenceError("VALIDATION_ERROR", "第 1 集不能引用上一集。");
  if (!approving) return;
  const estimate = estimateScriptWorkbench(script);
  if (estimate.seconds > plan.brief.targetEpisodeSeconds || estimate.dialogueCount > plan.brief.dialogueQuota) {
    throw new PersistenceError("REVIEW_REQUIRED", "本集估时或对白用量超过作品配额，请修订后再定稿。");
  }
  const review = script.review;
  if (!script.title.trim() || !script.openingHook.trim() || !script.change.trim() || !script.endingHandoff.trim()
    || !script.characterKnowledge.trim() || !script.unresolvedThreads.trim() || script.scenes.length === 0
    || script.scenes.some(s => !s.heading.trim() || s.beats.length === 0 || s.beats.some(b => b.kind !== "pause" && !b.text.trim()
      || b.kind !== "dialogue" && b.seconds <= 0))
    || !review || !review.identityClear || !review.goalClear || !review.obstacleClear || !review.continuityChecked || !review.lockedMaterialsChecked) {
    throw new PersistenceError("REVIEW_REQUIRED", "请补齐可拍场次、动作与停顿计时、角色已知信息、未回收悬念，以及审稿检查，再确认定稿版本。没有悬念时可填写“无”。");
  }
}

/** A changed earlier episode invalidates every later revision that froze its old version, transitively. */
export async function invalidateWorkbenchDependents(client: PoolClient, workspaceId: string, projectId: string, previousId: string): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `WITH RECURSIVE affected AS (
       SELECT id FROM script_revision WHERE workspace_id = $1 AND project_id = $2
         AND content_json->'workbench'->'script'->>'previousRevisionId' = $3
       UNION
       SELECT r.id FROM script_revision r JOIN affected a ON r.content_json->'workbench'->'script'->>'previousRevisionId' = a.id::text
         WHERE r.workspace_id = $1 AND r.project_id = $2
     ) UPDATE script_revision r SET freshness_status = 'STALE', stale_reason = 'PREVIOUS_EPISODE_REPLACED', stale_from_ref = $3
       WHERE r.id IN (SELECT id FROM affected) AND r.workspace_id = $1 AND r.freshness_status = 'CURRENT' RETURNING r.id`,
    [workspaceId, projectId, previousId]);
  return result.rows.map(r => r.id);
}
