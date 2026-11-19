import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PersistenceError } from "@ai-drama/database";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import { hashPassword } from "../auth/password-hash";
import { SITE_AUTH, SiteAuth } from "../auth/site-auth";
import { AUTH_WORKSPACE_ID, CREATOR_ACCOUNT_STORE, CREATOR_PLAN_LEDGER_STORE } from "../auth/auth.tokens";
import { AuthController } from "../auth/auth.controller";
import { SiteAuthMiddleware } from "../auth/site-auth.middleware";
import { AdminCreatorsController } from "./admin-creators.controller";
import { setAdminResponseHeaders, type AdminHeaderResponse } from "./admin-auth";

const OPERATOR_PASSWORD = "test-only-site-password-Qm7#x";
const CREATOR_PASSWORD = "synthetic-creator-password-A1";
const ORIGIN = "https://drama.example.test";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
let OPERATOR_HASH = "";
let CREATOR_HASH = "";

beforeAll(async () => {
  OPERATOR_HASH = await hashPassword(OPERATOR_PASSWORD, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
  CREATOR_HASH = await hashPassword(CREATOR_PASSWORD, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
});

describe("operator creator provisioning API", () => {
  let app: INestApplication | undefined;
  let base: string;
  const created: Array<{ id: string; username: string; passwordHash: string }> = [];

  afterEach(async () => {
    await app?.close();
    app = undefined;
    created.length = 0;
  });

  async function start() {
    await app?.close();
    created.length = 0;
    const auth = new SiteAuth(
      { username: "admin", passwordHash: OPERATOR_HASH, publicOrigin: ORIGIN },
      {
        creators: {
          findActiveByUsername: async (username) => username === "creator-a"
            ? { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", username: "creator-a", passwordHash: CREATOR_HASH }
            : null,
        },
      },
    );
    const creators = {
      listActive: vi.fn(async () => created.map((row) => ({
        id: row.id,
        workspaceId: WORKSPACE,
        username: row.username,
        status: "ACTIVE" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }))),
      createActive: vi.fn(async (input: { username: string; passwordHash: string }) => {
        if (created.some((row) => row.username.toLowerCase() === input.username.toLowerCase())) {
          throw new PersistenceError("VALIDATION_ERROR", "账号已存在");
        }
        const row = {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          username: input.username,
          passwordHash: input.passwordHash,
        };
        created.push(row);
        return {
          id: row.id,
          workspaceId: WORKSPACE,
          username: row.username,
          status: "ACTIVE" as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }),
    };
    const plans = { ensureDefaultEntitlement: vi.fn(async () => undefined) };
    const module = await Test.createTestingModule({
      controllers: [AuthController, AdminCreatorsController],
      providers: [
        { provide: SITE_AUTH, useValue: { kind: "enabled" as const, auth } },
        { provide: CREATOR_ACCOUNT_STORE, useValue: creators },
        { provide: CREATOR_PLAN_LEDGER_STORE, useValue: plans },
        { provide: AUTH_WORKSPACE_ID, useValue: WORKSPACE },
        SiteAuthMiddleware,
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.use("/api/v1/admin", (_request: unknown, response: AdminHeaderResponse, next: () => void) => {
      setAdminResponseHeaders(response);
      next();
    });
    // Mirror AuthModule middleware for login + admin routes.
    const middleware = app.get(SiteAuthMiddleware);
    app.use((req: { method: string; originalUrl: string; headers: Record<string, string | string[] | undefined>; query?: Record<string, unknown> }, res: { statusCode: number; setHeader(name: string, value: string): void; end(body: string): void }, next: () => void) => {
      middleware.use(req, res, next);
    });
    app.setGlobalPrefix("api/v1");
    app.useGlobalFilters(new SafeExceptionFilter());
    await app.listen(0, "127.0.0.1");
    base = `${await app.getUrl()}/api/v1`;
  }

  async function login(username: string, password: string) {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ username, password }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { role: string; csrfToken: string };
    const cookie = response.headers.getSetCookie?.().map((value) => value.split(";", 1)[0]).join("; ")
      ?? [...response.headers.entries()].filter(([key]) => key.toLowerCase() === "set-cookie").map(([, value]) => value.split(";", 1)[0]).join("; ");
    return { cookie, csrf: body.csrfToken, role: body.role };
  }

  it("lets an operator provision a synthetic creator without echoing the password", async () => {
    await start();
    const session = await login("admin", OPERATOR_PASSWORD);
    expect(session.role).toBe("operator");
    const response = await fetch(`${base}/admin/creators`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
      },
      body: JSON.stringify({ username: "creator-b", password: CREATOR_PASSWORD }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ username: "creator-b", role: "creator", status: "ACTIVE" });
    expect(JSON.stringify(body)).not.toContain(CREATOR_PASSWORD);
    expect(JSON.stringify(body)).not.toMatch(/password/i);
    expect(created[0]?.passwordHash).toBeTruthy();
    expect(created[0]?.passwordHash).not.toBe(CREATOR_PASSWORD);

    const listed = await fetch(`${base}/admin/creators`, {
      headers: { cookie: session.cookie, accept: "application/json" },
    });
    expect(listed.status).toBe(200);
    const listBody = await listed.json() as { items: Array<{ username: string }> };
    expect(listBody.items.map((item) => item.username)).toContain("creator-b");
    expect(JSON.stringify(listBody)).not.toMatch(/password/i);
  });

  it("rejects a creator calling the provisioning API with opaque 401", async () => {
    await start();
    const session = await login("creator-a", CREATOR_PASSWORD);
    expect(session.role).toBe("creator");
    const response = await fetch(`${base}/admin/creators`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
      },
      body: JSON.stringify({ username: "creator-b", password: CREATOR_PASSWORD }),
    });
    expect(response.status).toBe(401);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe("AUTH_REQUIRED");
    expect(created).toHaveLength(0);
  });
});
