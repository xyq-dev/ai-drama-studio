import { describe, expect, it, vi } from "vitest";
import { checkVendorCatalog } from "./admin-vendor-probe";

describe("supplier catalog evidence", () => {
  it("sends each saved key to its own official route, without any inference request", async () => {
    const key = "synthetic-catalog-secret";
    const network = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ id: "deepseek-flash" }] }))
      .mockResolvedValueOnce(Response.json({ data: [], has_more: true }))
      .mockResolvedValueOnce(Response.json({ success: true, output: { permissions: [{ model: "qwen-plus", permissions: { inference: true } }] } }));
    expect(await checkVendorCatalog("deepseek", "deepseek-flash", key, undefined, network)).toMatchObject({ status: "listed" });
    expect(await checkVendorCatalog("anthropic", "the-model", key, "wrkspc_test", network)).toMatchObject({ status: "unknown" });
    expect(await checkVendorCatalog("bailian", "qwen-plus", key, undefined, network)).toMatchObject({ status: "listed" });
    expect(network.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.deepseek.com/models", "https://api.anthropic.com/v1/models?limit=1000",
      "https://dashscope.aliyuncs.com/api/v1/models/permissions?model=qwen-plus&authorization_scope=AUTHORIZED&action=INFERENCE",
    ]);
    expect(network.mock.calls[1]?.[1]?.headers).toMatchObject({ "x-api-key": key, "anthropic-workspace-id": "wrkspc_test" });
    expect(network.mock.calls.every(([, init]) => init?.method === "GET" && !init.body)).toBe(true);
  });

  it("never retries ambiguous responses, classifies a missing model and never echoes upstream errors", async () => {
    const key = "synthetic-catalog-secret";
    for (const [response, status] of [
      [new DOMException("timeout", "TimeoutError"), "unknown"],
      [Response.json({ error: key }, { status: 504 }), "unknown"],
      [Response.json({ data: [] }), "unavailable"],
      [Response.json({ error: key }), "unknown"],
      [Response.json({ error: key }, { status: 401 }), "failed"],
    ] as const) {
      const network = vi.fn<typeof fetch>();
      if (response instanceof Error) network.mockRejectedValueOnce(response);
      else network.mockResolvedValueOnce(response);
      const result = await checkVendorCatalog("openai", "gpt-6-astra", key, undefined, network);
      expect(result.status).toBe(status);
      expect(result.message).not.toContain(key);
      expect(network).toHaveBeenCalledTimes(1);
    }
  });
});
