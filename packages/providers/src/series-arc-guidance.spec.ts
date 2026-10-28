import { describe, expect, it } from "vitest";
import { SERIES_ARC_SCHEMA, SERIES_WRITING_PROMPT_VERSION, seriesJsonSchema, type SeriesArc } from "@ai-drama/contracts";
import { buildSeriesPrompt, canonicalInputHash, seriesAutoInput, seriesPlanContext } from "@ai-drama/domain";
import { hashSeriesInput } from "./series-writing-engine";
import { fixtureSeriesArc, type SeriesFixtureExchange } from "./series-writing-fixtures";
import { seriesSetup } from "./series-writing-test-kit";

/** Synthetic answers and historical snapshots only. The real DeepSeek adapter uses an intercepted transport. */
const SCOPE = { plan: true, batchFrom: 1, batchTo: 1, final: false };
const LEGACY_PROMPT = "ads.series-writing.prompt.v1";
const DEPENDENCY_RULE = "target.payoffEpisode < item.payoffEpisode";
const HISTORICAL_GRANT_KEY = "33333333-3333-4333-8333-333333333331";
const NEW_GRANT_KEY = "33333333-3333-4333-8333-333333333332";
type Setup = Awaited<ReturnType<typeof seriesSetup>>;

function deepseekAnswer(arc: SeriesArc) {
  return { status: 200, body: {
    id: "synthetic-arc-dependency", object: "chat.completion", model: "fixture-model",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(arc) } }],
    usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
  } };
}

function sentSchema(exchange: SeriesFixtureExchange): unknown {
  const marker = "JSON Schema：\n";
  expect(exchange.system).toContain(marker);
  return JSON.parse(exchange.system.slice(exchange.system.indexOf(marker) + marker.length));
}

function historicalSeries(setup: Setup): void {
  // An existing v1 row, not a migration or a request to rewrite history.
  setup.series.input.promptVersion = LEGACY_PROMPT;
  setup.series.inputHash = hashSeriesInput(setup.series.title, setup.series.input);
  Object.assign(setup.store.series[0]!, structuredClone(setup.series));
}

async function pauseHistoricalPlanBeforeArc(setup: Setup) {
  historicalSeries(setup);
  const created = await setup.grant(SCOPE, HISTORICAL_GRANT_KEY, { drive: false });
  if (created.kind !== "created") throw new Error("synthetic historical grant was not created");
  const job = setup.store.jobs.find((item) => item.id === created.jobId)!;
  job.input.promptVersion = LEGACY_PROMPT;
  job.inputHash = canonicalInputHash(job.input);
  const frozen = structuredClone({ seriesInput: setup.series.input, seriesHash: setup.series.inputHash, jobInput: job.input, jobHash: job.inputHash });
  const reserve = setup.store.reserveCall.bind(setup.store);
  setup.store.reserveCall = async (call, limits, nowIso, leaseUntil) => {
    // Synthetic pause after setting, before any arc reservation or paid send. No timer or rejected answer is needed.
    if (call.stageKey === "arc") return { kind: "blocked", code: "SERIES_DAILY_CAP" };
    return reserve(call, limits, nowIso, leaseUntil);
  };
  try {
    await setup.main.drive(job.id);
  } finally {
    setup.store.reserveCall = reserve;
  }
  expect(setup.seen.map((item) => item.stage)).toEqual(["research", "directions", "setting"]);
  expect(job).toMatchObject({ state: "partial", callsUsed: 3 });
  expect(setup.store.grants[0]).toMatchObject({ state: "stopped", callsUsed: 3, callBudget: 19 });
  return { created, job, frozen, calls: structuredClone(setup.store.calls), completed: structuredClone(setup.store.stages.filter((item) => item.state === "completed")) };
}

describe("series arc guidance: actual requests, strict refusals and frozen prompt history", () => {
  it("a new 60-episode plan and first batch send 19 calls with v2 guidance and the unchanged arc schema", async () => {
    const setup = await seriesSetup();
    expect((await setup.grant(SCOPE)).kind).toBe("created");
    expect(SERIES_WRITING_PROMPT_VERSION).toBe("ads.series-writing.prompt.v2");
    expect(setup.store.series[0]!.input.promptVersion).toBe(SERIES_WRITING_PROMPT_VERSION);
    expect(setup.store.jobs.every((job) => job.input.promptVersion === SERIES_WRITING_PROMPT_VERSION)).toBe(true);
    expect(setup.seen).toHaveLength(19);
    expect(setup.store.calls).toHaveLength(19);
    const exchange = setup.seen.find((item) => item.stage === "arc")!;
    expect(exchange.body).toMatchObject({ model: "m-1", response_format: { type: "json_object" }, stream: false });
    expect(exchange.user).toContain("提示版本：ads.series-writing.prompt.v2");
    expect(exchange.user).toContain(DEPENDENCY_RULE);
    expect(sentSchema(exchange)).toEqual(seriesJsonSchema("arc", 60).schema);
    const output = setup.store.stages.find((item) => item.stageKey === "arc")!.output;
    expect(output).toEqual(fixtureSeriesArc(60));
    expect(output).toMatchObject({ schema: SERIES_ARC_SCHEMA, foreshadowing: expect.arrayContaining([expect.objectContaining({ id: "FS3", dependsOn: ["FS2"] })]) });
    expect(setup.store.grants[0]).toMatchObject({ state: "completed", callsUsed: 19, callBudget: 19 });
    expect(setup.store.plans).toHaveLength(1);
    expect(setup.store.ledgers).toHaveLength(1);
    expect(await setup.view()).toMatchObject({ written: 3, completion: "partial" });
    expect(setup.seen.some((item) => item.stage === "final_review" || item.stage === "episode:4")).toBe(false);
  });

  it.each([
    ["same-episode dependency", 20],
    ["later dependency", 19],
  ] as const)("%s is refused on call four, stores no refused answer, and never retries", async (_label, payoffEpisode) => {
    const arc: SeriesArc = { ...fixtureSeriesArc(60), foreshadowing: [
      ...fixtureSeriesArc(60).foreshadowing,
      { id: "FS4", content: "合成前置伏笔", plantEpisode: 8, payoffEpisode: 20, dependsOn: [] },
      { id: "FS5", content: "合成拒收正文标记", plantEpisode: 7, payoffEpisode, dependsOn: ["FS4"] },
    ] };
    const original = structuredClone(arc);
    const setup = await seriesSetup({ override: (stage) => stage === "arc" ? deepseekAnswer(arc) : undefined });
    const created = await setup.grant(SCOPE);
    if (created.kind !== "created") throw new Error("synthetic grant was not created");
    const code = "plan_structure@foreshadowing[4].dependsOn";
    expect(setup.seen.map((item) => item.stage)).toEqual(["research", "directions", "setting", "arc"]);
    expect(setup.store.calls.map((item) => item.state)).toEqual(["completed", "completed", "completed", "rejected"]);
    expect(setup.store.calls.at(-1)).toMatchObject({ stageKey: "arc", errorCode: code, attemptNo: 1 });
    expect(setup.store.stages.find((item) => item.stageKey === "arc")).toMatchObject({ state: "rejected", errorCode: code, output: null, outputHash: null, dependsOn: null });
    expect(setup.store.jobs).toHaveLength(1);
    expect(setup.store.jobs[0]).toMatchObject({ state: "partial", errorCode: "plan_structure", callsUsed: 4 });
    expect(setup.store.grants[0]).toMatchObject({ state: "stopped", stopReason: "plan_structure", callsUsed: 4, callBudget: 19, input: { resendAllowance: 0 } });
    expect(setup.store.plans).toEqual([]);
    expect(setup.store.ledgers).toEqual([]);
    expect(JSON.stringify(await setup.snapshot())).not.toContain("合成拒收正文标记");
    expect(arc).toEqual(original);
    const before = structuredClone(await setup.snapshot());
    await setup.main.drive(created.jobId);
    await setup.main.maintain();
    expect(setup.seen).toHaveLength(4);
    expect(await setup.snapshot()).toEqual(before);
  });

  it("an explicitly resumed v1 job keeps its original prompt, frozen hashes and completed prefix; replay sends nothing", async () => {
    const setup = await seriesSetup();
    const { created, job, frozen, calls, completed } = await pauseHistoricalPlanBeforeArc(setup);
    const context = seriesPlanContext(setup.series.input, setup.store.stages.filter((item) => item.runId === job.id));
    const autoInput = seriesAutoInput(setup.series.input, job.input);
    const expectedPrompt = buildSeriesPrompt("arc", setup.series.input, context, autoInput, LEGACY_PROMPT);
    expect(await setup.resume(created.grant.id, "resume-v1")).toMatchObject({ kind: "ok", jobId: job.id });
    const exchange = setup.seen.find((item) => item.stage === "arc")!;
    expect(exchange.user).toBe(expectedPrompt.user);
    expect(exchange.user).toContain("提示版本：ads.series-writing.prompt.v1");
    expect(exchange.user).not.toContain(DEPENDENCY_RULE);
    expect(setup.seen).toHaveLength(19);
    expect(setup.store.calls.slice(0, 3)).toEqual(calls);
    for (const original of completed) expect(setup.store.stages.find((item) => item.runId === original.runId && item.stageKey === original.stageKey)).toEqual(original);
    expect(setup.store.series[0]).toMatchObject({ input: frozen.seriesInput, inputHash: frozen.seriesHash });
    expect(job).toMatchObject({ input: frozen.jobInput, inputHash: frozen.jobHash, state: "completed" });
    const batch = setup.store.jobs.find((item) => item.kind === "batch")!;
    expect(batch.input.promptVersion).toBe(SERIES_WRITING_PROMPT_VERSION);
    expect(setup.seen.find((item) => item.stage === "episode:1")!.user).toContain("提示版本：ads.series-writing.prompt.v2");
    const before = structuredClone(await setup.snapshot());
    expect(await setup.grant(SCOPE, HISTORICAL_GRANT_KEY, { base: null })).toMatchObject({ kind: "existing" });
    expect(await setup.resume(created.grant.id, "resume-v1")).toMatchObject({ kind: "replayed" });
    expect(await setup.snapshot()).toEqual(before);
    expect(setup.seen).toHaveLength(19);
  });

  it("a newly authorized job on an old series uses v2 while reusing the completed prefix without rewriting history", async () => {
    const setup = await seriesSetup();
    const { job, frozen, calls, completed } = await pauseHistoricalPlanBeforeArc(setup);
    const oldGrant = structuredClone(setup.store.grants[0]);
    const created = await setup.grant(SCOPE, NEW_GRANT_KEY, { base: null });
    expect(created.kind).toBe("created");
    expect(setup.seen).toHaveLength(19);
    expect(setup.seen.slice(3).map((item) => item.stage)).toEqual([
      "arc", ...Array.from({ length: 10 }, (_, index) => `outline:${String(index + 1)}`), "plan_review",
      "episode:1", "episode:2", "episode:3", "batch_review:1",
    ]);
    const currentJob = setup.store.jobs.find((item) => item.kind === "plan" && item.id !== job.id)!;
    expect(currentJob.input.promptVersion).toBe(SERIES_WRITING_PROMPT_VERSION);
    expect(setup.seen.find((item) => item.stage === "arc")!.user).toContain(DEPENDENCY_RULE);
    expect(currentJob.input.reused.map((item) => item.stageKey)).toEqual(["sources", "research", "directions", "setting"]);
    expect(setup.store.calls.slice(0, 3)).toEqual(calls);
    for (const original of completed) expect(setup.store.stages.find((item) => item.runId === original.runId && item.stageKey === original.stageKey)).toEqual(original);
    expect(setup.store.grants[0]).toEqual(oldGrant);
    expect(setup.store.grants[1]).toMatchObject({ state: "completed", callsUsed: 16, callBudget: 19 });
    expect(setup.store.series[0]).toMatchObject({ input: frozen.seriesInput, inputHash: frozen.seriesHash });
    expect(job).toMatchObject({ input: frozen.jobInput, inputHash: frozen.jobHash, state: "partial" });
  });
});
