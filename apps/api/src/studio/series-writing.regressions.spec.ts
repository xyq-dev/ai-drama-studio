import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { seriesScopeCalls, type SeriesScope } from "@ai-drama/contracts";
import { PersistenceError } from "@ai-drama/database";
import type { SeriesView } from "@ai-drama/domain";
import { InMemorySeriesWritingStore, SeriesWritingEngine, titleWritingProviderConfigs } from "@ai-drama/providers";
import { seriesFixtureTransport, type SeriesFixtureExchange } from "@ai-drama/providers/title-writing-fixtures";
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

function setup(options: { override?: (stage: string, attempt: number) => { status: number; body: unknown } | undefined } = {}) {
  const store = new InMemorySeriesWritingStore();
  const seen: SeriesFixtureExchange[] = [];
  let clock = START;
  const now = () => new Date(clock);
  const engine = (executorId = "executor-a") => new SeriesWritingEngine({ workspaceId: WS, store, providers, executorId, leaseMs: 240_000, clock: now,
    transport: seriesFixtureTransport({ seen, ...(options.override ? { override: options.override } : {}) }), maxCallsPerDay: 1_000, maxActiveRuns: 2 });
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
