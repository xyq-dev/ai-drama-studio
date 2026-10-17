import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
type LegacyProviderKey = "qwen" | "deepseek";
import { InMemoryTitleWritingStore, TitleWritingEngine, hashTitleResume, newTitleRun, titleRunView, uncertainCallIdsOf } from "./title-writing-engine";
import { fixtureChatTransport, type FixtureExchange } from "./title-writing-fixtures";
import { titleWritingProviderConfigs, type WritingTransport } from "./text-writing";

/**
 * Runs and calls stored with the retired qwen key, and DeepSeek runs stored before DeepSeek's retirement (created before
 * DEEPSEEK_REACTIVATED_AT). DeepSeek is configured and active again here, with the old run's own model allowed, to show
 * that only the run's age stops it. Whatever state such a run is in, the engine never reserves, sends, moves it to
 * another provider or model, or writes a second save or version; it keeps every stored fact (provider, model, input
 * hash, call identity, unknown cost).
 */
const WS = "11111111-1111-4111-8111-111111111111";
const TITLE = "夜班证词";
const KEY = "sk-ant-api03-test-secret-0123456789";
const providers = titleWritingProviderConfigs({
  OPENAI_API_KEY: KEY, TITLE_WRITING_OPENAI_MODELS: "o-1", ANTHROPIC_API_KEY: KEY, TITLE_WRITING_ANTHROPIC_MODELS: "claude-opus-5-5",
  DEEPSEEK_API_KEY: "fake-deepseek-test-key-0123456789", TITLE_WRITING_DEEPSEEK_MODELS: "deepseek-model,deepseek-flash",
});
/** The stop a legacy run gets: qwen has no configuration at all; an old DeepSeek run is stopped for its age. */
const STOP: Record<LegacyProviderKey, string> = { qwen: "provider_unconfigured", deepseek: "legacy_provider_run" };
const EMPTY_USAGE = { status: "unknown" as const, inputTokens: null, outputTokens: null, totalTokens: null };

function harness(start = Date.parse("2026-10-16T00:00:00Z")) {
  let now = start;
  const clock = () => new Date(now);
  const store = new InMemoryTitleWritingStore();
  const seen: FixtureExchange[] = [];
  const sends: string[] = [];
  const fixture = fixtureChatTransport(TITLE, { seen });
  const transport: WritingTransport = async (request) => { sends.push(request.url); return fixture(request); };
  const engine = new TitleWritingEngine({ workspaceId: WS, store, providers, transport, maxCallsPerDay: 100, clock, leaseMs: 1000 });
  const reserve = vi.spyOn(store, "reserveCall");
  const saveStory = vi.spyOn(store, "saveStory");
  return { store, engine, seen, sends, reserve, saveStory, clock, advance: (ms: number) => { now += ms; } };
}

async function storedRun(store: InMemoryTitleWritingStore, providerKey: LegacyProviderKey, clock: () => Date, projectId = randomUUID()) {
  if (!store.projects.has(projectId)) store.addProject(WS, projectId);
  const run = newTitleRun({ workspaceId: WS, projectId, actorId: "owner", idempotencyKey: randomUUID(), title: TITLE,
    settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey, model: `${providerKey}-model`, now: clock() });
  expect((await store.createRun(run, { maxActiveRuns: 10 })).kind).toBe("created");
  return run;
}

/** Puts a call of a dead executor in the given state, as a crash would have left it. */
async function deadCall(store: InMemoryTitleWritingStore, runId: string, providerKey: LegacyProviderKey, clock: () => Date, submit: boolean) {
  const leaseUntil = new Date(clock().getTime() + 1000).toISOString();
  expect(await store.claimRun(WS, runId, "dead", clock().toISOString(), leaseUntil)).toBe(true);
  const id = randomUUID();
  await store.reserveCall({ id, runId, workspaceId: WS, stepKey: "concept", attemptNo: 1, providerKey, model: `${providerKey}-model`,
    requestHash: "a".repeat(64), state: "reserved", executorId: "dead", providerRequestId: null, responseModel: null, usage: EMPTY_USAGE,
    errorCode: null, createdAt: clock().toISOString(), finishedAt: null }, { sinceIso: "2026-10-15T00:00:00Z", maxCallsPerDay: 100 },
  clock().toISOString(), leaseUntil);
  if (submit) expect(await store.markCallSubmitted(WS, id, "dead", clock().toISOString(), leaseUntil)).toBe("submitted");
  return id;
}

describe.each(["qwen", "deepseek"] as const)("a run stored with the retired provider %s", (providerKey) => {
  it("is stopped before any reservation or send, keeping provider, model and input hash", async () => {
    const { store, engine, sends, reserve, clock } = harness();
    const run = await storedRun(store, providerKey, clock);
    await engine.drive(run.id);
    const after = (await store.getRunById(WS, run.id))!;
    expect(after.run).toMatchObject({ state: "needs_attention", errorCode: STOP[providerKey], executorId: null, callsUsed: 0,
      inputHash: run.inputHash, input: run.input });
    expect(after.run.input).toMatchObject({ providerKey, model: `${providerKey}-model` });
    expect(after.calls).toEqual([]);
    expect(reserve).not.toHaveBeenCalled();
    expect(sends).toEqual([]);
  });

  it("maintenance stops an unclaimed run so it no longer holds the active slot; nothing is sent or moved to another provider", async () => {
    const { store, engine, sends, clock } = harness();
    const projectId = randomUUID();
    const run = await storedRun(store, providerKey, clock, projectId);
    // While it runs it holds the project's single running slot.
    const blocked = newTitleRun({ workspaceId: WS, projectId, actorId: "owner", idempotencyKey: randomUUID(), title: TITLE,
      settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "anthropic", model: "claude-opus-5-5", now: clock() });
    expect((await store.createRun(blocked, { maxActiveRuns: 1 })).kind).toBe("active");
    await engine.maintain();
    expect((await store.getRunById(WS, run.id))!.run).toMatchObject({ state: "needs_attention", errorCode: STOP[providerKey] });
    expect(sends).toEqual([]);
    // The slot is free; a new Claude run of the same work starts and runs with its own provider only.
    expect((await store.createRun(blocked, { maxActiveRuns: 1 })).kind).toBe("created");
    await engine.drive(blocked.id);
    expect(sends.every((url) => url === "https://api.anthropic.com/v1/messages")).toBe(true);
    expect(sends).toHaveLength(5);
    expect((await store.getRunById(WS, run.id))!.calls).toEqual([]);
  });

  it("a run under another executor's live lease is left alone", async () => {
    const { store, engine, sends, clock } = harness();
    const run = await storedRun(store, providerKey, clock);
    expect(await store.claimRun(WS, run.id, "other", clock().toISOString(), new Date(clock().getTime() + 60_000).toISOString())).toBe(true);
    const before = (await store.getRunById(WS, run.id))!;
    await engine.maintain();
    await engine.drive(run.id);
    expect(await store.getRunById(WS, run.id)).toEqual(before);
    expect(sends).toEqual([]);
  });

  it("a call submitted before a crash becomes unknown with its cost unknown, and is never resent", async () => {
    const { store, engine, sends, reserve, clock, advance } = harness();
    const run = await storedRun(store, providerKey, clock);
    const callId = await deadCall(store, run.id, providerKey, clock, true);
    reserve.mockClear();
    advance(5_000);
    await engine.maintain();
    await engine.maintain();
    const view = titleRunView((await store.getRunById(WS, run.id))!);
    expect(view.state).toBe("needs_attention");
    expect(view.calls).toEqual([expect.objectContaining({ callId, providerKey, model: `${providerKey}-model`, state: "unknown",
      errorCode: "executor_lost", billingStatus: "unknown", usage: EMPTY_USAGE })]);
    expect(reserve).not.toHaveBeenCalled();
    expect(sends).toEqual([]);
  });

  it("a reservation never sent is closed as never sent, and the run then stops without a send", async () => {
    const { store, engine, sends, clock, advance } = harness();
    const run = await storedRun(store, providerKey, clock);
    await deadCall(store, run.id, providerKey, clock, false);
    advance(5_000);
    await engine.maintain();
    const after = (await store.getRunById(WS, run.id))!;
    expect(after.run).toMatchObject({ state: "needs_attention", errorCode: STOP[providerKey] });
    expect(after.calls.map((call) => [call.providerKey, call.state])).toEqual([[providerKey, "rejected"]]);
    expect(sends).toEqual([]);
  });

  it("a requested cancel still ends the run as canceled", async () => {
    const { store, engine, sends, clock } = harness();
    const run = await storedRun(store, providerKey, clock);
    await store.requestCancel(WS, run.projectId, run.id, clock().toISOString());
    await engine.drive(run.id);
    expect((await store.getRunById(WS, run.id))!.run).toMatchObject({ state: "canceled", errorCode: null });
    expect(sends).toEqual([]);
  });

  it("an uncertain call cannot be confirmed into a new send; the resume changes nothing", async () => {
    const { store, engine, sends, clock, advance } = harness();
    const run = await storedRun(store, providerKey, clock);
    await deadCall(store, run.id, providerKey, clock, true);
    advance(5_000);
    await engine.maintain();
    const bundle = (await store.getRunById(WS, run.id))!;
    const confirmed = uncertainCallIdsOf(bundle.steps, bundle.calls);
    expect(confirmed).toHaveLength(1);
    // A retired provider is never ready: the services pass providerReady false for it.
    const prepared = await store.prepareResume(WS, run.projectId, run.id, { resumeKey: randomUUID(),
      requestHash: hashTitleResume(run.id, confirmed), confirmedCallIds: confirmed, maxActiveRuns: 10, providerReady: false }, clock().toISOString());
    expect(prepared.kind).toBe("provider_unconfigured");
    expect(await store.getRunById(WS, run.id)).toEqual(bundle);
    await engine.maintain();
    expect(sends).toEqual([]);
  });
});

describe("a retired-provider run whose answers were all stored before the retirement", () => {
  it("finishes its save as the engine would, without a send, a second save or a new story version", async () => {
    const { store, engine, sends, saveStory, clock, advance } = harness();
    const projectId = randomUUID();
    store.addProject(WS, projectId);
    // The run was answered by its own provider before the retirement. Here a Claude double stands in for that
    // provider's answers; the executor stopped before the save, and the stored run is then the historical qwen run.
    const run = newTitleRun({ workspaceId: WS, projectId, actorId: "owner", idempotencyKey: randomUUID(), title: TITLE,
      settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "anthropic", model: "claude-opus-5-5", now: clock() });
    await store.createRun(run, { maxActiveRuns: 10 });
    saveStory.mockResolvedValueOnce("lost");
    await engine.drive(run.id);
    expect(sends).toHaveLength(5);
    const stored = store.runs.find((item) => item.id === run.id)!;
    stored.input = { ...stored.input, providerKey: "qwen", model: "qwen3.7-plus-2026-05-26" };
    for (const call of store.calls.filter((item) => item.runId === run.id)) Object.assign(call, { providerKey: "qwen", model: "qwen3.7-plus-2026-05-26" });
    const callsBefore = structuredClone(store.calls.filter((item) => item.runId === run.id));
    advance(5_000);
    await engine.maintain();
    const after = (await store.getRunById(WS, run.id))!;
    expect(after.run).toMatchObject({ state: "completed", storySave: "saved" });
    expect(after.run.input).toMatchObject({ providerKey: "qwen", model: "qwen3.7-plus-2026-05-26" });
    expect(after.calls).toEqual(callsBefore);
    expect(sends).toHaveLength(5);
    expect(store.projects.get(projectId)!.stories).toHaveLength(1);
    await engine.maintain();
    expect(store.projects.get(projectId)!.stories).toHaveLength(1);
    expect(saveStory).toHaveBeenCalledTimes(2);
  });
});

describe("the provider CHECK of an unmigrated database", () => {
  it("rejects storing a Claude run until the provider migration, and reports it as not ready", async () => {
    const store = new InMemoryTitleWritingStore();
    store.anthropicReady = false;
    expect(await store.providerStorageReady("anthropic")).toBe(false);
    expect(await store.providerStorageReady("openai")).toBe(true);
    const projectId = randomUUID();
    store.addProject(WS, projectId);
    const run = newTitleRun({ workspaceId: WS, projectId, actorId: "owner", idempotencyKey: randomUUID(), title: TITLE,
      settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "anthropic", model: "claude-opus-5-5", now: new Date() });
    await expect(store.createRun(run, { maxActiveRuns: 10 })).rejects.toThrow("check constraint");
    expect(store.runs).toEqual([]);
  });
});

describe("DeepSeek runs created after the reactivation", () => {
  it("run with DeepSeek only, with the frozen model, sending one Chat Completions request per step and never another provider", async () => {
    const { store, engine, sends, seen, clock } = harness(Date.parse("2026-10-17T08:00:00Z"));
    const projectId = randomUUID();
    store.addProject(WS, projectId);
    const run = newTitleRun({ workspaceId: WS, projectId, actorId: "owner", idempotencyKey: randomUUID(), title: TITLE,
      settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "deepseek", model: "deepseek-flash", now: clock() });
    expect((await store.createRun(run, { maxActiveRuns: 10 })).kind).toBe("created");
    await engine.drive(run.id);
    const after = (await store.getRunById(WS, run.id))!;
    expect(after.run).toMatchObject({ state: "completed", storySave: "saved", errorCode: null });
    expect(sends).toHaveLength(5);
    expect(new Set(sends)).toEqual(new Set(["https://api.deepseek.com/chat/completions"]));
    expect(after.calls.every((call) => call.providerKey === "deepseek" && call.model === "deepseek-flash" && call.state === "completed")).toBe(true);
    expect(seen.every((exchange) => exchange.body.model === "deepseek-flash")).toBe(true);
    // Usage is DeepSeek's own count; the cost stays unknown, never zero.
    expect(titleRunView(after).calls.every((call) => call.billingStatus === "unknown" && call.usage.totalTokens === 300)).toBe(true);
  });

  it("a DeepSeek failure is never moved to Claude or OpenAI and is not retried", async () => {
    const store = new InMemoryTitleWritingStore();
    const sends: string[] = [];
    const transport: WritingTransport = async (request) => { sends.push(request.url); return { status: 402, headers: { get: () => null }, body: new TextEncoder().encode("{}") }; };
    const engine = new TitleWritingEngine({ workspaceId: WS, store, providers, transport, maxCallsPerDay: 100,
      clock: () => new Date("2026-10-17T08:00:00Z"), leaseMs: 1000 });
    const projectId = randomUUID();
    store.addProject(WS, projectId);
    const run = newTitleRun({ workspaceId: WS, projectId, actorId: "owner", idempotencyKey: randomUUID(), title: TITLE,
      settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "deepseek", model: "deepseek-flash", now: new Date("2026-10-17T08:00:00Z") });
    await store.createRun(run, { maxActiveRuns: 10 });
    await engine.drive(run.id);
    await engine.maintain();
    expect(sends).toEqual(["https://api.deepseek.com/chat/completions"]);
    expect((await store.getRunById(WS, run.id))!.run).toMatchObject({ state: "failed", errorCode: "quota" });
  });

  it("a run whose frozen model is no longer allowed stops without a send and is never given another model", async () => {
    const { store, engine, sends, clock } = harness(Date.parse("2026-10-17T08:00:00Z"));
    const projectId = randomUUID();
    store.addProject(WS, projectId);
    const run = newTitleRun({ workspaceId: WS, projectId, actorId: "owner", idempotencyKey: randomUUID(), title: TITLE,
      settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "deepseek", model: "deepseek-v4-pro", now: clock() });
    await store.createRun(run, { maxActiveRuns: 10 });
    await engine.drive(run.id);
    expect((await store.getRunById(WS, run.id))!.run).toMatchObject({ state: "needs_attention", errorCode: "provider_unconfigured",
      input: expect.objectContaining({ model: "deepseek-v4-pro" }) });
    expect(sends).toEqual([]);
  });
});
