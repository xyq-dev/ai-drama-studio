import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { seriesPlanCalls, seriesScopeCalls } from "@ai-drama/contracts";
import { canonicalInputHash, formatSeriesStory, seriesDecisionBasis, seriesLedgerBasisNow, seriesLedgerEditBasis, seriesPackageJson } from "@ai-drama/domain";
import { titleWritingProviderConfigs } from "./text-writing";
import { SeriesWritingEngine } from "./series-writing-engine";
import { seriesFixtureTransport } from "./series-writing-fixtures";
import { ALL, P1, PROVIDERS, START, WS, seriesSetup } from "./series-writing-test-kit";

/**
 * Series writing offline acceptance, continued: cross-batch continuity, people's edits, call protections and the current
 * package. Model double only; no real model, image, voice or video service is called.
 */

describe("B. the first three episodes, then continuing across batches", () => {
  it("plan + episodes 1–3 is 19 calls for 60 episodes and stops at 3/60; episodes 4–6 rewrite neither the plan nor episodes 1–3", async () => {
    const { view, store, seen, grant } = await seriesSetup();
    const first = await grant({ plan: true, batchFrom: 1, batchTo: 1, final: false });
    expect(first.kind).toBe("created");
    expect(store.calls).toHaveLength(19);
    const afterFirst = await view();
    expect(afterFirst.completion).toBe("partial");
    expect(afterFirst.completionLabel).toContain("已完成 3/60 集");
    expect(afterFirst.written).toBe(3);
    expect(afterFirst.ranges.toWrite).toBe("第 4–60 集");
    expect(afterFirst.grants[0]).toMatchObject({ state: "completed", callsUsed: 19, callBudget: 19 });
    const sentBefore = seen.length;
    const second = await grant({ plan: false, batchFrom: 2, batchTo: 2, final: false });
    expect(second.kind).toBe("created");
    expect(seen.slice(sentBefore).map((item) => item.stage)).toEqual(["episode:4", "episode:5", "episode:6", "batch_review:2"]);
    const afterSecond = await view();
    expect(afterSecond.written).toBe(6);
    expect(store.plans).toHaveLength(1);
    expect(afterSecond.episodes.slice(0, 3).map((item) => item.version!.hash)).toEqual(afterFirst.episodes.slice(0, 3).map((item) => item.version!.hash));
  });

  it("carries the key, the foreshadowing and the open conflict across the batch boundary in the ledger", async () => {
    const { store, seen, grant } = await seriesSetup();
    await grant({ plan: true, batchFrom: 1, batchTo: 2, final: false });
    const batch1 = store.ledgers.find((item) => item.batchNo === 1)!.content;
    expect(batch1.props.find((item) => item.id === "P1")!.holderId).toBe("C1");
    expect(batch1.foreshadowing.find((item) => item.id === "FS2")).toMatchObject({ status: "planted", plantedIn: 3 });
    expect(batch1.conflicts.find((item) => item.id === "K1")).toMatchObject({ status: "open", openedIn: 1 });
    const episode4 = seen.find((item) => item.stage === "episode:4")!.user;
    expect(episode4).toContain("<<<连续性台账（本集开始前）");
    expect(episode4).toContain('"id":"P1","holderId":"C1"');
    expect(episode4).toContain("第3夜结束：钥匙在C1手里。");
    const batch2 = store.ledgers.find((item) => item.batchNo === 2)!;
    expect(batch2.content.props.find((item) => item.id === "P1")!.holderId).toBe("C3");
    expect(batch2.content.foreshadowing.find((item) => item.id === "FS2")).toMatchObject({ status: "paid", plantedIn: 3, paidIn: 5 });
    expect(batch2.basis.baseLedgerHash).toBe(store.ledgers.find((item) => item.batchNo === 1)!.contentHash);
    const review2 = store.stages.find((item) => item.stageKey === "batch_review:2")!.output as { deterministic: unknown[]; passed: boolean };
    expect(review2).toMatchObject({ deterministic: [], passed: true });
  });

  it("the secret is revealed mid-series only to a person on screen, with someone who knew it present", async () => {
    const { store, grant, view } = await seriesSetup({ episodes: 12 });
    await grant(ALL(12));
    const ledger = store.ledgers.find((item) => item.batchNo === 2)!.content;
    expect(ledger.secrets.find((item) => item.id === "S1")!.knownBy).toEqual(["C1"]);
    expect((await view()).completion).toBe("text_complete");
  });

  it.each([
    ["a key handed over with its holder absent", { propContradiction: 5 }, "prop_handoff", 5, 2],
    ["a payoff of foreshadowing not planted yet", { payoffBeforePlant: 2 }, "foreshadowing_order", 2, 1],
  ])("an injected contradiction (%s) is a blocking finding: no pass is recorded and the next batch is not written", async (_label, plan, check, episodeNo, batchNo) => {
    const { store, seen, view, grant } = await seriesSetup({ plan });
    await grant({ plan: true, batchFrom: 1, batchTo: 3, final: false });
    const review = store.stages.find((item) => item.stageKey === "batch_review:" + String(batchNo))!.output as { deterministic: Array<{ check: string; severity: string; target: string }>; passed: boolean };
    expect(review.passed).toBe(false);
    expect(review.deterministic).toContainEqual(expect.objectContaining({ check, severity: "high", target: "episode:" + String(episodeNo) }));
    expect(seen.some((item) => item.stage === "episode:" + String(batchNo * 3 + 1))).toBe(false);
    const result = await view();
    expect(result.batches[batchNo - 1]!.review.status).toBe("needs_revision");
    expect(result.grants[0]).toMatchObject({ state: "stopped", stopReason: "batch_review_blocking" });
    expect(result.completion).toBe("partial");
    expect(result.ranges.toRevise).toEqual([batchNo]);
  });

  it("a batch review's verified high issue blocks the same way (the model's verdict alone decides nothing)", async () => {
    const { view, grant } = await seriesSetup({ episodes: 9, plan: { blockingBatchReviews: [1] } });
    await grant({ plan: true, batchFrom: 1, batchTo: 2, final: false });
    const result = await view();
    expect(result.batches[0]!.review.output!.issues[0]).toMatchObject({ evidenceVerified: true, severity: "high" });
    expect(result.batches[0]!.review.status).toBe("needs_revision");
    expect(result.written).toBe(3);
  });

  it("episodes 3 and 6 are never the series ending: an episode that ends the series early is refused and nothing more is sent", async () => {
    const { store, seen, view, grant } = await seriesSetup({ plan: { earlyFinale: 3 } });
    await grant({ plan: true, batchFrom: 1, batchTo: 2, final: false });
    expect(seen.at(-1)!.stage).toBe("episode:3");
    expect(store.stages.find((item) => item.stageKey === "episode:3")).toMatchObject({ state: "rejected", errorCode: "finale_misplaced@ending" });
    expect((await view()).grants[0]).toMatchObject({ state: "stopped", stopReason: "finale_misplaced" });
    const prompt3 = seen.find((item) => item.stage === "episode:3")!.user;
    expect(prompt3).toContain('ending 必须写 "continue"');
    expect(store.plans[0]!.content.outlines.filter((item) => item.isFinale).map((item) => item.episodeNo)).toEqual([60]);
  });
});

describe("C. people's edits, upstream changes and missing batches stop silent continuation", () => {
  async function placed() {
    const setup = await seriesSetup({ episodes: 9 });
    await setup.grant({ plan: true, batchFrom: 1, batchTo: 2, final: false });
    setup.store.approveCurrentStory(P1);
    const snap = await setup.snapshot();
    for (const batchNo of [1, 2]) {
      const scripts = snap.jobs.filter((job) => job.run.batchNo === batchNo).flatMap((job) => job.stages.filter((stage) => stage.stageKey.startsWith("episode:"))
        .map((stage) => ({ episodeNo: Number(stage.stageKey.split(":")[1]), runId: job.run.id, stageKey: stage.stageKey, text: `剧本 ${stage.stageKey}` })));
      expect(await setup.store.placeBatch(WS, P1, batchNo, scripts, "server-owner", new Date(START).toISOString())).toMatchObject({ kind: "ok", placed: 3 });
    }
    return setup;
  }

  async function confirm(setup: Awaited<ReturnType<typeof placed>>, batchNo: number) {
    const snap = await setup.snapshot();
    const basis = seriesLedgerBasisNow(snap, batchNo);
    if ("blocked" in basis) throw new Error(basis.blocked);
    const current = snap.ledgers.filter((item) => item.batchNo === batchNo).sort((a, b) => b.revisionNo - a.revisionNo)[0]!;
    const content = { ...current.content };
    return setup.store.saveLedgerRevision(WS, P1, {
      id: randomUUID(), seriesId: setup.series.id, batchNo, revisionNo: 0, origin: "manual", content, contentHash: canonicalInputHash(content),
      summaries: basis.versions.map((version) => ({ episodeNo: version.ref.episodeNo, summary: "人工确认的概要", versionHash: version.ref.hash })),
      basis: basis.basis, createdBy: "server-owner", createdAt: new Date(START).toISOString(),
    }, current.id, (state) => seriesLedgerEditBasis(state, batchNo), seriesLedgerEditBasis(snap, batchNo)!);
  }

  it("placed model versions stay the current versions; a person's edit makes the ledger pending and stops the next batch", async () => {
    const setup = await placed();
    let result = await setup.view();
    expect(result.batches.map((item) => item.ledger.status)).toEqual(["valid", "valid", "none"]);
    expect(result.episodes[1]!.version!.source).toBe("模型稿（已写入工作台）");
    const scriptId = setup.store.writeHumanScript(P1, 2, "人工修改后的第 2 集");
    result = await setup.view();
    expect(result.batches[0]!.ledger.status).toBe("pending_confirmation");
    expect(result.batches[0]!.changedEpisodes).toEqual([2]);
    expect(result.batches[1]!.ledger.status).toBe("stale");
    expect(result.batches[0]!.review.status).toBe("stale");
    expect(result.episodes[1]!.version).toMatchObject({ kind: "script", source: "工作台人工修改稿" });
    expect(result.next.blockers).toContain("ledger_pending_confirmation:1");
    const sent = setup.seen.length;
    expect(await setup.grant({ plan: false, batchFrom: 3, batchTo: 3, final: false })).toMatchObject({ kind: "refused", code: "SERIES_BLOCKED" });
    expect(setup.seen.length).toBe(sent);
    expect(setup.store.projects.get(P1)!.episodes.get(2)!.scripts.map((item) => item.id)).toContain(scriptId);
    expect(setup.store.projects.get(P1)!.episodes.get(2)!.scripts).toHaveLength(2);
  });

  it("a confirmed ledger and a person's review decision let the series go on; no extraction call is added", async () => {
    const setup = await placed();
    setup.store.writeHumanScript(P1, 2, "人工修改后的第 2 集");
    const sentBefore = setup.seen.length;
    expect(await confirm(setup, 1)).toBe("saved");
    expect(await confirm(setup, 2)).toBe("saved");
    expect(setup.seen.length).toBe(sentBefore);
    let result = await setup.view();
    expect(result.batches.slice(0, 2).map((item) => item.ledger.status)).toEqual(["confirmed", "confirmed"]);
    expect(result.next.blockers).toEqual(["batch_review_stale:1"]);
    // The review covers everything the batch depends on, as the page showed it: plan, story, the ledgers before and after, each episode.
    const basis = result.batches[0]!.decisionBasis!;
    expect(Object.keys(basis).sort()).toEqual(["baseLedger", "episode:1", "episode:2", "episode:3", "ledger", "plan", "story"]);
    expect(await setup.store.saveDecision(WS, P1, { id: randomUUID(), seriesId: setup.series.id, target: "batch:1", basis, note: "已人工复核第 2 集修改", createdBy: "server-owner",
      createdAt: new Date(START).toISOString() }, (snapshot) => seriesDecisionBasis(snapshot, "batch:1"))).toBe("saved");
    result = await setup.view();
    expect(result.batches[0]!.review.status).toBe("cleared");
    expect(result.next.blockers).toEqual([]);
    const sent = setup.seen.length;
    expect((await setup.grant({ plan: false, batchFrom: 3, batchTo: 3, final: false })).kind).toBe("created");
    expect(setup.seen.slice(sent).map((item) => item.stage)).toEqual(["episode:7", "episode:8", "episode:9", "batch_review:3"]);
  });

  it("a ledger confirmation conflicts when another one was saved first", async () => {
    const setup = await placed();
    setup.store.writeHumanScript(P1, 2, "人工修改后的第 2 集");
    expect(await confirm(setup, 1)).toBe("saved");
    const snap = await setup.snapshot();
    const stale = snap.ledgers.find((item) => item.batchNo === 1 && item.origin === "program")!;
    expect(await setup.store.saveLedgerRevision(WS, P1, { ...stale, id: randomUUID() }, stale.id, (state) => seriesLedgerEditBasis(state, 1),
      seriesLedgerEditBasis(snap, 1)!)).toBe("conflict");
  });

  it("a person's plan revision makes every ledger stale and stops scheduling; the earlier plan stays", async () => {
    const setup = await placed();
    const snap = await setup.snapshot();
    const current = snap.plans[0]!;
    const content = structuredClone(current.content);
    content.setting.logline = "人工改写后的一句话故事";
    const id = randomUUID();
    expect(await setup.store.savePlanRevision(WS, P1, { ...current, id, revisionNo: 0, origin: "manual", sourceRunId: null, parentRevisionId: current.id,
      content, contentHash: canonicalInputHash(content), review: null, storyRevisionId: null, storyHash: null, storySave: "pending", createdBy: "server-owner" },
    { parentId: current.id, storyRevisionId: snap.project.currentStoryRevisionId }, { mode: "from_plan", text: formatSeriesStory(id, content, "manual")! })).toBe("saved");
    const result = await setup.view();
    expect(result.plan).toMatchObject({ status: "unreviewed", revisionNo: 2 });
    expect(result.batches.slice(0, 2).map((item) => item.ledger.status)).toEqual(["stale", "stale"]);
    // The plan's new story DRAFT replaced the story the placed scripts were written from: their source is stale.
    expect(result.episodes[0]!.state).toBe("source_stale");
    expect(result.story.status).toBe("ok");
    expect(setup.store.plans).toHaveLength(2);
    expect(await setup.grant({ plan: false, batchFrom: 3, batchTo: 3, final: false })).toMatchObject({ kind: "refused", code: "SERIES_BLOCKED" });
  });

  it("a batch is never written out of order or without the batch before it", async () => {
    const setup = await seriesSetup({ episodes: 9 });
    await setup.grant({ plan: true, batchFrom: null, batchTo: null, final: false });
    expect(await setup.grant({ plan: false, batchFrom: 2, batchTo: 2, final: false })).toMatchObject({ kind: "refused", code: "SERIES_SCOPE_NOT_NEXT" });
    expect(await setup.grant({ plan: false, batchFrom: null, batchTo: null, final: true })).toMatchObject({ kind: "refused", code: "SERIES_BLOCKED" });
    expect(await setup.grant({ plan: true, batchFrom: null, batchTo: null, final: false })).toMatchObject({ kind: "refused", code: "SERIES_PLAN_EXISTS" });
    expect(setup.store.calls).toHaveLength(seriesPlanCalls(9));
  });
});

describe("D. call protections and recovery", () => {
  it("the same key with the same request returns the grant: no new job, no schedule, no send; other content under it is a conflict", async () => {
    const setup = await seriesSetup({ episodes: 6 });
    const scope = { plan: true, batchFrom: 1, batchTo: 1, final: false };
    const first = await setup.grant(scope, "grant-key");
    expect(first.kind).toBe("created");
    const sent = setup.store.calls.length;
    const jobs = setup.store.jobs.length;
    // The page replays its stored request exactly: the plan revision the card was built on (none) included.
    expect(await setup.grant(scope, "grant-key", { base: null })).toMatchObject({ kind: "existing" });
    expect(setup.store.calls.length).toBe(sent);
    expect(setup.store.jobs.length).toBe(jobs);
    expect(await setup.grant({ ...scope, batchTo: 2 }, "grant-key", { base: null })).toMatchObject({ kind: "conflict" });
  });

  it("a card with other normal calls than the formula is refused before anything is written", async () => {
    const setup = await seriesSetup();
    expect(await setup.grant({ plan: true, batchFrom: 1, batchTo: 1, final: false }, "k", { normalCalls: 11 })).toMatchObject({ kind: "refused", code: "SERIES_CARD_STALE" });
    expect(setup.store.grants).toHaveLength(0);
    expect(setup.store.calls).toHaveLength(0);
  });

  it("two drivers and a lease race send each stage once", async () => {
    const setup = await seriesSetup({ episodes: 6 });
    const scope = { plan: true, batchFrom: 1, batchTo: 2, final: false };
    const created = await setup.grant(scope, "k", { drive: false });
    if (created.kind !== "created") throw new Error(created.kind);
    const other = setup.engine("executor-b");
    await Promise.all([setup.main.drive(created.jobId), other.drive(created.jobId), setup.main.drive(created.jobId)]);
    await setup.main.maintain();
    await other.maintain();
    expect(setup.store.calls).toHaveLength(seriesScopeCalls(6, scope));
    expect(new Set(setup.seen.map((item) => item.stage)).size).toBe(setup.seen.length);
  });

  it("a timed-out call is unknown: nothing is resent until a person confirms it, and the resend counts against the grant", async () => {
    let hang = true;
    const setup = await seriesSetup({ episodes: 6 });
    const scope = { plan: true, batchFrom: 1, batchTo: 1, final: false };
    const created = await setup.grant(scope, "k", { resendAllowance: 1, drive: false });
    if (created.kind !== "created") throw new Error(created.kind);
    const timed = new SeriesWritingEngine({ workspaceId: WS, store: setup.store, providers: PROVIDERS, transport: seriesFixtureTransport({ seen: setup.seen,
      override: (stage) => stage === "episode:2" && hang ? "hang" : undefined }), maxCallsPerDay: 1_000, maxActiveRuns: 2, clock: () => new Date(START), leaseMs: 240_000,
    timeoutMs: 5, executorId: "executor-a" });
    await timed.drive(created.jobId);
    let result = await setup.view();
    expect(result.grants[0]).toMatchObject({ state: "stopped" });
    const uncertain = result.grants[0]!.uncertainCallIds;
    expect(uncertain).toHaveLength(1);
    const sent = setup.store.calls.length;
    await setup.main.maintain();
    expect(setup.store.calls.length).toBe(sent);
    expect(await setup.resume(created.grant.id, "r1")).toMatchObject({ kind: "needs_confirmation" });
    hang = false;
    expect(await setup.resume(created.grant.id, "r2", uncertain)).toMatchObject({ kind: "ok" });
    result = await setup.view();
    expect(result.written).toBe(3);
    expect(result.grants[0]).toMatchObject({ state: "completed", callsUsed: seriesScopeCalls(6, scope) + 1 });
    expect(await setup.resume(created.grant.id, "r2", uncertain)).toMatchObject({ kind: "replayed" });
  });

  it("an expired lease before the send is safe to retake (API restart)", async () => {
    const setup = await seriesSetup({ episodes: 3 });
    const created = await setup.grant({ plan: true, batchFrom: 1, batchTo: 1, final: false }, "k", { drive: false });
    if (created.kind !== "created") throw new Error(created.kind);
    expect(await setup.store.claimJob(WS, created.jobId, "dead", new Date(START).toISOString(), new Date(START + 1000).toISOString())).toBe(true);
    setup.tick(5_000);
    await setup.main.maintain();
    expect((await setup.view()).written).toBe(3);
    expect(new Set(setup.seen.map((item) => item.stage)).size).toBe(setup.seen.length);
  });

  it("a submitted call whose executor is lost becomes unknown on restart, stops the grant, and a late answer is not accepted", async () => {
    const setup = await seriesSetup({ episodes: 3 });
    const created = await setup.grant({ plan: true, batchFrom: null, batchTo: null, final: false }, "k", { drive: false });
    if (created.kind !== "created") throw new Error(created.kind);
    const job = setup.store.jobs[0]!;
    const nowIso = new Date(START).toISOString();
    const lease = new Date(START + 1000).toISOString();
    expect(await setup.store.claimJob(WS, job.id, "dead", nowIso, lease)).toBe(true);
    await setup.store.completeLocalStage(WS, job.id, "dead", "sources", { schema: "x" }, "0".repeat(64), nowIso);
    const call = { id: randomUUID(), runId: job.id, grantId: job.grantId, seriesId: job.seriesId, workspaceId: WS, stageKey: "research", attemptNo: 1, providerKey: "deepseek" as const,
      model: "m-1", requestHash: "0".repeat(64), state: "reserved" as const, executorId: "dead", providerRequestId: null, responseModel: null,
      usage: { status: "unknown" as const, inputTokens: null, outputTokens: null, totalTokens: null }, errorCode: null, createdAt: nowIso, finishedAt: null };
    expect(await setup.store.reserveCall(call, { sinceIso: nowIso, maxCallsPerDay: 100 }, nowIso, lease)).toEqual({ kind: "reserved" });
    expect(await setup.store.markCallSubmitted(WS, call.id, "dead", nowIso, lease)).toBe("submitted");
    setup.tick(5_000);
    await setup.main.maintain();
    expect((await setup.view()).grants[0]).toMatchObject({ state: "stopped", stopReason: "executor_lost" });
    expect(setup.seen).toHaveLength(0);
    expect(await setup.store.finishCall(WS, call.id, "dead", { state: "completed", errorCode: null, output: {}, outputHash: "1".repeat(64), dependsOn: {},
      providerRequestId: null, responseModel: null, usage: call.usage }, nowIso)).toBe(false);
  });

  it("cancel stops before the next send; nothing is sent afterwards", async () => {
    const setup = await seriesSetup({ episodes: 6 });
    const created = await setup.grant({ plan: true, batchFrom: 1, batchTo: 2, final: false }, "k", { drive: false });
    if (created.kind !== "created") throw new Error(created.kind);
    await setup.store.requestCancel(WS, P1, created.grant.id, new Date(START).toISOString());
    await setup.main.drive(created.jobId);
    expect(setup.seen).toHaveLength(0);
    expect((await setup.view()).grants[0]).toMatchObject({ state: "canceled" });
    expect(await setup.resume(created.grant.id, "after-cancel")).toMatchObject({ kind: "not_resumable" });
    expect(setup.seen).toHaveLength(0);
  });

  it("the daily cap admits the current bounded stage only; a short day stops between jobs and resumes later without resending", async () => {
    const setup = await seriesSetup({ maxCallsPerDay: 17 });
    const created = await setup.grant({ plan: true, batchFrom: 1, batchTo: 1, final: false }, "k");
    expect(created.kind).toBe("created");
    let result = await setup.view();
    expect(result.grants[0]).toMatchObject({ state: "stopped", stopReason: "daily_quota_low", callsUsed: 15 });
    expect(result.written).toBe(0);
    setup.tick(86_400_001);
    expect(await setup.resume(result.grants[0]!.grantId, "r1")).toMatchObject({ kind: "ok" });
    result = await setup.view();
    expect(result.grants[0]).toMatchObject({ state: "completed", callsUsed: 19 });
    expect(setup.store.calls).toHaveLength(19);
  });

  it("a day without room for the first stage creates nothing", async () => {
    const setup = await seriesSetup({ maxCallsPerDay: 10 });
    expect(await setup.grant({ plan: true, batchFrom: null, batchTo: null, final: false })).toMatchObject({ kind: "daily_quota_low", requiredCalls: 15, remainingCalls: 10 });
    expect(setup.store.grants).toHaveLength(0);
  });

  it("an uncertain call with no resend left in the grant stops for good: no other task or provider sends it", async () => {
    const setup = await seriesSetup({ episodes: 3, override: (stage) => stage === "episode:1" ? { status: 500, body: "{}" } : undefined });
    const created = await setup.grant({ plan: true, batchFrom: 1, batchTo: 1, final: false });
    if (created.kind !== "created") throw new Error(created.kind);
    const result = await setup.view();
    expect(result.grants[0]).toMatchObject({ state: "stopped", stopReason: "server_error" });
    expect(await setup.resume(created.grant.id, "r1", result.grants[0]!.uncertainCallIds)).toMatchObject({ kind: "budget_exhausted" });
    expect(setup.seen.filter((item) => item.stage === "episode:1")).toHaveLength(1);
  });

  it("the grant budget and the job cap each stop a send", async () => {
    const setup = await seriesSetup({ episodes: 3, override: (stage, attempt) => stage === "episode:1" && attempt === 1 ? { status: 500, body: "{}" } : undefined });
    const created = await setup.grant({ plan: true, batchFrom: 1, batchTo: 1, final: false }, "k", { resendAllowance: 1 });
    if (created.kind !== "created") throw new Error(created.kind);
    const uncertain = (await setup.view()).grants[0]!.uncertainCallIds;
    expect(await setup.resume(created.grant.id, "r1", uncertain)).toMatchObject({ kind: "ok" });
    expect((await setup.view()).grants[0]).toMatchObject({ state: "completed", callsUsed: seriesScopeCalls(3, { plan: true, batchFrom: 1, batchTo: 1, final: false }) + 1 });
    expect(setup.store.jobs.every((job) => job.callsUsed <= job.callCap)).toBe(true);
  });

  it("an unavailable provider stops the job before any reservation", async () => {
    const setup = await seriesSetup({ episodes: 3 });
    const engine = new SeriesWritingEngine({ workspaceId: WS, store: setup.store, providers: titleWritingProviderConfigs({}), transport: seriesFixtureTransport({ seen: setup.seen }),
      maxCallsPerDay: 100, maxActiveRuns: 2, clock: () => new Date(START) });
    const created = await setup.grant({ plan: true, batchFrom: null, batchTo: null, final: false }, "k", { drive: false });
    if (created.kind !== "created") throw new Error(created.kind);
    await engine.drive(created.jobId);
    expect(setup.store.calls).toHaveLength(0);
    expect((await setup.view()).grants[0]).toMatchObject({ state: "stopped", stopReason: "provider_unconfigured" });
  });

  it("shares the daily cap and the concurrency cap with title writing, candidates and automatic creation", async () => {
    const setup = await seriesSetup({ maxCallsPerDay: 20, maxActiveRuns: 1 });
    for (let index = 0; index < 6; index += 1) setup.store.otherCalls.push({ workspaceId: WS, createdAt: new Date(START).toISOString() });
    expect(await setup.grant({ plan: true, batchFrom: null, batchTo: null, final: false })).toMatchObject({ kind: "daily_quota_low", requiredCalls: 15, remainingCalls: 14 });
    setup.store.otherCalls.splice(0, 6);
    setup.store.otherRunning.set("33333333-3333-4333-8333-333333333333", "auto");
    expect(await setup.grant({ plan: true, batchFrom: null, batchTo: null, final: false })).toMatchObject({ kind: "blocked", code: "SERIES_ACTIVE_RUN_CAP" });
    setup.store.otherRunning.clear();
    setup.store.otherRunning.set(P1, "title");
    expect(await setup.grant({ plan: true, batchFrom: null, batchTo: null, final: false })).toMatchObject({ kind: "active", runKind: "title" });
    expect(setup.store.calls).toHaveLength(0);
  });

  it("a refused answer stores only its rule and field, never the model's text", async () => {
    const setup = await seriesSetup({ episodes: 3, plan: { oversizedEpisodes: [2] } });
    await setup.grant({ plan: true, batchFrom: 1, batchTo: 1, final: false });
    const stage = setup.store.stages.find((item) => item.stageKey === "episode:2")!;
    expect(stage).toMatchObject({ state: "rejected", output: null });
    expect(stage.errorCode).toMatch(/^too_large/);
    expect(JSON.stringify(setup.store.calls)).not.toContain("填充");
    expect(JSON.stringify(setup.store.grants)).not.toContain("sk-");
  });
});

describe("E. the current writing package", () => {
  it("reads the current versions, the person's edit included, and is the same on a second read", async () => {
    const setup = await seriesSetup({ episodes: 6 });
    await setup.grant(ALL(6));
    expect((await setup.view()).completion).toBe("text_complete");
    setup.store.approveCurrentStory(P1);
    const snap = await setup.snapshot();
    const scripts = snap.jobs.filter((job) => job.run.batchNo === 1).flatMap((job) => job.stages.filter((stage) => stage.stageKey.startsWith("episode:"))
      .map((stage) => ({ episodeNo: Number(stage.stageKey.split(":")[1]), runId: job.run.id, stageKey: stage.stageKey, text: `剧本 ${stage.stageKey}` })));
    await setup.store.placeBatch(WS, P1, 1, scripts, "server-owner", new Date(START).toISOString());
    setup.store.writeHumanScript(P1, 1, "人工修改后的第 1 集全文");
    const meta = { generatedAt: new Date(START).toISOString() };
    const first = seriesPackageJson(await setup.snapshot(), meta);
    expect(seriesPackageJson(await setup.snapshot(), meta)).toEqual(first);
    const episodes = first.episodes as Array<{ episodeNo: number; current: { source: string; text: string }; unadoptedModelDraft: { note: string } | null }>;
    expect(episodes[0]!.current).toMatchObject({ source: "workbench_manual_revision", text: "人工修改后的第 1 集全文" });
    expect(episodes[0]!.unadoptedModelDraft?.note).toContain("未采纳的模型稿");
    expect(episodes[3]!.current.source).toBe("model_version_not_in_workbench");
    // An edit after the final review makes the series partial again: never "text complete" on checks of another version.
    expect((first.completion as { level: string }).level).toBe("partial");
  });
});
