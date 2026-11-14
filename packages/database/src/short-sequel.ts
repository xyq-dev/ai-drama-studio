import { SCRIPT_WORKBENCH_SCHEMA, SHORT_SEQUEL_AI_SCHEMA, canBindShortSequelFirstPlan, shortSequelDraftIsExpired } from "@ai-drama/contracts";
import type {
  AutoBible, AutoCreationFrozenInput, AutoDirectionsOutput, AutoEpisode, AutoOutline, AutoStageRecord, AutoStoredResearch,
  ShortSequelAiInput,
} from "@ai-drama/contracts";
import { autoContextFromStages, canonicalInputHash, formatAutoEpisode } from "@ai-drama/domain";
import type { PoolClient } from "pg";
import { episodePlanReadyIn } from "./episode-plan";
import { PersistenceError, type DatabasePool } from "./job-service";
import { readWorkbenchPlan, readWorkbenchScript, workbenchPart } from "./script-workbench-validation";

const EXPANDED = "project.short_sequel_added";
const MAX_EPISODES = 6;

type Scope = { workspaceId: string; projectId: string };
interface Project {
  episode_count: number; writing_mode: string; target_episode_seconds: number | null;
  current_story_revision_id: string | null; approved_story_revision_id: string | null;
}
interface AddedEpisode { episodeNo: number; episodeId: string; originalRunId: string }
interface OriginalRun { id: string; episodeCount: number; episodeSeconds: number; constraints: AutoCreationFrozenInput["constraints"] }
interface Episode {
  id: string; episode_no: number; approved_script_revision_id: string | null; script_id: string | null;
  script_content: Record<string, unknown> | null; script_review: string | null; script_freshness: Freshness | null;
  locked_freshness: Freshness | null;
}
type Freshness = "CURRENT" | "STALE";
export interface ShortSequelRefs {
  previousRevisionId: string | null;
  originalRunId: string | null;
  originalEpisodeHash: string | null;
}
export interface ShortSequelBodyRefs extends ShortSequelRefs {
  episodeCount: number;
  planConfirmation: number;
  aiAttemptId?: string;
}
export interface ShortSequelContext extends ShortSequelRefs {
  episodeNo: number; episodeId: string; episodeCount: number; targetEpisodeSeconds: number;
  storyRevisionId: string | null; storyConfirmed: boolean; story: Record<string, unknown> | null;
  previousEpisodeNo: number; previousLocked: boolean; previousScript: Record<string, unknown> | null;
  confirmedStoryRevisionId: string | null; lastConfirmedStoryRevisionId: string | null; lockedPreviousRevisionId: string | null;
  currentStoryRevisionId: string | null; currentStoryRevisionNo: number | null; lastConfirmedStoryRevisionNo: number | null;
  lastConfirmedEpisodeCount: number | null; planConfirmation: number;
  previousFreshnessStatus: Freshness | null; lockedPreviousFreshnessStatus: Freshness | null; previousHandoff: string | null;
  hasBody: boolean;
  /** If the preceding package draft has since been placed unchanged, old package references still match it. */
  placedOriginal: { runId: string; episodeHash: string } | null;
  lockedOriginal: { runId: string; episodeHash: string } | null;
  original: {
    runId: string; constraints: AutoCreationFrozenInput["constraints"]; research: AutoStoredResearch | null;
    topic: AutoDirectionsOutput | null; story: AutoBible | null; outline: AutoOutline | null;
    previousScript: AutoEpisode | null; previousScriptText: string | null; previousStageHash: string | null;
  };
}

async function projectIn(client: PoolClient, scope: Scope, lock = false): Promise<Project> {
  const result = await client.query<Project>(
    `SELECT coalesce((to_jsonb(p)->>'episode_count')::int, 3) AS episode_count,
            coalesce(to_jsonb(p)->>'writing_mode', 'short') AS writing_mode,
            (to_jsonb(p)->>'target_episode_seconds')::int AS target_episode_seconds,
            current_story_revision_id, approved_story_revision_id
       FROM project p WHERE id = $1 AND workspace_id = $2 AND status = 'ACTIVE' AND archived_at IS NULL
       ${lock ? "FOR UPDATE" : ""}`, [scope.projectId, scope.workspaceId]);
  if (!result.rows[0]) throw new PersistenceError("NOT_FOUND", "作品不存在或已移入回收站。");
  return result.rows[0];
}

export async function shortSequelEpisodesIn(client: PoolClient, { projectId, workspaceId }: Scope): Promise<AddedEpisode[]> {
  const result = await client.query<AddedEpisode>(
    `SELECT e.episode_no AS "episodeNo", e.id AS "episodeId", d.payload_json->>'originalRunId' AS "originalRunId"
       FROM domain_event d JOIN episode e ON e.id = d.aggregate_id AND e.project_id = d.project_id AND e.workspace_id = d.workspace_id
      WHERE d.project_id = $1 AND d.workspace_id = $2 AND d.event_type = $3
      ORDER BY e.episode_no`, [projectId, workspaceId, EXPANDED]);
  return result.rows;
}

export async function isShortSequelOriginalEpisode(client: PoolClient, scope: Scope, episodeId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM episode e WHERE e.id = $3 AND e.workspace_id = $1 AND e.project_id = $2
       AND EXISTS (SELECT 1 FROM domain_event d WHERE d.workspace_id = $1 AND d.project_id = $2 AND d.event_type = $4)
       AND NOT EXISTS (SELECT 1 FROM domain_event d WHERE d.workspace_id = $1 AND d.project_id = $2 AND d.event_type = $4 AND d.aggregate_id = e.id)`,
    [scope.workspaceId, scope.projectId, episodeId, EXPANDED]);
  return result.rows.length > 0;
}

async function hasAutoRuns(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ ready: boolean }>("SELECT to_regclass('auto_creation_run') IS NOT NULL AS ready");
  return result.rows[0]?.ready === true;
}

async function originalRunIn(client: PoolClient, scope: Scope, runId: string | undefined, episodeCount: number): Promise<OriginalRun | null> {
  const result = await client.query<{ id: string; input_json: AutoCreationFrozenInput }>(
    `SELECT r.id, r.input_json FROM auto_creation_run r
      WHERE r.project_id = $1 AND r.workspace_id = $2 AND r.state = 'completed' AND r.story_save = 'saved'
        AND ($3::uuid IS NULL OR r.id = $3)
        AND (r.input_json->>'episodeCount')::int = $4
        AND EXISTS (SELECT 1 FROM auto_creation_stage s WHERE s.run_id = r.id AND s.state = 'completed' AND s.stage_key LIKE 'review:%')
        AND NOT EXISTS (SELECT 1 FROM auto_creation_stage s WHERE s.run_id = r.id AND s.state <> 'completed')
      ORDER BY r.created_at DESC, r.id DESC LIMIT 1`, [scope.projectId, scope.workspaceId, runId ?? null, episodeCount]);
  const row = result.rows[0];
  return row ? { id: row.id, episodeCount: row.input_json.episodeCount, episodeSeconds: row.input_json.episodeSeconds, constraints: row.input_json.constraints } : null;
}

async function expansionState(client: PoolClient, scope: Scope, lock = false) {
  const project = await projectIn(client, scope, lock);
  const continuations = await shortSequelEpisodesIn(client, scope);
  const first = continuations[0];
  const originalCount = first ? first.episodeNo - 1 : project.episode_count;
  const original = project.writing_mode === "short" && project.target_episode_seconds !== null && await hasAutoRuns(client)
    ? await originalRunIn(client, scope, first?.originalRunId, originalCount) : null;
  let nextEpisodeNo: number | null = null;
  if (original?.episodeSeconds === project.target_episode_seconds && project.episode_count < MAX_EPISODES) {
    const target = project.episode_count + 1;
    const existing = await client.query(`SELECT 1 FROM episode WHERE project_id = $1 AND workspace_id = $2 AND episode_no >= $3 LIMIT 1`,
      [scope.projectId, scope.workspaceId, target]);
    if (existing.rows.length === 0) nextEpisodeNo = target;
  }
  return { project, original, nextEpisodeNo, continuations };
}

export class ShortSequelStore {
  constructor(private readonly pool: DatabasePool) {}

  async list(workspaceId: string, projectId: string) {
    return this.inTransaction(true, async client => {
      const state = await expansionState(client, { workspaceId, projectId });
      return { episodeCount: state.project.episode_count, targetEpisodeSeconds: state.project.target_episode_seconds,
        nextEpisodeNo: state.nextEpisodeNo, continuations: state.continuations.map(({ episodeNo, episodeId }) => ({ episodeNo, episodeId })) };
    });
  }

  async confirm(workspaceId: string, projectId: string, episodeNo: number, traceId: string) {
    return this.inTransaction(false, async client => {
      const state = await expansionState(client, { workspaceId, projectId }, true);
      const { project, original } = state;
      const existing = state.continuations.find(episode => episode.episodeNo === episodeNo);
      if (existing) return { episodeNo, episodeId: existing.episodeId, episodeCount: project.episode_count };
      if (episodeNo !== state.nextEpisodeNo || !original) throw new PersistenceError("REVISION_CONFLICT", "当前无法新增这一集，请刷新作品后重试。");
      if (!await episodePlanReadyIn(client)) throw new PersistenceError("EPISODE_PLAN_UNAVAILABLE", "作品集数暂时无法更新。");
      const result = await client.query<{ id: string }>(
        `INSERT INTO episode (workspace_id, project_id, episode_no, title)
         VALUES ($1, $2, $3, $4) RETURNING id`, [workspaceId, projectId, episodeNo, `第 ${episodeNo} 集`]);
      const episodeId = result.rows[0]!.id;
      await client.query("UPDATE project SET episode_count = $3, version = version + 1, updated_at = now() WHERE id = $1 AND workspace_id = $2",
        [projectId, workspaceId, episodeNo]);
      await client.query(
        `INSERT INTO domain_event (workspace_id, project_id, aggregate_type, aggregate_id, event_type, payload_json, trace_id)
         VALUES ($1, $2, 'Episode', $3, $4, $5::jsonb, $6)`, [workspaceId, projectId, episodeId, EXPANDED,
          JSON.stringify({ episodeNo, originalRunId: original.id }), traceId]);
      return { episodeNo, episodeId, episodeCount: episodeNo };
    });
  }

  context(workspaceId: string, projectId: string, episodeNo: number): Promise<ShortSequelContext> {
    return this.inTransaction(true, client => shortSequelContextIn(client, { workspaceId, projectId }, episodeNo));
  }

  previous(workspaceId: string, projectId: string, episodeNo: number, revisionId: string) {
    return this.inTransaction(true, async client => {
      await projectIn(client, { workspaceId, projectId });
      const episodes = await shortSequelEpisodesIn(client, { workspaceId, projectId });
      if (!episodes.some(episode => episode.episodeNo === episodeNo)) throw new PersistenceError("NOT_FOUND", "未找到这一集续写。");
      const result = await client.query<{ revisionNo: number; content: Record<string, unknown>; freshnessStatus: Freshness }>(
        `SELECT s.revision_no AS "revisionNo", s.content_json AS content, s.freshness_status AS "freshnessStatus"
           FROM script_revision s JOIN episode e ON e.id = s.episode_id AND e.project_id = s.project_id AND e.workspace_id = s.workspace_id
          WHERE s.workspace_id = $1 AND s.project_id = $2 AND e.episode_no = $3 AND s.id = $4
            AND to_jsonb(s)->>'deleted_at' IS NULL`, [workspaceId, projectId, episodeNo - 1, revisionId]);
      const previous = result.rows[0];
      if (!previous) throw new PersistenceError("NOT_FOUND", "未找到引用的前集版本。");
      return { ...previous, revisionId, handoff: shortSequelHandoff(previous.content) };
    });
  }

  private async inTransaction<T>(readOnly: boolean, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function shortSequelHandoff(content: Record<string, unknown> | null): string | null {
  if (!content) return null;
  const structured = readWorkbenchScript(content);
  if (structured?.endingHandoff.trim()) return structured.endingHandoff.trim();
  if (typeof content.text !== "string") return null;
  // The original one-click formatter appends its immutable facts after the last scene.
  const marker = [...content.text.matchAll(/(?:^|\n)交接事实[：:]/gu)].at(-1);
  return marker ? content.text.slice(marker.index + marker[0].length).trim() || null : null;
}

export async function shortSequelContextIn(client: PoolClient, scope: Scope, episodeNo: number): Promise<ShortSequelContext> {
  const project = await projectIn(client, scope);
  const added = await shortSequelEpisodesIn(client, scope);
  const target = added.find(episode => episode.episodeNo === episodeNo);
  if (!target || project.writing_mode !== "short" || project.target_episode_seconds === null) {
    throw new PersistenceError("NOT_FOUND", "未找到这一集续写。");
  }
  const originalRun = await originalRunIn(client, scope, target.originalRunId, added[0]!.episodeNo - 1);
  if (!originalRun) throw new PersistenceError("SOURCE_STALE", "无法读取原一键编剧任务的已保存版本。");
  const episodes = await client.query<Episode>(
      `SELECT e.id, e.episode_no, e.approved_script_revision_id, s.id AS script_id, s.content_json AS script_content,
              s.review_status AS script_review, s.freshness_status AS script_freshness, locked.freshness_status AS locked_freshness
         FROM episode e LEFT JOIN script_revision s ON s.id = e.current_script_revision_id AND s.episode_id = e.id
          AND s.project_id = e.project_id AND s.workspace_id = e.workspace_id
         LEFT JOIN script_revision locked ON locked.id = e.approved_script_revision_id AND locked.episode_id = e.id
          AND locked.workspace_id = e.workspace_id AND locked.project_id = e.project_id
        WHERE e.project_id = $1 AND e.workspace_id = $2 AND e.episode_no IN ($3, $4)`,
      [scope.projectId, scope.workspaceId, episodeNo - 1, episodeNo]);
  const stories = await client.query<{ id: string; revision_no: number; content_json: Record<string, unknown>; review_status: string; freshness_status: string }>(
      "SELECT id, revision_no, content_json, review_status, freshness_status FROM story_revision WHERE project_id = $1 AND workspace_id = $2 AND id IN ($3, $4)",
      [scope.projectId, scope.workspaceId, project.current_story_revision_id, project.approved_story_revision_id]);
  const confirmations = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM story_revision WHERE workspace_id = $1 AND project_id = $2 AND review_status = 'APPROVED'
       AND content_json#>>'{workbench,schema}' = $3`, [scope.workspaceId, scope.projectId, SCRIPT_WORKBENCH_SCHEMA]);
  const savedStages = await client.query<Pick<AutoStageRecord, "stageKey" | "ordinal" | "state" | "output" | "outputHash" | "scriptRevisionId">>(
      `SELECT stage_key AS "stageKey", ordinal, state, output_json AS output, output_hash AS "outputHash", script_revision_id AS "scriptRevisionId"
         FROM auto_creation_stage WHERE run_id = $1 AND workspace_id = $2 AND state = 'completed'
          AND (stage_key IN ('research','directions','bible','outline') OR stage_key = $3 OR stage_key LIKE $4)`,
      [originalRun.id, scope.workspaceId, `episode:${episodeNo - 1}`, `revise:%:episode:${episodeNo - 1}`]);
  const context = autoContextFromStages(savedStages.rows.map(row => ({ ...row, runId: originalRun.id, attemptNo: 0, errorCode: null,
    dependsOn: null, scriptSave: null, updatedAt: "" })));
  const previousStage = context.episodes.get(episodeNo - 1);
  const previousStageHash = savedStages.rows.find(row => row.stageKey === previousStage?.stageKey)?.outputHash ?? null;
  const placed = savedStages.rows.find(row => row.stageKey === `episode:${episodeNo - 1}`)?.scriptRevisionId;
  const previousScriptText = context.bible && previousStage ? formatAutoEpisode(previousStage.episode, context.bible) : null;
  const previous = episodes.rows.find(row => row.episode_no === episodeNo - 1);
  const previousRevisionId = previous?.script_id ?? null;
  const matchesPlan = (value: unknown) => {
    const plan = readWorkbenchPlan(value);
    return plan !== null && plan.outline.episodes.length === project.episode_count
      && plan.outline.episodes.every(episode => episode.episodeNo <= project.episode_count)
      && plan.brief.targetEpisodeSeconds === project.target_episode_seconds;
  };
  const currentStory = stories.rows.find(row => row.id === project.current_story_revision_id);
  const story = currentStory && matchesPlan(currentStory.content_json) ? currentStory : null;
  const lastConfirmed = stories.rows.find(row => row.id === project.approved_story_revision_id && row.review_status === "APPROVED"
    && row.freshness_status === "CURRENT" && readWorkbenchPlan(row.content_json) !== null);
  const confirmed = lastConfirmed && matchesPlan(lastConfirmed.content_json) ? lastConfirmed : null;
  const storyRevisionId = story?.id ?? null;
  const packageFallback = !placed && previousScriptText !== null && previousStageHash !== null;
  const previousScript = previous?.script_content ?? (packageFallback ? { text: previousScriptText } : null);
  const usesPackageFacts = previousRevisionId === null ? packageFallback : previousRevisionId === placed;
  return {
    episodeNo, episodeId: target.episodeId, episodeCount: project.episode_count, targetEpisodeSeconds: project.target_episode_seconds,
    storyRevisionId, storyConfirmed: storyRevisionId !== null && storyRevisionId === confirmed?.id, story: story?.content_json ?? null,
    confirmedStoryRevisionId: confirmed?.id ?? null, lastConfirmedStoryRevisionId: lastConfirmed?.id ?? null,
    currentStoryRevisionId: currentStory?.id ?? null, currentStoryRevisionNo: currentStory?.revision_no ?? null,
    lastConfirmedStoryRevisionNo: lastConfirmed?.revision_no ?? null,
    lastConfirmedEpisodeCount: lastConfirmed ? readWorkbenchPlan(lastConfirmed.content_json)!.outline.episodes.length : null,
    planConfirmation: confirmations.rows[0]!.count,
    lockedPreviousRevisionId: previous?.approved_script_revision_id ?? null,
    previousEpisodeNo: episodeNo - 1, previousRevisionId,
    previousLocked: previousRevisionId !== null && previous?.approved_script_revision_id === previousRevisionId
      && previous.script_review === "APPROVED" && previous.script_freshness === "CURRENT",
    previousScript,
    previousFreshnessStatus: previous?.script_freshness ?? null, lockedPreviousFreshnessStatus: previous?.locked_freshness ?? null,
    previousHandoff: usesPackageFacts ? previousStage?.episode.handoffFacts.join("；").trim() || null : shortSequelHandoff(previousScript),
    originalRunId: previousRevisionId === null && packageFallback ? originalRun.id : null,
    originalEpisodeHash: previousRevisionId === null && packageFallback ? previousStageHash : null,
    placedOriginal: previousRevisionId !== null && previousRevisionId === placed && previousStageHash
      ? { runId: originalRun.id, episodeHash: previousStageHash } : null,
    lockedOriginal: placed && previous?.approved_script_revision_id === placed && previousStageHash
      ? { runId: originalRun.id, episodeHash: previousStageHash } : null,
    hasBody: episodes.rows.some(row => row.episode_no === episodeNo && row.script_id !== null),
    original: { runId: originalRun.id, constraints: originalRun.constraints, research: context.research ?? null,
      topic: context.directions ?? null, story: context.bible ?? null, outline: context.outline ?? null,
      previousScript: previousStage?.episode ?? null, previousScriptText, previousStageHash },
  };
}

export function shortSequelRefsMatch(refs: ShortSequelRefs, context: ShortSequelContext): boolean {
  if (refs.previousRevisionId !== null) {
    return refs.previousRevisionId === context.previousRevisionId && refs.originalRunId === null && refs.originalEpisodeHash === null;
  }
  return refs.originalRunId !== null && refs.originalEpisodeHash !== null && (
    (refs.originalRunId === context.originalRunId && refs.originalEpisodeHash === context.originalEpisodeHash)
    || (refs.originalRunId === context.placedOriginal?.runId && refs.originalEpisodeHash === context.placedOriginal.episodeHash));
}

export function shortSequelAiMaterials(context: ShortSequelContext, source: ShortSequelRefs) {
  const { original, story } = context;
  const originalPrevious = source.originalRunId === original.runId && source.originalEpisodeHash === original.previousStageHash;
  return { original: { research: original.research, topic: original.topic, story: original.story, outline: original.outline,
    constraints: original.constraints, previousScript: original.previousScript },
    previousScript: originalPrevious ? { text: original.previousScriptText } : context.previousScript,
    previousHandoff: originalPrevious ? original.previousScript?.handoffFacts.join("；").trim() || null : context.previousHandoff,
    story };
}

export function shortSequelAiStale(input: ShortSequelAiInput, context: ShortSequelContext): boolean {
  return input.episodeId !== context.episodeId || input.episodeCount !== context.episodeCount
    || input.targetEpisodeSeconds !== context.targetEpisodeSeconds || input.source.storyRevisionId !== context.storyRevisionId
    || context.previousFreshnessStatus === "STALE" || !context.previousScript || !shortSequelRefsMatch(input.source, context)
    || input.contextHash !== canonicalInputHash(shortSequelAiMaterials(context, input.source));
}

export function shortSequelAiDraftExpired(input: ShortSequelAiInput, context: ShortSequelContext): boolean {
  return input.episodeId !== context.episodeId || input.targetEpisodeSeconds !== context.targetEpisodeSeconds
    || shortSequelDraftIsExpired({ ...input.source, episodeCount: input.episodeCount }, context);
}

export async function assertShortSequelScript(client: PoolClient, input: Scope & { episodeId: string; sourceStoryRevisionId: string; content: unknown }, existingBody: boolean) {
  const added = await shortSequelEpisodesIn(client, input);
  const target = added.find(episode => episode.episodeId === input.episodeId);
  const wb = workbenchPart(input.content);
  const ref = wb?.continuation as Partial<ShortSequelBodyRefs> & ShortSequelRefs | undefined;
  if (!target) {
    if (ref !== undefined) throw new PersistenceError("VALIDATION_ERROR", "本集没有续写引用。");
    return null;
  }
  const context = await shortSequelContextIn(client, input, target.episodeNo);
  if (!context.storyConfirmed || context.storyRevisionId !== input.sourceStoryRevisionId) {
    throw new PersistenceError("REVIEW_REQUIRED", "请先在定稿交接确认含本集的新版设定与大纲。");
  }
  if (!ref || wb?.sourceStoryRevisionId !== context.storyRevisionId || !shortSequelRefsMatch(ref, context) || !context.previousScript) {
    throw new PersistenceError("SOURCE_STALE", "续写引用的设定、大纲或上一集已更新，请按当前版本改写。");
  }
  if (context.previousFreshnessStatus === "STALE") throw new PersistenceError("SOURCE_STALE", "上一集版本已过期，请先修订并锁定上一集。");
  if (!context.previousLocked) throw new PersistenceError("REVIEW_REQUIRED", "请先锁定上一集，再保存或提交本集正文。");
  const validCount = ref.episodeCount === context.episodeCount || (existingBody && ref.episodeCount === undefined);
  const validConfirmation = ref.planConfirmation === context.planConfirmation || ref.planConfirmation === context.planConfirmation - 1
    || (existingBody && ref.planConfirmation === undefined);
  if (!validCount || !validConfirmation) {
    throw new PersistenceError("SOURCE_STALE", "草稿的集数或大纲确认版本已更新，请重新编写。");
  }
  if (ref.aiAttemptId) {
    const available = await client.query<{ present: boolean }>("SELECT to_regclass('writing_candidate_request') IS NOT NULL AS present");
    if (!available.rows[0]?.present) throw new PersistenceError("SOURCE_STALE", "无法读取 AI 草稿的冻结版本。");
    const result = await client.query<{ input_json: ShortSequelAiInput }>(
      `SELECT input_json FROM writing_candidate_request WHERE id = $1 AND workspace_id = $2 AND project_id = $3
         AND episode_id = $4 AND state = 'completed' AND input_json->>'schema' = $5`,
      [ref.aiAttemptId, input.workspaceId, input.projectId, input.episodeId, SHORT_SEQUEL_AI_SCHEMA]);
    const ai = result.rows[0]?.input_json;
    if (!ai || ai.episodeId !== input.episodeId || ai.episodeNo !== target.episodeNo
      || ai.episodeCount !== ref.episodeCount || ai.source.planConfirmation !== ref.planConfirmation
      || ai.source.previousRevisionId !== ref.previousRevisionId || ai.source.originalRunId !== ref.originalRunId
      || ai.source.originalEpisodeHash !== ref.originalEpisodeHash || shortSequelAiDraftExpired(ai, context)
      || (ai.source.storyRevisionId !== input.sourceStoryRevisionId
        && !canBindShortSequelFirstPlan({ ...ai.source, episodeCount: ai.episodeCount }, context))) {
      throw new PersistenceError("SOURCE_STALE", "AI 草稿的冻结版本无法用于当前大纲，请重新生成或编写。");
    }
  }
  return { previousRevisionId: ref.previousRevisionId, previousHandoff: context.previousHandoff, episodeCount: context.episodeCount };
}

/** Called after the plan or predecessor has been confirmed, with the same project write lock as the confirmation. */
export async function staleShortSequelDraftsIn(client: PoolClient, scope: Scope & { traceId?: string },
  source: { storyRevisionId: string } | { episodeId: string; revisionId: string }): Promise<string[]> {
  const added = await shortSequelEpisodesIn(client, scope);
  if (added.length === 0) return [];
  const reason = "storyRevisionId" in source ? "SOURCE_STORY_REPLACED" : "PREVIOUS_EPISODE_REPLACED";
  const reference = "storyRevisionId" in source ? source.storyRevisionId : source.revisionId;
  let ids: string[];
  if ("storyRevisionId" in source) {
    const result = await client.query<{ id: string }>(
      `SELECT r.id FROM script_revision r WHERE r.workspace_id = $1 AND r.project_id = $2 AND r.episode_id = ANY($3::uuid[])
        AND r.source_story_revision_id <> $4 AND r.review_status <> 'APPROVED' AND r.freshness_status = 'CURRENT'
        AND to_jsonb(r)->>'deleted_at' IS NULL`,
      [scope.workspaceId, scope.projectId, added.map(episode => episode.episodeId), source.storyRevisionId]);
    ids = result.rows.map(row => row.id);
  } else {
    const result = await client.query<{ episode_no: number }>("SELECT episode_no FROM episode WHERE id = $1 AND project_id = $2 AND workspace_id = $3",
      [source.episodeId, scope.projectId, scope.workspaceId]);
    const next = added.find(episode => episode.episodeNo === Number(result.rows[0]?.episode_no) + 1);
    if (!next) return [];
    const context = await shortSequelContextIn(client, scope, next.episodeNo);
    const drafts = await client.query<{ id: string; content_json: unknown }>(
      `SELECT id, content_json FROM script_revision WHERE workspace_id = $1 AND project_id = $2 AND episode_id = $3
        AND freshness_status = 'CURRENT' AND to_jsonb(script_revision)->>'deleted_at' IS NULL`,
      [scope.workspaceId, scope.projectId, next.episodeId]);
    ids = drafts.rows.filter(row => {
      const ref = workbenchPart(row.content_json)?.continuation as ShortSequelRefs | undefined;
      return ref && !shortSequelRefsMatch(ref, context);
    }).map(row => row.id);
  }
  if (ids.length === 0) return [];
  const result = await client.query<{ id: string }>(
    `WITH RECURSIVE stale(id) AS (
       SELECT unnest($3::uuid[])
       UNION
       SELECT r.id FROM script_revision r JOIN stale ON r.content_json->'workbench'->'script'->>'previousRevisionId' = stale.id::text
        WHERE r.workspace_id = $1 AND r.project_id = $2 AND $4 = 'PREVIOUS_EPISODE_REPLACED'
     ), updated AS (
       UPDATE script_revision SET freshness_status = 'STALE', stale_reason = $4, stale_from_ref = $5, review_version = review_version + 1
        WHERE workspace_id = $1 AND project_id = $2 AND id IN (SELECT id FROM stale) AND freshness_status = 'CURRENT' RETURNING id
     ), events AS (
       INSERT INTO domain_event (workspace_id, project_id, aggregate_type, aggregate_id, event_type, payload_json, trace_id)
       SELECT $1, $2, 'ScriptRevision', id, 'revision.stale',
         jsonb_build_object('revisionId', id, 'freshnessStatus', 'STALE', 'staleReason', $4::text, 'staleFromRef', $5::text), $6 FROM updated
     ) SELECT id FROM updated`, [scope.workspaceId, scope.projectId, ids, reason, reference, scope.traceId ?? "short-sequel"]);
  return result.rows.map(row => row.id);
}
