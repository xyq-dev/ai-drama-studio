import { describe, expect, it } from "vitest";
import { SERIES_RESEARCH_CONTRACT, seriesScopeCalls, type SeriesResearchContract, type SeriesScope } from "@ai-drama/contracts";
import { PersistenceError } from "@ai-drama/database";
import type { SeriesView } from "@ai-drama/domain";
import { hashSeriesInput, InMemorySeriesWritingStore, SeriesWritingEngine, titleWritingProviderConfigs } from "@ai-drama/providers";
import { seriesFixtureTransport, type SeriesFixtureExchange } from "@ai-drama/providers/title-writing-fixtures";
import { AutoCreationService } from "./auto-creation.service";
import { SeriesWritingService } from "./series-writing.service";

/** The series writing API boundary against the in-process store and the model double (no network, no database). */
const WS = "11111111-1111-4111-8111-111111111111";
const TOKEN = "operator-token-0123456789";
const CONTEXT = (key?: string) => ({ actorId: "server-owner", traceId: "t", ...(key ? { idempotencyKey: key } : {}) });
const providers = titleWritingProviderConfigs({ DEEPSEEK_API_KEY: "sk-deepseek-test-0123456789", TITLE_WRITING_DEEPSEEK_MODELS: "m-1" });

function setup(options: { enabled?: boolean; maxCallsPerDay?: number } = {}) {
  const store = new InMemorySeriesWritingStore();
  const seen: SeriesFixtureExchange[] = [];
  const engine = new SeriesWritingEngine({ workspaceId: WS, store, providers, transport: seriesFixtureTransport({ seen }), maxCallsPerDay: options.maxCallsPerDay ?? 200, maxActiveRuns: 2 });
  const pending: Array<() => Promise<void>> = [];
  const service = new SeriesWritingService({
    workspaceId: WS, enabled: options.enabled ?? true, operatorToken: TOKEN, defaultProvider: "deepseek", providers, store, engine,
    projects: {
      getProject: async (_workspaceId: string, projectId: string) => {
        if (!store.projects.has(projectId)) throw new PersistenceError("NOT_FOUND", "Project not found");
        return { id: projectId } as never;
      },
      episodePlanReady: async () => true,
    },
    maxCallsPerDay: options.maxCallsPerDay ?? 200, maxActiveRuns: 2, research: { fetchEnabled: false, allowedHosts: [] },
    schedule: (work) => { pending.push(work); },
  });
  const settle = async () => { while (pending.length > 0) await pending.shift()!(); };
  return { store, service, seen, settle };
}

const viewOf = (body: unknown) => (body as { series: SeriesView }).series;

async function created(service: SeriesWritingService, episodeCount = 60): Promise<SeriesView> {
  const result = await service.create({ title: "替身样例", episodeCount, episodeSeconds: 60 }, TOKEN, CONTEXT(`create-${String(episodeCount)}`));
  expect(result.status).toBe(201);
  return viewOf(result.body);
}

function body(view: SeriesView, scope: SeriesScope, extra: Record<string, unknown> = {}) {
  const normal = seriesScopeCalls(view.episodeCount, scope);
  return { scope, normalCalls: normal, resendAllowance: 0, callBudget: normal, providerKey: "deepseek", model: "m-1", basePlanRevisionId: view.plan?.revisionId ?? null, ...extra };
}

describe("series writing service", () => {
  it("off, without the operator, or without an idempotency key: refused before anything is written", async () => {
    const off = setup({ enabled: false });
    expect((await off.service.create({ title: "x", episodeCount: 3, episodeSeconds: 60 }, TOKEN, CONTEXT("k"))).status).toBe(404);
    const { service, store } = setup();
    expect((await service.create({ title: "x", episodeCount: 3, episodeSeconds: 60 }, "wrong-token-000000000", CONTEXT("k"))).status).toBe(403);
    expect((await service.create({ title: "x", episodeCount: 3, episodeSeconds: 60 }, TOKEN, CONTEXT())).status).toBe(400);
    expect((await service.create({ title: "x", episodeCount: 61, episodeSeconds: 60 }, TOKEN, CONTEXT("k"))).status).toBe(400);
    expect((await service.create({ title: "x", episodeCount: 3, episodeSeconds: 45 }, TOKEN, CONTEXT("k"))).status).toBe(400);
    expect(store.series).toHaveLength(0);
  });

  it("creating a work sends nothing; the same key returns it; other content under the key is refused", async () => {
    const { service, seen, store } = setup();
    const view = await created(service, 60);
    expect(view).toMatchObject({ episodeCount: 60, written: 0, completion: "not_started" });
    expect(view.budget).toMatchObject({ normalCalls: 96, planCalls: 15, planAndFirstBatchCalls: 19 });
    expect((await service.create({ title: "替身样例", episodeCount: 60, episodeSeconds: 60 }, TOKEN, CONTEXT("create-60"))).status).toBe(200);
    expect((await service.create({ title: "别的", episodeCount: 60, episodeSeconds: 60 }, TOKEN, CONTEXT("create-60"))).status).toBe(409);
    expect(store.series).toHaveLength(1);
    expect(seen).toHaveLength(0);
  });

  it.each<SeriesResearchContract>([
    SERIES_RESEARCH_CONTRACT,
    { ...SERIES_RESEARCH_CONTRACT, promptVersion: "ads.auto-creation.prompt.v10", checksVersion: "ads.auto-creation.checks.v13" },
  ])("an old v1 creation replays after a prompt upgrade, without accepting changed creative content ($checksVersion)", async (researchContract) => {
    const { service, seen, store, settle } = setup();
    const view = await created(service, 60);
    const stored = store.series[0]!;
    // Synthetic historical record: the work predates the series prompt upgrade, possibly the shared research upgrade too.
    stored.input.promptVersion = "ads.series-writing.prompt.v1";
    stored.input.researchContract = researchContract;
    stored.inputHash = hashSeriesInput(stored.title, stored.input);
    const before = structuredClone(stored);
    const request = { title: "替身样例", episodeCount: 60, episodeSeconds: 60 };
    const replay = await service.create(request, TOKEN, CONTEXT("create-60"));
    expect(replay.status).toBe(200);
    expect(viewOf(replay.body).projectId).toBe(view.projectId);
    expect(viewOf(replay.body).versions.prompt).toBe("ads.series-writing.prompt.v1");
    for (const change of [
      { title: "别的" }, { idea: "新想法" }, { episodeCount: 59 }, { episodeSeconds: 90 },
      { constraints: { audience: "新受众" } }, { referenceUrls: ["https://example.com/source"] },
    ]) {
      expect((await service.create({ ...request, ...change }, TOKEN, CONTEXT("create-60"))).body)
        .toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REUSED" } });
    }
    await settle();
    expect(store.series).toEqual([before]);
    expect(store.projects.size).toBe(1);
    expect(store.grants).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });

  it("a card whose numbers are not the formula's, or whose budget is not normal plus resends, is refused with zero sends", async () => {
    const { service, seen, store } = setup();
    const view = await created(service);
    const scope = { plan: true, batchFrom: 1, batchTo: 1, final: false };
    expect((await service.grant(view.projectId, body(view, scope, { normalCalls: 11, callBudget: 11 }), TOKEN, CONTEXT("g1"))).body).toMatchObject({ error: { code: "SERIES_CARD_STALE" } });
    expect((await service.grant(view.projectId, body(view, scope, { callBudget: 25 }), TOKEN, CONTEXT("g2"))).body).toMatchObject({ error: { code: "SERIES_BUDGET_MISMATCH" } });
    expect((await service.grant(view.projectId, body(view, scope, { model: "other" }), TOKEN, CONTEXT("g3"))).body).toMatchObject({ error: { code: "SERIES_MODEL_UNAVAILABLE" } });
    expect((await service.grant(view.projectId, body(view, scope, { providerKey: "openai" }), TOKEN, CONTEXT("g4"))).body).toMatchObject({ error: { code: "SERIES_PROVIDER_UNCONFIGURED" } });
    expect(store.grants).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });

  it("a grant runs the plan and episodes 1–3 (19 calls); the replayed key adds nothing; the package downloads", async () => {
    const { service, seen, settle } = setup();
    const view = await created(service);
    const scope = { plan: true, batchFrom: 1, batchTo: 1, final: false };
    expect((await service.grant(view.projectId, body(view, scope), TOKEN, CONTEXT("g"))).status).toBe(201);
    await settle();
    expect(seen).toHaveLength(19);
    expect((await service.grant(view.projectId, body(view, scope), TOKEN, CONTEXT("g"))).status).toBe(200);
    await settle();
    expect(seen).toHaveLength(19);
    const after = viewOf((await service.get(view.projectId)).body);
    expect(after.completionLabel).toContain("已完成 3/60 集");
    const markdown = await service.package(view.projectId, "markdown");
    expect(markdown.download).toMatchObject({ contentType: "text/markdown; charset=utf-8" });
    expect((await service.package(view.projectId, "pdf")).status).toBe(400);
    // Placement waits for a person's approval of the story; a ledger with no change to confirm is refused.
    expect((await service.placeBatch(view.projectId, 1, {}, CONTEXT())).body).toMatchObject({ error: { code: "SERIES_STORY_NOT_APPROVED" } });
    expect((await service.placeBatch(view.projectId, 2, {}, CONTEXT())).body).toMatchObject({ error: { code: "SERIES_NOT_READY" } });
  });

  it("a short-drama service refuses a series work before any call", async () => {
    const auto = new AutoCreationService({
      workspaceId: WS, enabled: true, operatorToken: TOKEN, defaultProvider: "deepseek", providers, store: { storageReady: async () => true } as never,
      engine: { workspaceId: WS, drive: async () => undefined, maintain: async () => undefined },
      projects: { getProject: async () => ({}) as never, getProjectEpisodePlan: async () => ({ episodeCount: 60, targetEpisodeSeconds: 60, writingMode: "series" }) as never,
        episodePlanReady: async () => true },
      maxCallsPerDay: 10, maxActiveRuns: 1, research: { fetchEnabled: false, allowedHosts: [] },
    });
    expect((await auto.start("22222222-2222-4222-8222-222222222222", {}, TOKEN, CONTEXT("a"))).body).toMatchObject({ error: { code: "AUTO_CREATION_SERIES_PROJECT" } });
  });
});
