/** Opt-in native PostgreSQL acceptance. Only a new, explicitly named disposable database may be mutated. */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkDisposableAcceptanceEnv, verifyDisposableAcceptanceDatabase } from "./disposable-acceptance-guard";
import { PersistenceError } from "./job-service";
import { runMigrations } from "./migrations";
import { ProjectLibraryStore, type ProjectLibraryPage } from "./project-library";

const pattern = /^ads_library_acceptance_[a-z0-9_]+$/;
if (process.env.PROJECT_LIBRARY_TEST_ALLOW_WRITES !== "true" || process.env.PROJECT_LIBRARY_TEST_ALLOW_DRAFT !== "true") {
  throw new Error("Project library acceptance requires explicit isolated writes and draft flags");
}
// DATABASE_URL is compared only to reject accidental reuse; it is never used as a connection target or fallback.
const decision = checkDisposableAcceptanceEnv({
  databaseName: process.env.PROJECT_LIBRARY_TEST_DATABASE_NAME,
  url: process.env.PROJECT_LIBRARY_TEST_DATABASE_URL,
  businessDatabaseUrl: process.env.DATABASE_URL,
  namePattern: pattern,
  nameHint: pattern.source,
});
if (!decision.ok) throw new Error(`Project library acceptance refused: ${decision.reason}`);
const pool = new Pool({
  connectionString: decision.url, max: 8, connectionTimeoutMillis: 5000,
  statement_timeout: 15000, query_timeout: 20000, application_name: "project-library-isolated-acceptance",
});
const store = new ProjectLibraryStore(pool);
let baseline: string[];
let beforeDraft: { page: ProjectLibraryPage; tablesPresent: boolean; writeError: string | null; projectId: string };

async function workspace(): Promise<string> {
  return (await pool.query<{ id: string }>(
    "INSERT INTO workspace(name) VALUES('Synthetic project library acceptance') RETURNING id",
  )).rows[0]!.id;
}

async function project(workspaceId: string, title = "合成测试作品", timestamp = "2026-11-11T00:00:00.123456Z"): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO project(workspace_id, title, premise, created_at, updated_at)
     VALUES ($1, $2, 'synthetic premise', $3::timestamptz, $3::timestamptz) RETURNING id`,
    [workspaceId, title, timestamp],
  )).rows[0]!.id;
}

async function category(workspaceId: string, name: string) {
  return store.createCategory(workspaceId, { id: randomUUID(), name });
}

beforeAll(async () => {
  const safe = await verifyDisposableAcceptanceDatabase(pool, decision.databaseName, pattern);
  if (!safe.ok) throw new Error(safe.reason);
  baseline = (await runMigrations(pool)).applied;
  const tables = await pool.query<{ present: boolean }>(
    `SELECT to_regclass('project_library_category') IS NOT NULL
       OR to_regclass('project_library_assignment') IS NOT NULL AS present`,
  );
  const workspaceId = await workspace();
  const projectId = await project(workspaceId, "未迁移作品 100%_");
  let writeError: string | null = null;
  try { await category(workspaceId, "尚不可写"); }
  catch (error) {
    if (!(error instanceof PersistenceError)) throw error;
    writeError = error.code;
  }
  beforeDraft = { page: await store.list(workspaceId, { q: "100%_" }),
    tablesPresent: tables.rows[0]!.present, writeError, projectId };
  await pool.query(await readFile(resolve(__dirname, "../prisma/drafts/20261111000100_project_library.sql"), "utf8"));
});

afterAll(async () => { await pool.end(); });

describe("project library on a new disposable PostgreSQL database", () => {
  it("keeps the draft out of automatic migrations and reads the existing works before applying it", () => {
    expect(baseline.some((name) => name.includes("project_library"))).toBe(false);
    expect(beforeDraft.tablesPresent).toBe(false);
    expect(beforeDraft.writeError).toBe("PROJECT_LIBRARY_UNAVAILABLE");
    expect(beforeDraft.page).toMatchObject({ categoriesReady: false, categories: [], allCount: 1, total: 1,
      unclassifiedCount: 1, nextCursor: null, items: [{ id: beforeDraft.projectId, categoryId: null,
        categoryRevision: 0, thumbnailUrl: null, writingMode: "short", episodeCount: 3 }] });
  });

  it("lists and searches the saved script title and preserves the AI origin after a person edits the story", async () => {
    const workspaceId = await workspace();
    const projectId = await project(workspaceId, "AI 自动创作 2026/11/13");
    const categoryId = (await category(workspaceId, "创作来源")).id;
    await store.assignCategory(workspaceId, projectId, { categoryId, expectedRevision: 0 });
    const storyId = randomUUID();
    const runId = randomUUID();
    await pool.query(`INSERT INTO story_revision (id, workspace_id, project_id, revision_no, content_json, content_hash, created_by)
      VALUES ($1, $2, $3, 1, $4, repeat('0', 64), $5)`,
      [storyId, workspaceId, projectId, { text: "【AI 草稿】\n\n剧名：最后一枚纽扣\n一句话故事：样本" }, `auto-creation:${runId}`]);
    await pool.query(`UPDATE project SET current_story_revision_id = $2 WHERE id = $1`, [projectId, storyId]);
    await pool.query(`INSERT INTO auto_creation_run
      (id, workspace_id, project_id, actor_id, idempotency_key, input_hash, input_json,
       provider_key, model, state, call_cap, story_save, story_revision_id, created_at, updated_at)
      VALUES ($1, $2, $3, 'server-owner', $1::uuid::text, repeat('0', 64), '{}',
              'deepseek', 'deepseek-flash', 'completed', 10, 'saved', $4, now(), now())`,
      [runId, workspaceId, projectId, storyId]);
    await pool.query(`INSERT INTO auto_creation_stage
      (run_id, workspace_id, stage_key, ordinal, state, output_json, output_hash, script_save, updated_at)
      VALUES ($1, $2, 'bible', 1, 'completed', '{"title":"最后一枚纽扣"}', repeat('0',64), NULL, now()),
             ($1, $2, 'episode:1', 2, 'completed', '{}', repeat('0',64), 'pending', now())`, [runId, workspaceId]);
    const expected = { title: "最后一枚纽扣", source: "ai", providerKey: "deepseek", model: "deepseek-flash", destination: "auto" };
    await expect(store.list(workspaceId, { q: "纽扣", category: categoryId })).resolves.toMatchObject({
      total: 1, allCount: 1, categories: [{ id: categoryId, count: 1 }],
      items: [{ id: projectId, title: "AI 自动创作 2026/11/13", script: expected }],
    });
    const updatedId = randomUUID();
    await pool.query(`INSERT INTO story_revision (id, workspace_id, project_id, revision_no, content_json, content_hash, created_by)
      VALUES ($1, $2, $3, 2, $4, repeat('1', 64), 'server-owner')`,
      [updatedId, workspaceId, projectId, { text: "剧名：审阅后的纽扣\n一句话故事：修订样本" }]);
    await pool.query(`UPDATE project SET current_story_revision_id = $2 WHERE id = $1`, [projectId, updatedId]);
    await expect(store.list(workspaceId, { q: "审阅后的纽扣" })).resolves.toMatchObject({
      items: [{ id: projectId, script: { ...expected, title: "审阅后的纽扣" } }],
    });
    const episodeId = randomUUID();
    const scriptId = randomUUID();
    await pool.query(`INSERT INTO episode (id, workspace_id, project_id, episode_no, title)
      VALUES ($1, $2, $3, 1, '第1集')`, [episodeId, workspaceId, projectId]);
    await pool.query(`INSERT INTO script_revision
      (id, workspace_id, project_id, episode_id, revision_no, source_story_revision_id, content_json, content_hash, created_by)
      VALUES ($1, $2, $3, $4, 1, $5, '{"text":"已写入的分集剧本"}', repeat('0',64), 'server-owner')`,
      [scriptId, workspaceId, projectId, episodeId, updatedId]);
    await pool.query(`UPDATE episode SET current_script_revision_id = $2 WHERE id = $1`, [episodeId, scriptId]);
    await expect(store.list(workspaceId, { q: "审阅后的纽扣" })).resolves.toMatchObject({
      items: [{ id: projectId, script: { ...expected, title: "审阅后的纽扣", destination: "script" } }],
    });
  });

  it("recognizes a saved manual workbench draft and leaves an unrecorded origin unknown", async () => {
    const workspaceId = await workspace();
    const projectId = await project(workspaceId, "作品名");
    const old = await project(workspaceId, "旧作品");
    const storyId = randomUUID();
    const episodeId = randomUUID();
    const scriptId = randomUUID();
    await pool.query("UPDATE project SET episode_count = 1, target_episode_seconds = 60 WHERE id = $1", [projectId]);
    await pool.query(`INSERT INTO story_revision (id, workspace_id, project_id, revision_no, content_json, content_hash, created_by)
      VALUES ($1, $2, $3, 1, '{"workbench":{"schema":"script-workbench.v1"}}', repeat('0',64), 'server-owner')`,
      [storyId, workspaceId, projectId]);
    await pool.query(`UPDATE project SET current_story_revision_id = $2 WHERE id = $1`, [projectId, storyId]);
    await pool.query(`INSERT INTO episode (id, workspace_id, project_id, episode_no, title)
      VALUES ($1, $2, $3, 1, '第1集')`, [episodeId, workspaceId, projectId]);
    await pool.query(`INSERT INTO script_revision
      (id, workspace_id, project_id, episode_id, revision_no, source_story_revision_id, content_json, content_hash, created_by)
      VALUES ($1, $2, $3, $4, 1, $5, '{"workbench":{"script":{"title":"雨巷来信"}}}', repeat('0',64), 'server-owner')`,
      [scriptId, workspaceId, projectId, episodeId, storyId]);
    await pool.query(`UPDATE episode SET current_script_revision_id = $2 WHERE id = $1`, [episodeId, scriptId]);
    const { items } = await store.list(workspaceId);
    expect(items.find((item) => item.id === projectId)?.script).toEqual({
      title: "雨巷来信", source: "manual", providerKey: null, model: null, destination: "script",
    });
    expect(items.find((item) => item.id === old)?.script).toEqual({
      title: null, source: "unknown", providerKey: null, model: null, destination: null,
    });
  });

  it("persists creation and assignment across store instances without changing project version or ordering", async () => {
    const workspaceId = await workspace();
    const projectId = await project(workspaceId);
    const created = await category(workspaceId, "都市");
    const original = (await pool.query("SELECT version, updated_at::text FROM project WHERE id=$1", [projectId])).rows[0];
    await expect(store.createCategory(workspaceId, { id: created.id, name: "都市" })).resolves.toEqual(created);
    await expect(category(workspaceId, "都市")).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const english = await category(workspaceId, "Drama");
    await expect(category(workspaceId, "drama")).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(english.id).not.toBe(created.id);
    expect(await store.assignCategory(workspaceId, projectId, { categoryId: created.id, expectedRevision: 0 }))
      .toEqual({ projectId, categoryId: created.id, categoryName: "都市", categoryRevision: 1 });
    const restarted = new ProjectLibraryStore(pool);
    expect((await restarted.list(workspaceId)).items[0])
      .toMatchObject({ id: projectId, categoryId: created.id, categoryName: "都市", categoryRevision: 1 });
    await expect(restarted.assignCategory(workspaceId, projectId, { categoryId: null, expectedRevision: 0 }))
      .rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(await restarted.assignCategory(workspaceId, projectId, { categoryId: null, expectedRevision: 1 }))
      .toEqual({ projectId, categoryId: null, categoryName: null, categoryRevision: 2 });
    expect((await restarted.list(workspaceId, { category: "uncategorized" })).items[0])
      .toMatchObject({ id: projectId, categoryId: null, categoryRevision: 2 });
    expect((await pool.query("SELECT version, updated_at::text FROM project WHERE id=$1", [projectId])).rows[0]).toEqual(original);
    expect((await pool.query("SELECT revision FROM project_library_assignment WHERE project_id=$1", [projectId])).rows[0]?.revision).toBe(2);
  });

  it("paginates every matching row at microsecond precision and binds cursors to the query", async () => {
    const workspaceId = await workspace();
    const ids: string[] = [];
    for (let index = 1; index <= 45; index++) {
      ids.push(await project(workspaceId, `分页作品 ${index}`,
        `2026-11-11T00:00:00.${String(index).padStart(6, "0")}Z`));
    }
    for (const sort of ["updated", "created"] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.list(workspaceId, { sort, q: "分页作品", ...(cursor ? { cursor } : {}) });
        expect(page.total).toBe(45);
        expect(page.items.length).toBeLessThanOrEqual(20);
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor ?? undefined;
        if (cursor) {
          const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { at: string };
          expect(decoded.at).toMatch(/\.0000\d{2}Z$/);
        }
      } while (cursor);
      expect(seen).toEqual([...ids].reverse());
      expect(new Set(seen).size).toBe(45);
    }
    const first = await store.list(workspaceId, { q: "分页作品" });
    await expect(store.list(workspaceId, { q: "changed", cursor: first.nextCursor! })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(store.list(workspaceId, { q: "分页作品", sort: "created", cursor: first.nextCursor! })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("escapes search metacharacters and counts the full search before the selected category and page", async () => {
    const workspaceId = await workspace();
    const urban = await category(workspaceId, "都市");
    const costume = await category(workspaceId, "古装");
    for (let index = 0; index < 23; index++) {
      const projectId = await project(workspaceId, `匹配 ${index}`);
      if (index < 5) await store.assignCategory(workspaceId, projectId, { categoryId: urban.id, expectedRevision: 0 });
      if (index >= 5 && index < 8) await store.assignCategory(workspaceId, projectId, { categoryId: costume.id, expectedRevision: 0 });
    }
    const special = await project(workspaceId, "literal 100%_\\story");
    for (const q of ["100%_", "%", "_", "\\"]) {
      const page = await store.list(workspaceId, { q });
      expect(page.total).toBe(1);
      expect(page.items.map((item) => item.id)).toEqual([special]);
    }
    expect((await store.list(workspaceId, { q: "' OR true; --" })).total).toBe(0);
    const filtered = await store.list(workspaceId, { q: "匹配", category: urban.id });
    expect(filtered).toMatchObject({ total: 5, allCount: 23, unclassifiedCount: 15 });
    expect(filtered.categories).toEqual([
      { id: urban.id, name: "都市", count: 5 }, { id: costume.id, name: "古装", count: 3 },
    ]);
    expect((await store.list(workspaceId, { q: "匹配" })).items).toHaveLength(20);
    expect((await store.list(workspaceId, { q: "匹配", category: "uncategorized" })).total).toBe(15);
  });

  it("isolates workspace reads, writes and category foreign keys", async () => {
    const workspaceId = await workspace();
    const otherWorkspace = await workspace();
    const projectId = await project(workspaceId, "可见作品");
    const otherProject = await project(otherWorkspace, "不应可见");
    const own = await category(workspaceId, "同名分类");
    const other = await category(otherWorkspace, "同名分类");
    const page = await store.list(workspaceId);
    expect(page.items.map((item) => item.id)).toEqual([projectId]);
    expect(page.categories.map((item) => item.id)).toEqual([own.id]);
    await expect(store.assignCategory(workspaceId, otherProject, { categoryId: own.id, expectedRevision: 0 }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(store.assignCategory(workspaceId, projectId, { categoryId: other.id, expectedRevision: 0 }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await store.list(workspaceId, { category: other.id })).total).toBe(0);
    await expect(pool.query(`INSERT INTO project_library_assignment (project_id, workspace_id, category_id, revision)
      VALUES ($1, $2, $3, 1)`, [projectId, workspaceId, other.id])).rejects.toMatchObject({ code: "23503" });
    await pool.query("UPDATE workspace SET status='SUSPENDED' WHERE id=$1", [workspaceId]);
    await expect(store.list(workspaceId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("uses only a real, readable image belonging to the project and excludes newer unusable candidates", async () => {
    const workspaceId = await workspace();
    const projectId = await project(workspaceId, "有图作品");
    const emptyProject = await project(workspaceId, "无图作品");
    const otherWorkspace = await workspace();
    const otherProject = await project(otherWorkspace);
    let ordinal = 0;
    async function image(options: { projectId?: string; workspaceId?: string; provider?: string;
      width?: number; height?: number; mimeType?: string; bytes?: number; kind?: string } = {}): Promise<string> {
      ordinal++;
      const id = randomUUID();
      await pool.query(`INSERT INTO asset (id, workspace_id, project_id, kind, storage_provider, object_key,
        mime_type, byte_size, checksum_sha256, width, height, source_kind, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'UPLOAD',$12::timestamptz)`,
      [id, options.workspaceId ?? workspaceId, options.projectId ?? projectId, options.kind ?? "IMAGE",
        options.provider ?? "s3", `synthetic-library/${id}`, options.mimeType ?? "image/png", options.bytes ?? 100,
        "a".repeat(64), options.width ?? 512, options.height ?? 512, `2026-11-11T00:00:00.${String(ordinal).padStart(6, "0")}Z`]);
      return id;
    }
    const usable = await image();
    await image({ provider: "mock-object-store" });
    await image({ width: 1, height: 1 });
    await image({ mimeType: "image/svg+xml" });
    await image({ bytes: 10485761 });
    await image({ bytes: 0 });
    await image({ kind: "VIDEO", mimeType: "video/mp4" });
    const stale = await image();
    await pool.query("UPDATE asset SET status='STALE',row_version=row_version+1 WHERE id=$1", [stale]);
    const rejected = await image();
    await pool.query(`UPDATE asset SET review_status='REJECTED',reviewed_by='synthetic-reviewer',
      reviewed_at=now(),reviewed_content_hash=checksum_sha256,row_version=row_version+1 WHERE id=$1`, [rejected]);
    await image({ workspaceId: otherWorkspace, projectId: otherProject });
    const result = await store.list(workspaceId);
    expect(result.items.find((item) => item.id === projectId)).toMatchObject({ thumbnailAssetId: usable,
      thumbnailUrl: `/api/v1/real-media/assets/${usable}/content` });
    expect(result.items.find((item) => item.id === emptyProject)).toMatchObject({ thumbnailAssetId: null, thumbnailUrl: null });
  });

  it("allows exactly one concurrent classification writer with the same expected revision", async () => {
    const workspaceId = await workspace();
    const projectId = await project(workspaceId);
    const first = await category(workspaceId, "类别甲");
    const second = await category(workspaceId, "类别乙");
    const results = await Promise.allSettled([
      store.assignCategory(workspaceId, projectId, { categoryId: first.id, expectedRevision: 0 }),
      new ProjectLibraryStore(pool).assignCategory(workspaceId, projectId, { categoryId: second.id, expectedRevision: 0 }),
    ]);
    const successes = results.filter((result) => result.status === "fulfilled");
    expect(successes).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "REVISION_CONFLICT" } });
    const winner = successes[0]!;
    if (winner.status !== "fulfilled") throw new Error("Expected one successful classification");
    const page = await store.list(workspaceId);
    expect(page.items[0]).toMatchObject({ categoryId: winner.value.categoryId, categoryRevision: 1 });
    expect((await pool.query("SELECT count(*)::integer AS count FROM project_library_assignment WHERE project_id=$1", [projectId])).rows[0]?.count).toBe(1);
  });
});
