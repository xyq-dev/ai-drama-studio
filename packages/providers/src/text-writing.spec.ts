import { describe, expect, it } from "vitest";
import { TITLE_WRITING_JSON_SCHEMAS, scriptBreakdownJsonSchema } from "@ai-drama/contracts";
import { createFetchTransport } from "./http-transport";
import {
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_THINKING_HEADROOM_TOKENS,
  DEEPSEEK_CHAT_COMPLETIONS_URL,
  OPENAI_RESPONSES_URL,
  TEXT_WRITING_MAX_RESPONSE_BYTES,
  WRITING_ADAPTERS,
  claudeJsonSchema,
  deepseekSystemMessage,
  providerConfigFor,
  sendWriting,
  titleWritingProviderConfigs,
  type WritingAdapter,
  type WritingRequest,
  type WritingTransport,
} from "./text-writing";

const KEY = "sk-ant-api03-test-secret-0123456789";
const REQUEST: WritingRequest = {
  model: "model-a",
  system: "系统 json",
  user: "用户",
  schemaName: TITLE_WRITING_JSON_SCHEMAS.concept.name,
  jsonSchema: TITLE_WRITING_JSON_SCHEMAS.concept.schema,
  maxOutputTokens: 4096,
};
const openai = WRITING_ADAPTERS.openai;
const claude = WRITING_ADAPTERS.anthropic;
const deepseek = WRITING_ADAPTERS.deepseek;
/** A clearly fake DeepSeek key: DeepSeek documents no prefix. Never a real key. */
const DEEPSEEK_KEY = "fake-deepseek-test-key-0123456789";

function reply(status: number, body: unknown, headers: Record<string, string> = {}): WritingTransport {
  return async () => ({
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: body === null ? null : new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
  });
}

function responses(text: string, extra: Record<string, unknown> = {}) {
  return { id: "resp_1", model: "model-a", status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 }, ...extra };
}

function message(content: unknown[], extra: Record<string, unknown> = {}) {
  return { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason: "end_turn",
    stop_sequence: null, usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 40,
      output_tokens_details: { thinking_tokens: 25 } }, ...extra };
}

const thinking = { type: "thinking", thinking: "", signature: "sig" };

async function send(adapter: WritingAdapter, transport: WritingTransport, extra: { timeoutMs?: number } = {}) {
  return sendWriting({ adapter, url: adapter.url, apiKey: KEY, request: REQUEST, transport, ...extra });
}

describe("request mapping stays inside each adapter", () => {
  it("openai: Responses API with a strict json_schema format, max_output_tokens and store false", () => {
    const body = JSON.parse(openai.buildBody(REQUEST)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "model-a", instructions: "系统 json", input: "用户", store: false, max_output_tokens: 4096,
      text: { format: { type: "json_schema", name: "title_concept", strict: true } } });
    expect((body.text as { format: { schema: unknown } }).format.schema).toEqual(TITLE_WRITING_JSON_SCHEMAS.concept.schema);
    expect(body).not.toHaveProperty("messages");
    expect(openai.url).toBe("https://api.openai.com/v1/responses");
  });

  it("claude: Messages API with system, one user message, adaptive thinking kept out of the answer and a json_schema format", () => {
    const body = JSON.parse(claude.buildBody(REQUEST)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "output_config", "system", "thinking"]);
    expect(body).toMatchObject({
      model: "model-a",
      system: "系统 json",
      messages: [{ role: "user", content: "用户" }],
      // Thinking counts toward max_tokens: the shared answer budget plus room to think.
      max_tokens: 4096 + ANTHROPIC_THINKING_HEADROOM_TOKENS,
      thinking: { type: "adaptive", display: "omitted" },
      output_config: { effort: "low", format: { type: "json_schema" } },
    });
    // Not the OpenAI body: no instructions/input/text/store, no prefill, no tools, no sampling knobs.
    for (const field of ["instructions", "input", "text", "store", "tools", "tool_choice", "temperature", "top_p", "top_k", "stream"]) {
      expect(body).not.toHaveProperty(field);
    }
    expect(claude.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("claude: the schema keeps shape, required fields, enums and additionalProperties but drops bounds Claude rejects", () => {
    const body = JSON.parse(claude.buildBody({ ...REQUEST, jsonSchema: scriptBreakdownJsonSchema(2).schema })) as {
      output_config: { format: { schema: Record<string, unknown> } };
    };
    const schema = body.output_config.format.schema;
    const text = JSON.stringify(schema);
    for (const keyword of ["maxLength", "minLength", "maximum", "minimum", "maxItems"]) expect(text).not.toContain(`"${keyword}"`);
    // minItems survives only as 0 or 1.
    for (const match of text.matchAll(/"minItems":(\d+)/g)) expect(["0", "1"]).toContain(match[1]);
    expect(schema).toMatchObject({ type: "object", additionalProperties: false, required: ["schema", "episodeNo", "scenes", "shots"] });
    expect((schema.properties as Record<string, unknown>).episodeNo).toEqual({ type: "integer", enum: [2] });
    // The shared schema object itself is never changed (OpenAI still gets every bound).
    expect(JSON.stringify(scriptBreakdownJsonSchema(2).schema)).toContain("\"maxLength\"");
    expect(claudeJsonSchema({ type: "array", minItems: 3, items: { type: "string", maxLength: 5 } }))
      .toEqual({ type: "array", minItems: 1, items: { type: "string" } });
  });

  it("each provider authenticates its own way; the key is never in the body or URL", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    for (const adapter of [openai, claude]) {
      await send(adapter, async (request) => { seen.push(request); return { status: 401, headers: { get: () => null }, body: null }; });
    }
    expect(seen).toHaveLength(2);
    expect(seen[0]!.url).toBe(OPENAI_RESPONSES_URL);
    expect(seen[0]!.headers).toEqual({ Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" });
    expect(seen[1]!.url).toBe(ANTHROPIC_MESSAGES_URL);
    expect(seen[1]!.headers).toEqual({ "x-api-key": KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" });
    expect(seen[1]!.headers).not.toHaveProperty("Authorization");
    expect(seen[1]!.headers).not.toHaveProperty("anthropic-workspace-id");
    for (const request of seen) {
      expect(request.body).not.toContain(KEY);
      expect(request.url).not.toContain(KEY);
    }
  });

  it("every Console key kind goes as x-api-key, the workspace header only when configured, no OAuth or Claude Code identity", async () => {
    const keys = ["sk-ant-api03-fake-legacy-key-for-tests-only", "sk-ant-usr-fake-personal-key-for-tests-only", "sk-ant-svc-fake-service-key-for-tests-only"];
    const seen: Array<Record<string, string>> = [];
    const capture: WritingTransport = async (request) => { seen.push(request.headers); return { status: 401, headers: { get: () => null }, body: null }; };
    for (const apiKey of keys) {
      await sendWriting({ adapter: claude, url: claude.url, apiKey, request: REQUEST, transport: capture });
      await sendWriting({ adapter: claude, url: claude.url, apiKey, workspaceId: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ", request: REQUEST, transport: capture });
    }
    // OpenAI never sends a workspace header, even if one is passed.
    await sendWriting({ adapter: openai, url: openai.url, apiKey: KEY, workspaceId: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ", request: REQUEST, transport: capture });
    expect(seen).toHaveLength(7);
    keys.forEach((apiKey, index) => {
      expect(seen[index * 2]).toEqual({ "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" });
      expect(seen[index * 2 + 1]).toEqual({ "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json",
        "anthropic-workspace-id": "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ" });
    });
    expect(seen[6]).toEqual({ Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" });
    for (const headers of seen.slice(0, 6)) {
      const names = Object.keys(headers).map((name) => name.toLowerCase());
      expect(names).not.toContain("authorization");
      expect(names).not.toContain("anthropic-beta");
      expect(names).not.toContain("x-app");
      expect(names).not.toContain("user-agent");
    }
  });

  it("a configured URL other than the adapter's own endpoint is refused before anything is sent", async () => {
    let sends = 0;
    for (const adapter of [openai, claude]) {
      const result = await sendWriting({ adapter, url: "https://proxy.example.com/v1/messages", apiKey: KEY, request: REQUEST,
        transport: async () => { sends += 1; return { status: 200, headers: { get: () => null }, body: null }; } });
      expect(result).toMatchObject({ outcome: "rejected", errorCode: "provider_error" });
    }
    expect(sends).toBe(0);
  });
});

describe("openai output parsing", () => {
  it("completed message text is answered with usage", async () => {
    const result = await send(openai, reply(200, responses("{\"a\":1}"), { "x-request-id": "req_abc" }));
    expect(result).toMatchObject({ outcome: "answered", content: "{\"a\":1}", responseModel: "model-a", providerRequestId: "req_abc",
      usage: { status: "present", inputTokens: 11, outputTokens: 22, totalTokens: 33 } });
  });

  it("refusal, incomplete and tool calls are rejected", async () => {
    const refusal = { ...responses(""), output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] };
    expect((await send(openai, reply(200, refusal))).errorCode).toBe("refusal");
    expect((await send(openai, reply(200, { ...responses("x"), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }))).errorCode).toBe("truncated");
    expect((await send(openai, reply(200, { ...responses("x"), status: "incomplete", incomplete_details: { reason: "content_filter" } }))).errorCode).toBe("refusal");
    const tool = { ...responses("x"), output: [...responses("x").output, { type: "function_call", name: "f", arguments: "{}" }] };
    expect((await send(openai, reply(200, tool))).errorCode).toBe("invalid_output");
  });

  it("missing usage stays unknown, never zero", async () => {
    const result = await send(openai, reply(200, { ...responses("{}"), usage: undefined }));
    expect(result.usage).toEqual({ status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null });
  });
});

describe("claude output parsing", () => {
  it("one text block after thinking is the answer; usage adds cache input once and does not add thinking again", async () => {
    const result = await send(claude, reply(200, message([thinking, { type: "text", text: "{\"a\":1}" }]), { "request-id": "req_011CS" }));
    expect(result).toMatchObject({ outcome: "answered", errorCode: null, content: "{\"a\":1}", responseModel: "claude-opus-5-5",
      providerRequestId: "req_011CS" });
    // input 100 + cache creation 10 + cache read 5; output_tokens 40 already includes the 25 thinking tokens.
    expect(result.usage).toEqual({ status: "present", inputTokens: 115, outputTokens: 40, totalTokens: 155 });
  });

  it("thinking text is never content, even when it is the only block or looks like JSON", async () => {
    const onlyThinking = message([{ type: "thinking", thinking: "{\"schema\":\"looks like the answer\"}", signature: "s" }]);
    expect(await send(claude, reply(200, onlyThinking))).toMatchObject({ outcome: "rejected", errorCode: "invalid_output", content: null });
    const redacted = message([{ type: "redacted_thinking", data: "opaque" }]);
    expect((await send(claude, reply(200, redacted))).errorCode).toBe("invalid_output");
  });

  it("refusal, max_tokens, context window, pause and tool use are not answers", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: null } }, "refusal"],
      [{ stop_reason: "max_tokens" }, "truncated"],
      [{ stop_reason: "model_context_window_exceeded" }, "truncated"],
      [{ stop_reason: "pause_turn" }, "truncated"],
      [{ stop_reason: "tool_use" }, "invalid_output"],
      [{ stop_reason: "stop_sequence" }, "invalid_output"],
      [{ stop_reason: null }, "invalid_output"],
    ];
    for (const [extra, code] of cases) {
      // Each body still carries complete-looking JSON: it must not be taken as a finished answer.
      const result = await send(claude, reply(200, message([thinking, { type: "text", text: "{\"schema\":\"x\"}" }], extra)));
      expect([result.outcome, result.errorCode, result.content]).toEqual(["rejected", code, null]);
      expect(result.usage.status).toBe("present");
    }
  });

  it("a tool call, a second text block, citations or an empty text are rejected", async () => {
    const bodies = [
      message([thinking, { type: "tool_use", id: "toolu_1", name: "x", input: {} }, { type: "text", text: "{}" }]),
      message([{ type: "text", text: "{}" }, { type: "text", text: "{}" }]),
      message([{ type: "text", text: "{}", citations: [{ type: "char_location", cited_text: "x" }] }]),
      message([{ type: "text", text: "   " }]),
      message([]),
      { ...message([{ type: "text", text: "{}" }]), type: "error" },
      { ...message([{ type: "text", text: "{}" }]), role: "user" },
      { ...message([{ type: "text", text: "{}" }]), content: "not blocks" },
    ];
    for (const body of bodies) {
      expect(await send(claude, reply(200, body))).toMatchObject({ outcome: "rejected", errorCode: "invalid_output", content: null });
    }
  });

  it("missing or malformed usage stays unknown, never zero", async () => {
    const answer = [{ type: "text", text: "{}" }];
    for (const usage of [undefined, null, {}, { input_tokens: 5 }, { output_tokens: 5 }, { input_tokens: -1, output_tokens: 2 },
      { input_tokens: 1.5, output_tokens: 2 }, { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: "3" }]) {
      const result = await send(claude, reply(200, { ...message(answer), usage }));
      expect(result.outcome).toBe("answered");
      expect(result.usage).toEqual({ status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null });
    }
    // Null or absent cache counts mean no caching.
    const plain = await send(claude, reply(200, { ...message(answer), usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: null } }));
    expect(plain.usage).toEqual({ status: "present", inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  });

  it("a body that is not JSON or not strict UTF-8 is rejected", async () => {
    expect((await send(claude, reply(200, "<html>"))).errorCode).toBe("invalid_output");
    const bad: WritingTransport = async () => ({ status: 200, headers: { get: () => null }, body: new Uint8Array([0xff, 0xfe, 0x7b]) });
    expect(await send(claude, bad)).toMatchObject({ outcome: "rejected", errorCode: "invalid_output" });
  });
});

describe("error classification", () => {
  it.each([
    [401, "auth", "rejected"], [429, "rate_limited", "rejected"], [400, "bad_request", "rejected"],
    [404, "bad_request", "rejected"], [413, "bad_request", "rejected"], [422, "bad_request", "rejected"],
    [500, "server_error", "unknown"], [503, "server_error", "unknown"], [504, "server_error", "unknown"], [529, "server_error", "unknown"],
    [302, "redirect_rejected", "unknown"], [0, "redirect_rejected", "unknown"],
  ] as const)("HTTP %s → %s (%s) for both providers", async (status, code, outcome) => {
    for (const adapter of [openai, claude]) {
      expect(await send(adapter, reply(status, null))).toMatchObject({ outcome, errorCode: code, content: null });
    }
  });

  it("HTTP 403 stays auth for OpenAI and is a permission refusal for Claude", async () => {
    expect(await send(openai, reply(403, null))).toMatchObject({ outcome: "rejected", errorCode: "auth" });
    expect(await send(claude, reply(403, { type: "error", error: { type: "permission_error", message: "x" } })))
      .toMatchObject({ outcome: "rejected", errorCode: "permission" });
  });

  it("Claude workspace answers are named as such, never as a key format, balance or generic request problem", async () => {
    const required = { type: "error", error: { type: "invalid_request_error",
      message: "anthropic-workspace-id is required when authenticating with an identity-linked API key; send the id of the workspace this request acts in." },
      request_id: "req_011CSHoEeqs5C35K2UUqR7Fy" };
    expect(await send(claude, reply(400, required))).toMatchObject({ outcome: "rejected", errorCode: "workspace_required", providerRequestId: "req_011CSHoEeqs5C35K2UUqR7Fy" });
    expect(await send(claude, reply(400, { type: "error", error: { type: "invalid_request_error", message: "anthropic-workspace-id header must be a valid workspace ID." } })))
      .toMatchObject({ outcome: "rejected", errorCode: "workspace_invalid" });
    expect(await send(claude, reply(404, { type: "error", error: { type: "not_found_error", message: "Workspace `wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ` not found." } })))
      .toMatchObject({ outcome: "rejected", errorCode: "workspace_invalid" });
    // An unknown model is still a bad request, and other 400s are not turned into workspace problems.
    expect((await send(claude, reply(404, { type: "error", error: { type: "not_found_error", message: "model: claude-x" } }))).errorCode).toBe("bad_request");
    expect((await send(claude, reply(400, { type: "error", error: { type: "invalid_request_error", message: "max_tokens: too large" } }))).errorCode).toBe("bad_request");
    // OpenAI keeps its own classification of the same bodies.
    expect((await send(openai, reply(400, required))).errorCode).toBe("bad_request");
  });

  it("a Claude 400 saying the credit balance is too low is a balance problem", async () => {
    expect(await send(claude, reply(400, { type: "error", error: { type: "invalid_request_error",
      message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } })))
      .toMatchObject({ outcome: "rejected", errorCode: "quota" });
  });

  it("balance signals map to quota: OpenAI insufficient_quota, Claude 402 billing_error", async () => {
    expect((await send(openai, reply(429, { error: { code: "insufficient_quota" } }))).errorCode).toBe("quota");
    expect(await send(claude, reply(402, { type: "error", error: { type: "billing_error", message: "x" }, request_id: "req_bill" })))
      .toMatchObject({ outcome: "rejected", errorCode: "quota", providerRequestId: "req_bill" });
    // A Claude spend-cap 429 is still a rate limit, not a guessed balance problem.
    expect((await send(claude, reply(429, { type: "error", error: { type: "rate_limit_error", message: "x" } }))).errorCode).toBe("rate_limited");
  });

  it("an error body never comes back, and a key echoed in it is not kept", async () => {
    const result = await send(claude, reply(401, { type: "error", error: { type: "authentication_error", message: `bad key ${KEY}` }, request_id: KEY }));
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(result.providerRequestId).toBeNull();
  });

  it("timeouts and disconnects are unknown and are not retried", async () => {
    for (const adapter of [openai, claude, deepseek]) {
      let calls = 0;
      const hang: WritingTransport = (request) => { calls += 1; return new Promise((_, reject) => {
        request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }); };
      expect(await send(adapter, hang, { timeoutMs: 10 })).toMatchObject({ outcome: "unknown", errorCode: "timeout" });
      expect(calls).toBe(1);
      let failures = 0;
      const broken: WritingTransport = async () => { failures += 1; throw new TypeError("fetch failed"); };
      expect(await send(adapter, broken)).toMatchObject({ outcome: "unknown", errorCode: "disconnected" });
      expect(failures).toBe(1);
    }
  });

  it("an oversized body is stopped and its outcome stays unknown", async () => {
    const huge: WritingTransport = async () => ({ status: 200, headers: { get: () => null }, body: new Uint8Array(TEXT_WRITING_MAX_RESPONSE_BYTES + 1) });
    for (const adapter of [openai, claude, deepseek]) expect(await send(adapter, huge)).toMatchObject({ outcome: "unknown", errorCode: "response_too_large" });
  });

  it("a request id that contains the key is dropped", async () => {
    expect((await send(claude, reply(200, message([{ type: "text", text: "{}" }], { id: `msg_${KEY}` }), { "request-id": KEY }))).providerRequestId).toBeNull();
  });
});

describe("fetch transport", () => {
  it("never follows a redirect and sends exactly once", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response(null, { status: 307, headers: { location: "https://elsewhere.example.com" } });
    }) as unknown as typeof fetch;
    const result = await send(claude, createFetchTransport(fetchImpl));
    expect(result).toMatchObject({ outcome: "unknown", errorCode: "redirect_rejected" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.redirect).toBe("manual");
  });

  it("stops reading a streamed body at the size limit", async () => {
    const fetchImpl = (async () => new Response(new Uint8Array(64), { status: 200 })) as unknown as typeof fetch;
    const result = await sendWriting({ adapter: claude, url: claude.url, apiKey: KEY, request: REQUEST, transport: createFetchTransport(fetchImpl, 16) });
    expect(result).toMatchObject({ outcome: "unknown", errorCode: "response_too_large" });
  });
});

describe("server configuration", () => {
  it("only DeepSeek, Claude and OpenAI exist; names of missing variables are reported; Claude and DeepSeek have a documented default model", () => {
    const configs = titleWritingProviderConfigs({});
    expect(Object.keys(configs).sort()).toEqual(["anthropic", "deepseek", "openai"]);
    expect(configs.openai).toEqual({ providerKey: "openai", ok: false, models: [], missing: ["OPENAI_API_KEY", "TITLE_WRITING_OPENAI_MODELS"] });
    // Claude without a model list uses TITLE_WRITING_DEFAULT_MODELS; the key is still missing, so it is not ready.
    expect(configs.anthropic).toEqual({ providerKey: "anthropic", ok: false, models: ["claude-opus-5-5"], missing: ["ANTHROPIC_API_KEY"] });
    expect(configs.deepseek).toEqual({ providerKey: "deepseek", ok: false, models: ["deepseek-flash"], missing: ["DEEPSEEK_API_KEY"] });
    expect(Object.keys(WRITING_ADAPTERS).sort()).toEqual(["anthropic", "deepseek", "openai"]);
  });

  it("a DeepSeek key alone is a complete setup with deepseek-flash; the key is checked without any prefix rule", () => {
    expect(titleWritingProviderConfigs({ DEEPSEEK_API_KEY: DEEPSEEK_KEY }).deepseek)
      .toEqual({ providerKey: "deepseek", ok: true, url: DEEPSEEK_CHAT_COMPLETIONS_URL, apiKey: DEEPSEEK_KEY, models: ["deepseek-flash"], missing: [], workspaceId: null });
    for (const bad of ["short-key", "fake key with spaces 0123", "fake-deepseek-key-\u5bc6\u94a5-0123", `${"x".repeat(257)}`]) {
      expect(titleWritingProviderConfigs({ DEEPSEEK_API_KEY: bad }).deepseek).toMatchObject({ ok: false, missing: ["DEEPSEEK_API_KEY"] });
    }
    expect(titleWritingProviderConfigs({ DEEPSEEK_API_KEY: DEEPSEEK_KEY, TITLE_WRITING_DEEPSEEK_MODELS: "bad model" }).deepseek)
      .toMatchObject({ ok: false, missing: ["TITLE_WRITING_DEEPSEEK_MODELS"] });
  });

  it("a Claude key alone is a complete setup with the default model; an explicit list still wins", () => {
    expect(titleWritingProviderConfigs({ ANTHROPIC_API_KEY: KEY }).anthropic)
      .toMatchObject({ ok: true, url: ANTHROPIC_MESSAGES_URL, models: ["claude-opus-5-5"] });
    expect(titleWritingProviderConfigs({ ANTHROPIC_API_KEY: KEY, TITLE_WRITING_ANTHROPIC_MODELS: "  " }).anthropic)
      .toMatchObject({ ok: true, models: ["claude-opus-5-5"] });
    expect(titleWritingProviderConfigs({ ANTHROPIC_API_KEY: KEY, TITLE_WRITING_ANTHROPIC_MODELS: "claude-sonnet-5-5" }).anthropic)
      .toMatchObject({ ok: true, models: ["claude-sonnet-5-5"] });
    // OpenAI keeps needing its own list: a key alone is not ready and no model is guessed.
    expect(titleWritingProviderConfigs({ OPENAI_API_KEY: KEY }).openai).toEqual({ providerKey: "openai", ok: false, models: [], missing: ["TITLE_WRITING_OPENAI_MODELS"] });
  });

  it("reads the Claude key with the console's rule: Console keys of every kind, nothing else", () => {
    for (const credential of ["sk-ant-oat01-abcdefghijklmnopqrstuvwxyz", "sk-ant-ort01-abcdefghijklmnopqrstuvwxyz", "sk-ant-admin01-abcdefghijklmnopqrstuvwxyz",
      "sk-ant-sid01-abcdefghijklmnop", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl", "sk-ant-xyz-abcdefghijklmnop", "sk-proj-abcdefghijklmnop",
      "stub-not-a-provider-key-0123456789", `sk-ant-api03-${"a".repeat(260)}`]) {
      expect(titleWritingProviderConfigs({ ANTHROPIC_API_KEY: credential }).anthropic).toMatchObject({ ok: false, missing: ["ANTHROPIC_API_KEY"] });
    }
    for (const apiKey of ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "sk-ant-usr-fake-personal-key-for-tests-only", "sk-ant-svc-fake-service-key-for-tests-only"]) {
      expect(titleWritingProviderConfigs({ ANTHROPIC_API_KEY: apiKey }).anthropic).toMatchObject({ ok: true, apiKey, workspaceId: null });
    }
  });

  it("an optional workspace id is passed through as configured; a malformed one makes Claude not ready instead of being dropped", () => {
    expect(titleWritingProviderConfigs({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_WORKSPACE_ID: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ" }).anthropic)
      .toMatchObject({ ok: true, workspaceId: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ" });
    expect(titleWritingProviderConfigs({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_WORKSPACE_ID: "" }).anthropic).toMatchObject({ ok: true, workspaceId: null });
    for (const workspace of ["default", "wrkspc_x\r\nX-Evil: 1", "wrkspc_ab", KEY]) {
      expect(titleWritingProviderConfigs({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_WORKSPACE_ID: workspace }).anthropic)
        .toMatchObject({ ok: false, missing: ["ANTHROPIC_WORKSPACE_ID"] });
    }
    // OpenAI has no workspace and is unaffected.
    expect(titleWritingProviderConfigs({ OPENAI_API_KEY: KEY, TITLE_WRITING_OPENAI_MODELS: "o-1", ANTHROPIC_WORKSPACE_ID: "bad" }).openai).toMatchObject({ ok: true });
  });

  it("uses the fixed endpoints and the configured allowlist", () => {
    const configs = titleWritingProviderConfigs({
      OPENAI_API_KEY: KEY, TITLE_WRITING_OPENAI_MODELS: "o-1",
      ANTHROPIC_API_KEY: KEY, TITLE_WRITING_ANTHROPIC_MODELS: "claude-opus-5-5, claude-sonnet-5-5,claude-opus-5-5",
    });
    expect(configs.openai).toMatchObject({ ok: true, url: OPENAI_RESPONSES_URL, models: ["o-1"] });
    expect(configs.anthropic).toMatchObject({ ok: true, url: ANTHROPIC_MESSAGES_URL, models: ["claude-opus-5-5", "claude-sonnet-5-5"] });
  });

  it("the retired provider's variables are ignored, and a malformed allowlist or key is not ready", () => {
    const configs = titleWritingProviderConfigs({
      DASHSCOPE_API_KEY: KEY, BAILIAN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1", TITLE_WRITING_QWEN_MODELS: "q-1",
      ANTHROPIC_API_KEY: "has space key", TITLE_WRITING_ANTHROPIC_MODELS: "bad model",
    } as Parameters<typeof titleWritingProviderConfigs>[0]);
    expect(Object.keys(configs).sort()).toEqual(["anthropic", "deepseek", "openai"]);
    expect(configs.anthropic).toMatchObject({ ok: false, missing: ["ANTHROPIC_API_KEY", "TITLE_WRITING_ANTHROPIC_MODELS"] });
    expect(configs.deepseek).toMatchObject({ ok: false, missing: ["DEEPSEEK_API_KEY"] });
  });

  it("a stored run of a retired provider gets no configuration, so nothing can be sent for it", () => {
    const configs = titleWritingProviderConfigs({ OPENAI_API_KEY: KEY, TITLE_WRITING_OPENAI_MODELS: "o-1" });
    expect(providerConfigFor(configs, "qwen")).toBeNull();
    expect(providerConfigFor(configs, "__proto__")).toBeNull();
    // DeepSeek is active again: its entry exists (not ready without a key); a legacy run is stopped by the engine.
    expect(providerConfigFor(configs, "deepseek")).toMatchObject({ providerKey: "deepseek", ok: false });
    expect(providerConfigFor(configs, "openai")).toMatchObject({ ok: true });
    // Even a configuration object that still carries an old entry is not used for it.
    expect(providerConfigFor({ ...configs, qwen: configs.openai }, "qwen")).toBeNull();
  });
});

describe("DeepSeek adapter (official Chat Completions, checked 2026-10-17)", () => {
  const chat = (content: unknown, extra: Record<string, unknown> = {}, finish: unknown = "stop", message: Record<string, unknown> = {}) => ({
    id: "ds-req-1", object: "chat.completion", model: "deepseek-flash",
    choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content, ...message } }],
    usage: { prompt_tokens: 120, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 100, completion_tokens: 80, total_tokens: 200,
      completion_tokens_details: { reasoning_tokens: 0 } },
    ...extra,
  });
  const dsSend = (transport: WritingTransport, extra: { timeoutMs?: number } = {}) =>
    sendWriting({ adapter: deepseek, url: deepseek.url, apiKey: DEEPSEEK_KEY, request: REQUEST, transport, ...extra });

  it("sends one POST to the fixed endpoint with a Bearer key, thinking disabled, JSON output and the shared output budget", async () => {
    const seen: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
    const result = await dsSend(async (request) => { seen.push(request); return { status: 200, headers: { get: () => null }, body: new TextEncoder().encode(JSON.stringify(chat("{\"ok\":true}"))) }; });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.deepseek.com/chat/completions");
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers).toEqual({ Authorization: `Bearer ${DEEPSEEK_KEY}`, "Content-Type": "application/json" });
    const body = JSON.parse(seen[0]!.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "response_format", "stream", "thinking"]);
    expect(body).toMatchObject({ model: "model-a", thinking: { type: "disabled" }, response_format: { type: "json_object" }, max_tokens: 4096, stream: false });
    // No OpenAI Responses or Claude parameter, and the key never travels in the body.
    for (const foreign of ["instructions", "input", "text", "store", "max_output_tokens", "output_config", "system", "tools", "reasoning_effort", "temperature"]) {
      expect(body).not.toHaveProperty(foreign);
    }
    expect(seen[0]!.body).not.toContain(DEEPSEEK_KEY);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages.map((item) => item.role)).toEqual(["system", "user"]);
    // The frozen system prompt is kept as is; the schema and the word json the mode needs follow it.
    expect(messages[0]!.content.startsWith(REQUEST.system)).toBe(true);
    expect(messages[0]!.content).toBe(deepseekSystemMessage(REQUEST.system, REQUEST.schemaName, REQUEST.jsonSchema));
    expect(messages[0]!.content).toContain("json");
    expect(messages[0]!.content).toContain(JSON.stringify(REQUEST.jsonSchema));
    expect(messages[1]!.content).toBe(REQUEST.user);
    expect(result).toEqual({ outcome: "answered", errorCode: null, content: "{\"ok\":true}", responseModel: "deepseek-flash", providerRequestId: "ds-req-1",
      usage: { status: "present", inputTokens: 120, outputTokens: 80, totalTokens: 200 } });
  });

  it("uses only the final content: reasoning_content is never returned, stored or joined to it", async () => {
    const result = await dsSend(reply(200, chat("{\"a\":1}", {}, "stop", { reasoning_content: "secret chain of thought" })));
    expect(result).toMatchObject({ outcome: "answered", content: "{\"a\":1}" });
    expect(JSON.stringify(result)).not.toContain("secret chain of thought");
  });

  it("empty content, truncation, refusal, tool calls, stopped answers and malformed bodies are never an answer", async () => {
    const cases: Array<[unknown, string]> = [
      [chat(""), "invalid_output"],
      [chat("   "), "invalid_output"],
      [chat(null), "invalid_output"],
      [chat("{\"partial\":", {}, "length"), "truncated"],
      [chat("blocked", {}, "content_filter"), "refusal"],
      [chat("{}", {}, "stop", { refusal: "I can't help" }), "refusal"],
      [chat(null, {}, "tool_calls", { tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }] }), "invalid_output"],
      [chat("{}", {}, "stop", { tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }] }), "invalid_output"],
      [chat("{}", {}, "insufficient_system_resource"), "server_error"],
      [chat("{}", {}, "aborted"), "server_error"],
      [chat("{}", {}, "something_new"), "invalid_output"],
      [{ ...chat("{}"), choices: [] }, "invalid_output"],
      [{ ...chat("{}"), choices: [chat("{}").choices[0], chat("{}").choices[0]] }, "invalid_output"],
      ["not json at all", "invalid_output"],
    ];
    for (const [body, code] of cases) {
      const result = await dsSend(reply(200, body));
      expect(result).toMatchObject({ outcome: "rejected", errorCode: code, content: null });
    }
  });

  it("does not trust parsable JSON alone: the answer is still a string for the caller's schema checks", async () => {
    // JSON mode may wrap or return any JSON; the adapter hands over the text and the zod / domain checks decide.
    expect(await dsSend(reply(200, chat("[1,2,3]")))).toMatchObject({ outcome: "answered", content: "[1,2,3]" });
    expect(await dsSend(reply(200, chat("```json\n{}\n```")))).toMatchObject({ outcome: "answered", content: "```json\n{}\n```" });
  });

  it("usage: cache hits are part of prompt_tokens and reasoning is part of completion_tokens, never added twice; a contradiction is unknown", async () => {
    const usage = async (value: unknown) => (await dsSend(reply(200, chat("{}", { usage: value })))).usage;
    expect(await usage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6,
      completion_tokens_details: { reasoning_tokens: 3 } })).toEqual({ status: "present", inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(await usage({ prompt_tokens: 10, completion_tokens: 5 })).toEqual({ status: "present", inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    for (const bad of [undefined, null, {}, { prompt_tokens: 10 }, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 99 },
      { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 4 },
      { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 4 }, { prompt_tokens: -1, completion_tokens: 5 }, { prompt_tokens: 1.5, completion_tokens: 5 }]) {
      expect(await usage(bad)).toEqual({ status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null });
    }
  });

  it("errors: 401 auth, 402 balance, 400 / 422 invalid, 429 rate limit are refused; 500 / 503 and redirects stay unknown", async () => {
    const cases: Array<[number, string, string]> = [
      [401, "auth", "rejected"], [402, "quota", "rejected"], [400, "bad_request", "rejected"], [422, "bad_request", "rejected"],
      [429, "rate_limited", "rejected"], [500, "server_error", "unknown"], [503, "server_error", "unknown"], [302, "redirect_rejected", "unknown"],
      [403, "auth", "rejected"],
    ];
    for (const [status, code, outcome] of cases) {
      let calls = 0;
      const result = await dsSend(async () => { calls += 1; return { status, headers: { get: () => null },
        body: new TextEncoder().encode(JSON.stringify({ error: { message: `bad key ${DEEPSEEK_KEY}`, type: "authentication_error" } })) }; });
      expect(result).toMatchObject({ outcome, errorCode: code, content: null });
      expect(calls).toBe(1);
      expect(JSON.stringify(result)).not.toContain(DEEPSEEK_KEY);
    }
  });

  it("refuses any other URL before sending, and the fetch transport never follows a redirect", async () => {
    let calls = 0;
    const refused = await sendWriting({ adapter: deepseek, url: "https://api.deepseek.com/v1/chat/completions", apiKey: DEEPSEEK_KEY, request: REQUEST,
      transport: async () => { calls += 1; return { status: 200, headers: { get: () => null }, body: null }; } });
    expect(refused).toMatchObject({ outcome: "rejected", errorCode: "provider_error" });
    expect(calls).toBe(0);
    const inits: RequestInit[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      inits.push(init);
      return new Response(null, { status: 301, headers: { location: "https://elsewhere.example.com" } });
    }) as unknown as typeof fetch;
    expect(await dsSend(createFetchTransport(fetchImpl))).toMatchObject({ outcome: "unknown", errorCode: "redirect_rejected" });
    expect(inits).toHaveLength(1);
    expect(inits[0]!.redirect).toBe("manual");
  });

  it("a response id or body that contains the key is never returned", async () => {
    const result = await dsSend(reply(200, chat("{}", { id: `id-${DEEPSEEK_KEY}` })));
    expect(result.providerRequestId).toBeNull();
    expect(JSON.stringify(result)).not.toContain(DEEPSEEK_KEY);
  });
});
