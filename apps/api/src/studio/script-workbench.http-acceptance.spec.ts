import "reflect-metadata";
import { Module, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool, JobPersistenceService, PostgresSpeechStore, PostgresTitleWritingStore, RuntimeStore, runMigrations, TextChainService, VimaxPreviewSourceStore } from "@ai-drama/database";
import { SCRIPT_BREAKDOWN_OUTPUT_SCHEMA, type ScriptBreakdownFrozenInput, type ScriptBreakdownRunView, type ScriptWorkbenchPlan, type ScriptWorkbenchScript, type ScriptWorkbenchSnapshot, type SpeechBinding, type SpeechGenerationPort, type SpeechPlanView, type SpeechVoice, type VimaxPlatformSourceSnapshot } from "@ai-drama/contracts";
import { workbenchScriptText } from "@ai-drama/domain";
import { TitleWritingEngine, titleWritingProviderConfigs, type WritingTransport } from "@ai-drama/providers";
import { breakdownPromptParts, providerAnswer } from "@ai-drama/providers/title-writing-fixtures";
import { checkDisposableAcceptanceEnv, verifyDisposableAcceptanceDatabase } from "../../../../packages/database/src/disposable-acceptance-guard";
import { AuthModule } from "../auth/auth.module";
import { hashPassword } from "../auth/password-hash";
import type { ApiEnv } from "../config/env";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import { ScriptWorkbenchController, SCRIPT_WORKBENCH_SERVICE } from "./script-workbench.controller";
import { ScriptWorkbenchService } from "./script-workbench.service";
import { StudioController } from "./studio.controller";
import { StudioService } from "./studio.service";
import { ScriptBreakdownController } from "./script-breakdown.controller";
import { ScriptBreakdownService } from "./script-breakdown.service";
import { VimaxPreviewController } from "./vimax-preview.controller";
import { VimaxPreviewService } from "./vimax-preview.service";
import { SCRIPT_BREAKDOWN_SERVICE, STUDIO_SERVICE, VIMAX_PREVIEW_SERVICE } from "./tokens";
import { SpeechController, SPEECH_SERVICE } from "./speech.controller";
import { SpeechService } from "./speech.service";

const pattern = /^ads_workbench_acceptance_[a-z0-9_]+$/;
if (process.env.SCRIPT_WORKBENCH_TEST_ALLOW_WRITES !== "true" || process.env.SCRIPT_WORKBENCH_TEST_ALLOW_DRAFT !== "true") throw new Error("Explicit disposable-write and draft flags required");
const decision = checkDisposableAcceptanceEnv({ databaseName: process.env.SCRIPT_WORKBENCH_TEST_DATABASE_NAME,
  url: process.env.SCRIPT_WORKBENCH_TEST_DATABASE_URL, businessDatabaseUrl: process.env.DATABASE_URL, namePattern: pattern, nameHint: pattern.source });
if (!decision.ok) throw new Error(decision.reason);
const pool = createPostgresPool({ connectionString: decision.url, connectionTimeoutMs: 2000, statementTimeoutMs: 15000, queryTimeoutMs: 15000 });
const workspaceId = randomUUID(); const otherWorkspaceId = randomUUID(); const projectId = randomUUID(); const otherProjectId = randomUUID();
const chain = new TextChainService(pool);
const runtime = new RuntimeStore(pool);
const writingStore = new PostgresTitleWritingStore(pool, chain);
const vimaxSource = new VimaxPreviewSourceStore(pool);
const speech = new PostgresSpeechStore(pool, new JobPersistenceService(pool));
const speechProviderId = randomUUID();
const speechVoice: SpeechVoice = { catalogVoiceId: "workbench-fixture-voice", name: "工作台验收声音", providerConfigurationId: speechProviderId,
  providerConfigurationVersion: "fixture-v1", providerKey: "dashscope-media", model: "qwen3-tts-flash", modelVersion: "fixture-v1",
  voiceId: "Cherry", locale: "zh-CN", rightsRef: "synthetic-acceptance-no-provider-call",
  capabilities: { emotions: ["neutral"], speedMin: 1, speedMax: 1, maxTextCharacters: 600 } };
const speechGeneration: SpeechGenerationPort = {
  capabilities: async () => ({ available: true, reasonCode: null, catalogVersion: "fixture-v1", voices: [speechVoice] }),
  quote: async () => { throw new Error("This source acceptance must not quote paid speech"); },
  generate: async () => { throw new Error("This source acceptance must not generate paid speech"); },
};
const scheduledBreakdowns: Array<() => Promise<void>> = [];
const breakdownPrompts: string[] = [];
// Only this in-memory transport can run: no request reaches a provider or incurs a charge.
const transport: WritingTransport = async (input) => {
  const body = JSON.parse(input.body) as { messages: Array<{ role: string; content: string }>; max_tokens: number };
  expect(body.max_tokens).toBe(4096);
  const prompt = body.messages.find(message => message.role === "user")!.content;
  const parts = breakdownPromptParts(prompt);
  breakdownPrompts.push(parts.script);
  const speaker = parts.characters[0]?.name ?? (parts.script.includes("\n青：") ? "青" : "R01");
  const longEpisode = prompt.includes("每集目标约 210 秒");
  return { status: 200, headers: { get: () => "workbench-handoff-fixture" }, body: new TextEncoder().encode(JSON.stringify(providerAnswer(input.url, {
    schema: SCRIPT_BREAKDOWN_OUTPUT_SCHEMA, episodeNo: 1,
    scenes: Array.from({ length: longEpisode ? 3 : 1 }, (_, index) => ({ key: `S${String(index + 1)}`, heading: "门口", timeOfDay: "夜", description: "她推开门。" })),
    shots: Array.from({ length: longEpisode ? 21 : 1 }, (_, index) => {
      const sceneNo = Math.floor(index / 7) + 1;
      return { key: `S${String(sceneNo)}-${String(index % 7 + 1)}`, sceneKey: `S${String(sceneNo)}`, shotType: "近景", camera: "固定", action: "她推开门。",
        dialogue: index === 0 ? [{ speaker, line: "谁在门外？" }] : [],
        characterKeys: index === 0 && parts.characters[0] ? [parts.characters[0].key] : [], plannedSeconds: longEpisode ? 10 : 6 };
    }),
  }))) };
};
const origin = "https://workbench.example.test";
const password = "test-only-workbench-password-938#";
let app: INestApplication; let base = ""; let readHeaders: Record<string, string>; let writeHeaders: Record<string, string>;
const plan: ScriptWorkbenchPlan = { brief: { genre: "悬疑", audience: "悬疑爱好者", productionConstraints: "两人一室", logline: "找出真相", targetEpisodeSeconds: 27, dialogueQuota: 4 },
  bible: { ending: "真相公开", openThreads: "无", characters: [{ id: "R01", name: "青", appearance: "青衣", voice: "清晰", aliases: "阿青", knownInformation: "见过信" }] },
  outline: { episodes: [{ episodeNo: 1, title: "来客", openingHook: "门响", change: "发现信", endingHandoff: "门开" }] } };
function request(path: string, init: RequestInit = {}) { return fetch(`${base}${path}`, { redirect: "manual", ...init }); }
function write(path: string, body: unknown, headers: Record<string, string> = {}) {
  return request(path, { method: "POST", headers: { ...writeHeaders, "idempotency-key": randomUUID(), "if-match": "1", ...headers }, body: JSON.stringify(body) });
}
function put(path: string, body: unknown, version: number) {
  return request(path, { method: "PUT", headers: { ...writeHeaders, "idempotency-key": randomUUID(), "if-match": String(version) }, body: JSON.stringify(body) });
}
async function approveRevision(path: string, rowVersion: number) {
  const submitted = await write(path, { to: "IN_REVIEW", expectedReviewVersion: 1 }, { "if-match": String(rowVersion) });
  expect(submitted.status).toBe(200);
  const review = await submitted.json() as { rowVersion: number; reviewVersion: number };
  const approved = await write(path, { to: "APPROVED", expectedReviewVersion: review.reviewVersion }, { "if-match": String(review.rowVersion) });
  expect(approved.status).toBe(200);
}
beforeAll(async () => {
  const safe = await verifyDisposableAcceptanceDatabase(pool as Parameters<typeof verifyDisposableAcceptanceDatabase>[0], decision.databaseName, pattern);
  if (!safe.ok) throw new Error(safe.reason);
  await runMigrations(pool);
  await pool.query(await readFile(resolve("../../packages/database/prisma/drafts/20261111000300_script_workbench_trash.sql"), "utf8"));
  await pool.query(await readFile(resolve("../../packages/database/prisma/drafts/20261101000100_character_voice.sql"), "utf8"));
  expect(await speech.storageReady()).toBe(true);
  await pool.query("INSERT INTO workspace(id,name) VALUES($1,'workbench HTTP'),($2,'other workspace')", [workspaceId, otherWorkspaceId]);
  await pool.query("INSERT INTO provider_configuration(id,workspace_id,provider_key,capability,default_timeout_ms,max_attempts) VALUES($1,$2,'dashscope-media','audio.tts',30000,1)", [speechProviderId, workspaceId]);
  await pool.query("INSERT INTO project(id,workspace_id,title,episode_count,target_episode_seconds) VALUES($1,$2,'HTTP验收',1,60),($3,$4,'其他空间',1,60)", [projectId, workspaceId, otherProjectId, otherWorkspaceId]);
  const hash = await hashPassword(password, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
  const env = { NODE_ENV: "test", SITE_AUTH_ENABLED: "true", SITE_AUTH_USERNAME: "qa", SITE_AUTH_PASSWORD_HASH: hash, SITE_AUTH_PUBLIC_ORIGIN: origin } as ApiEnv;
  const providers = titleWritingProviderConfigs({ DEEPSEEK_API_KEY: "stub-workbench-handoff-not-a-real-key" });
  const breakdown = new ScriptBreakdownService({ workspaceId, nodeEnv: "test", enabled: true, operatorToken: null, siteOperator: true,
    defaultProvider: "deepseek", providers, store: writingStore,
    engine: new TitleWritingEngine({ workspaceId, store: writingStore, providers, transport, maxCallsPerDay: 20, timeoutMs: 1500 }),
    projects: runtime, maxCallsPerDay: 20, maxActiveRuns: 2, schedule: work => { scheduledBreakdowns.push(work); } });
  class Routes {}
  Module({ controllers: [ScriptWorkbenchController, StudioController, ScriptBreakdownController, VimaxPreviewController, SpeechController], providers: [
    { provide: SCRIPT_WORKBENCH_SERVICE, useValue: new ScriptWorkbenchService(pool, workspaceId) },
    { provide: STUDIO_SERVICE, useValue: new StudioService(new JobPersistenceService(pool), runtime, chain, workspaceId) },
    { provide: SCRIPT_BREAKDOWN_SERVICE, useValue: breakdown },
    { provide: VIMAX_PREVIEW_SERVICE, useValue: new VimaxPreviewService({ workspaceId, nodeEnv: "test", source: vimaxSource }) },
    { provide: SPEECH_SERVICE, useValue: new SpeechService({ workspaceId, store: speech, generation: speechGeneration }) },
  ] })(Routes);
  const module = await Test.createTestingModule({ imports: [AuthModule.register(env), Routes] }).compile();
  app = module.createNestApplication({ logger: false }); app.setGlobalPrefix("api/v1"); app.useGlobalFilters(new SafeExceptionFilter());
  await app.listen(0, "127.0.0.1"); base = `${await app.getUrl()}/api/v1`;
  const login = await request("/auth/login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ username: "qa", password }) });
  expect(login.status).toBe(200);
  const cookies = login.headers.getSetCookie().filter(value => value.startsWith("__Host-ads_")).map(value => value.split(";", 1)[0]).join("; ");
  const session = await login.json() as { csrfToken: string };
  readHeaders = { cookie: cookies }; writeHeaders = { cookie: cookies, origin, "content-type": "application/json", "x-csrf-token": session.csrfToken };
});
afterAll(async () => { await app?.close(); await pool.end(); });

describe("script workbench HTTP boundaries", () => {
  it("requires authentication for both workbench and trash reads", async () => {
    expect((await request(`/projects/${projectId}/script-workbench`)).status).toBe(401);
    expect((await request("/script-workbench/trash")).status).toBe(401);
  });
  it("rejects authenticated mutations without CSRF or from a foreign origin", async () => {
    expect((await request(`/projects/${projectId}/script-workbench/plan`, { method: "POST", headers: { ...readHeaders, origin, "content-type": "application/json" }, body: JSON.stringify({ plan }) })).status).toBe(403);
    expect((await write(`/projects/${projectId}/script-workbench/plan`, { plan }, { origin: "https://foreign.example.test" })).status).toBe(403);
    expect((await request(`/projects/${projectId}/script-workbench/trash`, { method: "POST", headers: { ...readHeaders, origin, "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: 1 }) })).status).toBe(403);
  });
  it("rejects browser-supplied workspace scope, invalid IDs, malformed plans and missing versions", async () => {
    expect((await write(`/projects/${projectId}/script-workbench/plan`, { plan, workspaceId: otherWorkspaceId })).status).toBe(400);
    expect((await write(`/projects/${projectId}/script-workbench/plan`, { plan: { ...plan, brief: { ...plan.brief, dialogueQuota: -1 } } })).status).toBe(400);
    expect((await write(`/projects/${projectId}/script-workbench/plan`, { plan }, { "if-match": "" })).status).toBe(400);
    expect((await request("/projects/not-a-uuid/script-workbench", { headers: readHeaders })).status).toBe(400);
  });
  it("never exposes another workspace through snapshot, preview, or a forged write", async () => {
    expect((await request(`/projects/${otherProjectId}/script-workbench`, { headers: readHeaders })).status).toBe(404);
    expect((await request(`/projects/${otherProjectId}/script-workbench/deletion-preview`, { headers: readHeaders })).status).toBe(404);
    expect((await write(`/projects/${otherProjectId}/script-workbench/plan`, { plan })).status).toBe(404);
  });
  it("persists a valid plan, returns no-store snapshots, replays its key and rejects stale saves", async () => {
    const key = randomUUID(); const path = `/projects/${projectId}/script-workbench/plan`;
    const first = await write(path, { plan }, { "idempotency-key": key }); expect(first.status).toBe(201);
    const firstBody = await first.json();
    const retry = await write(path, { plan }, { "idempotency-key": key }); expect(retry.status).toBe(201); expect(await retry.json()).toEqual(firstBody);
    expect((await write(path, { plan })).status).toBe(409);
    const snapshot = await request(`/projects/${projectId}/script-workbench`, { headers: readHeaders });
    expect(snapshot.status).toBe(200); expect(snapshot.headers.get("cache-control")).toBe("no-store");
    expect(await snapshot.json()).toMatchObject({ story: { reviewStatus: "DRAFT", content: { workbench: { plan } } }, project: { version: 2 } });
  });

  it("hands an explicitly approved workbench version to actual breakdown and ViMax readers without weakening approval gates", async () => {
    const created = await write("/projects", { title: "工作台制作交接", episodeCount: 1, targetEpisodeSeconds: 60 });
    expect(created.status).toBe(201);
    const workId = (await created.json() as { id: string }).id;
    const savePlan = await write(`/projects/${workId}/script-workbench/plan`, { plan });
    expect(savePlan.status).toBe(201);
    const story = await savePlan.json() as { revisionId: string; rowVersion: number };
    const submitPlan = await write(`/projects/${workId}/stories/${story.revisionId}/review`, { to: "IN_REVIEW", expectedReviewVersion: 1 }, { "if-match": String(story.rowVersion) });
    expect(submitPlan.status).toBe(200);
    const planReview = await submitPlan.json() as { rowVersion: number; reviewVersion: number };
    const approvePlan = await write(`/projects/${workId}/stories/${story.revisionId}/review`, { to: "APPROVED", expectedReviewVersion: planReview.reviewVersion }, { "if-match": String(planReview.rowVersion) });
    expect(approvePlan.status).toBe(200);
    const snapshot = await (await request(`/projects/${workId}/script-workbench`, { headers: readHeaders })).json() as ScriptWorkbenchSnapshot;
    const episode = snapshot.episodes[0]!;
    const script: ScriptWorkbenchScript = { title: "来客", previousRevisionId: null, previousHandoff: "", openingHook: "门响", change: "发现信", endingHandoff: "门开",
      characterKnowledge: "R01 见过信", unresolvedThreads: "无", scenes: [{ id: "s1", heading: "门口", interiorExterior: "INT", timeOfDay: "NIGHT", characterIds: ["R01"],
        beats: [{ id: "a1", kind: "action", text: "她推开门。", seconds: 2 }, { id: "d1", kind: "dialogue", characterId: "R01", text: "谁在门外？", seconds: 2 }] }],
      review: { identityClear: true, goalClear: true, obstacleClear: true, continuityChecked: true, lockedMaterialsChecked: true, note: "人工核对通过" } };
    const scriptPath = `/projects/${workId}/episodes/${episode.id}/script-workbench`;
    const saved = await write(scriptPath, { script, sourceStoryRevisionId: story.revisionId }, { "if-match": String(episode.rowVersion) });
    expect(saved.status).toBe(201);
    const draft = await saved.json() as { revisionId: string; rowVersion: number; contentHash: string };
    const breakdownPath = `/projects/${workId}/episodes/${episode.id}/script-breakdowns`;
    const vimaxPath = `/projects/${workId}/episodes/${episode.id}/vimax-preview/source`;
    const refusedDraft = await write(breakdownPath, { providerKey: "deepseek", model: "deepseek-flash" });
    expect(refusedDraft.status).toBe(409);
    expect(await refusedDraft.json()).toMatchObject({ error: { code: "SCRIPT_REVIEW_REQUIRED" } });
    expect((await request(vimaxPath, { headers: readHeaders })).status).toBe(409);
    expect(scheduledBreakdowns).toHaveLength(0);

    const reviewPath = `/projects/${workId}/episodes/${episode.id}/scripts/${draft.revisionId}/review`;
    const submitScript = await write(reviewPath, { to: "IN_REVIEW", expectedReviewVersion: 1 }, { "if-match": String(draft.rowVersion) });
    expect(submitScript.status).toBe(200);
    const scriptReview = await submitScript.json() as { rowVersion: number; reviewVersion: number };
    const approveScript = await write(reviewPath, { to: "APPROVED", expectedReviewVersion: scriptReview.reviewVersion }, { "if-match": String(scriptReview.rowVersion) });
    expect(approveScript.status).toBe(200);
    const approvedSnapshot = await (await request(`/projects/${workId}/script-workbench`, { headers: readHeaders })).json() as ScriptWorkbenchSnapshot;
    const approvedContent = approvedSnapshot.episodes[0]!.script!.content;
    expect(Object.keys(approvedContent).sort()).toEqual(["text", "workbench"]);
    const savedText = approvedContent.text as string;
    expect(savedText).toContain("青：谁在门外？");
    const vimax = await request(vimaxPath, { headers: readHeaders });
    expect(vimax.status).toBe(200);
    const source = await vimax.json() as VimaxPlatformSourceSnapshot;
    expect(source).toMatchObject({ scriptRevisionId: draft.revisionId, scriptText: savedText,
      scriptContentHash: createHash("sha256").update(savedText, "utf8").digest("hex") });
    expect(await vimaxSource.read(workspaceId, workId, episode.id)).toMatchObject({ kind: "ok", source });

    const breakdownKey = randomUUID();
    const started = await write(breakdownPath, { providerKey: "deepseek", model: "deepseek-flash" }, { "idempotency-key": breakdownKey });
    expect(started.status).toBe(201);
    const runId = (await started.json() as { run: ScriptBreakdownRunView }).run.runId;
    const frozen = (await writingStore.getRun(workspaceId, workId, runId))!.run.input as ScriptBreakdownFrozenInput;
    expect(frozen).toMatchObject({ scriptRevisionId: draft.revisionId, scriptContentHash: draft.contentHash, scriptText: savedText, targetEpisodeSeconds: 27 });
    const scriptSource = await pool.query("SELECT source_story_revision_id FROM script_revision WHERE id=$1", [draft.revisionId]) as { rows: Array<{ source_story_revision_id: string }> };
    expect(scriptSource.rows).toEqual([{ source_story_revision_id: story.revisionId }]);
    expect(scheduledBreakdowns).toHaveLength(1);
    await scheduledBreakdowns.shift()!();
    const finished = await (await request(`${breakdownPath}/${runId}`, { headers: readHeaders })).json() as { run: ScriptBreakdownRunView };
    expect(finished.run).toMatchObject({ state: "completed", save: "saved", scriptRevisionId: draft.revisionId, targetEpisodeSeconds: 27, callsUsed: 1 });
    expect(breakdownPrompts).toEqual([savedText]);
    const sceneSources = await pool.query("SELECT source_script_revision_id FROM scene_revision WHERE project_id=$1", [workId]) as { rows: Array<{ source_script_revision_id: string }> };
    expect(sceneSources.rows).toEqual([{ source_script_revision_id: draft.revisionId }]);

    // A later unapproved workbench version still closes both production readers, even though the older one was approved.
    const beforeRevision = await (await request(`/projects/${workId}/script-workbench`, { headers: readHeaders })).json() as ScriptWorkbenchSnapshot;
    const revised = await write(scriptPath, { script: { ...script, change: "发现第二封信" }, sourceStoryRevisionId: story.revisionId }, { "if-match": String(beforeRevision.episodes[0]!.rowVersion) });
    expect(revised.status).toBe(201);
    expect((await request(vimaxPath, { headers: readHeaders })).status).toBe(409);
    const refusedNewDraft = await write(breakdownPath, { providerKey: "deepseek", model: "deepseek-flash", replaceExisting: true });
    expect(refusedNewDraft.status).toBe(409);
    expect(await refusedNewDraft.json()).toMatchObject({ error: { code: "SCRIPT_REVIEW_REQUIRED" } });
    expect(breakdownPrompts).toHaveLength(1);

    // The approved source story owns the writing duration. A new plan must not mutate an existing run or its replay.
    const beforePlan = await (await request(`/projects/${workId}/script-workbench`, { headers: readHeaders })).json() as ScriptWorkbenchSnapshot;
    const nextPlan = await write(`/projects/${workId}/script-workbench/plan`, { plan: { ...plan, brief: { ...plan.brief, targetEpisodeSeconds: 210 } } }, { "if-match": String(beforePlan.project.version) });
    expect(nextPlan.status).toBe(201);
    const nextStory = await nextPlan.json() as { revisionId: string; rowVersion: number };
    const replay = await write(breakdownPath, { providerKey: "deepseek", model: "deepseek-flash" }, { "idempotency-key": breakdownKey });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ run: { runId, targetEpisodeSeconds: 27, scriptRevisionId: draft.revisionId } });
    expect((await writingStore.getRun(workspaceId, workId, runId))!.run.input).toEqual(frozen);
    expect(scheduledBreakdowns).toHaveLength(0);

    await approveRevision(`/projects/${workId}/stories/${nextStory.revisionId}/review`, nextStory.rowVersion);
    const nextSnapshot = await (await request(`/projects/${workId}/script-workbench`, { headers: readHeaders })).json() as ScriptWorkbenchSnapshot;
    const nextSaved = await write(scriptPath, { script, sourceStoryRevisionId: nextStory.revisionId }, { "if-match": String(nextSnapshot.episodes[0]!.rowVersion) });
    expect(nextSaved.status).toBe(201);
    const nextScript = await nextSaved.json() as { revisionId: string; rowVersion: number };
    await approveRevision(`/projects/${workId}/episodes/${episode.id}/scripts/${nextScript.revisionId}/review`, nextScript.rowVersion);
    const nextStarted = await write(breakdownPath, { providerKey: "deepseek", model: "deepseek-flash", replaceExisting: true });
    expect(nextStarted.status).toBe(201);
    const nextRunId = (await nextStarted.json() as { run: ScriptBreakdownRunView }).run.runId;
    expect((await writingStore.getRun(workspaceId, workId, nextRunId))!.run.input).toMatchObject({ scriptRevisionId: nextScript.revisionId, targetEpisodeSeconds: 210 });
    await scheduledBreakdowns.shift()!();
    const nextFinished = await (await request(`${breakdownPath}/${nextRunId}`, { headers: readHeaders })).json() as { run: ScriptBreakdownRunView };
    expect(nextFinished.run).toMatchObject({ state: "completed", save: "saved", targetEpisodeSeconds: 210, plannedTotalSeconds: 210, callsUsed: 1 });
    expect(nextFinished.run.output!.scenes).toHaveLength(3);
    expect(nextFinished.run.output!.shots).toHaveLength(21);
    expect(nextFinished.run.output!.shots.reduce((seconds, shot) => seconds + shot.plannedSeconds, 0)).toBe(210);
    const sceneList = await (await request(`/projects/${workId}/episodes/${episode.id}/scenes`, { headers: readHeaders })).json() as {
      items: Array<{ entityId: string; rowVersion: number; currentRevisionId: string }>;
    };
    expect(sceneList.items).toHaveLength(3);
    for (const scene of sceneList.items) {
      await approveRevision(`/projects/${workId}/episodes/${episode.id}/scenes/${scene.entityId}/revisions/${scene.currentRevisionId}/review`, scene.rowVersion);
    }
    const placed = await write(`${breakdownPath}/${nextRunId}/shots`, {});
    expect(placed.status).toBe(200);
    const persistedShots = await pool.query(`SELECT count(*)::int AS shot_count, sum(r.planned_duration_ms)::int AS duration_ms
      FROM shot s JOIN shot_revision r ON r.id=s.current_revision_id
      JOIN scene c ON c.id=s.scene_id
      WHERE c.episode_id=$1 AND c.archived_at IS NULL AND s.archived_at IS NULL`, [episode.id]) as { rows: Array<{ shot_count: number; duration_ms: number }> };
    expect(persistedShots.rows).toEqual([{ shot_count: 21, duration_ms: 210000 }]);

    // Oversized writing plans remain editable, but cannot start a paid breakdown outside its supported output bounds.
    const beforeOversize = await (await request(`/projects/${workId}/script-workbench`, { headers: readHeaders })).json() as ScriptWorkbenchSnapshot;
    const oversizePlan = await write(`/projects/${workId}/script-workbench/plan`, { plan: { ...plan, brief: { ...plan.brief, targetEpisodeSeconds: 241 } } }, { "if-match": String(beforeOversize.project.version) });
    expect(oversizePlan.status).toBe(201);
    const oversizeStory = await oversizePlan.json() as { revisionId: string; rowVersion: number };
    await approveRevision(`/projects/${workId}/stories/${oversizeStory.revisionId}/review`, oversizeStory.rowVersion);
    const oversizeSnapshot = await (await request(`/projects/${workId}/script-workbench`, { headers: readHeaders })).json() as ScriptWorkbenchSnapshot;
    const oversizeSaved = await write(scriptPath, { script, sourceStoryRevisionId: oversizeStory.revisionId }, { "if-match": String(oversizeSnapshot.episodes[0]!.rowVersion) });
    expect(oversizeSaved.status).toBe(201);
    const oversizeScript = await oversizeSaved.json() as { revisionId: string; rowVersion: number };
    await approveRevision(`/projects/${workId}/episodes/${episode.id}/scripts/${oversizeScript.revisionId}/review`, oversizeScript.rowVersion);
    const callsBeforeOversize = breakdownPrompts.length;
    const refusedOversize = await write(breakdownPath, { providerKey: "deepseek", model: "deepseek-flash", replaceExisting: true });
    expect(refusedOversize.status).toBe(422);
    expect(await refusedOversize.json()).toMatchObject({ error: { code: "SCRIPT_BREAKDOWN_TARGET_TOO_LONG" } });
    expect(scheduledBreakdowns).toHaveLength(0);
    expect(breakdownPrompts).toHaveLength(callsBeforeOversize);
  });

  it("keeps legacy text scripts readable and freezes the project's legacy 60-second target", async () => {
    const created = await write("/projects", { title: "传统正文制作交接", episodeCount: 1, targetEpisodeSeconds: 60 });
    expect(created.status).toBe(201);
    const workId = (await created.json() as { id: string }).id;
    const savedStory = await write(`/projects/${workId}/stories`, { content: { text: "来客推门而入。" } });
    expect(savedStory.status).toBe(201);
    const story = await savedStory.json() as { revisionId: string; rowVersion: number };
    await approveRevision(`/projects/${workId}/stories/${story.revisionId}/review`, story.rowVersion);
    const snapshot = await (await request(`/projects/${workId}/script-workbench`, { headers: readHeaders })).json() as ScriptWorkbenchSnapshot;
    const episode = snapshot.episodes[0]!;
    const text = "第1集 来客\n1.门口 内景 夜\n她推开门。\nR01：谁在门外？";
    const saved = await write(`/projects/${workId}/episodes/${episode.id}/scripts`, { sourceStoryRevisionId: story.revisionId, content: { text } }, { "if-match": String(episode.rowVersion) });
    expect(saved.status).toBe(201);
    const script = await saved.json() as { revisionId: string; rowVersion: number };
    await approveRevision(`/projects/${workId}/episodes/${episode.id}/scripts/${script.revisionId}/review`, script.rowVersion);
    expect(await vimaxSource.read(workspaceId, workId, episode.id)).toMatchObject({ kind: "ok", source: { scriptRevisionId: script.revisionId, scriptText: text } });
    const path = `/projects/${workId}/episodes/${episode.id}/script-breakdowns`;
    const started = await write(path, { providerKey: "deepseek", model: "deepseek-flash" });
    expect(started.status).toBe(201);
    const runId = (await started.json() as { run: ScriptBreakdownRunView }).run.runId;
    expect((await writingStore.getRun(workspaceId, workId, runId))!.run.input).toMatchObject({ scriptRevisionId: script.revisionId, scriptText: text, targetEpisodeSeconds: 60 });
    await scheduledBreakdowns.shift()!();
    expect(await (await request(`${path}/${runId}`, { headers: readHeaders })).json()).toMatchObject({ run: { state: "completed", save: "saved", targetEpisodeSeconds: 60 } });
  });

  it.each(["named", "legacy-id"] as const)("hands %s workbench dialogue through approved character shots into a real speech plan", async (storageFormat) => {
    const created = await write("/projects", { title: `角色配音交接 ${storageFormat}`, episodeCount: 1, targetEpisodeSeconds: 60 });
    expect(created.status).toBe(201);
    const workId = (await created.json() as { id: string }).id;
    const savedPlan = await write(`/projects/${workId}/script-workbench/plan`, { plan });
    expect(savedPlan.status).toBe(201);
    const story = await savedPlan.json() as { revisionId: string; rowVersion: number };
    await approveRevision(`/projects/${workId}/stories/${story.revisionId}/review`, story.rowVersion);
    const snapshot = await (await request(`/projects/${workId}/script-workbench`, { headers: readHeaders })).json() as ScriptWorkbenchSnapshot;
    const episode = snapshot.episodes[0]!;
    const script: ScriptWorkbenchScript = { title: "来客", previousRevisionId: null, previousHandoff: "", openingHook: "门响", change: "发现信", endingHandoff: "门开",
      characterKnowledge: "R01 见过信", unresolvedThreads: "无", scenes: [{ id: "s1", heading: "门口", interiorExterior: "INT", timeOfDay: "NIGHT", characterIds: ["R01"],
        beats: [{ id: "a1", kind: "action", text: "她推开门。", seconds: 2 }, { id: "d1", kind: "dialogue", characterId: "R01", text: "谁在门外？", seconds: 2 }] }],
      review: { identityClear: true, goalClear: true, obstacleClear: true, continuityChecked: true, lockedMaterialsChecked: true, note: "人工核对通过" } };
    const saved = await write(`/projects/${workId}/episodes/${episode.id}/script-workbench`, { script, sourceStoryRevisionId: story.revisionId }, { "if-match": String(episode.rowVersion) });
    expect(saved.status).toBe(201);
    let currentScript = await saved.json() as { revisionId: string; rowVersion: number };
    if (storageFormat === "legacy-id") {
      // Represent an immutable revision saved by the original workbench, through the existing generic editor route.
      const legacy = await write(`/projects/${workId}/episodes/${episode.id}/scripts`, { sourceStoryRevisionId: story.revisionId,
        content: { text: workbenchScriptText(script), workbench: { schema: "script-workbench.v1", script } } }, { "if-match": String(currentScript.rowVersion) });
      expect(legacy.status).toBe(201);
      currentScript = await legacy.json() as { revisionId: string; rowVersion: number };
    }
    await approveRevision(`/projects/${workId}/episodes/${episode.id}/scripts/${currentScript.revisionId}/review`, currentScript.rowVersion);
    const approvedSnapshot = await (await request(`/projects/${workId}/script-workbench`, { headers: readHeaders })).json() as ScriptWorkbenchSnapshot;
    const storedContent = approvedSnapshot.episodes[0]!.script!.content;
    expect(storedContent.text).toContain(`${storageFormat === "legacy-id" ? "R01" : "青"}：谁在门外？`);
    expect(storedContent).toMatchObject({ workbench: { script: { scenes: [{ characterIds: ["R01"], beats: [{ id: "a1" }, { characterId: "R01" }] }] } } });

    const savedCharacter = await write(`/projects/${workId}/characters`, { name: "青", sourceScriptRevisionId: currentScript.revisionId,
      content: { description: "青衣，清晰声线" } }, { "if-match": String(approvedSnapshot.project.version) });
    expect(savedCharacter.status).toBe(201);
    const character = await savedCharacter.json() as { entityId: string; revisionId: string; rowVersion: number };
    await approveRevision(`/projects/${workId}/characters/${character.entityId}/revisions/${character.revisionId}/review`, character.rowVersion);
    const breakdownPath = `/projects/${workId}/episodes/${episode.id}/script-breakdowns`;
    const started = await write(breakdownPath, { providerKey: "deepseek", model: "deepseek-flash" });
    expect(started.status).toBe(201);
    const runId = (await started.json() as { run: ScriptBreakdownRunView }).run.runId;
    const frozen = (await writingStore.getRun(workspaceId, workId, runId))!.run.input as ScriptBreakdownFrozenInput;
    expect(frozen.scriptText).toContain("青：谁在门外？");
    expect(frozen.scriptText).not.toContain("R01：");
    expect(frozen.characters).toEqual([{ key: "C1", characterId: character.entityId, revisionId: character.revisionId, name: "青" }]);
    expect(await vimaxSource.read(workspaceId, workId, episode.id)).toMatchObject({ kind: "ok", source: { scriptText: frozen.scriptText, scriptRevisionId: currentScript.revisionId } });
    await scheduledBreakdowns.shift()!();
    const finished = await (await request(`${breakdownPath}/${runId}`, { headers: readHeaders })).json() as { run: ScriptBreakdownRunView };
    expect(finished.run).toMatchObject({ state: "completed", save: "saved", output: { shots: [{ dialogue: [{ speaker: "青", line: "谁在门外？" }], characterKeys: ["C1"] }] } });
    const scenesPath = `/projects/${workId}/episodes/${episode.id}/scenes`;
    const sceneList = await (await request(scenesPath, { headers: readHeaders })).json() as { items: Array<{ entityId: string; rowVersion: number; currentRevisionId: string }> };
    const scene = sceneList.items[0]!;
    await approveRevision(`${scenesPath}/${scene.entityId}/revisions/${scene.currentRevisionId}/review`, scene.rowVersion);
    expect((await write(`${breakdownPath}/${runId}/shots`, {})).status).toBe(200);
    const shotsPath = `${scenesPath}/${scene.entityId}/shots`;
    const shotList = await (await request(shotsPath, { headers: readHeaders })).json() as { items: Array<{ entityId: string; rowVersion: number; currentRevisionId: string }> };
    const shot = shotList.items[0]!;
    const shotHistory = await (await request(`${shotsPath}/${shot.entityId}/revisions`, { headers: readHeaders })).json() as { items: Array<{ id: string; dialogue: string }> };
    expect(shotHistory.items.find(revision => revision.id === shot.currentRevisionId)!.dialogue).toBe("青：谁在门外？");
    const speechPath = `/shot-revisions/${shot.currentRevisionId}/speech-plan`;
    expect((await request(speechPath, { headers: readHeaders })).status).toBe(409);
    await approveRevision(`${shotsPath}/${shot.entityId}/revisions/${shot.currentRevisionId}/review`, shot.rowVersion);
    const references = await pool.query(`SELECT cr.character_id FROM shot_character_reference r
      JOIN character_revision cr ON cr.id=r.character_revision_id WHERE r.shot_revision_id=$1`, [shot.currentRevisionId]) as { rows: Array<{ character_id: string }> };
    expect(references.rows).toEqual([{ character_id: character.entityId }]);

    const voiceResponse = await put(`/projects/${workId}/voice-bindings/${character.entityId}`, { catalogVersion: "fixture-v1", catalogVoiceId: speechVoice.catalogVoiceId }, 0);
    expect(voiceResponse.status).toBe(200);
    const voiceBinding = await voiceResponse.json() as SpeechBinding;
    const sourceResponse = await request(speechPath, { headers: readHeaders });
    expect(sourceResponse.status).toBe(200);
    const source = await sourceResponse.json() as SpeechPlanView;
    expect(source.sourceDialogue).toBe("青：谁在门外？");
    const lineId = randomUUID();
    const planned = await put(speechPath, { sourceDialogueHash: source.sourceDialogueHash, timingPolicy: "sequential-reject-overflow",
      lines: [{ lineId, speakerBindingRevisionId: voiceBinding.currentRevision.id, sourceStart: "青：".length, sourceEnd: source.sourceDialogue.length,
        displayText: "谁在门外？", emotion: "neutral", speed: 1, pauseAfterMs: 0 }] }, source.rowVersion);
    expect(planned.status).toBe(200);
    const speechPlan = await planned.json() as SpeechPlanView;
    expect(speechPlan.currentRevision!.lines).toMatchObject([{ lineId, displayText: "谁在门外？", speakerBindingRevisionId: voiceBinding.currentRevision.id }]);
    expect(await speech.generationInput(workspaceId, speechPlan.currentRevision!.id, lineId)).toMatchObject({
      shotRevisionId: shot.currentRevisionId, spokenText: "谁在门外？", voice: { id: voiceBinding.currentRevision.id } });
    const jobs = await pool.query("SELECT count(*)::int AS count FROM generation_job WHERE project_id=$1", [workId]) as { rows: Array<{ count: number }> };
    expect(jobs.rows).toEqual([{ count: 0 }]);
  });
});
