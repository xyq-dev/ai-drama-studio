import "reflect-metadata";
import { Controller, Get, Module, Post, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadApiEnv } from "../config/env";
import { AuthModule } from "./auth.module";
import { hashPassword } from "./password-hash";

/**
 * S1 regression: the login switch as an operator actually sets it, through the real loadApiEnv → AuthModule → HTTP.
 * An explicitly empty SITE_AUTH_ENABLED must refuse access, never fall back to an open site.
 */
const PASSWORD = "test-only-site-password-Qm7#x";
const ORIGIN = "https://drama.example.test";
const BASE = {
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:55432/unused",
  REDIS_URL: "redis://127.0.0.1:56379", S3_ENDPOINT: "http://127.0.0.1:59000", S3_REGION: "us-east-1",
  S3_BUCKET: "test", S3_ACCESS_KEY_ID: "unused", S3_SECRET_ACCESS_KEY: "unused",
  APP_WORKSPACE_ID: "11111111-1111-4111-8111-111111111111",
};
let HASH = "";
const reached: string[] = [];

class Projects { list() { reached.push("list"); return { items: [] }; } create() { reached.push("create"); return { id: "p1" }; } }
Get("projects")(Projects.prototype, "list", Object.getOwnPropertyDescriptor(Projects.prototype, "list")!);
Post("projects")(Projects.prototype, "create", Object.getOwnPropertyDescriptor(Projects.prototype, "create")!);
Controller()(Projects);

beforeAll(async () => {
  HASH = await hashPassword(PASSWORD, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
});

describe("SITE_AUTH_ENABLED from the process environment, end to end", () => {
  let app: INestApplication | undefined;
  let base = "";

  afterEach(async () => {
    await app?.close();
    app = undefined;
    reached.length = 0;
  });

  async function start(processEnv: Record<string, string | undefined>) {
    const env = loadApiEnv({ ...BASE, ...processEnv });
    class Routes {}
    Module({ controllers: [Projects] })(Routes);
    const module = await Test.createTestingModule({ imports: [AuthModule.register(env), Routes] }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix("api/v1");
    await app.listen(0, "127.0.0.1");
    base = `${await app.getUrl()}/api/v1`;
  }

  const anonymousRead = () => fetch(`${base}/projects`);
  const anonymousWrite = () => fetch(`${base}/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const complete = () => ({ SITE_AUTH_PASSWORD_HASH: HASH, SITE_AUTH_PUBLIC_ORIGIN: ORIGIN });

  it.each([
    ["an explicitly empty value", ""],
    ["an invalid value", "yes"],
    ["an upper-case TRUE", "TRUE"],
  ])("refuses every request for %s, without reaching a controller", async (_label, value) => {
    await start({ SITE_AUTH_ENABLED: value, ...complete() });
    for (const response of [await anonymousRead(), await anonymousWrite()]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "AUTH_NOT_CONFIGURED" } });
    }
    expect(reached).toEqual([]);
  });

  it("refuses everything when switched on without a password hash or an origin", async () => {
    for (const missing of [{ SITE_AUTH_PUBLIC_ORIGIN: ORIGIN }, { SITE_AUTH_PASSWORD_HASH: HASH }, { SITE_AUTH_PASSWORD_HASH: "", SITE_AUTH_PUBLIC_ORIGIN: ORIGIN }]) {
      await start({ SITE_AUTH_ENABLED: "true", ...missing });
      expect((await anonymousRead()).status).toBe(503);
      expect((await anonymousWrite()).status).toBe(503);
      await app!.close();
      app = undefined;
    }
    expect(reached).toEqual([]);
  });

  it("requires the login when switched on with a complete configuration", async () => {
    await start({ SITE_AUTH_ENABLED: "true", ...complete() });
    expect((await anonymousRead()).status).toBe(401);
    // Origin is checked before the session on writes: refused either way, and no controller runs.
    expect((await anonymousWrite()).status).toBe(403);
    expect(reached).toEqual([]);
    const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: PASSWORD }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().map((item) => item.split(";", 1)[0]).join("; ");
    expect((await fetch(`${base}/projects`, { headers: { cookie } })).status).toBe(200);
    expect(reached).toEqual(["list"]);
  });

  it.each([
    ["explicitly false", { SITE_AUTH_ENABLED: "false" }],
    ["not set", {}],
  ])("keeps the earlier open behaviour when %s (protection stays in front of the app)", async (_label, setting) => {
    await start({ ...setting, ...complete() });
    expect((await anonymousRead()).status).toBe(200);
    expect((await anonymousWrite()).status).toBe(201);
    expect(reached).toEqual(["list", "create"]);
  });

  it("does not change how other process-only variables treat an empty value", () => {
    const env = loadApiEnv({ ...BASE, SITE_AUTH_ENABLED: "", SITE_AUTH_PASSWORD_HASH: "", MODEL_ADMIN_ENABLED: "", DASHSCOPE_API_KEY: "" });
    expect(env.SITE_AUTH_ENABLED).toBe("");
    expect(env.SITE_AUTH_PASSWORD_HASH).toBeUndefined();
    expect(env.MODEL_ADMIN_ENABLED).toBeUndefined();
    expect(env.DASHSCOPE_API_KEY).toBeUndefined();
  });

  it("ignores the switch in the .env file (process environment only)", () => {
    const env = loadApiEnv({ ...BASE }, { SITE_AUTH_ENABLED: "" });
    expect(env.SITE_AUTH_ENABLED).toBeUndefined();
  });
});
