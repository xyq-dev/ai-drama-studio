// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { csrfToken, loginUrl, logout, readSession, safeReturnTo, withSession } from "./site-session";

const CSRF = "c".repeat(43);
let assign: ReturnType<typeof vi.fn<(url: string | URL) => void>>;

beforeEach(() => {
  window.history.replaceState(null, "", "/projects/p1/create?step=story");
  assign = vi.fn<(url: string | URL) => void>();
  vi.spyOn(window.location, "assign").mockImplementation(assign);
});
afterEach(() => { document.cookie = "ads_csrf=; Max-Age=0; Path=/"; vi.restoreAllMocks(); });

describe("returnTo", () => {
  it("keeps paths on this site, with their query", () => {
    expect(safeReturnTo("/studio")).toBe("/studio");
    expect(safeReturnTo("/projects/p1/create?step=story")).toBe("/projects/p1/create?step=story");
    expect(safeReturnTo("/admin/models")).toBe("/admin/models");
  });
  it.each([
    "https://evil.example/", "//evil.example/x", "/\\evil.example", "\\\\evil.example", "javascript:alert(1)", "evil.example",
    "/login", "/login?returnTo=/x", "/api/v1/projects", "/_next/static/x.js", "/\u0000x", " /studio", "", null, undefined,
    `/${"a".repeat(2_001)}`,
  ])("rejects %j and falls back to 我的作品", (value) => {
    expect(safeReturnTo(value as string | null | undefined)).toBe("/studio");
  });
  it("builds the login address with an encoded, checked returnTo", () => {
    expect(loginUrl("/admin/models", "expired")).toBe("/login?returnTo=%2Fadmin%2Fmodels&reason=expired");
    expect(loginUrl("//evil.example")).toBe("/login?returnTo=%2Fstudio");
  });
});

describe("CSRF and session handling for API requests", () => {
  it("reads only a well-formed CSRF cookie", () => {
    expect(csrfToken(`a=1; ads_csrf=${CSRF}`)).toBe(CSRF);
    expect(csrfToken(`__Host-ads_csrf=${CSRF}`)).toBe(CSRF);
    expect(csrfToken("ads_csrf=short")).toBeNull();
    expect(csrfToken("")).toBeNull();
  });
  it("adds the token to writes only, keeping Idempotency-Key and If-Match, and leaves reads untouched", async () => {
    document.cookie = `ads_csrf=${CSRF}; Path=/`;
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => new Response("{}"));
    const send = withSession(fetch);
    const readInit = { method: "GET", headers: { Accept: "application/json" } };
    await send("/api/v1/projects", readInit);
    expect(fetch.mock.calls[0]![1]).toBe(readInit);
    await send("/api/v1/projects", { method: "POST", headers: { "Idempotency-Key": "k-1", "If-Match": "3" }, body: "{}" });
    expect(fetch.mock.calls[1]![1]!.headers).toEqual({ "Idempotency-Key": "k-1", "If-Match": "3", "X-CSRF-Token": CSRF });
    await send("/api/v1/x", { method: "PUT", headers: new Headers({ "Content-Type": "application/json" }) });
    expect(new Headers(fetch.mock.calls[2]![1]!.headers).get("X-CSRF-Token")).toBe(CSRF);
  });
  it("sends writes unchanged without a session cookie (login off)", async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => new Response("{}"));
    const init = { method: "POST", headers: { "Idempotency-Key": "k" } };
    await withSession(fetch)("/api/v1/projects", init);
    expect(fetch.mock.calls[0]![1]).toBe(init);
  });
  it("sends the browser to the login page, keeping the current page, when the API says the session ended", async () => {
    const send = withSession(async () => new Response(JSON.stringify({ error: { code: "AUTH_SESSION_EXPIRED" } }), { status: 401 }));
    const response = await send("/api/v1/projects", { method: "GET" });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "AUTH_SESSION_EXPIRED" } });
    expect(assign).toHaveBeenCalledWith("/login?returnTo=%2Fprojects%2Fp1%2Fcreate%3Fstep%3Dstory&reason=expired");
  });
  it("leaves other 401 answers to the caller", async () => {
    await withSession(async () => new Response(JSON.stringify({ error: { code: "TITLE_WRITING_FORBIDDEN" } }), { status: 401 }))("/api/v1/x");
    await withSession(async () => new Response("not json", { status: 401 }))("/api/v1/x");
    expect(assign).not.toHaveBeenCalled();
  });
  it("reads the session state and logs out with the CSRF token", async () => {
    document.cookie = `ads_csrf=${CSRF}; Path=/`;
    expect(await readSession(async () => new Response("{}", { status: 401 }))).toEqual({ enabled: true, authenticated: false });
    expect(await readSession(async () => new Response(JSON.stringify({ enabled: false, authenticated: false }))))
      .toMatchObject({ enabled: false, authenticated: false });
    await expect(readSession(async () => new Response("{}", { status: 503 }))).rejects.toThrow();
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    await logout(fetch);
    expect(fetch.mock.calls[0]![0]).toBe("/api/v1/auth/logout");
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "POST", headers: { "X-CSRF-Token": CSRF } });
    await expect(logout(async () => new Response(null, { status: 403 }))).rejects.toThrow();
  });
  it("never uses browser storage", async () => {
    const set = vi.spyOn(Storage.prototype, "setItem");
    document.cookie = `ads_csrf=${CSRF}; Path=/`;
    await withSession(async () => new Response("{}"))("/api/v1/projects", { method: "POST" });
    await readSession(async () => new Response(JSON.stringify({ enabled: true, authenticated: true, csrfToken: CSRF })));
    expect(set).not.toHaveBeenCalled();
  });
});
