import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./migrations";
import { TextChainService } from "./text-chain";
import { VimaxPreviewSourceStore } from "./vimax-preview-source";
import type { DatabasePool } from "./job-service";

// Collected only by the existing isolated PostgreSQL integration command, never the ordinary unit test run.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const chain = new TextChainService(pool);
const source = new VimaxPreviewSourceStore(pool);
const TEXT = "【场景】车站\r\n【动作】林夏望向门口。\r\n林夏：等我。\r\n";
beforeAll(async () => {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await runMigrations(pool);
});
beforeEach(async () => { await pool.query("TRUNCATE TABLE workspace RESTART IDENTITY CASCADE"); });
afterAll(async () => { await pool.end(); });

async function seed() {
  const workspaceId = (await pool.query<{ id: string }>("INSERT INTO workspace (name) VALUES ('preview') RETURNING id")).rows[0]!.id;
  const projectId = (await pool.query<{ id: string }>("INSERT INTO project (workspace_id, title) VALUES ($1, 'preview') RETURNING id", [workspaceId])).rows[0]!.id;
  const story = await chain.createStoryRevision({ workspaceId, projectId, content: { premise: "journey" }, createdBy: "author", expectedVersion: 1 });
  const storyReview = await chain.transitionReview({ table: "story_revision", workspaceId, revisionId: story.revisionId,
    expectedVersion: story.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW" });
  await chain.approveStory({ workspaceId, projectId, revisionId: story.revisionId, expectedVersion: storyReview.rowVersion,
    expectedReviewVersion: 2, reviewedBy: "editor" });
  const episodeId = (await pool.query<{ id: string }>("SELECT id FROM episode WHERE project_id = $1 AND episode_no = 1", [projectId])).rows[0]!.id;
  const script = await chain.createScriptRevision({ workspaceId, projectId, episodeId, sourceStoryRevisionId: story.revisionId,
    content: { text: TEXT }, createdBy: "author", expectedVersion: 1 });
  const scriptReview = await chain.transitionReview({ table: "script_revision", workspaceId, revisionId: script.revisionId,
    expectedVersion: script.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW" });
  await chain.approveScript({ workspaceId, episodeId, revisionId: script.revisionId, expectedVersion: scriptReview.rowVersion,
    expectedReviewVersion: 2, reviewedBy: "editor" });
  const client = await pool.connect();
  let character!: Awaited<ReturnType<TextChainService["createTextEntityRevisionInTransaction"]>>;
  try {
    await client.query("BEGIN");
    const version = (await client.query<{ version: number }>("SELECT version FROM project WHERE id = $1", [projectId])).rows[0]!.version;
    character = await chain.createTextEntityRevisionInTransaction(client, { kind: "character", workspaceId, projectId,
      name: "林夏", sourceScriptRevisionId: script.revisionId, content: { description: "traveler" }, createdBy: "author", expectedVersion: version });
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  return { workspaceId, projectId, episodeId, storyId: story.revisionId, script, character };
}

async function counts() {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM script_revision) AS scripts,
    (SELECT count(*)::int FROM scene_revision) AS scenes,
    (SELECT count(*)::int FROM shot_revision) AS shots,
    (SELECT count(*)::int FROM domain_event) AS events,
    (SELECT count(*)::int FROM idempotency_record) AS receipts,
    (SELECT count(*)::int FROM title_writing_run) AS runs,
    (SELECT count(*)::int FROM title_writing_call) AS calls`)).rows[0];
}

describe("ViMax preview source against isolated PostgreSQL", () => {
  it("preserves raw text/hash and current character identity, with no business writes on repeated reads", async () => {
    const graph = await seed();
    const before = await counts();
    const result = await source.read(graph.workspaceId, graph.projectId, graph.episodeId);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("source not ready");
    expect(result.source.scriptText).toBe(TEXT);
    expect(result.source.scriptContentHash).toBe(createHash("sha256").update(TEXT, "utf8").digest("hex"));
    expect(result.source.scriptContentHash).not.toBe(graph.script.contentHash);
    expect(result.source.characters).toEqual([{ key: "C1", characterId: graph.character.entityId,
      revisionId: graph.character.revisionId, name: "林夏" }]);
    expect(await source.read(graph.workspaceId, graph.projectId, graph.episodeId)).toEqual(result);
    expect(await counts()).toEqual(before);
  });

  it("rejects workspace, project and episode scope mismatches", async () => {
    const graph = await seed();
    const before = await counts();
    expect(await source.read(randomUUID(), graph.projectId, graph.episodeId)).toEqual({ kind: "not_found" });
    expect(await source.read(graph.workspaceId, randomUUID(), graph.episodeId)).toEqual({ kind: "not_found" });
    expect(await source.read(graph.workspaceId, graph.projectId, randomUUID())).toEqual({ kind: "not_found" });
    expect(await counts()).toEqual(before);
  });

  it("does not present an earlier approved script as the current unapproved replacement", async () => {
    const graph = await seed();
    const version = (await pool.query<{ row_version: number }>("SELECT row_version FROM episode WHERE id = $1", [graph.episodeId])).rows[0]!.row_version;
    await chain.createScriptRevision({ workspaceId: graph.workspaceId, projectId: graph.projectId, episodeId: graph.episodeId,
      sourceStoryRevisionId: graph.storyId, content: { text: `${TEXT}【动作】离开。` }, expectedVersion: version, createdBy: "author" });
    const before = await counts();
    expect(await source.read(graph.workspaceId, graph.projectId, graph.episodeId)).toEqual({ kind: "script_review_required" });
    expect(await counts()).toEqual(before);
  });

  it("reads one coherent snapshot when a new script commits between its source queries", async () => {
    const graph = await seed();
    const version = (await pool.query<{ row_version: number }>("SELECT row_version FROM episode WHERE id = $1", [graph.episodeId])).rows[0]!.row_version;
    let changed = false;
    const hooked = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            if (!changed && sql.includes("FROM project")) {
              changed = true;
              // The editor commits after the read-only transaction took its snapshot, without fixed delays.
              await chain.createScriptRevision({ workspaceId: graph.workspaceId, projectId: graph.projectId, episodeId: graph.episodeId,
                sourceStoryRevisionId: graph.storyId, content: { text: `${TEXT}【动作】离开。` }, expectedVersion: version, createdBy: "author" });
            }
            return result;
          },
          release: () => client.release(),
        };
      },
    } as unknown as DatabasePool;
    const result = await new VimaxPreviewSourceStore(hooked).read(graph.workspaceId, graph.projectId, graph.episodeId);
    expect(changed).toBe(true);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("source snapshot was not coherent");
    expect(result.source.scriptRevisionId).toBe(graph.script.revisionId);
    expect(result.source.scriptText).toBe(TEXT);
    expect(result.source.characters[0]!.revisionId).toBe(graph.character.revisionId);
    // A later request sees the replacement and refuses it. A preview snapshot is never a future write authorization.
    expect(await source.read(graph.workspaceId, graph.projectId, graph.episodeId)).toEqual({ kind: "script_review_required" });
  });

  it("does not silently omit a stale current character", async () => {
    const graph = await seed();
    await pool.query(`UPDATE character_revision SET freshness_status = 'STALE', stale_reason = 'PREVIEW_TEST',
      stale_from_ref = 'test:preview', review_version = review_version + 1 WHERE id = $1`, [graph.character.revisionId]);
    const before = await counts();
    expect(await source.read(graph.workspaceId, graph.projectId, graph.episodeId)).toEqual({ kind: "characters_unsupported" });
    expect(await counts()).toEqual(before);
  });

  it("rejects series projects without changing their script or media records", async () => {
    const graph = await seed();
    await pool.query("UPDATE project SET writing_mode = 'series', target_episode_seconds = 60 WHERE id = $1", [graph.projectId]);
    const before = await counts();
    expect(await source.read(graph.workspaceId, graph.projectId, graph.episodeId)).toEqual({ kind: "series_not_enabled" });
    expect(await counts()).toEqual(before);
  });
});
