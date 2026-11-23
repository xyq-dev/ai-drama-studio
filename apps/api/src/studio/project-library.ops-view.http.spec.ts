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
import { ScriptWorkbenchController, SCRIPT_WORKBENCH_SERVICE } from "./script-workbench.controller";
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

  const creatorBin = {
    snapshot: () => ({ owner: storeOwnerAccountFilter() }),
    previewProject: vi.fn(), listTrash: vi.fn(), restoreProject: vi.fn(), trashProject: vi.fn(() => ({ owner: storeOwnerAccountFilter() })),
  };

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
      controllers: [ProjectLibraryController, ScriptWorkbenchController],
      providers: [{
        provide: PROJECT_LIBRARY_SERVICE,
        useValue: new ProjectLibraryService({
          list: storeList,
          createCategory: vi.fn(),
          assignCategory: vi.fn(),
        }, WORKSPACE),
      }, { provide: SCRIPT_WORKBENCH_SERVICE, useValue: creatorBin }],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalFilters(new SafeExceptionFilter());
    await app.listen(0, "127.0.0.1");
    base = `${await app.getUrl()}/api/v1`;
    return auth;
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

  it("limits a bound staff operations view to the authorized list and keeps shared legacy recycling on audited routes", async () => {
    const auth = await start();
    const staffId = "00000000-0000-4000-8000-000000000092";
    auth.setStaffDirectory({
      findByUsername: async username => username === "staff" ? {
        id: staffId, username, passwordHash: HASH, status: "active", permissions: [], totpEnabled: false,
      } : null,
      recordLogin: async () => {}, verifySecondFactor: async () => false,
    });
    const cookie = await login("staff", PASSWORD);
    const get = (path: string) => fetch(base + path, { headers: { cookie } });
    expect(await (await get("/account/ops-access")).json()).toMatchObject({ opsViewAvailable: false });
    expect((await (await get("/library/projects?view=ops")).json()).items).toHaveLength(1);
    auth.syncStaff(staffId, { status: "active", permissions: ["review_works", "manage_works"] });
    expect(await (await get("/account/ops-access")).json()).toMatchObject({ opsViewAvailable: true });
    expect((await (await get("/library/projects?view=ops")).json()).items).toHaveLength(3);
    const path = "/projects/" + LEGACY_PROJECT + "/script-workbench";
    expect(await (await get(path + "?view=ops")).json()).toEqual({ owner: LEGACY_OWNER_ACCOUNT_ID });
    expect((await get("/script-workbench/trash?view=ops")).status).toBe(403);
    expect((await get(path + "/deletion-preview")).status).toBe(403);
    const write = (route: string, sessionCookie: string) => fetch(base + route, {
      method: "POST", headers: { origin: ORIGIN, cookie: sessionCookie, "x-csrf-token": auth.peek({ cookie: sessionCookie }).csrfToken },
    });
    expect((await write(path + "/trash?view=ops", cookie)).status).toBe(403);
    expect((await write(path + "/restore", cookie)).status).toBe(403);
    expect(creatorBin.listTrash).not.toHaveBeenCalled();
    expect(creatorBin.previewProject).not.toHaveBeenCalled();
    expect(creatorBin.trashProject).not.toHaveBeenCalled();
    expect(creatorBin.restoreProject).not.toHaveBeenCalled();
    const alice = await login("alice", "alice-fixture-password");
    const ownTrash = await write("/projects/" + ALICE_PROJECT + "/script-workbench/trash?view=ops", alice);
    expect(ownTrash.status).toBe(201);
    expect(await ownTrash.json()).toEqual({ owner: ALICE });
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
