import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { seriesScopeCalls, type SeriesEpisode, type SeriesScope } from "@ai-drama/contracts";
import { PersistenceError } from "@ai-drama/database";
import { buildSeriesJob, nextSeriesJob, seriesCurrentPlan, seriesFinalBasis, seriesJobUpstreamChange, type SeriesView } from "@ai-drama/domain";
import { InMemorySeriesWritingStore, SeriesWritingEngine, titleWritingProviderConfigs } from "@ai-drama/providers";
import { seriesFixtureTransport, type SeriesFixtureExchange, type SeriesFixturePlan } from "@ai-drama/providers/title-writing-fixtures";
import { SeriesWritingService } from "./series-writing.service";

/**
 * Direct regressions of the review findings 1–6 (model double, in-process store; no network, no database). The same
 * paths run on PostgreSQL in series-writing.acceptance.spec.ts.
 */
const WS = "11111111-1111-4111-8111-111111111111";
const TOKEN = "operator-token-0123456789";
const START = Date.parse("2026-10-22T00:00:00Z");
const CONTEXT = (key?: string) => ({ actorId: "server-owner", traceId: "t", ...(key ? { idempotencyKey: key } : {}) });
const providers = titleWritingProviderConfigs({ DEEPSEEK_API_KEY: "sk-deepseek-test-0123456789", TITLE_WRITING_DEEPSEEK_MODELS: "m-1" });

function setup(options: { override?: (stage: string, attempt: number) => { status: number; body: unknown } | undefined; plan?: SeriesFixturePlan } = {}) {
  const store = new InMemorySeriesWritingStore();
  const seen: SeriesFixtureExchange[] = [];
  let clock = START;
  const now = () => new Date(clock);
  const engine = (executorId = "executor-a") => new SeriesWritingEngine({ workspaceId: WS, store, providers, executorId, leaseMs: 240_000, clock: now,
    transport: seriesFixtureTransport({ seen, ...(options.override ? { override: options.override } : {}), ...(options.plan ? { plan: options.plan } : {}) }),
    maxCallsPerDay: 1_000, maxActiveRuns: 2 });
  const pending: Array<() => Promise<void>> = [];
  const service = new SeriesWritingService({
    workspaceId: WS, enabled: true, operatorToken: TOKEN, defaultProvider: "deepseek", providers, store, engine: engine(), clock: now,
    projects: {
      getProject: async (_workspaceId: string, projectId: string) => {
        if (!store.projects.has(projectId)) throw new PersistenceError("NOT_FOUND", "Project not found");
        return { id: projectId } as never;
      },
      episodePlanReady: async () => true,
    },
    maxCallsPerDay: 1_000, maxActiveRuns: 2, research: { fetchEnabled: false, allowedHosts: [] },
    schedule: (work) => { pending.push(work); },
  });
  const settle = async () => { while (pending.length > 0) await pending.shift()!(); };
  return { store, service, seen, settle, engine, tick: (ms: number) => { clock += ms; }, now };
}

type Setup = ReturnType<typeof setup>;
const viewOf = (body: unknown) => (body as { series: SeriesView }).series;

async function work(s: Setup, episodeCount: number): Promise<SeriesView> {
  const result = await s.service.create({ title: "回归样例", episodeCount, episodeSeconds: 60 }, TOKEN, CONTEXT(randomUUID()));
  expect(result.status).toBe(201);
  return viewOf(result.body);
}

async function current(s: Setup, projectId: string): Promise<SeriesView> {
  return viewOf((await s.service.get(projectId)).body);
}

async function grant(s: Setup, view: SeriesView, scope: SeriesScope, drive = true) {
  const normal = seriesScopeCalls(view.episodeCount, scope);
  const result = await s.service.grant(view.projectId, { scope, normalCalls: normal, resendAllowance: 0, callBudget: normal, providerKey: "deepseek", model: "m-1",
    basePlanRevisionId: view.plan?.revisionId ?? null }, TOKEN, CONTEXT(randomUUID()));
  if (drive) await s.settle();
  return result;
}

/** A person's ledger for batch b: the current one (changed or not), summaries for the versions the page shows. */
async function confirmLedger(s: Setup, projectId: string, batchNo: number, change = false) {
  const view = await current(s, projectId);
  const batch = view.batches[batchNo - 1]!;
  const content = structuredClone(batch.ledger.revision!.content);
  if (change) content.props = content.props.map((item) => ({ ...item, state: "人工改过的状态" }));
  return s.service.saveLedger(projectId, { batchNo, baseLedgerRevisionId: batch.ledger.revision!.id, content,
    summaries: view.episodes.slice(batch.first - 1, batch.last).map((item) => ({ episodeNo: item.episodeNo, summary: "人工确认的概要" })),
    // A page could only send what it once saw; when nothing is confirmable now it has nothing current to send.
    expectedBasis: batch.ledgerBasis ?? { opened: "none" } }, CONTEXT());
}

async function decide(s: Setup, projectId: string, target: string, expectedBasis: Record<string, string> | null) {
  return s.service.decide(projectId, { target, note: "人工复核", expectedBasis }, CONTEXT());
}

function savePlan(s: Setup, view: SeriesView, story: "from_plan" | "adopt_current", logline?: string) {
  const content = structuredClone(view.plan!.content);
  if (logline) content.setting.logline = logline;
  return s.service.savePlan(view.projectId, { basePlanRevisionId: view.plan!.revisionId, baseStoryRevisionId: view.story.current?.revisionId ?? null, story, content }, CONTEXT());
}

describe("1. a person's plan revision is bound to a new story DRAFT that placement follows", () => {
  it("manual plan → new story DRAFT → person reviews the plan and approves the story → batch placed as DRAFT from that story; old plan and story kept", async () => {
    const s = setup();
    const view = await work(s, 6);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    const before = await current(s, view.projectId);
    const project = s.store.projects.get(view.projectId)!;
    const oldStory = project.currentStoryId!;
    s.store.approveCurrentStory(view.projectId);
    expect((await savePlan(s, before, "from_plan", "人工改写后的一句话故事")).status).toBe(201);
    const after = await current(s, view.projectId);
    expect(after.plan).toMatchObject({ revisionNo: 2, origin: "manual", status: "unreviewed", storySave: "saved" });
    expect(after.plan!.storyRevisionId).not.toBe(oldStory);
    expect(after.story).toMatchObject({ status: "ok", current: { revisionId: after.plan!.storyRevisionId, reviewStatus: "DRAFT" }, approved: { revisionId: oldStory } });
    // The new story is a DRAFT of its own: the old approval is not inherited.
    expect(project.stories.find((item) => item.id === after.plan!.storyRevisionId)).toMatchObject({ reviewStatus: "DRAFT" });
    expect(project.stories.find((item) => item.id === after.plan!.storyRevisionId)!.text).toContain(after.plan!.revisionId);
    // The batch was written on plan revision 1: its ledger and review wait for the new plan (round 3, finding 5).
    expect((await s.service.placeBatch(view.projectId, 1, {}, CONTEXT())).body).toMatchObject({ error: { code: "SERIES_NOT_READY", details: { reason: "ledger_stale" } } });
    expect((await decide(s, view.projectId, "plan", after.plan!.decisionBasis)).status).toBe(201);
    s.store.approveCurrentStory(view.projectId);
    expect((await s.service.placeBatch(view.projectId, 1, {}, CONTEXT())).body).toMatchObject({ error: { code: "SERIES_NOT_READY", details: { reason: "ledger_stale" } } });
    expect(project.episodes.get(1)!.scripts).toHaveLength(0);
    expect((await confirmLedger(s, view.projectId, 1)).status).toBe(201);
    expect((await decide(s, view.projectId, "batch:1", (await current(s, view.projectId)).batches[0]!.decisionBasis)).status).toBe(201);
    const placed = await s.service.placeBatch(view.projectId, 1, {}, CONTEXT());
    expect(placed.body).toMatchObject({ placed: 3, conflicts: [] });
    const scripts = [1, 2, 3].map((episodeNo) => project.episodes.get(episodeNo)!.scripts[0]!);
    expect(scripts.every((item) => item.reviewStatus === "DRAFT" && item.sourceStoryRevisionId === after.plan!.storyRevisionId)).toBe(true);
    expect(s.store.plans).toHaveLength(2);
    expect(project.stories.map((item) => item.id)).toContain(oldStory);
    expect(project.stories.find((item) => item.id === oldStory)!.reviewStatus).toBe("APPROVED");
  });

  it("a story saved since the page was opened is a conflict: no plan revision, no story written", async () => {
    const s = setup();
    const view = await work(s, 3);
    await grant(s, view, { plan: true, batchFrom: null, batchTo: null, final: false });
    const page = await current(s, view.projectId);
    s.store.writeHumanStory(view.projectId, "另一个页面先保存的故事");
    const stories = s.store.projects.get(view.projectId)!.stories.length;
    expect((await savePlan(s, page, "from_plan", "页面上的改动")).body).toMatchObject({ error: { code: "SERIES_STORY_CONFLICT" } });
    expect((await savePlan(s, page, "adopt_current")).body).toMatchObject({ error: { code: "SERIES_STORY_CONFLICT" } });
    expect(s.store.plans).toHaveLength(1);
    expect(s.store.projects.get(view.projectId)!.stories).toHaveLength(stories);
  });
});

describe("2. a batch review is valid only on everything it read, the ledger before the batch included", () => {
  it("batch 1's ledger edited and batch 2's confirmed on it: batch 2's old review is stale until a person reviews it; then batch 3 is written", async () => {
    const s = setup();
    const view = await work(s, 9);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 2, final: false });
    const sent = s.seen.length;
    expect((await confirmLedger(s, view.projectId, 1, true)).status).toBe(201);
    let after = await current(s, view.projectId);
    expect(after.batches[1]!.ledger.status).toBe("stale");
    expect((await confirmLedger(s, view.projectId, 2)).status).toBe(201);
    after = await current(s, view.projectId);
    expect(after.batches.slice(0, 2).map((item) => item.ledger.status)).toEqual(["confirmed", "confirmed"]);
    // Batch 1's review read the plan's initial ledger, which did not change; batch 2's read batch 1's old ledger.
    expect(after.batches[0]!.review.status).toBe("passed");
    expect(after.batches[1]!.review.status).toBe("stale");
    expect(after.next.blockers).toEqual(["batch_review_stale:2"]);
    expect((await grant(s, after, { plan: false, batchFrom: 3, batchTo: 3, final: false })).body).toMatchObject({ error: { code: "SERIES_BLOCKED" } });
    // A ledger confirmation is no review: only a person's review on the full basis clears it, with no model call.
    expect(after.batches[1]!.decisionBasis).toMatchObject({ baseLedger: after.batches[0]!.ledger.revision!.contentHash, ledger: after.batches[1]!.ledger.revision!.contentHash });
    expect((await decide(s, view.projectId, "batch:2", after.batches[1]!.decisionBasis)).status).toBe(201);
    after = await current(s, view.projectId);
    expect(after.batches[1]!.review.status).toBe("cleared");
    expect(s.seen.length).toBe(sent);
    expect((await grant(s, after, { plan: false, batchFrom: 3, batchTo: 3, final: false })).status).toBe(201);
    expect(s.seen.slice(sent).map((item) => item.stage)).toEqual(["episode:7", "episode:8", "episode:9", "batch_review:3"]);
  });

  it("an old review does not become valid again when only the ledger after the batch changes back and forth", async () => {
    const s = setup();
    const view = await work(s, 6);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 2, final: false });
    const before = await current(s, view.projectId);
    const basis = before.batches[1]!.decisionBasis!;
    expect((await confirmLedger(s, view.projectId, 1, true)).status).toBe(201);
    // The page still shows the old basis: a review on it is refused, nothing recorded.
    expect((await decide(s, view.projectId, "batch:2", basis)).body).toMatchObject({ error: { code: "SERIES_DECISION_STALE" } });
    expect(s.store.decisions).toHaveLength(0);
  });
});

describe("3. a story replaced in the workbench stops new grants, resumes and the next send of a running job", () => {
  it("blocks every send until plan and story are bound again, the ledgers confirmed and the batches reviewed", async () => {
    let swap: (() => void) | null = null;
    const s = setup({ override: (stage) => { if (stage === "episode:5" && swap) { swap(); swap = null; } return undefined; } });
    const view = await work(s, 9);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    // A running job: the story is replaced while episode 5 is being written; the next send never happens.
    swap = () => { s.store.writeHumanStory(view.projectId, "工作台里人工另存的新故事"); };
    let sent = s.seen.length;
    expect((await grant(s, await current(s, view.projectId), { plan: false, batchFrom: 2, batchTo: 3, final: false })).status).toBe(201);
    expect(s.seen.slice(sent).map((item) => item.stage)).toEqual(["episode:4", "episode:5"]);
    let after = await current(s, view.projectId);
    expect(after.story.status).toBe("changed");
    const stopped = after.grants.find((item) => item.scope.batchFrom === 2)!;
    expect(stopped).toMatchObject({ state: "stopped", stopReason: "upstream_story_changed" });
    // A resume and a new grant send nothing.
    sent = s.seen.length;
    expect((await s.service.resume(view.projectId, stopped.grantId, {}, TOKEN, CONTEXT(randomUUID()))).body)
      .toMatchObject({ error: { code: "SERIES_UPSTREAM_CHANGED", details: { reason: "upstream_story_changed" } } });
    expect((await grant(s, after, { plan: false, batchFrom: 2, batchTo: 2, final: false })).body).toMatchObject({ error: { code: "SERIES_BLOCKED" } });
    await s.settle();
    expect(s.seen.length).toBe(sent);
    expect(after.next.blockers).toContain("story_changed");
    // The ledger cannot be confirmed against a story the plan is not bound to.
    expect((await confirmLedger(s, view.projectId, 1)).body).toMatchObject({ error: { code: "SERIES_LEDGER_BLOCKED", details: { reason: "story_changed" } } });
    // A person binds the workbench story to the plan: a new plan revision; the earlier ledgers and reviews need a person again.
    expect((await savePlan(s, after, "adopt_current")).status).toBe(201);
    after = await current(s, view.projectId);
    expect(after.story.status).toBe("ok");
    expect(after.plan).toMatchObject({ revisionNo: 2, status: "unreviewed", storyRevisionId: after.story.current!.revisionId });
    expect(after.batches[0]!.ledger.status).toBe("stale");
    expect(after.batches[0]!.review.status).toBe("stale");
    expect(after.next.blockers).toEqual(expect.arrayContaining(["plan_unreviewed", "ledger_stale:1", "batch_review_stale:1"]));
    expect((await decide(s, view.projectId, "plan", after.plan!.decisionBasis)).status).toBe(201);
    expect((await confirmLedger(s, view.projectId, 1)).status).toBe(201);
    after = await current(s, view.projectId);
    expect((await decide(s, view.projectId, "batch:1", after.batches[0]!.decisionBasis)).status).toBe(201);
    after = await current(s, view.projectId);
    expect(after.next).toMatchObject({ batchNo: 2, blockers: [] });
    expect(s.seen.length).toBe(sent);
    // The stopped job's history stays; episodes written on the replaced story are not taken over: the batch is written again.
    expect((await grant(s, after, { plan: false, batchFrom: 2, batchTo: 2, final: false })).status).toBe(201);
    expect(s.seen.slice(sent).map((item) => item.stage)).toEqual(["episode:4", "episode:5", "episode:6", "batch_review:2"]);
    expect(s.store.calls.filter((item) => item.stageKey === "episode:4")).toHaveLength(2);
  });

  it("a placed script made STALE by a new story is never read as its model version", async () => {
    const s = setup();
    const view = await work(s, 6);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    s.store.approveCurrentStory(view.projectId);
    expect((await s.service.placeBatch(view.projectId, 1, {}, CONTEXT())).body).toMatchObject({ placed: 3 });
    const page = await current(s, view.projectId);
    expect((await savePlan(s, page, "from_plan", "人工改写")).status).toBe(201);
    const after = await current(s, view.projectId);
    expect(after.episodes.slice(0, 3).map((item) => item.state)).toEqual(["source_stale", "source_stale", "source_stale"]);
    expect(after.batches[0]!.sourceStaleEpisodes).toEqual([1, 2, 3]);
    expect(after.next.blockers).toContain("episode_source_stale:1");
    expect((await confirmLedger(s, view.projectId, 1)).body).toMatchObject({ error: { code: "SERIES_LEDGER_BLOCKED", details: { reason: "episode_source_stale" } } });
  });
});

describe("4. a review is recorded only on the versions the person's page showed", () => {
  it("plan: page A saw revision 1, page B saved revision 2; A's review is refused, nothing recorded, the plan stays unreviewed", async () => {
    const s = setup();
    const view = await work(s, 6);
    await grant(s, view, { plan: true, batchFrom: null, batchTo: null, final: false });
    const pageA = await current(s, view.projectId);
    expect((await savePlan(s, pageA, "from_plan", "B 页面保存的第二版")).status).toBe(201);
    expect((await decide(s, view.projectId, "plan", pageA.plan!.decisionBasis)).body).toMatchObject({ error: { code: "SERIES_DECISION_STALE" } });
    expect(s.store.decisions).toHaveLength(0);
    expect((await current(s, view.projectId)).plan!.status).toBe("unreviewed");
    expect((await s.service.decide(view.projectId, { target: "plan", note: "x" }, CONTEXT())).status).toBe(400);
  });

  it("batch: page A saw the episode B edits; A's review is refused", async () => {
    const s = setup();
    const view = await work(s, 6);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    s.store.approveCurrentStory(view.projectId);
    await s.service.placeBatch(view.projectId, 1, {}, CONTEXT());
    s.store.writeHumanScript(view.projectId, 2, "第一次人工修改");
    expect((await confirmLedger(s, view.projectId, 1)).status).toBe(201);
    const pageA = await current(s, view.projectId);
    expect(pageA.batches[0]!.review.status).toBe("stale");
    s.store.writeHumanScript(view.projectId, 2, "B 页面又改了一次");
    expect((await decide(s, view.projectId, "batch:1", pageA.batches[0]!.decisionBasis)).body).toMatchObject({ error: { code: "SERIES_DECISION_STALE" } });
    expect(s.store.decisions).toHaveLength(0);
  });

  it("final: page A saw the final basis, B changed the last ledger; A's review is refused; on the current basis it is recorded", async () => {
    const s = setup();
    const view = await work(s, 3);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 1, final: true });
    const pageA = await current(s, view.projectId);
    expect(pageA.final.decisionBasis).toMatchObject({ plan: pageA.plan!.contentHash, story: pageA.plan!.storyHash });
    expect((await confirmLedger(s, view.projectId, 1, true)).status).toBe(201);
    expect((await decide(s, view.projectId, "final", pageA.final.decisionBasis)).body).toMatchObject({ error: { code: "SERIES_DECISION_STALE" } });
    expect(s.store.decisions).toHaveLength(0);
    const pageB = await current(s, view.projectId);
    expect(pageB.final.status).toBe("stale");
    expect((await decide(s, view.projectId, "final", pageB.final.decisionBasis)).status).toBe(201);
    expect((await current(s, view.projectId)).final.status).toBe("cleared");
  });
});

describe("5. the current package carries the actual current story", () => {
  it("JSON and Markdown both carry the workbench story text, its hash and review state; an approved story that differs is listed apart", async () => {
    const s = setup();
    const view = await work(s, 3);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    s.store.approveCurrentStory(view.projectId);
    const planStory = s.store.projects.get(view.projectId)!.currentStoryId!;
    s.store.writeHumanStory(view.projectId, "工作台人工修改后的故事正文");
    const json = JSON.parse((await s.service.package(view.projectId, "json")).download!.text) as { story: Record<string, unknown> & {
      current: { text: string; reviewStatus: string; relationToPlan: string; contentHash: string }; approved: { revisionId: string; text: string; relationToPlan: string } } };
    expect(json.story).toMatchObject({ binding: "changed", planStory: { revisionId: planStory } });
    expect(json.story.current).toMatchObject({ text: "工作台人工修改后的故事正文", reviewStatus: "DRAFT", relationToPlan: "not_plan_story" });
    expect(json.story.current.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(json.story.approved).toMatchObject({ revisionId: planStory, relationToPlan: "plan_story" });
    expect(json.story.approved.text).toContain("系列规划修订");
    const markdown = (await s.service.package(view.projectId, "markdown")).download!.text;
    expect(markdown).toContain("工作台人工修改后的故事正文");
    expect(markdown).toContain("不是规划绑定的故事");
    expect(markdown).toContain("已批准故事");
    expect(markdown).toContain("规划修订中的梗概");
  });
});

describe("6. a reservation lost before its send is given back; a maybe-sent call never is", () => {
  it("the batch still finishes in its own four calls; recovery twice gives back once; the lost executor cannot submit; the daily count agrees", async () => {
    const s = setup();
    const view = await work(s, 6);
    await grant(s, view, { plan: true, batchFrom: null, batchTo: null, final: false });
    expect((await grant(s, await current(s, view.projectId), { plan: false, batchFrom: 1, batchTo: 1, final: false }, false)).status).toBe(201);
    const job = s.store.jobs.find((item) => item.kind === "batch")!;
    const nowIso = s.now().toISOString();
    const lease = new Date(START + 1_000).toISOString();
    expect(await s.store.claimJob(WS, job.id, "dead", nowIso, lease)).toBe(true);
    const call = { id: randomUUID(), runId: job.id, grantId: job.grantId, seriesId: job.seriesId, workspaceId: WS, stageKey: "episode:1", attemptNo: 1, providerKey: "deepseek" as const,
      model: "m-1", requestHash: "0".repeat(64), state: "reserved" as const, executorId: "dead", providerRequestId: null, responseModel: null,
      usage: { status: "unknown" as const, inputTokens: null, outputTokens: null, totalTokens: null }, errorCode: null, createdAt: nowIso, finishedAt: null };
    expect(await s.store.reserveCall(call, { sinceIso: nowIso, maxCallsPerDay: 100 }, nowIso, lease)).toEqual({ kind: "reserved" });
    s.tick(5_000);
    expect(await s.store.recoverExpired(WS, s.now().toISOString())).toBe(1);
    expect(await s.store.recoverExpired(WS, s.now().toISOString())).toBe(0);
    expect(s.store.jobs.find((item) => item.id === job.id)).toMatchObject({ callsUsed: 0 });
    expect(s.store.grants.find((item) => item.id === job.grantId)).toMatchObject({ callsUsed: 0 });
    // The lost executor's reservation is closed for good: it can neither submit nor finish.
    expect(await s.store.markCallSubmitted(WS, call.id, "dead", s.now().toISOString(), new Date(START + 600_000).toISOString())).toBe("lost");
    const sent = s.seen.length;
    await s.engine("executor-b").maintain();
    const after = await current(s, view.projectId);
    expect(s.seen.length - sent).toBe(4);
    expect(after.grants.find((item) => item.grantId === job.grantId)).toMatchObject({ state: "completed", callsUsed: 4, callBudget: 4 });
    // The lost reservation stays in the record, rejected before its send, and out of every count.
    expect(s.store.calls.find((item) => item.id === call.id)).toMatchObject({ state: "rejected", errorCode: "executor_lost_before_send" });
    expect(after.budget.callsUsed).toBe(s.store.calls.filter((item) => item.errorCode !== "executor_lost_before_send").length);
  });

  it("a submitted call whose executor is lost is unknown: nothing is given back and nothing is resent without a person", async () => {
    const s = setup();
    const view = await work(s, 3);
    await grant(s, view, { plan: true, batchFrom: null, batchTo: null, final: false });
    expect((await grant(s, await current(s, view.projectId), { plan: false, batchFrom: 1, batchTo: 1, final: false }, false)).status).toBe(201);
    const job = s.store.jobs.find((item) => item.kind === "batch")!;
    const nowIso = s.now().toISOString();
    const lease = new Date(START + 1_000).toISOString();
    expect(await s.store.claimJob(WS, job.id, "dead", nowIso, lease)).toBe(true);
    const call = { id: randomUUID(), runId: job.id, grantId: job.grantId, seriesId: job.seriesId, workspaceId: WS, stageKey: "episode:1", attemptNo: 1, providerKey: "deepseek" as const,
      model: "m-1", requestHash: "0".repeat(64), state: "reserved" as const, executorId: "dead", providerRequestId: null, responseModel: null,
      usage: { status: "unknown" as const, inputTokens: null, outputTokens: null, totalTokens: null }, errorCode: null, createdAt: nowIso, finishedAt: null };
    await s.store.reserveCall(call, { sinceIso: nowIso, maxCallsPerDay: 100 }, nowIso, lease);
    expect(await s.store.markCallSubmitted(WS, call.id, "dead", nowIso, lease)).toBe("submitted");
    s.tick(5_000);
    const sent = s.seen.length;
    await s.engine("executor-b").maintain();
    expect(s.seen.length).toBe(sent);
    expect(s.store.grants.find((item) => item.id === job.grantId)).toMatchObject({ state: "stopped", callsUsed: 1 });
    expect(s.store.calls.find((item) => item.id === call.id)).toMatchObject({ state: "unknown" });
  });
});

/** What page A sends when it saves the ledger editor it opened earlier: the frozen basis and parent, its own content and summaries. */
function saveFromEditor(s: Setup, projectId: string, opened: SeriesView, batchNo: number) {
  const batch = opened.batches[batchNo - 1]!;
  return s.service.saveLedger(projectId, { batchNo, baseLedgerRevisionId: batch.ledger.revision!.id, content: batch.ledger.revision!.content,
    summaries: opened.episodes.slice(batch.first - 1, batch.last).map((item) => ({ episodeNo: item.episodeNo, summary: "A 页面写的概要" })),
    expectedBasis: batch.ledgerBasis! }, CONTEXT());
}

describe("round 2, finding 1: a ledger is confirmed only on the versions its editor was opened on", () => {
  it("A opens the editor, B saves another script of the batch, A's save is refused: no revision, no summary, the batch stays blocked", async () => {
    const s = setup();
    const view = await work(s, 6);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    s.store.approveCurrentStory(view.projectId);
    await s.service.placeBatch(view.projectId, 1, {}, CONTEXT());
    s.store.writeHumanScript(view.projectId, 2, "A 页面看到的版本");
    const pageA = await current(s, view.projectId);
    expect(pageA.batches[0]!.ledgerBasis).toMatchObject({ "episodeRef:2": expect.stringMatching(/^script:/), ledgerRevision: pageA.batches[0]!.ledger.revision!.id });
    s.store.writeHumanScript(view.projectId, 2, "B 页面另存的版本");
    const ledgers = s.store.ledgers.length;
    expect((await saveFromEditor(s, view.projectId, pageA, 1)).body).toMatchObject({ error: { code: "SERIES_LEDGER_STALE" } });
    expect(s.store.ledgers).toHaveLength(ledgers);
    const after = await current(s, view.projectId);
    expect(after.batches[0]!.ledger.status).toBe("pending_confirmation");
    expect(after.next.blockers).toContain("ledger_pending_confirmation:1");
    expect(after.batches[0]!.ledgerBasis).not.toEqual(pageA.batches[0]!.ledgerBasis);
    // Read again and confirmed on the version B saved: accepted, bound to that version.
    expect((await saveFromEditor(s, view.projectId, after, 1)).status).toBe(201);
    const saved = s.store.ledgers.at(-1)!;
    expect(saved.summaries.find((item) => item.episodeNo === 2)!.versionHash).toBe(after.batches[0]!.ledgerBasis!["episode:2"]);
  });

  it.each([
    ["the plan (bound again to the same story)", "plan"],
    ["the story (replaced in the workbench)", "story"],
    ["the previous batch's ledger", "previous"],
    ["the batch's own ledger", "target"],
  ] as const)("a change of %s since the editor was opened refuses the save; nothing is written", async (_label, change) => {
    const s = setup();
    const view = await work(s, 6);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 2, final: false });
    const pageA = await current(s, view.projectId);
    if (change === "plan") expect((await savePlan(s, pageA, "adopt_current")).status).toBe(201);
    if (change === "story") s.store.writeHumanStory(view.projectId, "B 另存的故事");
    if (change === "previous") expect((await confirmLedger(s, view.projectId, 1, true)).status).toBe(201);
    if (change === "target") expect((await confirmLedger(s, view.projectId, 2)).status).toBe(201);
    const ledgers = s.store.ledgers.length;
    const refused = await saveFromEditor(s, view.projectId, pageA, 2);
    expect(refused.status).toBe(409);
    expect(["SERIES_LEDGER_STALE", "SERIES_LEDGER_BLOCKED", "SERIES_EDIT_CONFLICT"]).toContain((refused.body as { error: { code: string } }).error.code);
    expect(s.store.ledgers).toHaveLength(ledgers);
  });

  it("with nothing changed the confirmation is saved as a new revision; review and the next batch follow, with no model call", async () => {
    const s = setup();
    const view = await work(s, 9);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 2, final: false });
    s.store.approveCurrentStory(view.projectId);
    await s.service.placeBatch(view.projectId, 1, {}, CONTEXT());
    s.store.writeHumanScript(view.projectId, 2, "人工修改的第 2 集");
    const sent = s.seen.length;
    const opened = await current(s, view.projectId);
    expect((await saveFromEditor(s, view.projectId, opened, 1)).status).toBe(201);
    const after = await current(s, view.projectId);
    expect(after.batches[0]!.ledger.status).toBe("confirmed");
    expect((await decide(s, view.projectId, "batch:1", after.batches[0]!.decisionBasis)).status).toBe(201);
    expect(s.seen.length).toBe(sent);
    expect((await grant(s, await current(s, view.projectId), { plan: false, batchFrom: 3, batchTo: 3, final: false })).status).toBe(201);
    expect(s.seen.length - sent).toBe(4);
  });
});

describe("round 2, finding 2: a story replaced after completion revokes the completion until plan and story are bound again", () => {
  it("text complete, then a new workbench story: partial, the final review stale (its output kept), the same in the view, JSON and Markdown", async () => {
    const s = setup();
    const view = await work(s, 6);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 2, final: true });
    const done = await current(s, view.projectId);
    expect(done).toMatchObject({ completion: "text_complete", final: { status: "passed" }, attention: [] });
    const finalStage = structuredClone(s.store.stages.find((item) => item.stageKey === "final_review")!);
    const calls = structuredClone(s.store.calls);
    s.store.writeHumanStory(view.projectId, "工作台另存的新故事");
    const after = await current(s, view.projectId);
    expect(after.story.status).toBe("changed");
    expect(after.completion).toBe("partial");
    expect(after.completionLabel).toContain("待同步");
    expect(after.final).toMatchObject({ status: "stale", previousPassed: true, decisionBasis: null });
    expect(after.attention).toEqual(expect.arrayContaining(["story_changed", "final_review_stale"]));
    expect(after.final.output).toEqual(done.final.output);
    expect(s.store.stages.find((item) => item.stageKey === "final_review")).toEqual(finalStage);
    expect(s.store.calls).toEqual(calls);
    const json = JSON.parse((await s.service.package(view.projectId, "json")).download!.text) as { completion: { level: string; attention: string[] };
      finalReview: { status: string; passed: boolean; note: string } };
    expect(json.completion).toMatchObject({ level: "partial", attention: expect.arrayContaining(["story_changed"]) });
    expect(json.finalReview).toMatchObject({ status: "stale", passed: true });
    expect(json.finalReview.note).toContain("不代表当前依赖有效");
    const markdown = (await s.service.package(view.projectId, "markdown")).download!.text;
    expect(markdown).toContain("待办：story_changed");
    expect(markdown).toContain("不代表当前依赖有效");
    expect(markdown).not.toContain("全剧文本完成（");
    // No review stands in for binding plan and story again: the bases the page had are refused, nothing recorded.
    for (const [target, basis] of [["final", done.final.decisionBasis], ["plan", done.plan!.decisionBasis], ["batch:1", done.batches[0]!.decisionBasis]] as const) {
      expect((await decide(s, view.projectId, target, basis)).status).toBe(409);
    }
    expect(s.store.decisions).toHaveLength(0);
    expect((await current(s, view.projectId)).completion).toBe("partial");
  });

  it("approved complete, then a new story: partial, the placed scripts' sources stale", async () => {
    const s = setup();
    const view = await work(s, 6);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 2, final: true });
    s.store.approveCurrentStory(view.projectId);
    for (const batchNo of [1, 2]) expect((await s.service.placeBatch(view.projectId, batchNo, {}, CONTEXT())).body).toMatchObject({ placed: 3 });
    for (let episodeNo = 1; episodeNo <= 6; episodeNo += 1) s.store.approveScript(view.projectId, episodeNo);
    expect((await current(s, view.projectId)).completion).toBe("approved_complete");
    s.store.writeHumanStory(view.projectId, "工作台另存的新故事");
    const after = await current(s, view.projectId);
    expect(after.completion).toBe("partial");
    expect(after.episodes.every((item) => item.state === "source_stale")).toBe(true);
    expect(after.attention).toEqual(expect.arrayContaining(["story_changed", "episode_source_stale:1", "episode_source_stale:2"]));
  });

  it("restored only after binding plan and story, confirming the ledgers and reviewing the batches and the final review; no model call", async () => {
    const s = setup();
    const view = await work(s, 6);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 2, final: true });
    s.store.writeHumanStory(view.projectId, "工作台另存的新故事");
    const sent = s.seen.length;
    let page = await current(s, view.projectId);
    expect((await savePlan(s, page, "adopt_current")).status).toBe(201);
    page = await current(s, view.projectId);
    expect(page.completion).toBe("partial");
    expect((await decide(s, view.projectId, "plan", page.plan!.decisionBasis)).status).toBe(201);
    for (const batchNo of [1, 2]) expect((await confirmLedger(s, view.projectId, batchNo)).status).toBe(201);
    expect((await current(s, view.projectId)).completion).toBe("partial");
    for (const batchNo of [1, 2]) {
      page = await current(s, view.projectId);
      expect((await decide(s, view.projectId, `batch:${String(batchNo)}`, page.batches[batchNo - 1]!.decisionBasis)).status).toBe(201);
    }
    page = await current(s, view.projectId);
    expect(page.final.status).toBe("stale");
    expect(page.completion).toBe("partial");
    expect((await decide(s, view.projectId, "final", page.final.decisionBasis)).status).toBe(201);
    page = await current(s, view.projectId);
    expect(page).toMatchObject({ completion: "text_complete", attention: [], final: { status: "cleared" } });
    expect(s.seen.length).toBe(sent);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Round 3 (review of 3335045): scheduling and authorization, formal placement, idempotency and the ledger, the final basis.

const REJECT = { status: 422, body: {} };

async function grantWith(s: Setup, view: SeriesView, scope: SeriesScope, resendAllowance: number) {
  const normal = seriesScopeCalls(view.episodeCount, scope);
  const result = await s.service.grant(view.projectId, { scope, normalCalls: normal, resendAllowance, callBudget: normal + resendAllowance, providerKey: "deepseek",
    model: "m-1", basePlanRevisionId: view.plan?.revisionId ?? null }, TOKEN, CONTEXT(randomUUID()));
  await s.settle();
  return result;
}

const stagesSent = (s: Setup, from: number) => s.seen.slice(from).map((item) => item.stage);
type LedgerContent = NonNullable<SeriesView["batches"][number]["ledger"]["revision"]>["content"];
type PlanContent = NonNullable<SeriesView["plan"]>["content"];

describe("round 3, 1: a person's script never stands in for the model stage and the batch review it skipped", () => {
  it("episode 3 refused with no resend left; the person writes it; a new grant finishes the batch's own stages; after the checks batch 2 follows", async () => {
    const s = setup({ override: (stage, attempt) => stage === "episode:3" && attempt === 1 ? REJECT : undefined });
    const view = await work(s, 6);
    await grantWith(s, view, { plan: true, batchFrom: 1, batchTo: 1, final: false }, 0);
    let page = await current(s, view.projectId);
    const old = page.grants[0]!;
    expect(old).toMatchObject({ state: "stopped" });
    // The old grant has no budget left for the batch's two remaining sends.
    expect((await s.service.resume(view.projectId, old.grantId, {}, TOKEN, CONTEXT(randomUUID()))).body).toMatchObject({ error: { code: "SERIES_BUDGET_EXHAUSTED" } });
    s.store.approveCurrentStory(view.projectId);
    const personScript = s.store.writeHumanScript(view.projectId, 3, "人工补写的第 3 集");
    page = await current(s, view.projectId);
    expect(page.written).toBe(3);
    // Batch 1 is still the next batch: its model stage of episode 3 and its batch review never ran.
    expect(page.next.batchNo).toBe(1);
    const sent = s.seen.length;
    const next = await grantWith(s, page, { plan: false, batchFrom: 1, batchTo: 1, final: false }, 0);
    expect(next.status).toBe(201);
    // Only what the stopped job did not finish is sent; episodes 1 and 2 are taken over, never sent again.
    expect(stagesSent(s, sent)).toEqual(["episode:3", "batch_review:1"]);
    page = await current(s, view.projectId);
    // The person's script stays the current version of episode 3; the model's stays apart, unadopted.
    expect(page.episodes[2]!.version).toMatchObject({ kind: "script" });
    expect(page.episodes[2]!.unadoptedModelDraft).toBe(true);
    expect(page.batches[0]!.ledger.status).toBe("pending_confirmation");
    expect(page.batches[0]!.review.status).toBe("stale");
    expect(page.next).toMatchObject({ batchNo: 2, blockers: ["ledger_pending_confirmation:1", "batch_review_stale:1"] });
    // The established checks: the person confirms the ledger and reviews the batch on what the page shows.
    expect((await confirmLedger(s, view.projectId, 1)).status).toBe(201);
    page = await current(s, view.projectId);
    expect((await decide(s, view.projectId, "batch:1", page.batches[0]!.decisionBasis)).status).toBe(201);
    page = await current(s, view.projectId);
    expect(page.next).toEqual({ batchNo: 2, blockers: [] });
    const before2 = s.seen.length;
    expect((await grantWith(s, page, { plan: false, batchFrom: 2, batchTo: 2, final: false }, 0)).status).toBe(201);
    expect(stagesSent(s, before2)).toEqual(["episode:4", "episode:5", "episode:6", "batch_review:2"]);
    // History kept: the old grant, its job and its rejected call; the person's script untouched.
    const snap = (await s.store.snapshot(WS, view.projectId))!;
    expect(snap.grants.find((item) => item.id === old.grantId)).toMatchObject({ state: "stopped", callsUsed: 9 });
    expect(snap.jobs.filter((job) => job.run.kind === "batch" && job.run.batchNo === 1).map((job) => job.run.state)).toEqual(["partial", "completed"]);
    expect(snap.jobs.flatMap((job) => job.calls).filter((call) => call.stageKey === "episode:3").map((call) => call.state)).toEqual(["rejected", "completed"]);
    expect(snap.episodes.find((item) => item.episodeNo === 3)!.currentScriptRevisionId).toBe(personScript);
  });
});

describe("round 3, 2: a planning grant superseded by a later plan is never resumed", () => {
  it("old plan job refused at setting (one resend kept); a new grant saves plan 1; the old grant's resume is refused with no send, job or plan", async () => {
    const s = setup({ override: (stage, attempt) => stage === "setting" && attempt === 1 ? REJECT : undefined });
    const view = await work(s, 6);
    await grantWith(s, view, { plan: true, batchFrom: null, batchTo: null, final: false }, 1);
    let page = await current(s, view.projectId);
    const old = page.grants[0]!;
    expect(old.state).toBe("stopped");
    expect((await grantWith(s, page, { plan: true, batchFrom: null, batchTo: null, final: false }, 1)).status).toBe(201);
    page = await current(s, view.projectId);
    expect(page.plan).toMatchObject({ revisionNo: 1, storySave: "saved" });
    expect(page.story.status).toBe("ok");
    const sent = s.seen.length;
    const jobs = s.store.jobs.length;
    const grants = structuredClone(s.store.grants);
    const resumed = await s.service.resume(view.projectId, old.grantId, {}, TOKEN, CONTEXT(randomUUID()));
    await s.settle();
    expect(resumed.status).toBe(409);
    expect(resumed.body).toMatchObject({ error: { code: "SERIES_UPSTREAM_CHANGED", details: { reason: "upstream_plan_superseded" } } });
    expect(s.seen.length).toBe(sent);
    expect(s.store.jobs).toHaveLength(jobs);
    expect(s.store.plans).toHaveLength(1);
    expect(s.store.grants).toEqual(grants);
    page = await current(s, view.projectId);
    expect(page.story.status).toBe("ok");
    expect(page.plan!.revisionNo).toBe(1);
  });

  it("a stopped plan grant nothing superseded still resumes", async () => {
    const s = setup({ override: (stage, attempt) => stage === "setting" && attempt === 1 ? REJECT : undefined });
    const view = await work(s, 6);
    await grantWith(s, view, { plan: true, batchFrom: null, batchTo: null, final: false }, 1);
    const old = (await current(s, view.projectId)).grants[0]!;
    const sent = s.seen.length;
    expect((await s.service.resume(view.projectId, old.grantId, {}, TOKEN, CONTEXT(randomUUID()))).status).toBe(200);
    await s.settle();
    expect(stagesSent(s, sent)).toEqual(["setting", "arc", "outline:1", "plan_review"]);
    expect((await current(s, view.projectId)).plan!.revisionNo).toBe(1);
  });
});

describe("round 3, 3: a new job's call cap counts what it will actually send", () => {
  it("6 episodes, plan only, refused at setting; a new grant (6 normal, 0 resend) takes over sources, research and directions and sends exactly the other 4", async () => {
    const s = setup({ override: (stage, attempt) => stage === "setting" && attempt === 1 ? REJECT : undefined });
    const view = await work(s, 6);
    await grantWith(s, view, { plan: true, batchFrom: null, batchTo: null, final: false }, 0);
    const page = await current(s, view.projectId);
    const sent = s.seen.length;
    expect((await grantWith(s, page, { plan: true, batchFrom: null, batchTo: null, final: false }, 0)).status).toBe(201);
    expect(stagesSent(s, sent)).toEqual(["setting", "arc", "outline:1", "plan_review"]);
    const after = await current(s, view.projectId);
    expect(after.plan).toMatchObject({ revisionNo: 1 });
    expect(after.grants[1]).toMatchObject({ state: "completed", callsUsed: 4, callBudget: 6 });
    const job = s.store.jobs.at(-1)!;
    expect(job).toMatchObject({ callCap: 4, callsUsed: 4, state: "completed" });
    const reused = s.store.stages.filter((stage) => stage.runId === job.id && stage.reusedFrom !== null).map((stage) => stage.stageKey);
    expect(reused).toEqual(["sources", "research", "directions"]);
    // sources is the local snapshot: never a model call, in either job.
    expect(s.store.calls.some((call) => call.stageKey === "sources")).toBe(false);
  });
});

describe("round 3, 4: placing a batch records the episodes a person's script already holds", () => {
  it("the person writes episode 2 before placing; ledger confirmed and batch reviewed; placement writes 1 and 3 and records 2 as a conflict, once", async () => {
    const s = setup();
    const view = await work(s, 6);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    s.store.approveCurrentStory(view.projectId);
    const personScript = s.store.writeHumanScript(view.projectId, 2, "人工先写的第 2 集");
    expect((await confirmLedger(s, view.projectId, 1)).status).toBe(201);
    let page = await current(s, view.projectId);
    expect((await decide(s, view.projectId, "batch:1", page.batches[0]!.decisionBasis)).status).toBe(201);
    const placed = await s.service.placeBatch(view.projectId, 1, {}, CONTEXT());
    expect(placed.body).toMatchObject({ placed: 2, conflicts: [2] });
    page = viewOf(placed.body);
    expect(page.batches[0]).toMatchObject({ placed: 2, conflicts: 1 });
    expect(page.episodes[1]).toMatchObject({ placed: "conflict", version: { kind: "script" } });
    const scripts = () => [1, 2, 3].map((episodeNo) => s.store.projects.get(view.projectId)!.episodes.get(episodeNo)!.scripts.length);
    expect(scripts()).toEqual([1, 1, 1]);
    // Clicked again: nothing more is written and nothing is left to do.
    expect((await s.service.placeBatch(view.projectId, 1, {}, CONTEXT())).body).toMatchObject({ placed: 0, conflicts: [] });
    expect(scripts()).toEqual([1, 1, 1]);
    expect(s.store.projects.get(view.projectId)!.episodes.get(2)!.currentScriptId).toBe(personScript);
    page = await current(s, view.projectId);
    expect(page.batches[0]!.placed + page.batches[0]!.conflicts).toBe(3);
  });
});

describe("round 3, 5: a batch is never placed on dependencies that are no longer current", () => {
  it("a manual plan (adopt_current) renames a person after the batch: no script is written until ledger and review are current; then the old plan's text is used", async () => {
    const s = setup();
    const view = await work(s, 6);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    s.store.approveCurrentStory(view.projectId);
    let page = await current(s, view.projectId);
    const content = structuredClone(page.plan!.content);
    content.setting.characters = content.setting.characters.map((item) => item.id === "C1" ? { ...item, name: "林大满" } : item);
    expect((await s.service.savePlan(view.projectId, { basePlanRevisionId: page.plan!.revisionId, baseStoryRevisionId: page.story.current!.revisionId,
      story: "adopt_current", content }, CONTEXT())).status).toBe(201);
    page = await current(s, view.projectId);
    expect(page.batches[0]).toMatchObject({ ledger: { status: "stale" }, review: { status: "stale" } });
    const refused = await s.service.placeBatch(view.projectId, 1, {}, CONTEXT());
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: "SERIES_NOT_READY" } });
    const written = () => [1, 2, 3].flatMap((episodeNo) => s.store.projects.get(view.projectId)!.episodes.get(episodeNo)!.scripts);
    expect(written()).toHaveLength(0);
    // The established process: the ledger confirmed and the batch reviewed on the new plan; the model text keeps its own plan's names.
    expect((await confirmLedger(s, view.projectId, 1)).status).toBe(201);
    page = await current(s, view.projectId);
    expect((await decide(s, view.projectId, "batch:1", page.batches[0]!.decisionBasis)).status).toBe(201);
    expect((await s.service.placeBatch(view.projectId, 1, {}, CONTEXT())).body).toMatchObject({ placed: 3, conflicts: [] });
    expect(written()).toHaveLength(3);
    expect(written().every((script) => script.text.includes("林小满") && !script.text.includes("林大满"))).toBe(true);
  });
});

describe("round 3, 7: a person's ledger keeps every planned person, prop, secret and foreshadowing", () => {
  async function batchDone() {
    const s = setup();
    const view = await work(s, 6);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    return { s, view };
  }

  async function save(s: Setup, projectId: string, edit: (content: LedgerContent) => void) {
    const page = await current(s, projectId);
    const batch = page.batches[0]!;
    const content = structuredClone(batch.ledger.revision!.content);
    edit(content);
    return s.service.saveLedger(projectId, { batchNo: 1, baseLedgerRevisionId: batch.ledger.revision!.id, content,
      summaries: page.episodes.slice(0, 3).map((item) => ({ episodeNo: item.episodeNo, summary: "人工确认的概要" })), expectedBasis: batch.ledgerBasis }, CONTEXT());
  }

  it.each<[string, (content: LedgerContent) => void, string]>([
    ["every person removed", (c) => { c.characters = []; }, "characters"],
    ["every prop removed", (c) => { c.props = []; }, "props"],
    ["every secret removed", (c) => { c.secrets = []; }, "secrets"],
    ["every foreshadowing removed", (c) => { c.foreshadowing = []; }, "foreshadowing"],
    ["prop P1 removed", (c) => { c.props = c.props.filter((item) => item.id !== "P1"); }, "props"],
    ["foreshadowing FS1 removed", (c) => { c.foreshadowing = c.foreshadowing.filter((item) => item.id !== "FS1"); }, "foreshadowing"],
    ["a prop listed twice", (c) => { c.props = [...c.props, c.props[0]!]; }, "props"],
    ["a secret listed twice", (c) => { c.secrets = [...c.secrets, c.secrets[0]!]; }, "secrets"],
    ["an unknown prop", (c) => { c.props = [...c.props, { id: "P9", holderId: null, state: "x" }]; }, "props"],
    ["a relationship pair listed twice", (c) => { c.relationships = [...c.relationships, { ...c.relationships[0]!, state: "仇敌" }]; }, "relationships"],
  ])("%s: refused, nothing saved", async (_label, edit, field) => {
    const { s, view } = await batchDone();
    const ledgers = s.store.ledgers.length;
    const saved = await save(s, view.projectId, edit);
    expect(saved.status).toBe(400);
    expect(saved.body).toMatchObject({ error: { code: "SERIES_INVALID_EDIT", details: { field } } });
    expect(s.store.ledgers).toHaveLength(ledgers);
  });

  it("a legitimate change of state (who holds a prop, where a person is) is saved", async () => {
    const { s, view } = await batchDone();
    const saved = await save(s, view.projectId, (c) => {
      c.props = c.props.map((item) => item.id === "P2" ? { ...item, holderId: "C1" } : item);
      c.characters = c.characters.map((item) => item.id === "C3" ? { ...item, whereabouts: "公交站" } : item);
    });
    expect(saved.status).toBe(201);
  });
});

describe("round 3, 9 and 10: a person's plan is held to unique directed relationships and strictly earlier dependencies", () => {
  async function planned() {
    const s = setup();
    const view = await work(s, 6);
    await grant(s, view, { plan: true, batchFrom: null, batchTo: null, final: false });
    return { s, page: await current(s, view.projectId) };
  }

  function revise(s: Setup, page: SeriesView, edit: (content: PlanContent) => void) {
    const content = structuredClone(page.plan!.content);
    edit(content);
    return s.service.savePlan(page.projectId, { basePlanRevisionId: page.plan!.revisionId, baseStoryRevisionId: page.story.current?.revisionId ?? null,
      story: "adopt_current", content }, CONTEXT());
  }

  const withFs3 = (c: PlanContent, dependsOn: string[]) => {
    c.arc.foreshadowing.push({ id: "FS3", content: "仓库角落的旧招牌", plantEpisode: 2, payoffEpisode: 6, dependsOn });
    c.outlines = c.outlines.map((item) => item.episodeNo === 2 ? { ...item, plants: [...item.plants, "FS3"] }
      : item.episodeNo === 6 ? { ...item, payoffs: [...item.payoffs, "FS3"] } : item);
  };

  it("C1→C2 twice (employer and enemy) is refused; C1→C2 with C2→C1 is accepted", async () => {
    const { s, page } = await planned();
    const twice = await revise(s, page, (c) => { c.setting.relationships.push({ from: "C1", to: "C2", relation: "仇敌", arc: "反目" }); });
    expect(twice.body).toMatchObject({ error: { code: "SERIES_INVALID_EDIT", details: { code: "duplicate_id", field: "relationships" } } });
    expect(s.store.plans).toHaveLength(1);
    const both = await revise(s, page, (c) => { c.setting.relationships.push({ from: "C2", to: "C1", relation: "店主与雇员", arc: "从隐瞒到坦白" }); });
    expect(both.status).toBe(201);
  });

  it("two foreshadowing entries paid in the same episode depending on each other are refused, and so is a one-way same-episode dependency", async () => {
    const { s, page } = await planned();
    const mutual = await revise(s, page, (c) => {
      withFs3(c, ["FS1"]);
      c.arc.foreshadowing = c.arc.foreshadowing.map((item) => item.id === "FS1" ? { ...item, dependsOn: ["FS3"] } : item);
    });
    expect(mutual.body).toMatchObject({ error: { code: "SERIES_INVALID_EDIT", details: { code: "plan_structure", field: "foreshadowing[0].dependsOn" } } });
    const oneWay = await revise(s, page, (c) => { withFs3(c, ["FS1"]); });
    expect(oneWay.body).toMatchObject({ error: { code: "SERIES_INVALID_EDIT", details: { code: "plan_structure", field: "foreshadowing[2].dependsOn" } } });
    expect(s.store.plans).toHaveLength(1);
  });
});

describe("round 3, 11: the final review stands only for the summaries it read", () => {
  it("only a person's summary changes after a passed final review: the final review is stale and the series no longer text complete; history kept, nothing sent", async () => {
    const s = setup();
    const view = await work(s, 6);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 2, final: false });
    s.store.approveCurrentStory(view.projectId);
    s.store.writeHumanScript(view.projectId, 2, "人工修改后的第 2 集");
    const summaryLedger = async (summary: string) => {
      const page = await current(s, view.projectId);
      const batch = page.batches[0]!;
      return s.service.saveLedger(view.projectId, { batchNo: 1, baseLedgerRevisionId: batch.ledger.revision!.id, content: batch.ledger.revision!.content,
        summaries: page.episodes.slice(0, 3).map((item) => ({ episodeNo: item.episodeNo, summary: item.episodeNo === 2 ? summary : item.summary ?? "人工确认的概要" })),
        expectedBasis: batch.ledgerBasis }, CONTEXT());
    };
    expect((await summaryLedger("概要 A：林小满第一次发现钥匙不见")).status).toBe(201);
    let page = await current(s, view.projectId);
    expect((await decide(s, view.projectId, "batch:1", page.batches[0]!.decisionBasis)).status).toBe(201);
    page = await current(s, view.projectId);
    expect((await grant(s, page, { plan: false, batchFrom: null, batchTo: null, final: true })).status).toBe(201);
    page = await current(s, view.projectId);
    expect(page).toMatchObject({ completion: "text_complete", final: { status: "passed" } });
    expect(s.seen.find((item) => item.stage === "final_review")!.user).toContain("概要 A：林小满第一次发现钥匙不见");
    const sent = s.seen.length;
    const finalStage = structuredClone(s.store.stages.find((item) => item.stageKey === "final_review")!);
    const ledgerHash = page.batches[0]!.ledger.revision!.contentHash;
    expect((await summaryLedger("概要 B：林小满怀疑老周拿走钥匙")).status).toBe(201);
    page = await current(s, view.projectId);
    // Only the summary changed: the ledger content and every script version are the same.
    expect(page.episodes[1]!.summary).toBe("概要 B：林小满怀疑老周拿走钥匙");
    expect(page.batches[0]!.ledger.revision!.contentHash).toBe(ledgerHash);
    expect(page.final).toMatchObject({ status: "stale", previousPassed: true });
    expect(page.completion).toBe("partial");
    expect(page.attention).toContain("final_review_stale");
    expect(s.store.stages.find((item) => item.stageKey === "final_review")).toEqual(finalStage);
    expect(s.seen.length).toBe(sent);
    // A person's final review on the basis the page now shows restores it, with no model call.
    expect((await decide(s, view.projectId, "final", page.final.decisionBasis)).status).toBe(201);
    expect((await current(s, view.projectId)).completion).toBe("text_complete");
    expect(s.seen.length).toBe(sent);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Round 4 (review of 9fd5e2f): the first final review is never a person's, and the package exports the saved text.

describe("round 4, 1: a person's review never stands in for the first model final review", () => {
  it("3 episodes, plan and batch 1 only: no final review ran, so no final basis is offered and a final decision is refused with nothing written", async () => {
    const s = setup();
    const view = await work(s, 3);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    const page = await current(s, view.projectId);
    expect(page.final).toMatchObject({ status: "none", output: null, decisionBasis: null });
    expect(page.completion).toBe("partial");
    expect(s.store.stages.filter((stage) => stage.stageKey === "final_review")).toHaveLength(0);
    // What the page could have sent: the basis a final review would read (the store never offers it as a decision basis).
    const basis = seriesFinalBasis((await s.store.snapshot(WS, view.projectId))!);
    expect(basis).not.toBeNull();
    const sent = s.seen.length;
    const refused = await decide(s, view.projectId, "final", basis);
    expect(refused.status).toBe(409);
    expect(s.store.decisions).toHaveLength(0);
    expect(s.seen.length).toBe(sent);
    expect((await current(s, view.projectId))).toMatchObject({ completion: "partial", final: { status: "none" } });
  });

  it("a final decision recorded without any final review output (as an older server could) never completes the series", async () => {
    const s = setup();
    const view = await work(s, 3);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    const snapshot = (await s.store.snapshot(WS, view.projectId))!;
    s.store.decisions.push({ id: randomUUID(), seriesId: snapshot.series.id, target: "final", basis: seriesFinalBasis(snapshot)!, note: "旧记录", createdBy: "server-owner",
      createdAt: new Date(START).toISOString() });
    const page = await current(s, view.projectId);
    expect(page.final.status).toBe("none");
    expect(page.completion).toBe("partial");
    expect(page.attention).toContain("final_review_missing");
  });

  it("the first final review is still sent from that basis; a later change makes it stale and a person's review then clears it", async () => {
    const s = setup();
    const view = await work(s, 3);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    let page = await current(s, view.projectId);
    const sent = s.seen.length;
    expect((await grant(s, page, { plan: false, batchFrom: null, batchTo: null, final: true })).status).toBe(201);
    expect(stagesOf(s, sent)).toEqual(["final_review"]);
    page = await current(s, view.projectId);
    expect(page).toMatchObject({ completion: "text_complete", final: { status: "passed" } });
    expect(page.final.decisionBasis).not.toBeNull();
    s.store.approveCurrentStory(view.projectId);
    s.store.writeHumanScript(view.projectId, 2, "人工修改后的第 2 集");
    expect((await confirmLedger(s, view.projectId, 1)).status).toBe(201);
    page = await current(s, view.projectId);
    expect((await decide(s, view.projectId, "batch:1", page.batches[0]!.decisionBasis)).status).toBe(201);
    page = await current(s, view.projectId);
    expect(page.final.status).toBe("stale");
    expect((await decide(s, view.projectId, "final", page.final.decisionBasis)).status).toBe(201);
    expect((await current(s, view.projectId))).toMatchObject({ completion: "text_complete", final: { status: "cleared" } });
  });
});

const stagesOf = (s: Setup, from: number) => s.seen.slice(from).map((item) => item.stage);

describe("round 4, 2: the current package exports the text actually saved, and model drafts on their own plan", () => {
  async function renamedAfterBatch() {
    const s = setup();
    const view = await work(s, 6);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    s.store.approveCurrentStory(view.projectId);
    let page = await current(s, view.projectId);
    const content = structuredClone(page.plan!.content);
    content.setting.characters = content.setting.characters.map((item) => item.id === "C1" ? { ...item, name: "林大满" } : item);
    expect((await s.service.savePlan(view.projectId, { basePlanRevisionId: page.plan!.revisionId, baseStoryRevisionId: page.story.current!.revisionId,
      story: "adopt_current", content }, CONTEXT())).status).toBe(201);
    page = await current(s, view.projectId);
    return { s, view, page };
  }

  type PackEpisode = { episodeNo: number; current: { source: string; text: string; workbench: { scriptRevisionId: string; contentHash: string } | null } | null;
    unadoptedModelDraft: { text: string } | null };
  const pack = async (s: Setup, projectId: string) => (JSON.parse((await s.service.package(projectId, "json")).download!.text) as { episodes: PackEpisode[] }).episodes;

  it("a model draft not in the workbench is formatted with the plan revision its job was written on", async () => {
    const { s, view } = await renamedAfterBatch();
    const episodes = await pack(s, view.projectId);
    expect(episodes[0]!.current).toMatchObject({ source: "model_version_not_in_workbench" });
    expect(episodes[0]!.current!.text).toContain("林小满");
    expect(episodes[0]!.current!.text).not.toContain("林大满");
  });

  it("a placed script is exported as its saved text in JSON and Markdown, byte for byte; an unadopted model draft keeps its own plan", async () => {
    const { s, view } = await renamedAfterBatch();
    expect((await confirmLedger(s, view.projectId, 1)).status).toBe(201);
    let page = await current(s, view.projectId);
    expect((await decide(s, view.projectId, "batch:1", page.batches[0]!.decisionBasis)).status).toBe(201);
    expect((await s.service.placeBatch(view.projectId, 1, {}, CONTEXT())).body).toMatchObject({ placed: 3 });
    const project = s.store.projects.get(view.projectId)!;
    const saved = [1, 2, 3].map((episodeNo) => project.episodes.get(episodeNo)!.scripts[0]!);
    let episodes = await pack(s, view.projectId);
    for (const [index, script] of saved.entries()) {
      expect(episodes[index]!.current).toMatchObject({ source: "model_version_in_workbench", workbench: { scriptRevisionId: script.id, contentHash: script.contentHash } });
      expect(episodes[index]!.current!.text).toBe(script.text);
    }
    const markdown = (await s.service.package(view.projectId, "markdown")).download!.text;
    for (const script of saved) expect(markdown).toContain("```text\n" + script.text + "\n```");
    // A person's edit of episode 1: the person's text is current; the model's stays apart, on its own plan's names.
    s.store.writeHumanScript(view.projectId, 1, "人工修改后的第 1 集全文");
    episodes = await pack(s, view.projectId);
    expect(episodes[0]!.current).toMatchObject({ source: "workbench_manual_revision", text: "人工修改后的第 1 集全文" });
    expect(episodes[0]!.unadoptedModelDraft!.text).toContain("林小满");
    expect(episodes[0]!.unadoptedModelDraft!.text).not.toContain("林大满");
    page = await current(s, view.projectId);
    expect(page.episodes[0]!.version!.kind).toBe("script");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Round 5 (review of 1f60aab): an older grant never redoes a batch or final review a later grant took over.

describe("round 5: a grant's remaining work taken over by a later grant is never sent again", () => {
  /** Grant 1 (plan + batches 1–2) stops after batch 1 (a blocking batch review); a person clears the finding. */
  async function stoppedBetween(episodes: number, scope: SeriesScope) {
    const s = setup({ plan: { blockingBatchReviews: [1] } });
    const view = await work(s, episodes);
    await grant(s, view, scope);
    let page = await current(s, view.projectId);
    const old = page.grants[0]!;
    expect(old).toMatchObject({ state: "stopped", stopReason: "batch_review_blocking" });
    expect((await decide(s, view.projectId, "batch:1", page.batches[0]!.decisionBasis)).status).toBe(201);
    page = await current(s, view.projectId);
    return { s, view, old, page };
  }

  const snapshotOf = async (s: Setup, projectId: string) => structuredClone((await s.store.snapshot(WS, projectId))!);

  it("A. grant 1 stopped after batch 1; grant 2 wrote batch 2; resuming grant 1 is refused: no send, no job, batch 2 and its ledger unchanged", async () => {
    const { s, view, old, page } = await stoppedBetween(9, { plan: true, batchFrom: 1, batchTo: 2, final: false });
    expect((await grant(s, page, { plan: false, batchFrom: 2, batchTo: 2, final: false })).status).toBe(201);
    const before = await snapshotOf(s, view.projectId);
    const sent = s.seen.length;
    const resumed = await s.service.resume(view.projectId, old.grantId, {}, TOKEN, CONTEXT(randomUUID()));
    await s.settle();
    expect(resumed.status).toBe(409);
    expect(resumed.body).toMatchObject({ error: { code: "SERIES_UPSTREAM_CHANGED", details: { reason: "upstream_job_superseded" } } });
    expect(s.seen.length).toBe(sent);
    expect(s.store.resumes).toHaveLength(0);
    const after = await snapshotOf(s, view.projectId);
    expect(after.jobs).toEqual(before.jobs);
    expect(after.ledgers).toEqual(before.ledgers);
    expect(after.grants).toEqual(before.grants);
  });

  it("A2. grant 1's own batch 2 job stopped mid-batch; grant 2 took batch 2 over and finished it; grant 1 resuming that job is refused", async () => {
    const s = setup({ override: (stage, attempt) => stage === "episode:5" && attempt === 1 ? REJECT : undefined });
    const view = await work(s, 9);
    await grantWith(s, view, { plan: true, batchFrom: 1, batchTo: 2, final: false }, 1);
    let page = await current(s, view.projectId);
    const old = page.grants[0]!;
    expect(old.state).toBe("stopped");
    expect((await grantWith(s, page, { plan: false, batchFrom: 2, batchTo: 2, final: false }, 0)).status).toBe(201);
    page = await current(s, view.projectId);
    expect(page.batches[1]).toMatchObject({ generated: true, ledger: { status: "valid" } });
    const before = await snapshotOf(s, view.projectId);
    const sent = s.seen.length;
    const resumed = await s.service.resume(view.projectId, old.grantId, {}, TOKEN, CONTEXT(randomUUID()));
    await s.settle();
    expect(resumed.body).toMatchObject({ error: { code: "SERIES_UPSTREAM_CHANGED", details: { reason: "upstream_job_superseded" } } });
    expect(s.seen.length).toBe(sent);
    const after = await snapshotOf(s, view.projectId);
    expect(after.jobs).toEqual(before.jobs);
    expect(after.ledgers).toEqual(before.ledgers);
  });

  it("B. grant 1 still had its final review; grant 2 ran the final review; resuming grant 1 sends no final review and keeps grant 2's result", async () => {
    const { s, view, old, page } = await stoppedBetween(3, { plan: true, batchFrom: 1, batchTo: 1, final: true });
    expect((await grant(s, page, { plan: false, batchFrom: null, batchTo: null, final: true })).status).toBe(201);
    const finals = () => s.store.stages.filter((stage) => stage.stageKey === "final_review" && stage.state === "completed");
    expect(finals()).toHaveLength(1);
    const result = structuredClone(finals()[0]!);
    const sent = s.seen.length;
    const resumed = await s.service.resume(view.projectId, old.grantId, {}, TOKEN, CONTEXT(randomUUID()));
    await s.settle();
    expect(resumed.body).toMatchObject({ error: { code: "SERIES_UPSTREAM_CHANGED", details: { reason: "upstream_job_superseded" } } });
    expect(s.seen.length).toBe(sent);
    expect(finals()).toEqual([result]);
    expect(s.store.calls.filter((call) => call.stageKey === "final_review")).toHaveLength(1);
  });

  it("D. with nothing taken over, the stopped grant resumes into batch 2; batch 1 is not sent again", async () => {
    const { s, view, old } = await stoppedBetween(9, { plan: true, batchFrom: 1, batchTo: 2, final: false });
    const sent = s.seen.length;
    expect((await s.service.resume(view.projectId, old.grantId, {}, TOKEN, CONTEXT(randomUUID()))).status).toBe(200);
    await s.settle();
    expect(stagesOf(s, sent)).toEqual(["episode:4", "episode:5", "episode:6", "batch_review:2"]);
    expect((await current(s, view.projectId)).grants[0]).toMatchObject({ state: "completed" });
  });

  it("the store's own steps refuse a superseded job too: no reservation and no ledger, even when the job is running", async () => {
    const s = setup({ override: (stage, attempt) => stage === "episode:5" && attempt === 1 ? REJECT : undefined });
    const view = await work(s, 9);
    await grantWith(s, view, { plan: true, batchFrom: 1, batchTo: 2, final: false }, 1);
    const page = await current(s, view.projectId);
    const oldJob = s.store.jobs.find((job) => job.kind === "batch" && job.batchNo === 2)!;
    expect((await grantWith(s, page, { plan: false, batchFrom: 2, batchTo: 2, final: false }, 0)).status).toBe(201);
    // As if the old job had been set running again before the takeover was seen (the race the locked steps close).
    Object.assign(oldJob, { state: "running", executorId: null, leaseUntil: null });
    for (const stage of s.store.stages.filter((item) => item.runId === oldJob.id && item.state === "rejected")) stage.state = "pending";
    const nowIso = new Date(START).toISOString();
    const lease = new Date(START + 240_000).toISOString();
    expect(await s.store.claimJob(WS, oldJob.id, "late-executor", nowIso, lease)).toBe(true);
    const calls = s.store.calls.length;
    const reservation = await s.store.reserveCall({ ...s.store.calls.find((call) => call.runId === oldJob.id)!, id: randomUUID(), stageKey: "episode:5", attemptNo: 2,
      state: "reserved", executorId: "late-executor", createdAt: nowIso, finishedAt: null }, { sinceIso: nowIso, maxCallsPerDay: 1_000 }, nowIso, lease);
    expect(reservation).toEqual({ kind: "blocked", code: "upstream_job_superseded" });
    expect(s.store.calls).toHaveLength(calls);
    const ledgers = s.store.ledgers.length;
    for (const stage of s.store.stages.filter((item) => item.runId === oldJob.id)) stage.state = "completed";
    const done = await s.store.completeJob(WS, oldJob.id, "late-executor", { kind: "batch", ledger: { ...s.store.ledgers.at(-1)!, id: randomUUID() } },
      { sinceIso: nowIso, maxCallsPerDay: 1_000, maxActiveRuns: 2 }, nowIso, lease, () => ({ kind: "done" }));
    expect(done).toEqual({ kind: "grant_stopped", reason: "upstream_job_superseded" });
    expect(s.store.ledgers).toHaveLength(ledgers);
    expect(s.store.jobs.find((job) => job.id === oldJob.id)).toMatchObject({ state: "needs_attention", errorCode: "upstream_job_superseded" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Round 6 (review of 47f4bb5): the frozen story and previous episode are checked again at the last steps before a send.

describe("round 6: a send is admitted only while the job's frozen story and previous episode are still current", () => {
  type Step = "reserveCall" | "markCallSubmitted" | "finishCall";
  /** Runs `change` once, right before the store step (a person's save landing between the engine's snapshot and that step). */
  function before(s: Setup, step: Step, change: () => void) {
    const store = s.store as unknown as Record<Step, (...args: unknown[]) => Promise<unknown>>;
    const original = store[step].bind(s.store);
    let armed = true;
    store[step] = async (...args: unknown[]) => {
      if (armed) { armed = false; change(); }
      return original(...args);
    };
  }

  /** Plan and batch 1 written, the story approved (episodes exist): batch 2 is next and freezes the story and episode 3. */
  async function readyForBatch2() {
    const s = setup();
    const view = await work(s, 9);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    s.store.approveCurrentStory(view.projectId);
    return { s, view, page: await current(s, view.projectId) };
  }

  const daily = (s: Setup) => (s.store as unknown as { recent(workspaceId: string, sinceIso: string): number }).recent(WS, new Date(START - 86_400_000).toISOString());
  const counters = (s: Setup) => {
    const grantRow = s.store.grants.at(-1)!;
    const job = s.store.jobs.filter((item) => item.grantId === grantRow.id).at(-1)!;
    return { grant: grantRow.callsUsed, job: job.callsUsed, daily: daily(s), calls: s.store.calls.length };
  };
  const changes: Record<string, (s: Setup, projectId: string) => void> = {
    story: (s, projectId) => { s.store.writeHumanStory(projectId, "工作台在发送前另存的故事"); },
    "previous episode": (s, projectId) => { s.store.writeHumanScript(projectId, 3, "工作台在发送前改写的第 3 集"); },
  };

  it.each(["story", "previous episode"])("A/B. the %s changes after the snapshot, before the reservation: nothing reserved, nothing sent, no budget used", async (what) => {
    const { s, view, page } = await readyForBatch2();
    const sent = s.seen.length;
    const callsBefore = s.store.calls.length;
    const dailyBefore = daily(s);
    before(s, "reserveCall", () => changes[what]!(s, view.projectId));
    expect((await grant(s, page, { plan: false, batchFrom: 2, batchTo: 2, final: false })).status).toBe(201);
    expect(s.seen.length).toBe(sent);
    expect(s.store.calls).toHaveLength(callsBefore);
    expect(counters(s)).toMatchObject({ grant: 0, job: 0, daily: dailyBefore });
    const job = s.store.jobs.at(-1)!;
    const reason = seriesJobUpstreamChange((await s.store.snapshot(WS, view.projectId))!, job);
    expect(reason).not.toBeNull();
    expect(job).toMatchObject({ state: "needs_attention", errorCode: reason });
    expect(s.store.grants.at(-1)).toMatchObject({ state: "stopped", stopReason: reason });
  });

  it.each(["story", "previous episode"])("C. the %s changes after the reservation, before the send: the call is kept as never sent and the job, grant and daily counts are given back", async (what) => {
    const { s, view, page } = await readyForBatch2();
    const sent = s.seen.length;
    const dailyBefore = daily(s);
    before(s, "markCallSubmitted", () => changes[what]!(s, view.projectId));
    expect((await grant(s, page, { plan: false, batchFrom: 2, batchTo: 2, final: false })).status).toBe(201);
    expect(s.seen.length).toBe(sent);
    const call = s.store.calls.at(-1)!;
    expect(call).toMatchObject({ stageKey: "episode:4", state: "rejected", errorCode: "upstream_changed_before_send", providerRequestId: null });
    expect(counters(s)).toMatchObject({ grant: 0, job: 0, daily: dailyBefore });
    const job = s.store.jobs.at(-1)!;
    expect(s.store.stages.find((stage) => stage.runId === job.id && stage.stageKey === "episode:4")).toMatchObject({ state: "pending", output: null });
    const reason = seriesJobUpstreamChange((await s.store.snapshot(WS, view.projectId))!, job);
    expect(job).toMatchObject({ state: "needs_attention", errorCode: reason });
    // E. Recovery, a second pass and the late executor give nothing back again and submit nothing.
    s.tick(600_000);
    await s.store.recoverExpired(WS, new Date(START + 600_000).toISOString());
    await s.engine("executor-b").maintain();
    expect(await s.store.markCallSubmitted(WS, call.id, call.executorId, new Date(START).toISOString(), new Date(START + 240_000).toISOString())).toBe("lost");
    expect(await s.store.finishCall(WS, call.id, call.executorId, { state: "completed", errorCode: null, output: null, outputHash: null, dependsOn: null,
      providerRequestId: null, responseModel: null, usage: call.usage }, new Date(START).toISOString())).toBe(false);
    expect(counters(s)).toMatchObject({ grant: 0, job: 0, daily: dailyBefore });
    expect(s.store.calls.at(-1)).toMatchObject({ state: "rejected", errorCode: "upstream_changed_before_send" });
    expect(s.seen.length).toBe(sent);
  });

  it("F. an edit after the call was sent: nothing is given back, nothing is resent, and the next send stops on the upstream change", async () => {
    const { s, view, page } = await readyForBatch2();
    const sent = s.seen.length;
    before(s, "finishCall", () => changes.story!(s, view.projectId));
    expect((await grant(s, page, { plan: false, batchFrom: 2, batchTo: 2, final: false })).status).toBe(201);
    expect(s.seen.slice(sent).map((item) => item.stage)).toEqual(["episode:4"]);
    expect(s.store.calls.at(-1)).toMatchObject({ stageKey: "episode:4", state: "completed" });
    expect(counters(s)).toMatchObject({ grant: 1, job: 1 });
    expect(s.store.jobs.at(-1)).toMatchObject({ state: "needs_attention", errorCode: "upstream_story_changed" });
  });

  it("G. with nothing changed the batch is sent once per stage, as before", async () => {
    const { s, page } = await readyForBatch2();
    const sent = s.seen.length;
    expect((await grant(s, page, { plan: false, batchFrom: 2, batchTo: 2, final: false })).status).toBe(201);
    expect(s.seen.slice(sent).map((item) => item.stage)).toEqual(["episode:4", "episode:5", "episode:6", "batch_review:2"]);
    expect(counters(s)).toMatchObject({ grant: 4, job: 4 });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Round 7 (review of ffd3e29): a grant writes only on the plan revision it was confirmed on (or the one its own planning
// job saved); a plan saved since stops it, even once every current blocker is cleared again.

describe("round 7: a grant never goes on under a plan revision it was not confirmed on", () => {
  type Snapshot = NonNullable<Awaited<ReturnType<InMemorySeriesWritingStore["snapshot"]>>>;
  const snapshotOf = async (s: Setup, projectId: string) => structuredClone((await s.store.snapshot(WS, projectId))!);
  const daily = (s: Setup) => (s.store as unknown as { recent(workspaceId: string, sinceIso: string): number }).recent(WS, new Date(START - 86_400_000).toISOString());
  const PLAN_ONLY: SeriesScope = { plan: true, batchFrom: null, batchTo: null, final: false };
  const BATCHES: SeriesScope = { plan: false, batchFrom: 1, batchTo: 2, final: false };
  const WITH_PLAN: SeriesScope = { plan: true, batchFrom: 1, batchTo: 2, final: false };

  /** The grant (with its own planning job, or on a plan written first) stops after batch 1 on a blocking batch review. */
  async function stoppedAfterBatch1(kind: "on a plan" | "with its own plan") {
    const s = setup({ plan: { blockingBatchReviews: [1] } });
    const view = await work(s, 9);
    if (kind === "on a plan") expect((await grant(s, view, PLAN_ONLY)).status).toBe(201);
    expect((await grant(s, await current(s, view.projectId), kind === "on a plan" ? BATCHES : WITH_PLAN)).status).toBe(201);
    const page = await current(s, view.projectId);
    const old = page.grants.at(-1)!;
    expect(old).toMatchObject({ state: "stopped", stopReason: "batch_review_blocking" });
    expect(page.batches[0]).toMatchObject({ generated: true });
    return { s, view, old, planBefore: page.plan!.revisionId };
  }

  /** A person reviews the plan, confirms the ledger and reviews batch 1 as far as each is needed: every current blocker clears. */
  async function reconfirm(s: Setup, projectId: string) {
    let page = await current(s, projectId);
    if (page.plan!.status !== "passed" && page.plan!.status !== "cleared") expect((await decide(s, projectId, "plan", page.plan!.decisionBasis)).status).toBe(201);
    page = await current(s, projectId);
    if (page.batches[0]!.ledger.status !== "valid" && page.batches[0]!.ledger.status !== "confirmed") expect((await confirmLedger(s, projectId, 1)).status).toBe(201);
    page = await current(s, projectId);
    if (page.batches[0]!.review.status !== "passed" && page.batches[0]!.review.status !== "cleared") {
      expect((await decide(s, projectId, "batch:1", page.batches[0]!.decisionBasis)).status).toBe(201);
    }
    page = await current(s, projectId);
    expect(page.next).toEqual({ batchNo: 2, blockers: [] });
    return page;
  }

  /** The old grant's resume is refused on the plan change: no send, no reservation, no job, no resume record, no count. */
  async function expectRefusedResume(s: Setup, projectId: string, grantId: string) {
    const before = await snapshotOf(s, projectId);
    const sent = s.seen.length;
    const dailyBefore = daily(s);
    const resumed = await s.service.resume(projectId, grantId, {}, TOKEN, CONTEXT(randomUUID()));
    await s.settle();
    expect(resumed.status).toBe(409);
    expect(resumed.body).toMatchObject({ error: { code: "SERIES_UPSTREAM_CHANGED", details: { reason: "upstream_plan_changed" } } });
    expect(s.seen.length).toBe(sent);
    expect(s.store.resumes).toHaveLength(0);
    expect(daily(s)).toBe(dailyBefore);
    const after = await snapshotOf(s, projectId);
    expect(after.jobs).toEqual(before.jobs);
    expect(after.grants).toEqual(before.grants);
    expect(after.plans).toEqual(before.plans);
    expect(after.ledgers).toEqual(before.ledgers);
    expect(after.decisions).toEqual(before.decisions);
    expect(after.grants.find((item) => item.id === grantId)!.input.basePlanRevisionId).toBe(before.grants.find((item) => item.id === grantId)!.input.basePlanRevisionId);
  }

  it.each(["on a plan", "with its own plan"] as const)("A/B. a grant %s stopped after batch 1; a person saves a new plan and clears every blocker; its resume is refused", async (kind) => {
    const { s, view, old, planBefore } = await stoppedAfterBatch1(kind);
    expect((await savePlan(s, await current(s, view.projectId), "from_plan", "人工改写后的一句话故事")).status).toBe(201);
    const page = await reconfirm(s, view.projectId);
    expect(page.plan!.revisionId).not.toBe(planBefore);
    await expectRefusedResume(s, view.projectId, old.grantId);
    // D. A new grant confirmed on the new plan goes on: batch 2 only, batch 1 not sent again.
    const sent = s.seen.length;
    expect((await grant(s, page, { plan: false, batchFrom: 2, batchTo: 2, final: false })).status).toBe(201);
    expect(stagesOf(s, sent)).toEqual(["episode:4", "episode:5", "episode:6", "batch_review:2"]);
    expect((await current(s, view.projectId)).grants.at(-1)).toMatchObject({ state: "completed" });
    const batch2 = s.store.jobs.filter((job) => job.kind === "batch" && job.batchNo === 2);
    expect(batch2.map((job) => job.input.planRevisionId)).toEqual([page.plan!.revisionId]);
  });

  it("E. the same plan text saved again as a new revision is still another revision: the old grant is refused", async () => {
    const { s, view, old, planBefore } = await stoppedAfterBatch1("on a plan");
    const before = await current(s, view.projectId);
    expect((await savePlan(s, before, "adopt_current")).status).toBe(201);
    const page = await reconfirm(s, view.projectId);
    expect(page.plan!.revisionId).not.toBe(planBefore);
    expect(page.plan!.contentHash).toBe(before.plan!.contentHash);
    await expectRefusedResume(s, view.projectId, old.grantId);
  });

  it.each(["on a plan", "with its own plan"] as const)("D. a grant %s with the plan unchanged resumes into batch 2; batch 1 is not sent again", async (kind) => {
    const { s, view, old, planBefore } = await stoppedAfterBatch1(kind);
    await reconfirm(s, view.projectId);
    const sent = s.seen.length;
    expect((await s.service.resume(view.projectId, old.grantId, {}, TOKEN, CONTEXT(randomUUID()))).status).toBe(200);
    await s.settle();
    expect(stagesOf(s, sent)).toEqual(["episode:4", "episode:5", "episode:6", "batch_review:2"]);
    expect((await current(s, view.projectId)).grants.at(-1)).toMatchObject({ state: "completed" });
    expect(s.store.jobs.filter((job) => job.grantId === old.grantId && job.kind === "batch").map((job) => job.input.planRevisionId)).toEqual([planBefore, planBefore]);
  });

  it("D. a grant with its own plan, batch 1 and the final review runs straight through on that plan (3 episodes)", async () => {
    const s = setup();
    const view = await work(s, 3);
    expect((await grant(s, view, { plan: true, batchFrom: 1, batchTo: 1, final: true })).status).toBe(201);
    const page = await current(s, view.projectId);
    expect(page.grants[0]).toMatchObject({ state: "completed" });
    expect(s.store.jobs.map((job) => [job.kind, job.input.planRevisionId])).toEqual([["plan", null], ["batch", page.plan!.revisionId], ["final", page.plan!.revisionId]]);
    expect(s.seen.filter((item) => item.stage === "final_review")).toHaveLength(1);
  });

  /**
   * C. Synthetic state at the hand-over: the snapshot the store hands to the next-job decision (read under its lock) shows a
   * newer plan revision with the same text, the ledgers rebound to it, nothing else blocking. The store must create no job.
   */
  it.each(["on a plan", "with its own plan"] as const)("C. the hand-over to batch 2 (grant %s) sees a newer plan revision under the store's lock: no job, no send", async (kind) => {
    const s = setup();
    const view = await work(s, 9);
    if (kind === "on a plan") expect((await grant(s, view, PLAN_ONLY)).status).toBe(201);
    const target = s.store as unknown as { completeJob: (...args: unknown[]) => Promise<unknown> };
    const original = target.completeJob.bind(s.store);
    const swappedIds: string[] = [];
    target.completeJob = async (...args: unknown[]) => {
      const next = args[7] as (snapshot: Snapshot) => unknown;
      args[7] = (snapshot: Snapshot) => {
        const plan = [...snapshot.plans].sort((a, b) => b.revisionNo - a.revisionNo)[0];
        if (!plan || !snapshot.jobs.some((job) => job.run.kind === "batch" && job.run.batchNo === 1 && job.run.state === "completed")) return next(snapshot);
        const id = randomUUID();
        swappedIds.push(id);
        const copy = structuredClone(snapshot);
        copy.plans.push({ ...structuredClone(plan), id, revisionNo: plan.revisionNo + 1, origin: "manual", sourceRunId: null, parentRevisionId: plan.id });
        for (const ledger of copy.ledgers) if (ledger.basis.planRevisionId === plan.id) ledger.basis.planRevisionId = id;
        return next(copy);
      };
      return original(...args);
    };
    const sent = s.seen.length;
    expect((await grant(s, await current(s, view.projectId), kind === "on a plan" ? BATCHES : WITH_PLAN)).status).toBe(201);
    expect(swappedIds).toHaveLength(1);
    expect(s.store.jobs.filter((job) => job.kind === "batch" && job.batchNo === 2)).toHaveLength(0);
    expect(s.store.jobs.some((job) => job.input.planRevisionId === swappedIds[0])).toBe(false);
    expect(stagesOf(s, sent).filter((stage) => /^(episode:[4-9]|batch_review:2)$/u.test(stage))).toEqual([]);
    expect(s.store.grants.at(-1)).toMatchObject({ state: "stopped", stopReason: "upstream_plan_changed" });
  });

  /** Plan written, a person's new plan saved and cleared; then a batch 2 job of the old grant frozen on the new plan (as an older server admitted it). */
  async function oldGrantJobOnNewPlan() {
    const { s, view, old } = await stoppedAfterBatch1("on a plan");
    expect((await savePlan(s, await current(s, view.projectId), "from_plan", "人工改写后的一句话故事")).status).toBe(201);
    const page = await reconfirm(s, view.projectId);
    const nowIso = new Date(START).toISOString();
    // Synthetic: an admission that skipped the grant's plan check (the state before this fix).
    const prepared = await s.store.prepareResume(WS, view.projectId, old.grantId, { resumeKey: randomUUID(), requestHash: randomUUID(), confirmedCallIds: [], providerReady: true,
      limits: { sinceIso: new Date(START - 86_400_000).toISOString(), maxCallsPerDay: 1_000, maxActiveRuns: 2 } }, nowIso,
    (state) => ({ kind: "job", job: buildSeriesJob(state, state.grants.find((item) => item.id === old.grantId)!, "batch", 2, { jobId: randomUUID(), nowIso }), requiredCalls: 0 }));
    expect(prepared).toMatchObject({ kind: "ok" });
    const job = s.store.jobs.find((item) => item.id === (prepared as { jobId: string }).jobId)!;
    expect(job.input.planRevisionId).toBe(page.plan!.revisionId);
    return { s, view, old, job };
  }

  it("F1. a job of the old grant frozen on the new plan looks current, yet it sends nothing: the engine and the store's reservation both stop it", async () => {
    const { s, view, job } = await oldGrantJobOnNewPlan();
    const snapshot = (await s.store.snapshot(WS, view.projectId))!;
    expect(seriesJobUpstreamChange(snapshot, job)).toBe("upstream_plan_changed");
    const sent = s.seen.length;
    const calls = s.store.calls.length;
    const dailyBefore = daily(s);
    await s.engine().drive(job.id);
    expect(s.seen.length).toBe(sent);
    expect(s.store.calls).toHaveLength(calls);
    expect(daily(s)).toBe(dailyBefore);
    expect(s.store.jobs.find((item) => item.id === job.id)).toMatchObject({ state: "needs_attention", errorCode: "upstream_plan_changed", callsUsed: 0 });
    // The store's own reservation (under its lock) refuses it as well, with nothing reserved.
    Object.assign(s.store.jobs.find((item) => item.id === job.id)!, { state: "running", errorCode: null, executorId: null, leaseUntil: null });
    const nowIso = new Date(START).toISOString();
    const lease = new Date(START + 240_000).toISOString();
    expect(await s.store.claimJob(WS, job.id, "late-executor", nowIso, lease)).toBe(true);
    const template = s.store.calls.at(-1)!;
    expect(await s.store.reserveCall({ ...template, id: randomUUID(), runId: job.id, grantId: job.grantId, stageKey: "episode:4", attemptNo: 1, state: "reserved",
      executorId: "late-executor", createdAt: nowIso, finishedAt: null }, { sinceIso: nowIso, maxCallsPerDay: 1_000 }, nowIso, lease))
      .toEqual({ kind: "upstream", code: "upstream_plan_changed" });
    expect(s.store.calls).toHaveLength(calls);
  });

  it("F1. resuming that job (stopped mid-batch) is refused too: no resume record, no send", async () => {
    const { s, view, old, job } = await oldGrantJobOnNewPlan();
    await s.engine().drive(job.id);
    expect(s.store.jobs.find((item) => item.id === job.id)).toMatchObject({ state: "needs_attention" });
    const resumes = s.store.resumes.length;
    const sent = s.seen.length;
    const resumed = await s.service.resume(view.projectId, old.grantId, {}, TOKEN, CONTEXT(randomUUID()));
    await s.settle();
    expect(resumed.body).toMatchObject({ error: { code: "SERIES_UPSTREAM_CHANGED", details: { reason: "upstream_plan_changed" } } });
    expect(s.store.resumes).toHaveLength(resumes);
    expect(s.seen.length).toBe(sent);
  });

  /** Synthetic: the grant's confirmed plan revision is made to differ from the plan its job froze, right before a store step. */
  function rebindGrantBefore(s: Setup, step: "markCallSubmitted" | "finishCall") {
    const target = s.store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const original = target[step]!.bind(s.store);
    let armed = true;
    target[step] = async (...args: unknown[]) => {
      if (armed) { armed = false; s.store.grants.at(-1)!.input.basePlanRevisionId = randomUUID(); }
      return original(...args);
    };
  }

  it("F2. the grant's plan no longer matches after the reservation, before the send: kept as never sent, given back once in all three counts", async () => {
    const s = setup();
    const view = await work(s, 9);
    expect((await grant(s, view, PLAN_ONLY)).status).toBe(201);
    const dailyBefore = daily(s);
    const sent = s.seen.length;
    rebindGrantBefore(s, "markCallSubmitted");
    expect((await grant(s, await current(s, view.projectId), BATCHES)).status).toBe(201);
    expect(s.seen.length).toBe(sent);
    const call = s.store.calls.at(-1)!;
    expect(call).toMatchObject({ stageKey: "episode:1", state: "rejected", errorCode: "upstream_changed_before_send", providerRequestId: null });
    const job = s.store.jobs.at(-1)!;
    expect(job).toMatchObject({ state: "needs_attention", errorCode: "upstream_plan_changed", callsUsed: 0 });
    expect(s.store.grants.at(-1)).toMatchObject({ callsUsed: 0, state: "stopped", stopReason: "upstream_plan_changed" });
    expect(daily(s)).toBe(dailyBefore);
    s.tick(600_000);
    await s.store.recoverExpired(WS, new Date(START + 600_000).toISOString());
    await s.engine("executor-b").maintain();
    expect(await s.store.markCallSubmitted(WS, call.id, call.executorId, new Date(START).toISOString(), new Date(START + 240_000).toISOString())).toBe("lost");
    expect(s.store.grants.at(-1)).toMatchObject({ callsUsed: 0 });
    expect(s.store.jobs.at(-1)).toMatchObject({ callsUsed: 0 });
    expect(daily(s)).toBe(dailyBefore);
    expect(s.seen.length).toBe(sent);
  });

  it("F3. after the send the call is counted and never given back or resent; the next send stops on the plan change", async () => {
    const s = setup();
    const view = await work(s, 9);
    expect((await grant(s, view, PLAN_ONLY)).status).toBe(201);
    const sent = s.seen.length;
    rebindGrantBefore(s, "finishCall");
    expect((await grant(s, await current(s, view.projectId), BATCHES)).status).toBe(201);
    expect(stagesOf(s, sent)).toEqual(["episode:1"]);
    expect(s.store.calls.at(-1)).toMatchObject({ stageKey: "episode:1", state: "completed" });
    expect(s.store.jobs.at(-1)).toMatchObject({ state: "needs_attention", errorCode: "upstream_plan_changed", callsUsed: 1 });
    expect(s.store.grants.at(-1)).toMatchObject({ callsUsed: 1 });
  });

  it("the domain decision itself: nextSeriesJob refuses the old grant once the plan revision changed, and goes on while it did not", async () => {
    const { s, view, old } = await stoppedAfterBatch1("with its own plan");
    const ids = { jobId: randomUUID(), nowIso: new Date(START).toISOString() };
    await reconfirm(s, view.projectId);
    let snapshot = (await s.store.snapshot(WS, view.projectId))!;
    const own = seriesCurrentPlan(snapshot)!;
    expect(own.sourceRunId).toBe(s.store.jobs.find((job) => job.grantId === old.grantId && job.kind === "plan")!.id);
    expect(nextSeriesJob(snapshot, snapshot.grants.find((item) => item.id === old.grantId)!, ids)).toMatchObject({ kind: "job", job: { run: { input: { planRevisionId: own.id } } } });
    expect((await savePlan(s, await current(s, view.projectId), "from_plan", "人工改写后的一句话故事")).status).toBe(201);
    await reconfirm(s, view.projectId);
    snapshot = (await s.store.snapshot(WS, view.projectId))!;
    expect(nextSeriesJob(snapshot, snapshot.grants.find((item) => item.id === old.grantId)!, ids)).toMatchObject({ kind: "refused", code: "upstream_plan_changed" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Round 8 (review of PR #85): secret schedule and resolved conflicts on the engine path, plan blockers before any
// episode, and collision-safe Markdown fences.

/**
 * The fenced code blocks and the top-level headings of a Markdown text, read the way CommonMark reads fences: an
 * opening line of three or more backticks (up to three spaces of indent) is closed only by a line of at least as many
 * backticks and nothing else; anything unclosed runs to the end of the document.
 */
function markdownStructure(text: string): { blocks: string[]; headings: string[]; unclosed: boolean } {
  const blocks: string[] = [];
  const headings: string[] = [];
  let open: { length: number; lines: string[] } | null = null;
  // CommonMark ends a line at LF, CRLF or a lone CR: the parse reads a copy with those normalized (never the export itself).
  for (const line of text.replace(/\r\n?/gu, "\n").split("\n")) {
    if (open) {
      const close = /^ {0,3}(`+)[ \t]*$/u.exec(line);
      if (close && close[1]!.length >= open.length) { blocks.push(open.lines.join("\n")); open = null; } else open.lines.push(line);
      continue;
    }
    const start = /^ {0,3}(`{3,})([^`]*)$/u.exec(line);
    if (start) { open = { length: start[1]!.length, lines: [] }; continue; }
    if (/^ {0,3}#{1,6} /u.test(line)) headings.push(line.trim());
  }
  if (open) blocks.push(open.lines.join("\n"));
  return { blocks, headings, unclosed: open !== null };
}

describe("round 8, 2 and 3: the engine path keeps the secret schedule and resolved conflicts", () => {
  it("2. the planned reveal (episode 5 of 9) is missing: the model's batch review says pass, the program finding blocks; the grant stops for a person", async () => {
    const s = setup({ plan: { secrets: { 5: [] } } });
    const view = await work(s, 9);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 3, final: false });
    const page = await current(s, view.projectId);
    expect(page.grants[0]).toMatchObject({ state: "stopped", stopReason: "batch_review_blocking" });
    const review = s.store.stages.find((stage) => stage.stageKey === "batch_review:2" && stage.state === "completed")!.output as unknown as
      { verdict: string; passed: boolean; deterministic: Array<{ check: string; target: string; severity: string }> };
    expect(review.verdict).toBe("pass");
    expect(review.passed).toBe(false);
    expect(review.deterministic).toEqual(expect.arrayContaining([expect.objectContaining({ check: "secret_missing", target: "episode:5", severity: "high" })]));
    expect(page.batches[1]!.review.status).toBe("needs_revision");
    // Nothing approves the story or a script by itself; a person's review is the way on, as before.
    expect(s.store.projects.get(view.projectId)!.stories.every((story) => story.reviewStatus !== "APPROVED")).toBe(true);
    expect(s.seen.some((item) => item.stage === "batch_review:3")).toBe(false);
  });

  it("2. revealed early (episode 3) and never in episode 5: blocking findings in batch 1 and batch 2's planned episode is not called missing", async () => {
    const s = setup({ plan: { secrets: { 3: [{ id: "S1", revealedTo: ["C1"] }], 5: [] } } });
    const view = await work(s, 9);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    const review = s.store.stages.find((stage) => stage.stageKey === "batch_review:1" && stage.state === "completed")!.output as unknown as
      { passed: boolean; deterministic: Array<{ check: string; target: string }> };
    expect(review.passed).toBe(false);
    expect(review.deterministic.filter((item) => item.check.startsWith("secret_")).map((item) => `${item.check}@${item.target}`)).toEqual(["secret_schedule@episode:3"]);
  });

  it("3. K1 resolved in episode 2 and written open again in episode 3: the answer is refused before it is stored or merged; the ledger is never reopened", async () => {
    const s = setup({ plan: { conflicts: { 2: [{ id: "K1", content: "钥匙归属之争", status: "resolved" }], 3: [{ id: "K1", content: "钥匙又被拿走", status: "open" }] } } });
    const view = await work(s, 9);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    const stage = s.store.stages.find((item) => item.stageKey === "episode:3")!;
    expect(stage).toMatchObject({ state: "rejected", output: null });
    expect(stage.errorCode).toBe("plan_structure@continuity.conflicts[0]");
    expect(s.store.ledgers.filter((item) => item.batchNo === 1)).toHaveLength(0);
    const kept = s.store.stages.find((item) => item.stageKey === "episode:2")!.output as unknown as SeriesEpisode;
    expect(kept.continuity.conflicts).toEqual([{ id: "K1", content: "钥匙归属之争", status: "resolved" }]);
    expect((await current(s, view.projectId)).grants[0]).toMatchObject({ state: "stopped" });
  });

  it("3. a new K2 after K1 was resolved is accepted on the same path; the ledger keeps K1 resolved and its episode numbers", async () => {
    const s = setup({ plan: { conflicts: { 2: [{ id: "K1", content: "钥匙归属之争", status: "resolved" }], 3: [{ id: "K2", content: "转卖的消息", status: "open" }] } } });
    const view = await work(s, 9);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    const ledger = s.store.ledgers.find((item) => item.batchNo === 1)!;
    expect(ledger.content.conflicts).toEqual([
      { id: "K1", content: "钥匙归属之争", status: "resolved", openedIn: 1, resolvedIn: 2 },
      { id: "K2", content: "转卖的消息", status: "open", openedIn: 3, resolvedIn: null },
    ]);
  });
});

describe("round 8, 5: plan blockers are pending work before any episode is written", () => {
  const exported = async (s: Setup, projectId: string) => ({
    json: (JSON.parse((await s.service.package(projectId, "json")).download!.text) as { completion: { attention: string[] } }).completion.attention,
    markdown: (await s.service.package(projectId, "markdown")).download!.text,
  });
  const shown = async (s: Setup, projectId: string) => {
    const view = await current(s, projectId);
    const pack = await exported(s, projectId);
    expect(pack.json).toEqual(view.attention);
    const line = pack.markdown.split("\n").find((item) => item.startsWith("> 待办："));
    expect(line ?? null).toBe(view.attention.length > 0 ? `> 待办：${view.attention.join("、")}` : null);
    return view;
  };

  it("a blocking model plan review with 0 episodes: plan_review_blocking in the view, JSON and Markdown; a person's review clears it", async () => {
    const s = setup({ plan: { blockingPlanReview: true } });
    const created = await work(s, 6);
    await grant(s, created, { plan: true, batchFrom: null, batchTo: null, final: false });
    let view = await shown(s, created.projectId);
    expect(view).toMatchObject({ written: 0, completion: "planned", attention: ["plan_review_blocking"], plan: { status: "needs_revision" } });
    expect((await decide(s, created.projectId, "plan", view.plan!.decisionBasis)).status).toBe(201);
    view = await shown(s, created.projectId);
    expect(view).toMatchObject({ attention: [], plan: { status: "cleared" } });
  });

  it("a person's plan not yet reviewed, 0 episodes: plan_unreviewed until reviewed", async () => {
    const s = setup();
    const created = await work(s, 6);
    await grant(s, created, { plan: true, batchFrom: null, batchTo: null, final: false });
    expect((await shown(s, created.projectId)).attention).toEqual([]);
    expect((await savePlan(s, await current(s, created.projectId), "adopt_current", "人工改写后的一句话故事")).status).toBe(201);
    let view = await shown(s, created.projectId);
    expect(view).toMatchObject({ written: 0, attention: ["plan_unreviewed"], plan: { status: "unreviewed", origin: "manual" } });
    expect((await decide(s, created.projectId, "plan", view.plan!.decisionBasis)).status).toBe(201);
    view = await shown(s, created.projectId);
    expect(view.attention).toEqual([]);
  });

  it("no plan yet: not started, nothing pending, and no plan check is invented", async () => {
    const s = setup();
    const created = await work(s, 6);
    const view = await shown(s, created.projectId);
    expect(view).toMatchObject({ completion: "not_started", attention: [], plan: null });
  });
});

describe("round 8, 6: Markdown fences never close inside the text they hold", () => {
  const HOSTILE = (label: string) => `${label}开头\n\`\`\`\n# 注入的标题 ${label}\n[注入的链接](https://example.invalid/${label})\n\`\`\`\`\n\`\`\`\`\`\`\`text\n- 列表\n中文结尾无换行`;

  it("story, approved story, current, approved and unadopted scripts each stay one block, byte for byte; the package's own structure is unchanged", async () => {
    // The double's episode text carries a line of three backticks and a heading line (its JSON allows new lines).
    const s = setup({ plan: { tag: "替身样例\n```\n# 模型稿里的标题\n````" } });
    const view = await work(s, 3);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    const project = s.store.projects.get(view.projectId)!;
    s.store.writeHumanStory(view.projectId, HOSTILE("故事批准稿"));
    s.store.approveCurrentStory(view.projectId);
    s.store.writeHumanStory(view.projectId, HOSTILE("故事当前稿"));
    s.store.writeHumanScript(view.projectId, 1, HOSTILE("第1集当前稿"));
    s.store.writeHumanScript(view.projectId, 2, HOSTILE("第2集批准稿"));
    s.store.approveScript(view.projectId, 2);
    s.store.writeHumanScript(view.projectId, 2, HOSTILE("第2集当前稿"));
    const json = JSON.parse((await s.service.package(view.projectId, "json")).download!.text) as {
      story: { current: { text: string }; approved: { text: string } };
      episodes: Array<{ current: { text: string } | null; approved: { text: string } | null; unadoptedModelDraft: { text: string } | null }> };
    const markdown = (await s.service.package(view.projectId, "markdown")).download!.text;
    const structure = markdownStructure(markdown);
    expect(structure.unclosed).toBe(false);
    const texts = [json.story.current.text, json.story.approved.text, json.episodes[0]!.current!.text, json.episodes[0]!.unadoptedModelDraft!.text,
      json.episodes[1]!.current!.text, json.episodes[1]!.approved!.text, json.episodes[2]!.current!.text];
    expect(texts[0]).toBe(HOSTILE("故事当前稿"));
    expect(texts[1]).toBe(HOSTILE("故事批准稿"));
    expect(texts[2]).toBe(HOSTILE("第1集当前稿"));
    expect(texts[4]).toBe(HOSTILE("第2集当前稿"));
    expect(texts[5]).toBe(HOSTILE("第2集批准稿"));
    expect(texts[3]).toContain("\n```\n# 模型稿里的标题\n````");
    expect(texts[6]).toContain("\n```\n# 模型稿里的标题\n````");
    // Each text is exactly one code block's content, unchanged (the saved text and the JSON are the same).
    for (const text of texts) expect(structure.blocks).toContain(text);
    expect(project.stories.find((item) => item.id === project.currentStoryId)!.text).toBe(HOSTILE("故事当前稿"));
    // The headings inside the texts never become package structure: only the package's own headings are top level.
    expect(structure.headings.filter((item) => item.includes("注入") || item.includes("模型稿里的标题"))).toEqual([]);
    expect(structure.headings).toEqual(expect.arrayContaining(["## 故事（工作台实际当前稿）", "## 各集剧本", "### 第 1 集", "### 第 2 集", "### 第 3 集", "## 全剧总检", "## 缺项"]));
    // Every block's fence is longer than the longest backtick run it holds.
    const opened = markdown.split("\n").filter((line) => /^`{3,}(text|json)$/u.test(line));
    expect(opened.some((line) => line.startsWith("````````text"))).toBe(true);
  });
});

describe("round 8, 6 (CR): no line break of any kind lets an inline field open a package-level block", () => {
  const SECTIONS = ["## 全剧规划", "## 故事（工作台实际当前稿）", "## 各集剧本", "## 连续性与伏笔台账", "## 全剧总检", "## 缺项", "## 制作注意事项"];

  it.each([["LF", "\n"], ["CRLF", "\r\n"], ["CR", "\r"]])("%s in plan fields, the summary, the story and a script: fences close, sections stay in order, texts and JSON unchanged", async (_label, sep) => {
    const hostile = (label: string) => ["正常", "```", `# 注入的标题 ${label}`, "正文"].join(sep);
    // The double's summary and scene text carry the same line break (the model draft path).
    const s = setup({ plan: { tag: hostile("模型稿") } });
    const view = await work(s, 3);
    await grant(s, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    const page = await current(s, view.projectId);
    const content = structuredClone(page.plan!.content);
    content.setting.logline = hostile("一句话故事");
    content.setting.synopsis = hostile("梗概");
    content.setting.characters = content.setting.characters.map((item, index) => index === 0 ? { ...item, identity: hostile("身份") } : item);
    expect((await s.service.savePlan(view.projectId, { basePlanRevisionId: page.plan!.revisionId, baseStoryRevisionId: page.story.current!.revisionId,
      story: "adopt_current", content }, CONTEXT())).status).toBe(201);
    s.store.writeHumanStory(view.projectId, hostile("故事"));
    s.store.approveCurrentStory(view.projectId);
    s.store.writeHumanScript(view.projectId, 1, hostile("第1集"));
    const raw = (await s.service.package(view.projectId, "markdown")).download!.text;
    const json = JSON.parse((await s.service.package(view.projectId, "json")).download!.text) as {
      plan: { setting: { logline: string; synopsis: string } }; story: { current: { text: string } };
      episodes: Array<{ current: { text: string; summary: string | null } | null; unadoptedModelDraft: { text: string } | null }> };
    // Structure, read on a copy whose line breaks are normalized for parsing only.
    const structure = markdownStructure(raw);
    expect(structure.unclosed).toBe(false);
    expect(structure.headings.filter((item) => item.includes("注入"))).toEqual([]);
    const positions = SECTIONS.map((heading) => structure.headings.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // The texts are exported exactly, in the raw Markdown string and in the JSON (no line break is rewritten).
    expect(json.plan.setting.logline).toBe(hostile("一句话故事"));
    expect(json.story.current.text).toBe(hostile("故事"));
    expect(json.episodes[0]!.current!.text).toBe(hostile("第1集"));
    for (const text of [json.story.current.text, json.episodes[0]!.current!.text, json.episodes[0]!.unadoptedModelDraft!.text, json.episodes[1]!.current!.text]) {
      expect(raw).toContain(`\n${text}\n`);
    }
    // Inline fields are one line in the raw Markdown: no CR or LF of theirs survives.
    expect(raw).toContain("**一句话故事**：正常 ``` # 注入的标题 一句话故事 正文");
    expect(raw).toContain(`概要：${json.episodes[1]!.current!.summary!.replace(/\r\n?|\n/gu, " ")}`);
    expect(raw.includes("\r")).toBe(json.story.current.text.includes("\r"));
    expect(structure.unclosed).toBe(false);
    const normalized = (text: string) => text.replace(/\r\n?/gu, "\n");
    for (const text of [json.story.current.text, json.episodes[0]!.current!.text, json.episodes[0]!.unadoptedModelDraft!.text]) {
      expect(structure.blocks).toContain(normalized(text));
    }
  });
});
