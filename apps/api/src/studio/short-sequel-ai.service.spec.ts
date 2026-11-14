import { describe, expect, it, vi } from "vitest";
import type { ShortSequelAiAttempt, ShortSequelAiView } from "@ai-drama/contracts";
import type { ShortSequelContext } from "@ai-drama/database";
import { titleWritingProviderConfigs, type WritingTransport } from "@ai-drama/providers";
import { messagesAnswer } from "@ai-drama/providers/title-writing-fixtures";
import { ShortSequelAiService, type ShortSequelAiDependencies } from "./short-sequel-ai.service";

const PROJECT = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const EPISODE = "33333333-3333-4333-8333-333333333333";
const PREVIOUS = "44444444-4444-4444-8444-444444444444";
const ORIGINAL_RUN = "55555555-5555-4555-8555-555555555555";
const TOKEN = "sequel-test-operator";
const proof = { token: TOKEN, session: false };
const actor = (idempotencyKey: string) => ({ actorId: "server-owner", traceId: "t", idempotencyKey });

const HANDOFF = "林澈把纸鹤交给守夜人。";
const ANSWER = { episodeNo: 2, episodeCount: 2, previousHandoff: HANDOFF, title: "纸鹤背面", openingHook: "守夜人展开纸鹤。", change: "露出一行编号。",
  endingHandoff: "林澈去核对编号。", characterKnowledge: "林澈看见编号。", unresolvedThreads: "编号指向谁？",
  scenes: [{ locationId: "L1", timeOfDay: "DAY", characterIds: ["C1"],
    beats: [{ kind: "action", characterId: null, text: "林澈辨认纸背的笔画。", seconds: 4 }] }] };

function setup(responses: Array<typeof ANSWER | "timeout"> = [ANSWER]) {
  const original = { runId: ORIGINAL_RUN, constraints: { maxCharacters: 1, maxLocations: 1 },
    research: { observation: "以具体动作呈现选择" }, topic: { chosen: "纸鹤" },
    story: { characters: [{ id: "C1", name: "林澈", presence: "on_screen" }], locations: [{ id: "L1", name: "钟表铺", intExt: "INT" }] },
    outline: { episodes: [{ episodeNo: 1 }] }, previousScript: { handoffFacts: [HANDOFF] },
    previousScriptText: HANDOFF, previousStageHash: "sha" };
  const context = { episodeNo: 2, episodeId: EPISODE, episodeCount: 2, targetEpisodeSeconds: 60,
    storyRevisionId: null, storyConfirmed: false, story: null, previousEpisodeNo: 1, previousLocked: false,
    confirmedStoryRevisionId: null, lastConfirmedStoryRevisionId: null, lockedPreviousRevisionId: null,
    currentStoryRevisionId: null, currentStoryRevisionNo: null, lastConfirmedStoryRevisionNo: null, lastConfirmedEpisodeCount: null,
    planConfirmation: 0, previousFreshnessStatus: "CURRENT", lockedPreviousFreshnessStatus: null, previousHandoff: HANDOFF,
    previousScript: { text: original.previousScriptText }, previousRevisionId: null, originalRunId: ORIGINAL_RUN, originalEpisodeHash: "sha",
    original, placedOriginal: null, lockedOriginal: null, hasBody: false } as unknown as ShortSequelContext;
  const attempts: ShortSequelAiAttempt[] = [];
  const queued: Array<() => Promise<void>> = [];
  const store: ShortSequelAiDependencies["store"] = {
    storageReady: async () => true, providerStorageReady: async () => true,
    createShortSequel: async (attempt, options) => {
      const latest = attempts[0];
      if (options.expectedAttemptId && latest?.id !== options.expectedAttemptId) return { kind: "advanced", attempt: latest! };
      const uncertainId = latest?.state === "unknown" ? latest.id : null;
      if (uncertainId !== options.confirmUncertainAttemptId) return { kind: "needs_confirmation" };
      attempts.unshift(attempt);
      return { kind: "created", attempt };
    },
    getShortSequelAttempt: async (_workspaceId, id) => attempts.find(attempt => attempt.id === id) ?? null,
    findShortSequelByKey: async (_workspaceId, _actorId, key) => attempts.find(attempt => attempt.idempotencyKey === key) ?? null,
    listShortSequels: async (_workspaceId, _projectId, _episodeId, cursor) => ({
      attempts: cursor ? attempts.slice(1, 2) : attempts.slice(0, 1), nextCursor: !cursor && attempts.length > 1 ? "next" : null,
    }),
    markShortSequelSubmitted: async attempt => { attempt.state = "submitted"; return true; },
    closeUnsent: async (_workspaceId, id, _executorId, reason) => {
      const attempt = attempts.find(item => item.id === id)!;
      attempt.state = "rejected";
      attempt.errorCode = reason;
      return true;
    },
    finishShortSequel: async (_workspaceId, id, _executorId, patch) => {
      const attempt = attempts.find(item => item.id === id)!;
      attempt.state = patch.state;
      attempt.script = patch.candidate;
      attempt.errorCode = patch.errorCode;
      return true;
    },
  };
  const transport = vi.fn<WritingTransport>(async () => {
    const response = responses.shift();
    if (response === "timeout") throw Object.assign(new Error("timed out"), { name: "AbortError" });
    return { status: 200, headers: { get: () => null }, body: new TextEncoder().encode(JSON.stringify(messagesAnswer(response))) };
  });
  const service = new ShortSequelAiService({ workspaceId: WORKSPACE, enabled: true, operatorToken: TOKEN,
    siteOperator: false, defaultProvider: "anthropic", providers: titleWritingProviderConfigs({
      ANTHROPIC_API_KEY: "sk-ant-api03-test-not-real-01020304", TITLE_WRITING_ANTHROPIC_MODELS: "claude-test",
    }), source: { context: async () => context }, store, transport, maxCallsPerDay: 20, maxActiveRuns: 3,
    schedule: run => { queued.push(run); } });
  const start = (key: string) => service.start(PROJECT, 2, { direction: "用编号引出新线索" }, proof, actor(key));
  const latest = async () => ((await service.latest(PROJECT, 2)).body as ShortSequelAiView).task!;
  const run = async () => queued.shift()?.();
  return { service, context, attempts, transport, start, latest, run };
}

describe("short sequel AI task", () => {
  it("sends only the sequel, freezes previous context, and keeps the candidate out of saved episode content", async () => {
    const { context, attempts, transport, start, latest, run } = setup();
    expect((await start("a")).status).toBe(202);
    expect((await start("a")).status).toBe(200);
    await run();
    expect(transport).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(transport.mock.calls[0]![0].body) as { system: string; messages: Array<{ content: string }> };
    expect(payload.system).toContain("本剧计划共 2 集。本次只续写第 2 集");
    expect(payload.messages[0]!.content).toContain(HANDOFF);
    expect(payload.messages[0]!.content).toContain("以具体动作呈现选择");
    expect(await latest()).toMatchObject({ state: "completed", stale: false, episodeCount: 2, billing: "unknown",
      source: { originalRunId: ORIGINAL_RUN, originalEpisodeHash: "sha" },
      script: { title: "纸鹤背面", previousRevisionId: null, previousHandoff: HANDOFF } });
    expect(JSON.stringify(attempts[0]!.input)).not.toContain(HANDOFF);
    expect(context.hasBody).toBe(false);
    context.previousRevisionId = PREVIOUS;
    context.originalRunId = null;
    context.originalEpisodeHash = null;
    context.previousScript = { text: "改版后的前集" };
    context.lockedOriginal = { runId: ORIGINAL_RUN, episodeHash: "sha" };
    expect(await latest()).toMatchObject({ stale: false });
    context.lockedOriginal = null;
    context.lockedPreviousRevisionId = PREVIOUS;
    expect(await latest()).toMatchObject({ stale: true, script: { title: "纸鹤背面" } });
  });

  it("resumes an uncertain send only with confirmation and preserves task identity", async () => {
    const { service, transport, start, latest, run } = setup(["timeout", ANSWER]);
    await start("start");
    await run();
    const staleAttempt = await latest();
    expect(staleAttempt.state).toBe("unknown");
    const resume = (key: string, confirmUncertain: boolean) => service.resume(PROJECT, 2, staleAttempt.taskId,
      { attemptId: staleAttempt.attemptId, confirmUncertain }, proof, actor(key));
    expect((await resume("unconfirmed", false)).status).toBe(409);
    expect((await resume("confirmed", true)).status).toBe(202);
    expect((await resume("repeated", true)).status).toBe(200);
    await run();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(await latest()).toMatchObject({ taskId: staleAttempt.taskId, state: "completed" });
  });

  it("refuses to regenerate with consent for an earlier unknown attempt of the same task", async () => {
    const { service, transport, start, latest, run } = setup(["timeout", "timeout", ANSWER]);
    await start("start");
    await run();
    const earlier = await latest();
    await service.resume(PROJECT, 2, earlier.taskId, { attemptId: earlier.attemptId, confirmUncertain: true }, proof, actor("other-tab"));
    await run();
    const current = await latest();
    expect(current).toMatchObject({ taskId: earlier.taskId, state: "unknown" });
    expect(current.attemptId).not.toBe(earlier.attemptId);
    const regenerate = (key: string, attemptId: string) => service.start(PROJECT, 2, { confirmUncertainAttemptId: attemptId }, proof, actor(key));
    expect((await regenerate("stale-tab", earlier.attemptId)).body).toMatchObject({ error: { code: "SHORT_SEQUEL_AI_NEEDS_CONFIRMATION" } });
    await run();
    expect(transport).toHaveBeenCalledTimes(2);
    expect((await regenerate("updated-tab", current.attemptId)).status).toBe(202);
    await run();
    expect(await latest()).toMatchObject({ state: "completed" });
  });

  it("returns a separate page of older candidates, including expired scripts", async () => {
    const { service, context, start, run } = setup([ANSWER, ANSWER]);
    await start("older");
    await run();
    await start("newer");
    await run();
    context.previousFreshnessStatus = "STALE";
    expect((await service.latest(PROJECT, 2)).body).toMatchObject({ nextCursor: "next" });
    expect((await service.history(PROJECT, 2, "next")).body).toMatchObject({
      items: [{ stale: true, script: { title: "纸鹤背面" } }], nextCursor: null,
    });
    expect((await service.history(PROJECT, 2, ["next"])).status).toBe(400);
  });

  it("allows a pre-plan AI draft at its exact first confirmation and expires it on a later confirmation", async () => {
    const { context, start, run, latest } = setup();
    await start("before-plan");
    await run();
    context.storyRevisionId = "66666666-6666-4666-8666-666666666666";
    expect(await latest()).toMatchObject({ stale: false });
    context.confirmedStoryRevisionId = context.storyRevisionId;
    context.lastConfirmedStoryRevisionId = context.storyRevisionId;
    context.currentStoryRevisionId = context.storyRevisionId;
    context.lastConfirmedEpisodeCount = 2;
    context.planConfirmation = 1;
    context.storyConfirmed = true;
    expect(await latest()).toMatchObject({ stale: false, script: { title: "纸鹤背面" } });
    context.planConfirmation = 2;
    context.lastConfirmedStoryRevisionId = "77777777-7777-4777-8777-777777777777";
    expect(await latest()).toMatchObject({ stale: true });
  });

  it("keeps a draft of the two-episode plan readable when episode three is added before confirmation", async () => {
    const { context, start, run, latest } = setup();
    const plan = "66666666-6666-4666-8666-666666666666";
    context.storyRevisionId = context.currentStoryRevisionId = plan;
    await start("draft-with-plan");
    await run();
    context.episodeCount = 3;
    context.storyRevisionId = null;
    expect(await latest()).toMatchObject({ stale: false, source: { storyRevisionId: plan }, episodeCount: 2 });
    context.storyRevisionId = context.currentStoryRevisionId = "77777777-7777-4777-8777-777777777777";
    expect(await latest()).toMatchObject({ stale: false });
    context.confirmedStoryRevisionId = context.lastConfirmedStoryRevisionId = context.storyRevisionId;
    context.lastConfirmedEpisodeCount = 3;
    context.planConfirmation = 1;
    expect(await latest()).toMatchObject({ stale: true, script: { title: "纸鹤背面" } });
  });

  it("refuses a new AI draft and a queued send if its predecessor becomes stale without changing revision IDs", async () => {
    const { context, transport, start, latest, run } = setup();
    context.previousRevisionId = PREVIOUS;
    context.previousScript = { text: HANDOFF };
    context.originalRunId = null;
    context.originalEpisodeHash = null;
    context.previousLocked = true;
    expect((await start("queued-with-current-predecessor")).status).toBe(202);
    context.previousFreshnessStatus = "STALE";
    context.previousLocked = false;
    expect((await start("stale-predecessor")).status).toBe(409);
    await run();
    expect(transport).not.toHaveBeenCalled();
    expect(await latest()).toMatchObject({ state: "rejected", errorCode: "source_changed" });
  });

  it("preserves a body saved while queued without sending and refuses an invalid returned episode count", async () => {
    const queued = setup();
    await queued.start("before-edit");
    queued.context.hasBody = true;
    await queued.run();
    expect(queued.transport).not.toHaveBeenCalled();
    expect((await queued.start("after-edit")).body).toMatchObject({ error: { code: "SHORT_SEQUEL_AI_BODY_EXISTS" } });
    const bad = setup([{ ...ANSWER, episodeNo: 1, episodeCount: 1 }]);
    await bad.start("invalid-output");
    await bad.run();
    expect(await bad.latest()).toMatchObject({ state: "rejected", script: null, errorCode: "invalid_output" });
  });

  it.each([
    ["an altered frozen handoff", { previousHandoff: "林澈烧了纸鹤。" }],
    ["a one-episode total in the title", { title: "本剧共 1 集" }],
    ["a Chinese one-episode total", { change: "全剧只有一集。" }],
    ["a fullwidth one-episode total", { endingHandoff: "总集数：１集。" }],
    ["an English one-episode total", { title: "A one-episode series" }],
    ["a rewritten first episode", { openingHook: "第一集改为林澈烧了纸鹤。" }],
    ["a rewrite of the prior ending in a scene", { scenes: [{ ...ANSWER.scenes[0], beats: [{ ...ANSWER.scenes[0]!.beats[0], text: "上集结局是林澈烧了纸鹤。" }] }] }],
    ["a different outcome declared in narration", { openingHook: "上一集里林澈早已烧了纸鹤。" }],
  ] satisfies Array<[string, Partial<typeof ANSWER>]>)("rejects correct numeric metadata with %s", async (_name, patch) => {
    const { start, run, latest } = setup([{ ...ANSWER, ...patch }]);
    await start("bad-prose");
    await run();
    expect(await latest()).toMatchObject({ state: "rejected", script: null, errorCode: "invalid_output" });
  });
});
