import { describe, expect, it } from "vitest";
import { autoCreationHardCap, autoCreationNormalCalls, type AutoCreationOptionsView, type AutoCreationRunView, type TitleWritingProviderKey } from "@ai-drama/contracts";
import { PersistenceError } from "@ai-drama/database";
import type { FetchedPage } from "@ai-drama/domain";
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
  /** The same store as an earlier setup (a restarted API with other settings). */
  store?: InMemoryAutoCreationStore;
  /** The page reader the engine has (the runtime wires one exactly when fetchEnabled). */
  fetchPages?: (urls: readonly string[]) => Promise<FetchedPage[]>;
  seen?: AutoFixtureExchange[];
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
});
