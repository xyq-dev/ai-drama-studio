import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ProjectLibraryStore } from "./project-library";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const CATEGORY = "33333333-3333-4333-8333-333333333333";
const ASSET = "44444444-4444-4444-8444-444444444444";
type Statement = { sql: string; values: unknown[] };
type Answer = { rows: Array<Record<string, unknown>> };
const EMPTY: Answer = { rows: [] };

/** Query-boundary tests; PostgreSQL execution is reserved for an isolated database, never an ambient URL. */
function harness(answers: Answer[] = []) {
  const statements: Statement[] = [];
  const release = vi.fn();
  const query = async (sql: string, values: unknown[] = []): Promise<Answer> => {
    statements.push({ sql, values });
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return EMPTY;
    const answer = answers.shift();
    if (!answer) throw new Error(`Unexpected query: ${sql}`);
    return answer;
  };
  const client = { query, release } as unknown as PoolClient;
  return { store: new ProjectLibraryStore({ connect: async () => client }), statements, release };
}
const active = { rows: [{ id: WORKSPACE }] };
const ready = { rows: [{ categories: true, assets: true }] };
const unavailable = { rows: [{ categories: false, assets: false }] };
function row(index = 0) {
  return { id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`, title: `作品 ${index}`, premise: "故事",
    created_at: new Date("2026-10-01T00:00:00.000Z"), updated_at: new Date("2026-11-01T00:00:00.123Z"),
    sort_at: "2026-11-01T00:00:00.123456Z", category_id: CATEGORY, category_name: "都市", category_revision: 2,
    thumbnail_asset_id: ASSET, episode_count: 3, writing_mode: "short" };
}
const counts = { rows: [{ all_count: "58", total: "25", unclassified_count: "8" }] };
const categories = { rows: [{ id: CATEGORY, name: "都市", count: "25" }] };

describe("project library reads", () => {
  it("bounds pages while reporting full search/category counts and exact timestamp cursors", async () => {
    const { store, statements, release } = harness([active, ready, counts, categories,
      { rows: Array.from({ length: 21 }, (_, index) => row(index)) }, active, ready, counts, categories, { rows: [row(22)] }]);
    const page = await store.list(WORKSPACE, { q: " 都市%_ ", category: CATEGORY });
    expect(page).toMatchObject({ total: 25, allCount: 58, unclassifiedCount: 8, categoriesReady: true, categories: [{ count: 25 }] });
    expect(page.items).toHaveLength(20);
    expect(page.items[0]).toMatchObject({ categoryRevision: 2, thumbnailAssetId: ASSET,
      thumbnailUrl: `/api/v1/real-media/assets/${ASSET}/content` });
    const cursor = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString()) as { at: string; id: string };
    expect(cursor.at).toBe("2026-11-01T00:00:00.123456Z");
    expect(cursor.id).toBe(row(19).id);
    const next = await store.list(WORKSPACE, { q: "都市%_", category: CATEGORY, cursor: page.nextCursor! });
    expect(next.nextCursor).toBeNull();
    const pages = statements.filter((statement) => statement.sql.includes("LIMIT $6"));
    expect(pages[0]?.values).toEqual([WORKSPACE, "%都市\\%\\_%", CATEGORY, null, null, 21]);
    expect(pages[1]?.values).toEqual([WORKSPACE, "%都市\\%\\_%", CATEGORY, cursor.at, cursor.id, 21]);
    expect(pages[0]?.sql).toContain("asset.workspace_id = p.workspace_id");
    expect(pages[0]?.sql).toContain("asset.review_status <> 'REJECTED'");
    expect(pages[0]?.sql).toContain("asset.width > 1 AND asset.height > 1");
    expect(pages[0]?.sql).toContain("asset.storage_provider = 's3'");
    expect(pages[0]?.sql).toContain("ORDER BY p.updated_at DESC, p.id DESC");
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("keeps old schemas readable without using missing library or media tables", async () => {
    const item = { ...row(), category_id: null, category_name: null, category_revision: 0, thumbnail_asset_id: null };
    const { store, statements } = harness([active, unavailable,
      { rows: [{ all_count: "1", total: "1", unclassified_count: "1" }] }, { rows: [item] }]);
    const result = await store.list(WORKSPACE, { sort: "created" });
    expect(result).toMatchObject({ categoriesReady: false, categories: [], total: 1,
      items: [{ thumbnailUrl: null, categoryRevision: 0 }] });
    const page = statements.find((statement) => statement.sql.includes("LIMIT $6"));
    expect(page?.sql).not.toContain("JOIN project_library_");
    expect(page?.sql).not.toContain("FROM asset");
    expect(page?.sql).toContain("ORDER BY p.created_at DESC, p.id DESC");
  });

  it("fails closed for classification before the draft is applied", async () => {
    const { store, statements, release } = harness([active, unavailable]);
    await expect(store.list(WORKSPACE, { category: "uncategorized" })).rejects.toMatchObject({ code: "PROJECT_LIBRARY_UNAVAILABLE" });
    expect(statements.at(-1)?.sql).toBe("ROLLBACK");
    expect(statements.some(({ sql }) => sql.includes("FROM project p"))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects suspended workspaces and stale query cursors before listing", async () => {
    const { store, statements } = harness([EMPTY]);
    await expect(store.list(WORKSPACE)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(statements.some(({ sql }) => sql.includes("FROM project p"))).toBe(false);
    const cursor = Buffer.from(JSON.stringify({ v: 1, q: "old", category: "all", sort: "updated",
      id: PROJECT, at: "2026-11-01T00:00:00.123456Z" })).toString("base64url");
    await expect(store.list(WORKSPACE, { q: "new", cursor })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(store.list(WORKSPACE, { category: "malformed" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("project category writes", () => {
  it("replays the same creation id and name without duplicating categories", async () => {
    const { store, statements } = harness([active, ready, EMPTY, { rows: [{ id: CATEGORY, name: "都市" }] }, { rows: [{ count: "2" }] }]);
    await expect(store.createCategory(WORKSPACE, { id: CATEGORY, name: " 都市 " })).resolves.toEqual({ id: CATEGORY, name: "都市", count: 2 });
    expect(statements.find(({ sql }) => sql.includes("INSERT INTO"))?.values).toEqual([CATEGORY, WORKSPACE, "都市"]);
    expect(statements.at(-1)?.sql).toBe("COMMIT");
  });

  it("refuses duplicate names, mismatched creation replays, and unavailable schema", async () => {
    for (const existing of [EMPTY, { rows: [{ id: CATEGORY, name: "古装" }] }]) {
      const { store } = harness([active, ready, EMPTY, existing]);
      await expect(store.createCategory(WORKSPACE, { id: CATEGORY, name: "都市" })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    }
    const { store, statements } = harness([active, unavailable]);
    await expect(store.createCategory(WORKSPACE, { id: CATEGORY, name: "都市" })).rejects.toMatchObject({ code: "PROJECT_LIBRARY_UNAVAILABLE" });
    expect(statements.some(({ sql }) => sql.includes("INSERT INTO"))).toBe(false);
  });

  it("assigns under the project lock and does not change the project text version or timestamps", async () => {
    const { store, statements } = harness([active, ready, { rows: [{ id: PROJECT }] },
      { rows: [{ name: "都市" }] }, EMPTY, EMPTY]);
    await expect(store.assignCategory(WORKSPACE, PROJECT, { categoryId: CATEGORY, expectedRevision: 0 }))
      .resolves.toEqual({ projectId: PROJECT, categoryId: CATEGORY, categoryName: "都市", categoryRevision: 1 });
    expect(statements.find(({ sql }) => sql.includes("FOR UPDATE"))?.values).toEqual([PROJECT, WORKSPACE]);
    expect(statements.find(({ sql }) => sql.includes("INSERT INTO project_library_assignment"))?.values)
      .toEqual([PROJECT, WORKSPACE, CATEGORY, 1]);
    expect(statements.some(({ sql }) => /UPDATE\s+project\s/i.test(sql))).toBe(false);
  });

  it("preserves a revision when clearing classification to prevent stale clients overwriting it", async () => {
    const { store, statements } = harness([active, ready, { rows: [{ id: PROJECT }] },
      { rows: [{ category_id: CATEGORY, revision: 2 }] }, EMPTY]);
    await expect(store.assignCategory(WORKSPACE, PROJECT, { categoryId: null, expectedRevision: 2 }))
      .resolves.toEqual({ projectId: PROJECT, categoryId: null, categoryName: null, categoryRevision: 3 });
    expect(statements.find(({ sql }) => sql.includes("INSERT INTO project_library_assignment"))?.values)
      .toEqual([PROJECT, WORKSPACE, null, 3]);
  });

  it("rejects stale revisions and categories from another workspace before writing", async () => {
    const stale = harness([active, ready, { rows: [{ id: PROJECT }] }, { rows: [{ category_id: CATEGORY, revision: 2 }] }]);
    await expect(stale.store.assignCategory(WORKSPACE, PROJECT, { categoryId: null, expectedRevision: 1 }))
      .rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const other = harness([active, ready, { rows: [{ id: PROJECT }] }, EMPTY]);
    await expect(other.store.assignCategory(WORKSPACE, PROJECT, { categoryId: CATEGORY, expectedRevision: 0 }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    for (const { statements } of [stale, other]) expect(statements.some(({ sql }) => sql.includes("INSERT INTO"))).toBe(false);
    expect(other.statements.find(({ sql }) => sql.includes("SELECT name"))?.values).toEqual([CATEGORY, WORKSPACE]);
  });

  it("does not write a no-op and rejects invalid revisions before database access", async () => {
    const { store, statements } = harness([active, ready, { rows: [{ id: PROJECT }] }, EMPTY]);
    expect((await store.assignCategory(WORKSPACE, PROJECT, { categoryId: null, expectedRevision: 0 })).categoryRevision).toBe(0);
    expect(statements.some(({ sql }) => sql.includes("INSERT INTO"))).toBe(false);
    await expect(store.assignCategory(WORKSPACE, PROJECT, { categoryId: null, expectedRevision: -1 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
