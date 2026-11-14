import type { PoolClient, QueryResultRow } from "pg";
import { PersistenceError, type DatabasePool } from "./job-service";

export interface WorkbenchDependencies { scenes: number; shots: number; speech: number; video: number; other: number; total: number }
export interface WorkbenchDependencyReference { kind: "scene" | "shot" | "speech" | "video" | "other"; id: string; label: string }
export interface WorkbenchDeletePreview {
  kind: "project" | "script"; projectId: string; title: string; version: number; episodeCount: number;
  episodeId?: string; episodeNo?: number; revisionId?: string; revisionNo?: number; reviewStatus?: string;
  dependencies: WorkbenchDependencies; references: WorkbenchDependencyReference[]; canDelete: boolean; blockedReason: string | null;
}
export interface WorkbenchTrashItem {
  kind: "project" | "script"; id: string; projectId: string; title: string; version: number; deletedAt: string;
  episodeId?: string; episodeNo?: number; revisionNo?: number;
}
interface ProjectRow extends QueryResultRow { id: string; title: string; version: number; archived_at: Date | null; status: string; episode_count: number }
interface RevisionRow extends QueryResultRow {
  id: string; revision_no: number; review_status: string; deleted_at: Date | null; episode_no: number; row_version: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const mutableVersion = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 1 || value >= 2147483647) throw new PersistenceError("VALIDATION_ERROR", "版本号无效，请重新加载。");
};
const ids = (...values: string[]): void => {
  if (values.some((value) => !UUID.test(value))) throw new PersistenceError("VALIDATION_ERROR", "稿件标识无效。");
};

async function ready(client: PoolClient, workspaceId: string): Promise<void> {
  const workspace = await client.query("SELECT id FROM workspace WHERE id = $1 AND status = 'ACTIVE'", [workspaceId]);
  if (!workspace.rows[0]) throw new PersistenceError("NOT_FOUND", "工作空间不可用。");
  const result = await client.query<{ present: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
      AND table_name = 'script_revision' AND column_name = 'deleted_at') AS present`);
  if (!result.rows[0]?.present) throw new PersistenceError("WORKBENCH_UNAVAILABLE", "回收站尚未启用，请先完成剧本工作台数据库更新。");
}
async function project(client: PoolClient, workspaceId: string, projectId: string, lock = false, archived = false): Promise<ProjectRow> {
  const result = await client.query<ProjectRow>(`SELECT id, title, version, archived_at, status,
    coalesce((to_jsonb(project)->>'episode_count')::integer, 3) AS episode_count FROM project
    WHERE id = $1 AND workspace_id = $2 ${archived ? "" : "AND archived_at IS NULL AND status = 'ACTIVE'"}
    ${lock ? "FOR UPDATE" : ""}`, [projectId, workspaceId]);
  if (!result.rows[0]) throw new PersistenceError("NOT_FOUND", "作品不存在或已移入回收站。");
  return result.rows[0];
}
async function revision(client: PoolClient, workspaceId: string, projectId: string, episodeId: string, revisionId: string, lock = false): Promise<RevisionRow> {
  // The project is always locked first by the caller, matching TextChainService's lock order.
  const result = await client.query<RevisionRow>(`SELECT r.id, r.revision_no, r.review_status, r.deleted_at,
    e.episode_no, e.row_version FROM script_revision r JOIN episode e
      ON e.id = r.episode_id AND e.project_id = r.project_id AND e.workspace_id = r.workspace_id
    WHERE r.workspace_id = $1 AND r.project_id = $2 AND r.episode_id = $3 AND r.id = $4
    ${lock ? "FOR UPDATE OF e, r" : ""}`, [workspaceId, projectId, episodeId, revisionId]);
  if (!result.rows[0]) throw new PersistenceError("NOT_FOUND", "稿件不存在。");
  return result.rows[0];
}

const OPTIONAL_WORK = ["title_writing_run", "auto_creation_run", "series_writing_run", "writing_candidate_request", "vimax_planning_request"] as const;
async function activeWork(client: PoolClient, workspaceId: string, projectId: string): Promise<boolean> {
  const jobs = await client.query(`SELECT 1 FROM workflow_run WHERE workspace_id=$1 AND project_id=$2 AND status IN ('PENDING','RUNNING')
    UNION ALL SELECT 1 FROM generation_job WHERE workspace_id=$1 AND project_id=$2
      AND state IN ('PENDING','QUEUED','RUNNING','WAITING_EXTERNAL') LIMIT 1`, [workspaceId, projectId]);
  if (jobs.rows[0]) return true;
  for (const table of OPTIONAL_WORK) {
    const exists = await client.query<{ present: boolean }>("SELECT to_regclass($1) IS NOT NULL AS present", [table]);
    if (!exists.rows[0]?.present) continue;
    const found = await client.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1 AND project_id=$2
      AND state IN ('running','reserved','submitted') LIMIT 1`, [workspaceId, projectId]);
    if (found.rows[0]) return true;
  }
  const speechBatches = await client.query<{ present: boolean }>("SELECT to_regclass('speech_batch_command') IS NOT NULL AS present");
  if (speechBatches.rows[0]?.present) {
    // Confirmation commits before dispatch creates its first GenerationJob. Match the batch's active-episode
    // constraint here; confirm/claim and archive all serialize through the same project lock.
    const found = await client.query(`SELECT 1 FROM speech_batch_command WHERE workspace_id=$1 AND project_id=$2
      AND state IN ('dispatching','needs_attention') AND NOT cancel_requested LIMIT 1`, [workspaceId, projectId]);
    if (found.rows[0]) return true;
  }
  return false;
}

/** Permanent sources are counted even when their descendants have been superseded; archive never severs provenance. */
async function dependencies(client: PoolClient, workspaceId: string, projectId: string, revisionId?: string): Promise<{
  dependencies: WorkbenchDependencies; references: WorkbenchDependencyReference[];
}> {
  const result = await client.query<{ kind: WorkbenchDependencyReference["kind"]; id: string; label: string }>(`
    WITH RECURSIVE sources AS (
      SELECT DISTINCT consumer_type, consumer_revision_id FROM script_revision_consumer_source
      WHERE workspace_id=$1 AND project_id=$2 AND ($3::uuid IS NULL OR script_revision_id=$3)
    ), asset_roots AS (
      SELECT DISTINCT a.id, a.kind FROM asset a WHERE a.workspace_id=$1 AND a.project_id=$2 AND (
        $3::uuid IS NULL OR a.source_shot_revision_id IN (SELECT consumer_revision_id FROM sources WHERE consumer_type='shot_revision')
        OR EXISTS (SELECT 1 FROM asset_revision_dependency d WHERE d.workspace_id=$1 AND d.project_id=$2 AND d.dependent_asset_id=a.id
          AND (d.script_revision_id=$3 OR d.shot_revision_id IN (SELECT consumer_revision_id FROM sources WHERE consumer_type='shot_revision')
            OR d.scene_revision_id IN (SELECT consumer_revision_id FROM sources WHERE consumer_type='scene_revision')
            OR d.character_revision_id IN (SELECT consumer_revision_id FROM sources WHERE consumer_type='character_revision')
            OR d.location_revision_id IN (SELECT consumer_revision_id FROM sources WHERE consumer_type='location_revision'))))
    ), linked_assets AS (
      SELECT id, kind FROM asset_roots
      UNION SELECT a.id, a.kind FROM linked_assets src JOIN asset_dependency d
        ON d.source_asset_id=src.id AND d.workspace_id=$1 AND d.project_id=$2
        JOIN asset a ON a.id=d.dependent_asset_id AND a.workspace_id=$1 AND a.project_id=$2
    )
    SELECT CASE consumer_type WHEN 'scene_revision' THEN 'scene' WHEN 'shot_revision' THEN 'shot' ELSE 'other' END AS kind,
      consumer_revision_id AS id,
      CASE consumer_type WHEN 'scene_revision' THEN '场景版本' WHEN 'shot_revision' THEN '分镜版本'
        WHEN 'character_revision' THEN '角色版本' ELSE '地点版本' END AS label FROM sources
    UNION ALL SELECT CASE kind WHEN 'AUDIO' THEN 'speech' WHEN 'VIDEO' THEN 'video' WHEN 'COMPOSITE' THEN 'video' ELSE 'other' END,
      id, CASE kind WHEN 'AUDIO' THEN '配音素材' WHEN 'VIDEO' THEN '视频素材' WHEN 'COMPOSITE' THEN '合成视频' ELSE '制作素材' END FROM linked_assets
    UNION ALL SELECT 'other', id, '后集连续性引用' FROM script_revision r WHERE r.workspace_id=$1 AND r.project_id=$2
      AND $3::uuid IS NOT NULL AND r.content_json #>> '{workbench,script,previousRevisionId}' = $3::text
      AND r.deleted_at IS NULL`, [workspaceId, projectId, revisionId ?? null]);
  // Script breakdown requests freeze their source even before scenes or shots exist.
  const breakdown = await client.query<{ id: string }>(`SELECT id FROM title_writing_run WHERE workspace_id=$1 AND project_id=$2
    AND to_jsonb(title_writing_run)->>'run_kind' = 'script_breakdown'
    AND ($3::uuid IS NULL OR to_jsonb(title_writing_run)->>'source_script_revision_id'=$3::text)`, [workspaceId, projectId, revisionId ?? null]);
  const references: WorkbenchDependencyReference[] = result.rows.map((row) => ({ ...row }));
  if (revisionId && (await client.query<{ present: boolean }>(`SELECT to_regclass('auto_creation_run') IS NOT NULL
      AND to_regclass('auto_creation_stage') IS NOT NULL AS present`)).rows[0]?.present) {
    const packageRefs = await client.query<{ id: string }>(`
      SELECT DISTINCT later.id FROM auto_creation_run run
      JOIN auto_creation_stage placed ON placed.run_id = run.id AND placed.workspace_id = run.workspace_id
        AND placed.stage_key LIKE 'episode:%' AND placed.script_revision_id = $3
      JOIN LATERAL (
        SELECT stage.output_hash FROM auto_creation_stage stage
        WHERE stage.run_id = run.id AND stage.workspace_id = run.workspace_id AND stage.state = 'completed'
          AND (stage.stage_key = placed.stage_key OR stage.stage_key LIKE ('revise:%:' || placed.stage_key))
        ORDER BY stage.ordinal DESC LIMIT 1
      ) current_package ON true
      JOIN script_revision later ON later.workspace_id = run.workspace_id AND later.project_id = run.project_id
        AND later.content_json #>> '{workbench,continuation,originalRunId}' = run.id::text
        AND later.content_json #>> '{workbench,continuation,originalEpisodeHash}' = current_package.output_hash
        AND later.content_json #>> '{workbench,script,previousRevisionId}' IS NULL
      JOIN episode next ON next.id = later.episode_id AND next.workspace_id = later.workspace_id AND next.project_id = later.project_id
        AND next.episode_no = split_part(placed.stage_key, ':', 2)::int + 1
      WHERE run.workspace_id = $1 AND run.project_id = $2 AND later.deleted_at IS NULL`, [workspaceId, projectId, revisionId]);
    for (const row of packageRefs.rows) references.push({ kind: "other", id: row.id, label: "后集连续性引用" });
  }
  const speechReady = await client.query<{ present: boolean }>("SELECT to_regclass('speech_plan') IS NOT NULL AS present");
  if (speechReady.rows[0]?.present) {
    const plans = await client.query<{ id: string }>(`SELECT p.id FROM speech_plan p WHERE p.workspace_id=$1 AND p.project_id=$2
      AND ($3::uuid IS NULL OR p.shot_revision_id IN (SELECT consumer_revision_id FROM script_revision_consumer_source
        WHERE workspace_id=$1 AND project_id=$2 AND script_revision_id=$3 AND consumer_type='shot_revision'))`, [workspaceId, projectId, revisionId ?? null]);
    for (const row of plans.rows) references.push({ kind: "speech", id: row.id, label: "逐句配音方案" });
  }
  for (const row of breakdown.rows) references.push({ kind: "other", id: row.id, label: "分镜拆解任务" });
  for (const table of ["vimax_storyboard_candidate", "vimax_planning_request"] as const) {
    const exists = await client.query<{ present: boolean }>("SELECT to_regclass($1) IS NOT NULL AS present", [table]);
    if (!exists.rows[0]?.present) continue;
    const rows = await client.query<{ id: string }>(`SELECT id FROM ${table} WHERE workspace_id=$1 AND project_id=$2
      AND ($3::uuid IS NULL OR source_script_revision_id=$3)`, [workspaceId, projectId, revisionId ?? null]);
    for (const row of rows.rows) references.push({ kind: "other", id: row.id, label: "分镜策划记录" });
  }
  const counts: WorkbenchDependencies = { scenes: 0, shots: 0, speech: 0, video: 0, other: 0, total: references.length };
  for (const ref of references) counts[ref.kind === "scene" ? "scenes" : ref.kind === "shot" ? "shots" : ref.kind]++;
  return { dependencies: counts, references: references.slice(0, 100) };
}

/** Workspace-scoped soft deletion. No row, object-storage object, or immutable dependency is physically removed. */
export class ScriptWorkbenchTrashStore {
  constructor(private readonly pool: DatabasePool) {}

  private async transaction<T>(workspaceId: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await ready(client, workspaceId);
      const value = await run(client);
      await client.query("COMMIT");
      return value;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  async previewProject(workspaceId: string, projectId: string): Promise<WorkbenchDeletePreview> {
    ids(workspaceId, projectId);
    return this.transaction(workspaceId, async (client) => {
      const found = await project(client, workspaceId, projectId);
      const linked = await dependencies(client, workspaceId, projectId);
      const busy = await activeWork(client, workspaceId, projectId);
      return { kind: "project", projectId, title: found.title, version: found.version, episodeCount: found.episode_count,
        ...linked, canDelete: !busy, blockedReason: busy ? "作品仍有进行中的生成任务，请先等待完成或取消任务。" : null };
    });
  }

  async previewRevision(workspaceId: string, projectId: string, episodeId: string, revisionId: string): Promise<WorkbenchDeletePreview> {
    ids(workspaceId, projectId, episodeId, revisionId);
    return this.transaction(workspaceId, async (client) => {
      const found = await project(client, workspaceId, projectId);
      const script = await revision(client, workspaceId, projectId, episodeId, revisionId);
      if (script.deleted_at) throw new PersistenceError("NOT_FOUND", "稿件已移入回收站。");
      const linked = await dependencies(client, workspaceId, projectId, revisionId);
      return { kind: "script", projectId, title: found.title, episodeId, episodeNo: script.episode_no, revisionId,
        revisionNo: script.revision_no, reviewStatus: script.review_status, version: script.row_version, episodeCount: 1, ...linked,
        canDelete: linked.dependencies.total === 0,
        blockedReason: linked.dependencies.total ? "此版本仍被分镜、素材或后集引用，请保留该版本并另建修订稿。" : null };
    });
  }

  async trashProject(workspaceId: string, projectId: string, input: { expectedVersion: number }): Promise<{ projectId: string; version: number }> {
    ids(workspaceId, projectId); mutableVersion(input.expectedVersion);
    return this.transaction(workspaceId, async (client) => {
      const found = await project(client, workspaceId, projectId, true);
      if (found.version !== input.expectedVersion) throw new PersistenceError("REVISION_CONFLICT", "作品已更新，请重新确认删除范围。");
      if (await activeWork(client, workspaceId, projectId)) throw new PersistenceError("REVISION_CONFLICT", "作品仍有进行中的任务，暂不能删除。");
      await client.query("UPDATE project SET archived_at=clock_timestamp(), status='ARCHIVED', version=version+1, updated_at=clock_timestamp() WHERE id=$1 AND workspace_id=$2", [projectId, workspaceId]);
      return { projectId, version: found.version + 1 };
    });
  }

  async restoreProject(workspaceId: string, projectId: string, input: { expectedVersion: number }): Promise<{ projectId: string; version: number }> {
    ids(workspaceId, projectId); mutableVersion(input.expectedVersion);
    return this.transaction(workspaceId, async (client) => {
      const found = await project(client, workspaceId, projectId, true, true);
      if (!found.archived_at) throw new PersistenceError("NOT_FOUND", "作品不在回收站。");
      if (found.version !== input.expectedVersion) throw new PersistenceError("REVISION_CONFLICT", "作品已更新，请刷新回收站。");
      await client.query("UPDATE project SET archived_at=NULL, status='ACTIVE', version=version+1, updated_at=clock_timestamp() WHERE id=$1 AND workspace_id=$2", [projectId, workspaceId]);
      return { projectId, version: found.version + 1 };
    });
  }

  async trashRevision(workspaceId: string, projectId: string, episodeId: string, revisionId: string,
    input: { expectedVersion: number; actorId?: string }): Promise<{ revisionId: string; rowVersion: number }> {
    ids(workspaceId, projectId, episodeId, revisionId); mutableVersion(input.expectedVersion);
    return this.transaction(workspaceId, async (client) => {
      await project(client, workspaceId, projectId, true);
      const script = await revision(client, workspaceId, projectId, episodeId, revisionId, true);
      if (script.deleted_at) throw new PersistenceError("NOT_FOUND", "稿件已移入回收站。");
      if (script.row_version !== input.expectedVersion) throw new PersistenceError("REVISION_CONFLICT", "本集已更新，请重新确认删除范围。");
      const linked = await dependencies(client, workspaceId, projectId, revisionId);
      if (linked.dependencies.total) throw new PersistenceError("REVISION_CONFLICT", "此版本仍被分镜、素材或后集引用，不能删除。", { dependencies: linked.dependencies, references: linked.references });
      await client.query(`UPDATE episode SET current_script_revision_id=CASE WHEN current_script_revision_id=$3 THEN NULL ELSE current_script_revision_id END,
        approved_script_revision_id=CASE WHEN approved_script_revision_id=$3 THEN NULL ELSE approved_script_revision_id END,
        row_version=row_version+1, updated_at=clock_timestamp() WHERE id=$1 AND workspace_id=$2`, [episodeId, workspaceId, revisionId]);
      await client.query(`UPDATE script_revision SET deleted_at=clock_timestamp(), deleted_by=$3, freshness_status='STALE',
        stale_reason='SCRIPT_TRASHED', stale_from_ref='script_revision:' || id::text
        WHERE id=$1 AND workspace_id=$2`, [revisionId, workspaceId, input.actorId ?? "user"]);
      return { revisionId, rowVersion: script.row_version + 1 };
    });
  }

  async restoreRevision(workspaceId: string, projectId: string, episodeId: string, revisionId: string,
    input: { expectedVersion: number }): Promise<{ revisionId: string; rowVersion: number; restoredAsHistory: true }> {
    ids(workspaceId, projectId, episodeId, revisionId); mutableVersion(input.expectedVersion);
    return this.transaction(workspaceId, async (client) => {
      await project(client, workspaceId, projectId, true);
      const script = await revision(client, workspaceId, projectId, episodeId, revisionId, true);
      if (!script.deleted_at) throw new PersistenceError("NOT_FOUND", "稿件不在回收站。");
      if (script.row_version !== input.expectedVersion) throw new PersistenceError("REVISION_CONFLICT", "本集已更新，请刷新回收站。");
      await client.query("UPDATE script_revision SET deleted_at=NULL, deleted_by=NULL WHERE id=$1 AND workspace_id=$2", [revisionId, workspaceId]);
      await client.query("UPDATE episode SET row_version=row_version+1, updated_at=clock_timestamp() WHERE id=$1 AND workspace_id=$2", [episodeId, workspaceId]);
      return { revisionId, rowVersion: script.row_version + 1, restoredAsHistory: true };
    });
  }

  async listTrash(workspaceId: string, cursor?: string): Promise<{ items: WorkbenchTrashItem[]; nextCursor: string | null }> {
    ids(workspaceId);
    let after: { at: string; id: string; kind: string } | null = null;
    if (cursor) {
      try {
        if (cursor.length > 1024) throw new Error();
        after = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { at: string; id: string; kind: string };
        if (!after || !UUID.test(after.id) || !["project", "script"].includes(after.kind)
          || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(after.at) || !Number.isFinite(Date.parse(after.at))) throw new Error();
      } catch { throw new PersistenceError("VALIDATION_ERROR", "回收站分页已失效，请重新加载。"); }
    }
    return this.transaction(workspaceId, async (client) => {
      const result = await client.query<QueryResultRow>(`WITH trash AS (
        SELECT 'project'::text AS kind, p.id, p.id AS project_id, p.title, p.version, p.archived_at AS deleted_at,
          NULL::uuid AS episode_id, NULL::smallint AS episode_no, NULL::integer AS revision_no FROM project p
          WHERE p.workspace_id=$1 AND p.archived_at IS NOT NULL
        UNION ALL SELECT 'script', r.id, p.id, p.title, e.row_version, r.deleted_at, e.id, e.episode_no, r.revision_no
          FROM script_revision r JOIN project p ON p.id=r.project_id AND p.workspace_id=r.workspace_id
            JOIN episode e ON e.id=r.episode_id AND e.workspace_id=r.workspace_id AND e.project_id=r.project_id
          WHERE r.workspace_id=$1 AND r.deleted_at IS NOT NULL AND p.archived_at IS NULL AND p.status='ACTIVE'
        ) SELECT *, to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_at FROM trash
        WHERE $2::timestamptz IS NULL OR (deleted_at, kind, id) < ($2::timestamptz, $3::text, $4::uuid)
        ORDER BY deleted_at DESC, kind DESC, id DESC LIMIT 51`, [workspaceId, after?.at ?? null, after?.kind ?? null, after?.id ?? null]);
      const rows = result.rows.slice(0, 50); const last = rows.at(-1);
      return { items: rows.map((row) => ({ kind: row.kind as "project" | "script", id: String(row.id), projectId: String(row.project_id),
        title: String(row.title), version: Number(row.version), deletedAt: new Date(row.deleted_at as Date).toISOString(),
        ...(row.kind === "script" ? { episodeId: String(row.episode_id), episodeNo: Number(row.episode_no), revisionNo: Number(row.revision_no) } : {}) })),
      nextCursor: result.rows.length > 50 && last ? Buffer.from(JSON.stringify({ at: last.sort_at, kind: last.kind, id: last.id })).toString("base64url") : null };
    });
  }
}
