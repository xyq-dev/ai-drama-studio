import { describe, expect, it } from "vitest";
import {
  AUTO_CREATION_CHECKS_VERSION,
  AUTO_CREATION_PROMPT_VERSION,
  AUTO_CREATION_RESEARCH_SCHEMA,
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
import { validateAutoStageOutput, type AutoCreationContext } from "./auto-creation";
import { seriesAutoInput, validateSeriesStageOutput, type SeriesContext } from "./series-writing";

// A verification plan's sample of the work (checks v8). A real series run (prompt v8, 60 episodes of 60 s) was refused at
// its first research call at hypotheses[0].howToVerify as constraint_violation, chinese_numeral, frozen_conflict +
// episode_count. The refused answer was not kept, so its sentence is NOT known and nothing here reproduces it: every
// text below is a SYNTHETIC sample. The three plans in SAMPLE_PLANS were each refused as a total-episode conflict on main
// 1feb0a6 with 60 episodes frozen.

const NOW = "2026-10-25T00:00:00.000Z";
const EPISODES = 60;

/** The frame the research stage builds for a run of 60 episodes of 60 s, no cast or location limit. */
const FRAME: AutoNumberFrame = {
  exempt: [[EPISODES, "集"], [60, "秒"], [1, "分钟"]], frozenAudience: "", episodeCount: EPISODES, episodeSeconds: 60, maxCharacters: null, maxLocations: null,
};
const plan = (text: string) => uncitedNumberReading(text, FRAME, { unverified: true, verificationPlan: true });

/** Plans that sample this work for a reading, in Chinese and Arabic numerals (synthetic). */
const SAMPLE_PLANS = [
  "计划制作三集样稿进行试读并收集反馈。",
  "计划选取三集样稿进行试读并收集反馈。",
  "计划试读前三集样稿并收集反馈。",
  "计划制作3集样稿进行试读并收集反馈。",
  "计划选取 3 集样稿进行试读并收集反馈。",
  "计划试读前3集样稿并收集反馈。",
  "计划抽取两集样稿进行试读，再比较不同开场的反馈。",
  "计划试读第三集样稿并收集反馈。",
  "计划制作六十集样稿进行试读并收集反馈。",
];

/** Plans with no sample count: passed before and still pass. */
const PLAIN_PLANS = ["计划请试看者复述主角的选择和动机，再比较不同开场的反馈。", "计划请试看者比较两个开场。", "计划询问试看者是否想知道后续。"];

/**
 * Must stay refused: [label, text, semantic, rule]. A total of the work (also with a plan word), a sample outside the
 * work, a viewing habit or a measured result, and a legal sample followed by a statistic or a total conflict.
 */
const REFUSED: ReadonlyArray<readonly [string, string, string, string]> = [
  ["the work's total", "本剧共三集。", "frozen_conflict", "episode_count"],
  ["the work cut to three, with a plan word", "计划将本剧改为三集再验证。", "frozen_conflict", "episode_count"],
  ["the work cut to three samples, with a plan word", "计划将本剧改为三集样稿再验证。", "frozen_conflict", "episode_count"],
  ["a sample of zero", "计划制作零集样稿进行试读。", "frozen_conflict", "sample_out_of_range"],
  ["a sample of more than the work", "计划制作六十一集样稿进行试读。", "frozen_conflict", "sample_out_of_range"],
  ["a sample of more than the work, digits", "计划选取61集样稿进行试读。", "frozen_conflict", "sample_out_of_range"],
  ["a sample position past the work", "计划试读第61集样稿并收集反馈。", "frozen_conflict", "sample_out_of_range"],
  ["a sample position past the work, Chinese", "计划试读第六十一集样稿并收集反馈。", "frozen_conflict", "sample_out_of_range"],
  ["a sample position of zero", "计划试读第0集样稿并收集反馈。", "frozen_conflict", "sample_out_of_range"],
  ["a viewing habit", "观众通常观看三集后退出。", "market_statistic", "viewing_count"],
  ["a measured average", "调查显示观众平均观看三集。", "result_claim", "measured_result"],
  ["episodes read with no sample named (boundary: read as before)", "计划试读前三集并收集反馈。", "frozen_conflict", "episode_count"],
  ["a sample already read","已选取三集样稿进行试读，反馈很好。", "frozen_conflict", "episode_count"],
  ["a sample with a viewing habit beside it", "计划选取观众通常看完的三集样稿进行试读。", "market_statistic", "viewing_count"],
  // checks v9: the sample verb must take this count as its object. Both passed on fc64e84 (checks v8), where any sample
  // verb in the clause was enough; both were refused on 1feb0a6.
  ["cases picked, the count is what viewers watched", "计划选取观众看完三集样稿后都弃剧的案例。", "market_statistic", "viewing_count"],
  ["the work cut to three samples, a reading after it", "计划把本剧缩至三集样稿后试读。", "frozen_conflict", "episode_count"],
  ["a sample per viewer","计划请观众平均每人试读三集样稿。", "market_statistic", "rate_or_average"],
  ["a legal sample, then a share of viewers", "计划制作三集样稿进行试读，七成观众会喜欢。", "market_statistic", "proportion"],
  ["a legal sample, then the work's total", "计划制作三集样稿进行试读，本剧共三集。", "frozen_conflict", "episode_count"],
  ["a legal sample, then the work's total in the next sentence", "计划试读前三集样稿。本剧共三集。", "frozen_conflict", "episode_count"],
  ["a legal sample, then a measured share", "计划选取三集样稿试读。调查显示三成观众会追更。", "market_statistic", "proportion"],
];

describe("A. the number reading of a verification plan (classifier, not the stage)", () => {
  it.each(SAMPLE_PLANS)("a sample of this work in its plan is no total of episodes: %s", (text) => {
    expect(plan(text)).toEqual({ refusal: null, unverified: [] });
  });

  it.each(PLAIN_PLANS)("a plan with no sample count still passes: %s", (text) => {
    expect(plan(text)).toEqual({ refusal: null, unverified: [] });
  });

  it.each(REFUSED)("%s is refused: %s", (_label, text, semantic, rule) => {
    expect(plan(text).refusal).toMatchObject({ semantic, rule });
  });

  it("viewers named in a sample plan neither make it a statistic nor exempt anything else", () => {
    expect(plan("计划邀请观众试读三集样稿并收集反馈。")).toEqual({ refusal: null, unverified: [] });
    expect(plan("计划邀请观众试读三集样稿，看哪个开场更受欢迎。")).toEqual({ refusal: null, unverified: [] });
    // Without the sample, a count of episodes next to viewers is a viewing count, as before.
    expect(plan("计划请试看者看完前三集再收集反馈。").refusal).toMatchObject({ semantic: "market_statistic", rule: "viewing_count" });
  });

  it("outside a verification plan the same sample is read as before (no field gets the context by itself)", () => {
    for (const text of SAMPLE_PLANS.filter((item) => !/第|六十集/u.test(item))) {
      expect(uncitedNumberReading(text, FRAME, { unverified: true }).refusal, text).toMatchObject({ semantic: "frozen_conflict", rule: "episode_count" });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The whole research stage: limited and sourced runs of 60 episodes, and a series of 60 episodes.

function input(): AutoCreationFrozenInput {
  return {
    schema: "ads.auto-creation.input.v1", promptVersion: AUTO_CREATION_PROMPT_VERSION, selectionRules: "ads.auto-creation.selection-rules.v1",
    checksVersion: AUTO_CREATION_CHECKS_VERSION, idea: "", constraints: autoCreationConstraintsSchema.parse({}), materials: [], referenceUrls: [],
    researchFetch: false, episodeCount: EPISODES, episodeSeconds: 60, revisionRounds: 0, callBudget: 6, maxOutputTokens: 4096, providerKey: "deepseek",
    model: "m", authorization: { mode: "auto", proof: "site_session", initiatedBy: "a", executor: "auto-creation-engine" },
  };
}

const limitedContext = (run = input()): AutoCreationContext => ({ sources: collectSources(run, [], NOW), episodes: new Map(), reviews: [] });
/** A recent, readable market page (synthetic, no number in it): the snapshot is then sourced. */
const sourcedContext = (run = input()): AutoCreationContext => ({
  sources: collectSources(run, [{ url: OCEAN_ENGINE_ENTRY_URLS[0], status: "read", title: "合成市场样本页", text: "合成样本：本页只描述题材趋势，没有统计数字。",
    publishedAt: "2026-09-01T00:00:00.000Z", fetchedAt: NOW, note: "合成样本" }], NOW),
  episodes: new Map(), reviews: [],
});

const seriesInput: SeriesFrozenInput = {
  schema: SERIES_WRITING_INPUT_SCHEMA, promptVersion: SERIES_WRITING_PROMPT_VERSION, checksVersion: SERIES_WRITING_CHECKS_VERSION, researchContract: SERIES_RESEARCH_CONTRACT,
  idea: "", constraints: { genre: "", audience: "", maxCharacters: null, maxLocations: null, forbiddenThemes: [], endingRequirement: "" },
  materials: [], referenceUrls: [], researchFetch: false, episodeCount: EPISODES, episodeSeconds: 60, batchSize: 3, outlineChunk: 6,
};

type Checked = { ok: boolean } & Record<string, unknown>;
/** limited, sourced, and the series' borrowed research (its real 60 episodes passed through seriesAutoInput). */
const PATHS: ReadonlyArray<readonly [string, "limited" | "sourced", (content: string) => Checked]> = [
  ["limited", "limited", (content) => validateAutoStageOutput("research", content, input(), limitedContext()) as Checked],
  ["sourced", "sourced", (content) => validateAutoStageOutput("research", content, input(), sourcedContext()) as Checked],
  ["series (60 episodes)", "limited", (content) => {
    const autoInput = seriesAutoInput(seriesInput, { providerKey: "deepseek", model: "m", maxOutputTokens: 4096 });
    const context: SeriesContext = { input: seriesInput, auto: limitedContext(autoInput), outlines: new Map() };
    return validateSeriesStageOutput("research", content, seriesInput, context, autoInput) as unknown as Checked;
  }],
];

function answer(mode: "limited" | "sourced", first: { statement?: string; howToVerify: string }, more: { hypotheses?: unknown[]; opportunities?: string[] } = {}): string {
  const creative = {
    hypotheses: [
      { id: "H1", statement: first.statement ?? "合成样本：开场就让主角做出冒险选择，可能更容易让观众代入。", howToVerify: first.howToVerify },
      ...(more.hypotheses ?? [{ id: "H2", statement: "合成样本：误会在结尾解开，可能比中途解开更有悬念。", howToVerify: "计划比较两种解开时机的试看反馈。" }]),
    ],
    contentStructure: [{ reference: null, application: { pattern: "主角主动选择推动结果", why: "自主创作设计，没有对应的方法资料。" } }],
    opportunities: more.opportunities ?? ["小人物在一个夜晚完成一次反击"],
  };
  const audience = { primary: "在通勤和睡前刷短剧的成年观众（待验证假设）", viewingNeeds: ["一集内看到结果"], emotionalAppeals: ["扳回一局"] };
  return JSON.stringify(mode === "limited"
    ? { schema: AUTO_CREATION_RESEARCH_SCHEMA, ...creative, audience }
    : { schema: AUTO_CREATION_RESEARCH_SCHEMA, facts: [], observations: [], ...creative, audience: { ...audience, basis: "hypothesis", sourceIds: [] } });
}

describe("B. the whole research stage (validateAutoStageOutput, and the series' borrowed research)", () => {
  describe.each(PATHS)("%s", (_path, mode, check) => {
    it.each(SAMPLE_PLANS)("a sample plan in howToVerify passes and is kept as written: %s", (howToVerify) => {
      const result = check(answer(mode, { howToVerify }));
      expect(result).toMatchObject({ ok: true });
      const output = result.output as { hypotheses: Array<{ howToVerify: string }>; unverified: unknown[]; serverRecord: { settings: { items: Array<{ key: string; value: string }> } } };
      expect(output.hypotheses[0]!.howToVerify).toBe(howToVerify);
      expect(output.unverified).toEqual([]);
      // The server's record keeps the frozen total.
      expect(output.serverRecord.settings.items.find((item) => item.key === "episodes")?.value).toBe(`共 ${String(EPISODES)} 集`);
    });

    it.each(PLAIN_PLANS)("a plan with no sample count still passes: %s", (howToVerify) => {
      expect(check(answer(mode, { howToVerify }))).toMatchObject({ ok: true });
    });

    it.each(REFUSED)("%s in howToVerify is refused whole: %s", (_label, howToVerify, semantic, rule) => {
      const result = check(answer(mode, { howToVerify }));
      expect(result).toMatchObject({ ok: false, field: "hypotheses[0].howToVerify", semantic, rule,
        code: semantic === "frozen_conflict" ? "constraint_violation" : "unsourced_number" });
      expect(result).not.toHaveProperty("output");
    });

    it("the same sample in the statement gets no plan context", () => {
      expect(check(answer(mode, { statement: "计划制作三集样稿进行试读并收集反馈。", howToVerify: "计划请试看者比较两个开场。" })))
        .toMatchObject({ ok: false, code: "constraint_violation", field: "hypotheses[0].statement", semantic: "frozen_conflict", rule: "episode_count" });
    });

    it("a legal sample does not unlock a later hypothesis or opportunity", () => {
      const howToVerify = SAMPLE_PLANS[0]!;
      expect(check(answer(mode, { howToVerify }, { hypotheses: [{ id: "H2", statement: "合成样本：七成观众更喜欢反转。", howToVerify: "计划比较两种开场。" }] })))
        .toMatchObject({ ok: false, field: "hypotheses[1].statement", semantic: "market_statistic", rule: "proportion" });
      expect(check(answer(mode, { howToVerify }, { hypotheses: [{ id: "H2", statement: "合成样本：反派动机可能让冲突更可信。", howToVerify: "计划选取三集样稿，观众通常看三集后退出。" }] })))
        .toMatchObject({ ok: false, field: "hypotheses[1].howToVerify", semantic: "market_statistic", rule: "viewing_count" });
      expect(check(answer(mode, { howToVerify }, { opportunities: ["调查显示观众平均观看三集"] })))
        .toMatchObject({ ok: false, field: "opportunities[0]", semantic: "result_claim", rule: "measured_result" });
      expect(check(answer(mode, { howToVerify }, { opportunities: ["本剧共三集"] })))
        .toMatchObject({ ok: false, code: "constraint_violation", field: "opportunities[0]", semantic: "frozen_conflict", rule: "episode_count" });
    });
  });
});
