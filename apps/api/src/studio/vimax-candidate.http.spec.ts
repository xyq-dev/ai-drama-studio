import "reflect-metadata";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  vimaxCandidateCreateSchema,
  type VimaxCandidateCreateResponse,
  type VimaxCandidatePage,
  type VimaxCandidateTargets,
  type VimaxCandidateView,
  type VimaxCandidateWriteResponse,
} from "@ai-drama/contracts";
import { PersistenceError } from "@ai-drama/database";
import type { ApiEnv } from "../config/env";
import { AuthModule } from "../auth/auth.module";
import { hashPassword } from "../auth/password-hash";
import { SiteAuth } from "../auth/site-auth";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import { VIMAX_CANDIDATE_SERVICE } from "./tokens";
import { VimaxCandidateController } from "./vimax-candidate.controller";
import { VimaxCandidateService, type VimaxCandidateDependencies } from "./vimax-candidate.service";

const W = "11111111-1111-4111-8111-111111111111";
const P = "22222222-2222-4222-8222-222222222222";
const E = "33333333-3333-4333-8333-333333333333";
const C = "44444444-4444-4444-8444-444444444444";
const BASE = `/projects/${P}/episodes/${E}/vimax-candidates`;
const PASSWORD = "test-only-candidate-password-Tq8#x";
const ORIGIN = "https://candidate.example.test";
const saveBody = { schema: "ads.vimax-candidate.save-scene.v1", expectedVersion: 1, confirmedReview: true };
const shotsBody = { schema: "ads.vimax-candidate.place-shots.v1", expectedVersion: 2, confirmedReview: true };
const raw = JSON.parse(readFileSync(resolve(__dirname, "../../../../scripts/vimax-evaluation/fixtures/single-scene.json"), "utf8")) as {
  input: Record<string, unknown>; candidate: unknown; supplements: unknown;
};
function createBody() {
  return vimaxCandidateCreateSchema.parse({ schema: "ads.vimax-candidate.create.v1",
    target: { sceneId: C, sceneRevisionId: "55555555-5555-4555-8555-555555555555", rowVersion: 4 },
    request: { schema: "ads.vimax-platform-preview.request.v1", source: {
      scriptRevisionId: raw.input.scriptRevisionId, scriptContentHash: raw.input.scriptContentHash, characters: raw.input.characters,
    }, sceneSpans: raw.input.sceneSpans, selectedSceneKeys: raw.input.selectedSceneKeys,
    sourceDialogue: raw.input.sourceDialogue, requirements: raw.input.requirements, candidate: raw.candidate, supplements: raw.supplements },
  });
}

describe("ViMax candidate HTTP boundaries with a real site session and CSRF middleware", () => {
  let app: INestApplication;
  let url: string;
  let cookie: string;
  let csrf: string;
  // Only persistence is doubled. The controller, service, JSON parser, login, CSRF and exception boundaries are real.
  const store = {
    storageReady: vi.fn(async () => true),
    targets: vi.fn(async () => ({ schema: "targets-fixture" }) as unknown as VimaxCandidateTargets),
    list: vi.fn(async () => ({ schema: "page-fixture" }) as unknown as VimaxCandidatePage),
    get: vi.fn(async () => ({ schema: "candidate-fixture" }) as unknown as VimaxCandidateView),
    create: vi.fn(async () => ({ replayed: false, candidate: { candidateId: C } }) as unknown as VimaxCandidateCreateResponse),
    saveScene: vi.fn(async () => ({ replayed: false, receipt: { candidateId: C, operation: "save_scene" } }) as unknown as VimaxCandidateWriteResponse),
    placeShots: vi.fn(async () => ({ replayed: false, receipt: { candidateId: C, operation: "place_shots" } }) as unknown as VimaxCandidateWriteResponse),
  };
  const dependencies: VimaxCandidateDependencies = { workspaceId: W, nodeEnv: "test", store };
  const headers = (extra: Record<string, string> = {}) => ({ cookie, origin: ORIGIN, "x-csrf-token": csrf,
    "content-type": "application/json", "idempotency-key": "request-key", ...extra });
  beforeAll(async () => {
    const passwordHash = await hashPassword(PASSWORD, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
    const module = await Test.createTestingModule({
      imports: [AuthModule.register({ NODE_ENV: "test" } as ApiEnv,
        { kind: "enabled", auth: new SiteAuth({ username: "admin", passwordHash, publicOrigin: ORIGIN }) })],
      controllers: [VimaxCandidateController],
      providers: [{ provide: VIMAX_CANDIDATE_SERVICE, useValue: new VimaxCandidateService(dependencies) }],
    }).compile();
    app = module.createNestApplication({ logger: false }); app.setGlobalPrefix("api/v1");
    (app as unknown as { useBodyParser(type: "json", options: { limit: string }): void }).useBodyParser("json", { limit: "300kb" });
    app.useGlobalFilters(new SafeExceptionFilter());
    await app.listen(0, "127.0.0.1"); url = `${await app.getUrl()}/api/v1`;
    const login = await fetch(`${url}/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: PASSWORD }) });
    expect(login.status).toBe(200);
    cookie = login.headers.getSetCookie().map((item) => item.split(";", 1)[0]).join("; ");
    csrf = (await login.json() as { csrfToken: string }).csrfToken;
  });
  beforeEach(() => { vi.clearAllMocks(); dependencies.nodeEnv = "test"; store.storageReady.mockResolvedValue(true); });
  afterAll(async () => { await app.close(); });

  it("rejects anonymous reads and writes before any storage access", async () => {
    for (const path of [BASE, `${BASE}/targets`, `${BASE}/${C}`]) expect((await fetch(`${url}${path}`)).status).toBe(401);
    for (const path of [BASE, `${BASE}/${C}/scene`, `${BASE}/${C}/shots`]) {
      expect((await fetch(`${url}${path}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    }
    expect(store.storageReady).not.toHaveBeenCalled();
  });

  it("requires CSRF and the configured Origin on all three mutations", async () => {
    for (const path of [BASE, `${BASE}/${C}/scene`, `${BASE}/${C}/shots`]) {
      expect((await fetch(`${url}${path}`, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json" }, body: "{}" })).status).toBe(403);
      expect((await fetch(`${url}${path}`, { method: "POST", headers: headers({ origin: "https://other.test" }), body: "{}" })).status).toBe(403);
    }
    expect(store.storageReady).not.toHaveBeenCalled();
  });

  it("dispatches targets before the UUID route and scopes all reads to server-owned identities", async () => {
    const targets = await fetch(`${url}${BASE}/targets`, { headers: { cookie } });
    expect(targets.status).toBe(200); expect(targets.headers.get("cache-control")).toBe("private, no-store");
    expect(await targets.json()).toEqual({ schema: "targets-fixture" });
    expect(store.targets).toHaveBeenCalledWith(W, P, E); expect(store.get).not.toHaveBeenCalled();
    expect((await fetch(`${url}${BASE}?limit=20&cursor=opaque-cursor`, { headers: { cookie } })).status).toBe(200);
    expect(store.list).toHaveBeenCalledWith(W, P, E, "server-owner", { limit: 20, cursor: "opaque-cursor" });
    expect((await fetch(`${url}${BASE}/${C}`, { headers: { cookie } })).status).toBe(200);
    expect(store.get).toHaveBeenCalledWith(W, P, E, "server-owner", C);
  });

  it("passes original keys and request traces through explicit writes without a paid-model token", async () => {
    const create = createBody();
    const created = await fetch(`${url}${BASE}`, { method: "POST", headers: headers({ "x-trace-id": "actual-create-trace" }), body: JSON.stringify(create) });
    expect(created.status).toBe(201); expect(created.headers.get("cache-control")).toBe("private, no-store");
    expect(store.create).toHaveBeenCalledWith(W, P, E, "server-owner", "request-key", create, "actual-create-trace");
    const saved = await fetch(`${url}${BASE}/${C}/scene`, { method: "POST", headers: headers({ "x-trace-id": "actual-scene-trace" }), body: JSON.stringify(saveBody) });
    expect(saved.status).toBe(200);
    expect(store.saveScene).toHaveBeenCalledWith(W, P, E, "server-owner", C, "request-key", saveBody, "actual-scene-trace");
    const shots = await fetch(`${url}${BASE}/${C}/shots`, { method: "POST", headers: headers({ "x-trace-id": "actual-shots-trace" }), body: JSON.stringify(shotsBody) });
    expect(shots.status).toBe(200);
    expect(store.placeShots).toHaveBeenCalledWith(W, P, E, "server-owner", C, "request-key", shotsBody, "actual-shots-trace");
    expect(store.targets).not.toHaveBeenCalled(); expect(store.get).not.toHaveBeenCalled();
  });

  it("reports disabled production and confirmed missing storage before reaching any candidate operation", async () => {
    dependencies.nodeEnv = "production";
    expect((await fetch(`${url}${BASE}/targets`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${url}${BASE}`, { method: "POST", headers: headers(), body: JSON.stringify(createBody()) })).status).toBe(404);
    expect(store.storageReady).not.toHaveBeenCalled();
    dependencies.nodeEnv = "test"; store.storageReady.mockResolvedValue(false);
    const missing = await fetch(`${url}${BASE}/${C}/scene`, { method: "POST", headers: headers(), body: JSON.stringify(saveBody) });
    expect(missing.status).toBe(503); expect(await missing.json()).toMatchObject({ error: { code: "VIMAX_CANDIDATE_STORAGE_UNAVAILABLE" } });
    expect(store.create).not.toHaveBeenCalled(); expect(store.saveScene).not.toHaveBeenCalled(); expect(store.targets).not.toHaveBeenCalled();
  });

  it("refuses malformed routes, duplicate/extra query fields, missing keys and forged request identity", async () => {
    for (const path of [BASE.replace(P, "bad-project"), BASE.replace(E, "bad-episode"), `${BASE}/bad-candidate`]) {
      expect((await fetch(`${url}${path}`, { headers: { cookie } })).status).toBe(400);
    }
    for (const query of ["limit=21", "limit=1&limit=2", "actorId=browser", "cursor="]) {
      expect((await fetch(`${url}${BASE}?${query}`, { headers: { cookie } })).status).toBe(400);
    }
    expect((await fetch(`${url}${BASE}`, { method: "POST", headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify(createBody()) })).status).toBe(400);
    expect((await fetch(`${url}${BASE}`, { method: "POST", headers: headers(), body: JSON.stringify({ ...createBody(), actorId: "browser" }) })).status).toBe(400);
    expect(store.storageReady).not.toHaveBeenCalled();
  });

  it("keeps the unchanged 300kb parser limit and safe overflow response", async () => {
    const response = await fetch(`${url}${BASE}`, { method: "POST", headers: headers(),
      body: JSON.stringify({ text: "PRIVATE-REJECTED-TEXT" + "a".repeat(300 * 1024) }) });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: "REQUEST_BODY_TOO_LARGE", message: "请求内容超过大小上限。", traceId: "api" } });
    expect(store.storageReady).not.toHaveBeenCalled();
  });

  it("returns fixed business refusals and sends unexpected failures to the safe 500 boundary", async () => {
    store.saveScene.mockRejectedValueOnce(new PersistenceError("VIMAX_CANDIDATE_SOURCE_CHANGED", "PRIVATE-SQL"));
    const refused = await fetch(`${url}${BASE}/${C}/scene`, { method: "POST", headers: headers(), body: JSON.stringify(saveBody) });
    expect(refused.status).toBe(409); expect(await refused.json()).toEqual({ error: {
      code: "VIMAX_CANDIDATE_SOURCE_CHANGED", message: "来源剧本或角色已变化，请重新核对当前版本。",
    } });
    store.create.mockRejectedValueOnce(new Error("PRIVATE-SQL"));
    const failed = await fetch(`${url}${BASE}`, { method: "POST", headers: headers(), body: JSON.stringify(createBody()) });
    expect(failed.status).toBe(500); expect(JSON.stringify(await failed.json())).not.toContain("PRIVATE-SQL");
  });
});
