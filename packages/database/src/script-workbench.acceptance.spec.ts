import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCRIPT_WORKBENCH_SCHEMA, estimateScriptWorkbench, type ScriptWorkbenchPlan, type ScriptWorkbenchScript } from "@ai-drama/contracts";
import { checkDisposableAcceptanceEnv, verifyDisposableAcceptanceDatabase } from "./disposable-acceptance-guard";
import { runMigrations } from "./migrations";
import { TextChainService } from "./text-chain";
import { ScriptWorkbenchStore, nextDocumentVersions } from "./script-workbench";
import { JobPersistenceService } from "./job-service";
import { requestHash } from "./runtime-store";

const pattern = /^ads_workbench_acceptance_[a-z0-9_]+$/;
if (process.env.SCRIPT_WORKBENCH_TEST_ALLOW_WRITES !== "true" || process.env.SCRIPT_WORKBENCH_TEST_ALLOW_DRAFT !== "true") {
  throw new Error("Workbench acceptance needs explicit disposable-write and draft flags");
}
const decision = checkDisposableAcceptanceEnv({ databaseName: process.env.SCRIPT_WORKBENCH_TEST_DATABASE_NAME,
  url: process.env.SCRIPT_WORKBENCH_TEST_DATABASE_URL, businessDatabaseUrl: process.env.DATABASE_URL, namePattern: pattern, nameHint: pattern.source });
if (!decision.ok) throw new Error(decision.reason);
const pool = new Pool({ connectionString: decision.url, max: 8, statement_timeout: 15000 });
const chain = new TextChainService(pool); const store = new ScriptWorkbenchStore(pool); const jobs = new JobPersistenceService(pool);
const plan = (): ScriptWorkbenchPlan => ({
  brief: { genre: "悬疑", audience: "悬疑爱好者", productionConstraints: "两人，一室", logline: "她只有七天找出真相", targetEpisodeSeconds: 60, dialogueQuota: 4 },
  bible: { ending: "真相公开", openThreads: "信件来源", characters: [{ id: "R01", name: "许青", appearance: "青衣", voice: "沉稳", aliases: "阿青", knownInformation: "见过信" }] },
  outline: { episodes: [1, 2].map(episodeNo => ({ episodeNo, title: `线索${episodeNo}`, openingHook: "门后传来声音", change: "发现证据", endingHandoff: "有人敲门" })) },
});
const script = (previousRevisionId: string | null = null): ScriptWorkbenchScript => ({
  title: "来客", previousRevisionId, previousHandoff: previousRevisionId ? "有人敲门" : "", openingHook: "门后传来声音", change: "发现证据", endingHandoff: "有人敲门",
  characterKnowledge: "R01 见过信", unresolvedThreads: "信件来源", scenes: [{ id: "s1", heading: "门口", interiorExterior: "INT", timeOfDay: "NIGHT", characterIds: ["R01"], beats: [
    { id: "a1", kind: "action", text: "她推开门", seconds: 2 }, { id: "d1", kind: "dialogue", characterId: "R01", text: "谁在那里？", seconds: 0 }, { id: "p1", kind: "pause", text: "", seconds: 1 },
  ] }], review: { identityClear: true, goalClear: true, obstacleClear: true, continuityChecked: true, lockedMaterialsChecked: true, note: "已核对" },
});
async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect(); try { await client.query("BEGIN"); const value = await fn(client); await client.query("COMMIT"); return value; }
  catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
async function currentVersion(table: "project" | "episode", id: string): Promise<number> {
  return Number((await pool.query(`SELECT ${table === "project" ? "version" : "row_version"} AS value FROM ${table} WHERE id=$1`, [id])).rows[0].value);
}
async function setup(approve = true) {
  const workspaceId: string = (await pool.query("INSERT INTO workspace(name) VALUES('synthetic workbench') RETURNING id")).rows[0].id;
  const projectId: string = (await pool.query("INSERT INTO project(workspace_id,title,episode_count,target_episode_seconds) VALUES($1,'合成验收',2,60) RETURNING id", [workspaceId])).rows[0].id;
  const story = await tx(client => store.savePlan(client, { workspaceId, projectId, plan: plan(), expectedVersion: 1, actorId: "qa", traceId: "qa" }));
  if (approve) {
    const submit = await chain.transitionReview({ table: "story_revision", workspaceId, revisionId: story.revisionId, expectedVersion: story.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW" });
    await chain.approveStory({ workspaceId, projectId, revisionId: story.revisionId, expectedVersion: submit.rowVersion, expectedReviewVersion: submit.reviewVersion, reviewedBy: "qa" });
  }
  const episodes = (await pool.query("SELECT id, episode_no FROM episode WHERE project_id=$1 ORDER BY episode_no", [projectId])).rows as { id: string; episode_no: number }[];
  return { workspaceId, projectId, storyId: story.revisionId, episodes };
}
type World = Awaited<ReturnType<typeof setup>>;
async function saveAtCurrent(w: World, index: number, content: ScriptWorkbenchScript) {
  const episodeId = w.episodes[index]!.id;
  const expectedVersion = await currentVersion("episode", episodeId);
  return tx(client => store.saveScript(client, { workspaceId: w.workspaceId, projectId: w.projectId, episodeId,
    sourceStoryRevisionId: w.storyId, script: content, expectedVersion, actorId: "qa", traceId: "qa" }));
}
async function approve(w: World, index: number, revisionId: string) {
  const episodeId = w.episodes[index]!.id;
  const submit = await chain.transitionReview({ table: "script_revision", workspaceId: w.workspaceId, revisionId,
    expectedVersion: await currentVersion("episode", episodeId), expectedReviewVersion: 1, to: "IN_REVIEW" });
  return chain.approveScript({ workspaceId: w.workspaceId, episodeId, revisionId, expectedVersion: submit.rowVersion, expectedReviewVersion: submit.reviewVersion, reviewedBy: "qa" });
}
beforeAll(async () => {
  const safe = await verifyDisposableAcceptanceDatabase(pool, decision.databaseName, pattern); if (!safe.ok) throw new Error(safe.reason);
  await runMigrations(pool);
  await pool.query(await readFile(resolve("prisma/drafts/20261111000300_script_workbench_trash.sql"), "utf8"));
});
afterAll(async () => pool.end());

describe("five-stage workbench uses the production text chain", () => {
  it("keeps separate document numbers and confirms an explicit immutable plan revision", async () => {
    const w = await setup(false); const first = await store.snapshot(w.workspaceId, w.projectId);
    expect(first.story?.reviewStatus).toBe("DRAFT"); expect(first.episodes).toHaveLength(0);
    expect(first.story?.content.workbench).toMatchObject({ schema: SCRIPT_WORKBENCH_SCHEMA, documentVersions: { brief: 1, synopsis: 1, bible: 1, outline: 1 } });
    const next = plan(); next.brief.logline = "另一个梗概";
    const changed = await tx(client => store.savePlan(client, { workspaceId: w.workspaceId, projectId: w.projectId, plan: next,
      expectedVersion: first.project.version, actorId: "qa", traceId: "qa" }));
    const second = await store.snapshot(w.workspaceId, w.projectId);
    expect(second.story?.content.workbench).toMatchObject({ documentVersions: { brief: 1, synopsis: 2, bible: 1, outline: 1 } });
    expect(second.storyHistory).toHaveLength(2); expect(second.storyHistory[1]?.content.workbench).toMatchObject({ plan: { brief: { logline: plan().brief.logline } } });
    await expect(chain.approveStory({ workspaceId: w.workspaceId, projectId: w.projectId, revisionId: w.storyId,
      expectedVersion: second.project.version, expectedReviewVersion: 1, reviewedBy: "qa" })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(changed.revisionNo).toBe(2);
  });
  it("guards plan completeness, workspace and compare-and-swap without losing the first revision", async () => {
    const w = await setup(false); const other = await setup();
    await expect(store.snapshot(other.workspaceId, w.projectId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(tx(client => store.savePlan(client, { workspaceId: w.workspaceId, projectId: w.projectId, plan: plan(), expectedVersion: 1, actorId: "qa", traceId: "qa" }))).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const incomplete = plan(); incomplete.bible.ending = "";
    const saved = await tx(client => store.savePlan(client, { workspaceId: w.workspaceId, projectId: w.projectId, plan: incomplete, expectedVersion: 2, actorId: "qa", traceId: "qa" }));
    const submit = await chain.transitionReview({ table: "story_revision", workspaceId: w.workspaceId, revisionId: saved.revisionId, expectedVersion: saved.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW" });
    await expect(chain.approveStory({ workspaceId: w.workspaceId, projectId: w.projectId, revisionId: saved.revisionId,
      expectedVersion: submit.rowVersion, expectedReviewVersion: submit.reviewVersion, reviewedBy: "qa" })).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
  });
  it("replays the same save without making duplicate revisions and rejects a reused key with changed content", async () => {
    const w = await setup(false); const input = { workspaceId: w.workspaceId, projectId: w.projectId, plan: plan(), expectedVersion: 2, actorId: "qa", traceId: "qa" };
    const scope = { workspaceId: w.workspaceId, actorId: "qa", httpMethod: "POST", routeKey: `/projects/${w.projectId}/script-workbench/plan`, key: "same-key", requestHash: requestHash(input) };
    const first = await jobs.runIdempotent(scope, 201, client => store.savePlan(client, input));
    const retry = await jobs.runIdempotent(scope, 201, client => store.savePlan(client, input));
    expect(retry.replayed).toBe(true); expect(retry.body).toEqual(first.body);
    await expect(jobs.runIdempotent({ ...scope, requestHash: requestHash({ ...input, plan: {} }) }, 201, client => store.savePlan(client, input))).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect((await store.snapshot(w.workspaceId, w.projectId)).storyHistory).toHaveLength(2);
  });
  it("requires the locked preceding episode and its exact handoff before episode two can be saved", async () => {
    const w = await setup(); const first = await saveAtCurrent(w, 0, script());
    await expect(saveAtCurrent(w, 1, script(first.revisionId))).rejects.toMatchObject({ code: "SOURCE_STALE" });
    await approve(w, 0, first.revisionId);
    const mismatch = script(first.revisionId); mismatch.previousHandoff = "她去了别处";
    await expect(saveAtCurrent(w, 1, mismatch)).rejects.toMatchObject({ code: "SOURCE_STALE" });
    const second = await saveAtCurrent(w, 1, script(first.revisionId)); await approve(w, 1, second.revisionId);
    const snapshot = await store.snapshot(w.workspaceId, w.projectId);
    expect(snapshot.episodes[1]?.script).toMatchObject({ id: second.revisionId, reviewStatus: "APPROVED", freshnessStatus: "CURRENT" });
  });
  it("counts action, speech and pauses and refuses over-budget or unchecked revisions at approval", async () => {
    const w = await setup(); const oversized = script(); oversized.scenes[0]!.beats[0]!.seconds = 60;
    expect(estimateScriptWorkbench(oversized).seconds).toBeGreaterThan(60);
    const revision = await saveAtCurrent(w, 0, oversized);
    await expect(approve(w, 0, revision.revisionId)).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
    const unchecked = script(); unchecked.review!.identityClear = false;
    const next = await saveAtCurrent(w, 0, unchecked);
    await expect(approve(w, 0, next.revisionId)).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
    const invalidRole = script(); invalidRole.scenes[0]!.beats[1]!.characterId = "R99";
    await expect(saveAtCurrent(w, 0, invalidRole)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
  it("invalidates downstream episodes and their approved scenes when the earlier locked script changes", async () => {
    const w = await setup(); const first = await saveAtCurrent(w, 0, script()); await approve(w, 0, first.revisionId);
    const second = await saveAtCurrent(w, 1, script(first.revisionId)); await approve(w, 1, second.revisionId);
    const episodeId = w.episodes[1]!.id;
    const scene = await tx(client => chain.createSceneRevisionInTransaction(client, { workspaceId: w.workspaceId, projectId: w.projectId, episodeId,
      sourceScriptRevisionId: second.revisionId, ordinal: 1, heading: "门口", timeOfDay: "夜", summary: "她开门", createdBy: "qa", expectedVersion: 4 }));
    const submitted = await tx(client => chain.reviewSceneShotInTransaction(client, { kind: "scene", workspaceId: w.workspaceId, projectId: w.projectId, episodeId,
      sceneId: scene.entityId, revisionId: scene.revisionId, expectedVersion: scene.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW", reviewedBy: "qa" }));
    await tx(client => chain.reviewSceneShotInTransaction(client, { kind: "scene", workspaceId: w.workspaceId, projectId: w.projectId, episodeId,
      sceneId: scene.entityId, revisionId: scene.revisionId, expectedVersion: submitted.rowVersion, expectedReviewVersion: submitted.reviewVersion, to: "APPROVED", reviewedBy: "qa" }));
    const changed = script(); changed.endingHandoff = "她打开信封";
    const newFirst = await saveAtCurrent(w, 0, changed);
    expect((await pool.query("SELECT freshness_status FROM script_revision WHERE id=$1", [second.revisionId])).rows[0].freshness_status).toBe("STALE");
    expect((await pool.query("SELECT freshness_status FROM scene_revision WHERE id=$1", [scene.revisionId])).rows[0].freshness_status).toBe("STALE");
    expect((await pool.query("SELECT count(*) AS n FROM stale_recalculation WHERE project_id=$1 AND status='PENDING'", [w.projectId])).rows[0].n).toBe("0");
    await approve(w, 0, newFirst.revisionId);
    const revisedSecond = script(newFirst.revisionId); revisedSecond.previousHandoff = changed.endingHandoff;
    await expect(saveAtCurrent(w, 1, revisedSecond)).resolves.toMatchObject({ revisionNo: 2 });
  });
  it("increments only the changed independently numbered planning document", () => {
    const first = plan(); const next = plan(); next.brief.dialogueQuota = 20;
    expect(nextDocumentVersions(first, next, { brief: 2, synopsis: 3, bible: 4, outline: 5 })).toEqual({ brief: 3, synopsis: 3, bible: 4, outline: 5 });
  });
});
