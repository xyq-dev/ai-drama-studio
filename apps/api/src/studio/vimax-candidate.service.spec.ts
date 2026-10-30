import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  vimaxCandidateCreateSchema,
  type VimaxCandidateCreateResponse,
  type VimaxCandidatePage,
  type VimaxCandidateTargets,
  type VimaxCandidateView,
  type VimaxCandidateWriteResponse,
} from "@ai-drama/contracts";
import { PersistenceError } from "@ai-drama/database";
import { VimaxCandidateService } from "./vimax-candidate.service";

const P = "11111111-1111-4111-8111-111111111111";
const E = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const context = { actorId: "server-owner", traceId: "actual-request-trace", idempotencyKey: "original-key" };
const saveBody = { schema: "ads.vimax-candidate.save-scene.v1", expectedVersion: 1, confirmedReview: true };
const shotsBody = { schema: "ads.vimax-candidate.place-shots.v1", expectedVersion: 2, confirmedReview: true };
const RAW = JSON.parse(readFileSync(resolve(__dirname, "../../../../scripts/vimax-evaluation/fixtures/single-scene.json"), "utf8")) as {
  input: Record<string, unknown>; candidate: unknown; supplements: unknown;
};

function createBody() {
  const input = RAW.input;
  return vimaxCandidateCreateSchema.parse({ schema: "ads.vimax-candidate.create.v1",
    target: { sceneId: C, sceneRevisionId: "44444444-4444-4444-8444-444444444444", rowVersion: 4 },
    request: { schema: "ads.vimax-platform-preview.request.v1",
      source: { scriptRevisionId: input.scriptRevisionId, scriptContentHash: input.scriptContentHash, characters: input.characters },
      sceneSpans: input.sceneSpans, selectedSceneKeys: input.selectedSceneKeys, sourceDialogue: input.sourceDialogue,
      requirements: input.requirements, candidate: RAW.candidate, supplements: RAW.supplements,
    },
  });
}
function setup(nodeEnv: "test" | "production" = "test") {
  // These markers exercise service orchestration; the store/contract suites validate the complete persisted views.
  const store = {
    storageReady: vi.fn(async () => true),
    targets: vi.fn(async () => ({ schema: "targets-marker" }) as unknown as VimaxCandidateTargets),
    list: vi.fn(async () => ({ schema: "page-marker" }) as unknown as VimaxCandidatePage),
    get: vi.fn(async () => ({ schema: "candidate-marker" }) as unknown as VimaxCandidateView),
    create: vi.fn(async () => ({ replayed: false, candidate: { candidateId: C } }) as unknown as VimaxCandidateCreateResponse),
    saveScene: vi.fn(async () => ({ replayed: false, receipt: { candidateId: C, operation: "save_scene" } }) as unknown as VimaxCandidateWriteResponse),
    placeShots: vi.fn(async () => ({ replayed: false, receipt: { candidateId: C, operation: "place_shots" } }) as unknown as VimaxCandidateWriteResponse),
  };
  return { store, service: new VimaxCandidateService({ workspaceId: "server-workspace", nodeEnv, store }) };
}
const calls = (service: VimaxCandidateService) => [
  () => service.targets(P, E), () => service.list(P, E, context.actorId, {}), () => service.get(P, E, C, context.actorId),
  () => service.create(P, E, createBody(), context), () => service.saveScene(P, E, C, saveBody, context),
  () => service.placeShots(P, E, C, shotsBody, context),
];

describe("ViMax candidate API orchestration has no source prechecks, model or whole-episode writer", () => {
  it("disables every endpoint in production before any storage access", async () => {
    const { service, store } = setup("production");
    for (const call of calls(service)) expect(await call()).toMatchObject({ status: 404, body: { error: { code: "VIMAX_CANDIDATE_DISABLED" } } });
    Object.values(store).forEach((method) => expect(method).not.toHaveBeenCalled());
  });

  it("refuses confirmed missing storage on every route without writing", async () => {
    const { service, store } = setup(); store.storageReady.mockResolvedValue(false);
    for (const call of calls(service)) expect(await call()).toMatchObject({ status: 503, body: { error: { code: "VIMAX_CANDIDATE_STORAGE_UNAVAILABLE" } } });
    expect(store.storageReady).toHaveBeenCalledTimes(6);
    Object.entries(store).filter(([name]) => name !== "storageReady").forEach(([, method]) => expect(method).not.toHaveBeenCalled());
  });

  it("does not disguise probe failures as missing SQL", async () => {
    const { service, store } = setup(); const error = new Error("database probe timeout");
    store.storageReady.mockRejectedValue(error);
    await expect(service.targets(P, E)).rejects.toBe(error);
    expect(store.targets).not.toHaveBeenCalled();
  });

  it("passes only the server workspace, authenticated actor, request identity and actual trace", async () => {
    const { service, store } = setup();
    const body = createBody(); const before = structuredClone(body);
    expect((await service.create(P, E, body, context)).status).toBe(201);
    expect(store.create).toHaveBeenCalledWith("server-workspace", P, E, "server-owner", "original-key", body, "actual-request-trace");
    expect(body).toEqual(before);
    await service.saveScene(P, E, C, saveBody, context);
    expect(store.saveScene).toHaveBeenCalledWith("server-workspace", P, E, "server-owner", C, "original-key", saveBody, "actual-request-trace");
    await service.placeShots(P, E, C, shotsBody, context);
    expect(store.placeShots).toHaveBeenCalledWith("server-workspace", P, E, "server-owner", C, "original-key", shotsBody, "actual-request-trace");
  });

  it("lets permanent replays through without first checking live targets, versions or reviews", async () => {
    const { service, store } = setup();
    store.targets.mockRejectedValue(new Error("changed source must not be pre-read"));
    store.get.mockRejectedValue(new Error("changed review must not be pre-read"));
    store.create.mockResolvedValue({ replayed: true, candidate: { candidateId: C } } as unknown as VimaxCandidateCreateResponse);
    store.saveScene.mockResolvedValue({ replayed: true, receipt: { candidateId: C } } as unknown as VimaxCandidateWriteResponse);
    store.placeShots.mockResolvedValue({ replayed: true, receipt: { candidateId: C } } as unknown as VimaxCandidateWriteResponse);
    for (const result of [await service.create(P, E, createBody(), context), await service.saveScene(P, E, C, saveBody, context),
      await service.placeShots(P, E, C, shotsBody, context)]) {
      expect(result.status).toBe(200); expect(result.body).toMatchObject({ replayed: true });
    }
    expect(store.targets).not.toHaveBeenCalled(); expect(store.get).not.toHaveBeenCalled(); expect(store.list).not.toHaveBeenCalled();
  });

  it("keeps read scoping and bounded pagination explicit", async () => {
    const { service, store } = setup();
    await service.targets(P, E); expect(store.targets).toHaveBeenCalledWith("server-workspace", P, E);
    await service.get(P, E, C, "server-owner"); expect(store.get).toHaveBeenCalledWith("server-workspace", P, E, "server-owner", C);
    await service.list(P, E, "server-owner", {}); expect(store.list).toHaveBeenLastCalledWith("server-workspace", P, E, "server-owner", { limit: 10 });
    await service.list(P, E, "server-owner", { limit: "20", cursor: "opaque-cursor" });
    expect(store.list).toHaveBeenLastCalledWith("server-workspace", P, E, "server-owner", { limit: 20, cursor: "opaque-cursor" });
  });

  it.each([{ limit: "0" }, { limit: "21" }, { limit: "01" }, { limit: ["1", "2"] }, { cursor: "" }, { actorId: "browser" }])(
    "rejects invalid query %j before probing storage", async (query) => {
      const { service, store } = setup(); expect((await service.list(P, E, "server-owner", query)).status).toBe(400);
      expect(store.storageReady).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "", " ", "a".repeat(201), "bad\nkey"])("requires a valid identity on each mutation (%j)", async (idempotencyKey) => {
    const { service, store } = setup(); const ctx = { ...context, idempotencyKey };
    for (const result of [await service.create(P, E, createBody(), ctx), await service.saveScene(P, E, C, saveBody, ctx),
      await service.placeShots(P, E, C, shotsBody, ctx)]) expect(result.status).toBe(400);
    expect(store.storageReady).not.toHaveBeenCalled();
  });

  it("rejects uploaded reports, forged identities, unconfirmed review and invalid versions before storage", async () => {
    const { service, store } = setup();
    for (const extra of [{ actorId: "browser" }, { workspaceId: "browser" }, { report: { writeAllowed: true } }, { savedSceneRevisionId: C }]) {
      expect((await service.create(P, E, { ...createBody(), ...extra }, context)).status).toBe(400);
    }
    for (const body of [{ ...saveBody, confirmedReview: false }, { ...saveBody, expectedVersion: 0 }, { ...saveBody, unexpected: true }]) {
      expect((await service.saveScene(P, E, C, body, context)).status).toBe(400);
    }
    expect((await service.placeShots(P, E, C, saveBody, context)).status).toBe(400);
    expect(store.storageReady).not.toHaveBeenCalled();
  });

  it("uses UTF-8 bytes for the complete envelope cap, not character count", async () => {
    const { service, store } = setup();
    const result = await service.create(P, E, { value: "剧".repeat(103_000) }, context);
    expect(result).toMatchObject({ status: 413, body: { error: { code: "VIMAX_CANDIDATE_INPUT_TOO_LARGE" } } });
    expect(store.storageReady).not.toHaveBeenCalled();
  });

  it.each([
    ["VIMAX_CANDIDATE_SOURCE_CHANGED", 409], ["VIMAX_CANDIDATE_TARGET_CHANGED", 409], ["VIMAX_CANDIDATE_HAS_SHOTS", 409],
    ["VIMAX_CANDIDATE_REVIEW_REQUIRED", 409], ["VIMAX_CANDIDATE_ACTIVE_BREAKDOWN", 409], ["VIMAX_CANDIDATE_BLOCKED", 422],
    ["VIMAX_CANDIDATE_ALREADY_SAVED", 409], ["IDEMPOTENCY_KEY_REUSED", 409], ["REVISION_CONFLICT", 409],
    ["SOURCE_STALE", 409], ["NOT_FOUND", 404], ["VIMAX_CANDIDATE_STORAGE_UNAVAILABLE", 503], ["SERIES_MEDIA_NOT_ENABLED", 409],
    ["VIMAX_CANDIDATE_CORRUPT", 503], ["REVIEW_REQUIRED", 409],
    ["VIMAX_CANDIDATE_FROZEN_TOO_LARGE", 413],
  ] as const)("translates %s to a fixed private-text-safe %s refusal", async (code, status) => {
    const { service, store } = setup();
    store.saveScene.mockRejectedValue(new PersistenceError(code, "SECRET-SQL-OR-REJECTED-DIALOGUE", { rejected: "PRIVATE" }));
    const result = await service.saveScene(P, E, C, saveBody, context);
    expect(result.status).toBe(status); expect(result.body).toMatchObject({ error: { code } });
    expect(JSON.stringify(result.body)).not.toMatch(/SECRET|PRIVATE/);
  });

  it("preserves unexpected operational failures for the app-wide safe exception boundary", async () => {
    const { service, store } = setup(); const failure = new Error("unexpected database disconnection");
    store.create.mockRejectedValue(failure);
    await expect(service.create(P, E, createBody(), context)).rejects.toBe(failure);
  });
});
