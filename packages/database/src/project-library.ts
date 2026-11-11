import { Buffer } from "node:buffer";
import type { PoolClient } from "pg";
import { PersistenceError, type DatabasePool } from "./job-service";

export const PROJECT_LIBRARY_PAGE_SIZE = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface ProjectLibraryQuery { q?: string; category?: string; sort?: "updated" | "created"; cursor?: string }
export interface ProjectLibraryCategory { id: string; name: string; count: number }
export interface ProjectLibraryItem {
  id: string; title: string; premise: string; createdAt: string; updatedAt: string;
  categoryId: string | null; categoryName: string | null; categoryRevision: number;
  thumbnailAssetId: string | null; thumbnailUrl: string | null; episodeCount: number; writingMode: string;
}
export interface ProjectLibraryPage {
  items: ProjectLibraryItem[]; nextCursor: string | null;
  /** Counts are computed across the full search result, before pagination. total includes the category filter. */
  total: number; allCount: number; unclassifiedCount: number;
  categories: ProjectLibraryCategory[]; categoriesReady: boolean;
}
export interface ProjectLibraryAssignment {
  projectId: string; categoryId: string | null; categoryName: string | null; categoryRevision: number;
}
interface ListRow {
  id: string; title: string; premise: string; created_at: Date; updated_at: Date; sort_at: string;
  category_id: string | null; category_name: string | null; category_revision: number;
  thumbnail_asset_id: string | null; episode_count: number; writing_mode: string;
}
interface Cursor { v: 1; sort: "updated" | "created"; q: string; category: string; at: string; id: string }

export function normalizeLibraryQuery(input: ProjectLibraryQuery): Required<Omit<ProjectLibraryQuery, "cursor">> & { cursor?: string } {
  const q = input.q?.trim() ?? "";
  const category = input.category ?? "all";
  const sort = input.sort ?? "updated";
  if (q.length > 200 || !["updated", "created"].includes(sort)
    || (category !== "all" && category !== "uncategorized" && !UUID.test(category))) {
    throw new PersistenceError("VALIDATION_ERROR", "作品查询参数无效。");
  }
  if (input.cursor && input.cursor.length > 2048) throw new PersistenceError("VALIDATION_ERROR", "分页参数无效。");
  return { q, category: category.toLowerCase(), sort, ...(input.cursor ? { cursor: input.cursor } : {}) };
}

function decodeCursor(raw: string | undefined, query: ReturnType<typeof normalizeLibraryQuery>): Cursor | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!value || typeof value !== "object") throw new Error();
    const cursor = value as Cursor;
    if (cursor.v !== 1 || cursor.sort !== query.sort || cursor.q !== query.q || cursor.category !== query.category
      || typeof cursor.id !== "string" || !UUID.test(cursor.id) || typeof cursor.at !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.at)
      || !Number.isFinite(Date.parse(cursor.at))) throw new Error();
    return cursor;
  } catch { throw new PersistenceError("VALIDATION_ERROR", "分页已失效，请重新加载作品。"); }
}

async function readiness(client: PoolClient): Promise<{ categories: boolean; assets: boolean }> {
  const result = await client.query<{ categories: boolean; assets: boolean }>(`
    SELECT to_regclass('project_library_category') IS NOT NULL
      AND to_regclass('project_library_assignment') IS NOT NULL AS categories,
      to_regclass('asset') IS NOT NULL AS assets`);
  return result.rows[0] ?? { categories: false, assets: false };
}

async function requireWorkspace(client: PoolClient, workspaceId: string): Promise<void> {
  const result = await client.query("SELECT id FROM workspace WHERE id = $1 AND status = 'ACTIVE'", [workspaceId]);
  if (!result.rows[0]) throw new PersistenceError("NOT_FOUND", "工作空间不可用。");
}

function requireCategories(ready: { categories: boolean }): void {
  if (!ready.categories) throw new PersistenceError("PROJECT_LIBRARY_UNAVAILABLE", "分类功能尚未启用，请联系管理员完成数据库更新。");
}

/** All list filters run in PostgreSQL. Library metadata never changes project versions or production content. */
export class ProjectLibraryStore {
  constructor(private readonly pool: DatabasePool) {}

  async list(workspaceId: string, input: ProjectLibraryQuery = {}): Promise<ProjectLibraryPage> {
    const query = normalizeLibraryQuery(input);
    const cursor = decodeCursor(query.cursor, query);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await requireWorkspace(client, workspaceId);
      const ready = await readiness(client);
      if (query.category !== "all") requireCategories(ready);
      const search = `%${query.q.replace(/[\\%_]/g, "\\$&")}%`;
      const searchClause = "p.workspace_id = $1 AND (p.title ILIKE $2 OR p.premise ILIKE $2)";
      const assignmentJoin = ready.categories
        ? "LEFT JOIN project_library_assignment a ON a.project_id = p.id AND a.workspace_id = p.workspace_id"
        : "LEFT JOIN LATERAL (SELECT NULL::uuid AS category_id, 0 AS revision) a ON true";
      const categoryClause = "($3::text = 'all' OR ($3 = 'uncategorized' AND a.category_id IS NULL) OR a.category_id::text = $3)";
      const counts = await client.query<{ all_count: string; total: string; unclassified_count: string }>(`
        SELECT count(*) AS all_count, count(*) FILTER (WHERE ${categoryClause}) AS total,
          count(*) FILTER (WHERE a.category_id IS NULL) AS unclassified_count
        FROM project p ${assignmentJoin} WHERE ${searchClause}`, [workspaceId, search, query.category]);
      let categories: ProjectLibraryCategory[] = [];
      if (ready.categories) {
        const result = await client.query<{ id: string; name: string; count: string }>(`
          SELECT c.id, c.name, count(p.id) AS count FROM project_library_category c
          LEFT JOIN project_library_assignment a ON a.category_id = c.id AND a.workspace_id = c.workspace_id
          LEFT JOIN project p ON p.id = a.project_id AND p.workspace_id = a.workspace_id
            AND (p.title ILIKE $2 OR p.premise ILIKE $2)
          WHERE c.workspace_id = $1 GROUP BY c.id, c.name ORDER BY c.created_at, c.id`, [workspaceId, search]);
        categories = result.rows.map((row) => ({ ...row, count: Number(row.count) }));
      }
      const timestamp = query.sort === "updated" ? "p.updated_at" : "p.created_at";
      const categoryJoin = ready.categories
        ? "LEFT JOIN project_library_category c ON c.id = a.category_id AND c.workspace_id = p.workspace_id"
        : "LEFT JOIN LATERAL (SELECT NULL::text AS name) c ON true";
      const thumbnailJoin = ready.assets ? `LEFT JOIN LATERAL (
        SELECT asset.id FROM asset WHERE asset.project_id = p.id AND asset.workspace_id = p.workspace_id
          AND asset.kind = 'IMAGE' AND asset.status = 'ACTIVE' AND asset.review_status <> 'REJECTED'
          AND asset.storage_provider = 's3' AND asset.width > 1 AND asset.height > 1
          AND asset.mime_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/avif')
          AND asset.byte_size > 0 AND asset.byte_size <= 10485760
        ORDER BY asset.created_at DESC, asset.id DESC LIMIT 1
      ) thumbnail ON true` : "LEFT JOIN LATERAL (SELECT NULL::uuid AS id) thumbnail ON true";
      const result = await client.query<ListRow>(`
        SELECT p.id, p.title, p.premise, p.created_at, p.updated_at,
          to_char(${timestamp} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_at,
          a.category_id, c.name AS category_name, coalesce(a.revision, 0) AS category_revision,
          thumbnail.id AS thumbnail_asset_id,
          coalesce((to_jsonb(p)->>'episode_count')::integer, 3) AS episode_count,
          coalesce(to_jsonb(p)->>'writing_mode', 'short') AS writing_mode
        FROM project p ${assignmentJoin} ${categoryJoin} ${thumbnailJoin}
        WHERE ${searchClause} AND ${categoryClause}
          AND ($4::timestamptz IS NULL OR (${timestamp}, p.id) < ($4::timestamptz, $5::uuid))
        ORDER BY ${timestamp} DESC, p.id DESC LIMIT $6`,
      [workspaceId, search, query.category, cursor?.at ?? null, cursor?.id ?? null, PROJECT_LIBRARY_PAGE_SIZE + 1]);
      await client.query("COMMIT");
      const rows = result.rows.slice(0, PROJECT_LIBRARY_PAGE_SIZE);
      const last = rows.at(-1);
      const nextCursor = result.rows.length > PROJECT_LIBRARY_PAGE_SIZE && last
        ? Buffer.from(JSON.stringify({ v: 1, sort: query.sort, q: query.q, category: query.category,
          at: last.sort_at, id: last.id } satisfies Cursor)).toString("base64url") : null;
      return { items: rows.map((row) => ({
        id: row.id, title: row.title, premise: row.premise, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
        categoryId: row.category_id, categoryName: row.category_name, categoryRevision: row.category_revision,
        thumbnailAssetId: row.thumbnail_asset_id,
        thumbnailUrl: row.thumbnail_asset_id ? `/api/v1/real-media/assets/${row.thumbnail_asset_id}/content` : null,
        episodeCount: row.episode_count, writingMode: row.writing_mode,
      })), nextCursor, total: Number(counts.rows[0]?.total ?? 0), allCount: Number(counts.rows[0]?.all_count ?? 0),
      unclassifiedCount: Number(counts.rows[0]?.unclassified_count ?? 0), categories, categoriesReady: ready.categories };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async createCategory(workspaceId: string, input: { id: string; name: string }): Promise<ProjectLibraryCategory> {
    const name = input.name.trim();
    if (!UUID.test(input.id) || name.length < 1 || name.length > 40
      || Array.from(name).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      throw new PersistenceError("VALIDATION_ERROR", "分类名称须为 1–40 个字符。");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await requireWorkspace(client, workspaceId);
      requireCategories(await readiness(client));
      const result = await client.query<{ id: string; name: string }>(`
        INSERT INTO project_library_category (id, workspace_id, name) VALUES ($1, $2, $3)
        ON CONFLICT DO NOTHING RETURNING id, name`, [input.id.toLowerCase(), workspaceId, name]);
      let category = result.rows[0];
      if (!category) {
        const existing = await client.query<{ id: string; name: string }>(
          "SELECT id, name FROM project_library_category WHERE id = $1 AND workspace_id = $2", [input.id.toLowerCase(), workspaceId]);
        category = existing.rows[0];
        if (!category || category.name !== name) throw new PersistenceError("REVISION_CONFLICT", "分类名称已存在或请求已改变，请刷新后重试。");
      }
      const count = await client.query<{ count: string }>(
        "SELECT count(*) AS count FROM project_library_assignment WHERE workspace_id = $1 AND category_id = $2", [workspaceId, category.id]);
      await client.query("COMMIT");
      return { ...category, count: Number(count.rows[0]?.count ?? 0) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async assignCategory(workspaceId: string, projectId: string,
    input: { categoryId: string | null; expectedRevision: number }): Promise<ProjectLibraryAssignment> {
    if (!UUID.test(projectId) || (input.categoryId !== null && !UUID.test(input.categoryId))
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision >= 2147483647) {
      throw new PersistenceError("VALIDATION_ERROR", "作品分类参数无效。");
    }
    const categoryId = input.categoryId?.toLowerCase() ?? null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await requireWorkspace(client, workspaceId);
      requireCategories(await readiness(client));
      const project = await client.query("SELECT id FROM project WHERE id = $1 AND workspace_id = $2 FOR UPDATE", [projectId, workspaceId]);
      if (!project.rows[0]) throw new PersistenceError("NOT_FOUND", "作品不存在。");
      let categoryName: string | null = null;
      if (categoryId) {
        const category = await client.query<{ name: string }>(
          "SELECT name FROM project_library_category WHERE id = $1 AND workspace_id = $2", [categoryId, workspaceId]);
        if (!category.rows[0]) throw new PersistenceError("NOT_FOUND", "分类不存在。");
        categoryName = category.rows[0].name;
      }
      const existing = await client.query<{ category_id: string | null; revision: number }>(
        "SELECT category_id, revision FROM project_library_assignment WHERE project_id = $1 AND workspace_id = $2", [projectId, workspaceId]);
      const current = existing.rows[0];
      const revision = current?.revision ?? 0;
      if (revision !== input.expectedRevision) throw new PersistenceError("REVISION_CONFLICT", "作品分类已更新，请刷新后重试。");
      const nextRevision = (current?.category_id ?? null) === categoryId ? revision : revision + 1;
      if (nextRevision !== revision) {
        await client.query(`INSERT INTO project_library_assignment (project_id, workspace_id, category_id, revision)
          VALUES ($1, $2, $3, $4) ON CONFLICT (project_id, workspace_id) DO UPDATE
          SET category_id = EXCLUDED.category_id, revision = EXCLUDED.revision, updated_at = now()`,
        [projectId, workspaceId, categoryId, nextRevision]);
      }
      await client.query("COMMIT");
      return { projectId, categoryId, categoryName, categoryRevision: nextRevision };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}
