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
    expect(await checkVendorCatalog("bailian", "qwen-plus", key, "llm-workspace", network)).toMatchObject({ status: "listed" });
    expect(network.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.deepseek.com/models", "https://api.anthropic.com/v1/models?limit=1000",
      "https://llm-workspace.cn-beijing.maas.aliyuncs.com/api/v1/models/permissions?model=qwen-plus&authorization_scope=AUTHORIZED&action=INFERENCE",
    ]);
    expect(network.mock.calls[1]?.[1]?.headers).toMatchObject({ "x-api-key": key, "anthropic-workspace-id": "wrkspc_test" });
    expect(network.mock.calls.every(([, init]) => init?.method === "GET" && !init.body)).toBe(true);
  });

  it("rejects a historical subscription key or missing/invalid Bailian workspace before sending anything", async () => {
    const network = vi.fn<typeof fetch>();
    const planKey = "sk-sp-fixture-for-tests";
    const result = await checkVendorCatalog("bailian", "qwen-plus", planKey, "llm-example", network);
    expect(result).toEqual({ status: "failed", message: "这是套餐密钥，请使用百炼按量付费 API Key" });
    expect(JSON.stringify(result)).not.toContain(planKey);
    for (const bad of [undefined, "tenant.other", "https://other.test", "tenant/other", "space@other", "-space"]) {
      expect(await checkVendorCatalog("bailian", "qwen-plus", "synthetic-regular-key", bad, network))
        .toMatchObject({ status: "failed" });
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("requires inference permission for the exact model, and treats timeouts as unknown without retrying", async () => {
    const key = "synthetic-regular-key";
    const network = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, output: { permissions: [
        { model: "qwen-plus", permissions: { inference: false } },
        { model: "other", permissions: { inference: true } },
      ] } }))
      .mockResolvedValueOnce(Response.json({ error: key }, { status: 403 }))
      .mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"));
    for (const status of ["unavailable", "failed", "unknown"]) {
      const result = await checkVendorCatalog("bailian", "qwen-plus", key, "llm-example", network);
      expect(result.status).toBe(status);
      expect(result.message).not.toContain(key);
    }
    expect(network).toHaveBeenCalledTimes(3);
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
