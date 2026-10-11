import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ScriptBreakdownRunView } from "@ai-drama/contracts";
import { PersistenceError } from "@ai-drama/database";
import {
  InMemoryTitleWritingStore,
  TitleWritingEngine,
  titleWritingProviderConfigs,
  type TitleWritingProviderEnv,
} from "@ai-drama/providers";
import { chatAnswer, fixtureChatTransport, type FixtureExchange, type FixtureStep } from "@ai-drama/providers/title-writing-fixtures";
import { ScriptBreakdownService } from "./script-breakdown.service";
import { TitleWritingService } from "./title-writing.service";

/**
 * Script breakdown at the API boundary, against the in-process store and a provider stub (no network, no database).
 * The PostgreSQL side of the same rules is in packages/database/src/script-breakdown.acceptance.spec.ts.
 */
const WS = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const TOKEN = "operator-token-0123456789";
const ENV: TitleWritingProviderEnv = {
  DASHSCOPE_API_KEY: "sk-test-not-a-real-key-000", BAILIAN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  TITLE_WRITING_QWEN_MODELS: "q-1",
};
const CONTEXT = (key?: string) => ({ actorId: "server-owner", traceId: "t", idempotencyKey: key });
type Override = (step: FixtureStep, attempt: number) => { status: number; body: unknown } | "hang" | "throw" | undefined;

const SCRIPT = "第 1 集\n场 1 便利店 夜\n林夏盯着监控。\n林夏：这不是我。\n场 2 天台 夜\n周野推开铁门。\n周野：你来了。";

function setup(options: { enabled?: boolean; breakdownReady?: boolean; override?: Override; maxCallsPerDay?: number; approved?: boolean } = {}) {
  const store = new InMemoryTitleWritingStore();
  store.breakdownReady = options.breakdownReady ?? true;
  const episode = store.addBreakdownEpisode({ workspaceId: WS, projectId: P1, episodeNo: 1, text: SCRIPT, approved: options.approved ?? true, targetEpisodeSeconds: 60 });
  const seen: FixtureExchange[] = [];
  const providers = titleWritingProviderConfigs(ENV);
  const transport = fixtureChatTransport("t", { seen, ...(options.override ? { override: options.override } : {}) });
  const maxCallsPerDay = options.maxCallsPerDay ?? 30;
  const engine = new TitleWritingEngine({ workspaceId: WS, store, providers, transport, maxCallsPerDay, timeoutMs: 20 });
  const pending: Array<() => Promise<void>> = [];
  const projects = {
    getProject: async (_workspaceId: string, projectId: string) => {
      if (projectId !== P1) throw new PersistenceError("NOT_FOUND", "Project not found");
      return { id: projectId } as never;
    },
  };
  const common = { workspaceId: WS, nodeEnv: "test" as const, enabled: options.enabled ?? true, operatorToken: TOKEN, defaultProvider: null, providers,
    store, engine, maxCallsPerDay, maxActiveRuns: 1, schedule: (work: () => Promise<void>) => { pending.push(work); } };
  const service = new ScriptBreakdownService({ ...common, projects });
  const title = new TitleWritingService({ ...common, projects: { ...projects,
    getProjectEpisodePlan: async () => ({ episodeCount: 3, targetEpisodeSeconds: null }), episodePlanReady: async () => true } });
  const settle = async () => { while (pending.length > 0) await pending.shift()!(); };
  const start = (body: unknown = {}, key: string | undefined = randomUUID(), token = TOKEN) => service.start(P1, episode.episodeId, body, token, CONTEXT(key));
  const runOf = (result: { body: unknown }) => (result.body as { run: ScriptBreakdownRunView }).run;
  return { store, episode, service, title, seen, settle, start, runOf, pending };
}

describe("starting a script breakdown", () => {
  it("refuses before anything is created or sent: switch off, wrong token, storage not migrated, missing key", async () => {
    for (const [options, token, key, status, code] of [
      [{ enabled: false }, TOKEN, "k", 404, "TITLE_WRITING_DISABLED"],
      [{}, "wrong-token-0000000000", "k", 403, "TITLE_WRITING_FORBIDDEN"],
      [{ breakdownReady: false }, TOKEN, "k", 503, "SCRIPT_BREAKDOWN_STORAGE_UNAVAILABLE"],
      [{}, TOKEN, "", 400, "VALIDATION_ERROR"],
    ] as const) {
      const { store, seen, start } = setup(options);
      const result = await start({}, key, token);
      expect([result.status, (result.body as { error: { code: string } }).error.code]).toEqual([status, code]);
      expect(store.runs).toHaveLength(0);
      expect(seen).toHaveLength(0);
    }
  });

  it("keeps the script gate: a script that is not approved cannot be broken down", async () => {
    const { store, seen, start } = setup({ approved: false });
    const result = await start();
    expect([result.status, (result.body as { error: { code: string } }).error.code]).toEqual([409, "SCRIPT_REVIEW_REQUIRED"]);
    expect([store.runs.length, seen.length]).toEqual([0, 0]);
  });

  it("asks before replacing existing scenes, then replaces them only when told to", async () => {
    const { store, episode, start, settle, runOf } = setup();
    const manual = store.addManualScene(episode.episodeId, "模板场景");
    const refused = await start({});
    expect([refused.status, (refused.body as { error: { code: string; details: unknown } }).error]).toEqual([409,
      expect.objectContaining({ code: "SCRIPT_BREAKDOWN_EXISTING_SCENES", details: { sceneCount: 1, shotCount: 0 } })]);
    expect(store.runs).toHaveLength(0);
    const started = await start({ replaceExisting: true });
    expect(started.status).toBe(201);
    expect(runOf(started)).toMatchObject({ replacedScenes: 1, state: "running", callCap: 3 });
    await settle();
    expect(store.scenes.find((scene) => scene.sceneId === manual.sceneId)!.archived).toBe(true);
  });

  it("answers a replay of the same key with the same run, even after the script changed, and refuses the key for other content", async () => {
    const { store, episode, start, settle, runOf, seen } = setup();
    const key = randomUUID();
    const first = await start({}, key);
    await settle();
    store.writeScript(episode.episodeId, `${SCRIPT}\n场 3 码头\n老周：走。`);
    const replay = await start({}, key);
    expect([replay.status, runOf(replay).runId]).toEqual([200, runOf(first).runId]);
    expect(store.runs).toHaveLength(1);
    expect(seen).toHaveLength(1);
    const other = await start({ replaceExisting: true }, key);
    expect([other.status, (other.body as { error: { code: string } }).error.code]).toEqual([409, "IDEMPOTENCY_KEY_REUSED"]);
  });

  it("counts against the shared daily quota and refuses a start without a call left", async () => {
    const { store, start, seen } = setup({ maxCallsPerDay: 2 });
    for (let index = 0; index < 2; index += 1) {
      store.calls.push({ id: randomUUID(), runId: randomUUID(), workspaceId: WS, stepKey: "concept", attemptNo: 1, providerKey: "qwen", model: "q-1",
        requestHash: "0".repeat(64), state: "completed", executorId: "earlier", providerRequestId: null, responseModel: null,
        usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null }, errorCode: null,
        createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
    }
    const result = await start();
    expect([result.status, (result.body as { error: { code: string; details: unknown } }).error]).toEqual([429,
      expect.objectContaining({ code: "TITLE_WRITING_DAILY_QUOTA_LOW", details: { requiredCalls: 1, remainingCalls: 0 } })]);
    expect([store.runs.length, seen.length]).toEqual([0, 0]);
  });

  it("completes one call, shows the frozen source and the output, and the title routes never see the run", async () => {
    const { service, title, episode, start, settle, runOf, seen } = setup();
    const started = await start();
    await settle();
    const latest = runOf(await service.latest(P1, episode.episodeId));
    expect(latest).toMatchObject({ runId: runOf(started).runId, state: "completed", save: "saved", episodeNo: 1, scriptRevisionNo: 1,
      targetEpisodeSeconds: 60, plannedTotalSeconds: 14, episodeScript: { currentRevisionNo: 1, approved: true } });
    expect(latest.output!.scenes.map((scene) => scene.heading)).toEqual(["便利店 夜", "天台 夜"]);
    expect(latest.scenes.map((scene) => scene.key)).toEqual(["S1", "S2"]);
    expect(seen).toHaveLength(1);
    expect((await title.latest(P1)).body).toEqual({ run: null });
    expect((await title.get(P1, latest.runId)).status).toBe(404);
    expect((await title.cancel(P1, latest.runId)).status).toBe(404);
    expect((await service.get(P1, randomUUID(), latest.runId)).status).toBe(404);
  });

  it("shows a script saved after the breakdown as a newer source; the old result stays and nothing is resent", async () => {
    const { store, service, episode, start, settle, runOf, seen } = setup();
    await start();
    await settle();
    store.writeScript(episode.episodeId, `${SCRIPT}\n场 3 码头\n老周：走。`);
    const latest = runOf(await service.latest(P1, episode.episodeId));
    expect(latest).toMatchObject({ scriptRevisionNo: 1, episodeScript: { currentRevisionNo: 2 } });
    expect(latest.scenes.every((scene) => scene.current.freshnessStatus === "STALE")).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("fails an invalid answer without a template or a second call, and resumes only on request", async () => {
    const { service, episode, start, settle, runOf, seen, store } = setup({
      override: (_step, attempt) => attempt === 1 ? { status: 200, body: chatAnswer({ schema: "ads.script-breakdown.output.v1", episodeNo: 1, scenes: [], shots: [] }) } : undefined,
    });
    const started = await start();
    await settle();
    let run = runOf(await service.get(P1, episode.episodeId, runOf(started).runId));
    expect([run.state, run.step.errorCode, run.save]).toEqual(["failed", "invalid_output", "pending"]);
    expect(store.scenes).toHaveLength(0);
    expect(seen).toHaveLength(1);
    const resumed = await service.resume(P1, episode.episodeId, run.runId, {}, TOKEN, CONTEXT(randomUUID()));
    expect(resumed.status).toBe(200);
    await settle();
    run = runOf(await service.get(P1, episode.episodeId, run.runId));
    expect([run.state, run.save, run.callsUsed]).toEqual(["completed", "saved", 2]);
  });

  it("writes shots only for approved scenes and reports the rest", async () => {
    const { store, service, episode, start, settle, runOf } = setup();
    const started = await start();
    await settle();
    const runId = runOf(started).runId;
    const before = await service.placeShots(P1, episode.episodeId, runId, {}, CONTEXT());
    expect(before.body).toMatchObject({ placement: { placed: [], awaitingApproval: ["S1", "S2"] } });
    store.approveScene(store.scenes.find((scene) => !scene.archived)!.sceneId);
    const after = await service.placeShots(P1, episode.episodeId, runId, {}, CONTEXT());
    expect(after.body).toMatchObject({ placement: { placed: ["S1"], awaitingApproval: ["S2"] } });
    expect(store.shots.map((shot) => shot.plannedDurationMs)).toEqual([3000, 4000]);
    expect((await service.placeShots(P1, episode.episodeId, randomUUID(), {}, CONTEXT())).status).toBe(404);
  });

  it("scene-change consent cannot attach an old breakdown to the next approved script", async () => {
    const { store, service, episode, start, settle, runOf, seen } = setup();
    const started = await start();
    await settle();
    const newScript = store.writeScript(episode.episodeId, `${SCRIPT}\n周野：这是第二版。`);
    for (const scene of store.scenes.filter((item) => !item.archived)) {
      const newScene = store.editScene(scene.sceneId, "按新剧本人工重写");
      scene.revisions.find((revision) => revision.id === newScene)!.sourceScriptRevisionId = newScript;
      store.approveScene(scene.sceneId);
    }
    const result = await service.placeShots(P1, episode.episodeId, runOf(started).runId, { acceptSceneChanged: true }, CONTEXT());
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: { code: "SCRIPT_BREAKDOWN_NOT_SAVED" } });
    expect(store.shots).toHaveLength(0);
    expect(seen).toHaveLength(1);
  });
});
