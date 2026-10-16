import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ScriptBreakdownRunView, TitleWritingRunView } from "@ai-drama/contracts";
import { PersistenceError } from "@ai-drama/database";
import {
  ANTHROPIC_MESSAGES_URL,
  InMemoryTitleWritingStore,
  OPENAI_RESPONSES_URL,
  TitleWritingEngine,
  hashScriptBreakdownRequest,
  hashTitleResume,
  newScriptBreakdownRun,
  newTitleRun,
  titleWritingProviderConfigs,
} from "@ai-drama/providers";
import { fixtureChatTransport, type FixtureExchange } from "@ai-drama/providers/title-writing-fixtures";
import { ScriptBreakdownService } from "./script-breakdown.service";
import { PROVIDER_MIGRATION_GAP, TitleWritingService } from "./title-writing.service";

/**
 * The two active providers (OpenAI, Claude) and the retired ones (qwen, deepseek) at the service boundary, against the
 * in-process store and a protocol-aware stub. Nothing here opens a network connection or a database.
 */
const WS = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const TOKEN = "operator-token-0123456789";
const KEY = "sk-test-not-a-real-key-000";
const TITLE = "夜班证词";
const SCRIPT = "第 1 集\n场 1 便利店 夜\n林夏盯着监控。\n林夏：这不是我。\n场 2 天台 夜\n周野推开铁门。\n周野：你来了。";
const CONTEXT = (key?: string) => ({ actorId: "server-owner", traceId: "t", ...(key ? { idempotencyKey: key } : {}) });
const EMPTY_USAGE = { status: "unknown" as const, inputTokens: null, outputTokens: null, totalTokens: null };

function setup(options: { anthropicReady?: boolean; defaultProvider?: "openai" | "anthropic" | null } = {}) {
  const store = new InMemoryTitleWritingStore();
  store.anthropicReady = options.anthropicReady ?? true;
  store.addProject(WS, P1);
  const episode = store.addBreakdownEpisode({ workspaceId: WS, projectId: randomUUID(), episodeNo: 1, text: SCRIPT, approved: true, targetEpisodeSeconds: 60 });
  const seen: FixtureExchange[] = [];
  const providers = titleWritingProviderConfigs({
    OPENAI_API_KEY: KEY, TITLE_WRITING_OPENAI_MODELS: "gpt-6-luna", ANTHROPIC_API_KEY: KEY, TITLE_WRITING_ANTHROPIC_MODELS: "claude-opus-5-5,claude-sonnet-5-5",
  });
  const engine = new TitleWritingEngine({ workspaceId: WS, store, providers, transport: fixtureChatTransport(TITLE, { seen }), maxCallsPerDay: 100, timeoutMs: 50 });
  const pending: Array<() => Promise<void>> = [];
  const projects = {
    getProject: async (_workspaceId: string, projectId: string) => {
      if (!store.projects.has(projectId) && projectId !== episode.projectId) throw new PersistenceError("NOT_FOUND", "Project not found");
      return { id: projectId } as never;
    },
    getProjectEpisodePlan: async () => ({ episodeCount: 3, targetEpisodeSeconds: null }),
    episodePlanReady: async () => true,
  };
  const common = { workspaceId: WS, nodeEnv: "test" as const, enabled: true, operatorToken: TOKEN, defaultProvider: options.defaultProvider ?? null,
    providers, store, engine, projects, maxCallsPerDay: 100, maxActiveRuns: 5, schedule: (work: () => Promise<void>) => { pending.push(work); } };
  const title = new TitleWritingService(common);
  const breakdown = new ScriptBreakdownService(common);
  const settle = async () => { while (pending.length > 0) await pending.shift()!(); };
  return { store, episode, seen, title, breakdown, settle };
}

const runOf = (result: { body: unknown }) => (result.body as { run: TitleWritingRunView }).run;
const errorOf = (result: { body: unknown }) => (result.body as { error?: { code: string; details?: Record<string, unknown> } }).error;

/** A title run stored by the released code with a retired provider, under the given request identity. */
async function storedRetiredRun(store: InMemoryTitleWritingStore, providerKey: "qwen" | "deepseek", idempotencyKey: string) {
  const run = newTitleRun({ workspaceId: WS, projectId: P1, actorId: "server-owner", idempotencyKey, title: TITLE,
    settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey, model: `${providerKey}-old-model`, now: new Date() });
  expect((await store.createRun(run, { maxActiveRuns: 10 })).kind).toBe("created");
  return run;
}

/** Leaves the run with one uncertain (possibly billed) call, as a timeout under the released code would have. */
async function withUncertainCall(store: InMemoryTitleWritingStore, runId: string, providerKey: "qwen" | "deepseek") {
  const at = new Date().toISOString();
  const lease = new Date(Date.now() + 60_000).toISOString();
  expect(await store.claimRun(WS, runId, "old-executor", at, lease)).toBe(true);
  const callId = randomUUID();
  await store.reserveCall({ id: callId, runId, workspaceId: WS, stepKey: "concept", attemptNo: 1, providerKey, model: `${providerKey}-old-model`,
    requestHash: "b".repeat(64), state: "reserved", executorId: "old-executor", providerRequestId: null, responseModel: null, usage: EMPTY_USAGE,
    errorCode: null, createdAt: at, finishedAt: null }, { sinceIso: "2000-01-01T00:00:00Z", maxCallsPerDay: 100 }, at, lease);
  expect(await store.markCallSubmitted(WS, callId, "old-executor", at, lease)).toBe("submitted");
  expect(await store.finishCall(WS, callId, "old-executor", { state: "unknown", errorCode: "timeout", output: null, outputHash: null,
    providerRequestId: "req-old", responseModel: null, usage: EMPTY_USAGE }, at)).toBe(true);
  expect(await store.finishRun(WS, runId, "old-executor", "needs_attention", "timeout", at)).toBe(true);
  return callId;
}

describe("options offer exactly OpenAI and Claude", () => {
  it("never lists a retired provider, and reports Claude as not ready until the provider migration, naming only the gap", async () => {
    const { title, breakdown, store } = setup({ anthropicReady: false });
    for (const service of [title, breakdown]) {
      const body = (await service.options()).body as { providers: Array<{ providerKey: string; label: string; ready: boolean; missing: string[] }> };
      expect(body.providers.map((item) => [item.providerKey, item.label, item.ready, item.missing])).toEqual([
        ["openai", "OpenAI", true, []],
        ["anthropic", "Claude", false, [PROVIDER_MIGRATION_GAP]],
      ]);
      expect(JSON.stringify(body)).not.toContain(KEY);
    }
    store.anthropicReady = true;
    const ready = (await title.options()).body as { providers: Array<{ providerKey: string; ready: boolean; missing: string[] }> };
    expect(ready.providers.find((item) => item.providerKey === "anthropic")).toMatchObject({ ready: true, missing: [] });
  });
});

describe("Claude before and after the provider migration", () => {
  it("refuses a Claude start with zero run writes, reservations and sends while the database cannot store it", async () => {
    const { title, store, seen, settle } = setup({ anthropicReady: false, defaultProvider: "anthropic" });
    for (const body of [{ title: TITLE, providerKey: "anthropic" }, { title: TITLE }]) {
      const result = await title.start(P1, body, TOKEN, CONTEXT(randomUUID()));
      expect([result.status, errorOf(result)?.code]).toEqual([503, "TITLE_WRITING_PROVIDER_STORAGE_UNAVAILABLE"]);
      expect(errorOf(result)?.details).toEqual({ providerKey: "anthropic", missing: [PROVIDER_MIGRATION_GAP] });
    }
    await settle();
    expect([store.runs.length, store.calls.length, seen.length]).toEqual([0, 0, 0]);
    // OpenAI needs no migration and is never substituted for the refused Claude request.
    const openai = await title.start(P1, { title: TITLE, providerKey: "openai" }, TOKEN, CONTEXT(randomUUID()));
    expect([openai.status, runOf(openai).providerKey]).toEqual([201, "openai"]);
  });

  it("after it, a Claude run freezes its provider and model, speaks the Messages API and saves the story with unknown cost", async () => {
    const { title, store, seen, settle } = setup();
    const started = await title.start(P1, { title: TITLE, providerKey: "anthropic", model: "claude-sonnet-5-5" }, TOKEN, CONTEXT("claude-1"));
    expect(started.status).toBe(201);
    await settle();
    const run = runOf(await title.latest(P1));
    expect(run).toMatchObject({ state: "completed", storySave: "saved", providerKey: "anthropic", model: "claude-sonnet-5-5" });
    expect(seen.map((item) => item.step)).toEqual(["concept", "outline", "episode:1", "episode:2", "episode:3"]);
    expect(new Set(seen.map((item) => item.url))).toEqual(new Set([ANTHROPIC_MESSAGES_URL]));
    for (const exchange of seen) {
      expect(exchange.body).toMatchObject({ model: "claude-sonnet-5-5", thinking: { type: "adaptive", display: "omitted" },
        output_config: { effort: "low", format: { type: "json_schema" } } });
      expect(exchange.body).not.toHaveProperty("text");
    }
    expect(run.calls).toHaveLength(5);
    for (const call of run.calls) {
      expect(call).toMatchObject({ providerKey: "anthropic", model: "claude-sonnet-5-5", responseModel: "fixture-model", state: "completed",
        billingStatus: "unknown", usage: { status: "present", inputTokens: 100, outputTokens: 200, totalTokens: 300 } });
      expect(call.providerRequestId).toMatch(/^fixture-/);
    }
    expect(store.projects.get(P1)!.stories).toHaveLength(1);
  });

  it("an OpenAI run still speaks the Responses API", async () => {
    const { title, seen, settle } = setup();
    expect((await title.start(P1, { title: TITLE, providerKey: "openai" }, TOKEN, CONTEXT("openai-1"))).status).toBe(201);
    await settle();
    expect(runOf(await title.latest(P1))).toMatchObject({ state: "completed", providerKey: "openai", model: "gpt-6-luna" });
    expect(new Set(seen.map((item) => item.url))).toEqual(new Set([OPENAI_RESPONSES_URL]));
    expect(seen[0]!.body).toMatchObject({ store: false, text: { format: { type: "json_schema", strict: true } } });
  });
});

describe.each(["qwen", "deepseek"] as const)("the retired provider %s", (retired) => {
  it("a new start naming it is refused before anything is created or sent, and is never moved to another provider", async () => {
    const { title, breakdown, store, episode, seen, settle } = setup({ defaultProvider: "anthropic" });
    const titleResult = await title.start(P1, { title: TITLE, providerKey: retired }, TOKEN, CONTEXT(randomUUID()));
    expect([titleResult.status, errorOf(titleResult)?.code, errorOf(titleResult)?.details?.providerKey]).toEqual([409, "TITLE_WRITING_PROVIDER_RETIRED", retired]);
    const breakdownResult = await breakdown.start(episode.projectId, episode.episodeId, { providerKey: retired, model: "x" }, TOKEN, CONTEXT(randomUUID()));
    expect([breakdownResult.status, errorOf(breakdownResult)?.code]).toEqual([409, "TITLE_WRITING_PROVIDER_RETIRED"]);
    await settle();
    expect([store.runs.length, store.calls.length, seen.length]).toEqual([0, 0, 0]);
  });

  it("a lost receipt of a start made before the retirement is still answered from its run, without a new run or a send", async () => {
    const { title, store, seen, settle } = setup({ defaultProvider: "anthropic" });
    const key = randomUUID();
    const stored = await storedRetiredRun(store, retired, key);
    const before = structuredClone(store.runs);
    // The page replays exactly what it stored, and also an older page body that left the provider to the server.
    for (const body of [{ title: TITLE, providerKey: retired, model: `${retired}-old-model` }, { title: TITLE, providerKey: retired }, { title: TITLE }]) {
      const replay = await title.start(P1, body, TOKEN, CONTEXT(key));
      expect([replay.status, runOf(replay).runId, runOf(replay).providerKey, runOf(replay).model]).toEqual([200, stored.id, retired, `${retired}-old-model`]);
    }
    // Other content under the same key is still refused as reused.
    const other = await title.start(P1, { title: "另一个剧名", providerKey: retired }, TOKEN, CONTEXT(key));
    expect([other.status, errorOf(other)?.code]).toEqual([409, "IDEMPOTENCY_KEY_REUSED"]);
    await settle();
    expect(store.runs).toEqual(before);
    expect(seen).toHaveLength(0);
  });

  it("its run and calls stay readable with the real provider, model, request id and unknown cost", async () => {
    const { title, store } = setup();
    const stored = await storedRetiredRun(store, retired, randomUUID());
    const callId = await withUncertainCall(store, stored.id, retired);
    const run = runOf(await title.get(P1, stored.id));
    expect(run).toMatchObject({ runId: stored.id, providerKey: retired, model: `${retired}-old-model`, state: "needs_attention", errorCode: "timeout" });
    expect(run.calls).toEqual([expect.objectContaining({ callId, providerKey: retired, model: `${retired}-old-model`, state: "unknown",
      providerRequestId: "req-old", billingStatus: "unknown", usage: EMPTY_USAGE })]);
  });

  it("confirming its uncertain call never sends again; the run, the call and the cost stay unchanged", async () => {
    const { title, store, seen, settle } = setup({ defaultProvider: "anthropic" });
    const stored = await storedRetiredRun(store, retired, randomUUID());
    const callId = await withUncertainCall(store, stored.id, retired);
    const before = structuredClone({ runs: store.runs, steps: store.steps, calls: store.calls, resumes: store.resumes });
    const result = await title.resume(P1, stored.id, { confirmUncertainCallIds: [callId] }, TOKEN, CONTEXT(randomUUID()));
    expect([result.status, errorOf(result)?.code, errorOf(result)?.details?.providerKey]).toEqual([409, "TITLE_WRITING_PROVIDER_RETIRED", retired]);
    await settle();
    expect({ runs: store.runs, steps: store.steps, calls: store.calls, resumes: store.resumes }).toEqual(before);
    expect(seen).toHaveLength(0);
  });

  it("a resume accepted before the retirement is replayed from its receipt; the run then stops without a send", async () => {
    const { title, store, seen, settle } = setup();
    const stored = await storedRetiredRun(store, retired, randomUUID());
    const callId = await withUncertainCall(store, stored.id, retired);
    const resumeKey = randomUUID();
    // Accepted by the released code while the provider still existed.
    const accepted = await store.prepareResume(WS, P1, stored.id, { resumeKey, requestHash: hashTitleResume(stored.id, [callId]),
      confirmedCallIds: [callId], maxActiveRuns: 5, providerReady: true }, new Date().toISOString());
    expect(accepted.kind).toBe("ok");
    const replay = await title.resume(P1, stored.id, { confirmUncertainCallIds: [callId] }, TOKEN, CONTEXT(resumeKey));
    expect([replay.status, runOf(replay).runId, runOf(replay).providerKey]).toEqual([200, stored.id, retired]);
    await settle();
    // The engine stops it as provider_unconfigured before any reservation: the resent call never happens.
    const engine = new TitleWritingEngine({ workspaceId: WS, store, providers: titleWritingProviderConfigs({
      OPENAI_API_KEY: KEY, TITLE_WRITING_OPENAI_MODELS: "gpt-6-luna", ANTHROPIC_API_KEY: KEY, TITLE_WRITING_ANTHROPIC_MODELS: "claude-opus-5-5" }),
    transport: fixtureChatTransport(TITLE, { seen }), maxCallsPerDay: 100 });
    await engine.maintain();
    expect(runOf(await title.get(P1, stored.id))).toMatchObject({ state: "needs_attention", errorCode: "provider_unconfigured", providerKey: retired });
    expect(store.calls.filter((call) => call.runId === stored.id)).toHaveLength(1);
    expect(seen).toHaveLength(0);
  });
});

describe("a breakdown stored with a retired provider", () => {
  it("is answered on replay and its resume never sends", async () => {
    const { breakdown, store, episode, seen, settle } = setup();
    // A breakdown the released code started with qwen; its request body named the provider and model.
    const key = randomUUID();
    const projectId = episode.projectId;
    const source = await store.breakdownSource(WS, projectId, episode.episodeId);
    if (source.kind !== "ok") throw new Error(source.kind);
    const requestHash = hashScriptBreakdownRequest(projectId, { episodeId: episode.episodeId, providerKey: "qwen", model: "qwen-old-model", replaceExisting: false });
    const run = newScriptBreakdownRun({ workspaceId: WS, projectId, actorId: "server-owner", idempotencyKey: key, requestHash, now: new Date(), input: {
      episodeId: episode.episodeId, episodeNo: 1, scriptRevisionId: source.scriptRevisionId, scriptRevisionNo: source.scriptRevisionNo,
      scriptContentHash: source.scriptContentHash, scriptText: (source.scriptContent as { text: string }).text, targetEpisodeSeconds: source.targetEpisodeSeconds,
      characters: [], replace: { scenes: [], shots: [] }, providerKey: "qwen", model: "qwen-old-model" } });
    expect((await store.createRun(run, { maxActiveRuns: 10 })).kind).toBe("created");
    const replay = await breakdown.start(projectId, episode.episodeId, { providerKey: "qwen", model: "qwen-old-model" }, TOKEN, CONTEXT(key));
    const view = (replay.body as { run: ScriptBreakdownRunView }).run;
    expect([replay.status, view.runId, view.providerKey]).toEqual([200, run.id, "qwen"]);
    await settle();
    expect(seen).toHaveLength(0);
  });
});
