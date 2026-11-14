import {
  SCRIPT_WORKBENCH_SCHEMA, type ScriptWorkbenchDocumentVersions, type ScriptWorkbenchPlan, type ScriptWorkbenchScript,
  type ScriptWorkbenchSnapshot, type ScriptWorkbenchRevision,
} from "@ai-drama/contracts";
import { workbenchScriptText } from "@ai-drama/domain";
export { workbenchScriptText } from "@ai-drama/domain";
import type { PoolClient } from "pg";
import { PersistenceError, type DatabasePool } from "./job-service";
import { TextChainService } from "./text-chain";
import { readWorkbenchPlan, validateWorkbenchPlan, workbenchPart } from "./script-workbench-validation";
import { shortSequelEpisodesIn, type ShortSequelBodyRefs } from "./short-sequel";
import { assertInheritedSequelPlan } from "./short-sequel-lineage";

interface RevisionRow { id: string; revision_no: number; review_status: string; freshness_status: string; review_version: number; content_json: Record<string, unknown>; created_at: Date }
function revision(row: RevisionRow): ScriptWorkbenchRevision {
  return { id: row.id, revisionNo: row.revision_no, reviewStatus: row.review_status, freshnessStatus: row.freshness_status,
    reviewVersion: row.review_version, content: row.content_json, createdAt: row.created_at.toISOString() };
}
export function workbenchPlanText(plan: ScriptWorkbenchPlan): string {
  return [plan.brief.logline, `题材：${plan.brief.genre}；受众：${plan.brief.audience}`, `制作边界：${plan.brief.productionConstraints}`,
    `单集 ${plan.brief.targetEpisodeSeconds} 秒，对白 ${plan.brief.dialogueQuota} 句`, `结局：${plan.bible.ending}`,
    ...plan.bible.characters.map(c => `${c.id} ${c.name}；定妆：${c.appearance}；声线：${c.voice}；称呼：${c.aliases}；已知：${c.knownInformation}`),
    `未回收悬念：${plan.bible.openThreads}`, ...plan.outline.episodes.map(e => `第${e.episodeNo}集 ${e.title}\n开场3秒：${e.openingHook}\n当集改变：${e.change}\n集尾交接：${e.endingHandoff}`)].join("\n\n");
}
export function nextDocumentVersions(previous: ScriptWorkbenchPlan | null, next: ScriptWorkbenchPlan, previousNumbers: unknown): ScriptWorkbenchDocumentVersions {
  const values = previousNumbers && typeof previousNumbers === "object" ? previousNumbers as Partial<ScriptWorkbenchDocumentVersions> : {};
  const brief = (p: ScriptWorkbenchPlan) => ({ ...p.brief, logline: undefined });
  const content = { brief: brief(next), synopsis: next.brief.logline, bible: next.bible, outline: next.outline };
  const before = previous ? { brief: brief(previous), synopsis: previous.brief.logline, bible: previous.bible, outline: previous.outline } : null;
  const result = {} as ScriptWorkbenchDocumentVersions;
  for (const kind of ["brief", "synopsis", "bible", "outline"] as const) {
    const existing = Number.isSafeInteger(values[kind]) && (values[kind] ?? 0) > 0 ? values[kind] as number : 0;
    result[kind] = before && existing > 0 && JSON.stringify(content[kind]) === JSON.stringify(before[kind]) ? existing : existing + 1;
  }
  return result;
}

/** An adapter for the existing text revision chain, never a second script store. */
export class ScriptWorkbenchStore {
  private readonly text: TextChainService;
  constructor(private readonly pool: DatabasePool) { this.text = new TextChainService(pool); }

  async snapshot(workspaceId: string, projectId: string): Promise<ScriptWorkbenchSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const projects = await client.query<{ id: string; title: string; version: number; episode_count: number; writing_mode: "short" | "series"; target_episode_seconds: number | null; current_story_revision_id: string | null }>(
        `SELECT id, title, version, coalesce((to_jsonb(project)->>'episode_count')::int, 3) AS episode_count,
          coalesce(to_jsonb(project)->>'writing_mode', 'short') AS writing_mode,
          (to_jsonb(project)->>'target_episode_seconds')::int AS target_episode_seconds, current_story_revision_id
         FROM project WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL AND status = 'ACTIVE'`, [projectId, workspaceId]);
      const project = projects.rows[0];
      if (!project) throw new PersistenceError("NOT_FOUND", "作品不存在或已移入回收站。");
      const stories = await client.query<RevisionRow>(
        "SELECT * FROM story_revision WHERE project_id = $1 AND workspace_id = $2 ORDER BY revision_no DESC LIMIT 100", [projectId, workspaceId]);
      const episodes = await client.query<{ id: string; episode_no: number; title: string; row_version: number; current_script_revision_id: string | null; approved_script_revision_id: string | null }>(
        "SELECT * FROM episode WHERE project_id = $1 AND workspace_id = $2 ORDER BY episode_no", [projectId, workspaceId]);
      const added = new Set((await shortSequelEpisodesIn(client, { workspaceId, projectId })).map(episode => episode.episodeId));
      const scripts = await client.query<RevisionRow & { episode_id: string }>(
        `SELECT selected.* FROM episode e CROSS JOIN LATERAL (
          SELECT s.* FROM script_revision s WHERE s.episode_id = e.id AND s.project_id = e.project_id AND s.workspace_id = e.workspace_id
            AND to_jsonb(s)->>'deleted_at' IS NULL ORDER BY revision_no DESC LIMIT 100
        ) selected WHERE e.project_id = $1 AND e.workspace_id = $2`, [projectId, workspaceId]);
      const storyHistory = stories.rows.map(revision);
      // Current pointers may legitimately predate the latest 100 history entries. Resolve them exactly,
      // without adding them to history (which would skip intermediate revisions when paging).
      let currentStory = storyHistory.find(s => s.id === project.current_story_revision_id) ?? null;
      if (!currentStory && project.current_story_revision_id) {
        const pointed = await client.query<RevisionRow>(
          "SELECT * FROM story_revision WHERE id=$1 AND project_id=$2 AND workspace_id=$3",
          [project.current_story_revision_id, projectId, workspaceId]);
        if (pointed.rows[0]) currentStory = revision(pointed.rows[0]);
      }
      const currentScripts = new Map(scripts.rows.map(s => [`${s.episode_id}:${s.id}`, revision(s)]));
      const missingEpisodes = episodes.rows.filter(e => e.current_script_revision_id && !currentScripts.has(`${e.id}:${e.current_script_revision_id}`)).map(e => e.id);
      if (missingEpisodes.length) {
        const pointed = await client.query<RevisionRow & { episode_id: string }>(
          `SELECT s.* FROM episode e JOIN script_revision s ON s.id=e.current_script_revision_id
             AND s.episode_id=e.id AND s.project_id=e.project_id AND s.workspace_id=e.workspace_id
           WHERE e.project_id=$1 AND e.workspace_id=$2 AND e.id=ANY($3::uuid[])
             AND to_jsonb(s)->>'deleted_at' IS NULL`, [projectId, workspaceId, missingEpisodes]);
        for (const row of pointed.rows) currentScripts.set(`${row.episode_id}:${row.id}`, revision(row));
      }
      const result: ScriptWorkbenchSnapshot = {
        project: { id: project.id, title: project.title, version: project.version, episodeCount: project.episode_count,
          writingMode: project.writing_mode, targetEpisodeSeconds: project.target_episode_seconds },
        story: currentStory, storyHistory,
        episodes: episodes.rows.map(e => {
          const history = scripts.rows.filter(s => s.episode_id === e.id).map(revision);
          return { id: e.id, episodeNo: e.episode_no, title: e.title, rowVersion: e.row_version,
            ...(added.has(e.id) ? { isContinuation: true } : {}),
            currentScriptRevisionId: e.current_script_revision_id, approvedScriptRevisionId: e.approved_script_revision_id,
            script: e.current_script_revision_id ? currentScripts.get(`${e.id}:${e.current_script_revision_id}`) ?? null : null, history };
        }),
      };
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  async savePlan(client: PoolClient, input: { workspaceId: string; projectId: string; plan: ScriptWorkbenchPlan; continuationEpisodeNo?: number; expectedVersion: number; actorId: string; traceId: string }) {
    const existing = await client.query<{ content_json: unknown; episode_count: number; version: number }>(
      `SELECT s.content_json, coalesce((to_jsonb(p)->>'episode_count')::int, 3) AS episode_count, p.version
       FROM project p LEFT JOIN story_revision s ON s.id = p.current_story_revision_id AND s.workspace_id = p.workspace_id
       WHERE p.id = $1 AND p.workspace_id = $2 AND p.archived_at IS NULL AND p.status = 'ACTIVE' FOR UPDATE OF p`, [input.projectId, input.workspaceId]);
    const row = existing.rows[0];
    if (!row) throw new PersistenceError("NOT_FOUND", "作品不存在或已移入回收站。");
    if (row.version !== input.expectedVersion) throw new PersistenceError("REVISION_CONFLICT", "计划已被更新，请保留草稿并重新加载。");
    validateWorkbenchPlan(input.plan, row.episode_count);
    const previous = readWorkbenchPlan(row.content_json);
    if (input.continuationEpisodeNo !== undefined) await assertInheritedSequelPlan(client, input, input.continuationEpisodeNo, previous, input.plan);
    const documentVersions = nextDocumentVersions(previous, input.plan, workbenchPart(row.content_json)?.documentVersions);
    return this.text.createStoryRevisionInTransaction(client, { workspaceId: input.workspaceId, projectId: input.projectId,
      expectedVersion: input.expectedVersion, createdBy: input.actorId, traceId: input.traceId,
      content: { text: workbenchPlanText(input.plan), workbench: { schema: SCRIPT_WORKBENCH_SCHEMA, plan: input.plan, documentVersions,
        ...(input.continuationEpisodeNo === undefined ? {} : { continuationEpisodeNo: input.continuationEpisodeNo }) } } });
  }

  async saveScript(client: PoolClient, input: { workspaceId: string; projectId: string; episodeId: string; sourceStoryRevisionId: string; script: ScriptWorkbenchScript; continuation?: ShortSequelBodyRefs; expectedVersion: number; actorId: string; traceId: string }) {
    const source = await client.query<{ content_json: unknown }>(
      "SELECT content_json FROM story_revision WHERE id = $1 AND project_id = $2 AND workspace_id = $3",
      [input.sourceStoryRevisionId, input.projectId, input.workspaceId]);
    if (!source.rows[0]) throw new PersistenceError("NOT_FOUND", "计划版本不存在。");
    const plan = readWorkbenchPlan(source.rows[0]?.content_json);
    if (!plan) throw new PersistenceError("REVIEW_REQUIRED", "请先确认工作台计划，再保存对应正文。");
    return this.text.createScriptRevisionInTransaction(client, { workspaceId: input.workspaceId, projectId: input.projectId,
      episodeId: input.episodeId, sourceStoryRevisionId: input.sourceStoryRevisionId, expectedVersion: input.expectedVersion,
      createdBy: input.actorId, traceId: input.traceId,
      content: { text: workbenchScriptText(input.script, plan.bible.characters), workbench: { schema: SCRIPT_WORKBENCH_SCHEMA, script: input.script,
        ...(input.continuation ? { continuation: input.continuation, sourceStoryRevisionId: input.sourceStoryRevisionId } : {}) } } });
  }
}
