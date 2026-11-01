import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  VIMAX_PLANNING_BUDGET, vimaxEvaluationInputSchema, vimaxPlanningStartSchema,
  type VimaxPlanningRecord, type VimaxPlanningStore, type VimaxPlanningReservation,
} from "@ai-drama/contracts";
import { hashVimaxPlanningRequest } from "@ai-drama/domain";
import { titleWritingProviderConfigs } from "@ai-drama/providers";
import { VimaxPlanningService, type VimaxPlanningDependencies } from "./vimax-planning.service";
const WS = "11111111-1111-4111-8111-111111111111", NOW = "2026-11-01T00:00:00.000Z";
function fixture() {
  const raw = JSON.parse(readFileSync(resolve(__dirname, "../../../../scripts/vimax-evaluation/fixtures/single-scene.json"), "utf8")) as { input: unknown };
  const i = vimaxEvaluationInputSchema.parse(raw.input);
  const body = vimaxPlanningStartSchema.parse({ schema: "ads.vimax-planning.start.v1", confirmedTextSend: true,
    source: { scriptRevisionId: i.scriptRevisionId, scriptContentHash: i.scriptContentHash, characters: i.characters },
    target: { sceneId: "a0000000-0000-4000-8000-000000000005", sceneRevisionId: "a0000000-0000-4000-8000-000000000006", rowVersion: 1 },
    sceneSpans: i.sceneSpans, selectedSceneKeys: i.selectedSceneKeys, sourceDialogue: i.sourceDialogue, requirements: i.requirements });
  const source = { schema: "ads.vimax-platform-source.v1" as const, projectId: i.projectId, episodeId: i.episodeId, episodeNo: i.episodeNo,
    scriptRevisionId: i.scriptRevisionId, scriptRevisionNo: 1, scriptContentHash: i.scriptContentHash, scriptText: i.scriptText, characters: i.characters };
  function record(r: VimaxPlanningReservation): VimaxPlanningRecord {
    return { ...r, frozenHash: "a".repeat(64), input: { schema: "ads.vimax-planning.frozen.v1", promptVersion: "ads.vimax-planning.prompt.v1",
      source, target: { ...r.request.target, sourceScriptRevisionId: source.scriptRevisionId, ordinal: 1, heading: i.sceneSpans[0]!.heading,
        timeOfDay: "夜", summary: "交谈", locationRevisionId: null }, request: r.request, providerKey: r.providerKey, model: r.model, budget: { ...VIMAX_PLANNING_BUDGET } },
      state: "reserved", errorCode: null, submittedAt: null, providerRequestId: null, responseModel: null,
      usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null }, output: null, finishedAt: null };
  }
  return { i, body, source, record };
}
function setup(overrides: Partial<VimaxPlanningDependencies> = {}) {
  const f = fixture(); let saved: VimaxPlanningRecord | null = null;
  const store: VimaxPlanningStore = {
    storageReady: vi.fn(async () => true), findByKey: vi.fn(async () => saved),
    create: vi.fn(async (r) => { saved = f.record(r); return { kind: "created", record: saved }; }),
    get: vi.fn(async () => saved), getById: vi.fn(async () => saved), list: vi.fn(async () => saved ? [saved] : []),
    markSubmitted: vi.fn(async () => false), closeUnsent: vi.fn(async () => false), finish: vi.fn(async () => false),
    recoverExpired: vi.fn(async () => 0), cancel: vi.fn(async () => saved),
  };
  const executor = { workspaceId: WS, executorId: "test", execute: vi.fn(async () => undefined), maintain: vi.fn(async () => undefined) };
  const scheduled: Array<() => Promise<void>> = [];
  const providers = titleWritingProviderConfigs({ OPENAI_API_KEY: "test-not-a-real-secret", TITLE_WRITING_OPENAI_MODELS: "o-1" });
  const service = new VimaxPlanningService({ workspaceId: WS, nodeEnv: "test", enabled: true, siteAuthRequired: true,
    operatorToken: null, siteOperator: true, defaultProvider: "openai", providers, store, executor, maxCallsPerDay: 10, maxActiveRuns: 3,
    clock: () => new Date(NOW), schedule: (work) => scheduled.push(work), ...overrides });
  const start = (key = "key-1", body: unknown = f.body) => service.start(f.i.projectId, f.i.episodeId, body,
    { session: true, token: undefined }, { actorId: "server-owner", traceId: "trace", idempotencyKey: key });
  return { ...f, store, service, executor, providers, scheduled, start, saved: () => saved, setSaved: (r: VimaxPlanningRecord) => { saved = r; } };
}
describe("ViMax planning API sends only newly reserved authorized work", () => {
  it.each([{ enabled: false }, { nodeEnv: "production" as const }, { siteAuthRequired: false }])("keeps a closed policy side-effect free: %o", async (policy) => {
    const h = setup(policy); expect((await h.start()).status).toBe(404); expect(h.store.create).not.toHaveBeenCalled(); expect(h.scheduled).toEqual([]);
  });
  it("supports production only with explicit authorization and authenticated operator", async () => {
    const h = setup({ nodeEnv: "production", allowProduction: true }); expect((await h.start()).status).toBe(202);
    expect(h.scheduled).toHaveLength(1); expect(h.executor.execute).not.toHaveBeenCalled();
  });
  it("rejects missing session, invalid key, or client model/approval injection before reservation", async () => {
    const h = setup();
    expect((await h.service.start(h.i.projectId, h.i.episodeId, h.body, undefined,
      { actorId: "server-owner", traceId: "t", idempotencyKey: "k" })).status).toBe(403);
    expect((await h.start("bad key")).status).toBe(400); expect((await h.start("k", { ...h.body, model: "other" })).status).toBe(400);
    expect((await h.start("unicode-key", { ...h.body, requirements: { ...h.body.requirements, style: "\ud800" } })).status).toBe(400);
    expect(h.store.create).not.toHaveBeenCalled();
  });
  it("returns a permanent replay before changed provider defaults without scheduling a second send", async () => {
    const h = setup(); expect((await h.start()).status).toBe(202); h.providers.openai = { ...h.providers.openai, ok: false };
    const replay = await h.start(); expect(replay.status).toBe(200); expect(replay.body).toMatchObject({ replayed: true, request: { requestKey: "key-1" } });
    expect(h.store.create).toHaveBeenCalledOnce(); expect(h.scheduled).toHaveLength(1);
    expect((await h.start("key-1", { ...h.body, requirements: { ...h.body.requirements, style: "different" } })).status).toBe(409);
  });
  it("does not replace an unready explicit default with another configured provider", async () => {
    const providers = titleWritingProviderConfigs({ ANTHROPIC_API_KEY: "sk-ant-api03-test-not-a-real-key" });
    const h = setup({ providers, defaultProvider: "openai" }); expect((await h.start()).status).toBe(503); expect(h.store.create).not.toHaveBeenCalled();
  });
  it("GET history and options never execute, maintain or reserve", async () => {
    const h = setup(); await h.service.options(h.i.projectId, h.i.episodeId); await h.service.list(h.i.projectId, h.i.episodeId, "server-owner");
    expect(h.store.create).not.toHaveBeenCalled(); expect(h.executor.execute).not.toHaveBeenCalled(); expect(h.executor.maintain).not.toHaveBeenCalled();
  });
  it("surfaces UNKNOWN confirmation and quota refusals without scheduling work", async () => {
    const h = setup(); vi.mocked(h.store.create).mockResolvedValueOnce({ kind: "needs_confirmation", requestId: "prior" });
    expect((await h.start()).body).toMatchObject({ error: { code: "VIMAX_PLANNING_NEEDS_CONFIRMATION", details: { requestId: "prior" } } });
    vi.mocked(h.store.create).mockResolvedValueOnce({ kind: "blocked", code: "VIMAX_PLANNING_DAILY_CAP" });
    expect((await h.start()).status).toBe(429); expect(h.scheduled).toEqual([]);
  });
  it("scopes a replay and refuses submitted cancellation without pretending it was unsent", async () => {
    const h = setup(); await h.start(); h.setSaved({ ...h.saved()!, state: "submitted", submittedAt: NOW });
    expect((await h.service.cancel(h.i.projectId, h.i.episodeId, "server-owner", h.saved()!.id, { session: true, token: undefined })).status).toBe(409);
    expect(hashVimaxPlanningRequest(h.i.projectId, h.i.episodeId, h.body)).toBe(h.saved()!.requestHash);
  });
});
