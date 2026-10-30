import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiEnv } from "../config/env";
import { AuthModule } from "../auth/auth.module";
import { hashPassword } from "../auth/password-hash";
import { SiteAuth } from "../auth/site-auth";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import { VIMAX_PREVIEW_SERVICE } from "./tokens";
import { VimaxPreviewController } from "./vimax-preview.controller";

const PASSWORD = "test-only-preview-password-Qm7#x";
const ORIGIN = "https://preview.example.test";
const BASE = "/projects/11111111-1111-4111-8111-111111111111/episodes/22222222-2222-4222-8222-222222222222/vimax-preview";

describe("ViMax preview HTTP uses existing site login, CSRF and JSON body limit", () => {
  let app: INestApplication;
  let url: string;
  let cookie: string;
  let csrf: string;
  const preview = vi.fn(async () => ({ status: 200, body: { persisted: false, modelCalls: 0 } }));
  const source = vi.fn(async () => ({ status: 200, body: { schema: "source-test" } }));
  beforeAll(async () => {
    const passwordHash = await hashPassword(PASSWORD, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
    const module = await Test.createTestingModule({
      imports: [AuthModule.register({ NODE_ENV: "test" } as ApiEnv,
        { kind: "enabled", auth: new SiteAuth({ username: "admin", passwordHash, publicOrigin: ORIGIN }) })],
      controllers: [VimaxPreviewController],
      providers: [{ provide: VIMAX_PREVIEW_SERVICE, useValue: { preview, source } }],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix("api/v1");
    (app as unknown as { useBodyParser(type: "json", options: { limit: string }): void }).useBodyParser("json", { limit: "300kb" });
    app.useGlobalFilters(new SafeExceptionFilter());
    await app.listen(0, "127.0.0.1");
    url = `${await app.getUrl()}/api/v1`;
    const signedIn = await fetch(`${url}/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: PASSWORD }) });
    expect(signedIn.status).toBe(200);
    cookie = signedIn.headers.getSetCookie().map((item) => item.split(";", 1)[0]).join("; ");
    csrf = (await signedIn.json() as { csrfToken: string }).csrfToken;
  });
  afterAll(async () => { await app.close(); });

  it("requires a site session on both source and preview routes", async () => {
    expect((await fetch(`${url}${BASE}/source`)).status).toBe(401);
    expect((await fetch(`${url}${BASE}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect(source).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  it("returns private source data only to a signed-in site session", async () => {
    const response = await fetch(`${url}${BASE}/source`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ schema: "source-test" });
  });

  it("keeps CSRF and origin checks on the POST despite having no business write", async () => {
    const before = preview.mock.calls.length;
    expect((await fetch(`${url}${BASE}`, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await fetch(`${url}${BASE}`, { method: "POST", headers: { cookie, origin: "https://other.test", "x-csrf-token": csrf,
      "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect(preview).toHaveBeenCalledTimes(before);
    const response = await fetch(`${url}${BASE}`, { method: "POST", headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf,
      "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ modelCalls: 0, persisted: false });
  });

  it("rejects malformed route parameters and oversized JSON before reaching the preview service", async () => {
    const before = preview.mock.calls.length;
    const sourceBefore = source.mock.calls.length;
    const headers = { cookie, origin: ORIGIN, "x-csrf-token": csrf, "content-type": "application/json" };
    expect((await fetch(`${url}${BASE.replace("11111111-1111-4111-8111-111111111111", "not-a-uuid")}`, { method: "POST", headers, body: "{}" })).status).toBe(400);
    const oversized = await fetch(`${url}${BASE}`, { method: "POST", headers,
      body: JSON.stringify({ value: "SECRET-REQUEST-TEXT" + "a".repeat(300 * 1024) }) });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: { code: "REQUEST_BODY_TOO_LARGE", message: "请求内容超过大小上限。", traceId: "api" } });
    expect(preview).toHaveBeenCalledTimes(before);
    expect(source).toHaveBeenCalledTimes(sourceBefore);
  });
});
