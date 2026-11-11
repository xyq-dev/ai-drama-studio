import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { StorageSettingsError } from "@ai-drama/database";
import type { ApiEnv } from "../config/env";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import { AuthModule } from "../auth/auth.module";
import { hashPassword } from "../auth/password-hash";
import { SiteAuth } from "../auth/site-auth";
import { setAdminResponseHeaders, type AdminHeaderResponse } from "./admin-auth";
import { STORAGE_SETTINGS_SERVICE, StorageSettingsController } from "./storage-settings.controller";
const ORIGIN = "https://drama.example.test", PASSWORD = "synthetic-password-7k@x", SECRET = "synthetic-secret-not-public";
const FIELDS = { provider: "oss", endpoint: "https://oss-cn-hangzhou.aliyuncs.com", region: "cn-hangzhou", bucket: "synthetic-bucket", prefix: "drama", forcePathStyle: false };
const VIEW = { revision: 0, active: { ...FIELDS, id: null, source: "environment", hasCredentials: true }, draft: null, managed: false, test: { status: "not_tested", testedAt: null, expiresAt: null } };
const UPDATE = { ...FIELDS, expectedRevision: 0, secretAction: "replace", accessKeyId: "synthetic-id", secretAccessKey: SECRET };
let HASH = "";
beforeAll(async () => { HASH = await hashPassword(PASSWORD, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 }); });
describe("storage settings authenticated HTTP boundary", () => {
  let app: INestApplication | undefined, base: string;
  let backend: { view: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn>; test: ReturnType<typeof vi.fn>; activate: ReturnType<typeof vi.fn> };
  afterEach(async () => { await app?.close(); });
  async function start(disabled = false) {
    backend = { view: vi.fn(async () => VIEW), save: vi.fn(async () => VIEW), test: vi.fn(async () => VIEW), activate: vi.fn(async () => VIEW) };
    const module = await Test.createTestingModule({ imports: [AuthModule.register({ NODE_ENV: "test" } as ApiEnv, disabled ? { kind: "disabled" } : { kind: "enabled", auth: new SiteAuth({ username: "admin", passwordHash: HASH, publicOrigin: ORIGIN }) })], controllers: [StorageSettingsController], providers: [{ provide: STORAGE_SETTINGS_SERVICE, useValue: backend }] }).compile();
    app = module.createNestApplication({ logger: false });
    app.use("/api/v1/admin", (_request: unknown, response: AdminHeaderResponse, next: () => void) => { setAdminResponseHeaders(response); next(); });
    app.setGlobalPrefix("api/v1"); app.useGlobalFilters(new SafeExceptionFilter()); await app.listen(0, "127.0.0.1"); base = `${await app.getUrl()}/api/v1`;
  }
  const request = (path: string, init?: RequestInit) => fetch(base + path, init);
  async function login() {
    const result = await request("/auth/login", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: PASSWORD }) });
    const cookie = result.headers.getSetCookie().map(v => v.split(";", 1)[0]).join("; "), view = await result.json() as { csrfToken: string };
    return { cookie, origin: ORIGIN, "content-type": "application/json", "x-csrf-token": view.csrfToken };
  }
  it("requires login on all routes and never opens when site login is disabled", async () => {
    await start();
    for (const [path, method] of [["", "GET"], ["/draft", "PUT"], ["/test", "POST"], ["/activate", "POST"]]) expect((await request("/admin/storage" + path, { method, headers: { origin: ORIGIN, "content-type": "application/json" } })).status).toBe(401);
    expect(backend.view).not.toHaveBeenCalled(); await app!.close(); await start(true);
    expect((await request("/admin/storage")).status).toBe(503); expect(backend.view).not.toHaveBeenCalled();
  });
  it("enforces origin, CSRF, JSON and explicit probe consent before calling storage", async () => {
    await start(); const headers = await login();
    for (const changed of [{ ...headers, origin: "https://evil.example" }, { ...headers, "x-csrf-token": "wrong" }, { ...headers, "content-type": "text/plain" }]) {
      const response = await request("/admin/storage/draft", { method: "PUT", headers: changed, body: JSON.stringify(UPDATE) }); expect(response.status).toBeGreaterThanOrEqual(400);
    }
    for (const body of [{ expectedRevision: 0 }, { expectedRevision: 0, confirmProbe: false }, { expectedRevision: 0, confirmProbe: true, secretAccessKey: SECRET }]) expect((await request("/admin/storage/test", { method: "POST", headers, body: JSON.stringify(body) })).status).toBe(400);
    expect(backend.save).not.toHaveBeenCalled(); expect(backend.test).not.toHaveBeenCalled();
  });
  it("saves/tests/activates through distinct endpoints with no-store public views", async () => {
    await start(); const headers = await login();
    for (const [path, method, body] of [["/draft", "PUT", UPDATE], ["/test", "POST", { expectedRevision: 0, confirmProbe: true }], ["/activate", "POST", { expectedRevision: 0 }]] as const) {
      const response = await request("/admin/storage" + path, { method, headers, body: JSON.stringify(body) }); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(await response.json()).toEqual(VIEW);
    }
    expect(backend.save).toHaveBeenCalledExactlyOnceWith(UPDATE); expect(backend.test).toHaveBeenCalledExactlyOnceWith(0); expect(backend.activate).toHaveBeenCalledExactlyOnceWith(0);
  });
  it("redacts errors, malformed JSON and accidental secret-bearing response objects", async () => {
    await start(); const headers = await login();
    backend.save.mockRejectedValueOnce(new Error(SECRET));
    const failure = await request("/admin/storage/draft", { method: "PUT", headers, body: JSON.stringify(UPDATE) }); expect(failure.status).toBe(503); expect(await failure.text()).not.toContain(SECRET);
    backend.save.mockRejectedValueOnce(new StorageSettingsError(409, "STORAGE_SETTINGS_CONFLICT"));
    expect((await request("/admin/storage/draft", { method: "PUT", headers, body: JSON.stringify(UPDATE) })).status).toBe(409);
    const malformed = await request("/admin/storage/draft", { method: "PUT", headers, body: `{"secretAccessKey":"${SECRET}",bad` }); expect(malformed.status).toBe(400); expect(await malformed.text()).not.toContain(SECRET);
    backend.view.mockResolvedValueOnce({ ...VIEW, secretAccessKey: SECRET }); const leak = await request("/admin/storage", { headers }); expect(leak.status).toBe(503); expect(await leak.text()).not.toContain(SECRET);
  });
});
