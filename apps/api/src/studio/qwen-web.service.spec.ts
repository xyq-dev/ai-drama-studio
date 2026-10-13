import { afterEach, describe, expect, it, vi } from "vitest";
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
  probes = 0;
  reservations = 0;
  maintenance = 0;
  constructor(private readonly ready: boolean) { super(); }
  async storageReady(): Promise<boolean> { this.probes += 1; return this.ready; }
  override async reserve(...args: Parameters<InMemoryQwenWebStore["reserve"]>) {
    this.reservations += 1;
    return super.reserve(...args);
  }
  override async recoverExpired(nowIso: string): Promise<number> {
    this.maintenance += 1;
    return super.recoverExpired(nowIso);
  }
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

  it("leases from the real send time when the process pauses after reserving (review P2)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-10-06T00:00:00.000Z");
    vi.setSystemTime(start);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const transport: QwenTransport = async () => {
      await gate;
      return { status: 200, headers: { get: () => null }, body: completion() };
    };
    const store = new TestStore(true);
    const reserve = store.reserve.bind(store);
    // The pause happens after the reservation and before the send, as a suspended host would. The provider then
    // computes the submit time and lease itself.
    store.reserve = async (...args) => {
      const reserved = await reserve(...args);
      vi.setSystemTime(new Date(start.getTime() + 90_000));
      return reserved;
    };
    const { service } = harness({ clock: undefined, store: store as unknown as PostgresQwenWebStore<QwenWritingInput>, transport });
    const running = service.request(PROJECT, { input: INPUT }, TOKEN, context("paused"));
    await vi.waitFor(async () => expect((await store.findByKey(WORKSPACE, "server-owner", "paused"))?.state).toBe("submitted"));
    vi.setSystemTime(new Date(start.getTime() + 121_000));
    expect(await store.recoverExpired(new Date().toISOString())).toBe(0);
    expect(Date.parse((await store.findByKey(WORKSPACE, "server-owner", "paused"))!.leaseUntil))
      .toBe(start.getTime() + 90_000 + QWEN_WEB_EXECUTOR_LEASE_MS);
    release();
    const done = await running;
    expect(done.body).toMatchObject({ request: { state: "completed" } });
    const stored = await store.findByKey(WORKSPACE, "server-owner", "paused");
    expect(Date.parse(stored!.updatedAt)).toBeGreaterThanOrEqual(start.getTime() + 121_000);
  });

  it("checks the operator token before any storage probe, reservation or send (closeout item 3)", async () => {
    for (const token of [undefined, "", "wrong-token-0000000", `${TOKEN}x`]) {
      // Storage present or absent must look the same to an unauthorized caller.
      for (const ready of [true, false]) {
        const { service, calls, store } = harness({ ready });
        expect(await service.status(token)).toMatchObject({ status: 403, body: { code: "QWEN_WEB_FORBIDDEN", ready: false, model: null } });
        expect(await service.request(PROJECT, { input: INPUT }, token, context("k"))).toEqual({ status: 403, body: { code: "QWEN_WEB_FORBIDDEN" } });
        expect(await service.get(PROJECT, "33333333-3333-4333-8333-333333333333", token)).toEqual({ status: 403, body: { code: "QWEN_WEB_FORBIDDEN" } });
        expect(store.probes).toBe(0);
        expect(store.reservations).toBe(0);
        expect(store.maintenance).toBe(0);
        expect(calls).toHaveLength(0);
      }
    }
    // Disabled and production keep their earlier answer, still without a probe.
    for (const overrides of [{ enabled: false }, { nodeEnv: "production" as const }]) {
      const { service, store, calls } = harness(overrides);
      expect(await service.request(PROJECT, { input: INPUT }, TOKEN, context("k"))).toEqual({ status: 404, body: { code: "QWEN_WEB_DISABLED" } });
      expect(store.probes).toBe(0);
      expect(calls).toHaveLength(0);
    }
    // A missing provider config is decided before the probe too.
    const noKey = harness({ provider: { ok: false, code: "missing_api_key" } });
    await noKey.service.status(TOKEN);
    expect(noKey.store.probes).toBe(0);
    // The right token probes exactly once per call.
    const authorized = harness({ ready: false });
    expect((await authorized.service.status(TOKEN)).body).toMatchObject({ code: "QWEN_WEB_STORAGE_UNAVAILABLE" });
    expect(authorized.store.probes).toBe(1);
  });

  it("refuses an input over 256,000 UTF-8 bytes before reserving or sending (closeout item 4)", async () => {
    // \u0001 serializes to six bytes. An episode input has two 20,000-character bodies, so a schema-legal input can
    // cross the cap; a story input (one body) cannot.
    const note = "\u0001".repeat(1_000);
    const base = { schema: "qwen.writing.input.v1", mode: "episode", episodeNo: 1, premise: note, genre: note,
      audience: note, characters: note, confirmedStory: "\u0001".repeat(20_000), currentText: "", revisionRequest: note,
      mustKeep: note, mustKeepDialogue: note, mustKeepEnding: note };
    const baseBytes = new TextEncoder().encode(JSON.stringify(base)).byteLength;
    const field = (bytes: number) => "\u0001".repeat(Math.floor(bytes / 6)) + "a".repeat(bytes % 6);
    const at = { ...base, currentText: field(256_000 - baseBytes) };
    const over = { ...base, currentText: field(256_001 - baseBytes) };
    expect(new TextEncoder().encode(JSON.stringify(at)).byteLength).toBe(256_000);
    expect(new TextEncoder().encode(JSON.stringify(over)).byteLength).toBe(256_001);
    expect(over.currentText.length).toBeLessThanOrEqual(20_000);
    const { parseQwenWritingInput } = await import("@ai-drama/contracts");
    expect(parseQwenWritingInput(over).ok).toBe(true);

    const refused = harness();
    expect(await refused.service.request(PROJECT, { input: over }, TOKEN, context("big"))).toEqual({ status: 413, body: { code: "QWEN_WEB_INPUT_TOO_LARGE" } });
    expect(refused.store.reservations).toBe(0);
    expect(refused.store.maintenance).toBe(0);
    expect(await refused.store.findByKey(WORKSPACE, "server-owner", "big")).toBeNull();
    expect(refused.calls).toHaveLength(0);

    // Exactly at the cap is sent once. The fake reply is a story plan, so the episode request ends rejected (422);
    // what matters here is that it was reserved and sent.
    const accepted = harness();
    const result = await accepted.service.request(PROJECT, { input: at }, TOKEN, context("edge"));
    expect(result.body).toMatchObject({ requestCount: 1 });
    expect(accepted.store.reservations).toBe(1);
    expect(accepted.calls).toHaveLength(1);
  });

  it("counts Chinese and emoji by UTF-8 bytes, not string length (closeout item 4)", async () => {
    // 3 bytes per CJK character and 4 per emoji: these inputs are far below 256,000 characters but not bytes.
    const { qwenWritingInputByteLength } = await import("@ai-drama/contracts");
    expect(qwenWritingInputByteLength("故")).toBe(5);
    expect(qwenWritingInputByteLength("😀")).toBe(6);
    expect("😀".length).toBe(2);
    const cjk = { ...INPUT, currentText: "故".repeat(20_000) };
    expect(JSON.stringify(cjk).length).toBeLessThan(25_000);
    expect(qwenWritingInputByteLength(cjk)).toBeGreaterThan(60_000);
    const { service, calls } = harness();
    expect((await service.request(PROJECT, { input: cjk }, TOKEN, context("cjk"))).status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
