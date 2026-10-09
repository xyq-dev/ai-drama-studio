import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TITLE_WRITING_DEFAULT_EPISODE_SECONDS, type TitleWritingProviderKey } from "@ai-drama/contracts";
import { titleWritingProviderConfigs, type WritingProviderConfig, type WritingTransport } from "./text-writing";
import {
  InMemoryTitleWritingStore,
  TITLE_WRITING_CALL_CAP_PER_RUN,
  TitleWritingEngine,
  hashTitleResume,
  newTitleRun,
  titleRunView,
  uncertainCallIdsOf,
} from "./title-writing-engine";
import { chatAnswer, fixtureChatTransport, fixtureConcept, fixtureOutline, type FixtureExchange, type FixtureStep } from "./title-writing-fixtures";

const WS = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const P2 = "33333333-3333-4333-8333-333333333333";
const KEY = "sk-test-secret-0123456789";
const TITLE = "夜班证词";

function providers(): Record<TitleWritingProviderKey, WritingProviderConfig> {
  return titleWritingProviderConfigs({
    DASHSCOPE_API_KEY: KEY, BAILIAN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1", TITLE_WRITING_QWEN_MODELS: "q-1",
    DEEPSEEK_API_KEY: KEY, TITLE_WRITING_DEEPSEEK_MODELS: "d-1",
  });
}

function setup(options: {
  transport?: WritingTransport;
  seen?: FixtureExchange[];
  override?: (step: FixtureStep, attempt: number) => { status: number; body: unknown } | "hang" | "throw" | undefined;
  maxCallsPerDay?: number;
  providerKey?: TitleWritingProviderKey;
  model?: string;
} = {}) {
  const store = new InMemoryTitleWritingStore();
  store.addProject(WS, P1);
  store.addProject(WS, P2);
  const seen = options.seen ?? [];
  const transport = options.transport ?? fixtureChatTransport(TITLE, { seen, ...(options.override ? { override: options.override } : {}) });
  const engine = new TitleWritingEngine({ workspaceId: WS, store, providers: providers(), transport, maxCallsPerDay: options.maxCallsPerDay ?? 30, timeoutMs: 20 });
  const run = (projectId = P1, key = "key-1", title = TITLE) => newTitleRun({
    workspaceId: WS, projectId, actorId: "server-owner", idempotencyKey: key, title,
    settings: { episodeCount: 3, episodeSeconds: TITLE_WRITING_DEFAULT_EPISODE_SECONDS, style: "" },
    providerKey: options.providerKey ?? "qwen", model: options.model ?? "q-1", now: new Date(),
  });
  return { store, engine, seen, run };
}

/** A fresh resume action; with confirm it names exactly the uncertain calls the store holds now, as the page shows them. */
async function resume(store: InMemoryTitleWritingStore, projectId: string, runId: string, confirm: boolean) {
  const bundle = (await store.getRunById(WS, runId))!;
  const confirmed = confirm ? uncertainCallIdsOf(bundle.steps, bundle.calls) : [];
  return store.prepareResume(WS, projectId, runId, { resumeKey: randomUUID(), requestHash: hashTitleResume(runId, confirmed),
    confirmedCallIds: confirmed, maxActiveRuns: 1 }, new Date().toISOString());
}

describe("title-driven writing run", () => {
  it("generates concept, outline and every episode in order and saves the story as a DRAFT", async () => {
    const { store, engine, seen, run } = setup();
    const created = await store.createRun(run(), { maxActiveRuns: 1 });
    expect(created.kind).toBe("created");
    await engine.drive(created.kind === "blocked" ? "" : created.bundle.run.id);
    const bundle = (await store.latestRun(WS, P1))!;
    const view = titleRunView(bundle);
    expect(seen.map((item) => item.step)).toEqual(["concept", "outline", "episode:1", "episode:2", "episode:3"]);
    expect(view.state).toBe("completed");
    expect(view.steps.map((step) => step.state)).toEqual(["completed", "completed", "completed", "completed", "completed"]);
    expect(view.storySave).toBe("saved");
    expect(view.storyText).toContain(`剧名：${TITLE}`);
    expect(view.storyText).toContain("分集大纲");
    expect(view.steps[2]?.text).toContain("第 1 集");
    expect(view.steps.slice(2).map((step) => step.scriptSave)).toEqual(["awaiting_story_approval", "awaiting_story_approval", "awaiting_story_approval"]);
    expect(view.calls).toHaveLength(5);
    expect(view.calls.every((call) => call.billingStatus === "unknown" && call.usage.status === "present")).toBe(true);
    const project = store.projects.get(P1)!;
    expect(project.stories).toHaveLength(1);
    expect(project.stories[0]?.reviewStatus).toBe("DRAFT");
    expect(project.approvedStoryId).toBeNull();
  });

  it("later steps receive the saved earlier outputs as context", async () => {
    const { store, engine, seen, run } = setup();
    const created = await store.createRun(run(), { maxActiveRuns: 1 });
    await engine.drive(created.kind === "blocked" ? "" : created.bundle.run.id);
    const concept = JSON.stringify(fixtureConcept(TITLE));
    expect(seen[0]?.user).toContain(`剧名：${TITLE}`);
    expect(seen[0]?.user).not.toContain("已保存的故事策划");
    expect(seen[1]?.user).toContain(concept);
    expect(seen[2]?.user).toContain(concept);
    expect(seen[2]?.user).toContain("已保存的分集大纲");
    expect(seen[2]?.user).toContain("这是第一集");
    expect(seen[3]?.user).toContain("第 1 集交接事实：第 1 集结束时林夏知道林川还活着。");
    expect(seen[4]?.user).toContain("第 2 集交接事实");
    expect(seen.every((item) => item.body.model === "q-1")).toBe(true);
  });

  it("only the title is needed: no story, characters or prompt from the person", async () => {
    const { store, engine, run } = setup();
    const record = run(P1, "k", "天台");
    expect(Object.keys(record.input).sort()).toEqual(["model", "promptVersion", "providerKey", "schema", "settings", "title"]);
    const created = await store.createRun(record, { maxActiveRuns: 1 });
    await engine.drive(created.kind === "blocked" ? "" : created.bundle.run.id);
    expect((await store.latestRun(WS, P1))!.run.state).toBe("completed");
  });

  it("a replay with the same key and input starts nothing new; a different input with the same key conflicts", async () => {
    const { store, run } = setup();
    const first = run();
    expect((await store.createRun(first, { maxActiveRuns: 1 })).kind).toBe("created");
    const replay = { ...run(), inputHash: first.inputHash };
    const again = await store.createRun(replay, { maxActiveRuns: 1 });
    expect(again.kind).toBe("existing");
    expect(again.kind !== "blocked" && again.bundle.run.id).toBe(first.id);
    const other = run(P1, "key-1", "另一个剧名");
    expect((await store.createRun(other, { maxActiveRuns: 1 })).kind).toBe("conflict");
    expect(store.runs).toHaveLength(1);
  });

  it("a second start on the same project while one runs returns the active run; the workspace cap blocks other projects", async () => {
    const { store, run } = setup();
    await store.createRun(run(P1, "a"), { maxActiveRuns: 1 });
    expect((await store.createRun(run(P1, "b"), { maxActiveRuns: 1 })).kind).toBe("active");
    expect(await store.createRun(run(P2, "c"), { maxActiveRuns: 1 })).toEqual({ kind: "blocked", code: "TITLE_WRITING_ACTIVE_RUN_CAP" });
  });

  it("concurrent drives of one run send each step once", async () => {
    const { store, run, seen } = setup();
    const created = await store.createRun(run(), { maxActiveRuns: 1 });
    const runId = created.kind === "blocked" ? "" : created.bundle.run.id;
    const engineB = new TitleWritingEngine({ workspaceId: WS, store, providers: providers(), transport: fixtureChatTransport(TITLE, { seen }), maxCallsPerDay: 30 });
    const engineA = new TitleWritingEngine({ workspaceId: WS, store, providers: providers(), transport: fixtureChatTransport(TITLE, { seen }), maxCallsPerDay: 30 });
    await Promise.all([engineA.drive(runId), engineB.drive(runId), engineA.drive(runId)]);
    expect(seen.map((item) => item.step)).toEqual(["concept", "outline", "episode:1", "episode:2", "episode:3"]);
  });

  it("an invalid model answer is rejected, never saved, and the run is partial with completed steps kept", async () => {
    const { store, engine, run, seen } = setup({
      override: (step) => step === "episode:2" ? { status: 200, body: chatAnswer({ schema: "ads.writing.episode-draft.v1", episodeNo: 3 }) } : undefined,
    });
    const created = await store.createRun(run(), { maxActiveRuns: 1 });
    const runId = created.kind === "blocked" ? "" : created.bundle.run.id;
    await engine.drive(runId);
    const view = titleRunView((await store.getRunById(WS, runId))!);
    expect(view.state).toBe("partial");
    expect(view.steps.map((step) => step.state)).toEqual(["completed", "completed", "completed", "rejected", "pending"]);
    expect(view.steps[3]?.output).toBeNull();
    expect(view.steps[3]?.errorCode).toBe("invalid_output");
    expect(view.storySave).toBe("pending");
    expect(store.projects.get(P1)!.stories).toHaveLength(0);
    expect(seen).toHaveLength(4);
  });

  it.each([
    ["a wrong episode number", chatAnswer({ ...JSON.parse(JSON.stringify({ schema: "ads.writing.episode-draft.v1", episodeNo: 2, title: "x", screenplay: "x", scenes: [{ heading: "a", action: "b", dialogue: "", sound: "" }], handoffFacts: ["x"] })) }), "episode_mismatch"],
    ["an empty object", chatAnswer({}), "invalid_output"],
    ["unparsable text", chatAnswer("不是 JSON"), "invalid_output"],
    ["HTML in the text", chatAnswer({ schema: "ads.writing.episode-draft.v1", episodeNo: 1, title: "<b>x</b>", screenplay: "x", scenes: [{ heading: "a", action: "b", dialogue: "", sound: "" }], handoffFacts: ["x"] }), "unsafe_content"],
  ])("rejects %s", async (_label, body, code) => {
    const { store, engine, run } = setup({ override: (step) => step === "episode:1" ? { status: 200, body } : undefined });
    const created = await store.createRun(run(), { maxActiveRuns: 1 });
    const runId = created.kind === "blocked" ? "" : created.bundle.run.id;
    await engine.drive(runId);
    expect(titleRunView((await store.getRunById(WS, runId))!).steps[2]).toMatchObject({ state: "rejected", errorCode: code, output: null });
  });

  it("a concept whose narrative fields are only whitespace is rejected and the outline never starts", async () => {
    const blank = { ...fixtureConcept(TITLE), logline: "  ", synopsis: "\n\n", coreConflict: "\t" };
    const { store, engine, run, seen } = setup({ override: (step) => step === "concept" ? { status: 200, body: chatAnswer(blank) } : undefined });
    const created = await store.createRun(run(), { maxActiveRuns: 1 });
    const runId = created.kind === "blocked" ? "" : created.bundle.run.id;
    await engine.drive(runId);
    const view = titleRunView((await store.getRunById(WS, runId))!);
    expect(view).toMatchObject({ state: "failed", errorCode: "invalid_output" });
    expect(view.steps.map((step) => step.state)).toEqual(["rejected", "pending", "pending", "pending", "pending"]);
    expect(seen.map((item) => item.step)).toEqual(["concept"]);
  });

  it("an outline whose episode text is only whitespace is rejected and no episode starts", async () => {
    const { store, engine, run, seen } = setup({ override: (step) => step === "outline"
      ? { status: 200, body: chatAnswer({ ...fixtureOutline(), episodes: fixtureOutline().episodes.map((episode) => ({ ...episode, goal: " \n " })) }) }
      : undefined });
    const created = await store.createRun(run(), { maxActiveRuns: 1 });
    const runId = created.kind === "blocked" ? "" : created.bundle.run.id;
    await engine.drive(runId);
    expect(titleRunView((await store.getRunById(WS, runId))!)).toMatchObject({ state: "partial", errorCode: "invalid_output" });
    expect(seen.map((item) => item.step)).toEqual(["concept", "outline"]);
  });

  it("an outline missing an episode is rejected", async () => {
    const { store, engine, run } = setup({ override: (step) => step === "outline"
      ? { status: 200, body: chatAnswer({ schema: "ads.writing.episode-outline.v1", episodes: [] }) } : undefined });
    const created = await store.createRun(run(), { maxActiveRuns: 1 });
    const runId = created.kind === "blocked" ? "" : created.bundle.run.id;
    await engine.drive(runId);
    expect(titleRunView((await store.getRunById(WS, runId))!).steps[1]).toMatchObject({ state: "rejected", errorCode: "invalid_output" });
  });

  it("an uncertain call (timeout) stops the run, is not resent, and resuming needs explicit confirmation", async () => {
    const { store, engine, run, seen } = setup({ override: (step, attempt) => step === "outline" && attempt === 1 ? "hang" : undefined });
    const created = await store.createRun(run(), { maxActiveRuns: 1 });
    const runId = created.kind === "blocked" ? "" : created.bundle.run.id;
    await engine.drive(runId);
    let view = titleRunView((await store.getRunById(WS, runId))!);
    expect(view.state).toBe("needs_attention");
    expect(view.steps[1]).toMatchObject({ state: "unknown", errorCode: "timeout" });
    expect(seen.map((item) => item.step)).toEqual(["concept", "outline"]);
    await engine.drive(runId);
    expect(seen).toHaveLength(2);
    expect((await resume(store, P1, runId, false)).kind).toBe("needs_confirmation");
    expect((await resume(store, P1, runId, true)).kind).toBe("ok");
    await engine.drive(runId);
    view = titleRunView((await store.getRunById(WS, runId))!);
    expect(view.state).toBe("completed");
    // The completed concept was reused; only the uncertain outline and the remaining steps were sent.
    expect(seen.map((item) => item.step)).toEqual(["concept", "outline", "outline", "episode:1", "episode:2", "episode:3"]);
    expect(view.calls.filter((call) => call.stepKey === "outline").map((call) => call.state)).toEqual(["unknown", "completed"]);
  });

  it.each([
    [500, "server_error", "needs_attention"],
    [401, "auth", "failed"],
    [429, "rate_limited", "failed"],
  ] as const)("HTTP %s on the first step → %s, run %s, no automatic resend", async (status, code, state) => {
    const { store, engine, run, seen } = setup({ override: () => ({ status, body: { error: { message: "x" } } }) });
    const created = await store.createRun(run(), { maxActiveRuns: 1 });
    const runId = created.kind === "blocked" ? "" : created.bundle.run.id;
    await engine.drive(runId);
    const view = titleRunView((await store.getRunById(WS, runId))!);
    expect(view).toMatchObject({ state, errorCode: code });
    expect(seen).toHaveLength(1);
  });

  it("never switches to another provider after a failure", async () => {
    const { store, engine, run, seen } = setup({ override: () => ({ status: 503, body: {} }) });
    const created = await store.createRun(run(), { maxActiveRuns: 1 });
    await engine.drive(created.kind === "blocked" ? "" : created.bundle.run.id);
    expect(new Set(seen.map((item) => item.url))).toEqual(new Set(["https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"]));
  });

  it("resuming a partial run sends only the rejected and later steps", async () => {
    const { store, engine, run, seen } = setup({ override: (step, attempt) => step === "episode:2" && attempt === 1 ? { status: 401, body: {} } : undefined });
    const created = await store.createRun(run(), { maxActiveRuns: 1 });
    const runId = created.kind === "blocked" ? "" : created.bundle.run.id;
    await engine.drive(runId);
    expect((await store.getRunById(WS, runId))!.run.state).toBe("partial");
    expect((await resume(store, P1, runId, false)).kind).toBe("ok");
    await engine.drive(runId);
    expect(seen.map((item) => item.step)).toEqual(["concept", "outline", "episode:1", "episode:2", "episode:2", "episode:3"]);
    expect((await store.getRunById(WS, runId))!.run.state).toBe("completed");
    expect((await resume(store, P1, runId, true)).kind).toBe("not_resumable");
  });

  it("resuming respects the workspace active-run cap", async () => {
    const { store, engine, run } = setup({ override: (step) => step === "concept" ? { status: 401, body: {} } : undefined });
    const first = await store.createRun(run(P1, "a"), { maxActiveRuns: 1 });
    const firstId = first.kind === "blocked" ? "" : first.bundle.run.id;
    await engine.drive(firstId);
    expect((await store.createRun(run(P2, "b"), { maxActiveRuns: 1 })).kind).toBe("created");
    expect((await resume(store, P1, firstId, false)).kind)
      .toBe("active_cap");
  });

  it("the workspace daily call cap is enforced on the server", async () => {
    const { store, engine, run, seen } = setup({ maxCallsPerDay: 2 });
    const created = await store.createRun(run(), { maxActiveRuns: 1 });
    const runId = created.kind === "blocked" ? "" : created.bundle.run.id;
    await engine.drive(runId);
    const view = titleRunView((await store.getRunById(WS, runId))!);
    expect(view).toMatchObject({ state: "partial", errorCode: "TITLE_WRITING_DAILY_CAP" });
    expect(seen).toHaveLength(2);
  });

  it("the per-run call cap stops resends", async () => {
    let failures = 0;
    const { store, engine, run, seen } = setup({ override: (step) => {
      if (step !== "concept") return undefined;
      failures += 1;
      return { status: 401, body: {} };
    } });
    const created = await store.createRun(run(), { maxActiveRuns: 1 });
    const runId = created.kind === "blocked" ? "" : created.bundle.run.id;
    for (let index = 0; index < TITLE_WRITING_CALL_CAP_PER_RUN + 2; index += 1) {
      await engine.drive(runId);
      await resume(store, P1, runId, false);
    }
    await engine.drive(runId);
    expect(seen).toHaveLength(TITLE_WRITING_CALL_CAP_PER_RUN);
    expect(failures).toBe(TITLE_WRITING_CALL_CAP_PER_RUN);
    expect((await store.getRunById(WS, runId))!.run).toMatchObject({ state: "failed", errorCode: "TITLE_WRITING_RUN_CAP" });
  });

  it("cancel stops later steps; the in-flight call keeps its real outcome and billing stays unknown", async () => {
    let cancel: (() => Promise<void>) | null = null;
    const store = new InMemoryTitleWritingStore();
    store.addProject(WS, P1);
    const seen: FixtureExchange[] = [];
    const inner = fixtureChatTransport(TITLE, { seen });
    const transport: WritingTransport = async (request) => {
      const answer = await inner(request);
      if (seen.length === 2 && cancel) await cancel();
      return answer;
    };
    const engine = new TitleWritingEngine({ workspaceId: WS, store, providers: providers(), transport, maxCallsPerDay: 30 });
    const record = newTitleRun({ workspaceId: WS, projectId: P1, actorId: "a", idempotencyKey: "k", title: TITLE,
      settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "qwen", model: "q-1", now: new Date() });
    await store.createRun(record, { maxActiveRuns: 1 });
    cancel = async () => { await store.requestCancel(WS, P1, record.id, new Date().toISOString()); };
    await engine.drive(record.id);
    const view = titleRunView((await store.getRunById(WS, record.id))!);
    expect(view.state).toBe("canceled");
    expect(view.steps.map((step) => step.state)).toEqual(["completed", "completed", "canceled", "canceled", "canceled"]);
    expect(view.calls.map((call) => [call.stepKey, call.state, call.billingStatus])).toEqual([
      ["concept", "completed", "unknown"], ["outline", "completed", "unknown"],
    ]);
    expect(seen).toHaveLength(2);
  });

  it("restart recovery: a call that was sent becomes unknown and is not resent; one never sent is sent once", async () => {
    let now = Date.parse("2026-10-08T00:00:00Z");
    const clock = () => new Date(now);
    const store = new InMemoryTitleWritingStore();
    store.addProject(WS, P1);
    const record = newTitleRun({ workspaceId: WS, projectId: P1, actorId: "a", idempotencyKey: "k", title: TITLE,
      settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "qwen", model: "q-1", now: clock() });
    await store.createRun(record, { maxActiveRuns: 1 });
    // A crashed executor: claimed, reserved the concept call and marked it submitted, then died.
    expect(await store.claimRun(WS, record.id, "dead", clock().toISOString(), new Date(now + 1000).toISOString())).toBe(true);
    const callId = "44444444-4444-4444-8444-444444444444";
    await store.reserveCall({ id: callId, runId: record.id, workspaceId: WS, stepKey: "concept", attemptNo: 1, providerKey: "qwen",
      model: "q-1", requestHash: "h", state: "reserved", executorId: "dead", providerRequestId: null, responseModel: null,
      usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null }, errorCode: null,
      createdAt: clock().toISOString(), finishedAt: null }, { sinceIso: "2026-10-07T00:00:00Z", maxCallsPerDay: 30 },
    clock().toISOString(), new Date(now + 1000).toISOString());
    await store.markCallSubmitted(WS, callId, "dead", clock().toISOString(), new Date(now + 1000).toISOString());
    const seen: FixtureExchange[] = [];
    const engine = new TitleWritingEngine({ workspaceId: WS, store, providers: providers(), transport: fixtureChatTransport(TITLE, { seen }), maxCallsPerDay: 30, clock });
    await engine.maintain();
    expect(seen).toHaveLength(0);
    now += 2000;
    await engine.maintain();
    expect(seen).toHaveLength(0);
    const view = titleRunView((await store.getRunById(WS, record.id))!);
    expect(view.state).toBe("needs_attention");
    expect(view.calls[0]).toMatchObject({ state: "unknown", errorCode: "executor_lost" });

    // Never sent: recovery frees the step and the next maintenance pass continues the run.
    const second = newTitleRun({ workspaceId: WS, projectId: P1, actorId: "a", idempotencyKey: "k2", title: TITLE,
      settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "qwen", model: "q-1", now: clock() });
    await store.createRun(second, { maxActiveRuns: 1 });
    await store.claimRun(WS, second.id, "dead", clock().toISOString(), new Date(now + 1000).toISOString());
    await store.reserveCall({ id: "55555555-5555-4555-8555-555555555555", runId: second.id, workspaceId: WS, stepKey: "concept",
      attemptNo: 1, providerKey: "qwen", model: "q-1", requestHash: "h", state: "reserved", executorId: "dead",
      providerRequestId: null, responseModel: null, usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null },
      errorCode: null, createdAt: clock().toISOString(), finishedAt: null }, { sinceIso: "2026-10-07T00:00:00Z", maxCallsPerDay: 30 },
    clock().toISOString(), new Date(now + 1000).toISOString());
    now += 2000;
    await engine.maintain();
    expect(seen.map((item) => item.step)).toEqual(["concept", "outline", "episode:1", "episode:2", "episode:3"]);
    expect((await store.getRunById(WS, second.id))!.run.state).toBe("completed");
  });

  it("a fenced executor's late answer cannot overwrite recovery", async () => {
    let now = Date.parse("2026-10-08T00:00:00Z");
    const clock = () => new Date(now);
    const store = new InMemoryTitleWritingStore();
    store.addProject(WS, P1);
    const record = newTitleRun({ workspaceId: WS, projectId: P1, actorId: "a", idempotencyKey: "k", title: TITLE,
      settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "qwen", model: "q-1", now: clock() });
    await store.createRun(record, { maxActiveRuns: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const inner = fixtureChatTransport(TITLE);
    const slow: WritingTransport = async (request) => { await gate; return inner(request); };
    const engine = new TitleWritingEngine({ workspaceId: WS, store, providers: providers(), transport: slow, maxCallsPerDay: 30, clock, leaseMs: 1000 });
    const driving = engine.drive(record.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    now += 5000;
    expect(await store.recoverExpired(WS, clock().toISOString())).toBe(1);
    release();
    await driving;
    const view = titleRunView((await store.getRunById(WS, record.id))!);
    expect(view.state).toBe("needs_attention");
    expect(view.steps[0]).toMatchObject({ state: "unknown", output: null });
  });

  it("an existing human story is not overwritten: the result is kept and the run reports a conflict", async () => {
    const { store, engine, run } = setup();
    store.writeHumanStory(P1, "我自己写的故事");
    const created = await store.createRun(run(), { maxActiveRuns: 1 });
    const runId = created.kind === "blocked" ? "" : created.bundle.run.id;
    await engine.drive(runId);
    const view = titleRunView((await store.getRunById(WS, runId))!);
    expect(view).toMatchObject({ state: "needs_attention", errorCode: "story_conflict", storySave: "conflict" });
    expect(view.storyText).toContain("故事梗概");
    expect(store.projects.get(P1)!.stories.map((story) => story.text)).toEqual(["我自己写的故事"]);
  });

  it("scripts are placed only after a person approved the story, and never over an existing script", async () => {
    const { store, engine, run } = setup();
    const created = await store.createRun(run(), { maxActiveRuns: 1 });
    const runId = created.kind === "blocked" ? "" : created.bundle.run.id;
    await engine.drive(runId);
    const now = new Date().toISOString();
    expect((await store.placeScripts(WS, P1, runId, { acceptStoryChanged: false }, "a", now)).kind).toBe("story_not_approved");
    store.approveCurrentStory(P1);
    store.projects.get(P1)!.episodes.get(2)!.currentScriptId = "human-script";
    const placed = await store.placeScripts(WS, P1, runId, { acceptStoryChanged: false }, "a", now);
    expect(placed.kind).toBe("ok");
    const view = titleRunView(placed.kind === "ok" ? placed.bundle : (await store.getRunById(WS, runId))!);
    expect(view.steps.slice(2).map((step) => step.scriptSave)).toEqual(["saved", "conflict", "saved"]);
    expect(store.projects.get(P1)!.episodes.get(2)!.currentScriptId).toBe("human-script");
    // Placing again changes nothing.
    await store.placeScripts(WS, P1, runId, { acceptStoryChanged: false }, "a", now);
    expect(store.projects.get(P1)!.episodes.get(1)!.scripts).toHaveLength(1);
  });

  it("a story edited before approval needs explicit acceptance before scripts are placed", async () => {
    const { store, engine, run } = setup();
    const created = await store.createRun(run(), { maxActiveRuns: 1 });
    const runId = created.kind === "blocked" ? "" : created.bundle.run.id;
    await engine.drive(runId);
    store.writeHumanStory(P1, "改过的故事");
    store.approveCurrentStory(P1);
    const now = new Date().toISOString();
    expect((await store.placeScripts(WS, P1, runId, { acceptStoryChanged: false }, "a", now)).kind).toBe("story_changed");
    expect((await store.placeScripts(WS, P1, runId, { acceptStoryChanged: true }, "a", now)).kind).toBe("ok");
  });

  it("an unconfigured provider stops before any send and never falls back to another provider", async () => {
    const { store, engine, run, seen } = setup({ providerKey: "openai", model: "o-1" });
    const created = await store.createRun(run(), { maxActiveRuns: 1 });
    const runId = created.kind === "blocked" ? "" : created.bundle.run.id;
    await engine.drive(runId);
    expect((await store.getRunById(WS, runId))!.run).toMatchObject({ state: "needs_attention", errorCode: "provider_unconfigured" });
    expect(seen).toHaveLength(0);
  });
});
