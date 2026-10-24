import { randomUUID } from "node:crypto";
import { seriesBatchCount, seriesConstraintsSchema, seriesScopeCalls, type SeriesScope, type TitleWritingProviderKey } from "@ai-drama/contracts";
import { admitSeriesGrant, nextSeriesJob, seriesCurrentPlan, seriesView } from "@ai-drama/domain";
import { titleWritingProviderConfigs } from "./text-writing";
import { SeriesWritingEngine, newSeries, newSeriesGrant } from "./series-writing-engine";
import { InMemorySeriesWritingStore } from "./series-writing-memory-store";
import { seriesFixtureTransport, type SeriesFixtureExchange, type SeriesFixturePlan } from "./series-writing-fixtures";

/** Shared setup of the series engine specs (model double, in-memory store). Never wired by the runtime. */

export const WS = "11111111-1111-4111-8111-111111111111";
export const P1 = "22222222-2222-4222-8222-222222222222";
export const START = Date.parse("2026-10-22T00:00:00Z");

export const PROVIDERS = titleWritingProviderConfigs({
  OPENAI_API_KEY: "sk-openai-test-0123456789", TITLE_WRITING_OPENAI_MODELS: "m-1",
  ANTHROPIC_API_KEY: "sk-ant-api03-test-secret-0123456789", TITLE_WRITING_ANTHROPIC_MODELS: "m-1",
  DEEPSEEK_API_KEY: "sk-deepseek-test-0123456789", TITLE_WRITING_DEEPSEEK_MODELS: "m-1",
});

interface Setup {
  episodes?: number;
  seconds?: number;
  providerKey?: TitleWritingProviderKey;
  plan?: SeriesFixturePlan | (() => SeriesFixturePlan);
  maxCallsPerDay?: number;
  maxActiveRuns?: number;
  override?: NonNullable<Parameters<typeof seriesFixtureTransport>[0]>["override"];
}

export async function seriesSetup(options: Setup = {}) {
  const n = options.episodes ?? 60;
  const store = new InMemorySeriesWritingStore();
  let clock = START;
  const now = () => new Date(clock);
  const series = newSeries({
    workspaceId: WS, projectId: P1, actorId: "server-owner", idempotencyKey: "series-key", title: "替身样例系列", idea: "", constraints: seriesConstraintsSchema.parse({}),
    materials: [], referenceUrls: [], researchFetch: false, episodeCount: n, episodeSeconds: options.seconds ?? 60, now: now(),
  });
  if ((await store.createSeries(series, { title: "替身样例系列", premise: "" })).kind !== "created") throw new Error("series not created");
  const seen: SeriesFixtureExchange[] = [];
  const transport = seriesFixtureTransport({ plan: options.plan, seen, override: options.override });
  const limits = () => ({ sinceIso: new Date(clock - 86_400_000).toISOString(), maxCallsPerDay: options.maxCallsPerDay ?? 1_000, maxActiveRuns: options.maxActiveRuns ?? 2 });
  const engine = (executorId?: string) => new SeriesWritingEngine({
    workspaceId: WS, store, providers: PROVIDERS, transport, maxCallsPerDay: options.maxCallsPerDay ?? 1_000, maxActiveRuns: options.maxActiveRuns ?? 2,
    clock: now, leaseMs: 240_000, ...(executorId ? { executorId } : {}),
  });
  const main = engine("executor-a");
  const snapshot = async () => (await store.snapshot(WS, P1))!;
  const view = async () => seriesView(await snapshot());
  async function grant(scope: SeriesScope, key = randomUUID(), extra: { resendAllowance?: number; providerKey?: TitleWritingProviderKey; normalCalls?: number; drive?: boolean; base?: string | null } = {}) {
    const snap = await snapshot();
    const normal = extra.normalCalls ?? seriesScopeCalls(n, scope);
    const resend = extra.resendAllowance ?? 0;
    const record = newSeriesGrant({
      series, actorId: "server-owner", idempotencyKey: key, scope, normalCalls: normal, resendAllowance: resend, callBudget: normal + resend,
      providerKey: extra.providerKey ?? options.providerKey ?? "deepseek", model: "m-1", basePlanRevisionId: extra.base !== undefined ? extra.base : seriesCurrentPlan(snap)?.id ?? null,
      authorization: { mode: "series", proof: "site_session", initiatedBy: "server-owner", executor: "series-writing-engine" }, now: now(),
    });
    const created = await store.createGrant(record, limits(), (state) => admitSeriesGrant(state, record, { jobId: randomUUID(), nowIso: now().toISOString() }));
    if (created.kind === "created" && extra.drive !== false) await main.drive(created.jobId);
    return created;
  }
  async function resume(grantId: string, key: string, confirmed: string[] = []) {
    const prepared = await store.prepareResume(WS, P1, grantId, { resumeKey: key, requestHash: `${key}:${confirmed.join(",")}`, confirmedCallIds: confirmed, providerReady: true, limits: limits() },
      now().toISOString(), (state) => nextSeriesJob(state, state.grants.find((item) => item.id === grantId)!, { jobId: randomUUID(), nowIso: now().toISOString() }));
    if (prepared.kind === "ok") await main.drive(prepared.jobId);
    return prepared;
  }
  return { n, store, series, seen, engine, main, snapshot, view, grant, resume, tick: (ms: number) => { clock += ms; }, limits };
}

export const ALL = (n: number): SeriesScope => ({ plan: true, batchFrom: 1, batchTo: seriesBatchCount(n), final: true });
