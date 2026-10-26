import { describe, expect, it } from "vitest";
import {
  AUTO_CREATION_CHECKS_VERSION,
  AUTO_CREATION_PROMPT_VERSION,
  AUTO_CREATION_RESEARCH_ANSWER_SCHEMA,
  AUTO_UNVERIFIED_EPISODE_SCOPE_NOTE,
  SERIES_RESEARCH_CONTRACT,
  SERIES_WRITING_CHECKS_VERSION,
  SERIES_WRITING_INPUT_SCHEMA,
  SERIES_WRITING_PROMPT_VERSION,
  autoCreationConstraintsSchema,
  type AutoCreationFrozenInput,
  type AutoResearch,
  type AutoStageRecord,
  type SeriesFrozenInput,
} from "@ai-drama/contracts";
import { OCEAN_ENGINE_ENTRY_URLS, collectSources } from "./auto-creation-sources";
import { uncitedNumberReading, type AutoNumberFrame } from "./auto-creation-numbers";
import {
  AUTO_RESEARCH_IDENTITY, autoContextFromStages, autoPackageJson, autoPackageMarkdown, buildAutoCreationPrompt, validateAutoStageOutput,
  type AutoCreationContext,
} from "./auto-creation";
import { seriesAutoInput, validateSeriesStageOutput, type SeriesContext } from "./series-writing";
import { autoReferenceCatalogOf } from "./auto-creation-references";

// The scope of a count of episodes in a verification plan (checks v11). A real run (60 episodes) was refused at
// hypotheses[0].howToVerify as constraint_violation, chinese_numeral, frozen_conflict + episode_count. The refused answer
// was not kept, so its sentence is NOT known and nothing here reproduces it: every text below is a SYNTHETIC sample.
// On main 208c5e3 (checks v10) the three plans in SAMPLE_PLANS were refused with 60 episodes frozen: the first and third
// as frozen_conflict + episode_count, the second as market_statistic + viewing_count.

const NOW = "2026-10-26T00:00:00.000Z";
const EPISODES = 60;

const FRAME: AutoNumberFrame = {
  exempt: [[EPISODES, "集"], [60, "秒"], [1, "分钟"]], frozenAudience: "", episodeCount: EPISODES, episodeSeconds: 60, maxCharacters: null, maxLocations: null,
};
const plan = (text: string) => uncitedNumberReading(text, FRAME, { unverified: true, verificationPlan: true });

/** C: a sample of this work its own reading or picking verb takes, no 样稿 needed (synthetic). */
const SAMPLE_PLANS = [
  "计划试读前三集并收集反馈。",
  "计划邀请观众试读前三集并收集反馈。",
  "计划选取其中三集进行试读并收集反馈。",
];
/** C, as before (checks v8/v9): a made sample, and positions and counts within the work. */
const STILL_PASSING = [
  "计划制作三集样稿进行试读并收集反馈。",
  "计划试读前 3 集并收集反馈。",
  "计划抽取其中两集，再比较不同开场的反馈。",
  "计划试读本剧前三集并收集反馈。",
  "计划试读第三集并收集反馈。",
  "计划试读六十集样稿并收集反馈。",
];

/** D: a future plan whose count of episodes the code cannot place: kept, with a notice (synthetic). */
const UNCONFIRMED: ReadonlyArray<readonly [string, string]> = [
  ["a viewing instruction to testers, no sample verb on the count", "计划请试看者看完前三集再收集反馈。"],
  ["a made count with no sample named", "计划制作三集再收集试看反馈。"],
  ["episodes as a span of the plan", "计划在三集内让试看者说出主角的动机。"],
];

/** A, B and samples outside the work: refused as before, plan word or not. [label, text, semantic, rule]. */
const REFUSED: ReadonlyArray<readonly [string, string, string, string]> = [
  ["the work's total", "本剧共三集。", "frozen_conflict", "episode_count"],
  ["the work changed to three, with a plan word", "计划将本剧改为三集再验证。", "frozen_conflict", "episode_count"],
  ["the work cut to three samples, a reading after it", "计划把本剧缩至三集样稿后试读。", "frozen_conflict", "episode_count"],
  ["the work cut to three, a reading after it", "计划把本剧缩短为三集后试读。", "frozen_conflict", "episode_count"],
  ["the work's total right before the count, with a plan word", "计划试读全剧三集。", "frozen_conflict", "episode_count"],
  ["cases picked, the count is what viewers watched", "计划选取观众看完三集样稿后都弃剧的案例。", "market_statistic", "viewing_count"],
  ["viewers leaving after a count, with a plan word", "计划请试看者读完三集后就弃剧。", "market_statistic", "viewing_count"],
  ["a viewing habit", "观众通常观看三集后退出。", "market_statistic", "viewing_count"],
  ["a measured average", "调查显示观众平均观看三集。", "result_claim", "measured_result"],
  ["a reading already done", "已试读前三集，反馈很好。", "frozen_conflict", "episode_count"],
  ["a reading done, with a plan word", "计划试读过前三集再收集反馈。", "frozen_conflict", "episode_count"],
  ["a sample of more than the work, made", "计划制作六十一集样稿进行试读。", "frozen_conflict", "sample_out_of_range"],
  ["a sample of more than the work, read", "计划试读六十一集并收集反馈。", "frozen_conflict", "sample_out_of_range"],
  ["a sample of zero", "计划试读零集并收集反馈。", "frozen_conflict", "sample_out_of_range"],
  ["a sample position past the work", "计划试读第六十一集并收集反馈。", "frozen_conflict", "sample_out_of_range"],
  ["a sample position past the work, digits", "计划试读第61集并收集反馈。", "frozen_conflict", "sample_out_of_range"],
  ["a second sample position past the work", "计划试读第2集和第61集并收集反馈。", "frozen_conflict", "sample_out_of_range"],
  ["an unplaced count larger than the work", "计划请试看者看完六十一集再收集反馈。", "frozen_conflict", "episode_count"],
  ["a count of episodes with no plan at all", "试看者看完前三集。", "market_statistic", "viewing_count"],
  // A legal sample or an unconfirmed count, then a statistic, a result or a total conflict.
  ["a legal sample, then a share of viewers", "计划试读前三集并收集反馈，七成观众会喜欢。", "market_statistic", "proportion"],
  ["a legal sample, then a measured result", "计划选取其中三集进行试读，已测得观众更喜欢反转。", "result_claim", "measured_result"],
  ["a legal sample, then the work's total", "计划邀请观众试读前三集，本剧共三集。", "frozen_conflict", "episode_count"],
  ["an unconfirmed count, then a share of viewers", "计划请试看者看完前三集，七成观众会喜欢。", "market_statistic", "proportion"],
  ["an unconfirmed count, then the work's total in the next sentence", "计划请试看者看完前三集再收集反馈。本剧共三集。", "frozen_conflict", "episode_count"],
  ["an unconfirmed count, then a measured share in the next sentence", "计划在三集内让试看者说出动机。调查显示三成观众会追更。", "market_statistic", "proportion"],
];

describe("A. the scope of a count of episodes in a verification plan (classifier, not the stage)", () => {
  it.each(SAMPLE_PLANS)("a sample its own verb takes passes as written: %s", (text) => {
    expect(plan(text)).toEqual({ refusal: null, unverified: [] });
  });

  it.each(STILL_PASSING)("a sample that passed before still passes: %s", (text) => {
    expect(plan(text)).toEqual({ refusal: null, unverified: [] });
  });

  it.each(UNCONFIRMED)("%s is kept with an episode-scope notice: %s", (_label, text) => {
    expect(plan(text)).toEqual({ refusal: null, unverified: [expect.objectContaining({ semantic: "unclassified", rule: "episode_scope_unconfirmed" })] });
  });

  it.each(REFUSED)("%s is refused: %s", (_label, text, semantic, rule) => {
    expect(plan(text).refusal).toMatchObject({ semantic, rule });
  });

  it("no other field gets the plan scope: the same texts outside a howToVerify are read as before", () => {
    expect(uncitedNumberReading(SAMPLE_PLANS[0]!, FRAME, { unverified: true }).refusal).toMatchObject({ semantic: "frozen_conflict", rule: "episode_count" });
    expect(uncitedNumberReading(SAMPLE_PLANS[1]!, FRAME, { unverified: true }).refusal).toMatchObject({ semantic: "market_statistic", rule: "viewing_count" });
    expect(uncitedNumberReading(SAMPLE_PLANS[2]!, FRAME, { unverified: true }).refusal).toMatchObject({ semantic: "frozen_conflict", rule: "episode_count" });
    expect(uncitedNumberReading(UNCONFIRMED[0]![1], FRAME, { unverified: true }).refusal).toMatchObject({ semantic: "market_statistic", rule: "viewing_count" });
    expect(uncitedNumberReading(UNCONFIRMED[1]![1], FRAME, { unverified: true }).refusal).toMatchObject({ semantic: "frozen_conflict", rule: "episode_count" });
  });

  it("a sample is held to the frozen episodes of the run, not to 60", () => {
    const three: AutoNumberFrame = { ...FRAME, exempt: [[3, "集"], [60, "秒"], [1, "分钟"]], episodeCount: 3 };
    expect(uncitedNumberReading("计划试读前两集并收集反馈。", three, { unverified: true, verificationPlan: true })).toEqual({ refusal: null, unverified: [] });
    expect(uncitedNumberReading("计划试读前五集并收集反馈。", three, { unverified: true, verificationPlan: true }).refusal)
      .toMatchObject({ semantic: "frozen_conflict", rule: "sample_out_of_range" });
    expect(uncitedNumberReading("计划试读第五集并收集反馈。", three, { unverified: true, verificationPlan: true }).refusal)
      .toMatchObject({ semantic: "frozen_conflict", rule: "sample_out_of_range" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The whole research stage: limited and sourced runs of 60 episodes, and a series of 60 episodes.

const withCatalog = (context: AutoCreationContext): AutoCreationContext => ({ ...context, referenceCatalog: autoReferenceCatalogOf(context.sources) });

function input(): AutoCreationFrozenInput {
  return {
    schema: "ads.auto-creation.input.v1", promptVersion: AUTO_CREATION_PROMPT_VERSION, selectionRules: "ads.auto-creation.selection-rules.v1",
    checksVersion: AUTO_CREATION_CHECKS_VERSION, idea: "", constraints: autoCreationConstraintsSchema.parse({}), materials: [], referenceUrls: [],
    researchFetch: false, episodeCount: EPISODES, episodeSeconds: 60, revisionRounds: 0, callBudget: 6, maxOutputTokens: 4096, providerKey: "deepseek",
    model: "m", authorization: { mode: "auto", proof: "site_session", initiatedBy: "a", executor: "auto-creation-engine" },
  };
}

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

type Checked = { ok: boolean } & Record<string, unknown>;
const PATHS: ReadonlyArray<readonly [string, "limited" | "sourced", (content: string) => Checked]> = [
  ["limited", "limited", (content) => validateAutoStageOutput("research", content, input(), limitedContext()) as Checked],
  ["sourced", "sourced", (content) => validateAutoStageOutput("research", content, input(), sourcedContext()) as Checked],
  ["series (60 episodes)", "limited", (content) => {
    const autoInput = seriesAutoInput(seriesInput, { providerKey: "deepseek", model: "m", maxOutputTokens: 4096 });
    expect(autoInput.episodeCount).toBe(EPISODES);
    const context: SeriesContext = { input: seriesInput, auto: limitedContext(autoInput), outlines: new Map(), episodes: new Map(), stageHashes: new Map() };
    return validateSeriesStageOutput("research", content, seriesInput, context, autoInput) as unknown as Checked;
  }],
];

function answer(mode: "limited" | "sourced", first: { statement?: string; howToVerify: string }, more: { hypotheses?: unknown[]; opportunities?: string[] } = {}): string {
  const creative = {
    hypotheses: [
      { id: "H1", statement: first.statement ?? "合成样本：开场就让主角做出冒险选择，可能更容易让观众代入。", howToVerify: first.howToVerify },
      ...(more.hypotheses ?? [{ id: "H2", statement: "合成样本：误会在结尾解开，可能比中途解开更有悬念。", howToVerify: "计划比较两种解开时机的试看反馈。" }]),
    ],
    contentStructure: [{ referenceId: null, application: { pattern: "主角主动选择推动结果", why: "自主创作设计，没有对应的方法资料。" } }],
    opportunities: more.opportunities ?? ["小人物在一个夜晚完成一次反击"],
  };
  const audience = { primary: "在通勤和睡前刷短剧的成年观众（待验证假设）", viewingNeeds: ["一集内看到结果"], emotionalAppeals: ["扳回一局"] };
  return JSON.stringify(mode === "limited"
    ? { schema: AUTO_CREATION_RESEARCH_ANSWER_SCHEMA, ...creative, audience }
    : { schema: AUTO_CREATION_RESEARCH_ANSWER_SCHEMA, facts: [], observations: [], ...creative, audience: { ...audience, basis: "hypothesis", sourceIds: [] } });
}

type Output = AutoResearch;

describe("B. the whole research stage (validateAutoStageOutput, and the series' borrowed research)", () => {
  describe.each(PATHS)("%s", (_path, mode, check) => {
    it.each([...SAMPLE_PLANS, ...STILL_PASSING])("a sample in howToVerify passes, kept as written, with no notice: %s", (howToVerify) => {
      const result = check(answer(mode, { howToVerify }));
      expect(result).toMatchObject({ ok: true });
      const output = result.output as Output;
      expect(output.hypotheses[0]!.howToVerify).toBe(howToVerify);
      expect(output.unverified).toEqual([]);
      expect(output.serverRecord.settings.items.find((item) => item.key === "episodes")?.value).toBe(`共 ${String(EPISODES)} 集`);
      expect(output.serverRecord.executedWith).toMatchObject({ checksVersion: "ads.auto-creation.checks.v11", promptVersion: "ads.auto-creation.prompt.v10" });
    });

    it.each(UNCONFIRMED)("%s passes with an episode-scope notice on that field, kept as written: %s", (_label, howToVerify) => {
      const result = check(answer(mode, { howToVerify }));
      expect(result).toMatchObject({ ok: true });
      const output = result.output as Output;
      expect(output.hypotheses[0]!.howToVerify).toBe(howToVerify);
      expect(output.unverified).toEqual([{ origin: "server_check", field: "hypotheses[0].howToVerify", token: expect.any(String), semantic: "unclassified",
        rule: "episode_scope_unconfirmed", note: AUTO_UNVERIFIED_EPISODE_SCOPE_NOTE }]);
    });

    it.each(REFUSED)("%s in howToVerify is refused whole: %s", (_label, howToVerify, semantic, rule) => {
      const result = check(answer(mode, { howToVerify }));
      expect(result).toMatchObject({ ok: false, field: "hypotheses[0].howToVerify", semantic, rule,
        code: semantic === "frozen_conflict" ? "constraint_violation" : "unsourced_number" });
      expect(result).not.toHaveProperty("output");
    });

    it("a notice does not end the reading: a later hypothesis or opportunity is still refused", () => {
      const howToVerify = UNCONFIRMED[0]![1];
      expect(check(answer(mode, { howToVerify }, { hypotheses: [{ id: "H2", statement: "合成样本：七成观众更喜欢反转。", howToVerify: "计划比较两种开场。" }] })))
        .toMatchObject({ ok: false, field: "hypotheses[1].statement", semantic: "market_statistic", rule: "proportion" });
      expect(check(answer(mode, { howToVerify }, { hypotheses: [{ id: "H2", statement: "合成样本：反派动机可能让冲突更可信。", howToVerify: "已测得观众平均观看三集。" }] })))
        .toMatchObject({ ok: false, field: "hypotheses[1].howToVerify", semantic: "result_claim", rule: "measured_result" });
      expect(check(answer(mode, { howToVerify }, { opportunities: ["本剧共三集"] })))
        .toMatchObject({ ok: false, code: "constraint_violation", field: "opportunities[0]", semantic: "frozen_conflict", rule: "episode_count" });
    });

    it("the statement and the opportunities get no plan scope", () => {
      expect(check(answer(mode, { statement: SAMPLE_PLANS[0]!, howToVerify: "计划请试看者比较两个开场。" })))
        .toMatchObject({ ok: false, code: "constraint_violation", field: "hypotheses[0].statement", semantic: "frozen_conflict", rule: "episode_count" });
      expect(check(answer(mode, { howToVerify: "计划请试看者比较两个开场。" }, { opportunities: [UNCONFIRMED[1]![1]] })))
        .toMatchObject({ ok: false, code: "constraint_violation", field: "opportunities[0]", semantic: "frozen_conflict", rule: "episode_count" });
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The notice as shown in the package (Markdown, JSON) and given to the next stage.

describe("C. the episode-scope notice in the package and the next prompt", () => {
  const stage = (stageKey: string, ordinal: number, output: unknown): AutoStageRecord => ({ runId: "r", stageKey, ordinal, state: "completed", attemptNo: 1,
    errorCode: null, output: output as AutoStageRecord["output"], outputHash: "h", dependsOn: null, scriptSave: null, scriptRevisionId: null, updatedAt: NOW });
  const meta = { runId: "r", projectId: "p", input: input(), quality: "pending", state: "running", callsUsed: 1, callCap: 6, revisionRoundsUsed: 0,
    storySave: "pending", generatedAt: NOW } as const;

  it("names its place and says the scope is unconfirmed, never a viewing time or a finding", () => {
    const result = validateAutoStageOutput("research", answer("limited", { howToVerify: UNCONFIRMED[0]![1] }), input(), limitedContext());
    const research = (result as { output: AutoResearch }).output;
    const stages = [stage("sources", 0, collectSources(input(), [], NOW)), stage("research", 1, research)];
    const line = `第1条假设（H1）的验证计划中的「${research.unverified[0]!.token}」：程序无法确认集数描述的作用范围，未核实；只属于创作假设或设计，不是有来源的事实或市场结论。`;
    const markdown = autoPackageMarkdown(meta, stages);
    const prompt = buildAutoCreationPrompt("directions", input(), autoContextFromStages(stages)).user;
    for (const text of [markdown, prompt]) {
      expect(text).toContain(line);
      expect(text).not.toContain("程序无法确认时长含义");
    }
    // Markdown keeps the plan as written.
    expect(markdown).toContain(`验证计划：${UNCONFIRMED[0]![1]}`);
    expect(markdown).toContain("**未核实提示**（程序未能判定数字、时长含义或集数作用范围，未核实；");
    const json = autoPackageJson(meta, stages) as { research: { analysis: AutoResearch; identity: Record<string, string> } };
    expect(json.research.analysis.unverified).toEqual(research.unverified);
    expect(json.research.analysis.hypotheses[0]!.howToVerify).toBe(UNCONFIRMED[0]![1]);
    expect(AUTO_RESEARCH_IDENTITY.unverified).toContain("episode_scope_unconfirmed：集数描述的作用范围");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The research prompt (prompt v10): the total stays the frozen one; a plan may sample part of the work.

describe("D. the research prompt says a plan may read part of the work, with an example within the run", () => {
  const prompt = (episodeCount: number, mode: "limited" | "sourced" = "limited") => {
    const run = { ...input(), episodeCount };
    return buildAutoCreationPrompt("research", run, mode === "limited" ? limitedContext(run) : sourcedContext(run)).user;
  };

  it.each([1, 2, 3, 6, 60])("%i episodes: the total is fixed, a sample stays within the run", (episodeCount) => {
    for (const mode of ["limited", "sourced"] as const) {
      const user = prompt(episodeCount, mode);
      expect(user).toContain("提示版本：ads.auto-creation.prompt.v10");
      expect(user).toContain(`全剧总集数只能是用户硬约束里的 ${String(episodeCount)} 集`);
      expect(user).toContain(`抽取的集数或第几集必须在 1 到 ${String(episodeCount)} 集之内`);
      expect(user).toContain("不写观众实际看了几集、看几集后退出、通常或平均看几集");
      expect(user).toContain(`共 ${String(episodeCount)} 集，每集约 60 秒`);
      // Every sample count the example gives lies within the run, and none is the whole run but a one-episode one.
      for (const [, digits] of user.matchAll(/计划(?:试读|选取)[^“”]*?(\d+) 集/gu)) {
        expect(Number(digits)).toBeGreaterThanOrEqual(1);
        expect(Number(digits)).toBeLessThan(Math.max(episodeCount, 2));
      }
      if (episodeCount === 1) expect(user).toContain("计划试读这一集并收集反馈");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// An adjustment word that changes something else (checks v11 fix before release). On 24fbccc a clause-wide test for
// 改为 / 延长到 … refused the legal sample below as a total-episode conflict on all three paths, and the same clause
// switched off the range check of a 第N集 sample. Synthetic samples, not a real refused answer.

/** A sample beside an adjustment of something that is no count of episodes: C, no notice. */
const ADJUSTED_ELSEWHERE = [
  "计划制作三集样稿并把试读时间延长到三天。",
  "计划试读前三集并把反馈收集期延长到七天。",
];
/** The same clause shape, refused for what the count is: out of range, a real total, or a total beside the sample. */
const ADJUSTED_REFUSED: ReadonlyArray<readonly [string, string, string, string]> = [
  ["a made sample past the work", "计划制作六十一集样稿并把试读时间延长到三天。", "frozen_conflict", "sample_out_of_range"],
  ["a sample position past the work", "计划试读第六十一集并把试读时间延长到三天。", "frozen_conflict", "sample_out_of_range"],
  ["a sample, then the work cut to two", "计划制作三集样稿并把本剧缩至两集。", "frozen_conflict", "episode_count"],
  ["the work compressed to three", "计划压缩本剧到三集再试读。", "frozen_conflict", "episode_count"],
  ["a sample and a longer reading, then the work's total", "计划制作三集样稿并把试读时间延长到三天，本剧共三集。", "frozen_conflict", "episode_count"],
  ["a sample and a longer reading, then a share of viewers", "计划试读前三集并把反馈收集期延长到七天，七成观众会喜欢。", "market_statistic", "proportion"],
  ["a sample and a longer reading, then a measured result", "计划制作三集样稿并把试读时间延长到三天，已测得观众更喜欢反转。", "result_claim", "measured_result"],
];

describe("E. an adjustment word for something else leaves a sample a sample", () => {
  it.each(ADJUSTED_ELSEWHERE)("classifier: the count is a sample, with no notice: %s", (text) => {
    expect(plan(text)).toEqual({ refusal: null, unverified: [] });
  });

  it.each(ADJUSTED_REFUSED)("classifier: %s is refused: %s", (_label, text, semantic, rule) => {
    expect(plan(text).refusal).toMatchObject({ semantic, rule });
  });

  describe.each(PATHS)("%s", (_path, mode, check) => {
    it.each(ADJUSTED_ELSEWHERE)("passes the whole research as written, with no notice: %s", (howToVerify) => {
      const result = check(answer(mode, { howToVerify }));
      expect(result).toMatchObject({ ok: true });
      const output = result.output as Output;
      expect(output.hypotheses[0]!.howToVerify).toBe(howToVerify);
      expect(output.unverified).toEqual([]);
    });

    it.each(ADJUSTED_REFUSED)("%s is refused whole: %s", (_label, howToVerify, semantic, rule) => {
      const result = check(answer(mode, { howToVerify }));
      expect(result).toMatchObject({ ok: false, field: "hypotheses[0].howToVerify", semantic, rule,
        code: semantic === "frozen_conflict" ? "constraint_violation" : "unsourced_number" });
      expect(result).not.toHaveProperty("output");
    });
  });
});
