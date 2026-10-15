import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { TITLE_WRITING_RUN_KIND_DISABLED, type TitleCallRecord, type TitleRunKind, type TitleRunRecord } from "@ai-drama/contracts";
import { InMemoryTitleWritingStore, TitleWritingEngine, newTitleRun } from "./title-writing-engine";
import { newScriptBreakdownRun } from "./script-breakdown-run";
import { fixtureChatTransport, type FixtureExchange } from "./title-writing-fixtures";
import { titleWritingProviderConfigs } from "./text-writing";

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const TITLE = "夜班证词";
const providers = titleWritingProviderConfigs({ DASHSCOPE_API_KEY: "test-only-key", TITLE_WRITING_QWEN_MODELS: "q-1",
  BAILIAN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1" });

function setup(allowedRunKinds?: readonly TitleRunKind[]) {
  const store = new InMemoryTitleWritingStore();
  const seen: FixtureExchange[] = [];
  const engine = new TitleWritingEngine({ workspaceId: WS, store, providers, maxCallsPerDay: 100,
    transport: fixtureChatTransport(TITLE, { seen }), ...(allowedRunKinds === undefined ? {} : { allowedRunKinds }) });
  const claim = vi.spyOn(store, "claimRun");
  const reserve = vi.spyOn(store, "reserveCall");
  return { store, seen, engine, claim, reserve };
}

async function title(store: InMemoryTitleWritingStore, workspaceId = WS) {
  const projectId = randomUUID();
  store.addProject(workspaceId, projectId);
  const run = newTitleRun({ workspaceId, projectId, actorId: "owner", idempotencyKey: randomUUID(), title: TITLE,
    settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "qwen", model: "q-1", now: new Date() });
  expect((await store.createRun(run, { maxActiveRuns: 10 })).kind).toBe("created");
  return run;
}

async function breakdown(store: InMemoryTitleWritingStore, workspaceId = WS) {
  const projectId = randomUUID();
  const episode = store.addBreakdownEpisode({ workspaceId, projectId, episodeNo: 1,
    text: "第 1 集\n场 1 便利店 夜\n林夏盯着监控。\n林夏：这不是我。" });
  const source = await store.breakdownSource(workspaceId, projectId, episode.episodeId);
  if (source.kind !== "ok") throw new Error(source.kind);
  const run = newScriptBreakdownRun({ workspaceId, projectId, actorId: "owner", idempotencyKey: randomUUID(),
    requestHash: "f".repeat(64), now: new Date(), input: {
      episodeId: episode.episodeId, episodeNo: 1, scriptRevisionId: source.scriptRevisionId, scriptRevisionNo: source.scriptRevisionNo,
      scriptContentHash: source.scriptContentHash, scriptText: (source.scriptContent as { text: string }).text,
      targetEpisodeSeconds: source.targetEpisodeSeconds, characters: [], replace: { scenes: [], shots: [] }, providerKey: "qwen", model: "q-1",
    } });
  expect((await store.createRun(run, { maxActiveRuns: 10 })).kind).toBe("created");
  return run;
}

describe("shared writing engine run-kind authorization", () => {
  it("refuses a disabled breakdown before claiming, reserving or sending; maintenance stops it without a send", async () => {
    const { store, seen, engine, claim, reserve } = setup(["title"]);
    const run = await breakdown(store);
    const before = (await store.getRunById(WS, run.id))!;
    await engine.drive(run.id);
    expect(await store.getRunById(WS, run.id)).toEqual(before);
    await engine.maintain();
    expect(claim).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    const after = (await store.getRunById(WS, run.id))!;
    expect(after.run).toMatchObject({ state: "needs_attention", errorCode: TITLE_WRITING_RUN_KIND_DISABLED, executorId: null,
      leaseUntil: null, callsUsed: 0, cancelRequestedAt: null, input: before.run.input, breakdownSave: "pending" });
    expect(after.steps).toEqual(before.steps);
    expect(after.calls).toEqual([]);
  });

  it("filters disabled runs before the maintenance limit so a later title still completes", async () => {
    const { store, seen, engine, claim, reserve } = setup(["title"]);
    const blocked = [];
    for (let index = 0; index < 6; index += 1) blocked.push(await breakdown(store));
    const allowed = await title(store);
    await engine.maintain(5);
    expect(seen.map((item) => item.step)).toEqual(["concept", "outline", "episode:1", "episode:2", "episode:3"]);
    expect(claim.mock.calls.map((args) => args[1])).toEqual([allowed.id]);
    expect(reserve.mock.calls.every(([call]) => call.runId === allowed.id)).toBe(true);
    expect((await store.getRunById(WS, allowed.id))!.run.state).toBe("completed");
    for (const run of blocked) {
      const after = (await store.getRunById(WS, run.id))!;
      expect(after.run).toMatchObject({ executorId: null, callsUsed: 0, state: "needs_attention", errorCode: TITLE_WRITING_RUN_KIND_DISABLED });
      expect(after.calls).toEqual([]);
    }
  });

  it("an empty policy blocks both kinds, including direct execution", async () => {
    const { store, seen, engine, claim, reserve } = setup([]);
    const titleRun = await title(store);
    const breakdownRun = await breakdown(store);
    await engine.drive(titleRun.id);
    await engine.drive(breakdownRun.id);
    await engine.maintain();
    expect(claim).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it("an omitted policy preserves execution of both kinds", async () => {
    const { store, seen, engine } = setup();
    const breakdownRun = await breakdown(store);
    const titleRun = await title(store);
    await engine.maintain();
    expect(seen).toHaveLength(6);
    expect((await store.getRunById(WS, breakdownRun.id))!.run.state).toBe("completed");
    expect((await store.getRunById(WS, titleRun.id))!.run.state).toBe("completed");
  });

  it("an allowed kind still cannot execute another workspace's run", async () => {
    const { store, seen, engine, claim, reserve } = setup(["title"]);
    const run = await title(store, OTHER_WS);
    const before = await store.getRunById(OTHER_WS, run.id);
    await engine.drive(run.id);
    await engine.maintain();
    expect(claim).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    expect(await store.getRunById(OTHER_WS, run.id)).toEqual(before);
  });
});

const PAST = () => new Date(Date.now() - 120_000).toISOString();
const PAST_LEASE = () => new Date(Date.now() - 60_000).toISOString();
const LIVE_LEASE = () => new Date(Date.now() + 600_000).toISOString();
const UNKNOWN_USAGE = { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null } as const;

function breakdownCall(run: TitleRunRecord, executorId: string, at: string): TitleCallRecord {
  return { id: randomUUID(), runId: run.id, workspaceId: run.workspaceId, stepKey: "breakdown", attemptNo: 1, providerKey: "qwen", model: "q-1",
    requestHash: "c".repeat(64), state: "reserved", executorId, providerRequestId: null, responseModel: null, usage: { ...UNKNOWN_USAGE },
    errorCode: null, createdAt: at, finishedAt: null };
}

/** A breakdown claimed by an executor that then stopped, with its call reserved and maybe submitted. */
async function abandoned(store: InMemoryTitleWritingStore, submitted: boolean, workspaceId = WS, leaseUntil = PAST_LEASE()) {
  const run = await breakdown(store, workspaceId);
  const at = PAST();
  expect(await store.claimRun(workspaceId, run.id, "dead", at, leaseUntil)).toBe(true);
  const call = breakdownCall(run, "dead", at);
  expect(await store.reserveCall(call, { sinceIso: "2000-01-01T00:00:00.000Z", maxCallsPerDay: 100 }, at, leaseUntil)).toEqual({ kind: "reserved" });
  if (submitted) expect(await store.markCallSubmitted(workspaceId, call.id, "dead", at, leaseUntil)).toBe("submitted");
  return { run, call };
}

describe("stopping runs of a switched-off kind", () => {
  it("settles each unheld disabled breakdown without a send and leaves live leases and other workspaces alone", async () => {
    const { store, seen, engine, claim, reserve } = setup(["title"]);
    const unclaimed = await breakdown(store);
    const reserved = await abandoned(store, false);
    const submitted = await abandoned(store, true);
    const canceled = await breakdown(store);
    await store.requestCancel(WS, canceled.projectId, canceled.id, new Date().toISOString());
    const held = await abandoned(store, false, WS, LIVE_LEASE());
    const other = await breakdown(store, OTHER_WS);
    const heldBefore = await store.getRunById(WS, held.run.id);
    const otherBefore = await store.getRunById(OTHER_WS, other.id);
    claim.mockClear();
    reserve.mockClear();
    const callsBefore = store.calls.length;

    await engine.maintain();

    expect(seen).toEqual([]);
    expect(claim).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(store.calls).toHaveLength(callsBefore);
    expect((await store.getRunById(WS, unclaimed.id))!.run).toMatchObject({ state: "needs_attention", errorCode: TITLE_WRITING_RUN_KIND_DISABLED });
    const released = (await store.getRunById(WS, reserved.run.id))!;
    expect(released.run).toMatchObject({ state: "needs_attention", errorCode: TITLE_WRITING_RUN_KIND_DISABLED, executorId: null, leaseUntil: null });
    expect(released.steps).toEqual([expect.objectContaining({ state: "pending" })]);
    expect(released.calls).toEqual([expect.objectContaining({ id: reserved.call.id, state: "rejected", errorCode: "executor_lost_before_send" })]);
    const uncertain = (await store.getRunById(WS, submitted.run.id))!;
    expect(uncertain.run).toMatchObject({ state: "needs_attention", errorCode: "executor_lost", executorId: null });
    expect(uncertain.steps).toEqual([expect.objectContaining({ state: "unknown", errorCode: "executor_lost" })]);
    expect(uncertain.calls).toEqual([expect.objectContaining({ id: submitted.call.id, state: "unknown", errorCode: "executor_lost", usage: UNKNOWN_USAGE })]);
    const stopped = (await store.getRunById(WS, canceled.id))!;
    expect(stopped.run).toMatchObject({ state: "canceled", errorCode: null });
    expect(stopped.steps).toEqual([expect.objectContaining({ state: "canceled" })]);
    expect(await store.getRunById(WS, held.run.id)).toEqual(heldBefore);
    expect(await store.getRunById(OTHER_WS, other.id)).toEqual(otherBefore);
  });

  it("settles open calls itself when called directly, before any recovery pass, and never stops another kind", async () => {
    const store = new InMemoryTitleWritingStore();
    const reserved = await abandoned(store, false);
    const submitted = await abandoned(store, true);
    const titleRun = await title(store);
    const now = new Date().toISOString();
    expect(await store.retireDisabledRuns(WS, now, ["script_breakdown"])).toBe(2);
    const released = (await store.getRunById(WS, reserved.run.id))!;
    expect(released.calls[0]).toMatchObject({ state: "rejected", errorCode: "executor_lost_before_send" });
    expect(released.run).toMatchObject({ state: "needs_attention", errorCode: TITLE_WRITING_RUN_KIND_DISABLED });
    const uncertain = (await store.getRunById(WS, submitted.run.id))!;
    expect(uncertain.calls[0]).toMatchObject({ state: "unknown", errorCode: "executor_lost", usage: UNKNOWN_USAGE });
    expect(uncertain.run).toMatchObject({ state: "needs_attention", errorCode: "executor_lost" });
    expect((await store.getRunById(WS, titleRun.id))!.run).toMatchObject({ state: "running" });
    expect(await store.retireDisabledRuns(WS, now, [])).toBe(0);
    expect(await store.retireDisabledRuns(WS, now, ["script_breakdown"])).toBe(0);
  });

  it("frees the slot under the default cap of one so a new title can start, and the stopped run can resume later", async () => {
    const { store, seen, engine } = setup(["title"]);
    const stranded = await breakdown(store);
    const projectId = randomUUID();
    store.addProject(WS, projectId);
    const next = newTitleRun({ workspaceId: WS, projectId, actorId: "owner", idempotencyKey: randomUUID(), title: TITLE,
      settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "qwen", model: "q-1", now: new Date() });
    expect(await store.createRun(next, { maxActiveRuns: 1 })).toEqual({ kind: "blocked", code: "TITLE_WRITING_ACTIVE_RUN_CAP" });
    await engine.maintain();
    expect(seen).toEqual([]);
    expect((await store.createRun(next, { maxActiveRuns: 1 })).kind).toBe("created");
    await engine.maintain();
    expect((await store.getRunById(WS, next.id))!.run.state).toBe("completed");
    // Nothing a later resume needs was dropped: once the switch is back on it continues from the frozen input.
    expect((await store.prepareResume(WS, stranded.projectId, stranded.id,
      { resumeKey: "later", requestHash: "e".repeat(64), confirmedCallIds: [], maxActiveRuns: 1 }, new Date().toISOString())).kind).toBe("ok");
  });

  it("does not stop anything while every kind is allowed", async () => {
    const { store, engine } = setup(["title", "script_breakdown"]);
    const retire = vi.spyOn(store, "retireDisabledRuns");
    await engine.maintain();
    expect(retire).not.toHaveBeenCalled();
  });
});

describe("a run whose result was saved before its executor stopped", () => {
  /**
   * Drives a run through the real engine and the real save (story or breakdown) and stops the executor right after the
   * save: the finishing write is lost, so the run is still running with an expired lease. Nothing is faked but that write.
   */
  async function crashedAfterSave(kind: TitleRunKind, stopBeforeSave = false) {
    let now = Date.now();
    const clock = () => new Date(now);
    const store = new InMemoryTitleWritingStore();
    const seen: FixtureExchange[] = [];
    const transport = fixtureChatTransport(TITLE, { seen });
    const run = kind === "title" ? await title(store) : await breakdown(store);
    if (stopBeforeSave) vi.spyOn(store, "saveBreakdown").mockResolvedValueOnce("lost");
    else vi.spyOn(store, "finishRun").mockResolvedValueOnce(false);
    await new TitleWritingEngine({ workspaceId: WS, store, providers, maxCallsPerDay: 100, transport, clock, leaseMs: 1_000 }).drive(run.id);
    vi.restoreAllMocks();
    const stopped = (await store.getRunById(WS, run.id))!;
    expect(stopped.run.state).toBe("running");
    expect(stopped.steps.every((step) => step.state === "completed")).toBe(true);
    now += 5_000;
    const engine = (allowedRunKinds: readonly TitleRunKind[]) => new TitleWritingEngine({ workspaceId: WS, store, providers, maxCallsPerDay: 100,
      transport, clock, leaseMs: 1_000, allowedRunKinds });
    const written = () => ({ stories: [...store.projects.values()].reduce((total, item) => total + item.stories.length, 0),
      scenes: store.scenes.length, revisions: store.scenes.reduce((total, item) => total + item.revisions.length, 0), shots: store.shots.length });
    return { store, seen, run, stopped, engine, written };
  }

  it.each(["title", "script_breakdown"] as const)("a %s run ends completed without a send, a second save or a new revision", async (kind) => {
    const { store, seen, run, stopped, engine, written } = await crashedAfterSave(kind);
    expect(kind === "title" ? stopped.run.storySave : stopped.run.breakdownSave).toBe("saved");
    const sends = seen.length;
    const before = written();
    const save = vi.spyOn(store, kind === "title" ? "saveStory" : "saveBreakdown");

    await engine(kind === "title" ? ["script_breakdown"] : ["title"]).maintain();

    const after = (await store.getRunById(WS, run.id))!;
    expect(after.run).toMatchObject({ state: "completed", errorCode: null, executorId: null, leaseUntil: null, callsUsed: stopped.run.callsUsed,
      storySave: stopped.run.storySave, storyRevisionId: stopped.run.storyRevisionId, breakdownSave: stopped.run.breakdownSave });
    expect(after.steps).toEqual(stopped.steps);
    expect(after.calls).toEqual(stopped.calls);
    expect(seen).toHaveLength(sends);
    expect(save).not.toHaveBeenCalled();
    expect(written()).toEqual(before);

    // Switched back on: nothing is claimed, sent or written again, and there is nothing to resume.
    await engine(["title", "script_breakdown"]).maintain();
    expect(seen).toHaveLength(sends);
    expect(save).not.toHaveBeenCalled();
    expect(written()).toEqual(before);
    expect((await store.getRunById(WS, run.id))!.calls).toEqual(stopped.calls);
    expect(await store.prepareResume(WS, run.projectId, run.id,
      { resumeKey: "after", requestHash: "e".repeat(64), confirmedCallIds: [], maxActiveRuns: 1 }, new Date().toISOString())).toEqual({ kind: "not_resumable" });
  });

  it("a breakdown whose answer was stored but not yet saved still stops for a later resume, which saves it without a send", async () => {
    const { store, seen, run, stopped, engine, written } = await crashedAfterSave("script_breakdown", true);
    expect(stopped.run.breakdownSave).toBe("pending");
    const sends = seen.length;
    const before = written();
    await engine(["title"]).maintain();
    expect((await store.getRunById(WS, run.id))!.run).toMatchObject({ state: "needs_attention", errorCode: TITLE_WRITING_RUN_KIND_DISABLED });
    expect(written()).toEqual(before);
    expect((await store.prepareResume(WS, run.projectId, run.id,
      { resumeKey: "after", requestHash: "e".repeat(64), confirmedCallIds: [], maxActiveRuns: 1 }, new Date().toISOString())).kind).toBe("ok");
    await engine(["title", "script_breakdown"]).maintain();
    const done = (await store.getRunById(WS, run.id))!;
    expect(done.run).toMatchObject({ state: "completed", breakdownSave: "saved" });
    expect(done.calls).toEqual(stopped.calls);
    expect(seen).toHaveLength(sends);
  });

  it("a requested cancel still ends as canceled, as the engine would", async () => {
    const { store, run, engine } = await crashedAfterSave("script_breakdown");
    await store.requestCancel(WS, run.projectId, run.id, new Date().toISOString());
    await engine(["title"]).maintain();
    expect((await store.getRunById(WS, run.id))!.run).toMatchObject({ state: "canceled", breakdownSave: "saved" });
  });

  it("a live lease is still left to its executor", async () => {
    const { store, run, stopped } = await crashedAfterSave("script_breakdown");
    // Past the stopped executor's lease, another executor takes the run under a lease that is still live.
    const later = new Date(Date.now() + 10_000).toISOString();
    expect(await store.claimRun(WS, run.id, "alive", later, new Date(Date.now() + 600_000).toISOString())).toBe(true);
    const held = await store.getRunById(WS, run.id);
    expect(await store.retireDisabledRuns(WS, later, ["script_breakdown"])).toBe(0);
    expect(await store.getRunById(WS, run.id)).toEqual(held);
    expect(held!.calls).toEqual(stopped.calls);
  });
});
