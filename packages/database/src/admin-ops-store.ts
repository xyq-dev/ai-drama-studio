import { Buffer } from "node:buffer";
import type { QueryResultRow } from "pg";
import { PersistenceError, type DatabasePool } from "./job-service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE = 20;

export interface AdminPageQuery {
  q?: string;
  status?: string;
  owner?: string;
  type?: string;
  cursor?: string;
  limit?: number;
}

export interface WorkSignalRow {
  id: string;
  title: string;
  updatedAt: string;
  ownerAccountId: string | null;
  ownerUsername: string | null;
  ownerStatus: string | null;
  episodeCount: number | null;
  episodeNo: number | null;
  scriptCount: number;
  imageCount: number;
  audioCount: number;
  videoCount: number;
  openImageJobs: number;
  openVoiceJobs: number;
  openVideoJobs: number;
  latestKind: string | null;
  latestState: string | null;
  latestError: string | null;
  latestSource: "generation" | "writing" | null;
  productionStatus: string;
}

export interface AssetSignalRow {
  id: string;
  kind: string;
  mimeType: string;
  createdAt: string;
  projectId: string;
  projectTitle: string;
  episodeNo: number | null;
  shotOrdinal: number | null;
  metadataName: string | null;
  jobId: string | null;
  jobKind: string | null;
}

export interface JobSignalRow {
  id: string;
  code: string;
  source: "generation" | "writing";
  kind: string;
  state: string;
  errorCode: string | null;
  updatedAt: string;
  projectTitle: string;
  episodeNo: number | null;
}

export interface OwnerFacetRow {
  id: string;
  username: string;
  status: string;
}

interface SchemaFlags {
  owner: boolean;
  episodes: boolean;
  creators: boolean;
  scripts: boolean;
  assets: boolean;
  jobs: boolean;
  shots: boolean;
  autoRuns: boolean;
  titleRuns: boolean;
  seriesRuns: boolean;
}

interface Cursor {
  v: 1;
  at: string;
  id: string;
}

interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function like(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function pageLimit(limit: number | undefined): number {
  if (limit === undefined) return PAGE;
  if (!Number.isFinite(limit)) throw new PersistenceError("VALIDATION_ERROR", "分页参数无效。");
  const size = Math.floor(limit);
  if (size < 1 || size > 50) throw new PersistenceError("VALIDATION_ERROR", "分页参数无效。");
  return size;
}

function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, at, id } satisfies Cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!value || typeof value !== "object") throw new Error();
    const cursor = value as Cursor;
    if (cursor.v !== 1 || typeof cursor.at !== "string" || !Number.isFinite(Date.parse(cursor.at)) || !UUID.test(cursor.id)) {
      throw new Error();
    }
    return cursor;
  } catch {
    throw new PersistenceError("VALIDATION_ERROR", "分页已失效，请重新加载。");
  }
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Read-only operator aggregation over existing tables.
 * Missing phase-4 columns (owner_account_id) and optional production tables degrade to empty signals.
 * No new table and no write, except none — this store never inserts.
 */
export class AdminOpsStore {
  constructor(private readonly pool: DatabasePool) {}

  async listWorks(workspaceId: string, input: AdminPageQuery = {}): Promise<{ items: WorkSignalRow[]; total: number; nextCursor: string | null; owners: OwnerFacetRow[] }> {
    const limit = pageLimit(input.limit);
    const q = (input.q ?? "").trim();
    if (q.length > 200) throw new PersistenceError("VALIDATION_ERROR", "作品查询参数无效。");
    const cursor = decodeCursor(input.cursor);
    const status = input.status && input.status !== "all" ? input.status : "";
    const owner = input.owner && input.owner !== "all" ? input.owner : "";
    if (status && !["draft", "script_review", "storyboard", "producing", "finished", "unknown"].includes(status)) {
      throw new PersistenceError("VALIDATION_ERROR", "作品查询参数无效。");
    }
    if (owner && owner !== "legacy" && !UUID.test(owner)) throw new PersistenceError("VALIDATION_ERROR", "作品查询参数无效。");
    return this.read(async (client) => {
      const flags = await this.flags(client);
      const sql = new Params();
      const workspace = sql.add(workspaceId);
      const where = [`p.workspace_id = ${workspace}::uuid`];
      if (q) where.push(`p.title ILIKE ${sql.add(like(q))} ESCAPE '\\'`);
      if (owner === "legacy") {
        if (flags.owner && flags.creators) where.push(`(c.status = 'LEGACY' OR c.username = 'legacy-owner' OR c.id IS NULL)`);
        else where.push("TRUE");
      } else if (owner && flags.owner) where.push(`p.owner_account_id = ${sql.add(owner)}::uuid`);
      if (cursor) {
        where.push(`(p.updated_at, p.id) < (${sql.add(cursor.at)}::timestamptz, ${sql.add(cursor.id)}::uuid)`);
      }
      const shape = this.workShape(flags);
      if (status) where.push(`${shape.statusSql} = ${sql.add(status)}`);
      const listed = await client.query<QueryResultRow>(`
        SELECT ${shape.columns}
          FROM project p
          ${flags.owner && flags.creators ? "LEFT JOIN creator_account c ON c.id = p.owner_account_id AND c.workspace_id = p.workspace_id" : ""}
          ${shape.join}
         WHERE ${where.join(" AND ")}
         ORDER BY p.updated_at DESC, p.id DESC
         LIMIT ${sql.add(limit + 1)}`, sql.values());
      const rows = listed.rows.map(mapWork);
      const next = rows.length > limit ? rows[limit - 1] : undefined;
      const items = rows.slice(0, limit);
      const countParams = new Params();
      const countWorkspace = countParams.add(workspaceId);
      const countWhere = [`p.workspace_id = ${countWorkspace}::uuid`];
      if (q) countWhere.push(`p.title ILIKE ${countParams.add(like(q))} ESCAPE '\\'`);
      if (owner === "legacy" && flags.owner && flags.creators) countWhere.push(`(c.status = 'LEGACY' OR c.username = 'legacy-owner' OR c.id IS NULL)`);
      else if (owner && flags.owner) countWhere.push(`p.owner_account_id = ${countParams.add(owner)}::uuid`);
      if (status) countWhere.push(`${shape.statusSql} = ${countParams.add(status)}`);
      const total = await client.query<{ n: number }>(`
        SELECT count(*)::int AS n
          FROM project p
          ${flags.owner && flags.creators ? "LEFT JOIN creator_account c ON c.id = p.owner_account_id AND c.workspace_id = p.workspace_id" : ""}
          ${shape.join}
         WHERE ${countWhere.join(" AND ")}`, countParams.values());
      const owners = flags.owner && flags.creators
        ? (await client.query<QueryResultRow>(`
            SELECT DISTINCT c.id::text AS id, c.username, c.status
              FROM project p
              JOIN creator_account c ON c.id = p.owner_account_id AND c.workspace_id = p.workspace_id
             WHERE p.workspace_id = $1::uuid AND c.status <> 'LEGACY' AND c.username <> 'legacy-owner'
             ORDER BY c.username ASC
             LIMIT 100`, [workspaceId])).rows.map((row) => ({
          id: String(row.id),
          username: String(row.username),
          status: String(row.status),
        }))
        : [];
      return {
        items,
        total: num(total.rows[0]?.n),
        nextCursor: next ? encodeCursor(next.updatedAt, next.id) : null,
        owners,
      };
    });
  }

  async getWork(workspaceId: string, id: string): Promise<WorkSignalRow | null> {
    if (!UUID.test(id)) throw new PersistenceError("VALIDATION_ERROR", "作品查询参数无效。");
    return this.read(async (client) => {
      const flags = await this.flags(client);
      const shape = this.workShape(flags);
      const result = await client.query<QueryResultRow>(`
        SELECT ${shape.columns}
          FROM project p
          ${flags.owner && flags.creators ? "LEFT JOIN creator_account c ON c.id = p.owner_account_id AND c.workspace_id = p.workspace_id" : ""}
          ${shape.join}
         WHERE p.workspace_id = $1::uuid AND p.id = $2::uuid`, [workspaceId, id]);
      const row = result.rows[0];
      return row ? mapWork(row) : null;
    });
  }

  async listAssets(workspaceId: string, input: AdminPageQuery = {}): Promise<{ items: AssetSignalRow[]; total: number; nextCursor: string | null; projects: Array<{ id: string; title: string }> }> {
    const limit = pageLimit(input.limit);
    const q = (input.q ?? "").trim();
    if (q.length > 200) throw new PersistenceError("VALIDATION_ERROR", "素材查询参数无效。");
    const type = input.type && input.type !== "all" ? input.type : "";
    const projectId = input.owner && input.owner !== "all" ? input.owner : "";
    if (type && !["image", "voice", "video"].includes(type)) throw new PersistenceError("VALIDATION_ERROR", "素材查询参数无效。");
    if (projectId && !UUID.test(projectId)) throw new PersistenceError("VALIDATION_ERROR", "素材查询参数无效。");
    const cursor = decodeCursor(input.cursor);
    return this.read(async (client) => {
      const flags = await this.flags(client);
      if (!flags.assets) return { items: [], total: 0, nextCursor: null, projects: [] };
      const kindSql = type === "image" ? "a.kind = 'IMAGE'" : type === "voice" ? "a.kind = 'AUDIO'" : type === "video" ? "a.kind IN ('VIDEO','COMPOSITE')" : "a.kind IN ('IMAGE','AUDIO','VIDEO','COMPOSITE')";
      const sql = new Params();
      const where = [
        `a.workspace_id = ${sql.add(workspaceId)}::uuid`,
        "a.status = 'ACTIVE'",
        "a.review_status <> 'REJECTED'",
        "a.source_kind <> 'UPLOAD'",
        kindSql,
      ];
      if (q) {
        const pattern = sql.add(like(q));
        where.push(`(p.title ILIKE ${pattern} ESCAPE '\\' OR COALESCE(a.metadata_json->>'name', a.metadata_json->>'title', a.metadata_json->>'label', '') ILIKE ${pattern} ESCAPE '\\')`);
      }
      if (projectId) where.push(`a.project_id = ${sql.add(projectId)}::uuid`);
      if (cursor) where.push(`(a.created_at, a.id) < (${sql.add(cursor.at)}::timestamptz, ${sql.add(cursor.id)}::uuid)`);
      const shotJoin = flags.shots
        ? `LEFT JOIN shot_revision sr ON sr.id = a.source_shot_revision_id AND sr.workspace_id = a.workspace_id
           LEFT JOIN shot sh ON sh.id = sr.shot_id AND sh.workspace_id = a.workspace_id
           LEFT JOIN episode e ON e.id = sh.episode_id AND e.workspace_id = a.workspace_id`
        : "";
      const jobJoin = flags.jobs ? "LEFT JOIN generation_job j ON j.id = a.source_generation_job_id AND j.workspace_id = a.workspace_id" : "";
      const rows = await client.query<QueryResultRow>(`
        SELECT a.id::text AS id, a.kind, a.mime_type, a.created_at, p.id::text AS project_id, p.title AS project_title,
               ${flags.shots ? "e.episode_no" : "NULL::int"} AS episode_no,
               ${flags.shots ? "sr.ordinal" : "NULL::int"} AS shot_ordinal,
               NULLIF(btrim(COALESCE(a.metadata_json->>'name', a.metadata_json->>'title', a.metadata_json->>'label', '')), '') AS metadata_name,
               ${flags.jobs ? "j.id::text" : "NULL::text"} AS job_id,
               ${flags.jobs ? "j.kind" : "NULL::text"} AS job_kind
          FROM asset a
          JOIN project p ON p.id = a.project_id AND p.workspace_id = a.workspace_id
          ${shotJoin}
          ${jobJoin}
         WHERE ${where.join(" AND ")}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT ${sql.add(limit + 1)}`, sql.values());
      const mapped = rows.rows.map(mapAsset);
      const next = mapped.length > limit ? mapped[limit - 1] : undefined;
      const count = new Params();
      const countWhere = [
        `a.workspace_id = ${count.add(workspaceId)}::uuid`,
        "a.status = 'ACTIVE'",
        "a.review_status <> 'REJECTED'",
        "a.source_kind <> 'UPLOAD'",
        kindSql,
      ];
      if (q) {
        const pattern = count.add(like(q));
        countWhere.push(`(p.title ILIKE ${pattern} ESCAPE '\\' OR COALESCE(a.metadata_json->>'name', a.metadata_json->>'title', a.metadata_json->>'label', '') ILIKE ${pattern} ESCAPE '\\')`);
      }
      if (projectId) countWhere.push(`a.project_id = ${count.add(projectId)}::uuid`);
      const total = await client.query<{ n: number }>(`
        SELECT count(*)::int AS n FROM asset a
          JOIN project p ON p.id = a.project_id AND p.workspace_id = a.workspace_id
         WHERE ${countWhere.join(" AND ")}`, count.values());
      const projects = await client.query<QueryResultRow>(`
        SELECT DISTINCT p.id::text AS id, p.title
          FROM asset a
          JOIN project p ON p.id = a.project_id AND p.workspace_id = a.workspace_id
         WHERE a.workspace_id = $1::uuid AND a.status = 'ACTIVE' AND a.review_status <> 'REJECTED' AND a.source_kind <> 'UPLOAD'
           AND a.kind IN ('IMAGE','AUDIO','VIDEO','COMPOSITE')
         ORDER BY p.title ASC
         LIMIT 100`, [workspaceId]);
      return {
        items: mapped.slice(0, limit),
        total: num(total.rows[0]?.n),
        nextCursor: next ? encodeCursor(next.createdAt, next.id) : null,
        projects: projects.rows.map((row) => ({ id: String(row.id), title: String(row.title) })),
      };
    });
  }

  async getAsset(workspaceId: string, id: string): Promise<AssetSignalRow | null> {
    if (!UUID.test(id)) throw new PersistenceError("VALIDATION_ERROR", "素材查询参数无效。");
    return this.read(async (client) => {
      const flags = await this.flags(client);
      if (!flags.assets) return null;
      const shotJoin = flags.shots
        ? `LEFT JOIN shot_revision sr ON sr.id = a.source_shot_revision_id AND sr.workspace_id = a.workspace_id
           LEFT JOIN shot sh ON sh.id = sr.shot_id AND sh.workspace_id = a.workspace_id
           LEFT JOIN episode e ON e.id = sh.episode_id AND e.workspace_id = a.workspace_id`
        : "";
      const result = await client.query<QueryResultRow>(`
        SELECT a.id::text AS id, a.kind, a.mime_type, a.created_at, p.id::text AS project_id, p.title AS project_title,
               ${flags.shots ? "e.episode_no" : "NULL::int"} AS episode_no,
               ${flags.shots ? "sr.ordinal" : "NULL::int"} AS shot_ordinal,
               NULLIF(btrim(COALESCE(a.metadata_json->>'name', a.metadata_json->>'title', a.metadata_json->>'label', '')), '') AS metadata_name,
               ${flags.jobs ? "j.id::text" : "NULL::text"} AS job_id,
               ${flags.jobs ? "j.kind" : "NULL::text"} AS job_kind
          FROM asset a
          JOIN project p ON p.id = a.project_id AND p.workspace_id = a.workspace_id
          ${shotJoin}
          ${flags.jobs ? "LEFT JOIN generation_job j ON j.id = a.source_generation_job_id AND j.workspace_id = a.workspace_id" : ""}
         WHERE a.workspace_id = $1::uuid AND a.id = $2::uuid
           AND a.status = 'ACTIVE' AND a.review_status <> 'REJECTED' AND a.source_kind <> 'UPLOAD'
           AND a.kind IN ('IMAGE','AUDIO','VIDEO','COMPOSITE')`, [workspaceId, id]);
      const row = result.rows[0];
      return row ? mapAsset(row) : null;
    });
  }

  async listJobs(workspaceId: string, input: AdminPageQuery = {}): Promise<{ items: JobSignalRow[]; total: number; nextCursor: string | null }> {
    const limit = pageLimit(input.limit);
    const q = (input.q ?? "").trim();
    if (q.length > 200) throw new PersistenceError("VALIDATION_ERROR", "任务查询参数无效。");
    const type = input.type && input.type !== "all" ? input.type : "";
    const status = input.status && input.status !== "all" ? input.status : "";
    if (type && !["writing", "image", "voice", "video"].includes(type)) throw new PersistenceError("VALIDATION_ERROR", "任务查询参数无效。");
    if (status && !["succeeded", "running", "failed", "unknown", "canceled", "queued"].includes(status)) {
      throw new PersistenceError("VALIDATION_ERROR", "任务查询参数无效。");
    }
    const cursor = decodeCursor(input.cursor);
    return this.read(async (client) => {
      const flags = await this.flags(client);
      const parts = this.jobUnions(flags);
      if (parts.length === 0) return { items: [], total: 0, nextCursor: null };
      const built = this.bindJobQuery(flags, workspaceId, { q, type, status, cursor, limit: limit + 1 });
      const listed = await client.query<QueryResultRow>(built.sql, built.values);
      const mapped = listed.rows.map(mapJob);
      const counted = this.bindJobQuery(flags, workspaceId, { q, type, status, cursor: null, limit: null });
      const total = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${counted.sql.replace(/ORDER BY[\s\S]*$/, "")}) counted`, counted.values);
      const next = mapped.length > limit ? mapped[limit - 1] : undefined;
      return {
        items: mapped.slice(0, limit),
        total: num(total.rows[0]?.n),
        nextCursor: next ? encodeCursor(next.updatedAt, next.id) : null,
      };
    });
  }

  async getJob(workspaceId: string, id: string): Promise<JobSignalRow | null> {
    if (!UUID.test(id)) throw new PersistenceError("VALIDATION_ERROR", "任务查询参数无效。");
    return this.read(async (client) => {
      const flags = await this.flags(client);
      const parts = this.jobUnions(flags);
      if (parts.length === 0) return null;
      const result = await client.query<QueryResultRow>(`
        SELECT id, code, source, kind, state, error_code, updated_at, project_title, episode_no
          FROM (${parts.join(" UNION ALL ")}) jobs
         WHERE id = $2::uuid`, [workspaceId, id]);
      const row = result.rows[0];
      return row ? mapJob(row) : null;
    });
  }

  private bindJobQuery(flags: SchemaFlags, workspaceId: string, input: {
    q: string;
    type: string;
    status: string;
    cursor: Cursor | null;
    limit: number | null;
  }): { sql: string; values: unknown[] } {
    const sql = new Params();
    const workspace = sql.add(workspaceId);
    const parts = this.jobUnions(flags, workspace);
    const where = ["TRUE"];
    if (input.q) {
      const pattern = sql.add(like(input.q));
      where.push(`(project_title ILIKE ${pattern} ESCAPE '\\' OR id::text ILIKE ${pattern} ESCAPE '\\' OR code ILIKE ${pattern} ESCAPE '\\')`);
    }
    if (input.type) where.push(`job_type = ${sql.add(input.type)}`);
    if (input.status) where.push(`display_status = ${sql.add(input.status)}`);
    if (input.cursor) where.push(`(updated_at, id) < (${sql.add(input.cursor.at)}::timestamptz, ${sql.add(input.cursor.id)}::uuid)`);
    const order = input.limit === null ? "" : ` ORDER BY updated_at DESC, id DESC LIMIT ${sql.add(input.limit)}`;
    return {
      sql: `SELECT id, code, source, kind, state, error_code, updated_at, project_title, episode_no, job_type, display_status
              FROM (${parts.join(" UNION ALL ")}) jobs
             WHERE ${where.join(" AND ")}${order}`,
      values: sql.values(),
    };
  }

  private jobUnions(flags: SchemaFlags, workspaceRef = "$1::uuid"): string[] {
    const code = `'JOB-' || lpad(((('x' || right(replace(id_src::text, '-', ''), 4))::bit(16)::int % 10000))::text, 4, '0')`;
    const display = `CASE
      WHEN error_code = 'MOCK_REQUEST_UNKNOWN' OR state IN ('needs_attention','partial') THEN 'unknown'
      WHEN state IN ('SUCCEEDED','completed') THEN 'succeeded'
      WHEN state IN ('FAILED','failed') THEN 'failed'
      WHEN state IN ('CANCELED','canceled','cancelled') THEN 'canceled'
      WHEN state IN ('QUEUED','PENDING','pending') THEN 'queued'
      WHEN state IN ('RUNNING','WAITING_EXTERNAL','running') THEN 'running'
      ELSE 'unknown'
    END`;
    const parts: string[] = [];
    if (flags.jobs) {
      const episode = flags.shots ? "e.episode_no" : "NULL::int";
      const shot = flags.shots
        ? `LEFT JOIN shot_revision sr ON sr.id = j.source_shot_revision_id AND sr.workspace_id = j.workspace_id
           LEFT JOIN shot sh ON sh.id = sr.shot_id AND sh.workspace_id = j.workspace_id
           LEFT JOIN episode e ON e.id = sh.episode_id AND e.workspace_id = j.workspace_id`
        : "";
      parts.push(`
        SELECT j.id, j.id::text AS id_src, 'generation'::text AS source, j.kind, j.state, j.error_code, j.updated_at,
               p.title AS project_title, ${episode} AS episode_no,
               CASE
                 WHEN j.kind IN ('MEDIA_IMAGE','MEDIA_CHARACTER_REFERENCE') THEN 'image'
                 WHEN j.kind = 'MEDIA_TTS' THEN 'voice'
                 WHEN j.kind IN ('MEDIA_VIDEO','MEDIA_COMPOSE') THEN 'video'
                 WHEN j.kind IN ('SCENES','SHOTS','STORY','SCRIPT') THEN 'writing'
                 ELSE 'other'
               END AS job_type
          FROM generation_job j
          JOIN project p ON p.id = j.project_id AND p.workspace_id = j.workspace_id
          ${shot}
         WHERE j.workspace_id = ${workspaceRef}`);
    }
    const writing = (table: string) => `
      SELECT r.id, r.id::text AS id_src, 'writing'::text AS source, 'WRITING'::text AS kind, r.state, r.error_code, r.updated_at,
             p.title AS project_title, NULL::int AS episode_no, 'writing'::text AS job_type
        FROM ${table} r
        JOIN project p ON p.id = r.project_id AND p.workspace_id = r.workspace_id
       WHERE r.workspace_id = ${workspaceRef}`;
    if (flags.autoRuns) parts.push(writing("auto_creation_run"));
    if (flags.titleRuns) parts.push(writing("title_writing_run"));
    if (flags.seriesRuns) parts.push(writing("series_writing_run"));
    // Keep id as uuid. Detail and cursor predicates compare it with ::uuid; casting to text makes PostgreSQL reject `text = uuid`.
    return parts.map((part) => `
      SELECT id, ${code.replaceAll("id_src", "id_src")} AS code, source, kind, state, error_code, updated_at,
             project_title, episode_no, job_type, ${display} AS display_status
        FROM (${part}) raw`);
  }

  private workShape(flags: SchemaFlags): { columns: string; join: string; statusSql: string } {
    const statusSql = this.productionCase(flags);
    const script = flags.scripts
      ? `(SELECT count(*) FROM script_revision s WHERE s.project_id = p.id AND s.workspace_id = p.workspace_id AND COALESCE(to_jsonb(s)->>'deleted_at','') = '')`
      : "0";
    const asset = (kindSql: string) => flags.assets
      ? `(SELECT count(*) FROM asset a WHERE a.project_id = p.id AND a.workspace_id = p.workspace_id AND a.status = 'ACTIVE' AND a.review_status <> 'REJECTED' AND a.source_kind <> 'UPLOAD' AND ${kindSql})`
      : "0";
    const open = (kindSql: string) => flags.jobs
      ? `(SELECT count(*) FROM generation_job j WHERE j.project_id = p.id AND j.workspace_id = p.workspace_id AND j.state IN ('PENDING','QUEUED','RUNNING','WAITING_EXTERNAL') AND ${kindSql})`
      : "0";
    const latestParts: string[] = [];
    if (flags.jobs) {
      latestParts.push(`SELECT j.kind, j.state, j.error_code, j.updated_at, 'generation'::text AS source
        FROM generation_job j WHERE j.project_id = p.id AND j.workspace_id = p.workspace_id`);
    }
    for (const [enabled, table] of [[flags.autoRuns, "auto_creation_run"], [flags.titleRuns, "title_writing_run"], [flags.seriesRuns, "series_writing_run"]] as const) {
      if (enabled) {
        latestParts.push(`SELECT 'WRITING'::text, r.state, r.error_code, r.updated_at, 'writing'::text
          FROM ${table} r WHERE r.project_id = p.id AND r.workspace_id = p.workspace_id`);
      }
    }
    const join = latestParts.length
      ? `LEFT JOIN LATERAL (
           SELECT kind, state, error_code, source FROM (${latestParts.join(" UNION ALL ")}) u
            ORDER BY updated_at DESC LIMIT 1
         ) latest ON TRUE`
      : "";
    const episode = flags.jobs && flags.shots
      ? `COALESCE((
           SELECT e.episode_no FROM generation_job j
             JOIN shot_revision sr ON sr.id = j.source_shot_revision_id AND sr.workspace_id = j.workspace_id
             JOIN shot sh ON sh.id = sr.shot_id AND sh.workspace_id = j.workspace_id
             JOIN episode e ON e.id = sh.episode_id AND e.workspace_id = j.workspace_id
            WHERE j.project_id = p.id AND j.workspace_id = p.workspace_id
              AND j.state IN ('PENDING','QUEUED','RUNNING','WAITING_EXTERNAL')
            ORDER BY j.updated_at DESC LIMIT 1
         ), (
           SELECT max(e.episode_no) FROM episode e WHERE e.project_id = p.id AND e.workspace_id = p.workspace_id
         ))`
      : flags.episodes
        ? `(SELECT max(e.episode_no) FROM episode e WHERE e.project_id = p.id AND e.workspace_id = p.workspace_id)`
        : "NULL::int";
    const columns = `p.id::text AS id, p.title, p.updated_at,
      ${flags.owner ? "p.owner_account_id::text" : "NULL::text"} AS owner_account_id,
      ${flags.owner && flags.creators ? "c.username" : "NULL::text"} AS owner_username,
      ${flags.owner && flags.creators ? "c.status" : "NULL::text"} AS owner_status,
      ${flags.episodes ? "p.episode_count" : "NULL::int"} AS episode_count,
      ${episode} AS episode_no,
      ${script}::int AS script_count,
      ${asset("a.kind = 'IMAGE'")}::int AS image_count,
      ${asset("a.kind = 'AUDIO'")}::int AS audio_count,
      ${asset("a.kind IN ('VIDEO','COMPOSITE')")}::int AS video_count,
      ${open("j.kind = 'MEDIA_IMAGE'")}::int AS open_image_jobs,
      ${open("j.kind = 'MEDIA_TTS'")}::int AS open_voice_jobs,
      ${open("j.kind IN ('MEDIA_VIDEO','MEDIA_COMPOSE')")}::int AS open_video_jobs,
      ${latestParts.length ? "latest.kind" : "NULL::text"} AS latest_kind,
      ${latestParts.length ? "latest.state" : "NULL::text"} AS latest_state,
      ${latestParts.length ? "latest.error_code" : "NULL::text"} AS latest_error,
      ${latestParts.length ? "latest.source" : "NULL::text"} AS latest_source,
      ${statusSql} AS production_status`;
    return { columns, join, statusSql };
  }

  private productionCase(flags: SchemaFlags): string {
    const image = flags.assets
      ? `(SELECT count(*) FROM asset a WHERE a.project_id = p.id AND a.workspace_id = p.workspace_id AND a.status = 'ACTIVE' AND a.review_status <> 'REJECTED' AND a.source_kind <> 'UPLOAD' AND a.kind = 'IMAGE')`
      : "0";
    const audio = flags.assets
      ? `(SELECT count(*) FROM asset a WHERE a.project_id = p.id AND a.workspace_id = p.workspace_id AND a.status = 'ACTIVE' AND a.review_status <> 'REJECTED' AND a.source_kind <> 'UPLOAD' AND a.kind = 'AUDIO')`
      : "0";
    const video = flags.assets
      ? `(SELECT count(*) FROM asset a WHERE a.project_id = p.id AND a.workspace_id = p.workspace_id AND a.status = 'ACTIVE' AND a.review_status <> 'REJECTED' AND a.source_kind <> 'UPLOAD' AND a.kind IN ('VIDEO','COMPOSITE'))`
      : "0";
    const script = flags.scripts
      ? `(SELECT count(*) FROM script_revision s WHERE s.project_id = p.id AND s.workspace_id = p.workspace_id AND COALESCE(to_jsonb(s)->>'deleted_at','') = '')`
      : "0";
    const open = (kindSql: string) => flags.jobs
      ? `(SELECT count(*) FROM generation_job j WHERE j.project_id = p.id AND j.workspace_id = p.workspace_id AND j.state IN ('PENDING','QUEUED','RUNNING','WAITING_EXTERNAL') AND ${kindSql})`
      : "0";
    const openImage = open("j.kind = 'MEDIA_IMAGE'");
    const openVoice = open("j.kind = 'MEDIA_TTS'");
    const openVideo = open("j.kind IN ('MEDIA_VIDEO','MEDIA_COMPOSE')");
    const openSum = `(${openImage} + ${openVoice} + ${openVideo})`;
    return `CASE
      WHEN ${video} > 0 AND ${openSum} = 0 THEN 'finished'
      WHEN ${openVoice} > 0 OR ${openVideo} > 0 OR ${audio} > 0 OR (${video} > 0 AND ${openSum} > 0) THEN 'producing'
      WHEN ${image} > 0 OR ${openImage} > 0 THEN 'storyboard'
      WHEN ${script} > 0 THEN 'script_review'
      WHEN length(btrim(p.title)) > 0 THEN 'draft'
      ELSE 'unknown'
    END`;
  }

  private async flags(client: Queryable): Promise<SchemaFlags> {
    const result = await client.query<SchemaFlags & QueryResultRow>(`
      SELECT
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'project' AND column_name = 'owner_account_id') AS owner,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'project' AND column_name = 'episode_count') AS episodes,
        to_regclass('creator_account') IS NOT NULL AS creators,
        to_regclass('script_revision') IS NOT NULL AS scripts,
        to_regclass('asset') IS NOT NULL AS assets,
        to_regclass('generation_job') IS NOT NULL AS jobs,
        to_regclass('shot_revision') IS NOT NULL AND to_regclass('shot') IS NOT NULL AND to_regclass('episode') IS NOT NULL AS shots,
        to_regclass('auto_creation_run') IS NOT NULL AS "autoRuns",
        to_regclass('title_writing_run') IS NOT NULL AS "titleRuns",
        to_regclass('series_writing_run') IS NOT NULL AS "seriesRuns"`);
    const row = result.rows[0];
    return {
      owner: row?.owner === true,
      episodes: row?.episodes === true,
      creators: row?.creators === true,
      scripts: row?.scripts === true,
      assets: row?.assets === true,
      jobs: row?.jobs === true,
      shots: row?.shots === true,
      autoRuns: row?.autoRuns === true,
      titleRuns: row?.titleRuns === true,
      seriesRuns: row?.seriesRuns === true,
    };
  }

  private async read<T>(work: (client: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
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

class Params {
  private readonly list: unknown[] = [];
  add(value: unknown): string {
    this.list.push(value);
    return `$${this.list.length}`;
  }
  values(): unknown[] { return this.list; }
}

function mapWork(row: QueryResultRow): WorkSignalRow {
  return {
    id: String(row.id),
    title: String(row.title),
    updatedAt: iso(row.updated_at as Date),
    ownerAccountId: row.owner_account_id == null ? null : String(row.owner_account_id),
    ownerUsername: row.owner_username == null ? null : String(row.owner_username),
    ownerStatus: row.owner_status == null ? null : String(row.owner_status),
    episodeCount: nullableNumber(row.episode_count),
    episodeNo: nullableNumber(row.episode_no),
    scriptCount: num(row.script_count),
    imageCount: num(row.image_count),
    audioCount: num(row.audio_count),
    videoCount: num(row.video_count),
    openImageJobs: num(row.open_image_jobs),
    openVoiceJobs: num(row.open_voice_jobs),
    openVideoJobs: num(row.open_video_jobs),
    latestKind: row.latest_kind == null ? null : String(row.latest_kind),
    latestState: row.latest_state == null ? null : String(row.latest_state),
    latestError: row.latest_error == null ? null : String(row.latest_error),
    latestSource: row.latest_source === "writing" || row.latest_source === "generation" ? row.latest_source : null,
    productionStatus: String(row.production_status),
  };
}

function mapAsset(row: QueryResultRow): AssetSignalRow {
  return {
    id: String(row.id),
    kind: String(row.kind),
    mimeType: String(row.mime_type),
    createdAt: iso(row.created_at as Date),
    projectId: String(row.project_id),
    projectTitle: String(row.project_title),
    episodeNo: nullableNumber(row.episode_no),
    shotOrdinal: nullableNumber(row.shot_ordinal),
    metadataName: row.metadata_name == null ? null : String(row.metadata_name),
    jobId: row.job_id == null ? null : String(row.job_id),
    jobKind: row.job_kind == null ? null : String(row.job_kind),
  };
}

function mapJob(row: QueryResultRow): JobSignalRow {
  const source = row.source === "writing" ? "writing" : "generation";
  return {
    id: String(row.id),
    code: String(row.code),
    source,
    kind: String(row.kind),
    state: String(row.state),
    errorCode: row.error_code == null ? null : String(row.error_code),
    updatedAt: iso(row.updated_at as Date),
    projectTitle: String(row.project_title),
    episodeNo: nullableNumber(row.episode_no),
  };
}
