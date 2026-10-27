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
  type AutoCreationMaterial,
  type AutoResearch,
  type SeriesFrozenInput,
} from "@ai-drama/contracts";
import { OCEAN_ENGINE_ENTRY_URLS, collectSources } from "./auto-creation-sources";
import { numberTokens, uncitedNumberReading, type AutoNumberFrame } from "./auto-creation-numbers";
import { validateAutoStageOutput, type AutoCreationContext } from "./auto-creation";
import { seriesAutoInput, validateSeriesStageOutput, type SeriesContext } from "./series-writing";
import { autoReferenceCatalogOf } from "./auto-creation-references";

// The order of a future verification plan (checks v13): 第一阶段, 第一项测试, 第一轮试读 in a hypothesis' howToVerify are
// steps of the plan, not places in a ranking. Every text below is a SYNTHETIC sample. A real run was refused at
// hypotheses[0].howToVerify as unsourced_number, rank, market_statistic + ranking; the refused answer was not kept, so
// its sentence is NOT known and nothing here reproduces it or claims that run was refused wrongly. On main 8f1955e
// (checks v12), with 60 episodes of 60 seconds frozen, the three plans in CORE were refused as rank, market_statistic +
// ranking, while 计划在第一轮试读后收集反馈 passed.

const NOW = "2026-10-27T00:00:00.000Z";
const EPISODES = 60;

const frameOf = (episodeCount: number): AutoNumberFrame => ({
  exempt: [[episodeCount, "集"], [60, "秒"], [1, "分钟"]], frozenAudience: "", episodeCount, episodeSeconds: 60, maxCharacters: null, maxLocations: null,
});
/** How creativeNumber reads a hypothesis' howToVerify. */
const plan = (text: string, episodeCount = EPISODES) =>
  uncitedNumberReading(text, frameOf(episodeCount), { unverified: true, verificationPlan: true, structureDesign: true });
/** How creativeNumber reads every other creative field (a statement, an application, an opportunity). */
const elsewhere = (text: string) => uncitedNumberReading(text, frameOf(EPISODES), { unverified: true, structureDesign: true });

const RANKING = { kind: "rank", semantic: "market_statistic", rule: "ranking" } as const;
/** The same refusal as a research stage reports it (field, code, semantic and rule; the token and its kind stay internal). */
const REFUSED_RANKING = { semantic: "market_statistic", rule: "ranking" } as const;

/** The three legal plans refused on 8f1955e: a stage, a test item, a round followed by a popularity word. */
const CORE = [
  "计划在第一阶段收集反馈。",
  "计划在第一项测试中记录观众反馈。",
  "计划在第一轮试读后比较角色人气。",
];
/** The same steps in digits, spaced digits and other numerals, and the steps the plan already used. */
const CORE_MORE = [
  "计划在第1阶段收集反馈。",
  "计划在第 2 阶段对比两个版本的反馈。",
  "计划在第二项验证中邀请试看者复述主角动机。",
  "计划在第 1 项检查中记录观众反馈。",
  "计划在第二轮试读后比较角色人气。",
  "计划在第 3 轮试读后比较角色热度。",
  "计划第一步邀请试看者复述主角的选择，比较角色人气。",
  // The control that passed already.
  "计划在第一轮试读后收集反馈。",
];

/** Places in a ranking or of a metric: refused as before, a plan or a doubt marks none of them. [label, text]. */
const RANKED: ReadonlyArray<readonly [string, string]> = [
  ["a ranking", "该题材排名第一。"],
  ["a metric's place", "该题材播放量第3。"],
  ["a place on a chart", "该剧在榜单上位列第3。"],
  ["a reputation's place", "该题材口碑第一。"],
  ["a heat's place before an episode", "该剧热度第3集。"],
  ["a ranking to verify", "计划验证该剧是否排名第一。"],
  ["a metric's place to verify", "待验证该剧播放量是否第3。"],
  ["a ranking after a legal round", "计划在第一轮试读后比较排名第一的作品。"],
  ["a metric's place after a legal stage", "计划在第一阶段比较播放量第3的作品。"],
  ["a ranking after a legal stage, spaced", "计划在第 1 阶段比较排名第 2 的作品。"],
  ["a place a ranking takes, even before a stage word", "计划验证本剧能否排名第一阶段的榜首。"],
  ["a popularity's place before a round word", "计划比较人气第一轮的作品。"],
];

describe("P. a verification plan's step is no ranking (classifier)", () => {
  it.each(CORE)("a core plan passes as written, no notice: %s", (text) => {
    expect(plan(text)).toEqual({ refusal: null, unverified: [] });
  });

  it.each(CORE_MORE)("the same steps in other numerals and units pass: %s", (text) => {
    expect(plan(text)).toEqual({ refusal: null, unverified: [] });
  });

  it.each(RANKED)("%s is refused as a ranking in a plan: %s", (_label, text) => {
    expect(plan(text).refusal).toMatchObject(RANKING);
  });

  // A result claimed with no number (已测得观众更喜欢反转) is no number this reading refuses, on 8f1955e as now.
  it("a legal step does not end the reading: a share, a measured result, a later ranking are still refused", () => {
    expect(plan("计划在第一阶段收集反馈，七成观众会喜欢。").refusal).toMatchObject({ semantic: "market_statistic", rule: "proportion" });
    expect(plan("计划在第一轮试读后比较角色人气，实测观众平均观看三集。").refusal).toMatchObject({ semantic: "result_claim", rule: "measured_result" });
    expect(plan("计划在第一项测试中记录观众反馈，该题材排名第一。").refusal).toMatchObject(RANKING);
    expect(plan("计划在第一阶段收集反馈。该题材播放量第3。").refusal).toMatchObject(RANKING);
    expect(plan("计划在第一阶段收集反馈，本剧共三集。").refusal).toMatchObject({ semantic: "frozen_conflict", rule: "episode_count" });
  });

  it("a position of episodes is checked on the raw text first; a step's number has no episode bound", () => {
    for (const text of ["计划在第一阶段试读第61集。", "计划在第一阶段试读第六十一集。", "计划在第一阶段试读第零集。"]) {
      expect(plan(text).refusal, text).toMatchObject({ semantic: "frozen_conflict", rule: "sample_out_of_range" });
    }
    expect(plan("计划在第一阶段试读第三集。", 1).refusal).toMatchObject({ semantic: "frozen_conflict", rule: "sample_out_of_range" });
    expect(plan("第六十一集揭开反派身份后，计划在第一阶段收集反馈。").refusal).toMatchObject({ semantic: "frozen_conflict", rule: "episode_range_out_of_range" });
    expect(plan("计划在第三阶段收集反馈。", 1)).toEqual({ refusal: null, unverified: [] });
    expect(plan("计划在第一阶段试读第三集。", 3)).toEqual({ refusal: null, unverified: [] });
  });

  it("a plan's sample, an activity done and the work's local design read as before", () => {
    expect(plan("计划试读前三集并收集反馈。")).toEqual({ refusal: null, unverified: [] });
    expect(plan("用前三集建立主角与对手的冲突。")).toEqual({ refusal: null, unverified: [] });
    expect(plan("已完成前三集的试读。").refusal).toMatchObject({ semantic: "frozen_conflict", rule: "episode_count" });
    // A step already taken is no future plan: its ordinal keeps the reading it had.
    expect(plan("已在第一阶段收集反馈。").refusal).toMatchObject(RANKING);
    // A step whose own clause names no plan keeps the reading it had too (the plan word is read in the step's clause).
    expect(plan("计划分两步进行，在第一阶段请读者复述动机。").refusal).toMatchObject(RANKING);
  });

  it("no other field and no default reading gains the plan's steps", () => {
    for (const text of CORE.slice(0, 2)) expect(elsewhere(text).refusal, text).toMatchObject(RANKING);
    expect(elsewhere(CORE[2]!).refusal).toMatchObject(RANKING);
    expect(uncitedNumberReading(CORE[0]!, frameOf(EPISODES)).refusal).toMatchObject(RANKING);
    expect(uncitedNumberReading(CORE[0]!, frameOf(EPISODES), { market: true, verificationPlan: false }).refusal).toMatchObject(RANKING);
    for (const text of CORE) expect(numberTokens(text), text).toEqual([expect.stringMatching(/^名次第/u)]);
  });

  it("a cited place is supported only by the same place in a source", () => {
    const source = new Set(numberTokens("某短剧榜单中，该剧排名第三。"));
    expect(numberTokens("该剧排名第三。").every((token) => source.has(token))).toBe(true);
    expect(numberTokens("该剧排名第五。").every((token) => source.has(token))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The whole research stage: limited, sourced, and the series' borrowed research with its real 60 episodes.

const MATERIALS: AutoCreationMaterial[] = [
  { title: "合成方法笔记", kind: "notes", text: "关键结果来自主角的选择和行动，不靠旁人突然解围。七成观众喜欢每三集一个小高潮的节奏。", rightsConfirmed: true },
];

function input(episodeCount = EPISODES): AutoCreationFrozenInput {
  return {
    schema: "ads.auto-creation.input.v1", promptVersion: AUTO_CREATION_PROMPT_VERSION, selectionRules: "ads.auto-creation.selection-rules.v1",
    checksVersion: AUTO_CREATION_CHECKS_VERSION, idea: "", constraints: autoCreationConstraintsSchema.parse({}), materials: MATERIALS, referenceUrls: [],
    researchFetch: false, episodeCount, episodeSeconds: 60, revisionRounds: 0, callBudget: 6, maxOutputTokens: 4096, providerKey: "deepseek",
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
const seriesInput = (episodeCount: number): SeriesFrozenInput => ({
  schema: SERIES_WRITING_INPUT_SCHEMA, promptVersion: SERIES_WRITING_PROMPT_VERSION, checksVersion: SERIES_WRITING_CHECKS_VERSION, researchContract: SERIES_RESEARCH_CONTRACT,
  idea: "", constraints: { genre: "", audience: "", maxCharacters: null, maxLocations: null, forbiddenThemes: [], endingRequirement: "" },
  materials: MATERIALS, referenceUrls: [], researchFetch: false, episodeCount, episodeSeconds: 60, batchSize: 3, outlineChunk: 6,
});

type Checked = { ok: boolean; output?: AutoResearch } & Record<string, unknown>;
interface Path { name: string; mode: "limited" | "sourced"; check: (content: string) => Checked }

function paths(): Path[] {
  const run = input();
  const series = seriesInput(EPISODES);
  const borrowed = seriesAutoInput(series, { providerKey: "deepseek", model: "m", maxOutputTokens: 4096 });
  return [
    { name: "limited", mode: "limited", check: (content) => validateAutoStageOutput("research", content, run, limitedContext(run)) as Checked },
    { name: "sourced", mode: "sourced", check: (content) => validateAutoStageOutput("research", content, run, sourcedContext(run)) as Checked },
    { name: "series (60 episodes)", mode: "limited", check: (content) => {
      expect(borrowed.episodeCount).toBe(EPISODES);
      const context: SeriesContext = { input: series, auto: limitedContext(borrowed), outlines: new Map(), episodes: new Map(), stageHashes: new Map() };
      return validateSeriesStageOutput("research", content, series, context, borrowed) as unknown as Checked;
    } },
  ];
}

interface Parts { statement?: string; howToVerify?: string; opportunity?: string }

function answer(mode: "limited" | "sourced", parts: Parts): string {
  const creative = {
    hypotheses: [
      { id: "H1", statement: parts.statement ?? "合成样本：开场就让主角做出冒险选择，可能更容易让观众代入。", howToVerify: parts.howToVerify ?? "计划请试看者复述主角的选择和动机。" },
    ],
    contentStructure: ["主角主动选择推动结果", "反派动机逐步揭开", "误会在结尾解开", "小人物完成一次反击"]
      .map((pattern) => ({ referenceId: null, application: { pattern, why: "自主创作设计。" } })),
    opportunities: [parts.opportunity ?? "小人物在一个夜晚完成一次反击"],
  };
  const audience = { primary: "在通勤和睡前刷短剧的成年观众（待验证假设）", viewingNeeds: ["一集内看到结果"], emotionalAppeals: ["扳回一局"] };
  return JSON.stringify(mode === "limited"
    ? { schema: AUTO_CREATION_RESEARCH_ANSWER_SCHEMA, ...creative, audience }
    : { schema: AUTO_CREATION_RESEARCH_ANSWER_SCHEMA, facts: [], observations: [], ...creative, audience: { ...audience, basis: "hypothesis", sourceIds: [] } });
}

const PLAN_FIELD = "hypotheses[0].howToVerify";

describe("Q. the whole research stage (validateAutoStageOutput, and the series' borrowed research)", () => {
  describe.each(paths().map((path) => [path.name, path] as const))("%s", (_name, path) => {
    const { mode, check } = path;

    it.each(CORE)("a core plan passes in howToVerify, kept as written, no notice: %s", (text) => {
      const result = check(answer(mode, { howToVerify: text }));
      expect(result).toMatchObject({ ok: true });
      expect(result.output!.hypotheses[0]!.howToVerify).toBe(text);
      expect(result.output!.unverified).toEqual([]);
    });

    it("the run records the checks it executed", () => {
      const result = check(answer(mode, { howToVerify: CORE[0] }));
      expect(result.output!.serverRecord.executedWith).toMatchObject({ checksVersion: AUTO_CREATION_CHECKS_VERSION, promptVersion: AUTO_CREATION_PROMPT_VERSION });
      expect(AUTO_CREATION_CHECKS_VERSION).toBe("ads.auto-creation.checks.v13");
      expect(AUTO_CREATION_PROMPT_VERSION).toBe("ads.auto-creation.prompt.v10");
    });

    it.each(RANKED)("%s in howToVerify is refused whole: %s", (_label, text) => {
      const result = check(answer(mode, { howToVerify: text }));
      expect(result).toMatchObject({ ok: false, code: "unsourced_number", field: PLAN_FIELD, ...REFUSED_RANKING });
      expect(result).not.toHaveProperty("output");
    });

    it("a legal step followed by a share, a result, a ranking or a sample outside the work is refused whole", () => {
      for (const [text, semantic, rule] of [
        ["计划在第一阶段收集反馈，七成观众会喜欢。", "market_statistic", "proportion"],
        ["计划在第一轮试读后比较角色人气，实测观众平均观看三集。", "result_claim", "measured_result"],
        ["计划在第一项测试中记录观众反馈，该题材排名第一。", "market_statistic", "ranking"],
        ["计划在第一阶段试读第61集。", "frozen_conflict", "sample_out_of_range"],
      ] as const) {
        expect(check(answer(mode, { howToVerify: text })), text).toMatchObject({ ok: false, field: PLAN_FIELD, semantic, rule });
      }
    });

    it("a legal plan does not end the reading: a later field is still refused", () => {
      expect(check(answer(mode, { howToVerify: CORE[2], opportunity: "该题材排名第一" })))
        .toMatchObject({ ok: false, field: "opportunities[0]", ...REFUSED_RANKING });
    });

    it("the same steps in a hypothesis' statement and in an opportunity are read as before", () => {
      for (const text of CORE) {
        expect(check(answer(mode, { statement: text })), text).toMatchObject({ ok: false, field: "hypotheses[0].statement", ...REFUSED_RANKING });
        expect(check(answer(mode, { opportunity: text })), text).toMatchObject({ ok: false, field: "opportunities[0]", ...REFUSED_RANKING });
      }
    });
  });
});
