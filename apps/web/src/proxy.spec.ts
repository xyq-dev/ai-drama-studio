import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config, pageAccess, proxy } from "./proxy";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("page access decided by the API session check", () => {
  it("allows a valid session and forwards only the browser cookie to the API", async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => json({ enabled: true, authenticated: true }));
    expect(await pageAccess("__Host-ads_session=abc", fetch as unknown as typeof globalThis.fetch)).toBe("allowed");
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:3001/api/v1/auth/session");
    expect(init!.headers).toEqual({ accept: "application/json", cookie: "__Host-ads_session=abc" });
  });
  it("tells an expired or forged session apart from no session", async () => {
    const answer = async () => json({ error: { code: "AUTH_SESSION_EXPIRED" } }, 401);
    expect(await pageAccess("__Host-ads_session=gone", answer as unknown as typeof fetch)).toBe("expired");
    expect(await pageAccess(null, answer as unknown as typeof fetch)).toBe("signed-out");
    expect(await pageAccess("other=1", answer as unknown as typeof fetch)).toBe("signed-out");
  });
  it("fails closed when the login service cannot answer", async () => {
    for (const answer of [
      async () => { throw new Error("connection refused"); },
      async () => json({ error: { code: "AUTH_NOT_CONFIGURED" } }, 503),
      async () => new Response("<html>", { status: 200 }),
      async () => json({ enabled: true, authenticated: false }),
    ]) {
      expect(["unavailable", "signed-out"]).toContain(await pageAccess("x=1", answer as unknown as typeof fetch));
      expect(await pageAccess("x=1", answer as unknown as typeof fetch)).not.toBe("allowed");
    }
  });
  it("keeps pages open only when the API says login is switched off", async () => {
    expect(await pageAccess(null, (async () => json({ enabled: false, authenticated: false })) as unknown as typeof fetch)).toBe("allowed");
  });
});

describe("page proxy", () => {
  it("redirects a signed-out page request to /login on the same origin, keeping the page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: "AUTH_REQUIRED" } }, 401)));
    const response = await proxy(new NextRequest("https://drama.example.test/projects/p1/create?step=story"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://drama.example.test/login?returnTo=%2Fprojects%2Fp1%2Fcreate%3Fstep%3Dstory");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("marks an expired session and an unavailable login service on the way to /login", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: "AUTH_SESSION_EXPIRED" } }, 401)));
    const expired = await proxy(new NextRequest("https://drama.example.test/studio", { headers: { cookie: "__Host-ads_session=old" } }));
    expect(expired.headers.get("location")).toBe("https://drama.example.test/login?returnTo=%2Fstudio&reason=expired");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    const down = await proxy(new NextRequest("https://drama.example.test/admin/models"));
    expect(down.headers.get("location")).toBe("https://drama.example.test/login?returnTo=%2Fadmin%2Fmodels&reason=unavailable");
  });
  it("lets a signed-in request through", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ enabled: true, authenticated: true, role: "creator" })));
    const response = await proxy(new NextRequest("https://drama.example.test/studio", { headers: { cookie: "__Host-ads_session=ok" } }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
  it("sends a creator from /admin and storage settings to /studio", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      enabled: true, authenticated: true, role: "creator", username: "creator-a",
    })));
    for (const path of ["/admin", "/admin/features", "/admin/works", "/admin/assets", "/admin/jobs", "/admin/usage", "/admin/users", "/admin/logs", "/admin/models", "/admin/media-keys"]) {
      const response = await proxy(new NextRequest(`https://drama.example.test${path}`, {
        headers: { cookie: "__Host-ads_session=creator" },
      }));
      expect(response.status, path).toBe(307);
      expect(response.headers.get("location"), path).toBe("https://drama.example.test/studio");
      expect(response.headers.get("cache-control"), path).toBe("private, no-store");
      expect(response.headers.get("x-middleware-next"), path).toBeNull();
    }
    const storage = await proxy(new NextRequest("https://drama.example.test/settings/storage", {
      headers: { cookie: "__Host-ads_session=creator" },
    }));
    expect(storage.status).toBe(307);
    expect(storage.headers.get("location")).toBe("https://drama.example.test/studio");
  });
  it.each(["", "/create?step=cast", "/script", "/writing", "/series", "/auto"])("redirects an operator opening a project%s to its read-only review", async (path) => {
    const id = "11111111-1111-4111-8111-111111111111";
    const fetch = vi.fn(async () => json({ enabled: true, authenticated: true, role: "operator" }));
    vi.stubGlobal("fetch", fetch);
    const response = await proxy(new NextRequest(`https://drama.example.test/projects/${id}${path}`));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`https://drama.example.test/admin/works/${id}/review?from=creator`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("leaves the workbench and its existing ownership gate in place for creators and legacy login-off sessions", async () => {
    for (const session of [{ enabled: true, authenticated: true, role: "creator" }, { enabled: false }]) {
      vi.stubGlobal("fetch", vi.fn(async () => json(session)));
      const response = await proxy(new NextRequest("https://drama.example.test/projects/11111111-1111-4111-8111-111111111111/create?step=cast"));
      expect(response.headers.get("x-middleware-next")).toBe("1");
    }
  });
  it("allows an operator session into /admin", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      enabled: true, authenticated: true, role: "operator", username: "admin",
    })));
    for (const path of ["/admin/models", "/admin/features", "/admin/usage", "/admin/works"]) {
      const response = await proxy(new NextRequest(`https://drama.example.test${path}`, {
        headers: { cookie: "__Host-ads_session=operator" },
      }));
      expect(response.headers.get("x-middleware-next"), path).toBe("1");
    }
  });
  it("covers every page except /login, the API and built static assets", () => {
    const pattern = new RegExp(`^${config.matcher[0]!}$`);
    for (const path of ["/", "/studio", "/create", "/projects/p1/writing", "/admin/models", "/status", "/loginx", "/_next/image", "/favicon.ico"]) {
      expect(pattern.test(path), path).toBe(true);
    }
    for (const path of ["/login", "/api/v1/projects", "/_next/static/chunks/a.js"]) {
      expect(pattern.test(path), path).toBe(false);
    }
  });
});
