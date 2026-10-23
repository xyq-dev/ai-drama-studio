import { describe, expect, it } from "vitest";
import {
  SERIES_ARC_SCHEMA,
  SERIES_EPISODE_SCHEMA,
  SERIES_LEDGER_SCHEMA,
  SERIES_OUTLINE_SCHEMA,
  SERIES_PLAN_SCHEMA,
  SERIES_SETTING_SCHEMA,
  SERIES_RESEARCH_CONTRACT,
  SERIES_WRITING_CHECKS_VERSION,
  SERIES_WRITING_INPUT_SCHEMA,
  SERIES_WRITING_PROMPT_VERSION,
  type SeriesArc,
  type SeriesEpisode,
  type SeriesFrozenInput,
  type SeriesOutlineEpisode,
  type SeriesPlanContent,
  type SeriesSetting,
} from "@ai-drama/contracts";
import {
  applySeriesContinuity,
  checkSeriesLedgerContent,
  checkSeriesPlanContent,
  seriesBatchFindings,
  seriesContextFromPlan,
  seriesInitialLedger,
  seriesOutlineLine,
  validateSeriesStageOutput,
  seriesAutoInput,
} from "./index";

/** Synthetic world for the checks (not a model's answer). */
const N = 9;
const input: SeriesFrozenInput = {
  schema: SERIES_WRITING_INPUT_SCHEMA, promptVersion: SERIES_WRITING_PROMPT_VERSION, checksVersion: SERIES_WRITING_CHECKS_VERSION, researchContract: SERIES_RESEARCH_CONTRACT,
  idea: "", constraints: { genre: "", audience: "", maxCharacters: 3, maxLocations: null, forbiddenThemes: ["僵尸"], endingRequirement: "" },
  materials: [], referenceUrls: [], researchFetch: false, episodeCount: N, episodeSeconds: 60, batchSize: 3, outlineChunk: 6,
};
const autoInput = seriesAutoInput(input, { providerKey: "deepseek", model: "m", maxOutputTokens: 4096 });

const setting: SeriesSetting = {
  schema: SERIES_SETTING_SCHEMA, title: "样例", logline: "样例", synopsis: "样例",
  core: { protagonistId: "C1", desire: "欲望", weakness: "弱点", goal: "目标", coreConflict: "冲突", keyChoices: [{ choice: "选择", consequence: "后果" }],
    failureCost: "代价", ending: "结局", majorTurns: [{ episodeNo: 9, turn: "转折" }] },
  characters: [
    { id: "C1", name: "甲", identity: "店员", goal: "目标", weakness: "弱点", arc: "弧线", voice: "直", initialWhereabouts: "店里" },
    { id: "C2", name: "乙", identity: "店主", goal: "目标", weakness: "弱点", arc: "弧线", voice: "慢", initialWhereabouts: "门口" },
    { id: "C3", name: "丙", identity: "妹妹", goal: "目标", weakness: "弱点", arc: "弧线", voice: "快", initialWhereabouts: "家" },
  ],
  relationships: [{ from: "C1", to: "C2", relation: "雇佣", arc: "变化" }],
  secrets: [{ id: "S1", holderId: "C2", content: "转卖", knownBy: [], revealEpisode: 5 }],
  locations: [{ id: "L1", name: "店", intExt: "INT", description: "店面" }],
  props: [{ id: "P1", name: "钥匙", initialHolderId: "C2", purpose: "开门" }],
};
const arc: SeriesArc = {
  schema: SERIES_ARC_SCHEMA,
  phases: [{ phaseNo: 1, title: "一", episodeFrom: 1, episodeTo: 4, goal: "目标", turningPoint: "转折" }, { phaseNo: 2, title: "二", episodeFrom: 5, episodeTo: 9, goal: "目标", turningPoint: "转折" }],
  foreshadowing: [{ id: "FS1", content: "划痕", plantEpisode: 2, payoffEpisode: 5, dependsOn: [] }],
  finale: { episodeNo: 9, resolution: "收束" },
};
function outline(k: number): SeriesOutlineEpisode {
  return { episodeNo: k, title: `第${String(k)}集`, goal: "目标", obstacle: "阻碍", choice: "选择", turn: "转折", result: "结果", endState: "结束", nextHook: "承接",
    characterIds: ["C1", "C2"], locationIds: ["L1"], plants: k === 2 ? ["FS1"] : [], payoffs: k === 5 ? ["FS1"] : [], isFinale: k === N };
}
const plan: SeriesPlanContent = { schema: SERIES_PLAN_SCHEMA, episodeCount: N, setting, arc, outlines: Array.from({ length: N }, (_, index) => outline(index + 1)) };

function episode(k: number, patch: Partial<SeriesEpisode> = {}): SeriesEpisode {
  return {
    schema: SERIES_EPISODE_SCHEMA, episodeNo: k, title: "题", plannedSeconds: 60, summary: "概要",
    scenes: [{ sceneNo: 1, locationId: "L1", timeOfDay: "夜", characterIds: ["C1", "C2"], action: "动作", dialogue: [{ characterId: "C1", line: "台词", delivery: "" }],
      sound: "", keyVisual: "画面", seconds: 60 }],
    handoffFacts: ["事实"],
    continuity: { characters: [], relationships: [], props: [], conflicts: [], secrets: [], foreshadowing: [
      ...(k === 2 ? [{ id: "FS1", action: "plant" as const }] : []), ...(k === 5 ? [{ id: "FS1", action: "payoff" as const }] : [])] },
    ending: k === N ? "finale" : "continue",
    ...patch,
  };
}

describe("structural checks of the plan", () => {
  const ctx = () => seriesContextFromPlan(input, plan, "0".repeat(64));

  it("a finale anywhere but the last episode is refused (arc, outline and episode)", () => {
    expect(validateSeriesStageOutput("arc", JSON.stringify({ ...arc, finale: { episodeNo: 3, resolution: "x" } }), input, ctx(), autoInput)).toMatchObject({ ok: false, code: "finale_misplaced" });
    const chunk = { schema: SERIES_OUTLINE_SCHEMA, chunkNo: 1, episodes: [1, 2, 3, 4, 5, 6].map((k) => ({ ...outline(k), isFinale: k === 3 })) };
    expect(validateSeriesStageOutput("outline:1", JSON.stringify(chunk), input, ctx(), autoInput)).toMatchObject({ ok: false, code: "finale_misplaced" });
    expect(validateSeriesStageOutput("episode:3", JSON.stringify(episode(3, { ending: "finale" })), input, ctx(), autoInput)).toMatchObject({ ok: false, code: "finale_misplaced" });
    expect(validateSeriesStageOutput("episode:9", JSON.stringify(episode(9, { ending: "continue" })), input, ctx(), autoInput)).toMatchObject({ ok: false, code: "finale_misplaced" });
  });

  it("phases must cover 1..N without gaps; foreshadowing pays after it is planted and dependencies pay first", () => {
    const gap = { ...arc, phases: [{ ...arc.phases[0]!, episodeTo: 3 }, arc.phases[1]!] };
    expect(validateSeriesStageOutput("arc", JSON.stringify(gap), input, ctx(), autoInput)).toMatchObject({ ok: false, code: "plan_structure" });
    const backwards = { ...arc, foreshadowing: [{ ...arc.foreshadowing[0]!, plantEpisode: 5, payoffEpisode: 5 }] };
    expect(validateSeriesStageOutput("arc", JSON.stringify(backwards), input, ctx(), autoInput)).toMatchObject({ ok: false, code: "plan_structure" });
    const dependency = { ...arc, foreshadowing: [...arc.foreshadowing, { id: "FS2", content: "合同", plantEpisode: 1, payoffEpisode: 3, dependsOn: ["FS1"] }] };
    expect(validateSeriesStageOutput("arc", JSON.stringify(dependency), input, ctx(), autoInput)).toMatchObject({ ok: false, code: "plan_structure" });
  });

  it("outline numbers are continuous, references valid and the foreshadowing schedule followed", () => {
    const skipped = { schema: SERIES_OUTLINE_SCHEMA, chunkNo: 1, episodes: [1, 2, 3, 4, 5, 7].map(outline) };
    expect(validateSeriesStageOutput("outline:1", JSON.stringify(skipped), input, ctx(), autoInput)).toMatchObject({ ok: false, code: "episode_numbering" });
    const ghost = { schema: SERIES_OUTLINE_SCHEMA, chunkNo: 1, episodes: [1, 2, 3, 4, 5, 6].map((k) => ({ ...outline(k), characterIds: k === 4 ? ["C9"] : ["C1"] })) };
    expect(validateSeriesStageOutput("outline:1", JSON.stringify(ghost), input, ctx(), autoInput)).toMatchObject({ ok: false, code: "dangling_reference" });
    const unplanned = { schema: SERIES_OUTLINE_SCHEMA, chunkNo: 1, episodes: [1, 2, 3, 4, 5, 6].map((k) => ({ ...outline(k), plants: [] })) };
    expect(validateSeriesStageOutput("outline:1", JSON.stringify(unplanned), input, ctx(), autoInput)).toMatchObject({ ok: false, code: "plan_structure" });
    const good = { schema: SERIES_OUTLINE_SCHEMA, chunkNo: 2, episodes: [7, 8, 9].map(outline) };
    expect(validateSeriesStageOutput("outline:2", JSON.stringify(good), input, ctx(), autoInput).ok).toBe(true);
  });

  it("a setting over the person's cast limit, or naming a forbidden theme, is refused", () => {
    const crowded = { ...setting, characters: [...setting.characters, { ...setting.characters[0]!, id: "C4" }] };
    expect(validateSeriesStageOutput("setting", JSON.stringify(crowded), input, ctx(), autoInput)).toMatchObject({ ok: false, code: "constraint_violation" });
    expect(validateSeriesStageOutput("setting", JSON.stringify({ ...setting, logline: "僵尸来了" }), input, ctx(), autoInput)).toMatchObject({ ok: false, code: "constraint_violation" });
  });

  it("an over-budget answer is refused whole, never cut", () => {
    const long = { ...episode(1), scenes: Array.from({ length: 5 }, (_, index) => ({ ...episode(1).scenes[0]!, sceneNo: index + 1, action: "长".repeat(200),
      dialogue: Array.from({ length: 8 }, () => ({ characterId: "C1", line: "长".repeat(60), delivery: "" })) })) };
    expect(validateSeriesStageOutput("episode:1", JSON.stringify(long), input, { ...ctx(), baseLedger: seriesInitialLedger(plan) }, autoInput)).toMatchObject({ ok: false, code: "too_large" });
  });

  it("a person's plan revision passes the same checks", () => {
    expect(checkSeriesPlanContent(input, plan).ok).toBe(true);
    expect(checkSeriesPlanContent(input, { ...plan, outlines: plan.outlines.map((item) => ({ ...item, isFinale: item.episodeNo === 6 })) })).toMatchObject({ ok: false, code: "finale_misplaced" });
    expect(seriesOutlineLine(outline(9))).toContain("（全剧结局）");
  });
});

describe("the continuity ledger and its contradictions", () => {
  const base = () => ({ ...seriesContextFromPlan(input, plan, "0".repeat(64)), baseLedger: seriesInitialLedger(plan), baseLedgerHash: null });

  it("merges each episode's changes into the current state in order", () => {
    let ledger = seriesInitialLedger(plan);
    expect(ledger).toMatchObject({ schema: SERIES_LEDGER_SCHEMA, throughEpisode: 0 });
    ledger = applySeriesContinuity(ledger, 1, { ...episode(1).continuity, props: [{ id: "P1", holderId: "C1", state: "易手" }], conflicts: [{ id: "K1", content: "争执", status: "open" }] });
    ledger = applySeriesContinuity(ledger, 2, episode(2).continuity);
    ledger = applySeriesContinuity(ledger, 5, { ...episode(5).continuity, conflicts: [{ id: "K1", content: "争执", status: "resolved" }], secrets: [{ id: "S1", revealedTo: ["C1"] }] });
    expect(ledger.props[0]).toMatchObject({ holderId: "C1" });
    expect(ledger.conflicts[0]).toMatchObject({ status: "resolved", openedIn: 1, resolvedIn: 5 });
    expect(ledger.foreshadowing[0]).toMatchObject({ status: "paid", plantedIn: 2, paidIn: 5 });
    expect(ledger.secrets[0]!.knownBy).toEqual(["C1"]);
  });

  it("flags a hand-over whose holder is absent, a secret told with no one who knew it present, a payoff before its plant", () => {
    const context = base();
    context.episodes.set(1, { stageKey: "episode:1", hash: "1".repeat(64), episode: episode(1, { continuity: { ...episode(1).continuity, props: [{ id: "P1", holderId: "C3", state: "x" }],
      secrets: [{ id: "S1", revealedTo: ["C1"] }] }, scenes: [{ ...episode(1).scenes[0]!, characterIds: ["C1"], dialogue: [] }] }) });
    context.episodes.set(2, { stageKey: "episode:2", hash: "2".repeat(64), episode: episode(2, { continuity: { ...episode(2).continuity, foreshadowing: [{ id: "FS1", action: "payoff" }] } }) });
    context.episodes.set(3, { stageKey: "episode:3", hash: "3".repeat(64), episode: episode(3) });
    const findings = seriesBatchFindings(input, context, 1, 3);
    const checks = findings.filter((item) => item.severity === "high").map((item) => `${item.check}@${item.target}`);
    expect(checks).toEqual(expect.arrayContaining(["prop_handoff@episode:1", "knowledge_boundary@episode:1", "foreshadowing_order@episode:2", "foreshadowing_missing@episode:2"]));
    expect(findings.map((item) => item.id)).toEqual(findings.map((_, index) => `K${String(index + 1)}`));
  });

  it("a person's ledger may only name the plan's people, props, secrets and foreshadowing, and ends with its batch", () => {
    const ledger = applySeriesContinuity(seriesInitialLedger(plan), 3, episode(3).continuity);
    expect(checkSeriesLedgerContent(plan, ledger, 3).ok).toBe(true);
    expect(checkSeriesLedgerContent(plan, ledger, 6)).toMatchObject({ ok: false, code: "episode_numbering" });
    expect(checkSeriesLedgerContent(plan, { ...ledger, props: [{ id: "P9", holderId: null, state: "x" }] }, 3)).toMatchObject({ ok: false, code: "dangling_reference" });
  });
});

describe("round 3: relationships, dependencies and a person's ledger", () => {
  const ctx = () => seriesContextFromPlan(input, plan, "0".repeat(64));

  it("9. one directed pair is one relationship: C1→C2 twice is refused in a model setting and a person's plan; C2→C1 is a different pair", () => {
    const twice = { ...setting, relationships: [...setting.relationships, { from: "C1", to: "C2", relation: "仇敌", arc: "反目" }] };
    expect(validateSeriesStageOutput("setting", JSON.stringify(twice), input, ctx(), autoInput)).toMatchObject({ ok: false, code: "duplicate_id", field: "relationships" });
    expect(checkSeriesPlanContent(input, { ...plan, setting: twice })).toMatchObject({ ok: false, code: "duplicate_id", field: "relationships" });
    const reversed = { ...setting, relationships: [...setting.relationships, { from: "C2", to: "C1", relation: "店主与店员", arc: "变化" }] };
    expect(validateSeriesStageOutput("setting", JSON.stringify(reversed), input, ctx(), autoInput).ok).toBe(true);
  });

  it("9. an episode's continuity may not change one directed pair twice", () => {
    const twice = episode(1, { continuity: { ...episode(1).continuity, relationships: [{ from: "C1", to: "C2", state: "合作" }, { from: "C1", to: "C2", state: "决裂" }] } });
    expect(validateSeriesStageOutput("episode:1", JSON.stringify(twice), input, { ...ctx(), baseLedger: seriesInitialLedger(plan) }, autoInput))
      .toMatchObject({ ok: false, code: "duplicate_id", field: "continuity.relationships" });
  });

  it("10. a dependency must be paid strictly earlier: the same episode, one way or both ways, is refused; an earlier one is accepted", () => {
    const same = { ...arc, foreshadowing: [...arc.foreshadowing, { id: "FS2", content: "合同", plantEpisode: 1, payoffEpisode: 5, dependsOn: ["FS1"] }] };
    expect(validateSeriesStageOutput("arc", JSON.stringify(same), input, ctx(), autoInput)).toMatchObject({ ok: false, code: "plan_structure", detail: "dependency_not_paid_earlier" });
    const mutual = { ...arc, foreshadowing: [{ ...arc.foreshadowing[0]!, dependsOn: ["FS2"] }, { id: "FS2", content: "合同", plantEpisode: 1, payoffEpisode: 5, dependsOn: ["FS1"] }] };
    expect(validateSeriesStageOutput("arc", JSON.stringify(mutual), input, ctx(), autoInput)).toMatchObject({ ok: false, code: "plan_structure" });
    const earlier = { ...arc, foreshadowing: [...arc.foreshadowing, { id: "FS2", content: "合同", plantEpisode: 3, payoffEpisode: 6, dependsOn: ["FS1"] }] };
    expect(validateSeriesStageOutput("arc", JSON.stringify(earlier), input, ctx(), autoInput).ok).toBe(true);
  });

  it("7. a person's ledger names every planned person, prop, secret and foreshadowing exactly once; states may change", () => {
    const ledger = applySeriesContinuity(seriesInitialLedger(plan), 3, episode(3).continuity);
    for (const [field, edit] of [
      ["characters", { characters: [] }], ["props", { props: [] }], ["secrets", { secrets: [] }], ["foreshadowing", { foreshadowing: [] }],
      ["characters", { characters: ledger.characters.slice(1) }], ["props", { props: [...ledger.props, ledger.props[0]!] }],
      ["secrets", { secrets: [...ledger.secrets, ledger.secrets[0]!] }], ["foreshadowing", { foreshadowing: [...ledger.foreshadowing, ledger.foreshadowing[0]!] }],
      ["relationships", { relationships: [...ledger.relationships, { ...ledger.relationships[0]!, state: "仇敌" }] }],
    ] as const) {
      expect(checkSeriesLedgerContent(plan, { ...ledger, ...edit }, 3)).toMatchObject({ ok: false, field });
    }
    const moved = { ...ledger, props: [{ id: "P1", holderId: "C1", state: "易手" }], characters: ledger.characters.map((item) => ({ ...item, whereabouts: "公交站" })),
      relationships: [{ from: "C1", to: "C2", state: "信任" }, { from: "C2", to: "C1", state: "愧疚" }], conflicts: [{ id: "K9", content: "新冲突", status: "open" as const, openedIn: 3, resolvedIn: null }] };
    expect(checkSeriesLedgerContent(plan, moved, 3).ok).toBe(true);
  });
});

describe("round 4: a forbidden theme is matched in creative text only, never in schema ids, references or enums", () => {
  const forbidding = (...terms: string[]): SeriesFrozenInput => ({ ...input, constraints: { ...input.constraints, forbiddenThemes: terms } });
  const ctx = () => seriesContextFromPlan(input, plan, "0".repeat(64));
  const withLedger = () => ({ ...ctx(), baseLedger: seriesInitialLedger(plan) });

  it.each<[string, string, unknown, () => ReturnType<typeof ctx>]>([
    ["series (the schema literal of a setting)", "setting", setting, ctx],
    ["C1 (a person's id and the protagonist reference)", "setting", setting, ctx],
    ["INT (a location's interior/exterior enum)", "setting", setting, ctx],
    ["continue (an episode's ending enum)", "episode:1", episode(1), withLedger],
    ["plant (a continuity foreshadowing action)", "episode:2", episode(2), withLedger],
    ["L1 (a scene's location reference)", "outline:2", { schema: SERIES_OUTLINE_SCHEMA, chunkNo: 2, episodes: [7, 8, 9].map(outline) }, ctx],
  ])("forbidding %s does not refuse a valid output", (label, stageKey, value, context) => {
    const term = label.split(" ")[0]!;
    expect(validateSeriesStageOutput(stageKey, JSON.stringify(value), forbidding(term), context(), autoInput).ok).toBe(true);
  });

  it("the same words in creative text are still refused, field by field (core.ending is text, an episode's ending is not)", () => {
    const refusedFor = (term: string, stageKey: string, value: unknown, context = ctx()) =>
      validateSeriesStageOutput(stageKey, JSON.stringify(value), forbidding(term), context, autoInput);
    expect(refusedFor("continue", "setting", { ...setting, core: { ...setting.core, ending: "故事 continue 下去" } })).toMatchObject({ ok: false, code: "constraint_violation" });
    expect(refusedFor("INT", "setting", { ...setting, locations: [{ ...setting.locations[0]!, description: "INT 风格的店面" }] })).toMatchObject({ ok: false, code: "constraint_violation" });
    expect(refusedFor("C1", "episode:1", episode(1, { scenes: [{ ...episode(1).scenes[0]!, dialogue: [{ characterId: "C1", line: "C1 是谁", delivery: "" }] }] }), withLedger()))
      .toMatchObject({ ok: false, code: "constraint_violation" });
    expect(refusedFor("plant", "episode:1", episode(1, { scenes: [{ ...episode(1).scenes[0]!, action: "她把 plant 放在柜台" }] }), withLedger()))
      .toMatchObject({ ok: false, code: "constraint_violation" });
    expect(refusedFor("series", "arc", { ...arc, finale: { ...arc.finale, resolution: "一部 series 的收束" } })).toMatchObject({ ok: false, code: "constraint_violation" });
  });

  it("a person's plan follows the same rule: schema and ids never match, its creative text does", () => {
    expect(checkSeriesPlanContent(forbidding("series", "C1", "INT", "FS1"), plan).ok).toBe(true);
    expect(checkSeriesPlanContent(forbidding("series"), { ...plan, setting: { ...setting, synopsis: "一部 series 样例" } }))
      .toMatchObject({ ok: false, code: "constraint_violation", detail: "forbidden_theme" });
    expect(checkSeriesPlanContent(forbidding("承接"), plan)).toMatchObject({ ok: false, code: "constraint_violation" });
  });
});
