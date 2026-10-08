import { describe, expect, it } from "vitest";
import { TITLE_WRITING_JSON_SCHEMAS } from "@ai-drama/contracts";
import {
  DEEPSEEK_CHAT_URL,
  OPENAI_RESPONSES_URL,
  WRITING_ADAPTERS,
  sendWriting,
  titleWritingProviderConfigs,
  type WritingAdapter,
  type WritingRequest,
  type WritingTransport,
} from "./text-writing";

const KEY = "sk-test-secret-0123456789";
const REQUEST: WritingRequest = {
  model: "model-a",
  system: "系统 json",
  user: "用户",
  schemaName: TITLE_WRITING_JSON_SCHEMAS.concept.name,
  jsonSchema: TITLE_WRITING_JSON_SCHEMAS.concept.schema,
  maxOutputTokens: 4096,
};

function reply(status: number, body: unknown, headers: Record<string, string> = {}): WritingTransport {
  return async () => ({
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: body === null ? null : new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
  });
}

function chat(content: string, finish = "stop") {
  return { id: "req-1", model: "model-a", choices: [{ message: { role: "assistant", content }, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } };
}

function responses(text: string, extra: Record<string, unknown> = {}) {
  return { id: "resp_1", model: "model-a", status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 }, ...extra };
}

async function send(adapter: WritingAdapter, transport: WritingTransport) {
  return sendWriting({ adapter, url: "https://example.invalid/x", apiKey: KEY, request: REQUEST, transport });
}

describe("request mapping stays inside each adapter", () => {
  it("qwen: chat completions with json_object, thinking off and max_completion_tokens", () => {
    const body = JSON.parse(WRITING_ADAPTERS.qwen.buildBody(REQUEST)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "model-a", stream: false, enable_thinking: false, max_completion_tokens: 4096,
      n: 1, response_format: { type: "json_object" } });
    expect(body.messages).toEqual([{ role: "system", content: "系统 json" }, { role: "user", content: "用户" }]);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("deepseek: json_object, thinking disabled and max_tokens", () => {
    const body = JSON.parse(WRITING_ADAPTERS.deepseek.buildBody(REQUEST)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "model-a", stream: false, thinking: { type: "disabled" }, max_tokens: 4096,
      response_format: { type: "json_object" } });
    expect(body).not.toHaveProperty("enable_thinking");
  });

  it("openai: Responses API with a strict json_schema format, max_output_tokens and store false", () => {
    const body = JSON.parse(WRITING_ADAPTERS.openai.buildBody(REQUEST)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "model-a", instructions: "系统 json", input: "用户", store: false, max_output_tokens: 4096,
      text: { format: { type: "json_schema", name: "title_concept", strict: true } } });
    expect((body.text as { format: { schema: unknown } }).format.schema).toEqual(TITLE_WRITING_JSON_SCHEMAS.concept.schema);
    expect(body).not.toHaveProperty("messages");
  });

  it("sends the key only as a bearer header and never in the body", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    for (const adapter of Object.values(WRITING_ADAPTERS)) {
      await sendWriting({ adapter, url: "https://example.invalid/x", apiKey: KEY, request: REQUEST,
        transport: async (request) => { seen.push(request); return { status: 401, headers: { get: () => null }, body: null }; } });
    }
    expect(seen).toHaveLength(3);
    for (const request of seen) {
      expect(request.headers.Authorization).toBe(`Bearer ${KEY}`);
      expect(request.body).not.toContain(KEY);
    }
  });
});

describe("output parsing", () => {
  it.each(["qwen", "deepseek"] as const)("%s: one stop choice is answered with usage", async (key) => {
    const result = await send(WRITING_ADAPTERS[key], reply(200, chat("{\"a\":1}")));
    expect(result).toMatchObject({ outcome: "answered", content: "{\"a\":1}", providerRequestId: "req-1", responseModel: "model-a",
      usage: { status: "present", inputTokens: 10, outputTokens: 20, totalTokens: 30 } });
  });

  it.each([
    ["length", "truncated"], ["content_filter", "refusal"], ["tool_calls", "invalid_output"], ["insufficient_system_resource", "invalid_output"],
  ])("chat finish_reason %s is rejected as %s", async (finish, code) => {
    const result = await send(WRITING_ADAPTERS.deepseek, reply(200, chat("{}", finish)));
    expect(result).toMatchObject({ outcome: "rejected", errorCode: code, content: null });
  });

  it("deepseek empty content (documented for json mode) is rejected, not saved", async () => {
    expect(await send(WRITING_ADAPTERS.deepseek, reply(200, chat("")))).toMatchObject({ outcome: "rejected", errorCode: "invalid_output" });
  });

  it("openai: completed message text is answered with usage", async () => {
    const result = await send(WRITING_ADAPTERS.openai, reply(200, responses("{\"a\":1}"), { "x-request-id": "req_abc" }));
    expect(result).toMatchObject({ outcome: "answered", content: "{\"a\":1}", providerRequestId: "req_abc",
      usage: { status: "present", inputTokens: 11, outputTokens: 22, totalTokens: 33 } });
  });

  it("openai: refusal, incomplete and tool calls are rejected", async () => {
    const refusal = { ...responses(""), output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] };
    expect(await send(WRITING_ADAPTERS.openai, reply(200, refusal))).toMatchObject({ outcome: "rejected", errorCode: "refusal" });
    const incomplete = { ...responses("{"), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
    expect(await send(WRITING_ADAPTERS.openai, reply(200, incomplete))).toMatchObject({ outcome: "rejected", errorCode: "truncated" });
    const tool = { ...responses("{}"), output: [{ type: "function_call", name: "x" }] };
    expect(await send(WRITING_ADAPTERS.openai, reply(200, tool))).toMatchObject({ outcome: "rejected", errorCode: "invalid_output" });
  });

  it("a body that is not JSON is rejected", async () => {
    for (const adapter of Object.values(WRITING_ADAPTERS)) {
      expect(await send(adapter, reply(200, "not json"))).toMatchObject({ outcome: "rejected", errorCode: "invalid_output", content: null });
    }
  });
});

describe("error classification", () => {
  it.each([
    [401, "auth", "rejected"], [403, "auth", "rejected"], [429, "rate_limited", "rejected"], [400, "bad_request", "rejected"],
    [422, "bad_request", "rejected"], [500, "server_error", "unknown"], [503, "server_error", "unknown"], [302, "redirect_rejected", "unknown"],
  ] as const)("HTTP %s → %s (%s)", async (status, code, outcome) => {
    for (const adapter of Object.values(WRITING_ADAPTERS)) {
      expect(await send(adapter, reply(status, { error: { message: `bad ${KEY}` } }))).toMatchObject({ outcome, errorCode: code, content: null });
    }
  });

  it("vendor balance signals map to quota", async () => {
    expect(await send(WRITING_ADAPTERS.deepseek, reply(402, {}))).toMatchObject({ outcome: "rejected", errorCode: "quota" });
    expect(await send(WRITING_ADAPTERS.openai, reply(429, { error: { code: "insufficient_quota" } }))).toMatchObject({ outcome: "rejected", errorCode: "quota" });
    expect(await send(WRITING_ADAPTERS.openai, reply(429, { error: { code: "rate_limit_exceeded" } }))).toMatchObject({ errorCode: "rate_limited" });
  });

  it("timeouts and disconnects are unknown and are not retried", async () => {
    let calls = 0;
    const hang: WritingTransport = (request) => { calls += 1; return new Promise((_, reject) => {
      request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }); };
    const timeout = await sendWriting({ adapter: WRITING_ADAPTERS.qwen, url: "https://x.invalid", apiKey: KEY, request: REQUEST, transport: hang, timeoutMs: 5 });
    expect(timeout).toMatchObject({ outcome: "unknown", errorCode: "timeout" });
    const broken: WritingTransport = async () => { calls += 1; throw new TypeError("fetch failed"); };
    expect(await send(WRITING_ADAPTERS.openai, broken)).toMatchObject({ outcome: "unknown", errorCode: "disconnected" });
    expect(calls).toBe(2);
  });

  it("a request id that contains the key is dropped", async () => {
    const result = await send(WRITING_ADAPTERS.qwen, reply(200, { ...chat("{}"), id: KEY }));
    expect(result.providerRequestId).toBeNull();
  });
});

describe("server configuration", () => {
  it("reports only the names of missing variables and never guesses models", () => {
    const configs = titleWritingProviderConfigs({});
    expect(configs.qwen).toEqual({ providerKey: "qwen", ok: false, models: [], missing: ["DASHSCOPE_API_KEY", "BAILIAN_BASE_URL", "TITLE_WRITING_QWEN_MODELS"] });
    expect(configs.openai).toMatchObject({ ok: false, missing: ["OPENAI_API_KEY", "TITLE_WRITING_OPENAI_MODELS"] });
    expect(configs.deepseek).toMatchObject({ ok: false, missing: ["DEEPSEEK_API_KEY", "TITLE_WRITING_DEEPSEEK_MODELS"] });
  });

  it("uses controlled endpoints and the configured allowlist", () => {
    const configs = titleWritingProviderConfigs({
      DASHSCOPE_API_KEY: KEY, BAILIAN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1", TITLE_WRITING_QWEN_MODELS: "q-1, q-2,q-1",
      OPENAI_API_KEY: KEY, TITLE_WRITING_OPENAI_MODELS: "o-1",
      DEEPSEEK_API_KEY: KEY, TITLE_WRITING_DEEPSEEK_MODELS: "d-1",
    });
    expect(configs.qwen).toMatchObject({ ok: true, url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", models: ["q-1", "q-2"] });
    expect(configs.openai).toMatchObject({ ok: true, url: OPENAI_RESPONSES_URL, models: ["o-1"] });
    expect(configs.deepseek).toMatchObject({ ok: true, url: DEEPSEEK_CHAT_URL, models: ["d-1"] });
  });

  it("rejects an unofficial Qwen host and malformed model lists", () => {
    const configs = titleWritingProviderConfigs({
      DASHSCOPE_API_KEY: KEY, BAILIAN_BASE_URL: "https://evil.example.com/compatible-mode/v1", TITLE_WRITING_QWEN_MODELS: "q-1",
      OPENAI_API_KEY: KEY, TITLE_WRITING_OPENAI_MODELS: "bad model",
    });
    expect(configs.qwen).toMatchObject({ ok: false, missing: ["BAILIAN_BASE_URL"] });
    expect(configs.openai).toMatchObject({ ok: false, missing: ["TITLE_WRITING_OPENAI_MODELS"] });
  });
});
