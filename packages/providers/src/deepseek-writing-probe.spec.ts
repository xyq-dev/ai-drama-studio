import { afterEach, describe, expect, it, vi } from "vitest";
import { probeDeepseekWriting } from "./deepseek-writing-probe";
import { DEEPSEEK_CHAT_COMPLETIONS_URL } from "./text-writing";

const SENTINEL = "sk-sentinel-probe-key-do-not-leak";

function jsonReply(content: string, extra: { status?: number; finish?: string; model?: string } = {}): Response {
  return new Response(JSON.stringify({
    id: "chatcmpl-probe",
    model: extra.model ?? "deepseek-flash",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: extra.finish ?? "stop" }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  }), { status: extra.status ?? 200, headers: { "content-type": "application/json" } });
}

describe("DeepSeek writing probe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts one official JSON Output request and does not leak the key", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("global fetch"); });
    let calls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      calls += 1;
      expect(String(input)).toBe(DEEPSEEK_CHAT_COMPLETIONS_URL);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${SENTINEL}`);
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        response_format: { type: string };
        thinking: { type: string };
        stream: boolean;
        messages: Array<{ content: string }>;
      };
      expect(body).toMatchObject({
        model: "deepseek-flash",
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        stream: false,
      });
      expect(body.messages.some((message) => message.content.toLowerCase().includes("json"))).toBe(true);
      expect(body.messages.some((message) => message.content.includes("EXAMPLE JSON OUTPUT"))).toBe(true);
      expect(String(init?.body)).not.toContain(SENTINEL);
      return jsonReply('{"ok":true}');
    };
    const result = await probeDeepseekWriting({ apiKey: SENTINEL, model: "deepseek-flash", fetchImpl });
    expect(calls).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      message: "已用所选模型完成一次最小 JSON 编剧探测，可以启用这一份草稿。",
      usage: { status: "present", amount: 6, unit: "token" },
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("does not call the network when fetch is missing or the model is not official", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const missing = await probeDeepseekWriting({ apiKey: SENTINEL, model: "deepseek-flash", fetchImpl: undefined });
    expect(missing).toMatchObject({ ok: false, message: "当前环境未接通供应商检测，测试没有发出。" });
    const unlisted = await probeDeepseekWriting({
      apiKey: SENTINEL,
      model: "deepseek-chat",
      fetchImpl: async () => { throw new Error("should not run"); },
    });
    expect(unlisted).toMatchObject({ ok: false, message: "该模型不在官方编剧候选中，检测没有发出。" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("covers official error codes and never retries", async () => {
    const cases: Array<[number, string]> = [
      [401, "认证失败：请检查 API Key 是否正确。"],
      [402, "余额不足：请先为 DeepSeek 账号充值。"],
      [429, "请求被限流：请稍后再检测，不会自动重试。"],
      [408, "请求超时，请先核对供应商的调用记录。"],
      [504, "请求超时，请先核对供应商的调用记录。"],
    ];
    for (const [status, message] of cases) {
      let calls = 0;
      const fetchImpl: typeof fetch = async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: SENTINEL } }), { status });
      };
      const result = await probeDeepseekWriting({ apiKey: SENTINEL, model: "deepseek-v4-pro", fetchImpl });
      expect(calls).toBe(1);
      expect(result).toMatchObject({ ok: false, message });
      expect(result.outcome).toBe([408, 504].includes(status) ? "unknown" : undefined);
      expect(JSON.stringify(result)).not.toContain(SENTINEL);
    }
  });

  it("rejects blank content and invalid JSON without a second send", async () => {
    const blank = await probeDeepseekWriting({
      apiKey: SENTINEL,
      model: "deepseek-flash",
      fetchImpl: async () => jsonReply("   "),
    });
    expect(blank).toMatchObject({ ok: false, message: "没有收到完整的检测回复。" });
    let calls = 0;
    const invalid = await probeDeepseekWriting({
      apiKey: SENTINEL,
      model: "deepseek-flash",
      fetchImpl: async () => {
        calls += 1;
        return jsonReply("not-json");
      },
    });
    expect(calls).toBe(1);
    expect(invalid.ok).toBe(false);
    expect(invalid.message).toContain("不是合法 JSON");
  });

  it.each(["[]", "{}", '{"ok":false}', '{"ok":"true"}'])("requires the requested acknowledgement (%s)", async (content) => {
    const fetchImpl = vi.fn(async () => jsonReply(content));
    expect(await probeDeepseekWriting({ apiKey: SENTINEL, model: "deepseek-flash", fetchImpl })).toMatchObject({ ok: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("requires a complete reply from the selected model", async () => {
    const probe = (reply: Response) => probeDeepseekWriting({
      apiKey: SENTINEL, model: "deepseek-v4-pro", fetchImpl: async () => reply,
    });
    expect((await probe(jsonReply('{"ok":true}', { model: "deepseek-flash" }))).ok).toBe(false);
    expect((await probe(jsonReply('{"ok":true}', { model: "deepseek-v4-pro", finish: "" }))).ok).toBe(false);
    expect((await probe(jsonReply('{"ok":true}', { model: "DeepSeek-V4-Pro-0813" }))).ok).toBe(true);
  });

  it("records a timeout as unknown after one attempt", async () => {
    const fetchImpl: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (init?.signal?.aborted) fail();
      init?.signal?.addEventListener("abort", fail, { once: true });
    });
    const result = await probeDeepseekWriting({ apiKey: SENTINEL, model: "deepseek-flash", fetchImpl, timeoutMs: 30 });
    expect(result).toMatchObject({ ok: false, outcome: "unknown", message: "请求超时，请先核对供应商的调用记录。" });
  });
});
