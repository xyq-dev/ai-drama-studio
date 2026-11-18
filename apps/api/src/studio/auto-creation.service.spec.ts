import { describe, expect, it } from "vitest";
import { AUTO_CREATION_CHECKS_VERSION, AUTO_CREATION_PROMPT_VERSION, autoCreationHardCap, autoCreationNormalCalls, type AutoCreationOptionsView, type AutoCreationRunView, type TitleWritingProviderKey } from "@ai-drama/contracts";
import { PersistenceError } from "@ai-drama/database";
import type { AutoOfficialVideoProbe, AutoOfficialVoiceProbe, AutoStoryboardImageProbe, FetchedPage } from "@ai-drama/domain";
import { AutoCreationEngine, InMemoryAutoCreationStore, hashAutoCreationInput, titleWritingProviderConfigs, type TitleWritingProviderEnv } from "@ai-drama/providers";
import { autoFixtureTransport, type AutoFixtureExchange, type AutoFixturePlan } from "@ai-drama/providers/title-writing-fixtures";
import { hashPassword } from "../auth/password-hash";
import { SiteAuth } from "../auth/site-auth";
import { AutoCreationController } from "./auto-creation.controller";
import { AutoCreationService } from "./auto-creation.service";
import type { RealMediaConfiguration } from "@ai-drama/contracts";

/** The automatic creation API boundary against the in-process store and the model double (no network, no database). */
const WS = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const TOKEN = "operator-token-0123456789";
const BOTH: TitleWritingProviderEnv = {
  ANTHROPIC_API_KEY: "sk-ant-api03-test-not-a-real-key-000", TITLE_WRITING_ANTHROPIC_MODELS: "m-1",
  OPENAI_API_KEY: "sk-openai-test-not-real-0000", TITLE_WRITING_OPENAI_MODELS: "o-1",
};
const CONTEXT = (key: string) => ({ actorId: "server-owner", traceId: "t", idempotencyKey: key });

interface Setup {
  plan?: { episodeCount: number; targetEpisodeSeconds: number | null };
  enabled?: boolean;
  env?: TitleWritingProviderEnv;
  defaultProvider?: TitleWritingProviderKey | null;
  maxCallsPerDay?: number;
  fixture?: AutoFixturePlan;
  fetchEnabled?: boolean;
  /** The same store as an earlier setup (a restarted API with other settings). */
  store?: InMemoryAutoCreationStore;
  /** The page reader the engine has (the runtime wires one exactly when fetchEnabled). */
  fetchPages?: (urls: readonly string[]) => Promise<FetchedPage[]>;
  seen?: AutoFixtureExchange[];
  mediaImageProbe?: () => Promise<AutoStoryboardImageProbe>;
  mediaVoiceProbe?: () => Promise<AutoOfficialVoiceProbe>;
  mediaVideoProbe?: () => Promise<AutoOfficialVideoProbe>;
}

function sunburstConfig(overrides: Partial<RealMediaConfiguration> = {}): RealMediaConfiguration {
  return {
    id: "11111111-1111-4111-8111-111111111111", version: "v1", providerKey: "openai-media", capability: "image.generate",
    model: "gpt-image-2.5-sunburst", region: "image.example.test", credentialRef: "env:openai-media", credentialVersion: "v1",
    enabled: true, queryAllowed: true, priceVersion: "fixture-v1", currency: "USD", unitPrice: "0.04", unitType: "image",
    parameters: { baseUrl: "https://image.example.test", quality: "max", size: "1024x1536" }, ...overrides,
  };
}

function setup(options: Setup = {}) {
  const store = options.store ?? new InMemoryAutoCreationStore();
  const plan = options.plan ?? { episodeCount: 1, targetEpisodeSeconds: 60 };
  if (!options.store) store.addProject(WS, P1, plan.episodeCount);
  const seen: AutoFixtureExchange[] = options.seen ?? [];
  const providers = titleWritingProviderConfigs(options.env ?? BOTH);
  const maxCallsPerDay = options.maxCallsPerDay ?? 30;
  const engine = new AutoCreationEngine({ workspaceId: WS, store, providers, transport: autoFixtureTransport({ seen, plan: options.fixture }), maxCallsPerDay,
    ...(options.fetchPages ? { fetchPages: options.fetchPages } : {}) });
  const pending: Array<() => Promise<void>> = [];
  const service = new AutoCreationService({
    workspaceId: WS, enabled: options.enabled ?? true, operatorToken: TOKEN, defaultProvider: options.defaultProvider ?? null, providers, store, engine,
    projects: {
      getProject: async (_workspaceId: string, projectId: string) => {
        if (projectId !== P1) throw new PersistenceError("NOT_FOUND", "Project not found");
        return { id: projectId } as never;
      },
      getProjectEpisodePlan: async () => plan as never,
      episodePlanReady: async () => true,
    },
    maxCallsPerDay, maxActiveRuns: 1,
    research: { fetchEnabled: options.fetchEnabled ?? false, allowedHosts: ["support.oceanengine.com"] },
    schedule: (work) => { pending.push(work); },
    ...(options.mediaImageProbe ? { mediaImageProbe: options.mediaImageProbe } : {}),
    ...(options.mediaVoiceProbe ? { mediaVoiceProbe: options.mediaVoiceProbe } : {}),
    ...(options.mediaVideoProbe ? { mediaVideoProbe: options.mediaVideoProbe } : {}),
  });
  const settle = async () => { while (pending.length > 0) await pending.shift()!(); };
  const run = async (runId: string) => ((await service.get(P1, runId)).body as { run: AutoCreationRunView }).run;
  return { store, service, seen, settle, run, pending, providers };
}

/**
 * Leaves a run as a stored run of the old prompt was left: every stage up to the episodes completed, the review not
 * sent, the run stopped at prompt_too_large. The stop happens where the reservation would be, with the engine's own
 * finishRun; nothing is sent for the review.
 */
async function stopBeforeReview(store: InMemoryAutoCreationStore, runId: string, providers: ReturnType<typeof titleWritingProviderConfigs>, seen: AutoFixtureExchange[]) {
  const wrapper = Object.create(store) as InMemoryAutoCreationStore;
  wrapper.reserveCall = async (call, limits, nowIso, leaseUntil) => {
    if (call.stageKey !== "review:1") return store.reserveCall(call, limits, nowIso, leaseUntil);
    await store.finishRun(WS, call.runId, call.executorId, "needs_attention", "prompt_too_large", nowIso);
    return { kind: "lost" };
  };
  await new AutoCreationEngine({ workspaceId: WS, store: wrapper, providers, transport: autoFixtureTransport({ seen }), maxCallsPerDay: 30 }).drive(runId);
}

/** What a refused resume must leave unchanged: the run, its stages, its calls and the resume records. */
function snapshot(store: InMemoryAutoCreationStore, runId: string) {
  return structuredClone({ run: store.runs.find((item) => item.id === runId), stages: store.stages.filter((item) => item.runId === runId),
    calls: store.calls.filter((item) => item.runId === runId), resumes: store.resumes.filter((item) => item.runId === runId) });
}

/** Leaves a stored run as older code froze it: that code's versions in its input and the hash it computed over them. */
function asStoredBy(store: InMemoryAutoCreationStore, runId: string, version: "v1" | "v2") {
  const run = store.runs.find((item) => item.id === runId)!;
  const { autoStoryboardAfterScripts: _oldRunHasNoPreference, ...historical } = run.input;
  run.input = { ...historical, promptVersion: `ads.auto-creation.prompt.${version}`, checksVersion: `ads.auto-creation.checks.${version}` };
  run.inputHash = hashAutoCreationInput(run.projectId, run.input);
}

const errorCode = (body: unknown) => (body as { error?: { code?: string } }).error?.code;

describe("automatic creation API", () => {
  it("exposes a ranking refusal excerpt only to the signed-in GET reader until resume clears it", async () => {
    const { service, store, settle } = setup({ fixture: { verificationSample: "ranking" } });
    const started = await service.start(P1, { revisionRounds: 0, callBudget: 7 }, TOKEN, CONTEXT("rank-rejection"));
    const runId = (started.body as { run: AutoCreationRunView }).run.runId;
    await settle();

    const publicStage = (body: unknown) => (body as { run: AutoCreationRunView }).run.stages.find(({ stageKey }) => stageKey === "research");
    const excerpt = /计划在第一轮试读后比较排名第一的作品/u;
    const storedStage = store.stages.find(({ stageKey }) => stageKey === "research");
    expect(storedStage).toMatchObject({ state: "rejected", output: null, outputHash: null, dependsOn: null,
      rejectionDiagnostic: { excerpt: expect.stringMatching(excerpt), truncated: false } });
    expect(JSON.stringify(store.calls)).not.toMatch(excerpt);
    expect(publicStage((await service.get(P1, runId)).body)).not.toHaveProperty("rejectionDiagnostic");
    for (const format of ["json", "markdown"]) expect((await service.package(P1, runId, format)).download?.text).not.toMatch(excerpt);

    const origin = "http://127.0.0.1";
    const password = "only-used-in-this-local-test";
    const passwordHash = await hashPassword(password, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
    const auth = new SiteAuth({ username: "test-user", passwordHash, publicOrigin: origin });
    const client = new AutoCreationController(service, { kind: "enabled", auth });
    const { cookies } = await auth.login({ origin, "content-type": "application/json" }, { username: "test-user", password });
    const cookie = cookies.map((item) => item.split(";", 1)[0]).join("; ");
    const response = { status() {}, setHeader() {} };
    const signedIn = { cookie };
    for (const body of [await client.latest(P1, response, signedIn), await client.get(P1, runId, response, signedIn)]) {
      expect(publicStage(body)).toMatchObject({ rejectionDiagnostic: { excerpt: expect.stringMatching(excerpt), truncated: false } });
    }
    expect(publicStage(await client.get(P1, runId, response, { cookie: `${auth.sessionCookie}=invalid` }))).not.toHaveProperty("rejectionDiagnostic");
    const disabled = new AutoCreationController(service, { kind: "disabled" });
    expect(publicStage(await disabled.get(P1, runId, response, signedIn))).not.toHaveProperty("rejectionDiagnostic");

    const restart = setup({ store });
    const restarted = new AutoCreationController(restart.service, { kind: "enabled", auth });
    const resumed = await restart.service.resume(P1, runId, {}, TOKEN, CONTEXT("rank-resume"));
    expect(resumed.status).toBe(200);
    expect(storedStage).not.toHaveProperty("rejectionDiagnostic");
    expect(publicStage(await restarted.get(P1, runId, response, signedIn))).not.toHaveProperty("rejectionDiagnostic");
    await restart.settle();
    expect(publicStage(await restarted.get(P1, runId, response, signedIn))).toMatchObject({ state: "completed" });
    expect(JSON.stringify(store.stages)).not.toMatch(excerpt);
  });

  it("never keeps a ranking excerpt carrying a JSON-escaped echo of the active provider key", async () => {
    const syntheticKey = "只供替身测试的随机串";
    const escapedKey = [...syntheticKey].map((char) => `\\u${char.charCodeAt(0).toString(16)}`).join("");
    const rawEcho = JSON.stringify(escapedKey).slice(1, -1);
    const { service, store, providers, run } = setup({ defaultProvider: "openai", env: { ...BOTH, OPENAI_API_KEY: syntheticKey } });
    const transport = autoFixtureTransport({ plan: { verificationSample: "ranking" } });
    const engine = new AutoCreationEngine({ workspaceId: WS, store, providers, maxCallsPerDay: 30, transport: async (request) => {
      const response = await transport(request);
      const original = new TextDecoder().decode(response.body ?? undefined);
      const withEcho = original.replace("排名第一的作品", `排名第一的作品${rawEcho}`);
      return { ...response, body: new TextEncoder().encode(withEcho) };
    } });
    const started = await service.start(P1, { revisionRounds: 0 }, TOKEN, CONTEXT("rank-key-echo"));
    expect(started.status).toBe(201);
    const runId = (started.body as { run: AutoCreationRunView }).run.runId;
    await engine.drive(runId);

    expect(await run(runId)).toMatchObject({ state: "failed", errorCode: "unsourced_number", callsUsed: 1 });
    const rejected = store.stages.find(({ stageKey }) => stageKey === "research");
    expect(rejected).toMatchObject({ state: "rejected", output: null,
      errorCode: "unsourced_number@hypotheses[0].howToVerify:rank+market_statistic+ranking" });
    expect(rejected).not.toHaveProperty("rejectionDiagnostic");
    expect(JSON.stringify({ stages: store.stages, calls: store.calls })).not.toContain(syntheticKey);
  });

  it("validates and freezes the quote preference without granting media authorization on start or replay", async () => {
    const { service, store, pending } = setup();
    expect((await service.start(P1, { autoStoryboardAfterScripts: "true" }, TOKEN, CONTEXT("invalid"))).status).toBe(400);
    expect(store.runs).toHaveLength(0);
    const context = CONTEXT("storyboards");
    const started = await service.start(P1, { autoStoryboardAfterScripts: true }, TOKEN, context);
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ run: { autoStoryboardAfterScripts: true, state: "running" } });
    expect(store.runs[0]?.input.autoStoryboardAfterScripts).toBe(true);
    expect((await service.start(P1, { autoStoryboardAfterScripts: true }, TOKEN, context)).status).toBe(200);
    expect(errorCode((await service.start(P1, {}, TOKEN, context)).body)).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(pending).toHaveLength(1);
    expect(store.calls).toHaveLength(0);
  });

  it("options name the real provider, the research limits and the missing media capabilities", async () => {
    const { service } = setup({ defaultProvider: "anthropic" });
    const options = (await service.options()).body as AutoCreationOptionsView;
    expect(options).toMatchObject({ code: "AUTO_CREATION_READY", defaultProvider: "anthropic", billing: "unknown", maxOutputTokensPerCall: 4096 });
    expect(options.episodePlan).toMatchObject({ defaultEpisodes: 1, defaultSeconds: 60, maxEpisodes: 6 });
    expect(options.research).toMatchObject({ fetchEnabled: false, readableMarketSources: 0, expectedMode: "limited", visualAnalysis: false });
    expect(options.media).toMatchObject({ realProviders: [], mockOnly: true });
    expect(options.media.missing.some((item) => item.includes("OpenAI 生图未接通") || item.includes("正式配音") || item.includes("真实视频"))).toBe(true);
  });

  it("options report OpenAI image connected only for openai-media + enabled sunburst, never via writing OPENAI_API_KEY", async () => {
    const disconnected = (await setup({
      mediaImageProbe: async () => ({
        imageProvider: undefined, mediaApiKeyPresent: false, configuration: null,
      }),
    }).service.options()).body as AutoCreationOptionsView;
    expect(disconnected.media).toMatchObject({ realProviders: [], mockOnly: true });
    expect(disconnected.media.missing.some((item) => item.includes("OPENAI_MEDIA_API_KEY"))).toBe(true);
    expect(disconnected.media.missing.join("\n")).toContain("不是写作 OPENAI_API_KEY");
    expect(JSON.stringify(disconnected.media)).not.toMatch(/sk-[a-z0-9-]+/i);

    const writingKeyOnly = (await setup({
      env: BOTH,
      mediaImageProbe: async () => ({
        // Writing key is present in env, but the probe must not treat it as media authorization.
        imageProvider: "openai-media", mediaApiKeyPresent: false, configuration: null,
      }),
    }).service.options()).body as AutoCreationOptionsView;
    expect(writingKeyOnly.media.realProviders).toEqual([]);
    expect(writingKeyOnly.media.mockOnly).toBe(true);

    const connected = (await setup({
      mediaImageProbe: async () => ({
        imageProvider: "openai-media", mediaApiKeyPresent: true, configuration: sunburstConfig(),
      }),
    }).service.options()).body as AutoCreationOptionsView;
    expect(connected.media).toMatchObject({ realProviders: ["openai-media"], mockOnly: false });
    expect(connected.media.missing.some((item) => item.includes("正式配音") || item.includes("语音"))).toBe(true);
    expect(connected.media.missing.some((item) => item.includes("真实视频") || item.includes("成片"))).toBe(true);
    expect(connected.media.missing.every((item) => !item.includes("OpenAI 生图未接通"))).toBe(true);

    const wrongModel = (await setup({
      mediaImageProbe: async () => ({
        imageProvider: "openai-media", mediaApiKeyPresent: true, configuration: sunburstConfig({ model: "dall-e-3" }),
      }),
    }).service.options()).body as AutoCreationOptionsView;
    expect(wrongModel.media).toMatchObject({ realProviders: [], mockOnly: true });

    const budgetTooLow = (await setup({
      mediaImageProbe: async () => ({
        imageProvider: "openai-media", mediaApiKeyPresent: true,
        configuration: sunburstConfig({ unitPrice: "0.04", maximumOperationAmount: "0.01" }),
      }),
    }).service.options()).body as AutoCreationOptionsView;
    expect(budgetTooLow.media).toMatchObject({ realProviders: [], mockOnly: true });
    expect(budgetTooLow.media.missing.some((item) => item.includes("单次费用上限"))).toBe(true);
  });

  it("options report MiniMax voice and wan2.6 video from probes, never via ElevenLabs/Bailian/writing keys", async () => {
    const minimaxConfig = (): RealMediaConfiguration => ({
      id: "22222222-2222-4222-8222-222222222222", version: "mm-v1", providerKey: "minimax-tts", capability: "audio.tts",
      model: "speech-2.8-hd", region: "api.minimaxi.com", credentialRef: "env:minimax-tts", credentialVersion: "v1",
      enabled: true, queryAllowed: true, priceVersion: "fixture-v1", currency: "CNY", unitPrice: "0.0002", unitType: "character",
      maximumOperationAmount: "10", parameters: { baseUrl: "https://api.minimaxi.com", outputFormat: "wav", sampleRate: 44100 },
    });
    const videoConfig = (): RealMediaConfiguration => ({
      id: "33333333-3333-4333-8333-333333333333", version: "video-v1", providerKey: "dashscope-media", capability: "video.generate",
      model: "wan2.6-i2v-flash", region: "beijing", credentialRef: "env:dashscope-media", credentialVersion: "v1",
      enabled: true, queryAllowed: true, priceVersion: "fixture-v1", currency: "CNY", unitPrice: "0.05", unitType: "second",
      maximumOperationAmount: "10", parameters: { duration: 5 },
    });

    const voiceOnly = (await setup({
      mediaVoiceProbe: async () => ({
        minimaxApiKeyPresent: true, unitPricePresent: true, priceVersionPresent: true, baseUrlCompliant: true,
        configuration: minimaxConfig(), webPathAcceptsMinimax: true,
      }),
    }).service.options()).body as AutoCreationOptionsView;
    expect(voiceOnly.media.realProviders).toEqual(["minimax-tts"]);
    expect(voiceOnly.media.mockOnly).toBe(false);
    expect(voiceOnly.media.missing.some((item) => item.includes("正式配音未接通"))).toBe(false);
    expect(voiceOnly.media.missing.some((item) => item.includes("真实视频") || item.includes("成片"))).toBe(true);

    const rejectedPath = (await setup({
      mediaVoiceProbe: async () => ({
        minimaxApiKeyPresent: true, unitPricePresent: true, priceVersionPresent: true, baseUrlCompliant: true,
        configuration: minimaxConfig(), webPathAcceptsMinimax: false,
      }),
    }).service.options()).body as AutoCreationOptionsView;
    expect(rejectedPath.media.realProviders).toEqual([]);
    expect(rejectedPath.media.missing.some((item) => item.includes("网页主路径仍拒绝 minimax-tts"))).toBe(true);

    const all = (await setup({
      mediaImageProbe: async () => ({ imageProvider: "openai-media", mediaApiKeyPresent: true, configuration: sunburstConfig() }),
      mediaVoiceProbe: async () => ({
        minimaxApiKeyPresent: true, unitPricePresent: true, priceVersionPresent: true, baseUrlCompliant: true,
        configuration: minimaxConfig(), webPathAcceptsMinimax: true,
      }),
      mediaVideoProbe: async () => ({
        dashscopeApiKeyPresent: true, unitPricePresent: true, priceVersionPresent: true, configuration: videoConfig(),
        chinesePromptGateReady: true, shotComposeEnabled: true, episodeComposeEnabled: true,
      }),
    }).service.options()).body as AutoCreationOptionsView;
    expect(all.media.realProviders).toEqual(["openai-media", "minimax-tts", "dashscope-media"]);
    expect(all.media.mockOnly).toBe(false);
    expect(all.media.missing).toEqual(["剧本拆解功能（服务端关闭，不会写入分镜生产数据）"]);
    expect(JSON.stringify(all.media)).not.toMatch(/sk-|api[_-]?key\s*=/i);
    expect(all.media.missing.every((item) => !item.includes("当前只有演示素材"))).toBe(true);
  });

  it("an empty body runs the whole default flow once; replaying the key returns the same run and sends nothing", async () => {
    const { service, seen, settle, run, store } = setup();
    const started = await service.start(P1, {}, TOKEN, CONTEXT("k-1"));
    expect(started.status).toBe(201);
    const runId = (started.body as { run: AutoCreationRunView }).run.runId;
    await settle();
    const done = await run(runId);
    expect(done).toMatchObject({ state: "completed", quality: "passed", callsUsed: autoCreationNormalCalls(1), callCap: autoCreationHardCap(1, 2),
      packageStatus: "ready", videoStatus: "not_started", authorization: { mode: "auto", proof: "operator_token", executor: "auto-creation-engine" } });
    const replay = await service.start(P1, {}, TOKEN, CONTEXT("k-1"));
    expect(replay.status).toBe(200);
    expect((replay.body as { run: AutoCreationRunView }).run.runId).toBe(runId);
    await settle();
    expect(seen).toHaveLength(autoCreationNormalCalls(1));
    expect(store.runs).toHaveLength(1);
    expect(errorCode((await service.start(P1, { idea: "别的想法" }, TOKEN, CONTEXT("k-1"))).body)).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  // v2 is what the deployed baseline (cf1ef29) freezes; v1 came before it. Neither is rehashed under v3.
  it.each(["v1", "v2"] as const)("a run frozen by the %s code answers its own key and request after the upgrade: 200, the same run, nothing written or sent", async (version) => {
    const { service, seen, settle, store, pending } = setup();
    const request = { revisionRounds: 0, callBudget: 6 };
    const started = await service.start(P1, request, TOKEN, CONTEXT("k-v1"));
    const runId = (started.body as { run: AutoCreationRunView }).run.runId;
    await settle();
    asStoredBy(store, runId, version);
    const before = snapshot(store, runId);
    const sent = seen.length;
    const replay = await service.start(P1, request, TOKEN, CONTEXT("k-v1"));
    expect(replay.status).toBe(200);
    expect((replay.body as { run: AutoCreationRunView }).run.runId).toBe(runId);
    expect(pending).toHaveLength(0);
    await settle();
    expect(seen).toHaveLength(sent);
    expect(store.runs).toHaveLength(1);
    expect(snapshot(store, runId)).toEqual(before);
    expect(before.run!.input).toMatchObject({ promptVersion: `ads.auto-creation.prompt.${version}`, checksVersion: `ads.auto-creation.checks.${version}` });
    // Other business content under the same key is still another request.
    for (const changed of [{ ...request, idea: "别的想法" }, { ...request, callBudget: 7 }, { ...request, model: "o-1", providerKey: "openai" }, {}]) {
      expect(errorCode((await service.start(P1, changed, TOKEN, CONTEXT("k-v1"))).body)).toBe("IDEMPOTENCY_KEY_REUSED");
    }
    // The versions are the server's: a request naming them is refused, not matched.
    expect((await service.start(P1, { ...request, promptVersion: `ads.auto-creation.prompt.${version}` }, TOKEN, CONTEXT("k-v1"))).status).toBe(400);
    // Another person's same key never reaches this run.
    const other = await service.start(P1, request, TOKEN, { ...CONTEXT("k-v1"), actorId: "someone-else" });
    expect(other.status).toBe(409);
    expect(errorCode(other.body)).toBe("AUTO_CREATION_PROJECT_NOT_EMPTY");
    expect(pending).toHaveLength(0);
    expect(seen).toHaveLength(sent);
    expect(snapshot(store, runId)).toEqual(before);
  });

  it("a new run freezes the current versions, and its own replay stays 200", async () => {
    const { service, settle, store } = setup();
    const started = await service.start(P1, {}, TOKEN, CONTEXT("k-v2"));
    expect(started.status).toBe(201);
    await settle();
    expect(store.runs[0]!.input).toMatchObject({ promptVersion: AUTO_CREATION_PROMPT_VERSION, checksVersion: AUTO_CREATION_CHECKS_VERSION });
    expect((await service.start(P1, {}, TOKEN, CONTEXT("k-v2"))).status).toBe(200);
  });

  it("a second key on the same work is refused while it runs and afterwards (never overwritten)", async () => {
    const { service, settle } = setup();
    await service.start(P1, {}, TOKEN, CONTEXT("k-1"));
    expect(errorCode((await service.start(P1, {}, TOKEN, CONTEXT("k-2"))).body)).toBe("AUTO_CREATION_RUN_ACTIVE");
    await settle();
    expect(errorCode((await service.start(P1, {}, TOKEN, CONTEXT("k-3"))).body)).toBe("AUTO_CREATION_PROJECT_NOT_EMPTY");
  });

  it("refuses before any write or send: off, no operator, no plan, plan mismatch, budget too low or too high", async () => {
    const off = setup({ enabled: false });
    expect((await off.service.start(P1, {}, TOKEN, CONTEXT("a"))).status).toBe(404);
    const ctx = setup();
    expect((await ctx.service.start(P1, {}, "wrong", CONTEXT("a"))).status).toBe(403);
    expect(errorCode((await ctx.service.start(P1, { episodeCount: 3 }, TOKEN, CONTEXT("b"))).body)).toBe("AUTO_CREATION_PLAN_MISMATCH");
    expect(errorCode((await ctx.service.start(P1, { callBudget: autoCreationNormalCalls(1) - 1 }, TOKEN, CONTEXT("c"))).body)).toBe("AUTO_CREATION_BUDGET_TOO_LOW");
    expect(errorCode((await ctx.service.start(P1, { callBudget: autoCreationHardCap(1, 2) + 1 }, TOKEN, CONTEXT("d"))).body)).toBe("AUTO_CREATION_BUDGET_TOO_HIGH");
    expect(errorCode((await ctx.service.start(P1, { referenceUrls: ["https://support.oceanengine.com/x"] }, TOKEN, CONTEXT("e"))).body)).toBe("AUTO_CREATION_RESEARCH_FETCH_DISABLED");
    expect(errorCode((await ctx.service.start(P1, { role: "reviewer" }, TOKEN, CONTEXT("f"))).body)).toBe("VALIDATION_ERROR");
    expect(errorCode((await ctx.service.start(P1, { providerAdapter: "deepseek.chat-completions.v1" }, TOKEN, CONTEXT("g"))).body)).toBe("VALIDATION_ERROR");
    const legacy = setup({ plan: { episodeCount: 3, targetEpisodeSeconds: null } });
    expect(errorCode((await legacy.service.start(P1, {}, TOKEN, CONTEXT("h"))).body)).toBe("AUTO_CREATION_PLAN_REQUIRED");
    expect(ctx.store.runs).toHaveLength(0);
    expect(ctx.seen).toHaveLength(0);
  });

  it("a configured default provider that is not usable is reported, never replaced by a ready one", async () => {
    const { service, store, seen } = setup({ defaultProvider: "deepseek" });
    const refused = await service.start(P1, {}, TOKEN, CONTEXT("k"));
    expect(refused.status).toBe(503);
    expect(errorCode(refused.body)).toBe("AUTO_CREATION_PROVIDER_UNCONFIGURED");
    expect(store.runs).toHaveLength(0);
    expect(seen).toHaveLength(0);
    // An explicit choice of a ready provider is honored, and only that provider is called.
    const chosen = await service.start(P1, { providerKey: "openai" }, TOKEN, CONTEXT("k2"));
    expect(chosen.status).toBe(201);
  });

  it("too few calls left in the shared daily cap: no run, no call", async () => {
    const { service, store, seen } = setup({ maxCallsPerDay: 10 });
    for (let index = 0; index < 5; index += 1) store.otherCalls.push({ workspaceId: WS, createdAt: new Date().toISOString() });
    const refused = await service.start(P1, {}, TOKEN, CONTEXT("k"));
    expect(refused.status).toBe(429);
    expect((refused.body as { error: { details: unknown } }).error.details).toEqual({ requiredCalls: 6, remainingCalls: 5 });
    expect(store.runs).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });

  it("an idea and hard constraints are frozen into the run as sent", async () => {
    const { service, settle, run } = setup();
    const started = await service.start(P1, { idea: "骑手讨工资", constraints: { maxCharacters: 3, endingRequirement: "主角赢回尊严" } }, TOKEN, CONTEXT("k"));
    const runId = (started.body as { run: AutoCreationRunView }).run.runId;
    await settle();
    const done = await run(runId);
    expect(done.idea).toBe("骑手讨工资");
    expect(done.constraints).toMatchObject({ maxCharacters: 3, endingRequirement: "主角赢回尊严" });
    expect(done.state).toBe("completed");
  });

  it("scripts go into the work only after a person approves the story; the package downloads as Markdown and JSON", async () => {
    const { service, settle, store } = setup({ plan: { episodeCount: 3, targetEpisodeSeconds: 60 } });
    const started = await service.start(P1, {}, TOKEN, CONTEXT("k"));
    const runId = (started.body as { run: AutoCreationRunView }).run.runId;
    await settle();
    expect(errorCode((await service.placeScripts(P1, runId, {}, CONTEXT("p"))).body)).toBe("AUTO_CREATION_STORY_NOT_APPROVED");
    store.approveCurrentStory(P1);
    const placed = await service.placeScripts(P1, runId, {}, CONTEXT("p"));
    expect((placed.body as { run: AutoCreationRunView }).run.stages.filter((stage) => stage.kind === "episode").map((stage) => stage.scriptSave))
      .toEqual(["saved", "saved", "saved"]);
    const markdown = await service.package(P1, runId, "markdown");
    expect(markdown.download?.contentType).toContain("text/markdown");
    expect(markdown.download?.text).toContain("视频成片：未开始");
    const json = await service.package(P1, runId, "json");
    expect(JSON.parse(json.download!.text)).toMatchObject({ schema: "ads.auto-creation.package.v1", status: { video: "not_started" } });
    expect((await service.package(P1, runId, "pdf")).status).toBe(400);
  });

  it("a run stopped at prompt_too_large by the old prompt now continues into its review alone, reusing every saved stage", async () => {
    const { service, settle, run, seen, store, providers } = setup({ plan: { episodeCount: 6, targetEpisodeSeconds: 60 }, fixture: { crowdedCast: true } });
    const runId = ((await service.start(P1, {}, TOKEN, CONTEXT("k"))).body as { run: AutoCreationRunView }).run.runId;
    const before: AutoFixtureExchange[] = [];
    await stopBeforeReview(store, runId, providers, before);
    expect(before.map((item) => item.stage)).toEqual(["research", "directions", "bible", "outline", "episode:1", "episode:2", "episode:3", "episode:4", "episode:5", "episode:6"]);
    const stopped = await run(runId);
    expect(stopped).toMatchObject({ state: "needs_attention", errorCode: "prompt_too_large", callsUsed: 10, resumeBlock: null });
    const resumed = await service.resume(P1, runId, {}, TOKEN, CONTEXT("r-1"));
    expect(resumed.status).toBe(200);
    await settle();
    // The ten completed stages are reused: the first send is the review, then only the budgeted rounds.
    expect(seen[0]!.stage).toBe("review:1");
    expect(seen.filter((item) => ["research", "directions", "bible", "outline"].includes(item.stage) || /^episode:/.test(item.stage))).toEqual([]);
    expect(await run(runId)).toMatchObject({ state: "completed", callsUsed: 10 + seen.length });
  });

  it("a stopped run whose next request cannot be built is refused before any record, reset or send; the page is told", async () => {
    const { service, settle, run, seen, store, providers } = setup({ plan: { episodeCount: 6, targetEpisodeSeconds: 60 } });
    const runId = ((await service.start(P1, {}, TOKEN, CONTEXT("k"))).body as { run: AutoCreationRunView }).run.runId;
    await stopBeforeReview(store, runId, providers, []);
    // A stored run of the old code whose saved episodes are larger than any review prompt can carry.
    const episode = store.stages.find((item) => item.runId === runId && item.stageKey === "episode:1")!;
    (episode.output as { scenes: Array<{ action: string }> }).scenes[0]!.action = "长".repeat(45_000);
    expect((await run(runId)).resumeBlock).toBe("prompt_too_large");
    const unchanged = snapshot(store, runId);
    const refused = await service.resume(P1, runId, {}, TOKEN, CONTEXT("r-1"));
    expect(refused.status).toBe(409);
    expect(errorCode(refused.body)).toBe("AUTO_CREATION_PROMPT_TOO_LARGE");
    await settle();
    expect(snapshot(store, runId)).toEqual(unchanged);
    expect(seen).toHaveLength(0);
    // The same key again: still refused, still nothing written (the refusal is not a resume the key could replay).
    expect(errorCode((await service.resume(P1, runId, {}, TOKEN, CONTEXT("r-1"))).body)).toBe("AUTO_CREATION_PROMPT_TOO_LARGE");
    expect(snapshot(store, runId)).toEqual(unchanged);
  });

  it("a run that froze page reading stops at its sources when reading is off after a restart, and continues once it is back", async () => {
    const reference = "https://support.oceanengine.com/help/content/reference-1";
    const seen: AutoFixtureExchange[] = [];
    // Started with reading on; the API restarts with reading off before the run's first stage.
    const first = setup({ fetchEnabled: true, fetchPages: async () => [], seen });
    const started = await first.service.start(P1, { referenceUrls: [reference] }, TOKEN, CONTEXT("k"));
    expect(started.status).toBe(201);
    const runId = (started.body as { run: AutoCreationRunView }).run.runId;
    expect(first.store.runs[0]!.input.researchFetch).toBe(true);
    const off = setup({ store: first.store, fetchEnabled: false, seen });
    await off.service.maintain();
    const stopped = await off.run(runId);
    expect(stopped).toMatchObject({ state: "needs_attention", errorCode: "research_fetch_unavailable", callsUsed: 0, resumeBlock: "research_fetch_unavailable" });
    expect(stopped.stages.find((stage) => stage.stageKey === "sources")!.state).toBe("pending");
    expect(seen).toHaveLength(0);
    // The reference URL is kept with the run, never recorded as read or dropped.
    expect(first.store.runs[0]!.input.referenceUrls).toEqual([reference]);
    const unchanged = snapshot(first.store, runId);
    const refused = await off.service.resume(P1, runId, {}, TOKEN, CONTEXT("r-1"));
    expect(refused.status).toBe(503);
    expect(errorCode(refused.body)).toBe("AUTO_CREATION_RESEARCH_UNAVAILABLE");
    await off.settle();
    expect(snapshot(first.store, runId)).toEqual(unchanged);
    expect(seen).toHaveLength(0);
    // Reading is back: the run continues from its sources, reads the page it froze, and sends each stage once.
    const read: string[][] = [];
    const on = setup({ store: first.store, fetchEnabled: true, seen, fetchPages: async (urls) => {
      read.push([...urls]);
      return urls.map((url) => ({ url, status: "unreadable" as const, title: null, text: "", publishedAt: null, fetchedAt: new Date().toISOString(), note: "替身：没有读到正文。" }));
    } });
    expect((await on.run(runId)).resumeBlock).toBeNull();
    const resumed = await on.service.resume(P1, runId, {}, TOKEN, CONTEXT("r-2"));
    expect(resumed.status).toBe(200);
    await on.settle();
    expect(read).toEqual([[reference]]);
    const done = await on.run(runId);
    expect(done.state).toBe("completed");
    const sources = done.stages.find((stage) => stage.stageKey === "sources")!.output as { sources: Array<{ locator: string; status: string }> };
    expect(sources.sources.find((item) => item.locator === reference)).toMatchObject({ status: "unreadable" });
    expect(seen.map((item) => item.stage)).toEqual(["research", "directions", "bible", "outline", "episode:1", "review:1"]);
  });

  it("resume needs the exact uncertain calls and its replay sends nothing", async () => {
    const { service, settle, run, seen } = setup();
    const started = await service.start(P1, {}, TOKEN, CONTEXT("k"));
    const runId = (started.body as { run: AutoCreationRunView }).run.runId;
    // Cancel before anything ran: the run is canceled with zero calls.
    await service.cancel(P1, runId);
    await settle();
    expect((await run(runId)).state).toBe("canceled");
    expect(seen).toHaveLength(0);
    const resumed = await service.resume(P1, runId, {}, TOKEN, CONTEXT("r-1"));
    expect(resumed.status).toBe(200);
    await settle();
    expect((await run(runId)).state).toBe("completed");
    const replay = await service.resume(P1, runId, {}, TOKEN, CONTEXT("r-1"));
    expect(replay.status).toBe(200);
    await settle();
    expect(seen).toHaveLength(autoCreationNormalCalls(1));
  });

  it("user revise quotes without confirm, refuses empty input, and starts only after confirm", async () => {
    const { service, settle, run, seen } = setup();
    const started = await service.start(P1, { revisionRounds: 2, callBudget: 12 }, TOKEN, CONTEXT("user-revise-start"));
    const runId = (started.body as { run: AutoCreationRunView }).run.runId;
    await settle();
    expect((await run(runId)).state).toBe("completed");
    const before = seen.length;
    expect(errorCode((await service.userRevise(P1, runId, { confirm: false }, TOKEN, CONTEXT())).body))
      .toBe("AUTO_CREATION_USER_REVISE_EMPTY");
    expect(seen).toHaveLength(before);
    const quoted = await service.userRevise(P1, runId, { instruction: "改动机", confirm: false }, TOKEN, CONTEXT());
    expect(quoted.status).toBe(200);
    expect(quoted.body).toMatchObject({ quote: { callsNeeded: 2, roundsRemainingAfter: 1 } });
    // Quote is call/round counts only — no invented money fields while billing stays unknown.
    expect(quoted.body).toEqual(expect.objectContaining({
      quote: expect.not.objectContaining({ amount: expect.anything(), price: expect.anything(), total: expect.anything() }),
    }));
    expect(JSON.stringify(quoted.body)).not.toMatch(/"(amount|unitPrice|totalPrice|priceYen|fee)"\s*:/u);
    expect(seen).toHaveLength(before);
    expect((await service.userRevise(P1, runId, { instruction: "改动机", confirm: true }, TOKEN, CONTEXT())).status).toBe(400);
    const confirmed = await service.userRevise(P1, runId, { instruction: "改动机", confirm: true }, TOKEN, CONTEXT("user-revise-1"));
    expect(confirmed.status).toBe(200);
    await settle();
    expect((await run(runId)).revisionRoundsUsed).toBe(1);
    expect(seen.slice(before).map((item) => item.stage)).toEqual(["revise:1:episode:1", "review:2"]);
    expect(seen.find((item) => item.stage === "revise:1:episode:1")!.user).toContain("ads.auto-creation.user-revise.v1");
    const replay = await service.userRevise(P1, runId, { instruction: "改动机", confirm: true }, TOKEN, CONTEXT("user-revise-1"));
    expect(replay.status).toBe(200);
    expect(seen.slice(before)).toHaveLength(2);
  });

  it("completed run exposes recorded usage and unknown billing on bill-checkable call records", async () => {
    const { service, settle, run } = setup();
    const started = await service.start(P1, { revisionRounds: 0, callBudget: 7 }, TOKEN, CONTEXT("usage-visible"));
    const runId = (started.body as { run: AutoCreationRunView }).run.runId;
    await settle();
    const done = await run(runId);
    expect(done).toMatchObject({ state: "completed", budget: { billing: "unknown" }, callsUsed: autoCreationNormalCalls(1) });
    expect(done.calls.length).toBe(autoCreationNormalCalls(1));
    expect(done.calls.every((call) => call.billingStatus === "unknown")).toBe(true);
    expect(done.calls.every((call) => call.usage.status === "present"
      && call.usage.inputTokens === 100
      && call.usage.outputTokens === 200
      && call.usage.totalTokens === 300
      && typeof call.providerKey === "string"
      && typeof call.model === "string"
      && typeof call.stageKey === "string"
      && typeof call.createdAt === "string")).toBe(true);
    expect(done.calls.some((call) => call.providerRequestId !== null && call.providerRequestId.length > 0)).toBe(true);
    expect(JSON.stringify(done.calls)).not.toMatch(/"(amount|unitPrice|totalPrice)"\s*:/u);
  });

  it("user revise findings-only and both quote paths work without charging before confirm", async () => {
    const { service, settle, run, seen } = setup({ fixture: { review: { lowIssueRounds: [1] } } });
    const started = await service.start(P1, { revisionRounds: 2, callBudget: 12 }, TOKEN, CONTEXT("findings-path"));
    const runId = (started.body as { run: AutoCreationRunView }).run.runId;
    await settle();
    const completed = await run(runId);
    expect(completed.quality).toBe("passed");
    const findingId = completed.selectableFindings?.find((item) => item.id === "R2")?.id
      ?? completed.selectableFindings?.[0]?.id;
    expect(findingId).toBeTruthy();
    const before = seen.length;
    const findingsQuote = await service.userRevise(P1, runId, { findingIds: [findingId!], confirm: false }, TOKEN, CONTEXT());
    expect(findingsQuote.status).toBe(200);
    expect(seen).toHaveLength(before);
    const bothQuote = await service.userRevise(P1, runId, {
      findingIds: [findingId!], instruction: "并写清可见犹豫", confirm: false,
    }, TOKEN, CONTEXT());
    expect(bothQuote.status).toBe(200);
    expect(seen).toHaveLength(before);
    expect((await service.userRevise(P1, runId, { findingIds: [findingId!], confirm: true }, TOKEN, CONTEXT("findings-only"))).status).toBe(200);
    await settle();
    expect(seen.slice(before).map((item) => item.stage)).toEqual(["revise:1:episode:1", "review:2"]);
  });

  it("confirm replays a matching resume identity before eligibility checks", async () => {
    const { service, settle, seen, store } = setup();
    const started = await service.start(P1, { revisionRounds: 2, callBudget: 12 }, TOKEN, CONTEXT("peek-start"));
    const runId = (started.body as { run: AutoCreationRunView }).run.runId;
    await settle();
    const before = seen.length;
    const confirmed = await service.userRevise(P1, runId, { instruction: "改动机", confirm: true }, TOKEN, CONTEXT("peek-replay"));
    expect(confirmed.status).toBe(200);
    await settle();
    expect(seen.slice(before)).toHaveLength(2);
    // After the round is consumed, plan would refuse — but the same key/body must still return the receipt.
    const stored = store.runs.find((item) => item.id === runId)!;
    expect(stored.revisionRoundsUsed).toBe(1);
    stored.state = "running";
    const replay = await service.userRevise(P1, runId, { instruction: "改动机", confirm: true }, TOKEN, CONTEXT("peek-replay"));
    expect(replay.status).toBe(200);
    expect((replay.body as { run: AutoCreationRunView }).run.runId).toBe(runId);
    expect(errorCode(replay.body)).toBeUndefined();
    expect(seen.slice(before)).toHaveLength(2);
  });

  it("refuses findings that cover more episodes than one revise round allows", async () => {
    const { service, settle, run, store } = setup({
      plan: { episodeCount: 6, targetEpisodeSeconds: 60 },
    });
    const started = await service.start(P1, { revisionRounds: 2 }, TOKEN, CONTEXT("too-many-eps"));
    expect(started.status).toBe(201);
    const runId = (started.body as { run: AutoCreationRunView }).run.runId;
    await settle();
    expect((await run(runId)).state).toBe("completed");
    const review = store.stages.find((stage) => stage.runId === runId && stage.stageKey === "review:1")!.output as {
      issues: Array<Record<string, unknown>>;
    };
    review.issues = [1, 2, 3, 4].map((episodeNo) => ({
      id: `R${String(episodeNo)}`, dimension: "conflictAction", severity: "low", target: `episode:${String(episodeNo)}`,
      evidence: `e${String(episodeNo)}`, problem: "p", suggestion: "s", evidenceVerified: true,
    }));
    const refused = await service.userRevise(P1, runId, {
      findingIds: ["R1", "R2", "R3", "R4"], confirm: false,
    }, TOKEN, CONTEXT());
    expect(refused.status).toBe(400);
    expect(errorCode(refused.body)).toBe("AUTO_CREATION_USER_REVISE_TOO_MANY_EPISODES");
    expect((refused.body as { error: { message: string } }).error.message).toContain("超过本轮改稿上限");
  });

  describe("phase 5 commercial robustness", () => {
    it("empty uncertain confirmation never schedules a paid resend", async () => {
      const { service, settle, run, seen, store } = setup();
      const started = await service.start(P1, { revisionRounds: 0, callBudget: 7 }, TOKEN, CONTEXT("robust-uncertain"));
      const runId = (started.body as { run: AutoCreationRunView }).run.runId;
      await settle();
      expect((await run(runId)).state).toBe("completed");
      // Simulate an uncertain prior call that may already have been billed: resume without matching IDs must not send.
      const call = store.calls.find((item) => item.runId === runId)!;
      const stage = store.stages.find((item) => item.runId === runId && item.stageKey === call.stageKey)!;
      call.state = "unknown";
      call.errorCode = "disconnected";
      stage.state = "unknown";
      stage.errorCode = "disconnected";
      const stored = store.runs.find((item) => item.id === runId)!;
      stored.state = "needs_attention";
      stored.errorCode = "disconnected";
      const before = seen.length;
      const beforeCalls = (await run(runId)).callsUsed;
      const unconfirmed = await service.resume(P1, runId, { confirmUncertainCallIds: [] }, TOKEN, CONTEXT("robust-resume-empty"));
      expect(unconfirmed.status).toBe(409);
      expect(errorCode(unconfirmed.body)).toBe("AUTO_CREATION_NEEDS_CONFIRMATION");
      expect(seen).toHaveLength(before);
      expect((await run(runId)).callsUsed).toBe(beforeCalls);
      expect(store.resumes.filter((item) => item.runId === runId)).toHaveLength(0);
    });

    it("unconfirmed user revise stays a quote and leaves call count / model send unchanged", async () => {
      const { service, settle, run, seen } = setup();
      const started = await service.start(P1, { revisionRounds: 2, callBudget: 12 }, TOKEN, CONTEXT("robust-quote-only"));
      const runId = (started.body as { run: AutoCreationRunView }).run.runId;
      await settle();
      const done = await run(runId);
      expect(done.state).toBe("completed");
      const beforeCalls = done.callsUsed;
      const beforeSeen = seen.length;
      const quoted = await service.userRevise(P1, runId, { instruction: "改动机", confirm: false }, TOKEN, CONTEXT());
      expect(quoted.status).toBe(200);
      expect(quoted.body).toMatchObject({ quote: { callsNeeded: 2 } });
      expect(seen).toHaveLength(beforeSeen);
      expect((await run(runId)).callsUsed).toBe(beforeCalls);
      expect((await run(runId)).revisionRoundsUsed).toBe(0);
    });
  });
});
