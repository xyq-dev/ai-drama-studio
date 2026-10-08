// Workspace isolation of title writing maintenance. In-memory store and controllable provider double; the PostgreSQL
// counterpart is in packages/database/src/title-writing-store.acceptance.spec.ts and runs only on an authorized database.
import { describe, expect, it } from "vitest";
import {
  InMemoryTitleWritingStore,
  TitleWritingEngine,
  newTitleRun,
  titleWritingProviderConfigs,
  type TitleWritingProviderEnv,
} from "@ai-drama/providers";
import { fixtureChatTransport, type FixtureExchange } from "@ai-drama/providers/title-writing-fixtures";
import { TitleWritingService } from "./title-writing.service";

const WA = "11111111-1111-4111-8111-111111111111";
const WB = "99999999-9999-4999-8999-999999999999";
const PA = "22222222-2222-4222-8222-222222222222";
const PB = "88888888-8888-4888-8888-888888888888";
const PB2 = "88888888-8888-4888-8888-000000000002";
const TOKEN = "operator-token-0123456789";
const CONFIGURED: TitleWritingProviderEnv = {
  DASHSCOPE_API_KEY: "sk-test-secret-abcdefghijkl", BAILIAN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1", TITLE_WRITING_QWEN_MODELS: "q-1",
};
const SETTINGS = { episodeCount: 3 as const, episodeSeconds: 90, style: "" };

function workspace(store: InMemoryTitleWritingStore, workspaceId: string, options: { enabled: boolean; env: TitleWritingProviderEnv; clock: () => Date }) {
  const seen: FixtureExchange[] = [];
  const providers = titleWritingProviderConfigs(options.env);
  const engine = new TitleWritingEngine({ workspaceId, store, providers, transport: fixtureChatTransport("夜班证词", { seen }),
    maxCallsPerDay: 30, clock: options.clock });
  const service = new TitleWritingService({
    workspaceId, nodeEnv: "test", enabled: options.enabled, operatorToken: TOKEN, defaultProvider: null, providers, store, engine,
    projects: { getProject: async () => ({}) as never }, maxCallsPerDay: 30, maxActiveRuns: 5, clock: options.clock, schedule: () => undefined,
  });
  return { service, seen, engine };
}

/** Workspace B gets two recoverable runs: one whose executor died after sending, one never started. */
async function seedWorkspaceB(store: InMemoryTitleWritingStore, clock: () => Date) {
  store.addProject(WB, PB);
  store.addProject(WB, PB2);
  const sent = newTitleRun({ workspaceId: WB, projectId: PB, actorId: "b", idempotencyKey: "sent", title: "乙", providerKey: "qwen", model: "q-1",
    settings: SETTINGS, now: clock() });
  await store.createRun(sent, { maxActiveRuns: 5 });
  const lease = new Date(clock().getTime() + 1000).toISOString();
  expect(await store.claimRun(WB, sent.id, "dead-b", clock().toISOString(), lease)).toBe(true);
  const callId = "77777777-7777-4777-8777-777777777777";
  await store.reserveCall({ id: callId, runId: sent.id, workspaceId: WB, stepKey: "concept", attemptNo: 1, providerKey: "qwen", model: "q-1",
    requestHash: "h", state: "reserved", executorId: "dead-b", providerRequestId: null, responseModel: null,
    usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null }, errorCode: null, createdAt: clock().toISOString(),
    finishedAt: null }, { sinceIso: "2000-01-01T00:00:00Z", maxCallsPerDay: 30 }, clock().toISOString(), lease);
  expect(await store.markCallSubmitted(WB, callId, "dead-b", clock().toISOString(), lease)).toBe(true);
  const idle = newTitleRun({ workspaceId: WB, projectId: PB2, actorId: "b", idempotencyKey: "idle", title: "乙二", providerKey: "qwen", model: "q-1",
    settings: SETTINGS, now: clock() });
  await store.createRun(idle, { maxActiveRuns: 5 });
  return { sent, idle };
}

function snapshotOf(store: InMemoryTitleWritingStore, workspaceId: string) {
  const runIds = store.runs.filter((run) => run.workspaceId === workspaceId).map((run) => run.id);
  return structuredClone({
    runs: store.runs.filter((run) => run.workspaceId === workspaceId),
    steps: store.steps.filter((step) => runIds.includes(step.runId)),
    calls: store.calls.filter((call) => call.workspaceId === workspaceId),
    stories: store.projects.get(PB)?.stories,
  });
}

describe("title writing maintenance stays inside its workspace", () => {
  it("A's pass (on, with keys) never fences, claims, finishes or sends for B (off, no keys)", async () => {
    let now = Date.parse("2026-10-08T00:00:00Z");
    const clock = () => new Date(now);
    const store = new InMemoryTitleWritingStore();
    store.addProject(WA, PA);
    const b = await seedWorkspaceB(store, clock);
    const own = newTitleRun({ workspaceId: WA, projectId: PA, actorId: "a", idempotencyKey: "own", title: "甲", providerKey: "qwen", model: "q-1",
      settings: SETTINGS, now: clock() });
    await store.createRun(own, { maxActiveRuns: 5 });
    const a = workspace(store, WA, { enabled: true, env: CONFIGURED, clock });
    const bSide = workspace(store, WB, { enabled: false, env: {}, clock });
    const before = snapshotOf(store, WB);
    now += 5000;

    await a.service.maintain();
    await a.engine.drive(b.idle.id);
    await a.engine.drive(b.sent.id);

    expect(a.seen.map((item) => item.step)).toEqual(["concept", "outline", "episode:1", "episode:2", "episode:3"]);
    expect(a.seen.every((item) => item.user.includes("剧名：甲"))).toBe(true);
    expect((await store.getRunById(WA, own.id))!.run).toMatchObject({ state: "completed", callsUsed: 5 });
    expect(snapshotOf(store, WB)).toEqual(before);
    expect(await store.getRunById(WA, b.sent.id)).toBeNull();

    // B's own pass with its switch off fences only B's expired executor and sends nothing.
    await bSide.service.maintain();
    expect(bSide.seen).toHaveLength(0);
    expect((await store.getRunById(WB, b.sent.id))!.run).toMatchObject({ state: "needs_attention", errorCode: "executor_lost", callsUsed: 1 });
    expect((await store.getRunById(WB, b.idle.id))!.run).toMatchObject({ state: "running", callsUsed: 0, executorId: null });
    expect((await store.getRunById(WA, own.id))!.run).toMatchObject({ state: "completed", callsUsed: 5 });
  });

  it("B's pass with B's own keys runs only B's runs, with B's provider configuration", async () => {
    let now = Date.parse("2026-10-08T00:00:00Z");
    const clock = () => new Date(now);
    const store = new InMemoryTitleWritingStore();
    store.addProject(WA, PA);
    const b = await seedWorkspaceB(store, clock);
    const own = newTitleRun({ workspaceId: WA, projectId: PA, actorId: "a", idempotencyKey: "own", title: "甲", providerKey: "qwen", model: "q-1",
      settings: SETTINGS, now: clock() });
    await store.createRun(own, { maxActiveRuns: 5 });
    const before = snapshotOf(store, WA);
    const bSide = workspace(store, WB, { enabled: true, env: CONFIGURED, clock });
    now += 5000;
    await bSide.service.maintain();
    expect(bSide.seen.every((item) => item.user.includes("剧名：乙二"))).toBe(true);
    expect((await store.getRunById(WB, b.idle.id))!.run.state).toBe("completed");
    expect(snapshotOf(store, WA)).toEqual(before);
  });

  it("refuses an engine bound to another workspace", () => {
    const store = new InMemoryTitleWritingStore();
    const providers = titleWritingProviderConfigs(CONFIGURED);
    const engine = new TitleWritingEngine({ workspaceId: WB, store, providers, transport: fixtureChatTransport("x"), maxCallsPerDay: 30 });
    expect(() => new TitleWritingService({ workspaceId: WA, nodeEnv: "test", enabled: true, operatorToken: TOKEN, defaultProvider: null,
      providers, store, engine, projects: { getProject: async () => ({}) as never }, maxCallsPerDay: 30, maxActiveRuns: 1 }))
      .toThrow("another workspace");
  });
});
