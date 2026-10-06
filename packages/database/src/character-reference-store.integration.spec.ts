import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrations";
import { CharacterReferenceStore, assertFrozenReferencesUsable } from "./character-reference-store";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");

/**
 * The reference columns, the IMAGE approval relaxation and the selection table come from an unapplied draft. Those
 * tests run only on an isolated database where the draft SQL was explicitly authorized; CI does not set this.
 */
const draftAuthorized = process.env.CHARACTER_REFERENCE_DRAFT_SQL_AUTHORIZED === "true";

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const store = new CharacterReferenceStore(pool);
const hash = "ab".repeat(32);

beforeAll(async () => {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await runMigrations(pool);
});

afterAll(async () => {
  await pool.end();
});

describe("CharacterReferenceStore without the reference draft", () => {
  it("reports storage unavailable and refuses every operation", async () => {
    expect(await store.storageReady()).toBe(false);
    await expect(store.listForCharacter("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"))
      .rejects.toMatchObject({ code: "CHARACTER_REFERENCE_STORAGE_UNAVAILABLE" });
    await expect(store.transaction((client) => store.strictVideoReferencesInTransaction(client,
      "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333")))
      .rejects.toMatchObject({ code: "CHARACTER_REFERENCE_STORAGE_UNAVAILABLE" });
    await expect(store.transaction((client) => assertFrozenReferencesUsable(client, "11111111-1111-4111-8111-111111111111",
      [{ characterRevisionId: "a", assetId: "b", checksumSha256: hash }])))
      .rejects.toMatchObject({ code: "CHARACTER_REFERENCE_STORAGE_UNAVAILABLE" });
  });
});

describe.runIf(draftAuthorized)("CharacterReferenceStore on the authorized reference draft", () => {
  let workspaceId: string;
  let projectId: string;
  let characterId: string;
  let revisionId: string;

  async function one(sql: string, values: unknown[]): Promise<string> {
    return String((await pool.query<{ id: string }>(sql, values)).rows[0]!.id);
  }

  async function reference(characterRevisionId: string, key: string): Promise<string> {
    return one(
      `INSERT INTO asset (workspace_id, project_id, kind, storage_provider, object_key, mime_type, byte_size,
         checksum_sha256, source_kind, reference_role, source_character_revision_id)
       VALUES ($1, $2, 'IMAGE', 'mock-object-store', $3, 'image/png', 1, $4, 'UPLOAD', 'character_reference', $5)
       RETURNING id`,
      [workspaceId, projectId, key, hash, characterRevisionId],
    );
  }

  const tx = <T>(work: (client: PoolClient) => Promise<T>) => store.transaction(work);

  beforeAll(async () => {
    const draft = await readFile(join(__dirname, "..", "prisma", "drafts", "20261005000200_character_reference_image.sql"), "utf8");
    await pool.query(draft);
    workspaceId = await one("INSERT INTO workspace (name) VALUES ('reference') RETURNING id", []);
    projectId = await one("INSERT INTO project (workspace_id, title) VALUES ($1, 'reference') RETURNING id", [workspaceId]);
    characterId = await one("INSERT INTO character (workspace_id, project_id, name) VALUES ($1, $2, 'lin') RETURNING id",
      [workspaceId, projectId]);
    revisionId = await one(
      `INSERT INTO character_revision (workspace_id, project_id, character_id, revision_no, content_json, content_hash, created_by)
       VALUES ($1, $2, $3, 1, '{}', $4, 'author') RETURNING id`,
      [workspaceId, projectId, characterId, hash],
    );
    await pool.query("UPDATE character SET current_revision_id = $1 WHERE id = $2", [revisionId, characterId]);
  });

  it("approves a reference only on its stored bytes and current row version", async () => {
    expect(await store.storageReady()).toBe(true);
    const assetId = await reference(revisionId, "refs/a.png");
    await expect(tx((client) => store.reviewInTransaction(client, { workspaceId, assetId, reviewedBy: "owner",
      traceId: "t", decision: "APPROVED", expectedRowVersion: 2, contentHash: hash, note: null })))
      .rejects.toMatchObject({ code: "REVIEW_CONFLICT" });
    await expect(tx((client) => store.reviewInTransaction(client, { workspaceId, assetId, reviewedBy: "owner",
      traceId: "t", decision: "APPROVED", expectedRowVersion: 1, contentHash: "cd".repeat(32), note: null })))
      .rejects.toMatchObject({ code: "REVIEW_CONFLICT" });
    const approved = await tx((client) => store.reviewInTransaction(client, { workspaceId, assetId, reviewedBy: "owner",
      traceId: "t", decision: "APPROVED", expectedRowVersion: 1, contentHash: hash, note: null }));
    expect(approved).toMatchObject({ reviewStatus: "APPROVED", reviewedContentHash: hash, rowVersion: 2 });
    await expect(tx((client) => store.reviewInTransaction(client, { workspaceId, assetId, reviewedBy: "owner",
      traceId: "t", decision: "REJECTED", expectedRowVersion: 2, contentHash: hash, note: "again" })))
      .rejects.toMatchObject({ code: "REVIEW_INVALID_TRANSITION" });
  });

  it("selects with compare-and-set and refuses an unapproved or stale reference", async () => {
    const draftAsset = await reference(revisionId, "refs/draft.png");
    await expect(tx((client) => store.selectInTransaction(client, { workspaceId, characterId, assetId: draftAsset,
      expectedSelectedAssetId: null, selectedBy: "owner", traceId: "t" }))).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
    const good = await reference(revisionId, "refs/good.png");
    await tx((client) => store.reviewInTransaction(client, { workspaceId, assetId: good, reviewedBy: "owner", traceId: "t",
      decision: "APPROVED", expectedRowVersion: 1, contentHash: hash, note: null }));
    await tx((client) => store.selectInTransaction(client, { workspaceId, characterId, assetId: good,
      expectedSelectedAssetId: null, selectedBy: "owner", traceId: "t" }));
    await expect(tx((client) => store.selectInTransaction(client, { workspaceId, characterId, assetId: good,
      expectedSelectedAssetId: null, selectedBy: "owner", traceId: "t" })))
      .rejects.toMatchObject({ code: "REFERENCE_SELECTION_CONFLICT", details: { currentAssetId: good } });
    expect((await store.listForCharacter(workspaceId, characterId)).selection).toMatchObject({ assetId: good, usable: true });
    await tx((client) => assertFrozenReferencesUsable(client, workspaceId,
      [{ characterRevisionId: revisionId, assetId: good, checksumSha256: hash }]));
    await pool.query("UPDATE asset SET status = 'STALE', row_version = row_version + 1 WHERE id = $1", [good]);
    expect((await store.listForCharacter(workspaceId, characterId)).selection).toMatchObject({ assetId: good, usable: false });
    await expect(tx((client) => assertFrozenReferencesUsable(client, workspaceId,
      [{ characterRevisionId: revisionId, assetId: good, checksumSha256: hash }])))
      .rejects.toMatchObject({ code: "CHARACTER_REFERENCE_REQUIRED" });
  });

  it("stales the videos and downstream assets made from a replaced selection, and nothing else (review P1)", async () => {
    const approve = (assetId: string) => tx((client) => store.reviewInTransaction(client, { workspaceId, assetId,
      reviewedBy: "owner", traceId: "t", decision: "APPROVED", expectedRowVersion: 1, contentHash: hash, note: null }));
    const a = await reference(revisionId, "refs/replace-a.png");
    const b = await reference(revisionId, "refs/replace-b.png");
    await approve(a);
    await approve(b);
    const current = (await store.listForCharacter(workspaceId, characterId)).selection?.assetId ?? null;
    await tx((client) => store.selectInTransaction(client, { workspaceId, characterId, assetId: a,
      expectedSelectedAssetId: current, selectedBy: "owner", traceId: "t" }));
    const upload = (kind: string, key: string) => one(
      `INSERT INTO asset (workspace_id, project_id, kind, storage_provider, object_key, mime_type, byte_size,
         checksum_sha256, source_kind) VALUES ($1, $2, $3, 'mock-object-store', $4, 'video/mp4', 1, $5, 'UPLOAD') RETURNING id`,
      [workspaceId, projectId, kind, key, hash]);
    const video = await upload("VIDEO", "videos/from-a.mp4");
    const composite = await upload("VIDEO", "videos/composite-of-a.mp4");
    const unrelated = await upload("VIDEO", "videos/unrelated.mp4");
    await pool.query("INSERT INTO asset_dependency (workspace_id, project_id, dependent_asset_id, source_asset_id) VALUES ($1,$2,$3,$4), ($1,$2,$5,$3)",
      [workspaceId, projectId, video, a, composite]);
    const replaced = await tx((client) => store.selectInTransaction(client, { workspaceId, characterId, assetId: b,
      expectedSelectedAssetId: a, selectedBy: "owner", traceId: "t" }));
    expect(replaced.staleAssetIds?.sort()).toEqual([video, composite].sort());
    const rows = (await pool.query<{ id: string; status: string; review_status: string }>(
      "SELECT id, status, review_status FROM asset WHERE id = ANY($1::uuid[])", [[a, b, video, composite, unrelated]])).rows;
    const status = Object.fromEntries(rows.map((row) => [row.id, row.status]));
    expect(status).toMatchObject({ [a]: "ACTIVE", [b]: "ACTIVE", [video]: "STALE", [composite]: "STALE", [unrelated]: "ACTIVE" });
    expect(rows.find((row) => row.id === a)?.review_status).toBe("APPROVED");
  });
});
