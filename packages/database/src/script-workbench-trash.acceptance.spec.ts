import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkDisposableAcceptanceEnv, verifyDisposableAcceptanceDatabase } from "./disposable-acceptance-guard";
import { runMigrations } from "./migrations";
import { RuntimeStore } from "./runtime-store";
import { TextChainService } from "./text-chain";
import { ProjectLibraryStore } from "./project-library";
import { ScriptWorkbenchStore } from "./script-workbench";
import { ScriptWorkbenchTrashStore } from "./script-workbench-trash";

const pattern = /^ads_trash_acceptance_[a-z0-9_]+$/;
if (process.env.SCRIPT_TRASH_TEST_ALLOW_WRITES !== "true" || process.env.SCRIPT_TRASH_TEST_ALLOW_DRAFT !== "true") {
  throw new Error("Script trash acceptance requires explicit disposable writes and draft flags");
}
const decision = checkDisposableAcceptanceEnv({ databaseName: process.env.SCRIPT_TRASH_TEST_DATABASE_NAME,
  url: process.env.SCRIPT_TRASH_TEST_DATABASE_URL, businessDatabaseUrl: process.env.DATABASE_URL,
  namePattern: pattern, nameHint: pattern.source });
if (!decision.ok) throw new Error(decision.reason);
const pool = new Pool({ connectionString: decision.url, max: 8, statement_timeout: 15000 });
const store = new ScriptWorkbenchTrashStore(pool);
const chain = new TextChainService(pool);
const runtime = new RuntimeStore(pool);
const library = new ProjectLibraryStore(pool);
const hash = "ab".repeat(32);
async function scalar(sql: string, params: unknown[] = []): Promise<string> {
  return String((await pool.query(sql, params)).rows[0].id);
}
async function version(table: "project" | "episode" | "scene", id: string): Promise<number> {
  return Number((await pool.query(`SELECT ${table === "project" ? "version" : "row_version"} AS value FROM ${table} WHERE id=$1`, [id])).rows[0].value);
}
async function tx<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect(); try { await client.query("BEGIN"); const result = await run(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
async function world(approved = false) {
  const workspaceId = await scalar("INSERT INTO workspace(name) VALUES('Synthetic trash acceptance') RETURNING id");
  const projectId = await scalar("INSERT INTO project(workspace_id,title) VALUES($1,'合成稿件') RETURNING id", [workspaceId]);
  const story = await chain.createStoryRevision({ workspaceId, projectId, content: { text: "合成大纲" }, createdBy: "qa", expectedVersion: 1 });
  const review = await chain.transitionReview({ table: "story_revision", workspaceId, revisionId: story.revisionId,
    expectedVersion: story.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW" });
  await chain.approveStory({ workspaceId, projectId, revisionId: story.revisionId, expectedVersion: review.rowVersion,
    expectedReviewVersion: review.reviewVersion, reviewedBy: "qa" });
  const episodeId = await scalar("SELECT id FROM episode WHERE project_id=$1 AND episode_no=1", [projectId]);
  const script = await chain.createScriptRevision({ workspaceId, projectId, episodeId, sourceStoryRevisionId: story.revisionId,
    content: { text: "第一场 内景 夜\n角色推开门。" }, createdBy: "qa", expectedVersion: await version("episode", episodeId) });
  if (approved) {
    const submitted = await chain.transitionReview({ table: "script_revision", workspaceId, revisionId: script.revisionId,
      expectedVersion: script.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW" });
    await chain.approveScript({ workspaceId, episodeId, revisionId: script.revisionId, expectedVersion: submitted.rowVersion,
      expectedReviewVersion: submitted.reviewVersion, reviewedBy: "qa" });
  }
  return { workspaceId, projectId, episodeId, revisionId: script.revisionId, storyId: story.revisionId };
}
let unavailableCode: string | null = null;
beforeAll(async () => {
  const safe = await verifyDisposableAcceptanceDatabase(pool, decision.databaseName, pattern);
  if (!safe.ok) throw new Error(safe.reason);
  await runMigrations(pool);
  const w = await world();
  try { await store.previewProject(w.workspaceId, w.projectId); } catch (error) { unavailableCode = (error as { code: string }).code; }
  await pool.query(await readFile(resolve("prisma/drafts/20261111000300_script_workbench_trash.sql"), "utf8"));
});
afterAll(async () => { await pool.end(); });

describe("script workbench reversible trash (isolated PostgreSQL)", () => {
  it("fails closed before the draft migration", () => { expect(unavailableCode).toBe("WORKBENCH_UNAVAILABLE"); });
  it("moves a draft out of history and pointers, restores immutable text as history without reopening production", async () => {
    const w = await world(); const before = await chain.listScriptRevisions(w.workspaceId, w.projectId, w.episodeId);
    const preview = await store.previewRevision(w.workspaceId, w.projectId, w.episodeId, w.revisionId);
    expect(preview).toMatchObject({ title: "合成稿件", episodeNo: 1, revisionNo: 1, reviewStatus: "DRAFT", canDelete: true });
    const removed = await store.trashRevision(w.workspaceId, w.projectId, w.episodeId, w.revisionId, { expectedVersion: preview.version, actorId: "qa" });
    expect((await chain.listScriptRevisions(w.workspaceId, w.projectId, w.episodeId)).items).toHaveLength(0);
    await expect(chain.requireScriptRevision(w.workspaceId, w.revisionId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await pool.query("SELECT current_script_revision_id,approved_script_revision_id FROM episode WHERE id=$1", [w.episodeId])).rows[0])
      .toEqual({ current_script_revision_id: null, approved_script_revision_id: null });
    const items = (await store.listTrash(w.workspaceId)).items;
    expect(items).toHaveLength(1); expect(items[0]).toMatchObject({ id: w.revisionId, episodeNo: 1, version: removed.rowVersion });
    const restored = await store.restoreRevision(w.workspaceId, w.projectId, w.episodeId, w.revisionId, { expectedVersion: removed.rowVersion });
    expect(restored.restoredAsHistory).toBe(true);
    const after = (await chain.listScriptRevisions(w.workspaceId, w.projectId, w.episodeId)).items[0]!;
    expect(after.content).toEqual(before.items[0]!.content); expect(after.contentHash).toEqual(before.items[0]!.contentHash);
    expect(after.freshnessStatus).toBe("STALE"); expect((await store.listTrash(w.workspaceId)).items).toHaveLength(0);
    await expect(chain.transitionReview({ table: "script_revision", workspaceId: w.workspaceId, revisionId: w.revisionId,
      expectedVersion: restored.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW" })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });
  it("resolves an approved current pointer outside 100 history rows and pages a restored old version without changing pointers", async () => {
    const w = await world(true);
    // Restored historical rows can be newer than the still-current locked revision.
    await pool.query(`INSERT INTO script_revision(workspace_id,project_id,episode_id,revision_no,source_story_revision_id,content_json,content_hash,created_by,freshness_status,stale_reason,stale_from_ref)
      SELECT workspace_id,project_id,episode_id,n,source_story_revision_id,content_json,content_hash,'qa','STALE','SCRIPT_TRASHED','script_revision:' || id::text
      FROM script_revision CROSS JOIN generate_series(2,102) AS n WHERE id=$1`, [w.revisionId]);
    const workbench = new ScriptWorkbenchStore(pool);
    const before = await workbench.snapshot(w.workspaceId, w.projectId);
    const episode = before.episodes.find(item => item.id === w.episodeId)!;
    expect(episode.history).toHaveLength(100);
    expect(episode.history.some(item => item.id === w.revisionId)).toBe(false);
    expect(episode.script).toMatchObject({ id: w.revisionId, reviewStatus: "APPROVED", freshnessStatus: "CURRENT" });
    expect((await chain.listScriptRevisions(w.workspaceId, w.projectId, w.episodeId, "3")).items.map(item => item.revisionNo)).toEqual([2,1]);
    const removed = await store.trashRevision(w.workspaceId, w.projectId, w.episodeId, w.revisionId, { expectedVersion: episode.rowVersion });
    expect((await chain.listScriptRevisions(w.workspaceId, w.projectId, w.episodeId, "3")).items.map(item => item.revisionNo)).toEqual([2]);
    await store.restoreRevision(w.workspaceId, w.projectId, w.episodeId, w.revisionId, { expectedVersion: removed.rowVersion });
    const after = (await workbench.snapshot(w.workspaceId, w.projectId)).episodes.find(item => item.id === w.episodeId)!;
    expect(after).toMatchObject({ currentScriptRevisionId: null, approvedScriptRevisionId: null, script: null });
    const page = await chain.listScriptRevisions(w.workspaceId, w.projectId, w.episodeId, "3");
    expect(page.items.find(item => item.id === w.revisionId)).toMatchObject({ freshnessStatus: "STALE" });
    expect(page.nextCursor).toBeNull();
    expect((await chain.listScriptRevisions(randomUUID(), w.projectId, w.episodeId, "3")).items).toEqual([]);
    expect((await chain.listScriptRevisions(w.workspaceId, randomUUID(), w.episodeId, "3")).items).toEqual([]);
  });
  it("enforces workspace scope and compare-and-swap, with only one winner under concurrent deletes", async () => {
    const w = await world(); const other = await world(); const expectedVersion = await version("episode", w.episodeId);
    await expect(store.previewRevision(other.workspaceId, w.projectId, w.episodeId, w.revisionId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(store.trashRevision(w.workspaceId, w.projectId, w.episodeId, w.revisionId, { expectedVersion: expectedVersion + 1 }))
      .rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const answers = await Promise.allSettled([1, 2].map(() => store.trashRevision(w.workspaceId, w.projectId, w.episodeId, w.revisionId, { expectedVersion })));
    expect(answers.filter((answer) => answer.status === "fulfilled")).toHaveLength(1);
    expect(answers.filter((answer) => answer.status === "rejected")).toHaveLength(1);
    expect((await pool.query("SELECT count(*) AS n FROM script_revision WHERE id=$1", [w.revisionId])).rows[0].n).toBe("1");
  });
  it("previews actual scene, shot, audio and transitive composite references and blocks locked-script deletion", async () => {
    const w = await world(true);
    const scene = await tx((client) => chain.createSceneRevisionInTransaction(client, { ...w, sourceScriptRevisionId: w.revisionId,
      ordinal: 1, heading: "门口", timeOfDay: "夜", summary: "人物开门", createdBy: "qa", expectedVersion: 4 }));
    const submit = await tx((client) => chain.reviewSceneShotInTransaction(client, { kind: "scene", ...w, sceneId: scene.entityId,
      revisionId: scene.revisionId, expectedVersion: scene.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW", reviewedBy: "qa" }));
    await tx((client) => chain.reviewSceneShotInTransaction(client, { kind: "scene", ...w, sceneId: scene.entityId,
      revisionId: scene.revisionId, expectedVersion: submit.rowVersion, expectedReviewVersion: submit.reviewVersion, to: "APPROVED", reviewedBy: "qa" }));
    const sceneVersion = await version("scene", scene.entityId);
    const shot = await tx((client) => chain.createShotScopedInTransaction(client, { workspaceId: w.workspaceId, projectId: w.projectId,
      sceneId: scene.entityId, sourceSceneRevisionId: scene.revisionId, ordinal: 1, shotType: "中景", camera: "固定", action: "人物开门",
      dialogue: "是谁？", promptText: "合成测试", createdBy: "qa", expectedVersion: sceneVersion }));
    const audio = await scalar(`INSERT INTO asset(workspace_id,project_id,kind,storage_provider,object_key,mime_type,byte_size,
      checksum_sha256,source_kind,source_shot_revision_id) VALUES($1,$2,'AUDIO','test',$3,'audio/wav',4,$4,'UPLOAD',$5) RETURNING id`,
    [w.workspaceId, w.projectId, randomUUID(), hash, shot.revisionId]);
    const video = await scalar(`INSERT INTO asset(workspace_id,project_id,kind,storage_provider,object_key,mime_type,byte_size,
      checksum_sha256,source_kind) VALUES($1,$2,'COMPOSITE','test',$3,'video/mp4',4,$4,'UPLOAD') RETURNING id`,
    [w.workspaceId, w.projectId, randomUUID(), hash]);
    await pool.query("INSERT INTO asset_dependency(workspace_id,project_id,dependent_asset_id,source_asset_id) VALUES($1,$2,$3,$4)", [w.workspaceId, w.projectId, video, audio]);
    const preview = await store.previewRevision(w.workspaceId, w.projectId, w.episodeId, w.revisionId);
    expect(preview).toMatchObject({ reviewStatus: "APPROVED", canDelete: false, dependencies: { scenes: 1, shots: 1, speech: 1, video: 1, total: 4 } });
    expect(preview.references.map((ref) => ref.id)).toEqual(expect.arrayContaining([scene.revisionId, shot.revisionId, audio, video]));
    await expect(store.trashRevision(w.workspaceId, w.projectId, w.episodeId, w.revisionId, { expectedVersion: preview.version })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect((await chain.listScriptRevisions(w.workspaceId, w.projectId, w.episodeId)).items[0]?.freshnessStatus).toBe("CURRENT");
  });
  it("protects later episodes' continuity references", async () => {
    const w = await world(true); const episode2 = await scalar("SELECT id FROM episode WHERE project_id=$1 AND episode_no=2", [w.projectId]);
    await pool.query(`INSERT INTO script_revision(workspace_id,project_id,episode_id,revision_no,source_story_revision_id,content_json,content_hash,created_by)
      VALUES($1,$2,$3,1,$4,$5::jsonb,$6,'qa')`, [w.workspaceId,w.projectId,episode2,w.storyId,
      JSON.stringify({ workbench: { schema: "script-workbench.v1", script: { previousRevisionId: w.revisionId } } }),hash]);
    expect(await store.previewRevision(w.workspaceId,w.projectId,w.episodeId,w.revisionId)).toMatchObject({ canDelete:false,dependencies:{other:1,total:1} });
  });
  it("archives projects from both library/list APIs, preserves nested drafts, and restores without starting any work", async () => {
    const w = await world(); const preview = await store.previewProject(w.workspaceId,w.projectId);
    expect(preview).toMatchObject({ canDelete:true,episodeCount:3 });
    const removed = await store.trashProject(w.workspaceId,w.projectId,{expectedVersion:preview.version});
    expect((await library.list(w.workspaceId)).items).toHaveLength(0);
    expect((await runtime.listProjects(w.workspaceId,20)).items).toHaveLength(0);
    await expect(runtime.getProject(w.workspaceId,w.projectId)).rejects.toMatchObject({code:"NOT_FOUND"});
    await expect(chain.requireEpisode(w.workspaceId,undefined,w.episodeId)).rejects.toMatchObject({code:"NOT_FOUND"});
    await expect(chain.requireScriptRevision(w.workspaceId,w.revisionId)).rejects.toMatchObject({code:"NOT_FOUND"});
    expect((await chain.listEpisodes(w.workspaceId,w.projectId))).toHaveLength(0);
    expect((await chain.listScriptRevisions(w.workspaceId,w.projectId,w.episodeId)).items).toHaveLength(0);
    expect((await store.listTrash(w.workspaceId)).items).toMatchObject([{kind:"project",id:w.projectId,version:removed.version}]);
    await expect(pool.query("INSERT INTO workflow_run(workspace_id,project_id,type,requested_by,input_snapshot) VALUES($1,$2,'MOCK','qa','{}')",[w.workspaceId,w.projectId]))
      .rejects.toMatchObject({code:"23514"});
    await store.restoreProject(w.workspaceId,w.projectId,{expectedVersion:removed.version});
    expect((await library.list(w.workspaceId)).items).toHaveLength(1);
    expect((await chain.listScriptRevisions(w.workspaceId,w.projectId,w.episodeId)).items).toHaveLength(1);
    expect((await pool.query("SELECT count(*) AS n FROM workflow_run WHERE project_id=$1",[w.projectId])).rows[0].n).toBe("0");
  });
  it("refuses project archive with active work and bounds/validates trash pagination", async () => {
    const w=await world(); await pool.query("INSERT INTO workflow_run(workspace_id,project_id,type,requested_by,input_snapshot) VALUES($1,$2,'MOCK','qa','{}')",[w.workspaceId,w.projectId]);
    const preview=await store.previewProject(w.workspaceId,w.projectId); expect(preview.canDelete).toBe(false);
    await expect(store.trashProject(w.workspaceId,w.projectId,{expectedVersion:preview.version})).rejects.toMatchObject({code:"REVISION_CONFLICT"});
    await expect(store.listTrash(w.workspaceId,"invalid")).rejects.toMatchObject({code:"VALIDATION_ERROR"});
    const ids:string[]=[];
    for(let i=0;i<52;i++) ids.push(await scalar("INSERT INTO project(workspace_id,title,status,archived_at) VALUES($1,'回收站分页','ARCHIVED','2026-11-11T00:00:00.123456Z') RETURNING id",[w.workspaceId]));
    const first=await store.listTrash(w.workspaceId); const next=await store.listTrash(w.workspaceId,first.nextCursor!);
    expect(first.items).toHaveLength(50); expect(next.items).toHaveLength(2); expect(next.nextCursor).toBeNull();
    expect(new Set([...first.items,...next.items].map((item)=>item.id)).size).toBe(52);
  });
  it("serializes archive against a concurrent new workflow, rechecking active work under the project lock", async () => {
    const w = await world();
    const expectedVersion = await version("project", w.projectId);
    const creator = await pool.connect();
    try {
      await creator.query("BEGIN");
      await creator.query("SELECT id FROM project WHERE id=$1 AND workspace_id=$2 FOR UPDATE", [w.projectId, w.workspaceId]);
      const archived = store.trashProject(w.workspaceId, w.projectId, { expectedVersion });
      await creator.query("INSERT INTO workflow_run(workspace_id,project_id,type,requested_by,input_snapshot) VALUES($1,$2,'MOCK','qa','{}')", [w.workspaceId,w.projectId]);
      await creator.query("COMMIT");
      await expect(archived).rejects.toMatchObject({ code:"REVISION_CONFLICT" });
      expect((await runtime.getProject(w.workspaceId,w.projectId)).status).toBe("ACTIVE");
    } catch (error) { await creator.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { creator.release(); }
  });
});
