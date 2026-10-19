import { describe, expect, it } from "vitest";
import {
  AUTO_CREATION_EPISODE_SCHEMA,
  AUTO_CREATION_PROMPT_MAX_CHARS,
  AUTO_CREATION_REVIEW_SCHEMA,
  AUTO_REVIEW_DIMENSIONS,
  autoCreationConstraintsSchema,
  autoCreationHardCap,
  autoCreationInitialStageKeys,
  autoCreationNormalCalls,
  type AutoCreationConstraints,
  type AutoCreationFrozenInput,
  type AutoEpisode,
  type AutoReviewOutput,
  type TitleWritingProviderKey,
} from "@ai-drama/contracts";
import {
  AUTO_REVIEW_FINDINGS_MAX_CHARS,
  findingsSummary,
  autoReviewQuotas,
  autoReviewRoom,
  buildAutoCreationPrompt,
  collectSources,
  deterministicFindings,
  validateAutoStageOutput,
  type AutoCreationContext,
} from "@ai-drama/domain";
import { titleWritingProviderConfigs, type WritingProviderConfig } from "./text-writing";
import { AutoCreationEngine, InMemoryAutoCreationStore, autoRunView, newAutoRun } from "./auto-creation-engine";
import {
  autoFixtureTransport,
  fixtureAutoBible,
  fixtureAutoCrowdedBible,
  fixtureAutoCrowdedEpisode,
  fixtureAutoEpisode,
  fixtureAutoOutline,
  type AutoFixtureExchange,
  type AutoFixturePlan,
} from "./auto-creation-fixtures";

const WS = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const START = Date.parse("2026-10-18T00:00:00Z");
const MAX = AUTO_CREATION_PROMPT_MAX_CHARS;

function providers(): Record<TitleWritingProviderKey, WritingProviderConfig> {
  return titleWritingProviderConfigs({ ANTHROPIC_API_KEY: "sk-ant-api03-test-secret-0123456789", TITLE_WRITING_ANTHROPIC_MODELS: "m-1" });
}

async function setup(options: { episodeCount: number; plan?: AutoFixturePlan; constraints?: Partial<AutoCreationConstraints> }) {
  const store = new InMemoryAutoCreationStore();
  store.addProject(WS, P1, options.episodeCount);
  const clock = () => new Date(START);
  const run = newAutoRun({
    workspaceId: WS, projectId: P1, actorId: "server-owner", idempotencyKey: "key-1", idea: "",
    constraints: autoCreationConstraintsSchema.parse(options.constraints ?? {}), materials: [], referenceUrls: [], researchFetch: false,
    episodeCount: options.episodeCount, episodeSeconds: 60, revisionRounds: 2, callBudget: autoCreationHardCap(options.episodeCount, 2),
    providerKey: "anthropic", model: "m-1",
    authorization: { mode: "auto", proof: "site_session", initiatedBy: "server-owner", executor: "auto-creation-engine" }, now: clock(),
  });
  expect((await store.createRun(run, autoCreationInitialStageKeys(options.episodeCount), {
    maxActiveRuns: 1, sinceIso: new Date(START - 86_400_000).toISOString(), maxCallsPerDay: 100, requiredCalls: autoCreationNormalCalls(options.episodeCount),
  })).kind).toBe("created");
  const seen: AutoFixtureExchange[] = [];
  const engine = new AutoCreationEngine({ workspaceId: WS, store, providers: providers(), maxCallsPerDay: 100, clock,
    transport: autoFixtureTransport({ plan: options.plan, seen }), leaseMs: 240_000 });
  return { store, run, engine, seen, view: async () => autoRunView((await store.getRunById(WS, run.id))!) };
}

const promptChars = (item: { system: string; user: string }) => item.system.length + item.user.length;

function input(overrides: Partial<AutoCreationFrozenInput> = {}): AutoCreationFrozenInput {
  return {
    schema: "ads.auto-creation.input.v1", promptVersion: "ads.auto-creation.prompt.v1", selectionRules: "ads.auto-creation.selection-rules.v1",
    checksVersion: "ads.auto-creation.checks.v1", idea: "", constraints: autoCreationConstraintsSchema.parse({}), materials: [], referenceUrls: [],
    researchFetch: false, episodeCount: 6, episodeSeconds: 60, revisionRounds: 2, callBudget: 21, maxOutputTokens: 4096, providerKey: "anthropic",
    model: "m-1", authorization: { mode: "auto", proof: "site_session", initiatedBy: "a", executor: "auto-creation-engine" }, ...overrides,
  };
}

/** Every user-controlled text of the frozen input at its longest: the fixed part of each prompt at its largest. */
function longestInput(): AutoCreationFrozenInput {
  return input({
    idea: "想".repeat(300), episodeSeconds: 90,
    constraints: autoCreationConstraintsSchema.parse({ genre: "题".repeat(20), audience: "众".repeat(40), maxCharacters: 8, maxLocations: 6,
      forbiddenThemes: ["甲", "乙", "丙", "丁", "戊"].map((head) => head.repeat(20)), endingRequirement: "结".repeat(100) }),
  });
}

type Scene = AutoEpisode["scenes"][number];
const EVERYONE = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"];
const fullLine = () => ({ characterId: "C1", line: "说".repeat(80), delivery: "气".repeat(20) });
const fullShot = (shotNo: number) => ({ shotNo, framing: "景".repeat(20), description: "画".repeat(120), seconds: 15 });

/**
 * A valid episode of exactly `length` JSON characters, built up: full scenes while they fit (every person of the crowded
 * setting listed, so the checks find the most), then one growing scene, then the title and hand-off facts take the rest.
 */
function episodeOfLength(episodeNo: number, length: number): AutoEpisode {
  const episode: AutoEpisode = { schema: AUTO_CREATION_EPISODE_SCHEMA, episodeNo, title: "题", scenes: [], handoffFacts: ["交"] };
  const left = () => length - JSON.stringify(episode).length;
  const tryAdd = (add: () => void, undo: () => void) => {
    add();
    if (left() >= 0) return true;
    undo();
    return false;
  };
  const grow = (get: () => string, set: (value: string) => void, cap: number, char: string) => {
    set(get() + char.repeat(Math.max(0, Math.min(left(), cap - get().length))));
  };
  for (let sceneNo = 1; sceneNo <= 10; sceneNo += 1) {
    const full: Scene = { sceneNo, locationId: "L1", timeOfDay: "夜", characterIds: EVERYONE, action: "动".repeat(300),
      dialogue: Array.from({ length: 8 }, fullLine), sound: "声".repeat(80), shots: Array.from({ length: 6 }, (_, index) => fullShot(index + 1)),
      assetNeeds: Array.from({ length: 4 }, () => "物".repeat(60)) };
    if (tryAdd(() => episode.scenes.push(full), () => episode.scenes.pop())) continue;
    const scene: Scene = { sceneNo, locationId: "L1", timeOfDay: "夜", characterIds: EVERYONE, action: "动", dialogue: [], sound: "",
      shots: [{ shotNo: 1, framing: "景", description: "画", seconds: 15 }], assetNeeds: [] };
    if (!tryAdd(() => episode.scenes.push(scene), () => episode.scenes.pop())) break;
    grow(() => scene.action, (value) => { scene.action = value; }, 300, "动");
    while (scene.dialogue.length < 8 && tryAdd(() => scene.dialogue.push(fullLine()), () => scene.dialogue.pop())) { /* next line */ }
    while (scene.shots.length < 6 && tryAdd(() => scene.shots.push(fullShot(scene.shots.length + 1)), () => scene.shots.pop())) { /* next shot */ }
    grow(() => scene.sound, (value) => { scene.sound = value; }, 80, "声");
    break;
  }
  grow(() => episode.title, (value) => { episode.title = value; }, 30, "题");
  for (let index = 0; index < 6 && left() > 0; index += 1) {
    if (index > 0) {
      // A new fact costs four characters (,"交"); borrow from the previous one when fewer are left.
      const short = 4 - left();
      if (short > 0) episode.handoffFacts[index - 1] = episode.handoffFacts[index - 1]!.slice(0, -short);
      episode.handoffFacts.push("交");
    }
    grow(() => episode.handoffFacts[index]!, (value) => { episode.handoffFacts[index] = value; }, 150, "交");
  }
  if (left() !== 0) throw new Error(`could not build an episode of ${String(length)} characters`);
  return episode;
}

function contextWith(episodes: AutoEpisode[], bible = fixtureAutoCrowdedBible()): AutoCreationContext {
  const outline = fixtureAutoOutline(6);
  return {
    sources: collectSources(input(), [], new Date(START).toISOString()),
    bible,
    outline: { ...outline, episodes: outline.episodes.map((episode) => ({ ...episode, characterIds: ["C1"] })) },
    episodes: new Map(episodes.map((episode) => [episode.episodeNo, { stageKey: `episode:${String(episode.episodeNo)}`, episode }])),
    reviews: [],
  };
}

/** A completed review with every issue at its longest, all on one episode (the most a revision prompt carries). */
function longestReview(context: AutoCreationContext, frozen: AutoCreationFrozenInput, target: string): AutoReviewOutput {
  return {
    schema: AUTO_CREATION_REVIEW_SCHEMA, checksVersion: "ads.auto-creation.checks.v1", verdict: "revise",
    dimensions: AUTO_REVIEW_DIMENSIONS.map((key) => ({ key, assessment: "评".repeat(150), internalScore: 2 })),
    issues: Array.from({ length: 10 }, (_, index) => ({ id: `R${String(index + 1)}`, dimension: "dialogue" as const, severity: "high" as const, target,
      evidence: "说".repeat(120), problem: "问".repeat(150), suggestion: "建".repeat(150), evidenceVerified: true })),
    deterministic: deterministicFindings(frozen, context), reviewed: {}, passed: false,
  };
}

describe("review input of a six-episode run with many repeated check results", () => {
  it("short valid episodes with hundreds of check results still reach their one review; no extra call, no stop", async () => {
    const { run, engine, seen, view } = await setup({ episodeCount: 6, plan: { crowdedCast: true } });
    await engine.drive(run.id);
    const result = await view();
    const firstReview = result.stages.find((stage) => stage.stageKey === "review:1")!;
    // The reproduction: six valid episodes of about 1,600 characters each and over two hundred check results.
    const episodes = result.stages.filter((stage) => stage.kind === "episode").map((stage) => JSON.stringify(stage.output).length);
    expect(episodes).toHaveLength(6);
    expect(Math.max(...episodes)).toBeLessThan(2_000);
    expect(firstReview.state).toBe("completed");
    const findings = (firstReview.output as AutoReviewOutput).deterministic;
    expect(findings.length).toBeGreaterThanOrEqual(200);
    expect(findings.filter((item) => item.check === "mentioned_on_screen")).toHaveLength(210);
    expect(findings).toHaveLength(235);
    // Every result stays in the stored review (page, package and the code's verdict); only the prompt summarises them.
    expect((firstReview.output as AutoReviewOutput).passed).toBe(false);
    expect(result.errorCode).not.toBe("prompt_too_large");
    expect(seen.every((item) => promptChars(item) <= MAX)).toBe(true);
    // The normal plan, then two budgeted rounds (three episodes and a review each): nothing beyond the worst case.
    expect(seen.map((item) => item.stage)).toEqual([
      "research", "directions", "bible", "outline", "episode:1", "episode:2", "episode:3", "episode:4", "episode:5", "episode:6", "review:1",
      "revise:1:episode:1", "revise:1:episode:2", "revise:1:episode:3", "review:2",
      "revise:2:episode:1", "revise:2:episode:2", "revise:2:episode:3", "review:3",
    ]);
    expect(result).toMatchObject({ state: "completed", quality: "needs_work", errorCode: "revision_rounds_exhausted", storySave: "saved" });
    expect(result.callsUsed).toBe(19);
  });

  it("the review prompt names every kind of result with its count and where it was found", async () => {
    const { run, engine, seen } = await setup({ episodeCount: 6, plan: { crowdedCast: true } });
    await engine.drive(run.id);
    const review = seen.find((item) => item.stage === "review:1")!;
    expect(promptChars(review)).toBeLessThan(30_000);
    for (const episodeNo of [1, 2, 3, 4, 5, 6]) expect(review.user).toContain(`episode:${String(episodeNo)}`);
    expect(review.user).toContain("mentioned_on_screen");
    expect(review.user).toContain("\"count\":35");
    // A revision still receives every id it may answer.
    const revise = seen.find((item) => item.stage === "revise:1:episode:1")!;
    for (let id = 1; id <= 35; id += 1) expect(revise.user).toContain(`"K${String(id)}"`);
  });
});

describe("cumulative review input budget", () => {
  it("long but valid episodes up to the shared budget are accepted, one character more is refused, and every later prompt fits", () => {
    const frozen = longestInput();
    expect(autoReviewQuotas(frozen).episode).toBeGreaterThan(2_000);
    const firstFive = [1, 2, 3, 4, 5].map((episodeNo) => episodeOfLength(episodeNo, 3_000));
    let context = contextWith(firstFive);
    const room = autoReviewRoom("episode:6", frozen, context);
    // The last episode may use everything the earlier stages left, and not one character more.
    const refused = validateAutoStageOutput("episode:6", JSON.stringify(episodeOfLength(6, room + 1)), frozen, context);
    expect(refused).toMatchObject({ ok: false, code: "too_large", detail: "review_budget" });
    const last = episodeOfLength(6, room);
    const accepted = validateAutoStageOutput("episode:6", JSON.stringify(last), frozen, context);
    expect(accepted.ok).toBe(true);
    context = contextWith([...firstFive, last]);
    expect(deterministicFindings(frozen, context).length).toBeGreaterThan(100);
    // The review sees everything accepted, with the most check results and the longest frozen input.
    const review = buildAutoCreationPrompt("review:1", frozen, context);
    expect(promptChars(review)).toBeLessThanOrEqual(MAX);
    for (const episodeNo of [1, 2, 3, 4, 5, 6]) expect(review.user).toContain(`<<<待审：episode:${String(episodeNo)}`);
    // A revision of the largest episode with ten longest issues, and the next review with the previous round's issues.
    const reviewed = { ...context, reviews: [{ stageKey: "review:1", review: longestReview(context, frozen, "episode:6") }] };
    expect(promptChars(buildAutoCreationPrompt("revise:1:episode:6", frozen, reviewed))).toBeLessThanOrEqual(MAX);
    expect(promptChars(buildAutoCreationPrompt("review:2", frozen, reviewed))).toBeLessThanOrEqual(MAX);
  });

  it("each stage is told its room; an earlier stage cannot take the room the later episodes are guaranteed", () => {
    const frozen = longestInput();
    const empty: AutoCreationContext = { sources: collectSources(frozen, [], new Date(START).toISOString()), episodes: new Map(), reviews: [] };
    const quotas = autoReviewQuotas(frozen);
    // The setting's quota, plus what rounding the episodes' equal shares left over.
    expect(autoReviewRoom("bible", frozen, empty) - quotas.bible).toBeGreaterThanOrEqual(0);
    expect(autoReviewRoom("bible", frozen, empty) - quotas.bible).toBeLessThan(6);
    expect(quotas.bible).toBeGreaterThan(JSON.stringify(fixtureAutoCrowdedBible()).length);
    const context = contextWith([]);
    // Episode 1 takes all the room the setting and outline left: every later episode still has its own share.
    const greedy = episodeOfLength(1, autoReviewRoom("episode:1", frozen, context));
    expect(validateAutoStageOutput("episode:1", JSON.stringify(greedy), frozen, context).ok).toBe(true);
    const after = contextWith([greedy]);
    for (const episodeNo of [2, 3, 4, 5, 6]) expect(autoReviewRoom(`episode:${String(episodeNo)}`, frozen, after)).toBe(quotas.episode);
    // The prompt says how long this episode may be.
    const prompt = buildAutoCreationPrompt("episode:2", frozen, after);
    expect(prompt.user).toMatch(/整个 json 不超过约 \d+ 字符/u);
  });

  it("the check summary stays within its share however many results there are; the stored review keeps them all", () => {
    const frozen = longestInput();
    // Six of the longest episodes (beyond the budget, only to produce the most results): ten scenes, eight people each.
    const context = contextWith([1, 2, 3, 4, 5, 6].map((episodeNo) => episodeOfLength(episodeNo, 28_000)));
    const findings = deterministicFindings(frozen, context);
    expect(findings.length).toBeGreaterThan(500);
    expect(JSON.stringify(findingsSummary(findings)).length).toBeLessThanOrEqual(AUTO_REVIEW_FINDINGS_MAX_CHARS);
    // A short list is shown as it is.
    expect(findingsSummary(findings.slice(0, 3))).toEqual(findings.slice(0, 3));
  });

  it("a revision is measured in place of the version it replaces", () => {
    const frozen = longestInput();
    const firstSix = [1, 2, 3, 4, 5].map((episodeNo) => episodeOfLength(episodeNo, 3_000));
    const room6 = autoReviewRoom("episode:6", frozen, contextWith(firstSix));
    const six = [...firstSix, episodeOfLength(6, room6)];
    const context = contextWith(six);
    const reviewed: AutoCreationContext = { ...context, reviews: [{ stageKey: "review:1", review: longestReview(context, frozen, "episode:2") }] };
    const reviseRoom = autoReviewRoom("revise:1:episode:2", frozen, reviewed);
    expect(reviseRoom).toBe(3_000);
    const changes = [{ issueId: "R1", change: "按问题修改。" }];
    const longer = validateAutoStageOutput("revise:1:episode:2", JSON.stringify({ ...episodeOfLength(2, 3_001), changes }), frozen, reviewed);
    expect(longer).toMatchObject({ ok: false, code: "too_large", detail: "review_budget" });
    expect(validateAutoStageOutput("revise:1:episode:2", JSON.stringify({ ...episodeOfLength(2, 2_500), changes }), frozen, reviewed).ok).toBe(true);
  });
});

describe("review evidence is a quote of one field", () => {
  const frozen = input({ episodeCount: 1 });
  const context: AutoCreationContext = {
    sources: collectSources(frozen, [], new Date(START).toISOString()), bible: fixtureAutoBible(), outline: fixtureAutoOutline(1),
    episodes: new Map([[1, { stageKey: "episode:1", episode: fixtureAutoEpisode(1) }]]), reviews: [],
  };
  const review = (issue: { target: string; evidence: string; severity?: "high" | "medium" }) => JSON.stringify({
    schema: AUTO_CREATION_REVIEW_SCHEMA, verdict: "revise",
    dimensions: AUTO_REVIEW_DIMENSIONS.map((key) => ({ key, assessment: "说明。", internalScore: 3 })),
    issues: [{ id: "R1", dimension: "dialogue", severity: issue.severity ?? "high", target: issue.target, evidence: issue.evidence, problem: "问题。", suggestion: "建议。" }],
  });
  const verdict = (target: string, evidence: string) => {
    const checked = validateAutoStageOutput("review:1", review({ target, evidence }), frozen, context);
    if (!checked.ok) throw new Error(checked.code);
    return checked.output as AutoReviewOutput;
  };

  it("a line joined to its delivery is not a quote: unverified, no revision, no block", () => {
    // 「签哪儿？」is a dialogue line and「平静」its delivery: two fields.
    const output = verdict("episode:1", "签哪儿？平静");
    expect(output.issues[0]!.evidenceVerified).toBe(false);
    expect(output.passed).toBe(true);
  });

  it("the end of the desire joined to the start of the weakness is not a quote of the setting", () => {
    // desire「拿回自己挣的钱，交上房租」, weakness「不敢和上级争」.
    const output = verdict("bible", "交上房租不敢和上级争");
    expect(output.issues[0]!.evidenceVerified).toBe(false);
    expect(output.passed).toBe(true);
  });

  it("a quote inside one field is still verified and still decides", () => {
    expect(verdict("episode:1", "签哪儿？").issues[0]!.evidenceVerified).toBe(true);
    expect(verdict("episode:1", "签哪儿？").passed).toBe(false);
    expect(verdict("bible", "交上房租").issues[0]!.evidenceVerified).toBe(true);
    // Whitespace inside one field is still ignored.
    expect(verdict("episode:1", "请顾客在手写单上 签名").issues[0]!.evidenceVerified).toBe(true);
  });

  it("an episode issue with a joined quote never buys a revision; a real one does", async () => {
    const joined = await setup({ episodeCount: 1, plan: { review: { joinedEvidenceRounds: [1] } } });
    await joined.engine.drive(joined.run.id);
    expect(joined.seen.map((item) => item.stage)).toEqual(["research", "directions", "bible", "outline", "episode:1", "review:1"]);
    expect(await joined.view()).toMatchObject({ state: "completed", quality: "passed", errorCode: null });
    const bible = await setup({ episodeCount: 1, plan: { review: { joinedBibleEvidenceRounds: [1] } } });
    await bible.engine.drive(bible.run.id);
    // Not an unrevisable setting problem: the quote is not in the setting.
    expect(await bible.view()).toMatchObject({ state: "completed", quality: "passed", errorCode: null });
    const real = await setup({ episodeCount: 1, plan: { review: { highIssueRounds: [1] } } });
    await real.engine.drive(real.run.id);
    expect(real.seen.map((item) => item.stage)).toContain("revise:1:episode:1");
    const realBible = await setup({ episodeCount: 1, plan: { review: { bibleIssueRounds: [1] } } });
    await realBible.engine.drive(realBible.run.id);
    expect(await realBible.view()).toMatchObject({ quality: "needs_work", errorCode: "unrevisable_issues" });
  });
});

// Keeps the crowded fixture honest: its episodes are valid output.
describe("crowded fixture", () => {
  it("is a valid setting and valid episodes", () => {
    const context = contextWith([]);
    expect(validateAutoStageOutput("episode:1", JSON.stringify(fixtureAutoCrowdedEpisode(1)), input(), context).ok).toBe(true);
  });
});
