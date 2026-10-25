import { describe, expect, it } from "vitest";
import {
  AUTO_CREATION_CHECKS_VERSION,
  AUTO_CREATION_PROMPT_VERSION,
  AUTO_CREATION_RESEARCH_SCHEMA,
  AUTO_VIEWING_DURATION_REASONS,
  SERIES_RESEARCH_CONTRACT,
  SERIES_WRITING_CHECKS_VERSION,
  SERIES_WRITING_INPUT_SCHEMA,
  SERIES_WRITING_PROMPT_VERSION,
  autoCreationConstraintsSchema,
  autoErrorCodeWith,
  autoErrorParts,
  type AutoCreationFrozenInput,
  type SeriesFrozenInput,
} from "@ai-drama/contracts";
import { OCEAN_ENGINE_ENTRY_URLS, collectSources } from "./auto-creation-sources";
import { uncitedNumberReading, type AutoNumberFrame } from "./auto-creation-numbers";
import { validateAutoStageOutput, type AutoCreationContext } from "./auto-creation";
import { seriesAutoInput, validateSeriesStageOutput, type SeriesContext } from "./series-writing";

// Which check refused a viewing time (diagnostics only; prompt v8, checks v9 and research v4 unchanged). A real run
// (project 89f323d3-…) was refused at research as unsourced_number@contentStructure[0].application.why:
// digits+market_statistic+viewing_duration. Its answer was not kept, so its sentence is NOT known and nothing here
// reproduces it: every text below is a SYNTHETIC sample, one per branch, marked 合成样本. A branch says why the program
// refused, not whether the answer or the check was right.

const NOW = "2026-10-26T00:00:00.000Z";
const EPISODES = 60;
const FRAME: AutoNumberFrame = {
  exempt: [[EPISODES, "集"], [60, "秒"], [1, "分钟"]], frozenAudience: "", episodeCount: EPISODES, episodeSeconds: 60, maxCharacters: null, maxLocations: null,
};

/** [reason, synthetic text]: in the order the checks run. */
const BRANCHES = [
  ["viewing_habit", "合成样本：观众通常在30秒后退出。"],
  ["leaving_after", "合成样本：观众在30秒后退出。"],
  ["viewing_the_work", "合成样本：待验证观众观看本剧60秒后的反应。"],
  ["viewing_verb_before", "合成样本：待验证观众看了30秒是否被吸引。"],
  ["over_episode_length", "合成样本：待验证观众能否在90秒内理解冲突。"],
  ["not_pending", "合成样本：观众能在30秒内理解冲突。"],
  ["not_observation_unit", "合成样本：计划观察观众3小时内的反馈。"],
  ["no_plan_verb", "合成样本：观众7天内会追完。"],
] as const;

describe("A. the classifier names the branch of a viewing time", () => {
  it("every branch has a sample, and the samples follow the checks' order", () => {
    expect(BRANCHES.map(([reason]) => reason)).toEqual([...AUTO_VIEWING_DURATION_REASONS]);
  });

  it.each(BRANCHES)("%s: %s", (reason, text) => {
    expect(uncitedNumberReading(text, FRAME, { unverified: true })).toEqual({
      refusal: { token: expect.any(String) as string, kind: "digits", semantic: "market_statistic", rule: "viewing_duration", reason }, unverified: [],
    });
  });

  it("other refusals carry no reason; legal durations and pending ones read as before", () => {
    expect(uncitedNumberReading("合成样本：观众平均每天观看60秒。", FRAME).refusal).toEqual({ token: "60", kind: "digits", semantic: "market_statistic", rule: "rate_or_average" });
    expect(uncitedNumberReading("本剧共三集。", FRAME).refusal).toEqual({ token: "三集", kind: "chinese_numeral", semantic: "frozen_conflict", rule: "episode_count" });
    expect(uncitedNumberReading("合成样本：待验证观众是否喜欢本剧60秒的紧凑叙事。", FRAME, { unverified: true })).toEqual({ refusal: null, unverified: [] });
    expect(uncitedNumberReading("合成样本：上线后观察观众7天内的反馈。", FRAME, { unverified: true })).toEqual({ refusal: null, unverified: [] });
    expect(uncitedNumberReading("合成样本：待验证观众能否在30秒内理解冲突。", FRAME, { unverified: true })).toEqual({
      refusal: null, unverified: [{ token: "30", kind: "digits", semantic: "unclassified", rule: "duration_unconfirmed" }],
    });
  });
});

describe("B. the stored error code", () => {
  it("appends a known reason as a fourth part; the first five parts are what they were", () => {
    const stored = autoErrorCodeWith("unsourced_number", "contentStructure[0].application.why", "digits", "market_statistic", "viewing_duration", "not_pending");
    expect(stored).toBe("unsourced_number@contentStructure[0].application.why:digits+market_statistic+viewing_duration+not_pending");
    expect(autoErrorParts(stored)).toEqual({ code: "unsourced_number", field: "contentStructure[0].application.why", category: "digits",
      semantic: "market_statistic", rule: "viewing_duration", reason: "not_pending" });
  });

  it("writes no reason that is not a fixed slug, nor one on another rule", () => {
    expect(autoErrorCodeWith("unsourced_number", "f", "digits", "market_statistic", "viewing_duration", "原句片段")).toBe("unsourced_number@f:digits+market_statistic+viewing_duration");
    expect(autoErrorCodeWith("unsourced_number", "f", "digits", "market_statistic", "viewing_duration", "made_up")).toBe("unsourced_number@f:digits+market_statistic+viewing_duration");
    expect(autoErrorCodeWith("unsourced_number", "f", "digits", "market_statistic", "proportion", "viewing_habit")).toBe("unsourced_number@f:digits+market_statistic+proportion");
    expect(autoErrorCodeWith("unsourced_number", "f", "digits", "market_statistic", "viewing_duration")).toBe("unsourced_number@f:digits+market_statistic+viewing_duration");
  });

  it.each([
    ["a bare code", "unsourced_number", { code: "unsourced_number", field: null, category: null, semantic: null, rule: null, reason: null }],
    ["a field and a category (checks v2)", "unsourced_number@limitations[0]:digits", { code: "unsourced_number", field: "limitations[0]", category: "digits", semantic: null, rule: null, reason: null }],
    ["three number parts (checks v3)", "unsourced_number@hypotheses[0].statement:chinese_numeral+market_statistic+audience_count",
      { code: "unsourced_number", field: "hypotheses[0].statement", category: "chinese_numeral", semantic: "market_statistic", rule: "audience_count", reason: null }],
    ["a viewing time stored before its branch", "unsourced_number@contentStructure[0].application.why:digits+market_statistic+viewing_duration",
      { code: "unsourced_number", field: "contentStructure[0].application.why", category: "digits", semantic: "market_statistic", rule: "viewing_duration", reason: null }],
    ["an unknown reason", "unsourced_number@x:digits+market_statistic+viewing_duration+made_up",
      { code: "unsourced_number", field: "x", category: "digits", semantic: "market_statistic", rule: "viewing_duration", reason: null }],
    ["a known reason on another rule", "unsourced_number@x:digits+market_statistic+proportion+viewing_habit",
      { code: "unsourced_number", field: "x", category: "digits", semantic: "market_statistic", rule: "proportion", reason: null }],
  ] as const)("reads %s as before", (_label, stored, parts) => {
    expect(autoErrorParts(stored)).toEqual(parts);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The whole research stage, the sample in contentStructure[0].application.why: limited, sourced, and a series of 60.

function input(): AutoCreationFrozenInput {
  return {
    schema: "ads.auto-creation.input.v1", promptVersion: AUTO_CREATION_PROMPT_VERSION, selectionRules: "ads.auto-creation.selection-rules.v1",
    checksVersion: AUTO_CREATION_CHECKS_VERSION, idea: "", constraints: autoCreationConstraintsSchema.parse({}), materials: [], referenceUrls: [],
    researchFetch: false, episodeCount: EPISODES, episodeSeconds: 60, revisionRounds: 0, callBudget: 6, maxOutputTokens: 4096, providerKey: "deepseek",
    model: "m", authorization: { mode: "auto", proof: "site_session", initiatedBy: "a", executor: "auto-creation-engine" },
  };
}

const limitedContext = (run = input()): AutoCreationContext => ({ sources: collectSources(run, [], NOW), episodes: new Map(), reviews: [] });
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
const PATHS: ReadonlyArray<readonly [string, "limited" | "sourced", (content: string) => Checked]> = [
  ["limited", "limited", (content) => validateAutoStageOutput("research", content, input(), limitedContext()) as Checked],
  ["sourced", "sourced", (content) => validateAutoStageOutput("research", content, input(), sourcedContext()) as Checked],
  ["series (60 episodes)", "limited", (content) => {
    const autoInput = seriesAutoInput(seriesInput, { providerKey: "deepseek", model: "m", maxOutputTokens: 4096 });
    const context: SeriesContext = { input: seriesInput, auto: limitedContext(autoInput), outlines: new Map() };
    return validateSeriesStageOutput("research", content, seriesInput, context, autoInput) as unknown as Checked;
  }],
];

function answer(mode: "limited" | "sourced", why: string): string {
  const creative = {
    hypotheses: [{ id: "H1", statement: "合成样本：开场就让主角做出冒险选择，可能更容易让观众代入。", howToVerify: "计划比较两种开场的试看反馈。" }],
    contentStructure: [{ reference: null, application: { pattern: "主角主动选择推动结果", why } }],
    opportunities: ["小人物在一个夜晚完成一次反击"],
  };
  const audience = { primary: "在通勤和睡前刷短剧的成年观众（待验证假设）", viewingNeeds: ["一集内看到结果"], emotionalAppeals: ["扳回一局"] };
  return JSON.stringify(mode === "limited"
    ? { schema: AUTO_CREATION_RESEARCH_SCHEMA, ...creative, audience }
    : { schema: AUTO_CREATION_RESEARCH_SCHEMA, facts: [], observations: [], ...creative, audience: { ...audience, basis: "hypothesis", sourceIds: [] } });
}

const FIELD = "contentStructure[0].application.why";

describe("C. the whole research stage keeps the branch beside the five parts it had", () => {
  describe.each(PATHS)("%s", (_path, mode, check) => {
    it.each(BRANCHES)("%s in application.why", (reason, why) => {
      const result = check(answer(mode, why));
      expect(result).toMatchObject({ ok: false, code: "unsourced_number", field: FIELD, category: "digits", semantic: "market_statistic", rule: "viewing_duration", reason });
      expect(result).not.toHaveProperty("output");
      const r = result as unknown as { code: string; field: string; category: string; semantic: string; rule: string; reason: string };
      const stored = autoErrorCodeWith(r.code, r.field, r.category, r.semantic, r.rule, r.reason);
      expect(stored).toBe(`unsourced_number@${FIELD}:digits+market_statistic+viewing_duration+${reason}`);
      // The five parts are exactly what the same answer was stored with before the branch was named.
      const five = ({ code, field, category, semantic, rule }: ReturnType<typeof autoErrorParts>) => ({ code, field, category, semantic, rule });
      expect(five(autoErrorParts(stored))).toEqual(five(autoErrorParts(`unsourced_number@${FIELD}:digits+market_statistic+viewing_duration`)));
      // No model text in the code.
      expect(stored).not.toMatch(/[^\x20-\x7e]/u);
    });

    it("a legal work length, a planned observation and a pending duration pass as before", () => {
      expect(check(answer(mode, "合成样本：待验证观众是否喜欢本剧60秒的紧凑叙事。"))).toMatchObject({ ok: true });
      expect(check(answer(mode, "合成样本：上线后观察观众7天内的反馈。"))).toMatchObject({ ok: true });
      const pending = check(answer(mode, "合成样本：待验证观众能否在30秒内理解冲突。"));
      expect(pending).toMatchObject({ ok: true });
      expect((pending.output as { unverified: Array<{ field: string; rule: string }> }).unverified).toEqual([expect.objectContaining({ field: FIELD, rule: "duration_unconfirmed" })]);
    });
  });
});
