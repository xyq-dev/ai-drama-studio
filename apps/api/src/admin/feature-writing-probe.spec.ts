import { describe, expect, it, vi } from "vitest";
import { featureWritingProbe } from "./feature-writing-probe";

const input = { feature: "writing", vendor: "bailian", apiKey: "sk-test-fake-only", model: "qwen-plus", kind: "admin_test", vendorRequestId: "probe_mock" } as const;
const valid = '{"title":"雨夜重逢"}';
function chat(model: string | undefined, content: string) {
  return Response.json({
    id: "chatcmpl-fixture", model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  });
}

describe("Bailian draft writing probe", () => {
  it.each(["qwen-plus", "qwen-plus-2025-12-01"])("sends one paid request for the exact selection and verifies the %s reply", async (model) => {
    const transport = vi.fn<typeof fetch>(async () => chat(model, valid));
    const result = await featureWritingProbe(transport)(input);
    expect(result).toMatchObject({ ok: true, usage: { status: "present", amount: 28, unit: "token" } });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0]!;
    expect(String(url)).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: input.model });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + input.apiKey);
    expect(JSON.stringify(result)).not.toContain(input.apiKey);
  });

  it.each([
    ["qwen-plus", "not-json"], ["qwen-plus", '{"ok":true}'], ["qwen-plus", '{"title":"  "}'],
    ["qwen-plus", '{"title":"123"}'], ["other-model", valid], [undefined, valid],
  ])("withholds a pass for response model %s and content %s", async (model, content) => {
    const transport = vi.fn(async () => chat(model, content!));
    expect(await featureWritingProbe(transport)(input)).toMatchObject({ ok: false });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("returns unknown once for HTTP timeout and never exposes the error body", async () => {
    const transport = vi.fn(async () => Response.json({ error: { message: input.apiKey } }, { status: 408 }));
    const result = await featureWritingProbe(transport)(input);
    expect(result).toMatchObject({ ok: false, outcome: "unknown" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(input.apiKey);
  });
});
