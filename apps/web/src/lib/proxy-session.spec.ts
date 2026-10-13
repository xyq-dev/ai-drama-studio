import { describe, expect, it, vi } from "vitest";
import { proxyAssetContent } from "./asset-content-proxy";
import { proxyEpisodeExport } from "./episode-export-proxy";

const ID = "11111111-1111-4111-8111-111111111111";
const COOKIE = "__Host-ads_session=abc; __Host-ads_csrf=def";
const unauthorized = () => new Response(JSON.stringify({ error: { code: "AUTH_REQUIRED" } }), { status: 401, headers: { "content-type": "application/json" } });

describe("server-side proxies pass the browser session to the API and never grant access themselves", () => {
  it("asset content forwards the cookie and passes a 401 through", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => unauthorized());
    const got = await proxyAssetContent(new Request("http://localhost/content", { headers: { cookie: COOKIE } }), Promise.resolve({ assetId: ID }),
      fetchImpl as unknown as typeof fetch);
    expect(new Headers(fetchImpl.mock.calls[0]![1]!.headers).get("cookie")).toBe(COOKIE);
    expect(got.status).toBe(401);
  });
  it("asset content sends no cookie when the browser has none", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => unauthorized());
    await proxyAssetContent(new Request("http://localhost/content"), Promise.resolve({ assetId: ID }), fetchImpl as unknown as typeof fetch);
    expect(new Headers(fetchImpl.mock.calls[0]![1]!.headers).has("cookie")).toBe(false);
  });
  it("episode download forwards the cookie and does not turn a 401 into a download", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => unauthorized());
    const request = new Request(`http://localhost/download?expectedContentHash=${"ab".repeat(32)}`, { headers: { cookie: COOKIE } });
    const got = await proxyEpisodeExport(request, Promise.resolve({ projectId: ID, episodeId: ID, assetId: ID }), "download",
      fetchImpl as unknown as typeof fetch);
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ method: "GET", headers: { cookie: COOKIE } });
    expect(got.status).toBe(401);
    expect(got.headers.get("content-disposition")).toBeNull();
  });
});
