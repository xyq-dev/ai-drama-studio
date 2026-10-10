import "reflect-metadata";
import { Controller, Get, Head, Module, Post, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiEnv } from "../config/env";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import { AuthModule } from "./auth.module";
import { hashPassword, parsePasswordHash, verifyPassword } from "./password-hash";
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, SiteAuth, type SiteAuthState } from "./site-auth";
import { siteAuthFromEnv, siteAuthWarnings } from "./site-auth.config";
import { isAnonymous } from "./site-auth.middleware";

// Test-only credentials; the real password is configured on the server and never appears in the repository.
const USERNAME = "admin";
const PASSWORD = "test-only-site-password-Qm7#x";
const ORIGIN = "https://drama.example.test";
const LEGACY_TOKEN = "test-only-admin-bootstrap-7VCTEdmr_-84HqRZ";
let HASH = "";

/** Stand-ins for representative business routes, mounted at their real paths; the session check is path-agnostic. */
const calls: string[] = [];
// Spec files are outside the compiled tsconfig, so Nest decorators are applied as the functions they are.
class BusinessRoutes {
  list() { calls.push("list"); return { items: [] }; }
  create() { calls.push("create"); return { id: "p1" }; }
  stories() { calls.push("stories"); return { items: [] }; }
  content() { calls.push("asset"); return "bytes"; }
  contentHead() { calls.push("asset-head"); return ""; }
  download() { calls.push("download"); return "video"; }
  manifest() { calls.push("manifest"); return {}; }
  titleRun() { calls.push("title-run"); return {}; }
  adminModels() { calls.push("admin"); return {}; }
  live() { return { status: "ok" }; }
  ready() { return { status: "ok" }; }
}
for (const [decorator, path, name] of [
  [Get, "projects", "list"],
  [Post, "projects", "create"],
  [Get, "projects/:projectId/stories", "stories"],
  [Get, "assets/:id/content", "content"],
  [Head, "assets/:id/content", "contentHead"],
  [Get, "projects/:p/episodes/:e/composites/:a/download", "download"],
  [Get, "projects/:p/episodes/:e/composites/:a/export-manifest", "manifest"],
  [Post, "projects/:p/title-runs", "titleRun"],
  [Get, "admin/models", "adminModels"],
  [Get, "health/live", "live"],
  [Get, "health/ready", "ready"],
] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(BusinessRoutes.prototype, name)!;
  decorator(path)(BusinessRoutes.prototype, name, descriptor);
}
Controller()(BusinessRoutes);

function env(overrides: Partial<ApiEnv> = {}): ApiEnv {
  return { NODE_ENV: "test", SITE_AUTH_ENABLED: "true", SITE_AUTH_USERNAME: USERNAME, SITE_AUTH_PASSWORD_HASH: HASH,
    SITE_AUTH_PUBLIC_ORIGIN: ORIGIN, ...overrides } as ApiEnv;
}

beforeAll(async () => {
  // The lowest accepted cost keeps the suite fast; production hashes use the defaults (N = 2^17).
  HASH = await hashPassword(PASSWORD, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
});

describe("site login over real HTTP", () => {
  let app: INestApplication | undefined;
  let base = "";
  let now = Date.parse("2026-10-10T00:00:00Z");

  afterEach(async () => {
    await app?.close();
    app = undefined;
    calls.length = 0;
    now = Date.parse("2026-10-10T00:00:00Z");
  });

  async function start(state?: SiteAuthState) {
    await app?.close();
    const chosen = state ?? { kind: "enabled", auth: new SiteAuth({ username: USERNAME, passwordHash: HASH, publicOrigin: ORIGIN }, { now: () => now }) };
    class Routes {}
    Module({ controllers: [BusinessRoutes] })(Routes);
    const module = await Test.createTestingModule({ imports: [AuthModule.register(env(), chosen), Routes] }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalFilters(new SafeExceptionFilter());
    await app.listen(0, "127.0.0.1");
    base = `${await app.getUrl()}/api/v1`;
  }

  const request = (path: string, init?: RequestInit) => fetch(`${base}${path}`, { redirect: "manual", ...init });

  function login(body: unknown = { username: USERNAME, password: PASSWORD }, headers: Record<string, string> = {}) {
    return request("/auth/login", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
      body: JSON.stringify(body) });
  }

  async function signedIn() {
    const response = await login();
    expect(response.status).toBe(200);
    const cookies = response.headers.getSetCookie();
    const session = cookies.find((item) => item.startsWith("__Host-ads_session="))!.split(";", 1)[0]!;
    const csrfCookie = cookies.find((item) => item.startsWith("__Host-ads_csrf="))!.split(";", 1)[0]!;
    const view = await response.json() as { csrfToken: string; username: string; expiresAt: string };
    return { cookies, session, csrfCookie, view,
      read: { cookie: `${session}; ${csrfCookie}` },
      write: { cookie: `${session}; ${csrfCookie}`, origin: ORIGIN, "content-type": "application/json", "x-csrf-token": view.csrfToken } };
  }

  it("logs in with the right username and password and sets a host-only, HttpOnly, Secure session cookie", async () => {
    await start();
    const { cookies, view } = await signedIn();
    expect(view.username).toBe(USERNAME);
    expect(JSON.stringify(view)).not.toContain(PASSWORD);
    const session = cookies.find((item) => item.startsWith("__Host-ads_session="))!;
    expect(session).toMatch(/^__Host-ads_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200; Secure$/);
    const csrf = cookies.find((item) => item.startsWith("__Host-ads_csrf="))!;
    expect(csrf).toMatch(/^__Host-ads_csrf=[A-Za-z0-9_-]{43}; Path=\/; SameSite=Strict; Max-Age=43200; Secure$/);
    expect(csrf).not.toContain("HttpOnly");
    // The earlier console cookie is cleared on its own path.
    expect(cookies).toContain("ads_admin_session=; Path=/api/v1/admin; HttpOnly; SameSite=Strict; Max-Age=0; Secure");
  });

  it("gives the same answer for an unknown username and a wrong password, and sets no cookie", async () => {
    await start();
    for (const body of [{ username: "root", password: PASSWORD }, { username: USERNAME, password: "wrong-password" },
      { username: USERNAME, password: "" }, { username: USERNAME }, { token: LEGACY_TOKEN }]) {
      now += 61_000;
      const response = await login(body);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { code: "AUTH_LOGIN_FAILED", message: "账号或密码不正确。" } });
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  });

  it("limits login attempts per minute, then admits a login after the window", async () => {
    await start();
    for (let index = 0; index < 5; index += 1) expect((await login({ username: USERNAME, password: "wrong" })).status).toBe(401);
    const limited = await login();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: "AUTH_RATE_LIMITED" } });
    now += 60_001;
    expect((await login()).status).toBe(200);
  });

  it("refuses a login from another origin or without JSON", async () => {
    await start();
    expect((await login(undefined, { origin: "https://evil.example" })).status).toBe(403);
    expect((await request("/auth/login", { method: "POST", headers: { origin: ORIGIN, "content-type": "text/plain" },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }) })).status).toBe(415);
  });

  it("protects representative reads, writes, assets, downloads, exports and the console with JSON 401s", async () => {
    await start();
    const id = "11111111-1111-4111-8111-111111111111";
    for (const [method, path] of [
      ["GET", "/projects"], ["POST", "/projects"], ["GET", `/projects/${id}/stories`],
      ["GET", `/assets/${id}/content`], ["HEAD", `/assets/${id}/content`],
      ["GET", `/projects/${id}/episodes/${id}/composites/${id}/download?expectedContentHash=${"a".repeat(64)}`],
      ["GET", `/projects/${id}/episodes/${id}/composites/${id}/export-manifest?expectedContentHash=${"a".repeat(64)}`],
      ["POST", `/projects/${id}/title-runs`], ["GET", "/admin/models"], ["GET", "/no-such-route"],
      // Path variants never share an exemption with the anonymous routes.
      ["GET", "/auth/session/../../projects"], ["GET", "/health/live/../../projects"], ["GET", "/HEALTH/LIVE/x"],
    ] as const) {
      const response = await request(path, { method, headers: { origin: ORIGIN, "content-type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}) });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(response.headers.get("content-type")).toContain("application/json");
      if (method !== "HEAD") expect(await response.json()).toMatchObject({ error: { code: "AUTH_REQUIRED" } });
    }
    expect(calls).toEqual([]);
  });

  it("keeps health anonymous and gives it nothing else", async () => {
    await start();
    expect((await request("/health/live")).status).toBe(200);
    expect((await request("/health/ready")).status).toBe(200);
    expect(isAnonymous("GET", "/api/v1/health/live?x=1")).toBe(true);
    expect(isAnonymous("POST", "/api/v1/health/live")).toBe(false);
    expect(isAnonymous("GET", "/api/v1/health/live/")).toBe(false);
    expect(isAnonymous("GET", "/api/v1/projects")).toBe(false);
  });

  it("serves reads with the session, restores it on refresh, and requires origin and CSRF for writes", async () => {
    await start();
    const { read, write, view } = await signedIn();
    expect((await request("/projects", { headers: read })).status).toBe(200);
    // A page reload reads the session again: same CSRF token, still signed in.
    const again = await request("/auth/session", { headers: read });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ authenticated: true, username: USERNAME, csrfToken: view.csrfToken });

    const post = (headers: Record<string, string>) => request("/projects", { method: "POST", headers, body: JSON.stringify({ title: "t" }) });
    expect((await post({ ...write, origin: "https://evil.example" })).status).toBe(403);
    const { origin: _origin, ...noOrigin } = write;
    expect((await post(noOrigin)).status).toBe(403);
    const { "x-csrf-token": _csrf, ...noCsrf } = write;
    expect(await (await post(noCsrf)).json()).toMatchObject({ error: { code: "AUTH_CSRF_REJECTED" } });
    expect((await post({ ...write, "x-csrf-token": "A".repeat(43) })).status).toBe(403);
    expect(calls).toEqual(["list"]);
    const created = await post({ ...write, "idempotency-key": "k-1", "if-match": "1" });
    expect(created.status).toBe(201);
    expect(calls).toEqual(["list", "create"]);
  });

  it("treats forged, duplicated and expired sessions as signed out", async () => {
    await start();
    const { session, read } = await signedIn();
    for (const cookie of ["__Host-ads_session=" + "A".repeat(43), `${session}; ${session}`, "__Host-ads_session=not-valid",
      "ads_session=" + session.split("=")[1]]) {
      const response = await request("/projects", { headers: { cookie } });
      expect(response.status, cookie.slice(0, 30)).toBe(401);
    }
    expect(await (await request("/projects", { headers: { cookie: "__Host-ads_session=" + "A".repeat(43) } })).json())
      .toMatchObject({ error: { code: "AUTH_SESSION_EXPIRED" } });
    // Idle expiry: two hours without a request.
    now += SESSION_IDLE_MS;
    const expired = await request("/projects", { headers: read });
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ error: { code: "AUTH_SESSION_EXPIRED", message: "登录已过期或已退出，请重新登录。" } });
  });

  it("answers a passive session check without extending the idle limit; a normal read does extend it", async () => {
    await start();
    const { read } = await signedIn();
    const passive = { ...read, "x-session-check": "passive" };
    now += SESSION_IDLE_MS - 1;
    expect((await request("/auth/session", { headers: passive })).status).toBe(200);
    now += 1;
    expect((await request("/auth/session", { headers: passive })).status).toBe(401);
    await start();
    const second = await signedIn();
    now += SESSION_IDLE_MS - 1;
    expect((await request("/auth/session", { headers: second.read })).status).toBe(200);
    now += 1;
    expect((await request("/auth/session", { headers: { ...second.read, "x-session-check": "passive" } })).status).toBe(200);
  });

  it("ends a session at the absolute limit even while it is in use", async () => {
    await start();
    const { read } = await signedIn();
    for (let elapsed = 0; elapsed < SESSION_ABSOLUTE_MS - SESSION_IDLE_MS / 2; elapsed += SESSION_IDLE_MS / 2) {
      now += SESSION_IDLE_MS / 2;
      expect((await request("/projects", { headers: read })).status).toBe(200);
    }
    now += SESSION_IDLE_MS / 2;
    expect((await request("/projects", { headers: read })).status).toBe(401);
  });

  it("revokes the session on logout so the old cookie no longer works anywhere", async () => {
    await start();
    const { read, write } = await signedIn();
    expect((await request("/auth/logout", { method: "POST", headers: { ...read, origin: ORIGIN } })).status).toBe(403);
    const out = await request("/auth/logout", { method: "POST", headers: write });
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie()).toEqual(expect.arrayContaining([
      "__Host-ads_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
      "__Host-ads_csrf=; Path=/; SameSite=Strict; Max-Age=0; Secure",
    ]));
    for (const path of ["/projects", "/admin/models", "/auth/session"]) {
      expect((await request(path, { headers: read })).status, path).toBe(401);
    }
    expect((await request("/projects", { method: "POST", headers: write, body: "{}" })).status).toBe(401);
  });

  it("does not accept the old administrator token in any form", async () => {
    await start();
    expect((await login({ token: LEGACY_TOKEN })).status).toBe(401);
    expect((await login({ username: USERNAME, password: LEGACY_TOKEN })).status).toBe(401);
    for (const headers of [{ authorization: `Bearer ${LEGACY_TOKEN}` }, { "x-admin-token": LEGACY_TOKEN },
      { cookie: `ads_admin_session=${LEGACY_TOKEN}` }]) {
      expect((await request("/admin/models", { headers })).status).toBe(401);
    }
    // The earlier token login route no longer exists, and is not reachable without a session either.
    expect((await request("/admin/session", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ token: LEGACY_TOKEN }) })).status).toBe(401);
  });

  it("refuses everything except health when login is switched on but misconfigured", async () => {
    await start({ kind: "misconfigured" });
    for (const path of ["/projects", "/admin/models", "/auth/session"]) {
      const response = await request(path);
      expect(response.status, path).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "AUTH_NOT_CONFIGURED" } });
    }
    expect((await login()).status).toBe(503);
    expect((await request("/health/live")).status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("leaves routes open only when login is explicitly off, and says so to the web", async () => {
    await start({ kind: "disabled" });
    expect((await request("/projects")).status).toBe(200);
    expect(await (await request("/auth/session")).json()).toEqual({ enabled: false, authenticated: false });
    expect((await login()).status).toBe(503);
  });

  it("never logs the password or the session", async () => {
    const spy = vi.spyOn(console, "log");
    await start();
    await signedIn();
    expect(JSON.stringify(spy.mock.calls)).not.toContain(PASSWORD);
    spy.mockRestore();
  });
});

describe("site login configuration", () => {
  it("is independent of MODEL_ADMIN_ENABLED and fails closed on anything incomplete", () => {
    expect(siteAuthFromEnv(env({ SITE_AUTH_ENABLED: undefined, MODEL_ADMIN_ENABLED: "true" })).kind).toBe("disabled");
    expect(siteAuthFromEnv(env({ MODEL_ADMIN_ENABLED: "false" })).kind).toBe("enabled");
    for (const overrides of [{ SITE_AUTH_ENABLED: "yes" }, { SITE_AUTH_PASSWORD_HASH: undefined }, { SITE_AUTH_PASSWORD_HASH: "sha256$abc" },
      { SITE_AUTH_PUBLIC_ORIGIN: undefined }, { SITE_AUTH_PUBLIC_ORIGIN: "https://drama.example.test/" },
      { SITE_AUTH_PUBLIC_ORIGIN: "http://drama.example.test" }, { SITE_AUTH_USERNAME: "ad min" },
      { NODE_ENV: "production" as const, SITE_AUTH_PUBLIC_ORIGIN: "http://localhost:3000" }]) {
      expect(siteAuthFromEnv(env(overrides)).kind, JSON.stringify(overrides)).toBe("misconfigured");
    }
    expect(siteAuthFromEnv(env({ SITE_AUTH_PUBLIC_ORIGIN: "http://127.0.0.1:3000" })).kind).toBe("enabled");
  });

  it("warns, without values, that the old token and origin variables are ignored", () => {
    const warnings = siteAuthWarnings(env({ MODEL_ADMIN_TOKEN: LEGACY_TOKEN, MODEL_ADMIN_PUBLIC_ORIGIN: ORIGIN }), siteAuthFromEnv(env()));
    expect(warnings.join("\n")).toContain("MODEL_ADMIN_TOKEN is no longer used");
    expect(warnings.join("\n")).not.toContain(LEGACY_TOKEN);
  });
});

describe("password hashing", () => {
  it("uses salted scrypt at the OWASP minimum by default and verifies only the right password", async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).toMatch(/^scrypt\$17\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(await hashPassword(PASSWORD)).not.toBe(hash);
    const parsed = parsePasswordHash(hash)!;
    expect(await verifyPassword(PASSWORD, parsed)).toBe(true);
    expect(await verifyPassword(`${PASSWORD} `, parsed)).toBe(false);
  });

  it("rejects plain digests and out-of-range parameters", () => {
    expect(parsePasswordHash("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")).toBeNull();
    expect(parsePasswordHash(HASH.replace(/^scrypt\$15/, "scrypt$10"))).toBeNull();
    expect(parsePasswordHash(HASH.replace(/^scrypt\$15/, "scrypt$30"))).toBeNull();
  });

  it("accepts hashes made by the operator script", async () => {
    const { hashPassword: scriptHash } = await import("../../../../scripts/site-auth-password.mjs") as { hashPassword: (value: string) => Promise<string> };
    const parsed = parsePasswordHash(await scriptHash(PASSWORD))!;
    expect(parsed).not.toBeNull();
    expect(await verifyPassword(PASSWORD, parsed)).toBe(true);
  });
});
