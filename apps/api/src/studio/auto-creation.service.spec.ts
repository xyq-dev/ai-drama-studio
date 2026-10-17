import { describe, expect, it } from "vitest";
import { autoCreationHardCap, autoCreationNormalCalls, type AutoCreationOptionsView, type AutoCreationRunView, type TitleWritingProviderKey } from "@ai-drama/contracts";
import { PersistenceError } from "@ai-drama/database";
import { AutoCreationEngine, InMemoryAutoCreationStore, titleWritingProviderConfigs, type TitleWritingProviderEnv } from "@ai-drama/providers";
import { autoFixtureTransport, type AutoFixtureExchange, type AutoFixturePlan } from "@ai-drama/providers/title-writing-fixtures";
import { AutoCreationService } from "./auto-creation.service";

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
}

function setup(options: Setup = {}) {
  const store = new InMemoryAutoCreationStore();
  const plan = options.plan ?? { episodeCount: 1, targetEpisodeSeconds: 60 };
  store.addProject(WS, P1, plan.episodeCount);
  const seen: AutoFixtureExchange[] = [];
  const providers = titleWritingProviderConfigs(options.env ?? BOTH);
  const maxCallsPerDay = options.maxCallsPerDay ?? 30;
  const engine = new AutoCreationEngine({ workspaceId: WS, store, providers, transport: autoFixtureTransport({ seen, plan: options.fixture }), maxCallsPerDay });
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
  });
  const settle = async () => { while (pending.length > 0) await pending.shift()!(); };
  const run = async (runId: string) => ((await service.get(P1, runId)).body as { run: AutoCreationRunView }).run;
  return { store, service, seen, settle, run, pending };
}

const errorCode = (body: unknown) => (body as { error?: { code?: string } }).error?.code;

describe("automatic creation API", () => {
  it("options name the real provider, the research limits and the missing media capabilities", async () => {
    const { service } = setup({ defaultProvider: "anthropic" });
    const options = (await service.options()).body as AutoCreationOptionsView;
    expect(options).toMatchObject({ code: "AUTO_CREATION_READY", defaultProvider: "anthropic", billing: "unknown", maxOutputTokensPerCall: 4096 });
    expect(options.episodePlan).toMatchObject({ defaultEpisodes: 1, defaultSeconds: 60, maxEpisodes: 6 });
    expect(options.research).toMatchObject({ fetchEnabled: false, readableMarketSources: 0, expectedMode: "limited", visualAnalysis: false });
    expect(options.media).toMatchObject({ realProviders: [], mockOnly: true });
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
});
