import { describe, expect, it } from "vitest";
import {
  AUTO_CREATION_CHECKS_VERSION,
  AUTO_CREATION_PROMPT_VERSION,
  AUTO_CREATION_RESEARCH_ANSWER_SCHEMA,
  SERIES_RESEARCH_CONTRACT,
  SERIES_WRITING_CHECKS_VERSION,
  SERIES_WRITING_INPUT_SCHEMA,
  SERIES_WRITING_PROMPT_VERSION,
  autoCreationConstraintsSchema,
  type AutoCreationFrozenInput,
  type SeriesFrozenInput,
} from "@ai-drama/contracts";
import { OCEAN_ENGINE_ENTRY_URLS, collectSources } from "./auto-creation-sources";
import { uncitedNumberReading, type AutoNumberFrame } from "./auto-creation-numbers";
import { buildAutoCreationPrompt, validateAutoStageOutput, type AutoCreationContext } from "./auto-creation";
import { buildSeriesPrompt, seriesAutoInput, validateSeriesStageOutput, type SeriesContext } from "./series-writing";
import { autoReferenceCatalogOf } from "./auto-creation-references";

// checks v14 / prompt v11. Every text below is a SYNTHETIC sample (合成样本), written for these checks; none is the
// refused answer of a real run, which was never kept. The texts carry no "合成样本" prefix: 样本 is itself a market word
// and would turn a story sentence into a sentence about the market.
//
// 1. A viewing time refused only because its judgement is unmarked (viewing_duration + not_pending) no longer hides a
//    statistic later in the same text: that statistic is reported. The verdict (refused) never changes.
// 2. In a duration's judgement, 是否 taken by a choice its viewers make (观众会在前10秒决定是否继续看) is no doubt about the
//    judgement: that sentence asserts what viewers do and is refused. A real question or a plan reads as before.

const NOW = "2026-10-28T00:00:00.000Z";
const EPISODES = 60;
const FRAME: AutoNumberFrame = {
  exempt: [[EPISODES, "集"], [60, "秒"], [1, "分钟"]], frozenAudience: "", episodeCount: EPISODES, episodeSeconds: 60, maxCharacters: null, maxLocations: null,
};
const CREATIVE = { unverified: true, structureDesign: true } as const;
const notPending = (token: string) => ({ token, kind: "digits", semantic: "market_statistic", rule: "viewing_duration", reason: "not_pending" });

/** [synthetic text, what is now reported]: an unmarked viewing time first, a statistic after it in the same text. */
const MASKED: ReadonlyArray<readonly [string, { token: string; kind: string; semantic: string; rule: string }]> = [
  ["开场10秒内交代主角目标，七成观众会因此留下。", { token: "七成", kind: "percent", semantic: "market_statistic", rule: "proportion" }],
  ["前10秒呈现矛盾，排名第一的短剧都这样开场。", { token: "名次第一", kind: "rank", semantic: "market_statistic", rule: "ranking" }],
  ["开场10秒内交代目标，观众平均观看45秒。", { token: "45", kind: "digits", semantic: "market_statistic", rule: "rate_or_average" }],
  ["前10秒呈现矛盾，观众平均每天观看3次。", { token: "3", kind: "digits", semantic: "market_statistic", rule: "rate_or_average" }],
  ["观众能在30秒内理解冲突。七成观众会因此留下。", { token: "七成", kind: "percent", semantic: "market_statistic", rule: "proportion" }],
  // A frozen conflict between them does not end the reading: the statistic after it is still reported.
  ["观众能在30秒内理解冲突。本剧共三集。七成观众会因此留下。", { token: "七成", kind: "percent", semantic: "market_statistic", rule: "proportion" }],
  ["观众能在30秒内理解冲突。本剧共三集。观众平均观看45秒。", { token: "45", kind: "digits", semantic: "market_statistic", rule: "rate_or_average" }],
];

/** [synthetic text, the token]: refused as an unmarked viewing time, before and after (nothing stronger follows). */
const STILL_NOT_PENDING: ReadonlyArray<readonly [string, string]> = [
  ["观众能在30秒内理解冲突。", "30"],
  ["观众在前3秒就决定去留。", "3"],
  ["观众在10秒内没有被吸引就会离开。", "10"],
  // The work's design and an unmarked viewer effect in one sentence: a known over-refusal the contract keeps (§3.2).
  ["在前10秒呈现矛盾，设计意图是帮助观众理解主角目标。", "10"],
  // An unmarked audience judgement or a notice after it does not replace it, and the refusal is not lost.
  ["观众能在30秒内理解冲突，两次反转让观众意外。", "30"],
  ["观众能在30秒内理解冲突。待验证观众能否在20秒内看懂反转。", "30"],
  // Only a statistic or a measured result after it is reported instead: a frozen conflict after it is not.
  ["观众能在30秒内理解冲突。本剧共三集。", "30"],
];

/** Synthetic sentences that assert a choice viewers make within a time: refused from checks v14 on. */
const CHOICES: ReadonlyArray<readonly [string, string]> = [
  ["观众会在前10秒决定是否继续看。", "10"],
  ["观众在前3秒就会决定是否划走。", "3"],
  ["观众会在30秒内决定是否付费。", "30"],
  ["观众会在前10秒判断是否继续看。", "10"],
  // The source the work goes by is another clause: the viewers make the choice in their own.
  ["根据观众留言，观众会在前10秒决定是否继续看。", "10"],
];

/** Synthetic questions and plans that stay pending: [text, notices expected]. */
const PENDING_KEPT: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["待验证观众是否会在前10秒被吸引。", []],
  ["待验证观众是否会在前10秒决定继续看。", []],
  ["在前10秒呈现矛盾，待验证观众能否理解主角目标。", []],
  ["前3秒让主角陷入危机，待验证观众是否因此想继续看。", []],
  ["前3秒让主角陷入危机，可能更容易抓住观众。", []],
  ["计划比较两种开场的试看反馈，观察观众在前10秒是否被吸引。", []],
  ["计划观察观众是否会在前10秒决定是否继续看。", []],
  ["计划测试开场10秒的版本，收集观众反馈。", []],
  // The work's own decision on viewers' feedback, not a choice the viewers make.
  ["根据观众反馈决定是否保留前10秒的悬念。", []],
  ["根据观众留言决定是否保留前10秒的悬念。", []],
  ["参考观众弹幕决定是否在前10秒加入反转。", []],
  ["观众留言决定是否在前10秒加入反转。", []],
  ["观众前30秒弹幕决定是否保留这段开场。", []],
  ["观众评分决定是否在前10秒加入反转。", []],
  ["按观众弹幕决定是否在前10秒加入反转。", []],
  ["由观众留言决定是否在前10秒加入反转。", []],
  // Another person makes the choice: the viewers only watch it.
  ["让观众看到主角在前10秒决定是否救人。", []],
  ["前10秒他们决定是否救人，观众是否会紧张待验证。", []],
  ["本剧开场10秒内交代主角目标。", []],
  ["待验证观众能否在30秒内理解冲突。", ["duration_unconfirmed"]],
  ["观众可能在30秒内理解冲突。", ["duration_unconfirmed"]],
];

/** Synthetic: a legal question or plan with a statistic, a habit or a result after it is still refused. */
const LEGAL_THEN_STATISTIC: ReadonlyArray<readonly [string, string, string]> = [
  ["待验证观众是否会在前10秒被吸引，七成观众会因此留下。", "market_statistic", "proportion"],
  ["前3秒让主角陷入危机，待验证观众是否因此想继续看，排名第一的短剧都这样开场。", "market_statistic", "ranking"],
  ["观众通常会在前10秒决定是否继续看。", "market_statistic", "viewing_duration"],
  ["观众在前3秒就决定是否划走，测试显示观众更容易留下。", "result_claim", "measured_result"],
];

describe("A. the reading of one text", () => {
  it.each(MASKED)("a statistic after an unmarked viewing time is reported: %s", (text, finding) => {
    expect(uncitedNumberReading(text, FRAME, CREATIVE).refusal).toEqual(finding);
    expect(uncitedNumberReading(text, FRAME).refusal).toEqual(finding);
  });

  it("a later viewing time refused for its own reason (a habit) is a statistic too, and is reported", () => {
    const habit = { token: "90", kind: "digits", semantic: "market_statistic", rule: "viewing_duration", reason: "viewing_habit" };
    expect(uncitedNumberReading("观众能在30秒内理解冲突。观众通常在90秒后离开。", FRAME, CREATIVE).refusal).toEqual(habit);
  });

  it.each(STILL_NOT_PENDING)("an unmarked viewing time with nothing stronger after it keeps not_pending: %s", (text, token) => {
    expect(uncitedNumberReading(text, FRAME, CREATIVE).refusal).toEqual(notPending(token));
    expect(uncitedNumberReading(text, FRAME).refusal).toEqual(notPending(token));
  });

  it.each(CHOICES)("a choice viewers make within a time is no pending question: %s", (text, token) => {
    expect(uncitedNumberReading(text, FRAME, CREATIVE)).toEqual({ refusal: notPending(token), unverified: [] });
    expect(uncitedNumberReading(text, FRAME, { ...CREATIVE, verificationPlan: true }).refusal).toEqual(notPending(token));
  });

  it.each(PENDING_KEPT)("a real question or plan reads as before: %s", (text, notices) => {
    const reading = uncitedNumberReading(text, FRAME, CREATIVE);
    expect(reading.refusal).toBeNull();
    expect(reading.unverified.map((item) => item.rule)).toEqual(notices);
    expect(uncitedNumberReading(text, FRAME, { ...CREATIVE, verificationPlan: true }).refusal).toBeNull();
  });

  it.each(LEGAL_THEN_STATISTIC)("a legal question with a statistic, habit or result is still refused: %s", (text, semantic, rule) => {
    expect(uncitedNumberReading(text, FRAME, CREATIVE).refusal).toMatchObject({ semantic, rule });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The whole research stage: limited, sourced and a series of 60 x 60 s; five creative fields; null and a catalog id.

function input(materials: AutoCreationFrozenInput["materials"] = []): AutoCreationFrozenInput {
  return {
    schema: "ads.auto-creation.input.v1", promptVersion: AUTO_CREATION_PROMPT_VERSION, selectionRules: "ads.auto-creation.selection-rules.v1",
    checksVersion: AUTO_CREATION_CHECKS_VERSION, idea: "", constraints: autoCreationConstraintsSchema.parse({}), materials, referenceUrls: [],
    researchFetch: false, episodeCount: EPISODES, episodeSeconds: 60, revisionRounds: 0, callBudget: 6, maxOutputTokens: 4096, providerKey: "deepseek",
    model: "m", authorization: { mode: "auto", proof: "site_session", initiatedBy: "a", executor: "auto-creation-engine" },
  };
}
const withCatalog = (context: AutoCreationContext): AutoCreationContext => ({ ...context, referenceCatalog: autoReferenceCatalogOf(context.sources) });
const limitedContext = (run = input()): AutoCreationContext => withCatalog({ sources: collectSources(run, [], NOW), episodes: new Map(), reviews: [] });
const sourcedContext = (run = input()): AutoCreationContext => withCatalog({
  sources: collectSources(run, [{ url: OCEAN_ENGINE_ENTRY_URLS[0], status: "read", title: "合成市场样本页", text: "合成样本：本页只描述题材趋势，没有统计数字。",
    publishedAt: "2026-09-01T00:00:00.000Z", fetchedAt: NOW, note: "合成样本" }], NOW),
  episodes: new Map(), reviews: [],
});
const seriesInput: SeriesFrozenInput = {
  schema: SERIES_WRITING_INPUT_SCHEMA, promptVersion: SERIES_WRITING_PROMPT_VERSION, checksVersion: SERIES_WRITING_CHECKS_VERSION, researchContract: SERIES_RESEARCH_CONTRACT,
  idea: "", constraints: { genre: "", audience: "", maxCharacters: null, maxLocations: null, forbiddenThemes: [], endingRequirement: "" },
  materials: [], referenceUrls: [], researchFetch: false, episodeCount: EPISODES, episodeSeconds: 60, batchSize: 3, outlineChunk: 6,
};
const seriesAuto = seriesAutoInput(seriesInput, { providerKey: "deepseek", model: "m", maxOutputTokens: 4096 });

/** One synthetic method note, so the catalog has an id to choose (the frozen runs above have no material). */
const NOTES = [{ title: "合成方法笔记", kind: "notes" as const, text: "主角每一场都要主动出手。反派从不解释动机。", rightsConfirmed: true as const }];

type Checked = { ok: boolean; output?: Record<string, unknown> } & Record<string, unknown>;
type Path = readonly [name: string, mode: "limited" | "sourced", check: (content: string) => Checked, referenceId: string | null];
const PATHS: Path[] = [
  ["limited", "limited", (content) => validateAutoStageOutput("research", content, input(), limitedContext()) as Checked, null],
  ["sourced", "sourced", (content) => validateAutoStageOutput("research", content, input(), sourcedContext()) as Checked, null],
  ["series (60 x 60 s)", "limited", (content) => {
    const context: SeriesContext = { input: seriesInput, auto: limitedContext(seriesAuto), outlines: new Map() };
    return validateSeriesStageOutput("research", content, seriesInput, context, seriesAuto) as unknown as Checked;
  }, null],
  ...(["limited", "sourced"] as const).map((mode): Path => {
    const run = input(NOTES);
    const context = mode === "limited" ? limitedContext(run) : sourcedContext(run);
    return [`${mode} with a catalog id`, mode, (content) => validateAutoStageOutput("research", content, run, context) as Checked,
      context.referenceCatalog!.entries[0]!.referenceId];
  }),
];

type Slot = "pattern" | "why" | "statement" | "howToVerify" | "opportunity";
const FIELDS: ReadonlyArray<readonly [Slot, string]> = [
  ["pattern", "contentStructure[0].application.pattern"], ["why", "contentStructure[0].application.why"],
  ["statement", "hypotheses[0].statement"], ["howToVerify", "hypotheses[0].howToVerify"], ["opportunity", "opportunities[0]"],
];

function answer(mode: "limited" | "sourced", slot: Slot, text: string, referenceId: string | null): string {
  const texts = { pattern: "主角主动选择推动结果", why: "这是本作品的创作设计。", statement: "开场就让主角做出冒险选择，可能更容易让观众代入。",
    howToVerify: "计划比较两种开场的试看反馈。", opportunity: "小人物在一个夜晚完成一次反击", [slot]: text };
  const creative = {
    hypotheses: [{ id: "H1", statement: texts.statement, howToVerify: texts.howToVerify }],
    contentStructure: [{ referenceId, application: { pattern: texts.pattern, why: texts.why } }],
    opportunities: [texts.opportunity],
  };
  const audience = { primary: "在通勤和睡前刷短剧的成年观众（待验证假设）", viewingNeeds: ["一集内看到结果"], emotionalAppeals: ["扳回一局"] };
  return JSON.stringify(mode === "limited"
    ? { schema: AUTO_CREATION_RESEARCH_ANSWER_SCHEMA, ...creative, audience }
    : { schema: AUTO_CREATION_RESEARCH_ANSWER_SCHEMA, facts: [], observations: [], ...creative, audience: { ...audience, basis: "hypothesis", sourceIds: [] } });
}

describe("B. the whole research stage", () => {
  it("every path reads a run of 60 episodes of 60 seconds, and the catalog paths choose a real id", () => {
    expect([seriesAuto.episodeCount, seriesAuto.episodeSeconds]).toEqual([60, 60]);
    for (const [, , , referenceId] of PATHS.slice(3)) expect(referenceId).toMatch(/^R-[A-Za-z0-9]{10}$/u);
  });

  describe.each(PATHS)("%s", (_path, mode, check, referenceId) => {
    it.each(FIELDS)("%s: the statistic after an unmarked viewing time is the error, and nothing is kept", (slot, field) => {
      for (const [text, finding] of MASKED) {
        const result = check(answer(mode, slot, text, referenceId));
        expect(result).toMatchObject({ ok: false, code: "unsourced_number", field, category: finding.kind, semantic: finding.semantic, rule: finding.rule });
        expect(result).not.toHaveProperty("reason");
        expect(result).not.toHaveProperty("output");
      }
      for (const [text] of STILL_NOT_PENDING) {
        expect(check(answer(mode, slot, text, referenceId))).toMatchObject({ ok: false, code: "unsourced_number", field, category: "digits",
          semantic: "market_statistic", rule: "viewing_duration", reason: "not_pending" });
      }
    });

    it.each(FIELDS)("%s: a choice viewers make within a time is refused; a real question or plan passes as written", (slot, field) => {
      for (const [text] of CHOICES) {
        const result = check(answer(mode, slot, text, referenceId));
        expect(result).toMatchObject({ ok: false, code: "unsourced_number", field, category: "digits", semantic: "market_statistic",
          rule: "viewing_duration", reason: "not_pending" });
        expect(result).not.toHaveProperty("output");
      }
      for (const [text, notices] of PENDING_KEPT) {
        const result = check(answer(mode, slot, text, referenceId));
        expect(result).toMatchObject({ ok: true });
        expect(JSON.stringify(result.output)).toContain(text);
        const kept = (result.output as { unverified: Array<{ field: string; rule: string }> }).unverified;
        expect(kept.map((notice) => [notice.field, notice.rule])).toEqual(notices.map((rule) => [field, rule]));
      }
      for (const [text, semantic, rule] of LEGAL_THEN_STATISTIC) {
        expect(check(answer(mode, slot, text, referenceId))).toMatchObject({ ok: false, field, semantic, rule });
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Prompt v11: one shared line on a structure's application, the same in limited, sourced and a series' research.

describe("C. the shared prompt", () => {
  const prompts = (): Array<[string, string]> => [
    ["limited", buildAutoCreationPrompt("research", input(), limitedContext()).user],
    ["sourced", buildAutoCreationPrompt("research", input(), sourcedContext()).user],
    ["series", buildSeriesPrompt("research", seriesInput, { input: seriesInput, auto: limitedContext(seriesAuto), outlines: new Map() }, seriesAuto).user],
  ];

  it("names the versions it is sent with", () => {
    expect(AUTO_CREATION_PROMPT_VERSION).toBe("ads.auto-creation.prompt.v11");
    expect(AUTO_CREATION_CHECKS_VERSION).toBe("ads.auto-creation.checks.v14");
    for (const [, user] of prompts()) expect(user).toContain("提示版本：ads.auto-creation.prompt.v11");
  });

  it("tells a structure's timing apart from its effect on viewers, in every research prompt alike", () => {
    const lines = prompts().map(([, user]) => user.split("\n").filter((line) => line.startsWith("- application：")));
    for (const found of lines) {
      expect(found).toHaveLength(1);
      expect(found[0]).toContain("叙事时间安排");
      expect(found[0]).toContain("观众效果");
      expect(found[0]).toContain("不能写成已知事实");
      expect(found[0]).toContain("待验证");
      expect(found[0]).toContain("不能让无来源的统计、观看习惯或已经得到的结果变得可以写");
    }
    expect(new Set(lines.map((found) => found[0])).size).toBe(1);
  });

  it("its own example passes the checks it describes", () => {
    const example = /如“([^”]*待验证观众[^”]*)”/u.exec(prompts()[0]![1].split("\n").find((line) => line.startsWith("- application："))!)?.[1];
    expect(example).toBeDefined();
    expect(uncitedNumberReading(example!, FRAME, CREATIVE)).toEqual({ refusal: null, unverified: [] });
  });
});
