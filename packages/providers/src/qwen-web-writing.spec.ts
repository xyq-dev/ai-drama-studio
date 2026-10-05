import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseQwenWritingInput } from "@ai-drama/contracts";
import { QWEN_CHAT_MAX_TOKENS, buildQwenChatBody, type QwenTransport } from "./qwen-chat";
import { QWEN_WRITING_DEFAULT_MODEL } from "./qwen-writing";
import {
  InMemoryQwenWebStore,
  QWEN_WEB_REPLAY_POLICY,
  assertQwenWebTokenCap,
  qwenWebAccessDecision,
  runQwenWebWriting,
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

function base(store: InMemoryQwenWebStore, transport: QwenTransport, input: unknown = INPUT, key = "key-1") {
  const body = buildQwenChatBody({
    model: QWEN_WRITING_DEFAULT_MODEL,
    system: "return json",
    user: "story",
    tokenLimitField: "max_completion_tokens",
  });
  assertQwenWebTokenCap(body);
  return runQwenWebWriting({
    workspaceId: "workspace-1",
    projectId: "project-1",
    actorId: "operator-1",
    idempotencyKey: key,
    input,
    requestedModel: QWEN_WRITING_DEFAULT_MODEL,
    apiKey: SECRET,
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    body,
    store,
    transport,
  });
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

  it("treats a reserved row left by a crash as unknown and does not call the provider", async () => {
    const store = new InMemoryQwenWebStore();
    const now = new Date().toISOString();
    await store.insertReserved({
      id: "left-behind",
      workspaceId: "workspace-1",
      projectId: "project-1",
      actorId: "operator-1",
      idempotencyKey: "key-1",
      inputHash: frozenHash(),
      frozenInput: INPUT,
      mode: "story",
      episodeNo: null,
      requestedModel: QWEN_WRITING_DEFAULT_MODEL,
      state: "reserved",
      serverRequestId: null,
      errorCode: null,
      providerResult: null,
      candidateJson: null,
      candidateExpiresAt: null,
      billingStatus: "unknown",
      createdAt: now,
      updatedAt: now,
    });
    const calls: string[] = [];
    const transport: QwenTransport = async () => {
      calls.push("sent");
      throw new Error("should not send");
    };
    const result = await base(store, transport);
    expect(calls).toEqual([]);
    expect(result.requestCount).toBe(0);
    expect(result.record?.state).toBe("unknown");
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

  it("stops at the request and concurrency caps before any send", async () => {
    const store = new InMemoryQwenWebStore();
    const sent = transportOf(200, completion(PLAN));
    const capped = await runQwenWebWriting({
      ...(await requestOptions(store, sent.transport, "cap-key")),
      maxRequests: 0,
    });
    expect(capped.code).toBe("QWEN_WEB_REQUEST_CAP");
    expect(sent.calls).toEqual([]);
    const busy = new InMemoryQwenWebStore();
    const now = new Date().toISOString();
    await busy.insertReserved({
      id: "open-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
      actorId: "other",
      idempotencyKey: "other",
      inputHash: "cd".repeat(32),
      frozenInput: INPUT,
      mode: "story",
      episodeNo: null,
      requestedModel: QWEN_WRITING_DEFAULT_MODEL,
      state: "submitted",
      serverRequestId: null,
      errorCode: null,
      providerResult: null,
      candidateJson: null,
      candidateExpiresAt: null,
      billingStatus: "unknown",
      createdAt: now,
      updatedAt: now,
    });
    const blocked = await runQwenWebWriting({
      ...(await requestOptions(busy, sent.transport, "new-key")),
      maxConcurrency: 1,
    });
    expect(blocked.code).toBe("QWEN_WEB_CONCURRENCY_CAP");
    expect(sent.calls).toEqual([]);
  });
});

function frozenHash(): string {
  const parsed = parseQwenWritingInput(INPUT);
  if (!parsed.ok) throw new Error("input");
  return createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex");
}

async function requestOptions(store: InMemoryQwenWebStore, transport: QwenTransport, key: string) {
  const body = buildQwenChatBody({
    model: QWEN_WRITING_DEFAULT_MODEL,
    system: "return json",
    user: "story",
    tokenLimitField: "max_completion_tokens",
  });
  return {
    workspaceId: "workspace-1",
    projectId: "project-1",
    actorId: "operator-1",
    idempotencyKey: key,
    input: INPUT,
    requestedModel: QWEN_WRITING_DEFAULT_MODEL,
    apiKey: SECRET,
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    body,
    store,
    transport,
  };
}
