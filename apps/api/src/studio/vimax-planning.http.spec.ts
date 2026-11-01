import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiEnv } from "../config/env";
import { AuthModule } from "../auth/auth.module";
import { hashPassword } from "../auth/password-hash";
import { SiteAuth } from "../auth/site-auth";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import { VIMAX_PLANNING_SERVICE, VimaxPlanningController } from "./vimax-planning.controller";
const PASSWORD = "test-only-planning-password-Qm7#x", ORIGIN = "https://planning.example.test";
const P = "11111111-1111-4111-8111-111111111111", E = "22222222-2222-4222-8222-222222222222", ID = "33333333-3333-4333-8333-333333333333";
const BASE = `/projects/${P}/episodes/${E}/vimax-planning`;
describe("ViMax planning HTTP session and send boundary", () => {
  let app: INestApplication, url: string, cookie: string, csrf: string;
  const start = vi.fn(async () => ({ status: 202, body: { reserved: true } }));
  const cancel = vi.fn(async () => ({ status: 200, body: { canceled: true } }));
  const list = vi.fn(async () => ({ status: 200, body: { items: [] } }));
  const options = vi.fn(async () => ({ status: 200, body: { enabled: true } }));
  beforeAll(async () => {
    const passwordHash = await hashPassword(PASSWORD, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
    const module = await Test.createTestingModule({
      imports: [AuthModule.register({ NODE_ENV: "test" } as ApiEnv,
        { kind: "enabled", auth: new SiteAuth({ username: "admin", passwordHash, publicOrigin: ORIGIN }) })],
      controllers: [VimaxPlanningController], providers: [{ provide: VIMAX_PLANNING_SERVICE, useValue: { start, cancel, list, options } }],
    }).compile();
    app = module.createNestApplication({ logger: false }); app.setGlobalPrefix("api/v1");
    (app as unknown as { useBodyParser(type: "json", options: { limit: string }): void }).useBodyParser("json", { limit: "300kb" });
    app.useGlobalFilters(new SafeExceptionFilter()); await app.listen(0, "127.0.0.1"); url = `${await app.getUrl()}/api/v1`;
    const signedIn = await fetch(`${url}/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: PASSWORD }) });
    expect(signedIn.status).toBe(200); cookie = signedIn.headers.getSetCookie().map((v) => v.split(";", 1)[0]).join("; ");
    csrf = (await signedIn.json() as { csrfToken: string }).csrfToken;
  });
  afterAll(async () => { await app.close(); });
  it("requires login for reads and POST requests without invoking a planner", async () => {
    expect((await fetch(`${url}${BASE}/requests`)).status).toBe(401);
    expect((await fetch(`${url}${BASE}/requests`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect(list).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });
  it("reads history privately and never schedules a send", async () => {
    const r = await fetch(`${url}${BASE}/requests`, { headers: { cookie } }); expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toContain("no-store"); expect(list).toHaveBeenCalledWith(P, E, "server-owner"); expect(start).not.toHaveBeenCalled();
  });
  it("keeps CSRF on start and cancel and passes only verified session proof to the service", async () => {
    const headers = { cookie, origin: ORIGIN, "content-type": "application/json", "idempotency-key": "original-key", "x-trace-id": "planning-trace" };
    expect((await fetch(`${url}${BASE}/requests`, { method: "POST", headers, body: "{}" })).status).toBe(403);
    expect((await fetch(`${url}${BASE}/requests/${ID}/cancel`, { method: "POST", headers, body: "{}" })).status).toBe(403);
    expect(start).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
    const r = await fetch(`${url}${BASE}/requests`, { method: "POST", headers: { ...headers, "x-csrf-token": csrf }, body: "{}" });
    expect(r.status).toBe(202); expect(start).toHaveBeenCalledWith(P, E, {}, { session: true, token: undefined },
      { actorId: "server-owner", traceId: "planning-trace", idempotencyKey: "original-key" });
  });
  it("rejects malformed scope and oversized body before the service", async () => {
    const before = start.mock.calls.length, headers = { cookie, origin: ORIGIN, "content-type": "application/json", "x-csrf-token": csrf };
    expect((await fetch(`${url}${BASE.replace(P, "invalid")}/requests`, { method: "POST", headers, body: "{}" })).status).toBe(400);
    expect((await fetch(`${url}${BASE}/requests`, { method: "POST", headers, body: JSON.stringify({ x: "a".repeat(301 * 1024) }) })).status).toBe(413);
    expect(start).toHaveBeenCalledTimes(before);
  });
});
