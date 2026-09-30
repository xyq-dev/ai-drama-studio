import { describe, expect, it, vi } from "vitest";
import { proxyAssetContent } from "./asset-content-proxy";

const assetId = "33333333-3333-4333-8333-333333333333";

describe("same-origin asset content proxy", () => {
  it("forwards GET bytes and HEAD without a body, including a Range header the API ignores", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => new Response(init?.method === "HEAD" ? null : bytes, {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "content-length": String(bytes.byteLength),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    }));
    const getRequest = new Request("http://localhost/content", { headers: { range: "bytes=0-1" } });
    const got = await proxyAssetContent(getRequest, Promise.resolve({ assetId }), fetchImpl as typeof fetch);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
    expect(got.headers.get("content-type")).toBe("video/mp4");
    expect(got.headers.get("content-length")).toBe("4");
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining(`/api/v1/assets/${assetId}/content`), expect.objectContaining({
      method: "GET",
    }));
    const forwarded = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(forwarded.headers).get("range")).toBe("bytes=0-1");

    const head = await proxyAssetContent(new Request("http://localhost/content", { method: "HEAD" }), Promise.resolve({ assetId }), fetchImpl as typeof fetch);
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect(head.headers.get("content-length")).toBe("4");
    expect(head.headers.get("accept-ranges")).toBeNull();
  });
});
