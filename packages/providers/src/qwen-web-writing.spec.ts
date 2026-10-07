import { describe, expect, it } from "vitest";
import { QWEN_CHAT_MAX_TOKENS, buildQwenChatBody, type QwenTransport } from "./qwen-chat";
import { QWEN_WRITING_DEFAULT_MODEL } from "./qwen-writing";
import {
  InMemoryQwenWebStore,
  QWEN_WEB_EXECUTOR_LEASE_MS,
  QWEN_WEB_INPUT_TOO_LARGE,
  QWEN_WEB_LOST_AFTER_SEND,
  QWEN_WEB_LOST_BEFORE_SEND,
  QWEN_WEB_REPLAY_POLICY,
  assertQwenWebTokenCap,
  qwenWebAccessDecision,
  qwenWebProviderConfig,
  runQwenWebWriting,
  type QwenWebRecord,
  type RunQwenWebWritingInput,
} from "./qwen-web-writing";

const SECRET = "sk-qwen-web-test-key-9f3a";
const INPUT = {
  schema: "qwen.writing.input.v1",
  mode: "story" as const,
  premise: "夜班便利店的班次记录被改过",
  genre: "悬疑",
  audience: "成人短剧观众",
  characters: "店员小林",
  mustKeep: "班次记录是真的",
  mustNotChange: "不能改成喜剧",
  currentText: "",
};

const PLAN = {
  schema: "ads.writing.story-plan.v1",
  logline: "模拟候选，不是千问真实生成结果",
  protagonistGoal: "守住班次记录",
  opposition: "店长能改时间",
  coreConflict: "解释会被当成承认",
  relationships: [{ name: "店员", pressure: "不能供出同事" }],
  episodes: [1, 2, 3].map((episodeNo) => ({
    episodeNo,
    entryState: `进入${episodeNo}`,
    goal: `目标${episodeNo}`,
    action: `行动${episodeNo}`,
    turn: `转折${episodeNo}`,
    result: `结果${episodeNo}`,
    handoff: `交接${episodeNo}`,
  })),
};

function completion(content: unknown) {
  return new TextEncoder().encode(JSON.stringify({
    id: "chatcmpl-web-1",
    model: QWEN_WRITING_DEFAULT_MODEL,
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  }));
}

function transportOf(status: number, body: Uint8Array | null, requestId = "req-web-1") {
  const calls: string[] = [];
  const transport: QwenTransport = async () => {
    calls.push("sent");
    if (calls.length > 1) throw new Error("retry");
    return { status, headers: { get: (name: string) => name.toLowerCase() === "x-request-id" ? requestId : null }, body };
  };
  return { calls, transport };
}

function requestOptions(store: InMemoryQwenWebStore, transport: QwenTransport, key = "key-1"): RunQwenWebWritingInput {
  return {
    workspaceId: "workspace-1",
    projectId: "project-1",
    actorId: "operator-1",
    idempotencyKey: key,
    input: INPUT,
    requestedModel: QWEN_WRITING_DEFAULT_MODEL,
    apiKey: SECRET,
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    store,
    transport,
  };
}

function base(store: InMemoryQwenWebStore, transport: QwenTransport, input: unknown = INPUT, key = "key-1") {
  return runQwenWebWriting({ ...requestOptions(store, transport, key), input });
}

function pendingTransport() {
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const transport: QwenTransport = async () => {
    calls += 1;
    notifyStarted();
    await released;
    return { status: 200, headers: { get: () => null }, body: completion(PLAN) };
  };
  return { transport, started, release: () => release(), calls: () => calls };
}

describe("qwen web writing", () => {
  it("stays closed unless an operator, a non-production flag, and storage are all present", () => {
    expect(QWEN_WEB_REPLAY_POLICY).toBe("NOT_REPLAY_SAFE");
    expect(qwenWebAccessDecision({
      nodeEnv: "production", enabled: true, storageReady: true, configuredToken: "op", presentedToken: "op",
    })).toEqual({ status: 404, code: "QWEN_WEB_DISABLED" });
    expect(qwenWebAccessDecision({
      nodeEnv: "development", enabled: false, storageReady: true, configuredToken: "op", presentedToken: "op",
    }).code).toBe("QWEN_WEB_DISABLED");
    expect(qwenWebAccessDecision({
      nodeEnv: "development", enabled: true, storageReady: true, configuredToken: "op", presentedToken: "no",
    }).code).toBe("QWEN_WEB_FORBIDDEN");
    expect(qwenWebAccessDecision({
      nodeEnv: "development", enabled: true, storageReady: false, configuredToken: "op", presentedToken: "op",
    })).toEqual({ status: 503, code: "QWEN_WEB_STORAGE_UNAVAILABLE" });
    expect(qwenWebAccessDecision({
      nodeEnv: "development", enabled: true, storageReady: true, providerReady: false,
      configuredToken: "op", presentedToken: "op",
    })).toEqual({ status: 503, code: "QWEN_WEB_PROVIDER_UNCONFIGURED" });
    expect(qwenWebAccessDecision({
      nodeEnv: "development", enabled: true, storageReady: true, providerReady: true,
      configuredToken: "op", presentedToken: null,
    }).code).toBe("QWEN_WEB_FORBIDDEN");
    expect(qwenWebAccessDecision({
      nodeEnv: "development", enabled: true, storageReady: true, providerReady: true,
      configuredToken: "op", presentedToken: "op",
    })).toEqual({ status: 200, code: "QWEN_WEB_READY" });
  });

  it("resolves only a server-side key, the official endpoint and a safe model", () => {
    expect(qwenWebProviderConfig({})).toEqual({ ok: false, code: "missing_api_key" });
    expect(qwenWebProviderConfig({ DASHSCOPE_API_KEY: SECRET })).toEqual({ ok: false, code: "missing_base_url" });
    expect(qwenWebProviderConfig({ DASHSCOPE_API_KEY: SECRET, BAILIAN_BASE_URL: "https://example.com/compatible-mode/v1" }))
      .toEqual({ ok: false, code: "unofficial_host" });
    expect(qwenWebProviderConfig({ DASHSCOPE_API_KEY: SECRET,
      BAILIAN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1", QWEN_WEB_MODEL: "bad model" }))
      .toEqual({ ok: false, code: "invalid_model" });
    expect(qwenWebProviderConfig({ DASHSCOPE_API_KEY: SECRET,
      BAILIAN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1" })).toEqual({
      ok: true, apiKey: SECRET, model: QWEN_WRITING_DEFAULT_MODEL,
      url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    });
  });

  it("persists submitted before the single fake response and does not call again for the same key", async () => {
    const store = new InMemoryQwenWebStore();
    const calls: string[] = [];
    const transport: QwenTransport = async () => {
      const pending = await store.findByKey("workspace-1", "operator-1", "key-1");
      expect(pending?.state).toBe("submitted");
      calls.push("sent");
      if (calls.length > 1) throw new Error("retry");
      return {
        status: 200,
        headers: { get: (name: string) => name.toLowerCase() === "x-request-id" ? "req-web-1" : null },
        body: completion(PLAN),
      };
    };
    const saved = await base(store, transport);
    expect(calls).toEqual(["sent"]);
    expect(saved.requestCount).toBe(1);
    expect(saved.record?.state).toBe("completed");
    expect(saved.record?.billingStatus).toBe("unknown");
    expect(saved.record?.candidateJson).toContain("模拟候选");
    expect(JSON.stringify(saved.record)).not.toContain(SECRET);
    expect(saved.record?.candidateExpiresAt).toBeTruthy();
    const body = buildQwenChatBody({
      model: QWEN_WRITING_DEFAULT_MODEL,
      system: "return json",
      user: "story",
      tokenLimitField: "max_completion_tokens",
    });
    expect(JSON.parse(body).max_completion_tokens).toBe(QWEN_CHAT_MAX_TOKENS);
    const again = await base(store, transport);
    expect(calls).toEqual(["sent"]);
    expect(again.requestCount).toBe(0);
    expect(again.record?.id).toBe(saved.record?.id);
  });

  it("rejects the same idempotency key with different input and does not resend an unknown 5xx", async () => {
    const store = new InMemoryQwenWebStore();
    const server = transportOf(503, new TextEncoder().encode(JSON.stringify({ error: { message: SECRET, detail: "boom" } })));
    const failed = await base(store, server.transport);
    expect(server.calls).toEqual(["sent"]);
    expect(failed.record?.state).toBe("unknown");
    expect(failed.record?.providerResult).toBe("unknown");
    expect(failed.record?.serverRequestId).toBe("req-web-1");
    expect(JSON.stringify(failed.record)).not.toContain(SECRET);
    expect(JSON.stringify(failed.record)).not.toContain("boom");
    const replay = await base(store, server.transport);
    expect(server.calls).toEqual(["sent"]);
    expect(replay.requestCount).toBe(0);
    const changed = await base(store, server.transport, { ...INPUT, premise: "另一条前提，仍然是测试输入" });
    expect(changed.status).toBe(409);
    expect(changed.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(server.calls).toEqual(["sent"]);
  });

  it("recovers a submitted request only after its executor lease expires, and fences the late sender", async () => {
    const store = new InMemoryQwenWebStore();
    const pending = pendingTransport();
    const start = new Date("2026-10-06T00:00:00.000Z");
    let clock = start;
    const running = runQwenWebWriting({ ...requestOptions(store, pending.transport), now: start, clock: () => clock });
    await pending.started;
    const active = await store.findByKey("workspace-1", "operator-1", "key-1");
    expect(active?.state).toBe("submitted");
    // A replay is never evidence that the executor died, and a live lease blocks recovery.
    const replay = await base(store, pending.transport);
    expect(replay.record?.state).toBe("submitted");
    expect(await store.recoverExpired(new Date(start.getTime() + QWEN_WEB_EXECUTOR_LEASE_MS - 1).toISOString())).toBe(0);
    expect((await store.findByKey("workspace-1", "operator-1", "key-1"))?.state).toBe("submitted");
    expect(pending.calls()).toBe(1);

    clock = new Date(start.getTime() + QWEN_WEB_EXECUTOR_LEASE_MS + 1);
    expect(await store.recoverExpired(clock.toISOString())).toBe(1);
    const recovered = await store.findByKey("workspace-1", "operator-1", "key-1");
    expect(recovered).toMatchObject({ state: "unknown", providerResult: "unknown", errorCode: QWEN_WEB_LOST_AFTER_SEND,
      candidateJson: null, billingStatus: "unknown" });
    pending.release();
    expect((await running).record?.state).toBe("unknown");
    const afterRecovery = await base(store, pending.transport);
    expect(afterRecovery.record?.state).toBe("unknown");
    expect(afterRecovery.requestCount).toBe(0);
    expect(pending.calls()).toBe(1);
  });

  it("marks a reservation that never reached the provider as rejected, not unknown", async () => {
    const store = new InMemoryQwenWebStore();
    const now = "2026-10-06T00:00:00.000Z";
    const record: QwenWebRecord = {
      id: "reserved-only", workspaceId: "workspace-1", projectId: "project-1", actorId: "operator-1",
      idempotencyKey: "crashed-before-send", inputHash: "ab".repeat(32), frozenInput: INPUT, mode: "story",
      episodeNo: null, requestedModel: QWEN_WRITING_DEFAULT_MODEL, state: "reserved", executorId: "dead",
      leaseUntil: "2026-10-06T00:02:00.000Z", serverRequestId: null, errorCode: null, providerResult: null,
      candidateJson: null, candidateExpiresAt: null, billingStatus: "unknown", createdAt: now, updatedAt: now,
    };
    await store.reserve(record, { sinceIso: now, maxRequests: 8, maxConcurrency: 1 });
    expect(await store.markSubmitted("reserved-only", "other-executor", now, "2026-10-06T00:04:00.000Z")).toBe(false);
    expect(await store.markSubmitted("reserved-only", "dead", "2026-10-06T00:03:00.000Z", "2026-10-06T00:05:00.000Z"))
      .toBe(false);
    expect(await store.recoverExpired("2026-10-06T00:02:00.001Z")).toBe(1);
    expect(await store.findById("workspace-1", "project-1", "reserved-only")).toMatchObject({
      state: "rejected", errorCode: QWEN_WEB_LOST_BEFORE_SEND, providerResult: null,
    });
    expect(await store.findById("workspace-1", "other-project", "reserved-only")).toBeNull();
  });

  it("lets only the owning executor finish a submitted request", async () => {
    const store = new InMemoryQwenWebStore();
    const pending = pendingTransport();
    const running = runQwenWebWriting({ ...requestOptions(store, pending.transport), executorId: "owner" });
    await pending.started;
    const active = await store.findByKey("workspace-1", "operator-1", "key-1");
    const forged = await store.finish(active!.id, "intruder", {
      state: "completed", serverRequestId: null, errorCode: null, providerResult: "completed",
      candidateJson: "{}", candidateExpiresAt: null, updatedAt: new Date().toISOString(),
    });
    expect(forged.state).toBe("submitted");
    pending.release();
    expect((await running).record?.state).toBe("completed");
  });

  it("clears an expired candidate and keeps the idempotency row", async () => {
    const store = new InMemoryQwenWebStore();
    const sent = transportOf(200, completion(PLAN));
    const saved = await base(store, sent.transport);
    expect(saved.record?.candidateJson).toContain("ads.writing.story-plan.v1");
    const cleared = await store.expireCandidates(saved.record?.candidateExpiresAt ?? "");
    expect(cleared).toBe(1);
    const kept = await store.findByKey("workspace-1", "operator-1", "key-1");
    expect(kept?.candidateJson).toBeNull();
    expect(kept?.idempotencyKey).toBe("key-1");
    expect(kept?.inputHash).toMatch(/^[0-9a-f]{64}$/);
    const replay = await base(store, sent.transport);
    expect(sent.calls).toEqual(["sent"]);
    expect(replay.requestCount).toBe(0);
  });

  it("stops at a zero request cap before sending", async () => {
    const store = new InMemoryQwenWebStore();
    const sent = transportOf(200, completion(PLAN));
    const capped = await runQwenWebWriting({ ...requestOptions(store, sent.transport, "cap-key"), maxRequests: 0 });
    expect(capped.code).toBe("QWEN_WEB_REQUEST_CAP");
    expect(sent.calls).toEqual([]);
  });

  it.each([
    { maxRequests: 1, maxConcurrency: 10, code: "QWEN_WEB_REQUEST_CAP" },
    { maxRequests: 10, maxConcurrency: 1, code: "QWEN_WEB_CONCURRENCY_CAP" },
  ])("atomically reserves different concurrent keys for $code", async ({ maxRequests, maxConcurrency, code }) => {
    const store = new InMemoryQwenWebStore();
    const pending = pendingTransport();
    const results = Promise.all(["key-a", "key-b"].map((key) => runQwenWebWriting({
      ...requestOptions(store, pending.transport, key), maxRequests, maxConcurrency,
    })));
    await pending.started;
    expect(pending.calls()).toBe(1);
    pending.release();
    const settled = await results;
    expect(settled.map((result) => result.code).sort()).toEqual([code, "completed"].sort());
    expect(settled.reduce((sum, result) => sum + result.requestCount, 0)).toBe(1);
    expect(pending.calls()).toBe(1);
  });

  it("keeps a same-key concurrent replay pending without freeing its concurrency slot", async () => {
    const store = new InMemoryQwenWebStore();
    const pending = pendingTransport();
    const firstAndReplay = Promise.all([base(store, pending.transport), base(store, pending.transport)]);
    await pending.started;
    const submittedReplay = await base(store, pending.transport);
    expect(submittedReplay.record?.state).toBe("submitted");
    expect(submittedReplay.requestCount).toBe(0);
    const other = await base(store, pending.transport, INPUT, "different-key");
    expect(other.code).toBe("QWEN_WEB_CONCURRENCY_CAP");
    expect(pending.calls()).toBe(1);
    pending.release();
    const settled = await firstAndReplay;
    expect(settled.filter((result) => result.requestCount === 1)).toHaveLength(1);
    expect(settled.find((result) => result.requestCount === 0)?.record?.state).toMatch(/^(reserved|submitted)$/);
  });

  it("binds idempotency to project and model as well as validated input", async () => {
    const store = new InMemoryQwenWebStore();
    const pending = pendingTransport();
    const original = base(store, pending.transport);
    await pending.started;
    const changed = await Promise.all([
      runQwenWebWriting({ ...requestOptions(store, pending.transport), projectId: "other-project" }),
      runQwenWebWriting({ ...requestOptions(store, pending.transport), requestedModel: "other-model" }),
    ]);
    expect(changed.map((result) => result.code)).toEqual(["IDEMPOTENCY_KEY_REUSED", "IDEMPOTENCY_KEY_REUSED"]);
    expect(pending.calls()).toBe(1);
    pending.release();
    await original;
  });

  it("constructs the capped request from validated input instead of accepting an arbitrary body", async () => {
    const store = new InMemoryQwenWebStore();
    const calls: string[] = [];
    const transport: QwenTransport = async (request) => {
      assertQwenWebTokenCap(request.body);
      const body = JSON.parse(request.body);
      expect(body.model).toBe(QWEN_WRITING_DEFAULT_MODEL);
      expect(body.messages[1].content).toContain(INPUT.premise);
      expect(body.messages[1].content).toContain(INPUT.characters);
      calls.push(request.body);
      return { status: 200, headers: { get: () => null }, body: completion(PLAN) };
    };
    const result = await runQwenWebWriting({ ...requestOptions(store, transport), ...{ body: "untrusted caller body" } });
    expect(result.code).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("untrusted caller body");
  });

  it("refuses an input over 256,000 UTF-8 bytes before reserving or sending, and keeps the same key usable", async () => {
    const store = new InMemoryQwenWebStore();
    const sent = transportOf(200, completion(PLAN));
    let reservations = 0;
    const reserve = store.reserve.bind(store);
    store.reserve = async (...args) => { reservations += 1; return reserve(...args); };
    const note = "\u0001".repeat(1_000);
    const episode = { schema: "qwen.writing.input.v1", mode: "episode", episodeNo: 1, premise: note, genre: note,
      audience: note, characters: note, confirmedStory: "\u0001".repeat(20_000), currentText: "\u0001".repeat(20_000),
      revisionRequest: note, mustKeep: note, mustKeepDialogue: note, mustKeepEnding: note };
    const refused = await base(store, sent.transport, episode, "big-key");
    expect(refused).toEqual({ status: 413, code: QWEN_WEB_INPUT_TOO_LARGE, requestCount: 0, record: null });
    expect(reservations).toBe(0);
    expect(await store.findByKey("workspace-1", "operator-1", "big-key")).toBeNull();
    expect(sent.calls).toEqual([]);
    // Nothing was recorded under the key, so a corrected input on the same key is a first request.
    const corrected = await base(store, sent.transport, INPUT, "big-key");
    expect(corrected.code).toBe("completed");
    expect(sent.calls).toHaveLength(1);
  });
});
