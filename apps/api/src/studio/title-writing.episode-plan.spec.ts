import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EPISODE_OUTLINE_SCHEMA_V2,
  TITLE_WRITING_INPUT_SCHEMA,
  TITLE_WRITING_PROMPT_VERSION,
  TITLE_WRITING_PROMPT_VERSION_V2,
  TITLE_WRITING_PROMPT_VERSION_V3,
  TITLE_WRITING_PROMPT_VERSION_V4,
  type TitleCallRecord,
  type TitleWritingFrozenInputV2,
} from "@ai-drama/contracts";
import { PersistenceError } from "@ai-drama/database";
import {
  InMemoryTitleWritingStore,
  TitleWritingEngine,
  hashTitleWritingInput,
  titleWritingProviderConfigs,
  type TitleWritingProviderEnv,
} from "@ai-drama/providers";
import {
  messagesAnswer,
  fixtureChatTransport,
  fixtureConcept,
  fixtureEpisode,
  fixtureOutline,
  type FixtureExchange,
  type FixtureStep,
} from "@ai-drama/providers/title-writing-fixtures";
import { TitleWritingService } from "./title-writing.service";

/**
 * The episode plan at the API boundary, against the in-process store and a provider stub (no network, no database).
 * The PostgreSQL side of the same rules is in title-writing.episode-plan.acceptance.spec.ts.
 */
const WS = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const TOKEN = "operator-token-0123456789";
const ENV: TitleWritingProviderEnv = {
  ANTHROPIC_API_KEY: "sk-ant-api03-test-not-a-real-key-000", TITLE_WRITING_ANTHROPIC_MODELS: "q-1",
};
const CONTEXT = (key: string) => ({ actorId: "server-owner", traceId: "t", idempotencyKey: key });
type Plan = { episodeCount: number; targetEpisodeSeconds: number } | null;
type Override = (step: FixtureStep, attempt: number) => { status: number; body: unknown } | "hang" | "throw" | undefined;

interface RunBody {
  run: {
    runId: string; state: string; errorCode: string | null; inputVersion: number; episodeCount: number; callCap: number; callsUsed: number;
    settings: { episodeCount: number; episodeSeconds: number; style: string };
    steps: Array<{ stepKey: string; state: string; errorCode: string | null; scriptSave: string | null }>;
    calls: Array<{ callId: string; stepKey: string; state: string; attemptNo: number }>;
  };
}

function setup(plan: Plan, options: { planReady?: boolean; override?: Override; maxCallsPerDay?: number; hold?: boolean } = {}) {
  const store = new InMemoryTitleWritingStore();
  store.addProject(WS, P1, plan?.episodeCount ?? 3);
  const seen: FixtureExchange[] = [];
  const providers = titleWritingProviderConfigs(ENV);
  const transport = fixtureChatTransport("夜班证词", { seen, ...(options.override ? { override: options.override } : {}) });
  const maxCallsPerDay = options.maxCallsPerDay ?? 30;
  const engine = new TitleWritingEngine({ workspaceId: WS, store, providers, transport, maxCallsPerDay, timeoutMs: 20 });
  const pending: Array<() => Promise<void>> = [];
  const service = new TitleWritingService({
    workspaceId: WS, nodeEnv: "test", enabled: true, operatorToken: TOKEN, defaultProvider: null, providers, store, engine,
    projects: {
      getProject: async (_workspaceId: string, projectId: string) => {
        if (projectId !== P1) throw new PersistenceError("NOT_FOUND", "Project not found");
        return { id: projectId } as never;
      },
      getProjectEpisodePlan: async () => plan ?? { episodeCount: 3, targetEpisodeSeconds: null },
      episodePlanReady: async () => options.planReady ?? true,
    },
    maxCallsPerDay,
    maxActiveRuns: 1,
    schedule: (work) => { pending.push(work); },
  });
  const settle = async () => { while (pending.length > 0) await pending.shift()!(); };
  const read = async (runId: string) => (await service.get(P1, runId)).body as RunBody;
  return { store, service, seen, settle, read, pending };
}

/** Calls of this workspace inside the rolling 24 hours, made before the start (another run's history). */
function spendCalls(store: InMemoryTitleWritingStore, count: number): void {
  for (let index = 0; index < count; index += 1) {
    store.calls.push({
      id: randomUUID(), runId: randomUUID(), workspaceId: WS, stepKey: "concept", attemptNo: 1, providerKey: "anthropic", model: "q-1",
      requestHash: "0".repeat(64), state: "completed", executorId: "earlier", providerRequestId: null, responseModel: null,
      usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null }, errorCode: null,
      createdAt: new Date(Date.now() - 60_000).toISOString(), finishedAt: new Date(Date.now() - 59_000).toISOString(),
    } satisfies TitleCallRecord);
  }
}

const episodeKeys = (count: number) => Array.from({ length: count }, (_, index) => `episode:${String(index + 1)}`);

describe("a project with an episode plan starts a v2 run of exactly its N episodes", () => {
  it.each([1, 3, 6])("N=%i: N+2 steps and requests, cap N+5, the outline and every script for N episodes", async (count) => {
    const { service, settle, seen, read, store } = setup({ episodeCount: count, targetEpisodeSeconds: 60 });
    const started = await service.start(P1, { title: "夜班证词", settings: { episodeCount: count, episodeSeconds: 60 } }, TOKEN, CONTEXT("k"));
    expect(started.status).toBe(201);
    const runId = (started.body as RunBody).run.runId;
    expect((started.body as RunBody).run).toMatchObject({ inputVersion: 2, episodeCount: count, callCap: count + 5, callsUsed: 0,
      settings: { episodeCount: count, episodeSeconds: 60, style: "" } });
    expect((started.body as RunBody).run.steps.map((step) => step.stepKey)).toEqual(["concept", "outline", ...episodeKeys(count)]);
    await settle();
    const done = (await read(runId)).run;
    expect(done).toMatchObject({ state: "completed", callsUsed: count + 2 });
    expect(seen.map((item) => item.step)).toEqual(["concept", "outline", ...episodeKeys(count)]);
    const outlinePrompt = seen.find((item) => item.step === "outline")!.user;
    expect(outlinePrompt).toContain(`episodes 正好 ${String(count)} 项`);
    expect(outlinePrompt).toContain(EPISODE_OUTLINE_SCHEMA_V2);
    expect(outlinePrompt).toContain("每集目标时长：约 1 分钟（60 秒）");
    // The provider schema allows exactly N outline items and episode numbers 1..N.
    const format = (seen.find((item) => item.step === "outline")!.body.response_format ?? null) as unknown;
    if (format && typeof format === "object" && "json_schema" in format) {
      expect(JSON.stringify(format)).toContain(`"minItems":${String(count)}`);
    }
    expect(seen.filter((item) => item.step.startsWith("episode:")).map((item) => /共 (\d) 集/.exec(item.user)?.[1])).toEqual(
      Array.from({ length: count }, () => String(count)));
    // Generated inside the run is not written to the project: scripts wait for the person's story approval.
    expect(done.steps.filter((step) => step.stepKey.startsWith("episode:")).every((step) => step.scriptSave === "awaiting_story_approval")).toBe(true);
    store.approveCurrentStory(P1);
    expect(store.projects.get(P1)!.episodes.size).toBe(count);
    const placed = (await service.placeScripts(P1, runId, {}, { actorId: "owner", traceId: "t" })).body as RunBody;
    expect(placed.run.steps.map((step) => step.scriptSave)).toEqual([null, null, ...Array.from({ length: count }, () => "saved")]);
    // Placing again writes nothing twice.
    await service.placeScripts(P1, runId, {}, { actorId: "owner", traceId: "t" });
    expect([...store.projects.get(P1)!.episodes.values()].map((episode) => episode.scripts.length)).toEqual(Array.from({ length: count }, () => 1));
  });

  it("takes N and the target seconds from the project: a request that disagrees is refused before anything is created", async () => {
    const { service, seen, store, settle } = setup({ episodeCount: 4, targetEpisodeSeconds: 90 });
    const wrongCount = await service.start(P1, { title: "夜班证词", settings: { episodeCount: 6 } }, TOKEN, CONTEXT("a"));
    const wrongSeconds = await service.start(P1, { title: "夜班证词", settings: { episodeSeconds: 60 } }, TOKEN, CONTEXT("b"));
    const v1Seconds = await service.start(P1, { title: "夜班证词", settings: { episodeSeconds: 180 } }, TOKEN, CONTEXT("c"));
    await settle();
    for (const result of [wrongCount, wrongSeconds, v1Seconds]) {
      expect(result).toMatchObject({ status: 409, body: { error: { code: "TITLE_WRITING_PLAN_MISMATCH", details: { episodeCount: 4, targetEpisodeSeconds: 90 } } } });
    }
    expect(store.runs).toHaveLength(0);
    expect(seen).toHaveLength(0);
    // Without settings the run is frozen from the plan alone.
    const plain = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("d"));
    expect((plain.body as RunBody).run).toMatchObject({ inputVersion: 2, episodeCount: 4, settings: { episodeCount: 4, episodeSeconds: 90 } });
  });

  it("refuses a v2 start before any run or send while the episode plan migration is missing", async () => {
    const { service, seen, store, settle } = setup({ episodeCount: 4, targetEpisodeSeconds: 90 }, { planReady: false });
    const result = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("k"));
    await settle();
    expect(result).toMatchObject({ status: 503, body: { error: { code: "TITLE_WRITING_EPISODE_PLAN_UNAVAILABLE" } } });
    expect(store.runs).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });
});

describe("a project without a plan keeps the v1 run unchanged", () => {
  it.each([30, 90, 120, 180])("accepts the v1 seconds %i: five steps, cap 8, the v1 input and hash", async (seconds) => {
    const { service, settle, seen, store } = setup(null);
    const started = await service.start(P1, { title: "夜班证词", settings: { episodeSeconds: seconds, style: "悬疑" } }, TOKEN, CONTEXT("k"));
    expect(started.status).toBe(201);
    await settle();
    const run = store.runs[0]!;
    expect(run.input).toEqual({ schema: TITLE_WRITING_INPUT_SCHEMA, promptVersion: TITLE_WRITING_PROMPT_VERSION, title: "夜班证词",
      settings: { episodeCount: 3, episodeSeconds: seconds, style: "悬疑" }, providerKey: "anthropic", model: "q-1" });
    expect(run.inputHash).toBe(hashTitleWritingInput(P1, run.input));
    expect(run.callCap).toBe(8);
    expect(seen.map((item) => item.step)).toEqual(["concept", "outline", "episode:1", "episode:2", "episode:3"]);
    // The v1 prompts are the v1 text: three episodes, no "共 N 集" and the v1 outline schema.
    expect(seen.find((item) => item.step === "outline")!.user).toContain("episodes 正好 3 项，episodeNo 依次为 1、2、3。");
    expect(seen.some((item) => item.user.includes("（共 "))).toBe(false);
  });

  it("refuses a v1 episode count other than three with the v1 validation error", async () => {
    const { service, store } = setup(null);
    for (const episodeCount of [1, 4, 6]) {
      expect((await service.start(P1, { title: "x", settings: { episodeCount } }, TOKEN, CONTEXT(`k${String(episodeCount)}`))).body)
        .toMatchObject({ error: { code: "VALIDATION_ERROR", details: { field: "settings.episodeCount" } } });
    }
    expect((await service.start(P1, { title: "x", settings: { episodeCount: 7 } }, TOKEN, CONTEXT("k7"))).status).toBe(400);
    expect(store.runs).toHaveLength(0);
  });

  it("keeps v1 starts with fewer than five calls left, then stops at the per-call limit without resending on replay", async () => {
    const { service, store, settle, seen, read } = setup(null);
    spendCalls(store, 28);

    const started = await service.start(P1, { title: "夜班证词", settings: { episodeSeconds: 180 } }, TOKEN, CONTEXT("legacy-low-quota"));
    expect(started.status).toBe(201);
    const runId = (started.body as RunBody).run.runId;
    await settle();

    expect((await read(runId)).run).toMatchObject({
      inputVersion: 1, episodeCount: 3, state: "partial", errorCode: "TITLE_WRITING_DAILY_CAP", callsUsed: 2, callCap: 8,
      settings: { episodeCount: 3, episodeSeconds: 180 },
    });
    expect(seen.map((item) => item.step)).toEqual(["concept", "outline"]);
    expect(store.calls).toHaveLength(30);

    const replay = await service.start(P1, { title: "夜班证词", settings: { episodeSeconds: 180 } }, TOKEN, CONTEXT("legacy-low-quota"));
    expect(replay.status).toBe(200);
    expect((replay.body as RunBody).run.runId).toBe(runId);
    await settle();
    expect(store.runs).toHaveLength(1);
    expect(store.calls).toHaveLength(30);
    expect(seen).toHaveLength(2);
  });
});

describe("the start quota check", () => {
  it.each([1, 3, 6])("N=%i: fewer than N+2 calls left in 24 hours creates no run, no step and sends nothing", async (count) => {
    const { service, seen, store, settle } = setup({ episodeCount: count, targetEpisodeSeconds: 90 });
    spendCalls(store, 30 - (count + 1));
    const result = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("k"));
    await settle();
    expect(result).toMatchObject({ status: 429, body: { error: { code: "TITLE_WRITING_DAILY_QUOTA_LOW",
      details: { requiredCalls: count + 2, remainingCalls: count + 1 } } } });
    expect(store.runs).toHaveLength(0);
    expect(store.steps).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });

  it("exactly N+2 calls left is enough to start", async () => {
    const { service, store, settle, seen } = setup({ episodeCount: 6, targetEpisodeSeconds: 90 });
    spendCalls(store, 30 - 8);
    expect((await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("k"))).status).toBe(201);
    await settle();
    expect(seen).toHaveLength(8);
  });

  it("looks the key up first: a replay is returned after the quota ran out; the same key with another input still conflicts", async () => {
    const { service, store, settle, seen } = setup({ episodeCount: 3, targetEpisodeSeconds: 90 });
    const first = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("same"));
    await settle();
    spendCalls(store, 30);
    const replay = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("same"));
    expect(replay.status).toBe(200);
    expect((replay.body as RunBody).run.runId).toBe((first.body as RunBody).run.runId);
    expect((await service.start(P1, { title: "另一个剧名" }, TOKEN, CONTEXT("same"))).body).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REUSED" } });
    expect((await service.start(P1, { title: "另一个剧名" }, TOKEN, CONTEXT("new"))).body).toMatchObject({ error: { code: "TITLE_WRITING_DAILY_QUOTA_LOW" } });
    await settle();
    expect(seen).toHaveLength(5);
  });

  it("reserves nothing: calls spent by others during the run stop it with its results kept", async () => {
    const { service, store, pending, read, seen } = setup({ episodeCount: 3, targetEpisodeSeconds: 90 });
    spendCalls(store, 25);
    const started = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("k"));
    expect(started.status).toBe(201);
    spendCalls(store, 3);
    while (pending.length > 0) await pending.shift()!();
    const run = (await read((started.body as RunBody).run.runId)).run;
    expect(run).toMatchObject({ state: "partial", errorCode: "TITLE_WRITING_DAILY_CAP", callsUsed: 2 });
    expect(run.steps.slice(0, 2).map((step) => step.state)).toEqual(["completed", "completed"]);
    expect(seen.map((item) => item.step)).toEqual(["concept", "outline"]);
  });
});

describe("v2 outputs are checked against N before any later request", () => {
  const plan = { episodeCount: 4, targetEpisodeSeconds: 90 };
  const outline = (episodes: Array<{ episodeNo: number }>) => ({ status: 200, body: messagesAnswer({ ...fixtureOutline(4), episodes }) });

  it.each([
    ["missing an episode", () => outline(fixtureOutline(4).episodes.slice(0, 3))],
    ["one episode too many", () => outline([...fixtureOutline(4).episodes, { ...fixtureOutline(4).episodes[0]!, episodeNo: 5 }])],
    ["a repeated episode", () => outline(fixtureOutline(4).episodes.map((episode, index) => ({ ...episode, episodeNo: index === 3 ? 3 : episode.episodeNo })))],
    ["out of order", () => outline([...fixtureOutline(4).episodes].reverse())],
    ["the v1 outline schema", () => ({ status: 200, body: messagesAnswer({ ...fixtureOutline(4), schema: "ads.writing.episode-outline.v1" }) })],
    ["not JSON", () => ({ status: 200, body: messagesAnswer("第一集：……") })],
  ])("an outline %s is rejected and no episode is requested", async (_label, answer) => {
    const { service, settle, seen, read } = setup(plan, { override: (step) => step === "outline" ? answer() : undefined });
    const started = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("k"));
    await settle();
    const run = (await read((started.body as RunBody).run.runId)).run;
    expect(run.steps.find((step) => step.stepKey === "outline")).toMatchObject({ state: "rejected", errorCode: "invalid_output" });
    expect(run.state).toBe("partial");
    expect(seen.map((item) => item.step)).toEqual(["concept", "outline"]);
  });

  it("a truncated outline is rejected and never continued", async () => {
    const { service, settle, seen, read } = setup(plan, { override: (step) => step === "outline" ? { status: 200, body: messagesAnswer(fixtureOutline(4), "max_tokens") } : undefined });
    const started = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("k"));
    await settle();
    expect((await read((started.body as RunBody).run.runId)).run.steps[1]).toMatchObject({ state: "rejected", errorCode: "truncated" });
    expect(seen).toHaveLength(2);
  });

  it("an episode answer for another episode number is rejected", async () => {
    const { service, settle, seen, read } = setup(plan, { override: (step) => step === "episode:2" ? { status: 200, body: messagesAnswer(fixtureEpisode(4)) } : undefined });
    const started = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("k"));
    await settle();
    const run = (await read((started.body as RunBody).run.runId)).run;
    expect(run.steps.find((step) => step.stepKey === "episode:2")).toMatchObject({ state: "rejected", errorCode: "episode_mismatch" });
    expect(seen.map((item) => item.step)).toEqual(["concept", "outline", "episode:1", "episode:2"]);
  });

  it("a story that cannot be saved is found after the outline, before the first episode request", async () => {
    const long = (length: number) => "长".repeat(length);
    const concept = { ...fixtureConcept("夜班证词"), logline: long(300), synopsis: long(800), protagonistGoal: long(300), opposition: long(300),
      coreConflict: long(400), direction: long(600),
      characters: Array.from({ length: 6 }, (_, index) => ({ name: `人物${String(index)}`, role: long(40), profile: long(200) })),
      relationships: Array.from({ length: 6 }, (_, index) => ({ name: `关系${String(index)}`, pressure: long(200) })) };
    const outlineAnswer = { ...fixtureOutline(6), episodes: fixtureOutline(6).episodes.map((episode) => ({ ...episode, title: long(40),
      entryState: long(400), goal: long(400), action: long(400), turn: long(400), result: long(400), handoff: long(400) })) };
    const { service, settle, seen, read } = setup({ episodeCount: 6, targetEpisodeSeconds: 90 }, {
      override: (step) => step === "concept" ? { status: 200, body: messagesAnswer(concept) }
        : step === "outline" ? { status: 200, body: messagesAnswer(outlineAnswer) } : undefined,
    });
    const started = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("k"));
    await settle();
    const run = (await read((started.body as RunBody).run.runId)).run;
    expect(run).toMatchObject({ state: "needs_attention", errorCode: "story_too_large", callsUsed: 2 });
    expect(seen.map((item) => item.step)).toEqual(["concept", "outline"]);
  });
});

describe("v2 keeps the uncertain-call, cancel and resume rules", () => {
  it("an uncertain episode 5 stops the run; a confirmed resume resends only it and continues; nothing completed is sent again", async () => {
    const { service, settle, seen, read } = setup({ episodeCount: 6, targetEpisodeSeconds: 90 }, {
      override: (step, attempt) => step === "episode:5" && attempt === 1 ? { status: 502, body: {} } : undefined,
    });
    const started = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("k"));
    await settle();
    const runId = (started.body as RunBody).run.runId;
    const stopped = (await read(runId)).run;
    expect(stopped).toMatchObject({ state: "needs_attention", callsUsed: 7 });
    const uncertain = stopped.calls.filter((call) => call.state === "unknown").map((call) => call.callId);
    expect(uncertain).toHaveLength(1);
    expect((await service.resume(P1, runId, {}, TOKEN, CONTEXT("r0"))).body).toMatchObject({ error: { code: "TITLE_WRITING_NEEDS_CONFIRMATION" } });
    expect((await service.resume(P1, runId, { confirmUncertainCallIds: uncertain }, TOKEN, CONTEXT("r1"))).status).toBe(200);
    await settle();
    const done = (await read(runId)).run;
    expect(done).toMatchObject({ state: "completed", callsUsed: 9, callCap: 11 });
    // The uncertain call stays in the history next to its resend.
    expect(done.calls.filter((call) => call.stepKey === "episode:5").map((call) => call.state)).toEqual(["unknown", "completed"]);
    expect(seen.map((item) => item.step)).toEqual(["concept", "outline", "episode:1", "episode:2", "episode:3", "episode:4", "episode:5", "episode:5", "episode:6"]);
  });

  it("a cancel before the first send sends nothing and leaves the later steps canceled", async () => {
    const { service, pending, seen, read } = setup({ episodeCount: 5, targetEpisodeSeconds: 60 });
    const started = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("k"));
    const runId = (started.body as RunBody).run.runId;
    await service.cancel(P1, runId);
    while (pending.length > 0) await pending.shift()!();
    const run = (await read(runId)).run;
    expect(run.state).toBe("canceled");
    expect(run.steps.map((step) => step.state)).toEqual(Array.from({ length: 7 }, () => "canceled"));
    expect(seen).toHaveLength(0);
  });

  it("placing scripts refuses a project whose episodes are not this run's 1..N, writing nothing", async () => {
    const { service, settle, store } = setup({ episodeCount: 4, targetEpisodeSeconds: 90 });
    const started = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("k"));
    await settle();
    store.approveCurrentStory(P1);
    store.projects.get(P1)!.episodes.delete(4);
    const result = await service.placeScripts(P1, (started.body as RunBody).run.runId, {}, { actorId: "owner", traceId: "t" });
    expect(result).toMatchObject({ status: 409, body: { error: { code: "TITLE_WRITING_PLAN_MISMATCH" } } });
    expect([...store.projects.get(P1)!.episodes.values()].every((episode) => episode.scripts.length === 0)).toBe(true);
  });

  it("an episode that already has a script is reported as a conflict and keeps its text; the others are written", async () => {
    const { service, settle, store } = setup({ episodeCount: 2, targetEpisodeSeconds: 60 });
    const started = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("k"));
    await settle();
    store.approveCurrentStory(P1);
    const episodeTwo = store.projects.get(P1)!.episodes.get(2)!;
    episodeTwo.scripts.push({ id: "human", text: "人写的第二集", sourceStoryId: "s" });
    episodeTwo.currentScriptId = "human";
    const placed = (await service.placeScripts(P1, (started.body as RunBody).run.runId, {}, { actorId: "owner", traceId: "t" })).body as RunBody;
    expect(placed.run.steps.map((step) => step.scriptSave)).toEqual([null, null, "saved", "conflict"]);
    expect(episodeTwo.scripts).toEqual([{ id: "human", text: "人写的第二集", sourceStoryId: "s" }]);
  });
});

describe("the writing guidance is prompt v4 of new v2 runs only", () => {
  it("a new v2 run freezes prompt v4 and sends the guided prompts with the same steps and request count", async () => {
    const { service, settle, seen, read } = setup({ episodeCount: 3, targetEpisodeSeconds: 90 });
    const started = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("k"));
    expect(started.status).toBe(201);
    const runId = (started.body as RunBody).run.runId;
    expect((started.body as { run: { promptVersion?: string } }).run.promptVersion).toBe(TITLE_WRITING_PROMPT_VERSION_V4);
    await settle();
    expect((await read(runId)).run).toMatchObject({ state: "completed", callsUsed: 5 });
    expect(seen.map((item) => item.step)).toEqual(["concept", "outline", ...episodeKeys(3)]);
    for (const item of seen) expect(item.user).toContain(TITLE_WRITING_PROMPT_VERSION_V4);
    expect(seen.find((item) => item.step === "episode:2")!.user).toContain("不凭空新增解围人物或决定性证据");
    expect(seen.find((item) => item.step === "episode:2")!.user).toContain("下一集必须承接的事实");
    expect(seen.find((item) => item.step === "episode:3")!.user).toContain("handoffFacts 记录结局事实");
    expect(seen.find((item) => item.step === "episode:3")!.user).not.toContain("handoffFacts 包括本集结尾留下的");
  });

  it.each([
    { version: TITLE_WRITING_PROMPT_VERSION_V2, heading: null },
    { version: TITLE_WRITING_PROMPT_VERSION_V3, heading: TITLE_WRITING_PROMPT_VERSION_V3 },
  ] as const)("a stored $version run keeps its own text, and its start replayed after the upgrade returns it instead of a conflict", async ({ version, heading }) => {
    const { service, settle, seen, store } = setup({ episodeCount: 3, targetEpisodeSeconds: 90 });
    const first = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("before-upgrade"));
    const runId = (first.body as RunBody).run.runId;
    // The run as an API from before the upgrade stored it: the same input with its prompt version and that input's hash.
    const stored = store.runs.find((item) => item.id === runId)!;
    const input = { ...(stored.input as TitleWritingFrozenInputV2), promptVersion: version };
    stored.input = input;
    stored.inputHash = hashTitleWritingInput(P1, input);
    await settle();
    expect(seen).toHaveLength(5);
    for (const item of seen) expect(/编剧要求（(ads\.title-writing\.prompt\.v\d+)）/.exec(item.user)?.[1] ?? null).toBe(heading);
    for (const item of seen) expect(item.user).not.toContain(TITLE_WRITING_PROMPT_VERSION_V4);
    // A stored v3 run still asks its last episode for an ending question, exactly as before.
    if (version === TITLE_WRITING_PROMPT_VERSION_V3) expect(seen.find((item) => item.step === "episode:3")!.user).toContain("handoffFacts 包括本集结尾留下的问题。");
    const replay = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("before-upgrade"));
    expect(replay.status).toBe(200);
    expect((replay.body as RunBody).run.runId).toBe(runId);
    expect((replay.body as { run: { promptVersion?: string } }).run.promptVersion).toBe(version);
    expect(store.runs).toHaveLength(1);
    // Another input under the same key is still a reused key.
    expect((await service.start(P1, { title: "另一个剧名" }, TOKEN, CONTEXT("before-upgrade"))).body).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REUSED" } });
    await settle();
    expect(seen).toHaveLength(5);
  });

  it("a project without a plan still starts the unchanged v1 prompts", async () => {
    const { service, settle, seen } = setup(null);
    const started = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("v1"));
    expect((started.body as { run: { promptVersion?: string } }).run.promptVersion).toBe(TITLE_WRITING_PROMPT_VERSION);
    await settle();
    for (const item of seen) expect(item.user).not.toContain("编剧要求");
  });
});
