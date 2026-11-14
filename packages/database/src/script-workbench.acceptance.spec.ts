import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTO_CREATION_EPISODE_SCHEMA, SCRIPT_WORKBENCH_SCHEMA, SHORT_SEQUEL_AI_SCHEMA, canBindShortSequelFirstPlan, estimateScriptWorkbench,
  type AutoBible, type AutoEpisode, type ScriptWorkbenchPlan, type ScriptWorkbenchScript, type ShortSequelAiAttempt } from "@ai-drama/contracts";
import { checkDisposableAcceptanceEnv, verifyDisposableAcceptanceDatabase } from "./disposable-acceptance-guard";
import { runMigrations } from "./migrations";
import { TextChainService } from "./text-chain";
import { ScriptWorkbenchStore, nextDocumentVersions } from "./script-workbench";
import { JobPersistenceService } from "./job-service";
import { requestHash } from "./runtime-store";
import { ShortSequelStore, shortSequelAiDraftExpired, shortSequelAiMaterials, shortSequelAiStale } from "./short-sequel";
import { PostgresAutoCreationStore } from "./auto-creation-store";
import { canonicalInputHash, formatAutoEpisode, workbenchScriptText } from "@ai-drama/domain";
import { PostgresWritingCandidateStore } from "./writing-candidate-store";
import { registerShortSequelLineageAcceptance } from "./short-sequel-lineage.acceptance.spec";

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
registerShortSequelLineageAcceptance(pool);

async function seedSequelProject() {
    const workspaceId = (await pool.query<{ id: string }>("INSERT INTO workspace(name) VALUES('sequel acceptance') RETURNING id")).rows[0]!.id;
    const projectId = (await pool.query<{ id: string }>(
      "INSERT INTO project(workspace_id,title,episode_count,target_episode_seconds) VALUES($1,'单集原作',1,60) RETURNING id", [workspaceId])).rows[0]!.id;
    const originalStory = await chain.createStoryRevision({ workspaceId, projectId, expectedVersion: 1, content: { text: "本剧共 1 集" }, createdBy: "qa" });
    await chain.transitionReview({ table: "story_revision", workspaceId, revisionId: originalStory.revisionId,
      expectedVersion: originalStory.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW" });
    const frozen = { episodeCount: 1, episodeSeconds: 60, constraints: {}, providerKey: "openai", model: "fixture-model" };
    const hash = "a".repeat(64);
    const runId = (await pool.query<{ id: string }>(`INSERT INTO auto_creation_run (id,workspace_id,project_id,actor_id,idempotency_key,input_hash,input_json,
        provider_key,model,state,call_cap,quality,story_save,story_revision_id,created_at,updated_at)
      VALUES(gen_random_uuid(),$1,$2,'qa','original',$3,$4,'openai','fixture-model','completed',1,'passed','saved',$5,now(),now()) RETURNING id`,
    [workspaceId, projectId, hash, JSON.stringify(frozen), originalStory.revisionId])).rows[0]!.id;
    const first: AutoEpisode = { schema: AUTO_CREATION_EPISODE_SCHEMA, episodeNo: 1, title: "线索", scenes: [], handoffFacts: ["有人敲门"] };
    const bible = { characters: [], locations: [] } as unknown as AutoBible;
    for (const [ordinal, [key, output]] of [["research", {}], ["directions", {}], ["bible", bible], ["outline", {}], ["episode:1", first], ["review:1", {}]].entries()) {
      await pool.query(`INSERT INTO auto_creation_stage (run_id,workspace_id,stage_key,ordinal,state,output_json,output_hash,script_save,updated_at)
        VALUES($1,$2,$3,$4,'completed',$5,$6,$7,now())`, [runId, workspaceId, key, ordinal, JSON.stringify(output), hash, key === "episode:1" ? "pending" : null]);
    }
    return { workspaceId, projectId, originalStory, frozen, hash, runId, first, bible };
}

describe("five-stage workbench uses the production text chain", () => {
  it("atomically expands an auto project and guards the sequel with the confirmed plan and locked predecessor", async () => {
    const { workspaceId, projectId, originalStory, frozen, hash, runId, first, bible } = await seedSequelProject();
    const sequel = new ShortSequelStore(pool);
    const auto = new PostgresAutoCreationStore(pool, chain);
    expect(await sequel.list(workspaceId, projectId)).toMatchObject({ episodeCount: 1, nextEpisodeNo: 2, continuations: [] });
    await expect(sequel.context(workspaceId, projectId, 2)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(sequel.confirm(workspaceId, projectId, 3, "qa")).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    // Fail the last SQL statement to prove the existing episode and project writes are both rolled back.
    await expect(sequel.confirm(workspaceId, projectId, 2, "invalid\u0000trace")).rejects.toMatchObject({ code: "22021" });
    expect(await sequel.list(workspaceId, projectId)).toMatchObject({ episodeCount: 1, nextEpisodeNo: 2, continuations: [] });
    expect(await currentVersion("project", projectId)).toBe(originalStory.rowVersion + 1);
    expect((await store.snapshot(workspaceId, projectId)).episodes).toEqual([]);
    const [added, retry] = await Promise.all([1, 2].map(() => sequel.confirm(workspaceId, projectId, 2, "qa")));
    expect(added).toEqual(retry);
    expect(await sequel.list(workspaceId, projectId)).toMatchObject({ episodeCount: 2, nextEpisodeNo: 3, continuations: [
      { episodeNo: 2, episodeId: added!.episodeId },
    ] });
    expect((await pool.query("SELECT input_json,input_hash FROM auto_creation_run WHERE id=$1", [runId])).rows[0]).toEqual({ input_json: frozen, input_hash: hash });
    const beforeApproval = await sequel.context(workspaceId, projectId, 2);
    expect(beforeApproval).toMatchObject({ storyConfirmed: false, previousLocked: false, previousRevisionId: null,
      originalRunId: runId, originalEpisodeHash: hash, previousScript: { text: formatAutoEpisode(first, bible) } });
    const confirmPlan = async (next: ScriptWorkbenchPlan) => {
      const expectedVersion = await currentVersion("project", projectId);
      const saved = await tx(client => store.savePlan(client, { workspaceId, projectId, plan: next, expectedVersion, actorId: "qa", traceId: "qa" }));
      const submit = await chain.transitionReview({ table: "story_revision", workspaceId, revisionId: saved.revisionId,
        expectedVersion: saved.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW" });
      return { saved, submit };
    };
    const { saved, submit } = await confirmPlan(plan());
    const saveSecond = async (storyId: string, previousRevisionId: string | null = null, previousHandoff = "有人敲门") => {
      const content = script(previousRevisionId);
      content.previousHandoff = previousHandoff;
      const expectedVersion = await currentVersion("episode", added!.episodeId);
      const context = await sequel.context(workspaceId, projectId, 2);
      return tx(client => store.saveScript(client, { workspaceId, projectId, episodeId: added!.episodeId, script: content,
        sourceStoryRevisionId: storyId, expectedVersion, actorId: "qa", traceId: "qa", continuation: {
          previousRevisionId, originalRunId: previousRevisionId ? null : runId, originalEpisodeHash: previousRevisionId ? null : hash,
          episodeCount: context.episodeCount, planConfirmation: context.planConfirmation,
        } }));
    };
    await expect(saveSecond(saved.revisionId)).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
    await chain.approveStory({ workspaceId, projectId, revisionId: saved.revisionId, expectedVersion: submit.rowVersion,
      expectedReviewVersion: submit.reviewVersion, reviewedBy: "qa" });

    const candidates = new PostgresWritingCandidateStore(pool);
    const context = await sequel.context(workspaceId, projectId, 2);
    const source = { storyRevisionId: context.storyRevisionId, previousRevisionId: context.previousRevisionId,
      originalRunId: context.originalRunId, originalEpisodeHash: context.originalEpisodeHash,
      planConfirmation: context.planConfirmation, lockedPreviousRevisionId: context.lockedPreviousRevisionId, lockedOriginal: context.lockedOriginal };
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const leaseUntil = new Date(now + 60_000).toISOString();
    const makeAttempt = (): ShortSequelAiAttempt => ({ id: randomUUID(), workspaceId, projectId, actorId: "qa",
      idempotencyKey: randomUUID(), requestHash: hash, state: "reserved", errorCode: null, executorId: "qa", leaseUntil,
      script: null, usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null }, createdAt: nowIso, finishedAt: null,
      input: { schema: SHORT_SEQUEL_AI_SCHEMA, taskId: randomUUID(), episodeId: context.episodeId, episodeNo: 2, episodeCount: 2,
        targetEpisodeSeconds: 60, direction: "写新线索", source, contextHash: canonicalInputHash(shortSequelAiMaterials(context, source)),
        providerKey: "openai", model: "fixture-model" },
    });
    const limits = { nowIso, sinceIso: new Date(now - 86_400_000).toISOString(), maxCallsPerDay: 20, maxActiveRuns: 3,
      expectedAttemptId: null, confirmUncertainAttemptId: null };
    const inFlight = makeAttempt();
    expect(await candidates.createShortSequel(inFlight, limits)).toMatchObject({ kind: "created" });
    expect(await candidates.markShortSequelSubmitted(inFlight, "qa", nowIso, leaseUntil)).toBe(true);
    expect(await candidates.finishShortSequel(workspaceId, inFlight.id, "qa", { state: "unknown", errorCode: "executor_lost",
      providerRequestId: null, responseModel: null, usage: inFlight.usage, candidate: null }, nowIso)).toBe(true);
    const resumed = { ...makeAttempt(), input: inFlight.input };
    const resumeLimits = { ...limits, expectedAttemptId: inFlight.id };
    expect(await candidates.createShortSequel(resumed, resumeLimits)).toEqual({ kind: "needs_confirmation" });
    expect(await candidates.createShortSequel(resumed, { ...resumeLimits, confirmUncertainAttemptId: inFlight.id }))
      .toMatchObject({ kind: "created", attempt: { input: inFlight.input } });
    expect(await candidates.markShortSequelSubmitted(resumed, "qa", nowIso, leaseUntil)).toBe(true);
    const submitScript = (revisionId: string, expectedVersion: number) => chain.transitionReview({ table: "script_revision", workspaceId,
      revisionId, expectedVersion, expectedReviewVersion: 1, to: "IN_REVIEW" });
    await expect(saveSecond(saved.revisionId)).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
    const originalText = formatAutoEpisode(first, bible);
    expect(await auto.placeScripts(workspaceId, projectId, runId, [{ episodeNo: 1, stageKey: "episode:1", text: originalText }],
      { acceptStoryChanged: true }, "qa", new Date().toISOString())).toMatchObject({ kind: "ok" });
    const firstEpisode = (await store.snapshot(workspaceId, projectId)).episodes[0]!;
    expect(firstEpisode.script?.content).toEqual({ text: originalText });
    const lock = async (revisionId: string, rowVersion: number) => {
      const review = await submitScript(revisionId, rowVersion);
      await chain.approveScript({ workspaceId, episodeId: firstEpisode.id, revisionId, expectedVersion: review.rowVersion,
        expectedReviewVersion: review.reviewVersion, reviewedBy: "qa" });
    };
    await expect(saveSecond(saved.revisionId)).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
    await lock(firstEpisode.script!.id, firstEpisode.rowVersion);
    expect(await sequel.context(workspaceId, projectId, 2)).toMatchObject({ previousLocked: true, placedOriginal: { runId, episodeHash: hash } });
    await expect(saveSecond(saved.revisionId, null, "门外没有任何声音")).rejects.toMatchObject({ code: "SOURCE_STALE" });
    await expect(saveSecond(saved.revisionId, firstEpisode.script!.id, "")).rejects.toMatchObject({ code: "SOURCE_STALE" });
    const exactHandoffScript = { ...script(), previousHandoff: "有人敲门" };
    await expect(chain.createScriptRevision({ workspaceId, projectId, episodeId: added!.episodeId, sourceStoryRevisionId: saved.revisionId,
      expectedVersion: await currentVersion("episode", added!.episodeId), createdBy: "qa",
      content: { text: "本剧共 1 集。", workbench: { schema: SCRIPT_WORKBENCH_SCHEMA, script: exactHandoffScript, sourceStoryRevisionId: saved.revisionId,
        continuation: { previousRevisionId: null, originalRunId: runId, originalEpisodeHash: hash, episodeCount: 2, planConfirmation: 1 } } },
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const badStoredScript = { ...script(), previousHandoff: "门外没有任何声音" };
    // Seed a historical bad body created before the continuation guard, without changing the valid predecessor.
    const legacyContent = { text: workbenchScriptText(badStoredScript, plan().bible.characters), workbench: {
      schema: SCRIPT_WORKBENCH_SCHEMA, script: badStoredScript, sourceStoryRevisionId: saved.revisionId,
      continuation: { previousRevisionId: null, originalRunId: runId, originalEpisodeHash: hash },
    } };
    const legacy = (await pool.query<{ id: string }>(
      `INSERT INTO script_revision(workspace_id,project_id,episode_id,revision_no,source_story_revision_id,content_json,content_hash,created_by)
       VALUES($1,$2,$3,1,$4,$5,$6,'historical fixture') RETURNING id`,
      [workspaceId, projectId, added!.episodeId, saved.revisionId, legacyContent, canonicalInputHash(legacyContent)])).rows[0]!;
    await pool.query("UPDATE episode SET current_script_revision_id=$2 WHERE id=$1", [added!.episodeId, legacy.id]);
    await expect(submitScript(legacy.id, await currentVersion("episode", added!.episodeId))).rejects.toMatchObject({ code: "SOURCE_STALE" });
    await pool.query("UPDATE script_revision SET review_status='IN_REVIEW' WHERE id=$1", [legacy.id]);
    await expect(chain.approveScript({ workspaceId, episodeId: added!.episodeId, revisionId: legacy.id,
      expectedVersion: await currentVersion("episode", added!.episodeId), expectedReviewVersion: 1, reviewedBy: "qa" }))
      .rejects.toMatchObject({ code: "SOURCE_STALE" });
    await pool.query("UPDATE episode SET current_script_revision_id=NULL WHERE id=$1", [added!.episodeId]);
    const draft = await saveSecond(saved.revisionId);
    const bodyBeforeAiCompletes = (await store.snapshot(workspaceId, projectId)).episodes.find(episode => episode.id === context.episodeId);
    expect(await candidates.createShortSequel(makeAttempt(), limits)).toEqual({ kind: "body_exists" });
    expect(await candidates.finishShortSequel(workspaceId, resumed.id, "qa", { state: "completed", errorCode: null,
      providerRequestId: null, responseModel: null, usage: resumed.usage, candidate: { ...script(), title: "AI 候选稿" } }, nowIso)).toBe(true);
    expect(await candidates.listShortSequels(workspaceId, projectId, context.episodeId)).toMatchObject({ attempts: [
      { id: resumed.id, input: { taskId: inFlight.input.taskId }, script: { title: "AI 候选稿" } },
    ] });
    expect((await store.snapshot(workspaceId, projectId)).episodes.find(episode => episode.id === context.episodeId)).toEqual(bodyBeforeAiCompletes);
    const reviewSecond = await submitScript(draft.revisionId, draft.rowVersion);
    const changedFirst = await chain.createScriptRevision({ workspaceId, projectId, episodeId: firstEpisode.id, sourceStoryRevisionId: saved.revisionId,
      expectedVersion: await currentVersion("episode", firstEpisode.id), createdBy: "qa", content: { text: "原集修订" } });
    await lock(changedFirst.revisionId, changedFirst.rowVersion);
    await expect(saveSecond(saved.revisionId)).rejects.toMatchObject({ code: "SOURCE_STALE" });
    await expect(chain.approveScript({ workspaceId, episodeId: added!.episodeId, revisionId: draft.revisionId, expectedVersion: reviewSecond.rowVersion,
      expectedReviewVersion: reviewSecond.reviewVersion, reviewedBy: "qa" })).rejects.toMatchObject({ code: "SOURCE_STALE" });
    const newDraft = await saveSecond(saved.revisionId, changedFirst.revisionId);
    const updatedPlan = plan(); updatedPlan.outline.episodes[1]!.change = "线索出现新的意义";
    const nextPlan = await confirmPlan(updatedPlan);
    await chain.approveStory({ workspaceId, projectId, revisionId: nextPlan.saved.revisionId, expectedVersion: nextPlan.submit.rowVersion,
      expectedReviewVersion: nextPlan.submit.reviewVersion, reviewedBy: "qa" });
    await expect(saveSecond(saved.revisionId, changedFirst.revisionId)).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
    const snapshot = await store.snapshot(workspaceId, projectId);
    expect(snapshot.episodes[0]?.script).toMatchObject({ id: changedFirst.revisionId, reviewStatus: "APPROVED", freshnessStatus: "CURRENT" });
    expect(snapshot.episodes[1]).toMatchObject({ isContinuation: true, script: { id: newDraft.revisionId, freshnessStatus: "STALE" } });
    expect(snapshot.episodes[0]?.history.find(revision => revision.id === firstEpisode.script!.id)?.content).toEqual({ text: originalText });
    const finalSecond = await saveSecond(nextPlan.saved.revisionId, changedFirst.revisionId);
    const reviewFinalSecond = await submitScript(finalSecond.revisionId, finalSecond.rowVersion);
    await chain.approveScript({ workspaceId, episodeId: added!.episodeId, revisionId: finalSecond.revisionId,
      expectedVersion: reviewFinalSecond.rowVersion, expectedReviewVersion: reviewFinalSecond.reviewVersion, reviewedBy: "qa" });
    const third = await sequel.confirm(workspaceId, projectId, 3, "qa");
    expect(await sequel.context(workspaceId, projectId, 2)).toMatchObject({ episodeCount: 3, storyConfirmed: false,
      confirmedStoryRevisionId: null, lastConfirmedStoryRevisionId: nextPlan.saved.revisionId });
    const expandedPlan = structuredClone(updatedPlan);
    expandedPlan.outline.episodes.push({ ...expandedPlan.outline.episodes[1]!, episodeNo: 3 });
    const thirdPlan = await confirmPlan(expandedPlan);
    await chain.approveStory({ workspaceId, projectId, revisionId: thirdPlan.saved.revisionId, expectedVersion: thirdPlan.submit.rowVersion,
      expectedReviewVersion: thirdPlan.submit.reviewVersion, reviewedBy: "qa" });
    expect(await sequel.context(workspaceId, projectId, 3)).toMatchObject({ storyConfirmed: true, previousLocked: true, previousRevisionId: finalSecond.revisionId });
    expect(await sequel.context(workspaceId, projectId, 2)).toMatchObject({ lastConfirmedStoryRevisionId: thirdPlan.saved.revisionId });
    const saveThird = async () => tx(async client => {
      const current = await sequel.context(workspaceId, projectId, 3);
      return store.saveScript(client, { workspaceId, projectId, episodeId: third.episodeId, sourceStoryRevisionId: thirdPlan.saved.revisionId,
        expectedVersion: await currentVersion("episode", third.episodeId), actorId: "qa", traceId: "qa", script: script(finalSecond.revisionId),
        continuation: { previousRevisionId: finalSecond.revisionId, originalRunId: null, originalEpisodeHash: null,
          episodeCount: 3, planConfirmation: current.planConfirmation } });
    });
    const beforeThird = await sequel.context(workspaceId, projectId, 3);
    const thirdSource = { ...source, storyRevisionId: beforeThird.storyRevisionId, planConfirmation: beforeThird.planConfirmation,
      previousRevisionId: finalSecond.revisionId, originalRunId: null, originalEpisodeHash: null, lockedPreviousRevisionId: finalSecond.revisionId };
    const thirdAttempt = { ...makeAttempt(), input: { ...inFlight.input, taskId: randomUUID(), episodeId: third.episodeId, episodeNo: 3,
      episodeCount: 3, source: thirdSource, contextHash: canonicalInputHash(shortSequelAiMaterials(beforeThird, thirdSource)) } };
    expect(await candidates.createShortSequel(thirdAttempt, limits)).toMatchObject({ kind: "created" });
    const savedThird = await saveThird();
    const revisedAgain = await chain.createScriptRevision({ workspaceId, projectId, episodeId: firstEpisode.id,
      sourceStoryRevisionId: thirdPlan.saved.revisionId, expectedVersion: await currentVersion("episode", firstEpisode.id),
      createdBy: "qa", content: { text: "修订：交接改为钟声响起" } });
    await lock(revisedAgain.revisionId, revisedAgain.rowVersion);
    const afterRelock = await sequel.context(workspaceId, projectId, 3);
    expect(afterRelock).toMatchObject({ previousRevisionId: finalSecond.revisionId, previousFreshnessStatus: "STALE", previousLocked: false });
    expect(shortSequelAiDraftExpired(thirdAttempt.input, afterRelock)).toBe(true);
    expect(shortSequelAiStale(thirdAttempt.input, afterRelock)).toBe(true);
    await expect(saveThird()).rejects.toMatchObject({ code: "SOURCE_STALE" });
    expect((await store.snapshot(workspaceId, projectId)).episodes[2]?.script).toMatchObject({ id: savedThird.revisionId, freshnessStatus: "STALE" });
    expect(await candidates.markShortSequelSubmitted(thirdAttempt, "qa", nowIso, leaseUntil)).toBe(false);
    expect(await sequel.confirm(workspaceId, projectId, 2, "qa")).toMatchObject({ episodeId: added!.episodeId, episodeCount: 3 });
    await expect(sequel.confirm(workspaceId, projectId, 5, "qa")).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const fourth = await sequel.confirm(workspaceId, projectId, 4, "qa");
    expect(fourth.episodeCount).toBe(4);
    const emptyFourth = await sequel.context(workspaceId, projectId, 4);
    const fourthSource = { ...thirdSource, storyRevisionId: emptyFourth.storyRevisionId, previousRevisionId: savedThird.revisionId,
      planConfirmation: emptyFourth.planConfirmation, lockedPreviousRevisionId: emptyFourth.lockedPreviousRevisionId };
    expect(emptyFourth).toMatchObject({ hasBody: false, previousRevisionId: savedThird.revisionId, previousFreshnessStatus: "STALE" });
    expect(await candidates.createShortSequel({ ...makeAttempt(), input: { ...thirdAttempt.input, taskId: randomUUID(),
      episodeId: fourth.episodeId, episodeNo: 4, episodeCount: 4, source: fourthSource,
      contextHash: canonicalInputHash(shortSequelAiMaterials(emptyFourth, fourthSource)) } }, limits)).toEqual({ kind: "source_changed" });
    for (const episodeNo of [5, 6]) {
      expect(await sequel.confirm(workspaceId, projectId, episodeNo, "qa")).toMatchObject({ episodeNo, episodeCount: episodeNo });
    }
    await expect(sequel.confirm(workspaceId, projectId, 7, "qa")).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(await sequel.list(workspaceId, projectId)).toMatchObject({ episodeCount: 6, nextEpisodeNo: null });
    expect((await store.snapshot(workspaceId, projectId)).episodes.map(episode => episode.episodeNo)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("keeps pending drafts through unconfirmed plan and predecessor edits, and rejects binding a two-episode AI draft to a confirmed three-episode plan", async () => {
    const { workspaceId, projectId, hash } = await seedSequelProject();
    const sequel = new ShortSequelStore(pool);
    const candidates = new PostgresWritingCandidateStore(pool);
    const second = await sequel.confirm(workspaceId, projectId, 2, "qa");
    const stage = await sequel.context(workspaceId, projectId, 2);
    const frozenInput = (context: typeof stage): ShortSequelAiAttempt["input"] => {
      const source = { storyRevisionId: context.storyRevisionId, previousRevisionId: context.previousRevisionId,
        originalRunId: context.originalRunId, originalEpisodeHash: context.originalEpisodeHash,
        planConfirmation: context.planConfirmation, confirmedEpisodeCountAtCapture: context.lastConfirmedEpisodeCount,
        lockedPreviousRevisionId: context.lockedPreviousRevisionId, lockedOriginal: context.lockedOriginal };
      return { schema: SHORT_SEQUEL_AI_SCHEMA, taskId: randomUUID(), episodeId: second.episodeId, episodeNo: 2, episodeCount: context.episodeCount,
        targetEpisodeSeconds: 60, direction: "追查信件", providerKey: "openai", model: "mock",
        source, contextHash: canonicalInputHash(shortSequelAiMaterials(context, source)) };
    };
    const inputBeforePlan = frozenInput(stage);
    const now = new Date();
    const later = new Date(now.getTime() + 60_000).toISOString();
    const oldAi: ShortSequelAiAttempt = { id: randomUUID(), workspaceId, projectId, actorId: "qa", idempotencyKey: randomUUID(), requestHash: hash,
      input: inputBeforePlan, state: "reserved", errorCode: null, executorId: "qa", leaseUntil: later, script: null,
      usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null }, createdAt: now.toISOString(), finishedAt: null };
    expect(await candidates.createShortSequel(oldAi, { nowIso: now.toISOString(), sinceIso: now.toISOString(),
      maxCallsPerDay: 20, maxActiveRuns: 3, expectedAttemptId: null, confirmUncertainAttemptId: null })).toMatchObject({ kind: "created" });
    expect(await candidates.markShortSequelSubmitted(oldAi, "qa", now.toISOString(), later)).toBe(true);
    const body = { ...script(), previousHandoff: "有人敲门" };
    await candidates.finishShortSequel(workspaceId, oldAi.id, "qa", { state: "completed", candidate: body,
      errorCode: null, providerRequestId: null, responseModel: null, usage: oldAi.usage }, now.toISOString());

    const savePlan = async (next: ScriptWorkbenchPlan) => {
      const expectedVersion = await currentVersion("project", projectId);
      return tx(client => store.savePlan(client, { workspaceId, projectId, plan: next, expectedVersion, actorId: "qa", traceId: "qa" }));
    };
    const unconfirmed = await savePlan(plan());
    const inputUnderUnconfirmed = frozenInput(await sequel.context(workspaceId, projectId, 2));
    expect(inputUnderUnconfirmed.source.storyRevisionId).toBe(unconfirmed.revisionId);
    await sequel.confirm(workspaceId, projectId, 3, "qa");
    const afterExpansion = await sequel.context(workspaceId, projectId, 2);
    expect(afterExpansion).toMatchObject({ episodeCount: 3, storyRevisionId: null, currentStoryRevisionId: unconfirmed.revisionId, planConfirmation: 0 });
    expect(shortSequelAiDraftExpired(inputUnderUnconfirmed, afterExpansion)).toBe(false);
    expect(shortSequelAiDraftExpired(inputBeforePlan, afterExpansion)).toBe(false);
    const nextPlan = plan();
    nextPlan.outline.episodes.push({ ...nextPlan.outline.episodes[1]!, episodeNo: 3 });
    const next = await savePlan(nextPlan);
    const pending = await chain.transitionReview({ table: "story_revision", workspaceId, revisionId: next.revisionId, expectedVersion: next.rowVersion,
      expectedReviewVersion: 1, to: "IN_REVIEW" });
    expect(shortSequelAiDraftExpired(inputUnderUnconfirmed, await sequel.context(workspaceId, projectId, 2))).toBe(false);
    await chain.approveStory({ workspaceId, projectId, revisionId: next.revisionId, expectedVersion: pending.rowVersion,
      expectedReviewVersion: pending.reviewVersion, reviewedBy: "qa" });
    const confirmed = await sequel.context(workspaceId, projectId, 2);
    expect(shortSequelAiDraftExpired(inputUnderUnconfirmed, confirmed)).toBe(true);
    expect(shortSequelAiDraftExpired(inputBeforePlan, confirmed)).toBe(true);
    expect(canBindShortSequelFirstPlan({ ...inputBeforePlan.source, episodeCount: 2 }, confirmed)).toBe(false);
    const first = (await store.snapshot(workspaceId, projectId)).episodes[0]!;
    const previous = await chain.createScriptRevision({ workspaceId, projectId, episodeId: first.id, sourceStoryRevisionId: next.revisionId,
      expectedVersion: first.rowVersion, createdBy: "qa", content: { text: "门环动了。\n交接事实：有人敲门" } });
    const beforePreviousLock = await sequel.context(workspaceId, projectId, 2);
    const unlocked = frozenInput(beforePreviousLock);
    const replacement = await chain.createScriptRevision({ workspaceId, projectId, episodeId: first.id, sourceStoryRevisionId: next.revisionId,
      expectedVersion: previous.rowVersion, createdBy: "qa", content: { text: "门环又动了。\n交接事实：有人敲门" } });
    expect(shortSequelAiDraftExpired(unlocked, await sequel.context(workspaceId, projectId, 2))).toBe(false);
    await expect(sequel.previous(workspaceId, projectId, 2, previous.revisionId)).resolves.toMatchObject({
      revisionId: previous.revisionId, handoff: "有人敲门", content: { text: "门环动了。\n交接事实：有人敲门" },
    });
    const inReview = await chain.transitionReview({ table: "script_revision", workspaceId, revisionId: replacement.revisionId,
      expectedVersion: replacement.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW" });
    await chain.approveScript({ workspaceId, episodeId: first.id, revisionId: replacement.revisionId,
      expectedVersion: inReview.rowVersion, expectedReviewVersion: inReview.reviewVersion, reviewedBy: "qa" });
    expect(shortSequelAiDraftExpired(unlocked, await sequel.context(workspaceId, projectId, 2))).toBe(true);
    await expect(tx(client => store.saveScript(client, { workspaceId, projectId, episodeId: second.episodeId,
      sourceStoryRevisionId: next.revisionId, expectedVersion: 1, actorId: "qa", traceId: "qa",
      script: { ...body, previousRevisionId: replacement.revisionId }, continuation: {
        previousRevisionId: replacement.revisionId, originalRunId: null, originalEpisodeHash: null, planConfirmation: 0,
        episodeCount: 3, aiAttemptId: oldAi.id,
      } }))).rejects.toMatchObject({ code: "SOURCE_STALE" });
    expect((await store.snapshot(workspaceId, projectId)).episodes[1]?.script).toBeNull();
  });

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
