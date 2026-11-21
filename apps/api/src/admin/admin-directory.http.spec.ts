import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { hashPassword } from "../auth/password-hash";
import { AUTH_WORKSPACE_ID } from "../auth/auth.tokens";
import { SITE_AUTH, SiteAuth } from "../auth/site-auth";
import { AuthController } from "../auth/auth.controller";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import { ADMIN_DIRECTORY_SERVICE, AdminDirectoryController } from "./admin-directory.controller";
import { AdminDirectoryService } from "./admin-directory.service";
import type { AdminOpsStore, JobSignalRow } from "@ai-drama/database";

const OPERATOR_PASSWORD = "test-only-site-password-Qm7#x";
const CREATOR_PASSWORD = "synthetic-creator-password-A1";
const ORIGIN = "https://drama.example.test";
const JOB_ID = "00000000-0000-4000-8000-000000002169";
let OPERATOR_HASH = "";
let CREATOR_HASH = "";

beforeAll(async () => {
  OPERATOR_HASH = await hashPassword(OPERATOR_PASSWORD, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
  CREATOR_HASH = await hashPassword(CREATOR_PASSWORD, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
});

function row(overrides: Partial<JobSignalRow> = {}): JobSignalRow {
  return {
    id: JOB_ID,
    code: "JOB-2169",
    source: "generation",
    kind: "MEDIA_IMAGE",
    state: "FAILED",
    errorCode: "LEASE_EXPIRED",
    updatedAt: "2026-11-21T10:16:41.000Z",
    projectTitle: "旧巷灯火",
    episodeNo: 2,
    ...overrides,
  };
}

it("keeps directory APIs operator-only and does not retry without confirmation", async () => {
  const retry = vi.fn(async () => ({ id: "queued" }));
  let current = row();
  const store = {
    listWorks: vi.fn(async () => ({ items: [], total: 0, nextCursor: null, owners: [] })),
    getJob: vi.fn(async () => current),
  };
  const directory = new AdminDirectoryService({
    store: store as unknown as AdminOpsStore,
    creators: {
      listManaged: async () => [],
      setStatus: async (_workspace: string, id: string, status: "ACTIVE" | "DISABLED") => ({ id, username: "creator-a", status }),
    } as never,
    workspaceId: "11111111-1111-4111-8111-111111111111",
    logs: null,
    retry,
    readContent: vi.fn(),
    revokeSessions: (accountId) => auth.revokeAccount(accountId),
  });
  const auth = new SiteAuth(
    { username: "admin", passwordHash: OPERATOR_HASH, publicOrigin: ORIGIN },
    { creators: { findActiveByUsername: async (username) => username === "creator-a" ? { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", username: "creator-a", passwordHash: CREATOR_HASH } : null } },
  );
  const module = await Test.createTestingModule({
    controllers: [AuthController, AdminDirectoryController],
    providers: [
      { provide: SITE_AUTH, useValue: { kind: "enabled" as const, auth } },
      { provide: AUTH_WORKSPACE_ID, useValue: "11111111-1111-4111-8111-111111111111" },
      { provide: ADMIN_DIRECTORY_SERVICE, useValue: directory },
    ],
  }).compile();
  const app: INestApplication = module.createNestApplication({ logger: false });
  app.setGlobalPrefix("api/v1");
  app.useGlobalFilters(new SafeExceptionFilter());
  await app.listen(0, "127.0.0.1");
  try {
    const base = `${await app.getUrl()}/api/v1`;
    const login = async (username: string, password: string) => {
      const response = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ username, password }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { role: string; csrfToken: string };
      const cookie = response.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
      return { cookie, csrf: body.csrfToken, role: body.role };
    };
    const creator = await login("creator-a", CREATOR_PASSWORD);
    const denied = await fetch(`${base}/admin/works`, { headers: { cookie: creator.cookie, accept: "application/json" } });
    expect(denied.status).toBe(401);
    expect((await denied.json() as { error: { code: string } }).error.code).toBe("AUTH_REQUIRED");
    expect(store.listWorks).not.toHaveBeenCalled();

    const operator = await login("admin", OPERATOR_PASSWORD);
    const post = (body: unknown, key?: string) => fetch(`${base}/admin/jobs/${JOB_ID}/retry`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: operator.cookie,
        "x-csrf-token": operator.csrf,
        ...(key ? { "idempotency-key": key } : {}),
      },
      body: JSON.stringify(body),
    });
    const unconfirmed = await post({ confirmed: false }, "idem-key-unconfirmed");
    expect(unconfirmed.status).toBe(400);
    expect(retry).not.toHaveBeenCalled();

    current = row({ errorCode: "MOCK_REQUEST_UNKNOWN" });
    const unknown = await post({ confirmed: true }, "idem-key-unknown");
    expect(unknown.status).toBe(409);
    expect((await unknown.json() as { error: { code: string } }).error.code).toBe("UNKNOWN_OUTCOME");
    expect(retry).not.toHaveBeenCalled();

    current = row();
    const confirmed = await post({ confirmed: true }, "idem-key-confirmed");
    expect(confirmed.status).toBe(200);
    expect(retry).toHaveBeenCalledOnce();
    expect(JSON.stringify(await confirmed.json())).not.toMatch(/sk-[A-Za-z0-9]{8,}/);

    const disabled = await fetch(`${base}/admin/users/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/status`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: operator.cookie,
        "x-csrf-token": operator.csrf,
      },
      body: JSON.stringify({ confirmed: true, status: "DISABLED" }),
    });
    expect(disabled.status).toBe(200);
    const expired = await fetch(`${base}/auth/session`, { headers: { cookie: creator.cookie, accept: "application/json" } });
    expect(expired.status).toBe(401);
    const stillOperator = await fetch(`${base}/admin/works`, { headers: { cookie: operator.cookie, accept: "application/json" } });
    expect(stillOperator.status).toBe(200);
  } finally {
    await app.close();
  }
});

afterEach(() => undefined);
