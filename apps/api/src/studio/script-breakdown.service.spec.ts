import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ScriptBreakdownRunView, TitleWritingProviderKey } from "@ai-drama/contracts";
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
  /** The same store and engine after an administrator changed the provider settings (a restart with other configuration). */
  const reconfigured = (env: TitleWritingProviderEnv, defaultProvider: TitleWritingProviderKey | null) =>
    new ScriptBreakdownService({ ...common, projects, providers: titleWritingProviderConfigs(env), defaultProvider });
  return { store, episode, service, title, seen, settle, start, runOf, pending, reconfigured };
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

describe("resuming a script breakdown only against its frozen, still current script", () => {
  const failFirst: Override = (_step, attempt) => attempt === 1
    ? { status: 200, body: chatAnswer({ schema: "ads.script-breakdown.output.v1", episodeNo: 1, scenes: [], shots: [] }) } : undefined;
  const changes: Array<[string, (store: InMemoryTitleWritingStore, episodeId: string) => void]> = [
    ["a newer approved script replaced it", (store, episodeId) => { store.writeScript(episodeId, `${SCRIPT}\n周野：第二版。`); }],
    ["a newer draft left the current script unapproved", (store, episodeId) => { store.writeScript(episodeId, `${SCRIPT}\n周野：草稿。`, false); }],
    ["the same revision went STALE upstream", (store, episodeId) => { store.staleScript(episodeId); }],
  ];

  for (const [label, change] of changes) {
    it(`refuses the resume before any reservation or send when ${label}`, async () => {
      const { store, service, episode, start, settle, runOf, seen } = setup({ override: failFirst });
      const runId = runOf(await start()).runId;
      await settle();
      change(store, episode.episodeId);
      const calls = store.calls.length;
      const resumed = await service.resume(P1, episode.episodeId, runId, {}, TOKEN, CONTEXT(randomUUID()));
      expect([resumed.status, (resumed.body as { error: { code: string } }).error.code]).toEqual([409, "SCRIPT_BREAKDOWN_SOURCE_CHANGED"]);
      await settle();
      const run = runOf(await service.get(P1, episode.episodeId, runId));
      // The run keeps its frozen source and its failed state; nothing was reserved, resumed, sent or written.
      expect([run.state, run.callsUsed, run.save, run.scriptRevisionNo]).toEqual(["failed", 1, "pending", 1]);
      expect([seen.length, store.calls.length, store.resumes.length, store.scenes.length]).toEqual([1, calls, 0, 0]);
    });
  }

  it("sends nothing when the script changes after the resume was accepted and before the call is reserved", async () => {
    const { store, service, episode, start, settle, runOf, seen } = setup({ override: failFirst });
    const runId = runOf(await start()).runId;
    await settle();
    const resumed = await service.resume(P1, episode.episodeId, runId, {}, TOKEN, CONTEXT(randomUUID()));
    expect(resumed.status).toBe(200);
    store.writeScript(episode.episodeId, `${SCRIPT}\n周野：续跑前改了。`);
    await settle();
    const run = runOf(await service.get(P1, episode.episodeId, runId));
    expect([run.state, run.errorCode, run.callsUsed, run.save]).toEqual(["needs_attention", "breakdown_source_changed", 1, "pending"]);
    expect([seen.length, store.calls.length, store.scenes.length]).toEqual([1, 1, 0]);
  });

  it("still resumes against a current, approved script", async () => {
    const { store, service, episode, start, settle, runOf, seen } = setup({ override: failFirst });
    const runId = runOf(await start()).runId;
    await settle();
    expect((await service.resume(P1, episode.episodeId, runId, {}, TOKEN, CONTEXT(randomUUID()))).status).toBe(200);
    await settle();
    const run = runOf(await service.get(P1, episode.episodeId, runId));
    expect([run.state, run.save, run.callsUsed, seen.length, store.resumes.length]).toEqual(["completed", "saved", 2, 2, 1]);
  });
});

describe("replaying a breakdown start after the provider settings changed", () => {
  const DEEPSEEK_TOO: TitleWritingProviderEnv = { ...ENV, DEEPSEEK_API_KEY: "sk-test-deepseek-not-real-0", TITLE_WRITING_DEEPSEEK_MODELS: "d-1" };

  it("answers the same request and key with the original run, without a second run or send", async () => {
    const { store, episode, start, settle, runOf, seen, reconfigured } = setup();
    const key = randomUUID();
    const first = runOf(await start({}, key));
    await settle();
    const replayWith = (service: ScriptBreakdownService, body: unknown = {}, episodeId = episode.episodeId) =>
      service.start(P1, episodeId, body, TOKEN, CONTEXT(key));
    for (const service of [
      reconfigured({ ...ENV, TITLE_WRITING_QWEN_MODELS: "q-2,q-1" }, null), // another default model
      reconfigured(DEEPSEEK_TOO, "deepseek"), // another default provider
      reconfigured({ ...ENV, DASHSCOPE_API_KEY: undefined }, null), // the original provider is no longer configured
      reconfigured({}, null), // no provider is configured at all
    ]) {
      const replay = await replayWith(service);
      expect([replay.status, runOf(replay).runId, runOf(replay).providerKey, runOf(replay).model]).toEqual([200, first.runId, "qwen", "q-1"]);
    }
    expect([store.runs.length, seen.length]).toEqual([1, 1]);
  });

  it("still refuses the key for another request, and checks a new request against the current settings", async () => {
    const { store, episode, start, settle, runOf, seen, reconfigured } = setup();
    const key = randomUUID();
    await start({}, key);
    await settle();
    const changed = reconfigured(DEEPSEEK_TOO, "deepseek");
    for (const body of [{ replaceExisting: true }, { providerKey: "deepseek" }, { providerKey: "qwen", model: "q-2" }]) {
      const other = await changed.start(P1, episode.episodeId, body, TOKEN, CONTEXT(key));
      expect([other.status, (other.body as { error: { code: string } }).error.code]).toEqual([409, "IDEMPOTENCY_KEY_REUSED"]);
    }
    const otherEpisode = store.addBreakdownEpisode({ workspaceId: WS, projectId: P1, episodeNo: 2, text: SCRIPT });
    const elsewhere = await changed.start(P1, otherEpisode.episodeId, {}, TOKEN, CONTEXT(key));
    expect([elsewhere.status, (elsewhere.body as { error: { code: string } }).error.code]).toEqual([409, "IDEMPOTENCY_KEY_REUSED"]);
    // A new key is a new request: it takes the current default provider, and an unconfigured provider is refused.
    const fresh = await changed.start(P1, otherEpisode.episodeId, {}, TOKEN, CONTEXT(randomUUID()));
    expect([fresh.status, runOf(fresh).providerKey, runOf(fresh).model]).toEqual([201, "deepseek", "d-1"]);
    const unconfigured = await reconfigured({}, null).start(P1, otherEpisode.episodeId, { replaceExisting: true }, TOKEN, CONTEXT(randomUUID()));
    expect([unconfigured.status, (unconfigured.body as { error: { code: string } }).error.code]).toEqual([503, "TITLE_WRITING_PROVIDER_UNCONFIGURED"]);
    // A replay still needs the operator token and a work the caller can reach.
    const wrongToken = await changed.start(P1, episode.episodeId, {}, "wrong-token-0000000000", CONTEXT(key));
    expect(wrongToken.status).toBe(403);
    await expect(changed.start("99999999-9999-4999-8999-999999999999", episode.episodeId, {}, TOKEN, CONTEXT(key))).rejects.toThrow(/not found/i);
    expect(seen).toHaveLength(1);
  });
});

describe("replaying an accepted resume", () => {
  const RESUME_KEY = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  // Both the first call and the resumed call are refused, so the run ends failed again after the accepted resume.
  const failTwice: Override = (_step, attempt) => attempt <= 2
    ? { status: 200, body: chatAnswer({ schema: "ads.script-breakdown.output.v1", episodeNo: 1, scenes: [], shots: [] }) } : undefined;
  const code = (result: { body: unknown }) => (result.body as { error?: { code: string } }).error?.code;

  it("returns the accepted resume's run after the provider was disabled, the source changed or the run moved on, without a send", async () => {
    const { store, service, episode, start, settle, runOf, seen, reconfigured } = setup({ override: failTwice });
    const runId = runOf(await start()).runId;
    await settle();
    const accepted = await service.resume(P1, episode.episodeId, runId, {}, TOKEN, CONTEXT(RESUME_KEY));
    expect([accepted.status, runOf(accepted).state]).toEqual([200, "running"]);
    await settle();
    expect([runOf(await service.get(P1, episode.episodeId, runId)).state, seen.length, store.resumes.length]).toEqual(["failed", 2, 1]);

    const disabled = reconfigured({}, null);
    const afterDisable = await disabled.resume(P1, episode.episodeId, runId, {}, TOKEN, CONTEXT(RESUME_KEY));
    expect([afterDisable.status, runOf(afterDisable).runId, runOf(afterDisable).state]).toEqual([200, runId, "failed"]);
    store.writeScript(episode.episodeId, `${SCRIPT}\n周野：换了剧本。`);
    const afterSource = await service.resume(P1, episode.episodeId, runId, {}, TOKEN, CONTEXT(RESUME_KEY));
    expect([afterSource.status, runOf(afterSource).state]).toEqual([200, "failed"]);
    // Nothing was prepared, reserved or sent by any replay.
    await settle();
    expect([seen.length, store.resumes.length, store.calls.length, runOf(await service.get(P1, episode.episodeId, runId)).state]).toEqual([2, 1, 2, "failed"]);

    // The key with another confirmation is another request; new resumes keep every gate.
    const other = await service.resume(P1, episode.episodeId, runId, { confirmUncertainCallIds: [randomUUID()] }, TOKEN, CONTEXT(RESUME_KEY));
    expect([other.status, code(other)]).toEqual([409, "IDEMPOTENCY_KEY_REUSED"]);
    expect(code(await disabled.resume(P1, episode.episodeId, runId, {}, TOKEN, CONTEXT(randomUUID())))).toBe("TITLE_WRITING_PROVIDER_UNCONFIGURED");
    const fresh = await service.resume(P1, episode.episodeId, runId, {}, TOKEN, CONTEXT(randomUUID()));
    expect([fresh.status, code(fresh)]).toEqual([409, "SCRIPT_BREAKDOWN_SOURCE_CHANGED"]);
    // A replay still needs the token and the run's own work and episode.
    expect((await disabled.resume(P1, episode.episodeId, runId, {}, "wrong-token-0000000000", CONTEXT(RESUME_KEY))).status).toBe(403);
    const elsewhere = store.addBreakdownEpisode({ workspaceId: WS, projectId: P1, episodeNo: 2, text: SCRIPT });
    expect((await disabled.resume(P1, elsewhere.episodeId, runId, {}, TOKEN, CONTEXT(RESUME_KEY))).status).toBe(404);
    expect([seen.length, store.resumes.length]).toEqual([2, 1]);
  });
});

describe("writing shots under an edited, approved scene", () => {
  it("builds the shot prompts from the approved revision the shots point to, and writes them once", async () => {
    const { store, service, episode, start, settle, runOf } = setup();
    const runId = runOf(await start()).runId;
    await settle();
    const [first, second] = store.scenes.filter((scene) => !scene.archived);
    const edited = store.editScene(first!.sceneId, "人工改了地点和时段", { heading: "码头", timeOfDay: "清晨" });
    const noTime = store.editScene(second!.sceneId, "人工去掉了时段", { heading: "旧仓库", timeOfDay: null });
    store.approveScene(first!.sceneId);
    store.approveScene(second!.sceneId);
    const refused = await service.placeShots(P1, episode.episodeId, runId, {}, CONTEXT());
    expect(refused.body).toMatchObject({ placement: { placed: [], sceneChanged: ["S1", "S2"] } });
    expect(store.shots).toHaveLength(0);
    const placed = await service.placeShots(P1, episode.episodeId, runId, { acceptSceneChanged: true }, CONTEXT());
    expect(placed.body).toMatchObject({ placement: { placed: ["S1", "S2"] } });
    const of = (sceneId: string) => store.shots.filter((shot) => shot.sceneId === sceneId);
    expect(of(first!.sceneId).map((shot) => shot.sourceSceneRevisionId)).toEqual([edited, edited]);
    expect(of(first!.sceneId).every((shot) => shot.promptText.startsWith("码头（清晨）；"))).toBe(true);
    expect(of(second!.sceneId).length).toBeGreaterThan(0);
    expect(of(second!.sceneId).every((shot) => shot.sourceSceneRevisionId === noTime && shot.promptText.startsWith("旧仓库；"))).toBe(true);
    expect(store.shots.some((shot) => /便利店|天台/.test(shot.promptText))).toBe(false);
    // Shot plan, dialogue and action stay as proposed.
    expect(of(first!.sceneId).map((shot) => shot.action)).toEqual(runOf(await service.get(P1, episode.episodeId, runId)).output!.shots.slice(0, 2).map((shot) => shot.action));
    const count = store.shots.length;
    await service.placeShots(P1, episode.episodeId, runId, { acceptSceneChanged: true }, CONTEXT());
    expect(store.shots).toHaveLength(count);
  });
});
