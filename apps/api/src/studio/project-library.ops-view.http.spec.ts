import "reflect-metadata";
import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LEGACY_OWNER_ACCOUNT_ID } from "@ai-drama/domain";
import { storeOwnerAccountFilter, type ProjectLibraryPage } from "@ai-drama/database";
import type { ApiEnv } from "../config/env";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import { AuthModule } from "../auth/auth.module";
import { hashPassword } from "../auth/password-hash";
import { SiteAuth, type CreatorLoginDirectory } from "../auth/site-auth";
import { PROJECT_LIBRARY_SERVICE, ProjectLibraryController } from "./project-library.controller";
import { ProjectLibraryService } from "./project-library.service";

const ORIGIN = "https://drama.example.test";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OPERATOR = "admin";
const PASSWORD = "test-only-site-password-Qm7#x";
const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALICE_PROJECT = "11111111-1111-4111-8111-111111111101";
const BOB_PROJECT = "11111111-1111-4111-8111-111111111102";
const LEGACY_PROJECT = "11111111-1111-4111-8111-111111111103";

const ownedBy = new Map<string, string>([
  [ALICE_PROJECT, ALICE],
  [BOB_PROJECT, BOB],
  [LEGACY_PROJECT, LEGACY_OWNER_ACCOUNT_ID],
]);

let HASH = "";
let ALICE_HASH = "";

function emptyPage(items: Array<{ id: string }>): ProjectLibraryPage {
  return {
    items: items.map((item) => ({
      id: item.id, title: item.id, premise: "", createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z", categoryId: null, categoryName: null, categoryRevision: 0,
      thumbnailAssetId: null, thumbnailUrl: null, episodeCount: 0, writingMode: "manual",
      script: { title: null, source: "unknown", providerKey: null, model: null, destination: null },
    })),
    nextCursor: null, total: items.length, allCount: items.length, unclassifiedCount: items.length,
    categories: [], categoriesReady: true,
  };
}

describe("library projects ops view (DEF-01)", () => {
  let app: INestApplication | undefined;
  let base = "";
  const storeList = vi.fn(async (_workspaceId: string, query: Record<string, unknown>) => {
    expect(query).not.toHaveProperty("view");
    const owner = storeOwnerAccountFilter();
    const items = [...ownedBy.entries()]
      .filter(([, accountId]) => !owner || accountId === owner)
      .map(([id]) => ({ id }));
    return emptyPage(items);
  });

  beforeAll(async () => {
    HASH = await hashPassword(PASSWORD, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
    ALICE_HASH = await hashPassword("alice-fixture-password", { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
  });

  afterEach(async () => {
    storeList.mockClear();
    await app?.close();
    app = undefined;
  });

  async function start() {
    const creators: CreatorLoginDirectory = {
      findActiveByUsername: async (username) => username === "alice"
        ? { id: ALICE, username: "alice", passwordHash: ALICE_HASH }
        : null,
    };
    const auth = new SiteAuth(
      { username: OPERATOR, passwordHash: HASH, publicOrigin: ORIGIN },
      { creators, publicRegistrationEnabled: false },
    );
    const module = await Test.createTestingModule({
      imports: [AuthModule.register(
        { NODE_ENV: "test", APP_WORKSPACE_ID: WORKSPACE } as ApiEnv,
        { kind: "enabled", auth },
      )],
      controllers: [ProjectLibraryController],
      providers: [{
        provide: PROJECT_LIBRARY_SERVICE,
        useValue: new ProjectLibraryService({
          list: storeList,
          createCategory: vi.fn(),
          assignCategory: vi.fn(),
        }, WORKSPACE),
      }],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalFilters(new SafeExceptionFilter());
    await app.listen(0, "127.0.0.1");
    base = `${await app.getUrl()}/api/v1`;
  }

  async function login(username: string, password: string) {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().find((item) => item.startsWith("__Host-ads_session="))!.split(";", 1)[0]!;
    return cookie;
  }

  it("operator + view=ops lists works across owners and does not 400", async () => {
    await start();
    const cookie = await login(OPERATOR, PASSWORD);
    const response = await fetch(`${base}/library/projects?view=ops`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ id: string }> };
    expect(body.items.map((item) => item.id).sort()).toEqual(
      [ALICE_PROJECT, BOB_PROJECT, LEGACY_PROJECT].sort(),
    );
    expect(storeList).toHaveBeenCalled();
    expect(storeList.mock.calls[0]?.[1]).not.toHaveProperty("view");
  });

  it("operator without view=ops keeps 我的作品 ownership filter", async () => {
    await start();
    const cookie = await login(OPERATOR, PASSWORD);
    const response = await fetch(`${base}/library/projects`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ id: string }> };
    expect(body.items.map((item) => item.id)).toEqual([LEGACY_PROJECT]);
  });

  it("creator + view=ops still cannot see others' works", async () => {
    await start();
    const cookie = await login("alice", "alice-fixture-password");
    const withOps = await fetch(`${base}/library/projects?view=ops`, { headers: { cookie } });
    expect(withOps.status).toBe(200);
    const opsBody = await withOps.json() as { items: Array<{ id: string }> };
    expect(opsBody.items.map((item) => item.id)).toEqual([ALICE_PROJECT]);
    expect(opsBody.items.map((item) => item.id)).not.toContain(BOB_PROJECT);
    expect(opsBody.items.map((item) => item.id)).not.toContain(LEGACY_PROJECT);

    const without = await fetch(`${base}/library/projects`, { headers: { cookie } });
    expect(without.status).toBe(200);
    const plain = await without.json() as { items: Array<{ id: string }> };
    expect(plain.items.map((item) => item.id)).toEqual([ALICE_PROJECT]);
  });

  it("rejects invalid library query fields with the same validation error", async () => {
    await start();
    const cookie = await login(OPERATOR, PASSWORD);
    const response = await fetch(`${base}/library/projects?view=ops&limit=2000`, { headers: { cookie } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR", message: "作品查询参数无效。" },
    });
    expect(storeList).not.toHaveBeenCalled();
  });
});
