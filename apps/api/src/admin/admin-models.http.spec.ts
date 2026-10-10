import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminModelsView, AdminSessionView } from "@ai-drama/contracts";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import { ADMIN_AUTH, ADMIN_SESSION_COOKIE, ADMIN_SESSION_DURATION_MS, AdminAuth, setAdminResponseHeaders } from "./admin-auth";
import type { AdminHeaderResponse } from "./admin-auth";
import { ADMIN_MODELS_SERVICE, AdminModelsController } from "./admin-models.controller";

const TOKEN = "test-only-admin-bootstrap-7VCTEdmr_-84HqRZ";
const SECRET = "sk-test-never-echo-provider-key";
const ORIGIN = "https://drama.example.test";
const VIEW: AdminModelsView = {
  savedRevision: 0,
  activeRevision: 0,
  pendingRestart: false,
  activationDeferred: false,
  source: "environment",
  titleWriting: { enabled: false, productionBlocked: false, operatorConfigured: false },
  saved: { defaultProvider: null, maxCallsPerDay: 8, maxActiveRuns: 1, providers: [] },
  active: { defaultProvider: null, maxCallsPerDay: 8, maxActiveRuns: 1, providers: [] },
  audit: [],
  validation: "local_only",
};
const UPDATE = { expectedRevision: 0, models: ["test-model"], secretAction: "replace", apiKey: SECRET };
const LIMITS = { expectedRevision: 0, defaultProvider: "qwen", maxCallsPerDay: 8, maxActiveRuns: 1 };

function backend() {
  return {
    view: vi.fn(async () => VIEW),
    updateProvider: vi.fn(async () => VIEW),
    updateLimits: vi.fn(async () => VIEW),
  };
}

function privateHeaders(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("administrator model settings real HTTP boundary", () => {
  let app: INestApplication | undefined;
  let base: string;
  let now = Date.parse("2026-10-10T00:00:00Z");
  let store: ReturnType<typeof backend>;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    now = Date.parse("2026-10-10T00:00:00Z");
  });

  async function start(options: { authMissing?: boolean; backendMissing?: boolean; publicOrigin?: string } = {}) {
    store = backend();
    const auth = options.authMissing ? null : new AdminAuth({ token: TOKEN, publicOrigin: options.publicOrigin ?? ORIGIN }, { now: () => now });
    const module = await Test.createTestingModule({
      controllers: [AdminModelsController],
      providers: [
        { provide: ADMIN_AUTH, useValue: auth },
        { provide: ADMIN_MODELS_SERVICE, useValue: options.backendMissing ? null : store },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.use("/api/v1/admin", (_request: unknown, response: AdminHeaderResponse, next: () => void) => {
      setAdminResponseHeaders(response);
      next();
    });
    app.setGlobalPrefix("api/v1");
    app.useGlobalFilters(new SafeExceptionFilter());
    await app.listen(0, "127.0.0.1");
    base = `${await app.getUrl()}/api/v1/admin`;
  }

  function request(path: string, init?: RequestInit) {
    return fetch(`${base}${path}`, init);
  }

  async function login(token: unknown = TOKEN, extraHeaders: Record<string, string> = {}) {
    return request("/session", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify({ token }),
    });
  }

  async function signedIn() {
    const response = await login();
    expect(response.status).toBe(200);
    privateHeaders(response);
    const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
    const view = await response.json() as AdminSessionView;
    return { response, cookie, view, headers: { cookie, origin: ORIGIN, "content-type": "application/json", "x-admin-csrf": view.csrfToken } };
  }

  it("requires authentication before all settings backend reads and writes", async () => {
    await start();
    for (const [path, init] of [
      ["/session", undefined],
      ["/models", undefined],
      ["/models/providers/qwen", { method: "PUT", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(UPDATE) }],
      ["/models/limits", { method: "PUT", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(LIMITS) }],
    ] as const) {
      const response = await request(path, init);
      expect(response.status).toBe(401);
      privateHeaders(response);
      expect(await response.json()).toMatchObject({ error: { code: "ADMIN_UNAUTHENTICATED" } });
    }
    expect(store.view).not.toHaveBeenCalled();
    expect(store.updateProvider).not.toHaveBeenCalled();
    expect(store.updateLimits).not.toHaveBeenCalled();
  });

  it("issues an opaque restricted cookie, restores CSRF by session GET, and never echoes bootstrap credentials", async () => {
    await start();
    const { response, cookie, view } = await signedIn();
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toMatch(new RegExp(`^${ADMIN_SESSION_COOKIE}=[A-Za-z0-9_-]{43};`));
    expect(setCookie).toContain("Path=/api/v1/admin");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("Max-Age=1800");
    expect(setCookie).not.toContain("Domain=");
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(view.expiresAt).toBe(new Date(now + ADMIN_SESSION_DURATION_MS).toISOString());
    const restored = await request("/session", { headers: { cookie } });
    expect(await restored.json()).toEqual(view);
    const models = await request("/models", { headers: { cookie } });
    expect(models.status).toBe(200);
    expect(await models.json()).toEqual(VIEW);
    expect(store.view).toHaveBeenCalledTimes(1);
  });

  it("rejects wrong, missing, oversized or malformed login tokens without setting cookies", async () => {
    await start();
    for (const token of [null, "wrong-token", "x".repeat(257), { token: TOKEN }]) {
      const response = await login(token);
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
      privateHeaders(response);
      const text = await response.text();
      expect(text).toContain("ADMIN_LOGIN_FAILED");
      expect(text).not.toContain(TOKEN);
    }
    const missing = await request("/session", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("set-cookie")).toBeNull();
    expect(store.view).not.toHaveBeenCalled();
  });

  it("requires exact trusted Origin and JSON for login, ignoring forwarded host claims", async () => {
    await start();
    for (const origin of ["https://evil.test", "null", `${ORIGIN}.evil.test`, `${ORIGIN}/`]) {
      const response = await login(TOKEN, { origin, "x-forwarded-host": "drama.example.test" });
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    const noOrigin = await request("/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN }) });
    expect(noOrigin.status).toBe(403);
    const wrongType = await login(TOKEN, { "content-type": "text/plain" });
    expect(wrongType.status).toBe(415);
    expect(wrongType.headers.get("set-cookie")).toBeNull();
    expect((await login()).status).toBe(200);
  });

  it("rate limits all login attempts globally without trusting spoofed forwarded IPs", async () => {
    await start();
    for (let i = 0; i < 5; i += 1) {
      expect((await login("wrong-token", { "x-forwarded-for": `10.0.0.${i}` })).status).toBe(401);
    }
    const response = await login(TOKEN, { "x-forwarded-for": "203.0.113.9" });
    expect(response.status).toBe(429);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toMatchObject({ error: { code: "ADMIN_RATE_LIMITED" } });
    now += 60_001;
    expect((await login()).status).toBe(200);
  });

  it("rejects forged and duplicate session cookies before accessing storage", async () => {
    await start();
    const { cookie } = await signedIn();
    for (const value of [
      `${ADMIN_SESSION_COOKIE}=${"A".repeat(43)}`,
      `${cookie}; ${cookie}`,
      `${cookie}; ${ADMIN_SESSION_COOKIE}=forged`,
      `${ADMIN_SESSION_COOKIE}=not-valid`,
    ]) {
      expect((await request("/models", { headers: { cookie: value } })).status).toBe(401);
    }
    expect(store.view).not.toHaveBeenCalled();
  });

  it("has an absolute 30-minute expiry that reads do not extend", async () => {
    await start();
    const { cookie } = await signedIn();
    now += ADMIN_SESSION_DURATION_MS - 1;
    expect((await request("/session", { headers: { cookie } })).status).toBe(200);
    now += 1;
    expect((await request("/models", { headers: { cookie } })).status).toBe(401);
    expect(store.view).not.toHaveBeenCalled();
  });

  it("requires session-bound CSRF and trusted Origin on every settings mutation", async () => {
    await start();
    const first = await signedIn();
    const second = await signedIn();
    for (const [path, body] of [["/models/providers/qwen", UPDATE], ["/models/limits", LIMITS]] as const) {
      for (const headers of [
        { cookie: first.cookie, origin: ORIGIN, "content-type": "application/json" },
        { ...first.headers, "x-admin-csrf": second.view.csrfToken },
        { ...first.headers, origin: "https://evil.test" },
      ]) {
        const response = await request(path, { method: "PUT", headers, body: JSON.stringify(body) });
        expect(response.status).toBe(403);
        privateHeaders(response);
      }
      const mediaFailure = await request(path, { method: "PUT", headers: { ...first.headers, "content-type": "text/plain" }, body: JSON.stringify(body) });
      expect(mediaFailure.status).toBe(415);
    }
    expect(store.updateProvider).not.toHaveBeenCalled();
    expect(store.updateLimits).not.toHaveBeenCalled();
  });

  it("validates provider and limits DTOs before touching storage and never echoes submitted secrets", async () => {
    await start();
    const { headers } = await signedIn();
    for (const [path, body] of [
      ["/models/providers/unknown", UPDATE],
      ["/models/providers/qwen", { ...UPDATE, secretAction: "keep" }],
      ["/models/providers/qwen", { ...UPDATE, models: ["https://secret.test/model"] }],
      ["/models/limits", { ...LIMITS, maxActiveRuns: 0 }],
      ["/models/limits", { ...LIMITS, apiKey: SECRET }],
    ]) {
      const response = await request(path as string, { method: "PUT", headers, body: JSON.stringify(body) });
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("ADMIN_CONFIG_INVALID");
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("https://secret.test");
    }
    expect(store.updateProvider).not.toHaveBeenCalled();
    expect(store.updateLimits).not.toHaveBeenCalled();
  });

  it("passes valid mutations once to the backend and returns only its public view", async () => {
    await start();
    const { headers } = await signedIn();
    const provider = await request("/models/providers/qwen", { method: "PUT", headers, body: JSON.stringify(UPDATE) });
    expect(provider.status).toBe(200);
    expect(await provider.json()).toEqual(VIEW);
    expect(store.updateProvider).toHaveBeenCalledExactlyOnceWith("qwen", UPDATE);
    const limits = await request("/models/limits", { method: "PUT", headers, body: JSON.stringify(LIMITS) });
    expect(limits.status).toBe(200);
    expect(await limits.json()).toEqual(VIEW);
    expect(store.updateLimits).toHaveBeenCalledExactlyOnceWith(LIMITS);
  });

  it("maps backend errors to fixed safe responses without filesystem paths, raw messages or credentials", async () => {
    await start();
    const { headers } = await signedIn();
    for (const [code, status] of [["ADMIN_CONFIG_BUSY", 409], ["ADMIN_CONFIG_CONFLICT", 409], ["ADMIN_CONFIG_STORAGE_UNAVAILABLE", 503], ["ADMIN_CONFIG_INVALID", 400], ["EACCES", 500]] as const) {
      store.updateProvider.mockRejectedValueOnce(Object.assign(new Error(`/secret/path ${TOKEN} ${SECRET}`), { code }));
      const response = await request("/models/providers/qwen", { method: "PUT", headers, body: JSON.stringify(UPDATE) });
      expect(response.status).toBe(status);
      privateHeaders(response);
      const text = await response.text();
      expect(text).not.toContain("/secret/path");
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(SECRET);
      expect(text).toContain(status === 500 ? "ADMIN_INTERNAL_ERROR" : code);
    }
  });

  it("requires CSRF for logout, revokes the session and expires the same-path cookie", async () => {
    await start();
    const { headers, cookie } = await signedIn();
    expect((await request("/session", { method: "DELETE", headers: { cookie, origin: ORIGIN } })).status).toBe(403);
    expect((await request("/session", { headers: { cookie } })).status).toBe(200);
    const response = await request("/session", { method: "DELETE", headers });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("set-cookie")).toContain(`${ADMIN_SESSION_COOKIE}=; Path=/api/v1/admin; HttpOnly; SameSite=Strict; Max-Age=0; Secure`);
    expect((await request("/models", { headers: { cookie } })).status).toBe(401);
    expect(store.view).not.toHaveBeenCalled();
  });

  it.each([{ authMissing: true }, { backendMissing: true }])("returns configuration-unavailable with no login cookie or backend access for %j", async (options) => {
    await start(options);
    for (const response of [await login(), await request("/session"), await request("/models")]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "ADMIN_NOT_CONFIGURED" } });
      expect(response.headers.get("set-cookie")).toBeNull();
      privateHeaders(response);
    }
    expect(store.view).not.toHaveBeenCalled();
  });

  it("bounds session memory and admits a new session when expired sessions have been removed", async () => {
    await start();
    for (let group = 0; group < 4; group += 1) {
      for (let i = 0; i < 5; i += 1) expect((await login()).status).toBe(200);
      now += 60_001;
    }
    const full = await login();
    expect(full.status).toBe(429);
    expect(await full.json()).toMatchObject({ error: { code: "ADMIN_SESSION_LIMIT" } });
    now += ADMIN_SESSION_DURATION_MS;
    expect((await login()).status).toBe(200);
  });

  it("rejects a previous API process session after a new auth instance starts", async () => {
    await start();
    const { cookie } = await signedIn();
    await app!.close();
    app = undefined;
    await start();
    expect((await request("/models", { headers: { cookie } })).status).toBe(401);
    expect(store.view).not.toHaveBeenCalled();
  });

  it("keeps parser failures non-cacheable and does not expose malformed JSON content", async () => {
    await start();
    const response = await request("/session", {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: `{"token":"${TOKEN}",bad-json`,
    });
    expect(response.status).toBe(400);
    privateHeaders(response);
    expect(await response.text()).not.toContain(TOKEN);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("admin auth configuration boundary", () => {
  it("allows insecure cookies only for explicitly configured loopback development origins", () => {
    for (const publicOrigin of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      const auth = new AdminAuth({ token: TOKEN, publicOrigin });
      expect(auth.login(TOKEN).cookie).not.toContain("Secure");
    }
    for (const publicOrigin of ["http://drama.example.test", "https://user:pass@drama.example.test", `${ORIGIN}/path`, `${ORIGIN}?secret=x`, "not-an-origin"]) {
      expect(() => new AdminAuth({ token: TOKEN, publicOrigin })).toThrow("管理员配置尚未就绪");
    }
  });

  it("rejects short, whitespace or unbounded administrator bootstrap tokens", () => {
    for (const token of ["x".repeat(31), "x".repeat(257), `${TOKEN} with spaces`]) {
      expect(() => new AdminAuth({ token, publicOrigin: ORIGIN })).toThrow("管理员配置尚未就绪");
    }
  });
});
