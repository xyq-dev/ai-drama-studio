import { describe, expect, it } from "vitest";
import {
  autoCreationHardCap,
  autoCreationNormalCalls,
  autoCreationWorstCalls,
  autoCreationInitialStageKeys,
  autoCreationConstraintsSchema,
  autoRevisionSchema,
  type AutoCreationConstraints,
  type AutoCreationFrozenInput,
  type TitleWritingProviderKey,
} from "@ai-drama/contracts";
import { AUTO_DRAFT_BANNER, autoPackageJson, autoPackageMarkdown, AUTO_CREATION_SYSTEM_PROMPTS } from "@ai-drama/domain";
import { titleWritingProviderConfigs, type WritingProviderConfig } from "./text-writing";
import { AutoCreationEngine, InMemoryAutoCreationStore, autoRunView, autoScriptsOf, autoUncertainCallIds, hashAutoResume, newAutoRun } from "./auto-creation-engine";
import { autoFixtureTransport, fixtureAutoEpisode, type AutoFixtureExchange, type AutoFixturePlan } from "./auto-creation-fixtures";
import { messagesAnswer } from "./title-writing-fixtures";

const WS = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const START = Date.parse("2026-10-18T00:00:00Z");

function providers(): Record<TitleWritingProviderKey, WritingProviderConfig> {
  return titleWritingProviderConfigs({ ANTHROPIC_API_KEY: "sk-ant-api03-test-secret-0123456789", TITLE_WRITING_ANTHROPIC_MODELS: "m-1" });
}

interface Setup {
  episodeCount?: number;
  idea?: string;
  constraints?: Partial<AutoCreationConstraints>;
  revisionRounds?: number;
  callBudget?: number;
  plan?: AutoFixturePlan;
  providers?: Record<TitleWritingProviderKey, WritingProviderConfig>;
  providerKey?: TitleWritingProviderKey;
  maxCallsPerDay?: number;
  override?: Parameters<typeof autoFixtureTransport>[0]["override"];
  leaseMs?: number;
}

async function setup(options: Setup = {}) {
  let now = START;
  const clock = () => new Date(now);
  const advance = (ms: number) => { now += ms; };
  const store = new InMemoryAutoCreationStore();
  const episodeCount = options.episodeCount ?? 1;
  const rounds = options.revisionRounds ?? 2;
  store.addProject(WS, P1, episodeCount);
  const run = newAutoRun({
    workspaceId: WS, projectId: P1, actorId: "server-owner", idempotencyKey: "key-1",
    idea: options.idea ?? "", constraints: autoCreationConstraintsSchema.parse(options.constraints ?? {}), materials: [], referenceUrls: [],
    researchFetch: false, episodeCount, episodeSeconds: 60, revisionRounds: rounds,
    callBudget: options.callBudget ?? autoCreationHardCap(episodeCount, rounds), providerKey: options.providerKey ?? "anthropic", model: "m-1",
    authorization: { mode: "auto", proof: "site_session", initiatedBy: "server-owner", executor: "auto-creation-engine" }, now: clock(),
  });
  const created = await store.createRun(run, autoCreationInitialStageKeys(episodeCount), {
    maxActiveRuns: 1, sinceIso: new Date(now - 86_400_000).toISOString(), maxCallsPerDay: 100, requiredCalls: autoCreationNormalCalls(episodeCount),
  });
  expect(created.kind).toBe("created");
  const seen: AutoFixtureExchange[] = [];
  const engine = new AutoCreationEngine({
    workspaceId: WS, store, providers: options.providers ?? providers(), maxCallsPerDay: options.maxCallsPerDay ?? 100, clock,
    transport: autoFixtureTransport({ plan: options.plan, seen, override: options.override }), leaseMs: options.leaseMs ?? 240_000,
  });
  const view = async () => autoRunView((await store.getRunById(WS, run.id))!);
  return { store, run, engine, seen, view, advance, clock };
}

describe("automatic creation engine", () => {
  it("an empty idea runs research, a rule-based choice and one sixty-second episode to a saved machine draft", async () => {
    const { store, run, engine, seen, view } = await setup();
    await engine.drive(run.id);
    const result = await view();
    expect(result.state).toBe("completed");
    expect(result.quality).toBe("passed");
    expect(result.stages.map((stage) => [stage.stageKey, stage.state])).toEqual([
      ["sources", "completed"], ["research", "completed"], ["directions", "completed"], ["bible", "completed"], ["outline", "completed"],
      ["episode:1", "completed"], ["review:1", "completed"],
    ]);
    // The snapshot sends nothing: six paid calls for one episode, the normal count.
    expect(seen.map((item) => item.stage)).toEqual(["research", "directions", "bible", "outline", "episode:1", "review:1"]);
    expect(result.callsUsed).toBe(autoCreationNormalCalls(1));
    expect(result.researchMode).toBe("limited");
    const directions = result.stages.find((stage) => stage.stageKey === "directions")!.output as { selection: { chosenId: string; reasons: string[] } };
    expect(directions.selection.chosenId).toBe("D1");
    expect(directions.selection.reasons.join("")).toContain("不代表真实市场成功概率");
    // The reviewer has its own prompt; the writers never see it.
    expect(seen.find((item) => item.stage === "review:1")!.system).toBe(AUTO_CREATION_SYSTEM_PROMPTS.review);
    expect(seen.filter((item) => item.stage !== "review:1").every((item) => item.system !== AUTO_CREATION_SYSTEM_PROMPTS.review)).toBe(true);
    // Saved as a machine draft, never approved, never under a person's name.
    const project = store.projects.get(P1)!;
    expect(project.stories).toHaveLength(1);
    expect(project.stories[0]).toMatchObject({ reviewStatus: "DRAFT", createdBy: `auto-creation:${run.id}` });
    expect(project.stories[0]!.text.startsWith(AUTO_DRAFT_BANNER)).toBe(true);
    expect(project.approvedStoryId).toBeNull();
    expect(result).toMatchObject({ storySave: "saved", packageStatus: "ready", videoStatus: "not_started" });
    expect(result.calls.every((call) => call.billingStatus === "unknown")).toBe(true);
    // Running maintenance afterwards sends nothing and saves nothing again.
    await engine.maintain();
    expect(seen).toHaveLength(6);
    expect(project.stories).toHaveLength(1);
  });

  it("an idea and hard constraints are in every prompt; a bible over the character limit is refused, not stored", async () => {
    const { run, engine, seen, view } = await setup({ idea: "一个骑手在午夜前讨回工资", constraints: { maxCharacters: 2, forbiddenThemes: ["复仇"] } });
    await engine.drive(run.id);
    expect(seen.every((item) => item.user.includes("一个骑手在午夜前讨回工资"))).toBe(true);
    expect(seen.every((item) => item.user.includes("出场人物：最多 2 人") && item.user.includes("禁止题材或元素：复仇"))).toBe(true);
    const result = await view();
    expect(result.state).toBe("partial");
    expect(result.stages.find((stage) => stage.stageKey === "bible")).toMatchObject({ state: "rejected", errorCode: "constraint_violation", output: null });
    // Nothing after the refused stage was sent.
    expect(seen.map((item) => item.stage)).toEqual(["research", "directions", "bible"]);
  });

  it("a research answer with a number no source contains is refused (no invented market data)", async () => {
    const { run, engine, seen, view } = await setup({ plan: { fabricatedNumber: true } });
    await engine.drive(run.id);
    const result = await view();
    expect(result.state).toBe("failed");
    expect(result.stages.find((stage) => stage.stageKey === "research")).toMatchObject({ state: "rejected", errorCode: "unsourced_number" });
    expect(seen).toHaveLength(1);
  });

  it("the source snapshot records the official entries as unread and claims no video viewing", async () => {
    const { run, engine, view } = await setup();
    await engine.drive(run.id);
    const sources = (await view()).stages[0]!.output as { sources: Array<{ sourceId: string; status: string; readScope: string; excerpt: string }>; notes: string[] };
    const official = sources.sources.filter((item) => item.sourceId.startsWith("S-OE-"));
    expect(official).toHaveLength(3);
    expect(official.every((item) => item.status === "unreadable" && item.readScope === "none" && item.excerpt === "")).toBe(true);
    expect(sources.notes.join("")).toContain("没有观看任何视频");
    expect(sources.notes.join("")).toContain("资料有限策划模式");
  });

  it.each([3, 6])("%i episodes: each episode reads the earlier episodes' handoff facts and the run completes", async (count) => {
    const { run, engine, seen, view } = await setup({ episodeCount: count });
    await engine.drive(run.id);
    const result = await view();
    expect(result.state).toBe("completed");
    expect(result.callsUsed).toBe(autoCreationNormalCalls(count));
    const last = seen.find((item) => item.stage === `episode:${String(count)}`)!;
    expect(last.user).toContain(`第 ${String(count - 1)} 集结束时陈默拿到了巡查员的签名。`);
    expect(last.user).toContain("这是最后一集");
    expect(seen.find((item) => item.stage === "episode:1")!.user).toContain("这不是最后一集");
  });

  it("a verified high issue gets one targeted revision and a second review, and the episode's current version moves", async () => {
    const { run, engine, seen, view } = await setup({ plan: { review: { highIssueRounds: [1] } } });
    await engine.drive(run.id);
    const result = await view();
    expect(result.state).toBe("completed");
    expect(result.quality).toBe("passed");
    expect(seen.map((item) => item.stage).slice(-3)).toEqual(["review:1", "revise:1:episode:1", "review:2"]);
    expect(seen.find((item) => item.stage === "revise:1:episode:1")!.user).toContain("R1");
    expect(result.revisionRoundsUsed).toBe(1);
    expect(result.callsUsed).toBe(autoCreationNormalCalls(1) + 2);
    expect(result.currentEpisodes).toEqual({ "episode:1": "revise:1:episode:1" });
    expect(result.stages.find((stage) => stage.stageKey === "episode:1")!.supersededBy).toBe("revise:1:episode:1");
    // The revision itself is current: its own earlier version being replaced is no upstream change.
    expect(result.stages.find((stage) => stage.stageKey === "revise:1:episode:1")!.upstreamChanged).toBe(false);
  });

  it("a revised episode marks the later episodes built from its old version as needing review", async () => {
    const { run, engine, view } = await setup({ episodeCount: 3, plan: { review: { highIssueRounds: [1] } } });
    await engine.drive(run.id);
    const result = await view();
    const flag = (key: string) => result.stages.find((stage) => stage.stageKey === key)!.upstreamChanged;
    expect([flag("episode:1"), flag("episode:2"), flag("episode:3"), flag("revise:1:episode:1")]).toEqual([false, true, true, false]);
  });

  it("a deterministic length finding (six scenes in sixty seconds) is revised without the model naming it", async () => {
    const { run, engine, view } = await setup({ plan: { longEpisodes: [1] } });
    await engine.drive(run.id);
    const result = await view();
    const review = result.stages.find((stage) => stage.stageKey === "review:1")!.output as { passed: boolean; deterministic: Array<{ check: string }> };
    expect(review.passed).toBe(false);
    expect(review.deterministic.map((item) => item.check)).toContain("scene_count");
    expect(result.quality).toBe("passed");
    expect(result.currentEpisodes["episode:1"]).toBe("revise:1:episode:1");
  });

  it("still failing after two rounds stays at needs work with its open issues; it is never marked passed", async () => {
    const { run, engine, seen, view } = await setup({ plan: { review: { highIssueRounds: [1, 2, 3] } } });
    await engine.drive(run.id);
    const result = await view();
    expect(result.state).toBe("completed");
    expect(result.quality).toBe("needs_work");
    expect(result.errorCode).toBe("revision_rounds_exhausted");
    expect(result.revisionRoundsUsed).toBe(2);
    expect(seen.map((item) => item.stage).slice(-5)).toEqual(["review:1", "revise:1:episode:1", "review:2", "revise:2:episode:1", "review:3"]);
    expect(result.callsUsed).toBe(autoCreationWorstCalls(1, 2));
    expect(result.openIssues.map((item) => item.id)).toEqual(["R1"]);
    expect(result.packageStatus).toBe("ready");
  });

  it("a budget that cannot cover a whole revision round plans none and stops within the budget", async () => {
    const { run, engine, seen, view } = await setup({ callBudget: autoCreationNormalCalls(1) + 1, plan: { review: { highIssueRounds: [1] } } });
    await engine.drive(run.id);
    const result = await view();
    expect(result).toMatchObject({ state: "completed", quality: "needs_work", errorCode: "revision_budget_exhausted", revisionRoundsUsed: 0 });
    expect(seen).toHaveLength(autoCreationNormalCalls(1));
    expect(result.callsUsed).toBeLessThanOrEqual(result.callCap);
  });

  it("the workspace daily cap, shared with title writing, stops the run before the next reservation", async () => {
    const { store, run, engine, seen, view } = await setup({ maxCallsPerDay: 10 });
    for (let index = 0; index < 7; index += 1) store.otherCalls.push({ workspaceId: WS, createdAt: new Date(START).toISOString() });
    await engine.drive(run.id);
    const result = await view();
    expect(result).toMatchObject({ state: "partial", errorCode: "AUTO_CREATION_DAILY_CAP" });
    expect(seen).toHaveLength(3);
    expect(store.calls.length + store.otherCalls.length).toBe(10);
  });

  it("a configured provider that is not usable stops the run without sending to another provider", async () => {
    const { run, engine, seen, view } = await setup({ providers: titleWritingProviderConfigs({ OPENAI_API_KEY: "sk-openai-test-0123456789", TITLE_WRITING_OPENAI_MODELS: "o-1" }) });
    await engine.drive(run.id);
    const result = await view();
    expect(result).toMatchObject({ state: "needs_attention", errorCode: "provider_unconfigured", callsUsed: 0 });
    expect(seen).toHaveLength(0);
  });

  it("a DeepSeek run without the adapter mark is never sent for", async () => {
    const { store, run, engine, seen, view } = await setup();
    const stored = store.runs.find((item) => item.id === run.id)!;
    stored.input = { ...stored.input, providerKey: "deepseek" } as AutoCreationFrozenInput;
    delete (stored.input as { providerAdapter?: string }).providerAdapter;
    await engine.drive(run.id);
    expect((await view()).errorCode).toBe("legacy_provider_run");
    expect(seen).toHaveLength(0);
  });

  it("an uncertain call is never resent automatically; resume needs the exact confirmation and replays once", async () => {
    const { store, run, engine, seen, view } = await setup({ override: (stage, attempt) => stage === "bible" && attempt === 1 ? "throw" : undefined });
    await engine.drive(run.id);
    let result = await view();
    expect(result).toMatchObject({ state: "needs_attention", errorCode: "disconnected" });
    await engine.maintain();
    expect(seen.filter((item) => item.stage === "bible")).toHaveLength(1);
    const bundle = (await store.getRunById(WS, run.id))!;
    const uncertain = autoUncertainCallIds(bundle.stages, bundle.calls);
    expect(uncertain).toHaveLength(1);
    const request = (confirmed: string[], key: string) => ({ resumeKey: key, requestHash: hashAutoResume(run.id, confirmed), confirmedCallIds: confirmed,
      maxActiveRuns: 1, providerReady: true });
    expect((await store.prepareResume(WS, P1, run.id, request([], "r-0"), new Date(START).toISOString())).kind).toBe("needs_confirmation");
    expect((await store.prepareResume(WS, P1, run.id, request(uncertain, "r-1"), new Date(START).toISOString())).kind).toBe("ok");
    await engine.drive(run.id);
    // Same key, same content: answered from the stored resume, nothing reset or sent.
    expect((await store.prepareResume(WS, P1, run.id, request(uncertain, "r-1"), new Date(START).toISOString())).kind).toBe("replayed");
    result = await view();
    expect(result.state).toBe("completed");
    expect(seen.filter((item) => item.stage === "bible")).toHaveLength(2);
    expect(result.calls.filter((call) => call.stageKey === "bible").map((call) => call.state)).toEqual(["unknown", "completed"]);
  });

  it("an expired lease: a submitted call becomes unknown, a late answer is dropped and nothing is resent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let parked = false;
    const ctx = await setup({ leaseMs: 1000 });
    const inner = autoFixtureTransport({ seen: ctx.seen });
    const engine = new AutoCreationEngine({ workspaceId: WS, store: ctx.store, providers: providers(), maxCallsPerDay: 100, clock: ctx.clock, leaseMs: 1000,
      transport: async (request) => {
        const answer = await inner(request);
        if (ctx.seen.at(-1)?.stage === "outline") { parked = true; await gate; }
        return answer;
      } });
    const driving = engine.drive(ctx.run.id);
    while (!parked) await new Promise((resolve) => setTimeout(resolve, 1));
    ctx.advance(5000);
    expect(await ctx.store.recoverExpired(WS, ctx.clock().toISOString())).toBe(1);
    release();
    await driving;
    const result = await ctx.view();
    expect(result.state).toBe("needs_attention");
    expect(result.stages.find((stage) => stage.stageKey === "outline")).toMatchObject({ state: "unknown", output: null, errorCode: "executor_lost" });
    ctx.advance(5000);
    await engine.maintain();
    expect(ctx.seen.filter((item) => item.stage === "outline")).toHaveLength(1);
  });

  it("a cancel committed before the send closes the reservation; nothing is sent", async () => {
    const { store, run, view, seen } = await setup();
    const engine = new AutoCreationEngine({ workspaceId: WS, store, providers: providers(), maxCallsPerDay: 100,
      transport: autoFixtureTransport({ seen }),
      send: async () => { throw new Error("must not send"); } });
    const original = store.markCallSubmitted.bind(store);
    store.markCallSubmitted = async (...args) => {
      await store.requestCancel(WS, P1, run.id, new Date().toISOString());
      return original(...args);
    };
    await engine.drive(run.id);
    const result = await view();
    expect(result.state).toBe("canceled");
    expect(result.calls[0]).toMatchObject({ state: "rejected", errorCode: "canceled_before_send" });
  });

  it("a story a person saved during the run is kept; the run reports the conflict and keeps its package", async () => {
    const { store, run, engine, view } = await setup();
    const original = store.saveStory.bind(store);
    store.saveStory = async (...args) => {
      store.writeHumanStory(P1, "人工写的故事");
      return original(...args);
    };
    await engine.drive(run.id);
    const result = await view();
    expect(result).toMatchObject({ state: "needs_attention", errorCode: "story_conflict", storySave: "conflict", packageStatus: "ready" });
    expect(store.projects.get(P1)!.stories.map((item) => item.text)).toEqual(["人工写的故事"]);
    // The downloaded package says the same as the view: every stage completed, so the script package is ready.
    const bundle = (await store.getRunById(WS, run.id))!;
    const json = autoPackageJson({ runId: run.id, projectId: P1, input: bundle.run.input, quality: bundle.run.quality, state: bundle.run.state,
      callsUsed: bundle.run.callsUsed, callCap: bundle.run.callCap, revisionRoundsUsed: bundle.run.revisionRoundsUsed, storySave: bundle.run.storySave,
      generatedAt: new Date().toISOString() }, bundle.stages) as { status: { scriptPackage: string } };
    expect(json.status.scriptPackage).toBe("ready");
  });

  it("scripts are written only after a person approves the story; a person's script is never overwritten; a repeat writes nothing", async () => {
    const { store, run, engine } = await setup({ episodeCount: 3 });
    await engine.drive(run.id);
    const bundle = (await store.getRunById(WS, run.id))!;
    const scripts = autoScriptsOf(bundle);
    expect((await store.placeScripts(WS, P1, run.id, scripts, { acceptStoryChanged: false }, "server-owner", new Date().toISOString())).kind).toBe("story_not_approved");
    store.approveCurrentStory(P1);
    store.writeHumanScript(P1, 2, "人工写的第二集");
    const placed = await store.placeScripts(WS, P1, run.id, scripts, { acceptStoryChanged: false }, "server-owner", new Date().toISOString());
    expect(placed.kind).toBe("ok");
    const episodes = store.projects.get(P1)!.episodes;
    expect(episodes.get(2)!.scripts.map((item) => item.text)).toEqual(["人工写的第二集"]);
    expect(episodes.get(1)!.scripts).toHaveLength(1);
    await store.placeScripts(WS, P1, run.id, scripts, { acceptStoryChanged: false }, "server-owner", new Date().toISOString());
    expect(episodes.get(1)!.scripts).toHaveLength(1);
    const placedBundle = (await store.getRunById(WS, run.id))!;
    const view = autoRunView(placedBundle);
    expect(view.stages.filter((stage) => stage.kind === "episode").map((stage) => stage.scriptSave)).toEqual(["saved", "conflict", "saved"]);
    // The exported package now records the person's approval that placement required.
    const meta = { runId: run.id, projectId: P1, input: placedBundle.run.input, quality: placedBundle.run.quality, state: placedBundle.run.state,
      callsUsed: placedBundle.run.callsUsed, callCap: placedBundle.run.callCap, revisionRoundsUsed: placedBundle.run.revisionRoundsUsed,
      storySave: placedBundle.run.storySave, generatedAt: new Date().toISOString() };
    expect((autoPackageJson(meta, placedBundle.stages) as { status: { humanReview: string } }).status.humanReview).toBe("approved_before_script_placement");
    expect(autoPackageMarkdown(meta, placedBundle.stages)).toContain("故事已由人工审核通过");
  });

  it("a blocking setting-level issue is not answered with paid episode rounds: needs work, unrevisable", async () => {
    const { run, engine, seen, view } = await setup({ plan: { review: { highIssueRounds: [1, 2, 3], bibleIssueRounds: [1] } } });
    await engine.drive(run.id);
    const result = await view();
    expect(result).toMatchObject({ state: "completed", quality: "needs_work", errorCode: "unrevisable_issues", revisionRoundsUsed: 0 });
    expect(seen.some((item) => item.stage.startsWith("revise:"))).toBe(false);
    expect(result.openIssues.map((item) => item.target)).toContain("bible");
  });

  it("a run ended without a save still records its final review quality", async () => {
    const { store, run, engine } = await setup();
    await store.claimRun(WS, run.id, engine.executorId, new Date(START).toISOString(), new Date(START + 60_000).toISOString());
    await store.finishRun(WS, run.id, engine.executorId, "needs_attention", "story_too_large", new Date(START).toISOString(), "needs_work");
    expect(store.runs.find((item) => item.id === run.id)).toMatchObject({ quality: "needs_work", errorCode: "story_too_large" });
  });

  it("scripts of an incomplete package (its review never completed) are never placed", async () => {
    const { store, run, engine } = await setup({ episodeCount: 1, override: (stage) => stage === "review:1" ? { status: 400, body: { error: "bad" } } : undefined });
    await engine.drive(run.id);
    const bundle = (await store.getRunById(WS, run.id))!;
    expect(bundle.run.state).toBe("partial");
    store.writeHumanStory(P1, "人工写的故事");
    store.approveCurrentStory(P1);
    const placed = await store.placeScripts(WS, P1, run.id, autoScriptsOf(bundle), { acceptStoryChanged: true }, "server-owner", new Date().toISOString());
    expect(placed.kind).toBe("not_ready");
    expect(store.projects.get(P1)!.episodes.get(1)!.scripts).toHaveLength(0);
  });

  it("a stopped run is not resumed while a title writing run is active on the same work", async () => {
    const { store, run } = await setup();
    await store.requestCancel(WS, P1, run.id, new Date().toISOString());
    const engine = new AutoCreationEngine({ workspaceId: WS, store, providers: providers(), maxCallsPerDay: 100, transport: autoFixtureTransport() });
    await engine.drive(run.id);
    store.titleRunning.set(P1, "title-run");
    const resumed = await store.prepareResume(WS, P1, run.id, { resumeKey: "r", requestHash: hashAutoResume(run.id, []), confirmedCallIds: [],
      maxActiveRuns: 5, providerReady: true }, new Date().toISOString());
    expect(resumed.kind).toBe("active");
  });

  it("an episode whose script would exceed the editor's limit is refused, never cut", async () => {
    const long = "很".repeat(299);
    const big = fixtureAutoEpisode(1);
    big.scenes = Array.from({ length: 10 }, (_, index) => ({ ...big.scenes[1]!, sceneNo: index + 1, action: long,
      dialogue: Array.from({ length: 8 }, () => ({ characterId: "C1", line: "很".repeat(80), delivery: "压着火" })),
      shots: Array.from({ length: 6 }, (_, shot) => ({ shotNo: shot + 1, framing: "近景", description: "很".repeat(120), seconds: 1 })),
      assetNeeds: ["很".repeat(60), "很".repeat(60), "很".repeat(60), "很".repeat(60)] }));
    const { run, engine, view } = await setup({ override: (stage) => stage === "episode:1"
      ? { status: 200, body: messagesAnswer(big) } : undefined });
    await engine.drive(run.id);
    const result = await view();
    expect(result.stages.find((stage) => stage.stageKey === "episode:1")).toMatchObject({ state: "rejected", errorCode: "too_large", output: null });
  });

  it("deterministic finding ids past K99 can still be answered by a revision", () => {
    expect(autoRevisionSchema(1).shape.changes.element.shape.issueId.safeParse("K120").success).toBe(true);
    expect(autoRevisionSchema(1).shape.changes.element.shape.issueId.safeParse("X1").success).toBe(false);
  });

  it("an issue whose quote is not in the text is kept but never blocks or drives a revision", async () => {
    const { run, engine, view, seen } = await setup({ plan: { review: { unverifiedIssue: true } } });
    await engine.drive(run.id);
    const result = await view();
    expect(result.quality).toBe("passed");
    expect(seen.some((item) => item.stage.startsWith("revise:"))).toBe(false);
    const review = result.stages.find((stage) => stage.stageKey === "review:1")!.output as { issues: Array<{ id: string; evidenceVerified: boolean }> };
    expect(review.issues).toEqual([expect.objectContaining({ id: "R2", evidenceVerified: false })]);
  });

  it("the package carries research limits, the choice, the bible, the episodes, checks, revisions and separate statuses", async () => {
    const { store, run, engine } = await setup({ plan: { review: { highIssueRounds: [1] } } });
    await engine.drive(run.id);
    const bundle = (await store.getRunById(WS, run.id))!;
    const meta = { runId: run.id, projectId: P1, input: bundle.run.input, quality: bundle.run.quality, state: bundle.run.state, callsUsed: bundle.run.callsUsed,
      callCap: bundle.run.callCap, revisionRoundsUsed: bundle.run.revisionRoundsUsed, storySave: bundle.run.storySave, generatedAt: new Date().toISOString() };
    const json = autoPackageJson(meta, bundle.stages) as { status: Record<string, string>; episodes: Array<{ version: string }>; revisions: unknown[]; production: { shots: unknown[] } };
    expect(json.status).toEqual({ scriptPackage: "ready", video: "not_started", humanReview: "not_confirmed", publication: "not_allowed_without_human_review" });
    expect(json.episodes.map((item) => item.version)).toEqual(["revise:1:episode:1"]);
    expect(json.revisions).toHaveLength(1);
    expect(json.production.shots.length).toBeGreaterThan(0);
    const markdown = autoPackageMarkdown(meta, bundle.stages);
    for (const heading of ["## 研究资料与限制", "## 受众与市场分析", "## 选题比较与最终方向", "## 故事、人物、地点与分集大纲", "## 逐集剧本", "## 检查与修改记录", "## 生产准备"]) {
      expect(markdown).toContain(heading);
    }
    expect(markdown).toContain("视频成片：未开始");
    expect(markdown).toContain("资料有限策划模式");
  });
});
