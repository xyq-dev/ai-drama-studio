import { describe, expect, it } from "vitest";
import type { QwenWritingInput } from "@ai-drama/contracts";
import { PersistenceError, type PostgresQwenWebStore } from "@ai-drama/database";
import { InMemoryQwenWebStore, QWEN_WEB_EXECUTOR_LEASE_MS, type QwenTransport } from "@ai-drama/providers";
import { QwenWebService, type QwenWebDependencies } from "./qwen-web.service";

const SECRET = "sk-qwen-service-test-key-0b1c";
const TOKEN = "operator-token-0123456789";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const INPUT = {
  schema: "qwen.writing.input.v1", mode: "story", premise: "夜班便利店的班次记录被改过", genre: "悬疑",
  audience: "成人短剧观众", characters: "店员小林", mustKeep: "班次记录是真的", mustNotChange: "不能改成喜剧", currentText: "",
};
const PLAN = {
  schema: "ads.writing.story-plan.v1", logline: "模拟候选，不是千问真实生成结果", protagonistGoal: "守住班次记录",
  opposition: "店长能改时间", coreConflict: "解释会被当成承认", relationships: [{ name: "店员", pressure: "不能供出同事" }],
  episodes: [1, 2, 3].map((episodeNo) => ({ episodeNo, entryState: `进入${episodeNo}`, goal: `目标${episodeNo}`,
    action: `行动${episodeNo}`, turn: `转折${episodeNo}`, result: `结果${episodeNo}`, handoff: `交接${episodeNo}` })),
};

/** The provider protocol in memory plus the storage readiness switch the PostgreSQL store reports. */
class TestStore extends InMemoryQwenWebStore {
  constructor(private readonly ready: boolean) { super(); }
  async storageReady(): Promise<boolean> { return this.ready; }
}

function completion(): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    id: "chatcmpl-service", model: "qwen-test",
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(PLAN) } }],
  }));
}

function harness(overrides: Partial<QwenWebDependencies> & { ready?: boolean; status?: number } = {}) {
  const calls: string[] = [];
  const transport: QwenTransport = async (request) => {
    calls.push(request.body);
    return { status: overrides.status ?? 200, headers: { get: () => null }, body: completion() };
  };
  const store = new TestStore(overrides.ready ?? true);
  let now = new Date("2026-10-06T00:00:00.000Z");
  const service = new QwenWebService({
    workspaceId: WORKSPACE,
    nodeEnv: "development",
    enabled: true,
    operatorToken: TOKEN,
    provider: { ok: true, apiKey: SECRET, model: "qwen-test",
      url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions" },
    store: store as unknown as PostgresQwenWebStore<QwenWritingInput>,
    projects: { getProject: async (_workspace: string, projectId: string) => {
      if (projectId !== PROJECT) throw new PersistenceError("NOT_FOUND", "Project not found");
      return {} as never;
    } },
    transport,
    clock: () => now,
    ...overrides,
  });
  return { service, calls, store, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

const context = (key: string) => ({ actorId: "server-owner", traceId: "trace", idempotencyKey: key });

describe("QwenWebService", () => {
  it("refuses before any send when disabled, in production, without the operator or provider, or without storage", async () => {
    const off = harness({ enabled: false });
    expect((await off.service.status(TOKEN)).body).toMatchObject({ code: "QWEN_WEB_DISABLED", ready: false });
    const production = harness({ nodeEnv: "production" });
    expect((await production.service.request(PROJECT, { input: INPUT }, TOKEN, context("k"))).status).toBe(404);
    const stranger = harness();
    expect(await stranger.service.request(PROJECT, { input: INPUT }, "wrong-token-0000000", context("k")))
      .toEqual({ status: 403, body: { code: "QWEN_WEB_FORBIDDEN" } });
    const noKey = harness({ provider: { ok: false, code: "missing_api_key" } });
    expect(await noKey.service.request(PROJECT, { input: INPUT }, TOKEN, context("k")))
      .toEqual({ status: 503, body: { code: "QWEN_WEB_PROVIDER_UNCONFIGURED" } });
    const noStore = harness({ ready: false });
    expect(await noStore.service.status(TOKEN)).toMatchObject({ status: 503, body: { code: "QWEN_WEB_STORAGE_UNAVAILABLE", ready: false } });
    expect(await noStore.service.request(PROJECT, { input: INPUT }, TOKEN, context("k")))
      .toEqual({ status: 503, body: { code: "QWEN_WEB_STORAGE_UNAVAILABLE" } });
    for (const item of [off, production, stranger, noKey, noStore]) expect(item.calls).toEqual([]);
  });

  it("reports readiness without exposing the key", async () => {
    const ready = harness();
    const status = await ready.service.status(TOKEN);
    expect(status).toMatchObject({ status: 200, body: { code: "QWEN_WEB_READY", ready: true, model: "qwen-test",
      billingStatus: "unknown", replayPolicy: "NOT_REPLAY_SAFE" } });
    expect(JSON.stringify(status)).not.toContain(SECRET);
  });

  it("sends once, previews a parsed candidate, replays the key and refuses a changed input", async () => {
    const { service, calls } = harness();
    const first = await service.request(PROJECT, { input: INPUT }, TOKEN, context("key-1"));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ code: "completed", requestCount: 1, request: {
      projectId: PROJECT, mode: "story", state: "completed", billingStatus: "unknown", candidateExpired: false } });
    const serialized = JSON.stringify(first.body);
    expect(serialized).toContain("模拟候选");
    for (const hidden of [SECRET, "executorId", "frozenInput", "idempotencyKey", "actorId"]) {
      expect(serialized).not.toContain(hidden);
    }
    const replay = await service.request(PROJECT, { input: INPUT }, TOKEN, context("key-1"));
    expect(replay.body).toMatchObject({ requestCount: 0, request: { state: "completed" } });
    const changed = await service.request(PROJECT, { input: { ...INPUT, premise: "另一条前提" } }, TOKEN, context("key-1"));
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(calls).toHaveLength(1);
    const requestId = (first.body as { request: { requestId: string } }).request.requestId;
    expect((await service.get(PROJECT, requestId, TOKEN)).body).toMatchObject({ request: { state: "completed" } });
    await expect(service.get("33333333-3333-4333-8333-333333333333", requestId, TOKEN))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps an uncertain 5xx unknown, does not resend it and never writes a cost amount", async () => {
    const { service, calls } = harness({ status: 503 });
    const failed = await service.request(PROJECT, { input: INPUT }, TOKEN, context("unknown-key"));
    expect(failed.status).toBe(502);
    expect(failed.body).toMatchObject({ request: { state: "unknown", providerResult: "unknown", billingStatus: "unknown",
      candidateJson: null } });
    await service.request(PROJECT, { input: INPUT }, TOKEN, context("unknown-key"));
    expect(calls).toHaveLength(1);
  });

  it("validates the key, project and body before reserving", async () => {
    const { service, calls } = harness();
    await expect(service.request(PROJECT, { input: INPUT }, TOKEN, { actorId: "server-owner", traceId: "t" }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.request("33333333-3333-4333-8333-333333333333", { input: INPUT }, TOKEN, context("p")))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.request(PROJECT, { input: INPUT, model: "other" }, TOKEN, context("b")))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await service.request(PROJECT, { input: { ...INPUT, extra: true } }, TOKEN, context("i"))).body)
      .toEqual({ code: "invalid_input" });
    expect(calls).toEqual([]);
  });

  it("recovers an expired lease and clears an expired candidate on maintenance", async () => {
    const { service, advance } = harness();
    const done = await service.request(PROJECT, { input: INPUT }, TOKEN, context("expiring"));
    const requestId = (done.body as { request: { requestId: string } }).request.requestId;
    advance(QWEN_WEB_EXECUTOR_LEASE_MS + 8 * 24 * 60 * 60 * 1000);
    expect(await service.maintain()).toEqual({ recovered: 0, expired: 1 });
    const later = await service.get(PROJECT, requestId, TOKEN);
    expect(later.body).toMatchObject({ request: { state: "completed", candidateJson: null, candidateExpired: true } });
  });
});
