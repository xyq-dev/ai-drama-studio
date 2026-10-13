import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdminModelsView } from "@ai-drama/contracts";
import type { ApiEnv } from "../config/env";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import { AuthModule } from "../auth/auth.module";
import { hashPassword } from "../auth/password-hash";
import { SESSION_IDLE_MS, SiteAuth, type SiteAuthState } from "../auth/site-auth";
import { setAdminResponseHeaders } from "./admin-auth";
import type { AdminHeaderResponse } from "./admin-auth";
import { ADMIN_MODELS_SERVICE, AdminModelsController } from "./admin-models.controller";

// Test-only values. The console is reached through the site login; the old token must not open it.
const PASSWORD = "test-only-site-password-Qm7#x";
const LEGACY_TOKEN = "test-only-admin-bootstrap-7VCTEdmr_-84HqRZ";
const SECRET = "sk-test-never-echo-provider-key";
const ORIGIN = "https://drama.example.test";
let HASH = "";
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
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

beforeAll(async () => {
  HASH = await hashPassword(PASSWORD, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
});

describe("administrator model settings real HTTP boundary (site login)", () => {
  let app: INestApplication | undefined;
  let base: string;
  let now = Date.parse("2026-10-10T00:00:00Z");
  let store: ReturnType<typeof backend>;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    now = Date.parse("2026-10-10T00:00:00Z");
  });

  async function start(options: { site?: "enabled" | "disabled" | "misconfigured"; backendMissing?: boolean } = {}) {
    await app?.close();
    store = backend();
    const kind = options.site ?? "enabled";
    const state: SiteAuthState = kind === "enabled"
      ? { kind, auth: new SiteAuth({ username: "admin", passwordHash: HASH, publicOrigin: ORIGIN }, { now: () => now }) }
      : { kind };
    const module = await Test.createTestingModule({
      imports: [AuthModule.register({ NODE_ENV: "test" } as ApiEnv, state)],
      controllers: [AdminModelsController],
      providers: [{ provide: ADMIN_MODELS_SERVICE, useValue: options.backendMissing ? null : store }],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.use("/api/v1/admin", (_request: unknown, response: AdminHeaderResponse, next: () => void) => {
      setAdminResponseHeaders(response);
      next();
    });
    app.setGlobalPrefix("api/v1");
    app.useGlobalFilters(new SafeExceptionFilter());
    await app.listen(0, "127.0.0.1");
    base = `${await app.getUrl()}/api/v1`;
  }

  const request = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);

  async function signedIn() {
    const response = await request("/auth/login", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: PASSWORD }) });
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().filter((item) => /^__Host-ads_(session|csrf)=/.test(item))
      .map((item) => item.split(";", 1)[0]).join("; ");
    const view = await response.json() as { csrfToken: string };
    return { cookie, headers: { cookie, origin: ORIGIN, "content-type": "application/json", "x-csrf-token": view.csrfToken } };
  }

  it("requires the site session before every console read and write reaches the backend", async () => {
    await start();
    for (const [path, init] of [
      ["/admin/models", undefined],
      ["/admin/models/providers/qwen", { method: "PUT", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(UPDATE) }],
      ["/admin/models/limits", { method: "PUT", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(LIMITS) }],
    ] as const) {
      const response = await request(path, init);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "AUTH_REQUIRED" } });
    }
    expect(store.view).not.toHaveBeenCalled();
    expect(store.updateProvider).not.toHaveBeenCalled();
  });

  it("never opens with the old administrator token, and the token login routes are gone", async () => {
    await start();
    for (const init of [
      { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ token: LEGACY_TOKEN }) },
      { method: "GET", headers: { cookie: `ads_admin_session=${LEGACY_TOKEN}` } },
    ]) expect((await request("/admin/session", init)).status).toBe(401);
    const { headers } = await signedIn();
    // Even signed in, the earlier session routes no longer exist.
    expect((await request("/admin/session", { headers })).status).toBe(404);
    expect((await request("/admin/models", { headers: { authorization: `Bearer ${LEGACY_TOKEN}` } })).status).toBe(401);
    expect(store.view).not.toHaveBeenCalled();
  });

  it("serves the console view to a signed-in session with private headers", async () => {
    await start();
    const { cookie } = await signedIn();
    const response = await request("/admin/models", { headers: { cookie } });
    expect(response.status).toBe(200);
    privateHeaders(response);
    expect(await response.json()).toEqual(VIEW);
  });

  it("requires the exact origin, the session CSRF token and JSON on every console mutation", async () => {
    await start();
    const { headers, cookie } = await signedIn();
    for (const [changed, code] of [
      [{ ...headers, origin: "https://evil.example" }, "AUTH_ORIGIN_REJECTED"],
      [{ cookie, origin: ORIGIN, "content-type": "application/json" }, "AUTH_CSRF_REJECTED"],
      [{ ...headers, "x-csrf-token": "A".repeat(43) }, "AUTH_CSRF_REJECTED"],
      [{ ...headers, "content-type": "text/plain" }, "AUTH_CONTENT_TYPE_REJECTED"],
    ] as const) {
      const response = await request("/admin/models/limits", { method: "PUT", headers: changed, body: JSON.stringify(LIMITS) });
      expect(await response.json(), code).toMatchObject({ error: { code } });
    }
    expect(store.updateLimits).not.toHaveBeenCalled();
  });

  it("validates provider and limits DTOs before touching storage and never echoes submitted secrets", async () => {
    await start();
    const { headers } = await signedIn();
    for (const [path, body] of [
      ["/admin/models/providers/unknown", UPDATE],
      ["/admin/models/providers/qwen", { ...UPDATE, secretAction: "keep" }],
      ["/admin/models/providers/qwen", { ...UPDATE, models: ["https://secret.test/model"] }],
      ["/admin/models/limits", { ...LIMITS, maxActiveRuns: 0 }],
      ["/admin/models/limits", { ...LIMITS, apiKey: SECRET }],
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
    const provider = await request("/admin/models/providers/qwen", { method: "PUT", headers, body: JSON.stringify(UPDATE) });
    expect(provider.status).toBe(200);
    expect(await provider.json()).toEqual(VIEW);
    expect(store.updateProvider).toHaveBeenCalledExactlyOnceWith("qwen", UPDATE);
    const limits = await request("/admin/models/limits", { method: "PUT", headers, body: JSON.stringify(LIMITS) });
    expect(limits.status).toBe(200);
    expect(store.updateLimits).toHaveBeenCalledExactlyOnceWith(LIMITS);
  });

  it("maps backend errors to fixed safe responses without filesystem paths, raw messages or credentials", async () => {
    await start();
    const { headers } = await signedIn();
    for (const [code, status] of [["ADMIN_CONFIG_BUSY", 409], ["ADMIN_CONFIG_CONFLICT", 409], ["ADMIN_CONFIG_STORAGE_UNAVAILABLE", 503], ["ADMIN_CONFIG_INVALID", 400], ["EACCES", 500]] as const) {
      store.updateProvider.mockRejectedValueOnce(Object.assign(new Error(`/secret/path ${PASSWORD} ${SECRET}`), { code }));
      const response = await request("/admin/models/providers/qwen", { method: "PUT", headers, body: JSON.stringify(UPDATE) });
      expect(response.status).toBe(status);
      privateHeaders(response);
      const text = await response.text();
      expect(text).not.toContain("/secret/path");
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(SECRET);
      expect(text).toContain(status === 500 ? "ADMIN_INTERNAL_ERROR" : code);
    }
  });

  it("closes the console when the site session expires or is logged out", async () => {
    await start();
    const { cookie, headers } = await signedIn();
    now += SESSION_IDLE_MS;
    expect((await request("/admin/models", { headers: { cookie } })).status).toBe(401);
    await start();
    const second = await signedIn();
    expect((await request("/auth/logout", { method: "POST", headers: second.headers })).status).toBe(204);
    expect((await request("/admin/models", { headers: { cookie: second.cookie } })).status).toBe(401);
    expect((await request("/admin/models/limits", { method: "PUT", headers, body: JSON.stringify(LIMITS) })).status).toBe(401);
    expect(store.view).not.toHaveBeenCalled();
  });

  it("refuses (never opens anonymously) when the site login is off or misconfigured", async () => {
    await start({ site: "disabled" });
    const disabled = await request("/admin/models");
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toMatchObject({ error: { code: "ADMIN_NOT_CONFIGURED" } });
    await start({ site: "misconfigured" });
    const misconfigured = await request("/admin/models");
    expect(misconfigured.status).toBe(503);
    expect(await misconfigured.json()).toMatchObject({ error: { code: "AUTH_NOT_CONFIGURED" } });
    expect(store.view).not.toHaveBeenCalled();
  });

  it("returns configuration-unavailable to a signed-in session when the console is disabled", async () => {
    await start({ backendMissing: true });
    const { cookie } = await signedIn();
    const response = await request("/admin/models", { headers: { cookie } });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "ADMIN_NOT_CONFIGURED" } });
    privateHeaders(response);
  });

  it("rejects a previous API process session after a restart", async () => {
    await start();
    const { cookie } = await signedIn();
    await start();
    expect((await request("/admin/models", { headers: { cookie } })).status).toBe(401);
    expect(store.view).not.toHaveBeenCalled();
  });

  it("keeps parser failures non-cacheable and does not expose malformed JSON content", async () => {
    await start();
    const { headers } = await signedIn();
    const response = await request("/admin/models/limits", { method: "PUT", headers, body: `{"apiKey":"${SECRET}",bad-json` });
    expect(response.status).toBe(400);
    privateHeaders(response);
    expect(await response.text()).not.toContain(SECRET);
  });
});
