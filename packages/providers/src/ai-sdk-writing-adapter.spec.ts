import { afterEach, describe, expect, it, vi } from "vitest";
import { BAILIAN_COMPATIBLE_BASE_URL, DEEPSEEK_AI_SDK_BASE_URL, QWEN_PLUS_MODEL } from "@ai-drama/contracts";
import { sendAiSdkWriting, sdkWritingChatUrl, type SdkWritingKind } from "./ai-sdk-writing-adapter";
import type { WritingRequest } from "./text-writing";

const SENTINEL = "sk-sentinel-writing-key-do-not-leak";

const request: WritingRequest = {
  model: QWEN_PLUS_MODEL,
  system: "return json",
  user: "只根据剧名完成故事策划",
  schemaName: "title_concept",
  jsonSchema: { type: "object", properties: { synopsis: { maxLength: 800 } } },
  maxOutputTokens: 200,
};

function chat(content: string, extra: { status?: number; finish?: string; id?: string; model?: string } = {}): Response {
  return new Response(JSON.stringify({
    id: extra.id ?? "chatcmpl-test-01",
    model: extra.model ?? request.model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: extra.finish ?? "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
  }), { status: extra.status ?? 200, headers: { "content-type": "application/json" } });
}

function install(handler: (url: string, init: RequestInit | undefined, calls: string[]) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    return handler(url, init, calls);
  };
  return { fetchImpl, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AI SDK writing adapters", () => {
  it("posts qwen-plus to the China compatible-mode host once and keeps the key off the exchange", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("global fetch"); });
    const { fetchImpl, calls } = install((url, init) => {
      expect(url).toBe(`${BAILIAN_COMPATIBLE_BASE_URL}/chat/completions`);
      expect(url).not.toContain("dashscope-intl");
      expect(url).not.toContain("gateway");
      expect(init?.headers && new Headers(init.headers).get("authorization")).toBe(`Bearer ${SENTINEL}`);
      expect(String(init?.body)).not.toContain(SENTINEL);
      expect(String(init?.body)).toContain(QWEN_PLUS_MODEL);
      expect(String(init?.body)).toContain(request.schemaName);
      expect(String(init?.body)).toContain("800");
      return chat(JSON.stringify({ ok: true }));
    });
    const exchange = await sendAiSdkWriting({ kind: "bailian", apiKey: SENTINEL, request, fetchImpl });
    expect(calls).toHaveLength(1);
    expect(exchange.outcome).toBe("answered");
    expect(exchange.content).toContain("ok");
    expect(exchange.usage).toEqual({ status: "present", inputTokens: 11, outputTokens: 22, totalTokens: 33 });
    expect(JSON.stringify(exchange)).not.toContain(SENTINEL);
  });

  it("posts DeepSeek to the official host with JSON Output and does not use the gateway", async () => {
    const deepseek: WritingRequest = { ...request, model: "deepseek-flash" };
    const { fetchImpl, calls } = install((url, init) => {
      expect(url).toBe(`${DEEPSEEK_AI_SDK_BASE_URL}/chat/completions`);
      expect(url).not.toContain("ai-gateway");
      expect(url).not.toContain("vercel");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${SENTINEL}`);
      const body = JSON.parse(String(init?.body)) as { model?: string; response_format?: { type?: string }; messages?: unknown };
      expect(body.model).toBe("deepseek-flash");
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(JSON.stringify(body.messages ?? body)).toContain("json");
      expect(JSON.stringify(body.messages ?? body)).toContain("EXAMPLE JSON OUTPUT");
      expect(String(init?.body)).not.toContain(SENTINEL);
      return chat("{}", { model: "deepseek-flash" });
    });
    const exchange = await sendAiSdkWriting({ kind: "deepseek", apiKey: SENTINEL, request: deepseek, fetchImpl });
    expect(calls).toEqual([sdkWritingChatUrl("deepseek")]);
    expect(exchange.outcome).toBe("answered");
    expect(JSON.stringify(exchange)).not.toContain(SENTINEL);
  });

  it("treats blank JSON Output content as invalid and does not send again", async () => {
    const deepseek: WritingRequest = { ...request, model: "deepseek-v4-pro" };
    const { fetchImpl, calls } = install(() => chat("   ", { model: "deepseek-v4-pro", finish: "stop" }));
    const exchange = await sendAiSdkWriting({ kind: "deepseek", apiKey: SENTINEL, request: deepseek, fetchImpl });
    expect(calls).toHaveLength(1);
    expect(exchange).toMatchObject({ outcome: "rejected", errorCode: "invalid_output", content: null });
  });

  it("classifies insufficient balance and rate limits without retrying or leaking the key", async () => {
    const deepseek: WritingRequest = { ...request, model: "deepseek-flash" };
    for (const [status, errorCode] of [[402, "quota"], [429, "rate_limited"]] as const) {
      const { fetchImpl, calls } = install(() => new Response(JSON.stringify({ error: { message: SENTINEL } }), { status }));
      const exchange = await sendAiSdkWriting({ kind: "deepseek", apiKey: SENTINEL, request: deepseek, fetchImpl });
      expect(calls).toHaveLength(1);
      expect(exchange).toMatchObject({ outcome: "rejected", errorCode, content: null });
      expect(JSON.stringify(exchange)).not.toContain(SENTINEL);
    }
  });

  it("does not retry a provider error and classifies auth without copying the body", async () => {
    const { fetchImpl, calls } = install(() => new Response(JSON.stringify({ error: { message: SENTINEL } }), { status: 401 }));
    const exchange = await sendAiSdkWriting({ kind: "bailian", apiKey: SENTINEL, request, fetchImpl });
    expect(calls).toHaveLength(1);
    expect(exchange).toMatchObject({ outcome: "rejected", errorCode: "auth", content: null });
    expect(JSON.stringify(exchange)).not.toContain(SENTINEL);
  });

  it("drops an answer that contains the key", async () => {
    const { fetchImpl } = install(() => chat(`{"note":"${SENTINEL}"}`));
    const exchange = await sendAiSdkWriting({ kind: "bailian", apiKey: SENTINEL, request, fetchImpl });
    expect(exchange).toMatchObject({ outcome: "rejected", errorCode: "invalid_output", content: null });
    expect(JSON.stringify(exchange)).not.toContain(SENTINEL);
  });

  it("records a timeout as unknown after one attempt", async () => {
    const fetchImpl: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (init?.signal?.aborted) fail();
      init?.signal?.addEventListener("abort", fail, { once: true });
    });
    const exchange = await sendAiSdkWriting({ kind: "bailian", apiKey: SENTINEL, request, fetchImpl, timeoutMs: 30 });
    expect(exchange).toMatchObject({ outcome: "unknown", errorCode: "timeout", content: null });
  });

  it("refuses to call the network when no fetch is injected", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const exchange = await sendAiSdkWriting({ kind: "bailian" as SdkWritingKind, apiKey: SENTINEL, request, fetchImpl: undefined });
    expect(exchange).toMatchObject({ outcome: "unknown", errorCode: "disconnected" });
    expect(spy).not.toHaveBeenCalled();
  });
});
