import { describe, expect, it } from "vitest";
import {
  AUTO_CREATION_RESEARCH_ANSWER_SCHEMA,
  AUTO_UNVERIFIED_DURATION_NOTE,
  autoCreationConstraintsSchema,
  type AutoCreationFrozenInput,
} from "@ai-drama/contracts";
import { OCEAN_ENGINE_ENTRY_URLS, collectSources } from "./auto-creation-sources";
import { buildAutoCreationPrompt, validateAutoStageOutput, type AutoCreationContext } from "./auto-creation";
import { autoReferenceCatalog, autoReferenceCatalogOf } from "./auto-creation-references";
import { builtInSources } from "./auto-creation-sources";

/** Prompt v9: the catalog the research of a context chooses from, cut from its saved snapshot as the engines cut it. */
const withCatalog = (context: AutoCreationContext): AutoCreationContext => ({ ...context, referenceCatalog: autoReferenceCatalogOf(context.sources) });
/** The catalog id of the craft entry's sentence on a structure's key result (the same id in every snapshot that has it). */
const CRAFT_ID = autoReferenceCatalog({ schema: "ads.auto-creation.sources.v1", sources: builtInSources(), researchMode: "limited", notes: [] })
  .entries.find((entry) => entry.quote === "关键结果来自主角的选择和行动，不靠旁人突然解围。")!.referenceId;

// Durations in uncited creative text (checks v7). The failed real run 1af794d3-5a55-4a8b-b64b-d1f18a5b06ff was refused at
// unsourced_number@hypotheses[0].statement:digits+market_statistic+viewing_duration; its answer was not kept, so the
// sentence is NOT known. Every text below is a SYNTHETIC sample, judged through the whole validateAutoStageOutput.

const NOW = "2026-10-21T00:00:00.000Z";

function input(overrides: Partial<AutoCreationFrozenInput> = {}): AutoCreationFrozenInput {
  return {
    schema: "ads.auto-creation.input.v1", promptVersion: "ads.auto-creation.prompt.v7", selectionRules: "ads.auto-creation.selection-rules.v1",
    checksVersion: "ads.auto-creation.checks.v7", idea: "", constraints: autoCreationConstraintsSchema.parse({}), materials: [], referenceUrls: [],
    researchFetch: false, episodeCount: 1, episodeSeconds: 60, revisionRounds: 0, callBudget: 6, maxOutputTokens: 4096, providerKey: "deepseek",
    model: "m", authorization: { mode: "auto", proof: "site_session", initiatedBy: "a", executor: "auto-creation-engine" }, ...overrides,
  };
}

function context(frozen = input()): AutoCreationContext {
  return withCatalog({ sources: collectSources(frozen, [], NOW), episodes: new Map(), reviews: [] });
}

/** A recent, readable market page (synthetic, no number in it): the snapshot is then sourced. */
function sourcedContext(frozen = input()): AutoCreationContext {
  return withCatalog({ sources: collectSources(frozen, [{ url: OCEAN_ENGINE_ENTRY_URLS[0], status: "read", title: "合成市场样本页", text: "合成样本：本页只描述题材趋势，没有统计数字。",
    publishedAt: "2026-09-01T00:00:00.000Z", fetchedAt: NOW, note: "合成样本" }], NOW), episodes: new Map(), reviews: [] });
}

const STRUCTURE = { referenceId: CRAFT_ID, application: { pattern: "主角主动选择推动结果", why: "写作方法资料要求关键结果来自主角的行动。" } };

/** A legal limited answer (research v4): only the five root fields. */
function limited(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: AUTO_CREATION_RESEARCH_ANSWER_SCHEMA,
    hypotheses: [{ id: "H1", statement: "碎片时间的观众可能更愿意看一集内有明确兑现的故事。", howToVerify: "上线后用真实观看数据对比。" }],
    audience: { primary: "在通勤和睡前刷短剧的成年观众（待验证假设）", viewingNeeds: ["一集内看到结果"], emotionalAppeals: ["扳回一局"] },
    contentStructure: [STRUCTURE],
    opportunities: ["小人物在一个夜晚完成一次反击"],
    ...overrides,
  });
}

/** The same creative parts to the sourced contract. */
function sourced(overrides: Record<string, unknown> = {}): string {
  const answer = JSON.parse(limited(overrides)) as Record<string, unknown> & { audience: Record<string, unknown> };
  return JSON.stringify({ ...answer, facts: [], observations: [], audience: { ...answer.audience, basis: "hypothesis", sourceIds: [] } });
}

const hypothesis = (statement: string, howToVerify = "上线后用真实观看数据对比。") => ({ hypotheses: [{ id: "H1", statement, howToVerify }] });
const research = (answer: string, frozen = input()) => validateAutoStageOutput("research", answer, frozen, context(frozen));

describe("the three creative samples Codex reproduced (refused as viewing_duration before checks v7)", () => {
  it.each([
    "待验证观众是否喜欢本剧60秒的紧凑叙事。",
    "观众可能愿意看完本剧60秒的故事。",
  ])("the work's own length is the frozen setting, no notice: %s", (statement) => {
    expect(research(limited(hypothesis(statement)))).toMatchObject({ ok: true, output: { unverified: [] } });
  });

  it("a pending question whose duration the code cannot place is kept with a duration notice", () => {
    expect(research(limited(hypothesis("待验证：观众能否在60秒内理解人物冲突。")))).toMatchObject({ ok: true,
      output: { hypotheses: [{ statement: "待验证：观众能否在60秒内理解人物冲突。" }],
        unverified: [{ origin: "server_check", field: "hypotheses[0].statement", token: "60", semantic: "unclassified", rule: "duration_unconfirmed",
          note: AUTO_UNVERIFIED_DURATION_NOTE }] } });
  });

  it("the opening moment allowed before stays allowed, with no notice", () => {
    expect(research(limited(hypothesis("观众是否会在前3秒被吸引。")))).toMatchObject({ ok: true, output: { unverified: [] } });
  });
});

describe("A. the work's own length is judged against the frozen setting", () => {
  it.each([
    "待验证观众能否接受本剧每集约 60 秒的节奏。",
    "观众是否喜欢本剧1分钟的篇幅，待验证。",
    "待验证观众是否愿意看完这部剧六十秒的故事。",
    "待验证观众能否在本集60秒内看懂人物关系。",
  ])("allowed: %s", (statement) => {
    expect(research(limited(hypothesis(statement)))).toMatchObject({ ok: true, output: { unverified: [] } });
  });

  it.each([
    ["待验证观众是否喜欢本剧90秒的版本。", "over_length"],
    ["待验证观众是否更喜欢本剧30秒的版本。", "length_changed"],
    ["观众是否喜欢本剧2分钟的篇幅，待验证。", "over_length"],
  ])("a length the frozen setting does not have is a constraint violation: %s", (statement, rule) => {
    expect(research(limited(hypothesis(statement)))).toMatchObject({ ok: false, code: "constraint_violation", field: "hypotheses[0].statement",
      semantic: "frozen_conflict", rule });
  });

  it("an equal value is no exemption by itself: the work's length stated as a finding about viewers is still refused", () => {
    expect(research(limited(hypothesis("观众喜欢本剧60秒的紧凑叙事。")))).toMatchObject({ ok: false, code: "unsourced_number", semantic: "result_claim",
      rule: "unmarked_audience_judgement" });
  });

  it.each([
    [{ episodeSeconds: 90 }, "待验证观众是否喜欢本剧90秒的紧凑叙事。", null],
    [{ episodeSeconds: 120 }, "待验证观众是否喜欢本剧2分钟的紧凑叙事。", null],
    [{ episodeSeconds: 90 }, "待验证观众是否喜欢本剧60秒的紧凑叙事。", "length_changed"],
    [{ episodeSeconds: 45 }, "待验证观众是否喜欢本剧60秒的紧凑叙事。", "over_length"],
    [{ episodeSeconds: 90 }, "待验证：观众能否在90秒内理解人物冲突。", "notice"],
  ] as const)("other frozen lengths %j: %s", (frozen, statement, expected) => {
    const result = research(limited(hypothesis(statement)), input(frozen));
    if (expected === null) expect(result).toMatchObject({ ok: true, output: { unverified: [] } });
    else if (expected === "notice") expect(result).toMatchObject({ ok: true, output: { unverified: [{ rule: "duration_unconfirmed" }] } });
    else expect(result).toMatchObject({ ok: false, code: "constraint_violation", semantic: "frozen_conflict", rule: expected });
  });
});

describe("B. an actual viewing time, an average or a measured result still needs a source", () => {
  it.each([
    ["观众通常观看60秒后退出。", "market_statistic", "viewing_duration"],
    ["观众平均每天观看60秒。", "market_statistic", "rate_or_average"],
    ["数据显示观众观看60秒后流失。", "result_claim", "measured_result"],
    ["观众观看60秒后退出。", "market_statistic", "viewing_duration"],
    ["观众可能观看60秒后就划走。", "market_statistic", "viewing_duration"],
    ["假设观众通常观看60秒后退出。", "market_statistic", "viewing_duration"],
    ["计划验证：观众平均观看60秒。", "market_statistic", "rate_or_average"],
    ["待验证：观众一般看60秒就划走。", "market_statistic", "viewing_duration"],
    ["观众通常看完本剧60秒的故事。", "market_statistic", "viewing_duration"],
    ["观众观看本剧60秒后退出。", "market_statistic", "viewing_duration"],
    ["实测观众看完本剧60秒的故事。", "result_claim", "measured_result"],
    ["观众在60秒内理解人物冲突。", "market_statistic", "viewing_duration"],
    ["待验证：观众能否在90秒内理解人物冲突。", "market_statistic", "viewing_duration"],
    ["大部分人只看60秒就划走。", "market_statistic", "viewing_duration"],
  ] as const)("refused, the number the frozen 60 秒 too: %s", (statement, semantic, rule) => {
    expect(research(limited(hypothesis(statement)))).toMatchObject({ ok: false, code: "unsourced_number", field: "hypotheses[0].statement", semantic, rule });
  });

  it.each([
    ["the same clause", "待验证观众能否在60秒内理解冲突，七成观众会追更。", "hypotheses[0].statement", "proportion"],
    ["the same sentence", "待验证：观众能否在60秒内理解人物冲突，实测观看60秒后流失。", "hypotheses[0].statement", "measured_result"],
  ])("a notice never ends the reading: a statistic later in %s refuses the whole answer", (_where, statement, field, rule) => {
    expect(research(limited(hypothesis(statement)))).toMatchObject({ ok: false, field, rule });
  });

  it("a statistic in a later field after a notice refuses the whole answer", () => {
    expect(research(limited({ ...hypothesis("待验证：观众能否在60秒内理解人物冲突。"), opportunities: ["观众平均观看60秒后流失"] })))
      .toMatchObject({ ok: false, code: "unsourced_number", field: "opportunities[0]", rule: "rate_or_average" });
    expect(research(limited({ ...hypothesis("待验证：观众能否在60秒内理解人物冲突。", "上线后观察七成观众的反应。") })))
      .toMatchObject({ ok: false, field: "hypotheses[0].howToVerify", rule: "proportion" });
  });
});

describe("C. the same duration checks in every uncited creative field", () => {
  const unplaced = "待验证：观众能否在60秒内理解人物冲突。";
  const explicit = "观众通常观看60秒后退出。";
  it.each([
    ["hypotheses[0].howToVerify", (text: string) => hypothesis("主角主动反击可能更有代入感。", text)],
    ["opportunities[0]", (text: string) => ({ opportunities: [text] })],
    ["contentStructure[0].application.why", (text: string) => ({ contentStructure: [{ ...STRUCTURE, application: { pattern: "主角主动选择推动结果", why: text } }] })],
    ["contentStructure[0].application.pattern", (text: string) => ({ contentStructure: [{ referenceId: null, application: { pattern: text, why: "本剧自主设计。" } }] })],
  ] as const)("%s: work length allowed, an unplaced duration a notice, an explicit viewing time refused", (field, at) => {
    expect(research(limited(at("待验证观众是否喜欢本剧60秒的紧凑叙事。")))).toMatchObject({ ok: true, output: { unverified: [] } });
    expect(research(limited(at(unplaced)))).toMatchObject({ ok: true, output: { unverified: [{ field, rule: "duration_unconfirmed" }] } });
    expect(research(limited(at(explicit)))).toMatchObject({ ok: false, field, rule: "viewing_duration" });
  });

  it("a structure with a chosen passage and one with a null reference keep the same notice", () => {
    for (const [referenceId, reference] of [[CRAFT_ID, { sourceId: "S-KB-CRAFT", quote: "关键结果来自主角的选择和行动，不靠旁人突然解围。" }], [null, null]] as const) {
      expect(research(limited({ contentStructure: [{ referenceId, application: { pattern: "主角主动选择推动结果", why: unplaced } }] })))
        .toMatchObject({ ok: true, output: { contentStructure: [{ reference }], unverified: [{ field: "contentStructure[0].application.why", rule: "duration_unconfirmed" }] } });
    }
  });

  it("an uncited audience is about viewers throughout: the work's length may be written there, an unplaced duration has no notice exit", () => {
    const audience = (need: string) => ({ audience: { primary: "在通勤和睡前刷短剧的成年观众（待验证假设）", viewingNeeds: [need], emotionalAppeals: ["扳回一局"] } });
    expect(research(limited(audience("待验证观众是否喜欢本剧60秒的紧凑叙事")))).toMatchObject({ ok: true });
    expect(research(limited(audience(unplaced)))).toMatchObject({ ok: false, code: "unsourced_number", field: "audience.viewingNeeds[0]",
      semantic: "unclassified", rule: "duration_unconfirmed" });
    expect(research(limited(audience(explicit)))).toMatchObject({ ok: false, field: "audience.viewingNeeds[0]", rule: "viewing_duration" });
  });

  it("the sourced contract judges its creative fields the same way", () => {
    const frozen = input();
    expect(validateAutoStageOutput("research", sourced(hypothesis("待验证观众是否喜欢本剧60秒的紧凑叙事。")), frozen, sourcedContext(frozen)))
      .toMatchObject({ ok: true, output: { unverified: [] } });
    expect(validateAutoStageOutput("research", sourced(hypothesis(unplaced)), frozen, sourcedContext(frozen)))
      .toMatchObject({ ok: true, output: { unverified: [{ rule: "duration_unconfirmed" }] } });
    expect(validateAutoStageOutput("research", sourced(hypothesis(explicit)), frozen, sourcedContext(frozen)))
      .toMatchObject({ ok: false, rule: "viewing_duration" });
  });

  it("the research prompt says how to write the work's length and that a viewing time is never written", () => {
    for (const ctx of [context(), sourcedContext()]) {
      const { user } = buildAutoCreationPrompt("research", input(), ctx);
      expect(user).toContain("提示版本：ads.auto-creation.prompt.v10");
      expect(user).toContain("待验证观众是否喜欢本剧 60 秒的故事");
      expect(user).toContain("不写观众实际看了多久、看多久后退出");
    }
  });
});

describe("PR #84 review: a work reference never exempts a viewing time, and the work's unit never exempts another number", () => {
  const legal: readonly (readonly [string, "none" | "notice"])[] = [
    ["待验证观众是否喜欢本剧60秒的紧凑叙事。", "none"],
    ["观众可能愿意看完本剧60秒的故事。", "none"],
    ["待验证：观众能否在60秒内理解人物冲突。", "notice"],
    ["观众是否会在前3秒被吸引。", "none"],
    ["待验证观众能否接受本剧每集约60秒的节奏。", "none"],
    // A viewing verb alone is no refusal: here the duration describes the story it is followed by.
    ["待验证观众是否愿意观看本剧60秒的故事。", "none"],
  ];
  const refused: readonly (readonly [string, string])[] = [
    // A viewing verb before 本剧 / 本集 makes the duration how long they watch, equal to the frozen 60 秒 or not.
    ["假设观众观看本剧60秒。", "viewing_duration"],
    ["待验证：观众看了本集60秒。", "viewing_duration"],
    // 每集60秒 is the work's length; the count of viewings beside it is still a rate.
    ["假设观众会把每集60秒的故事观看3次。", "rate_or_average"],
    ["假设观众会把每集60秒的故事重复观看3次。", "rate_or_average"],
    ["假设观众每集观看3次。", "rate_or_average"],
  ];
  const fields = [
    ["hypotheses[0].statement", (text: string) => hypothesis(text)],
    ["contentStructure[0].application.why", (text: string) => ({ contentStructure: [{ ...STRUCTURE, application: { pattern: "主角主动选择推动结果", why: text } }] })],
    ["contentStructure[0].application.pattern", (text: string) => ({ contentStructure: [{ referenceId: null, application: { pattern: text, why: "本剧自主设计。" } }] })],
  ] as const;

  it.each(fields)("%s: refused as before checks v7, never a notice", (field, at) => {
    for (const [text, rule] of refused) {
      expect(research(limited(at(text))), text).toMatchObject({ ok: false, code: "unsourced_number", field, semantic: "market_statistic", rule });
    }
  });

  it.each(fields)("%s: the legal samples keep passing", (field, at) => {
    for (const [text, expected] of legal) {
      const result = research(limited(at(text)));
      if (expected === "none") expect(result, text).toMatchObject({ ok: true, output: { unverified: [] } });
      else expect(result, text).toMatchObject({ ok: true, output: { unverified: [{ field, rule: "duration_unconfirmed" }] } });
    }
  });

  it("the sourced contract refuses them the same way", () => {
    const frozen = input();
    for (const [text, rule] of refused) {
      expect(validateAutoStageOutput("research", sourced(hypothesis(text)), frozen, sourcedContext(frozen)), text).toMatchObject({ ok: false, rule });
    }
  });
});

describe("PR #84 incremental review: 每集 as the work's unit is read by what the other number counts", () => {
  const story = "待验证观众是否喜欢本剧每集60秒内发生两次反转的故事。";
  const fields = [
    ["hypotheses[0].statement", (text: string) => hypothesis(text)],
    ["contentStructure[0].application.why", (text: string) => ({ contentStructure: [{ ...STRUCTURE, application: { pattern: "主角主动选择推动结果", why: text } }] })],
    ["contentStructure[0].application.pattern", (text: string) => ({ contentStructure: [{ referenceId: null, application: { pattern: text, why: "本剧自主设计。" } }] })],
  ] as const;

  it.each(fields)("%s: a count of story events inside the episode's length is creative design, no notice", (_field, at) => {
    expect(research(limited(at(story)))).toMatchObject({ ok: true, output: { unverified: [] } });
  });

  it.each(fields)("%s: a count of viewings beside the work's length is still a rate", (field, at) => {
    for (const text of ["假设观众会把每集60秒的故事观看3次。", "假设观众会把每集60秒的故事重复观看3次。", "假设观众每集观看3次。"]) {
      expect(research(limited(at(text))), text).toMatchObject({ ok: false, code: "unsourced_number", field, semantic: "market_statistic", rule: "rate_or_average" });
    }
  });

  it("the sourced contract reads them the same way", () => {
    const frozen = input();
    expect(validateAutoStageOutput("research", sourced(hypothesis(story)), frozen, sourcedContext(frozen))).toMatchObject({ ok: true, output: { unverified: [] } });
    expect(validateAutoStageOutput("research", sourced(hypothesis("假设观众会把每集60秒的故事观看3次。")), frozen, sourcedContext(frozen)))
      .toMatchObject({ ok: false, rule: "rate_or_average" });
  });
});
