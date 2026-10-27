import { describe, expect, it } from "vitest";
import {
  AUTO_CREATION_CHECKS_VERSION,
  AUTO_CREATION_DIRECTIONS_SCHEMA,
  AUTO_CREATION_PROMPT_VERSION,
  AUTO_CREATION_RESEARCH_ANSWER_SCHEMA,
  AUTO_UNVERIFIED_EPISODE_SCOPE_NOTE,
  SERIES_RESEARCH_CONTRACT,
  SERIES_WRITING_CHECKS_VERSION,
  SERIES_WRITING_INPUT_SCHEMA,
  SERIES_WRITING_PROMPT_VERSION,
  autoCreationConstraintsSchema,
  type AutoCreationFrozenInput,
  type AutoCreationMaterial,
  type AutoDirections,
  type AutoResearch,
  type AutoStageRecord,
  type SeriesFrozenInput,
} from "@ai-drama/contracts";
import { OCEAN_ENGINE_ENTRY_URLS, collectSources } from "./auto-creation-sources";
import { uncitedNumberReading, type AutoNumberFrame } from "./auto-creation-numbers";
import {
  autoContextFromStages, autoPackageJson, autoPackageMarkdown, buildAutoCreationPrompt, validateAutoStageOutput, type AutoCreationContext,
} from "./auto-creation";
import { seriesAutoInput, validateSeriesStageOutput, type SeriesContext } from "./series-writing";
import { autoReferenceCatalogOf } from "./auto-creation-references";

// A count or a position of episodes in the work's own creative design (checks v12): a structure's application, a
// hypothesis, its plan, an opportunity, a direction's notes. Every text below is a SYNTHETIC sample. A real run (60
// episodes) was refused at contentStructure[4].application.pattern as constraint_violation, chinese_numeral,
// frozen_conflict + episode_count; the refused answer was not kept, so its sentence is NOT known and nothing here
// reproduces it or claims the run was refused wrongly. On main 12951c8 (checks v11), with 60 episodes frozen, the three
// local designs in LOCAL were refused as frozen_conflict + episode_count, and a position past the work (第61集) passed.

const NOW = "2026-10-26T00:00:00.000Z";
const EPISODES = 60;

const frameOf = (episodeCount: number): AutoNumberFrame => ({
  exempt: [[episodeCount, "集"], [60, "秒"], [1, "分钟"]], frozenAudience: "", episodeCount, episodeSeconds: 60, maxCharacters: null, maxLocations: null,
});
/** How creativeNumber reads a creative field (checks v12): unverified notices kept, the work's own design read by its scope. */
const design = (text: string, episodeCount = EPISODES) => uncitedNumberReading(text, frameOf(episodeCount), { unverified: true, structureDesign: true });

/** Local structure of the work its own range word takes (每, 每隔, 前, 用, 用前): passes as written, no notice. */
const LOCAL = [
  "本剧每三集设置一个小高潮。",
  "用前三集建立主角与对手的冲突。",
  "每六集推进一个阶段目标。",
];
const LOCAL_MORE = [
  "每隔两集安排一次反转。",
  "用三集完成主角的第一次反击。",
  "用本剧前三集交代主角处境。",
  "第三集让主角第一次主动反击。",
  "第3集和第４集交代反派动机。",
  "共六十集，每集约60秒。",
  // A pending judgement about viewers whose count is the work's own structure.
  "待验证观众是否喜欢本剧每三集一个小高潮的节奏。",
  // An adjustment of something else, before or after the local count, changes no total.
  "把反派出场时间延长到两场，每三集设置一个小高潮。",
  "每三集设置一个小高潮，并把高潮间隔缩短到两场戏。",
  "把试读时间延长到三天并用前三集建立冲突。",
];

/** A count within the work the code cannot place: kept as written with an episode-scope notice. */
const UNCONFIRMED = [
  "三集一个反转，推动主角主动选择。",
  "在三集内完成第一次反击。",
];

/** Refused as before, or as a range outside the work. [label, text, semantic, rule]. */
const REFUSED: ReadonlyArray<readonly [string, string, string, string]> = [
  ["the work's total", "本剧共三集。", "frozen_conflict", "episode_count"],
  ["the work cut to three", "计划将本剧缩至三集。", "frozen_conflict", "episode_count"],
  ["a total with no work named", "共 3 集，层层反转。", "frozen_conflict", "episode_count"],
  ["a total with no work named, in Chinese numerals", "一共三集，层层反转。", "frozen_conflict", "episode_count"],
  ["a count a making verb takes", "只写三集，层层反转。", "frozen_conflict", "episode_count"],
  ["an adjustment elsewhere, then the work cut", "把试读时间延长到三天并将本剧缩至三集。", "frozen_conflict", "episode_count"],
  ["a viewing habit", "观众通常观看三集后退出。", "market_statistic", "viewing_count"],
  ["a measured average", "调查显示观众平均观看三集。", "result_claim", "measured_result"],
  ["viewers leaving after a local count", "观众每三集就会弃剧。", "market_statistic", "viewing_count"],
  ["a local structure as an unmarked audience finding", "观众喜欢本剧每三集一个小高潮的节奏。", "market_statistic", "viewing_count"],
  ["a local range of zero", "用前零集建立主角与对手的冲突。", "frozen_conflict", "episode_range_out_of_range"],
  ["a period of zero", "每零集推进一个阶段目标。", "frozen_conflict", "episode_range_out_of_range"],
  ["a local range past the work", "用前六十一集建立主角与对手的冲突。", "frozen_conflict", "episode_range_out_of_range"],
  ["a period past the work", "每六十一集推进一个阶段目标。", "frozen_conflict", "episode_range_out_of_range"],
  ["a position past the work", "第六十一集揭开反派身份。", "frozen_conflict", "episode_range_out_of_range"],
  ["a position past the work, digits", "第61集揭开反派身份。", "frozen_conflict", "episode_range_out_of_range"],
  ["a position past the work, full-width digits", "第６１集揭开反派身份。", "frozen_conflict", "episode_range_out_of_range"],
  ["a position of zero", "第零集揭开反派身份。", "frozen_conflict", "episode_range_out_of_range"],
  ["a legal position, then one past the work", "第三集让主角反击，第六十一集揭开反派身份。", "frozen_conflict", "episode_range_out_of_range"],
  ["an unplaced count past the work", "六十一集一个反转。", "frozen_conflict", "episode_count"],
  // A verification plan's own scope is a howToVerify's only: elsewhere a reading or a viewing takes the count as before.
  ["a reading plan outside howToVerify", "计划试读前三集并收集反馈。", "frozen_conflict", "episode_count"],
  ["viewers asked to read outside howToVerify", "计划邀请观众试读前三集并收集反馈。", "market_statistic", "viewing_count"],
  ["a made count outside howToVerify", "计划制作三集再收集试看反馈。", "frozen_conflict", "episode_count"],
  ["testers watching outside howToVerify", "计划请试看者看完前三集再收集反馈。", "market_statistic", "viewing_count"],
  // A legal local design or a notice, then a statistic, a result or a total conflict.
  // The sentence names viewers and marks nothing pending: the count is read as before (no unmarked judgement is eased).
  ["a local design, then a share", "本剧每三集设置一个小高潮，七成观众会喜欢。", "market_statistic", "viewing_count"],
  ["a local design, then a share in the next sentence", "本剧每三集设置一个小高潮。七成观众会喜欢。", "market_statistic", "proportion"],
  ["a local design, then a measured result", "用前三集建立主角与对手的冲突，已测得观众更喜欢反转。", "result_claim", "measured_result"],
  ["a local design, then the work's total", "每六集推进一个阶段目标，本剧共三集。", "frozen_conflict", "episode_count"],
  ["a local design, then the work cut", "每六集推进一个阶段目标，计划将本剧缩至三集。", "frozen_conflict", "episode_count"],
  ["a local design, then a viewing habit in the next sentence", "本剧每三集设置一个小高潮。观众通常观看三集后退出。", "market_statistic", "viewing_count"],
  ["a notice, then a share in the next sentence", "三集一个反转。七成观众会喜欢。", "market_statistic", "proportion"],
  ["a notice, then the work's total in the next sentence", "三集一个反转。本剧共三集。", "frozen_conflict", "episode_count"],
];

describe("A. the work's own design: a count or position of episodes by its scope (classifier)", () => {
  it.each([...LOCAL, ...LOCAL_MORE])("a local structure within the work passes as written, no notice: %s", (text) => {
    expect(design(text)).toEqual({ refusal: null, unverified: [] });
  });

  it.each(UNCONFIRMED)("a count the code cannot place is kept with an episode-scope notice: %s", (text) => {
    expect(design(text)).toEqual({ refusal: null, unverified: [expect.objectContaining({ semantic: "unclassified", rule: "episode_scope_unconfirmed", token: "三集" })] });
  });

  it.each(REFUSED)("%s is refused: %s", (_label, text, semantic, rule) => {
    expect(design(text).refusal).toMatchObject({ semantic, rule });
  });

  it("the bounds follow the run's frozen episodes, not 60", () => {
    // Three episodes.
    for (const text of ["用前两集建立主角与对手的冲突。", "每两集推进一个阶段目标。", "第三集让主角反击。", "本剧共三集。", "用前三集建立冲突。"]) {
      expect(design(text, 3), text).toEqual({ refusal: null, unverified: [] });
    }
    expect(design("每六集推进一个阶段目标。", 3).refusal).toMatchObject({ semantic: "frozen_conflict", rule: "episode_range_out_of_range" });
    expect(design("第四集揭开反派身份。", 3).refusal).toMatchObject({ semantic: "frozen_conflict", rule: "episode_range_out_of_range" });
    expect(design("本剧共两集。", 3).refusal).toMatchObject({ semantic: "frozen_conflict", rule: "episode_count" });
    expect(design("两集一个反转。", 3)).toEqual({ refusal: null, unverified: [expect.objectContaining({ rule: "episode_scope_unconfirmed" })] });
    // One episode.
    expect(design("第一集揭开反派身份。", 1)).toEqual({ refusal: null, unverified: [] });
    for (const text of ["用前三集建立主角与对手的冲突。", "本剧每三集设置一个小高潮。", "第三集让主角第一次主动反击。", "第2集揭开反派身份。"]) {
      expect(design(text, 1).refusal, text).toMatchObject({ semantic: "frozen_conflict", rule: "episode_range_out_of_range" });
    }
    expect(design("两集一个反转。", 1).refusal).toMatchObject({ semantic: "frozen_conflict", rule: "episode_count" });
  });

  it("without the design reading (an audience) nothing changes", () => {
    expect(uncitedNumberReading(LOCAL[0]!, frameOf(EPISODES), { market: true }).refusal).toMatchObject({ semantic: "market_statistic", rule: "viewing_count" });
    expect(uncitedNumberReading(LOCAL[1]!, frameOf(EPISODES)).refusal).toMatchObject({ semantic: "frozen_conflict", rule: "episode_count" });
    expect(uncitedNumberReading("第61集揭开反派身份。", frameOf(EPISODES)).refusal).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The whole research stage: limited and sourced runs, and a series through seriesAutoInput.

/** A note whose passage the catalog cuts: a craft passage, and one carrying a share (no exemption for the application). */
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
interface Path { name: string; mode: "limited" | "sourced"; context: () => AutoCreationContext; check: (content: string) => Checked }

function paths(episodeCount = EPISODES): Path[] {
  const run = input(episodeCount);
  const series = seriesInput(episodeCount);
  const borrowed = seriesAutoInput(series, { providerKey: "deepseek", model: "m", maxOutputTokens: 4096 });
  return [
    { name: "limited", mode: "limited", context: () => limitedContext(run), check: (content) => validateAutoStageOutput("research", content, run, limitedContext(run)) as Checked },
    { name: "sourced", mode: "sourced", context: () => sourcedContext(run), check: (content) => validateAutoStageOutput("research", content, run, sourcedContext(run)) as Checked },
    { name: `series (${String(episodeCount)} episodes)`, mode: "limited", context: () => limitedContext(borrowed), check: (content) => {
      expect(borrowed.episodeCount).toBe(episodeCount);
      const context: SeriesContext = { input: series, auto: limitedContext(borrowed), outlines: new Map(), episodes: new Map(), stageHashes: new Map() };
      return validateSeriesStageOutput("research", content, series, context, borrowed) as unknown as Checked;
    } },
  ];
}

interface Parts { pattern?: string; why?: string; referenceId?: string | null; statement?: string; howToVerify?: string; opportunity?: string }
const FIFTH = 4;

/** A research answer whose fifth structure (index 4, as in the real refused field) and first hypothesis carry the texts. */
function answer(mode: "limited" | "sourced", parts: Parts): string {
  const creative = {
    hypotheses: [
      { id: "H1", statement: parts.statement ?? "合成样本：开场就让主角做出冒险选择，可能更容易让观众代入。", howToVerify: parts.howToVerify ?? "计划请试看者复述主角的选择和动机。" },
    ],
    contentStructure: [
      ...["主角主动选择推动结果", "反派动机逐步揭开", "误会在结尾解开", "小人物完成一次反击"]
        .map((pattern) => ({ referenceId: null, application: { pattern, why: "自主创作设计。" } })),
      { referenceId: parts.referenceId ?? null, application: { pattern: parts.pattern ?? "主角主动选择推动结果", why: parts.why ?? "自主创作设计。" } },
    ],
    opportunities: [parts.opportunity ?? "小人物在一个夜晚完成一次反击"],
  };
  const audience = { primary: "在通勤和睡前刷短剧的成年观众（待验证假设）", viewingNeeds: ["一集内看到结果"], emotionalAppeals: ["扳回一局"] };
  return JSON.stringify(mode === "limited"
    ? { schema: AUTO_CREATION_RESEARCH_ANSWER_SCHEMA, ...creative, audience }
    : { schema: AUTO_CREATION_RESEARCH_ANSWER_SCHEMA, facts: [], observations: [], ...creative, audience: { ...audience, basis: "hypothesis", sourceIds: [] } });
}

/** A catalog id of the path's own catalog: the passage carrying the share, so a cited method is seen to exempt nothing. */
const catalogId = (path: Path) => {
  const entries = path.context().referenceCatalog!.entries;
  expect(entries.length).toBeGreaterThan(0);
  return (entries.find((entry) => entry.quote.includes("七成")) ?? entries[0]!).referenceId;
};

const APPLICATION = `contentStructure[${String(FIFTH)}].application`;

describe("B. the whole research stage (validateAutoStageOutput, and the series' borrowed research)", () => {
  describe.each(paths().map((path) => [path.name, path] as const))("%s", (_name, path) => {
    const { mode, check } = path;
    const refs = () => [null, catalogId(path)] as const;

    it.each(LOCAL)("a local design passes in application.pattern and .why, with or without a method, as written, no notice: %s", (text) => {
      for (const referenceId of refs()) {
        for (const field of ["pattern", "why"] as const) {
          const result = check(answer(mode, { [field]: text, referenceId }));
          expect(result, `${field} ${String(referenceId)}`).toMatchObject({ ok: true });
          expect(result.output!.contentStructure[FIFTH]!.application[field]).toBe(text);
          expect(result.output!.unverified).toEqual([]);
          expect(result.output!.serverRecord.executedWith).toMatchObject({ checksVersion: "ads.auto-creation.checks.v13", promptVersion: "ads.auto-creation.prompt.v10" });
          expect(result.output!.serverRecord.settings.items.find((item) => item.key === "episodes")?.value).toBe(`共 ${String(EPISODES)} 集`);
        }
      }
    });

    it.each(LOCAL)("a local design passes in a hypothesis, its plan and an opportunity: %s", (text) => {
      for (const parts of [{ statement: text }, { howToVerify: text }, { opportunity: text }]) {
        const result = check(answer(mode, parts));
        expect(result, JSON.stringify(parts)).toMatchObject({ ok: true });
        expect(result.output!.unverified).toEqual([]);
      }
    });

    it("a count the code cannot place is kept in application with a notice on its own field", () => {
      for (const referenceId of refs()) {
        const result = check(answer(mode, { pattern: UNCONFIRMED[0], referenceId }));
        expect(result).toMatchObject({ ok: true });
        expect(result.output!.contentStructure[FIFTH]!.application.pattern).toBe(UNCONFIRMED[0]);
        expect(result.output!.unverified).toEqual([{ origin: "server_check", field: `${APPLICATION}.pattern`, token: "三集", semantic: "unclassified",
          rule: "episode_scope_unconfirmed", note: AUTO_UNVERIFIED_EPISODE_SCOPE_NOTE }]);
      }
    });

    it.each(REFUSED)("%s in application is refused whole, with or without a method: %s", (_label, text, semantic, rule) => {
      for (const referenceId of refs()) {
        for (const field of ["pattern", "why"] as const) {
          const result = check(answer(mode, { [field]: text, referenceId }));
          expect(result, `${field} ${String(referenceId)}`).toMatchObject({ ok: false, field: `${APPLICATION}.${field}`, semantic, rule,
            code: semantic === "frozen_conflict" ? "constraint_violation" : "unsourced_number" });
          expect(result).not.toHaveProperty("output");
        }
      }
    });

    it("a position past the work is refused in a hypothesis and an opportunity too; a sample past it in a plan keeps sample_out_of_range", () => {
      expect(check(answer(mode, { statement: "第六十一集揭开反派身份。" })))
        .toMatchObject({ ok: false, code: "constraint_violation", field: "hypotheses[0].statement", semantic: "frozen_conflict", rule: "episode_range_out_of_range" });
      expect(check(answer(mode, { opportunity: "第61集揭开反派身份" })))
        .toMatchObject({ ok: false, code: "constraint_violation", field: "opportunities[0]", semantic: "frozen_conflict", rule: "episode_range_out_of_range" });
      expect(check(answer(mode, { howToVerify: "计划试读第六十一集并收集反馈。" })))
        .toMatchObject({ ok: false, field: "hypotheses[0].howToVerify", semantic: "frozen_conflict", rule: "sample_out_of_range" });
      expect(check(answer(mode, { howToVerify: "第六十一集揭开反派身份后，计划请试看者复述动机。" })))
        .toMatchObject({ ok: false, field: "hypotheses[0].howToVerify", semantic: "frozen_conflict", rule: "episode_range_out_of_range" });
    });

    it("a verification plan's own scope stays in howToVerify: a hypothesis and an opportunity read a reading plan as before", () => {
      expect(check(answer(mode, { statement: "计划试读前三集并收集反馈。" })))
        .toMatchObject({ ok: false, field: "hypotheses[0].statement", semantic: "frozen_conflict", rule: "episode_count" });
      expect(check(answer(mode, { opportunity: "计划制作三集再收集试看反馈。" })))
        .toMatchObject({ ok: false, field: "opportunities[0]", semantic: "frozen_conflict", rule: "episode_count" });
      const plan = check(answer(mode, { howToVerify: "计划试读前三集并收集反馈。" }));
      expect(plan).toMatchObject({ ok: true });
      expect(plan.output!.unverified).toEqual([]);
    });

    it("a method cited for the structure exempts none of its statistics", () => {
      const result = check(answer(mode, { pattern: "七成观众喜欢每三集一个小高潮的节奏。", referenceId: catalogId(path) }));
      expect(result).toMatchObject({ ok: false, field: `${APPLICATION}.pattern`, semantic: "market_statistic", rule: "proportion" });
    });

    it("a notice does not end the reading: a later field is still refused", () => {
      expect(check(answer(mode, { pattern: UNCONFIRMED[0], opportunity: "本剧共三集" })))
        .toMatchObject({ ok: false, field: "opportunities[0]", semantic: "frozen_conflict", rule: "episode_count" });
      expect(check(answer(mode, { pattern: LOCAL[0], statement: "合成样本：七成观众更喜欢反转。" })))
        .toMatchObject({ ok: false, field: "hypotheses[0].statement", semantic: "market_statistic", rule: "proportion" });
    });
  });

  describe.each([1, 3])("%i episodes frozen: the bounds follow the run", (episodeCount) => {
    it.each(paths(episodeCount).map((path) => [path.name, path] as const))("%s", (_name, path) => {
      const within = episodeCount === 3 ? "用前两集建立主角与对手的冲突。" : "第一集揭开反派身份。";
      const ok = path.check(answer(path.mode, { pattern: within }));
      expect(ok).toMatchObject({ ok: true });
      expect(ok.output!.unverified).toEqual([]);
      expect(ok.output!.serverRecord.settings.items.find((item) => item.key === "episodes")?.value).toBe(`共 ${String(episodeCount)} 集`);
      for (const text of ["每六集推进一个阶段目标。", "第四集揭开反派身份。"]) {
        expect(path.check(answer(path.mode, { pattern: text })), text)
          .toMatchObject({ ok: false, field: `${APPLICATION}.pattern`, semantic: "frozen_conflict", rule: "episode_range_out_of_range" });
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A direction's notes read the work's own design the same way; its audience fit stays a judgement about viewers.

describe("C. a direction's differentiation and difficulty note", () => {
  const stage = (stageKey: string, ordinal: number, output: unknown): AutoStageRecord => ({ runId: "r", stageKey, ordinal, state: "completed", attemptNo: 1,
    errorCode: null, output: output as AutoStageRecord["output"], outputHash: "h", dependsOn: null, scriptSave: null, scriptRevisionId: null, updatedAt: NOW });
  const research = () => (validateAutoStageOutput("research", answer("limited", { why: UNCONFIRMED[1] }), input(), limitedContext()) as { output: AutoResearch }).output;
  const directions = (fields: Record<string, string>) => JSON.stringify({
    schema: AUTO_CREATION_DIRECTIONS_SCHEMA,
    candidates: ["D1", "D2"].map((id) => ({
      id, title: id, logline: `${id}：骑手被扣了三个月工资，要在午夜前讨回`, protagonist: "p", goal: "g", obstacle: "o", stakes: "s", coreEmotion: "e",
      differentiation: "用两次反转代替常见的三角恋", productionDifficulty: "low", difficultyNote: "只需两处室内场景", audienceFit: "可能契合想看小人物扳回一局的观众，待验证（H1）",
      evidenceIds: ["H1"], ratings: { audienceFit: 4, conflictStrength: 4, originality: 4, feasibility: 4, constraintFit: 4 }, ...(id === "D1" ? fields : {}),
    })),
  });
  const check = (fields: Record<string, string>) => validateAutoStageOutput("directions", directions(fields), input(), { ...limitedContext(), research: research() }) as
    { ok: boolean; output?: AutoDirections } & Record<string, unknown>;

  it.each(LOCAL)("a local design passes in both notes, no notice: %s", (text) => {
    for (const key of ["differentiation", "difficultyNote"]) {
      const result = check({ [key]: text });
      expect(result, key).toMatchObject({ ok: true });
      expect(result.output!.unverified).toEqual([]);
    }
  });

  it("a count the code cannot place is a notice on the note; a range or position past the work is refused", () => {
    const kept = check({ difficultyNote: UNCONFIRMED[0]! });
    expect(kept).toMatchObject({ ok: true });
    expect(kept.output!.unverified).toEqual([{ origin: "server_check", field: "candidates[0].difficultyNote", token: "三集", semantic: "unclassified",
      rule: "episode_scope_unconfirmed", note: AUTO_UNVERIFIED_EPISODE_SCOPE_NOTE }]);
    expect(check({ differentiation: "第61集揭开反派身份" }))
      .toMatchObject({ ok: false, field: "candidates[0].differentiation", semantic: "frozen_conflict", rule: "episode_range_out_of_range" });
    expect(check({ difficultyNote: "每六十一集推进一个阶段目标" }))
      .toMatchObject({ ok: false, field: "candidates[0].difficultyNote", semantic: "frozen_conflict", rule: "episode_range_out_of_range" });
    expect(check({ differentiation: "本剧共三集" })).toMatchObject({ ok: false, field: "candidates[0].differentiation", semantic: "frozen_conflict", rule: "episode_count" });
  });

  it("the audience fit gets no design reading", () => {
    expect(check({ audienceFit: "可能契合喜欢本剧每三集一个小高潮的观众，待验证（H1）" }))
      .toMatchObject({ ok: false, field: "candidates[0].audienceFit", semantic: "market_statistic", rule: "viewing_count" });
  });

  it("the research notice reaches the directions prompt; a direction's notice is in the package's Markdown and JSON", () => {
    const stored = research();
    expect(stored.unverified).toEqual([expect.objectContaining({ field: `${APPLICATION}.why`, rule: "episode_scope_unconfirmed" })]);
    const sources = collectSources(input(), [], NOW);
    const prompt = buildAutoCreationPrompt("directions", input(), autoContextFromStages([stage("sources", 0, sources), stage("research", 1, stored)])).user;
    expect(prompt).toContain("「三集」：程序无法确认集数描述的作用范围，未核实；");
    expect(prompt).not.toContain("程序无法确认时长含义");
    const chosen = check({ difficultyNote: UNCONFIRMED[0]! }).output!;
    const stages = [stage("sources", 0, sources), stage("research", 1, stored), stage("directions", 2, chosen)];
    const meta = { runId: "r", projectId: "p", input: input(), quality: "pending", state: "running", callsUsed: 2, callCap: 6, revisionRoundsUsed: 0,
      storySave: "pending", generatedAt: NOW } as const;
    const markdown = autoPackageMarkdown(meta, stages);
    expect(markdown).toContain(`本剧应用设计：主角主动选择推动结果：${UNCONFIRMED[1]!}`);
    expect(markdown).toContain("程序无法确认集数描述的作用范围，未核实");
    expect(markdown).not.toContain("程序无法确认时长含义");
    const json = autoPackageJson(meta, stages) as { research: { analysis: AutoResearch } };
    expect(json.research.analysis.unverified).toEqual(stored.unverified);
    expect(JSON.stringify(json)).toContain(UNCONFIRMED[0]!);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The work's total restated at its frozen value in a pending audience question (checks v12, before release). On 0388d04
// a total wording (本剧共N集) refused its count as a frozen conflict whatever its value: in a clause about viewers the
// frozen count is not removed before reading, so 待验证观众是否喜欢本剧共N集的体量 was refused as frozen_conflict +
// episode_count on all three paths for N = 1, 3, 60. Synthetic samples, not a real refused answer.

const restated = (n: number) => `待验证观众是否喜欢本剧共${String(n)}集的体量。`;
/** The same value, read for what it counts: a viewing statistic, a habit, a result or an unmarked finding. [label, text, semantic, rule]. */
const sameValueRefused = (n: number): ReadonlyArray<readonly [string, string, string, string]> => [
  ["a viewing habit", `观众通常观看${String(n)}集后退出。`, "market_statistic", "viewing_count"],
  ["a measured average", `调查显示观众平均观看${String(n)}集。`, "result_claim", "measured_result"],
  ["a pending question about watching the whole total", `待验证观众是否会看完本剧共${String(n)}集。`, "market_statistic", "viewing_count"],
  ["a pending question about leaving after the total", `待验证观众是否会在本剧${String(n)}集后弃剧。`, "market_statistic", "viewing_count"],
  ["a measured result about the total", `已测得观众看完本剧共${String(n)}集。`, "result_claim", "measured_result"],
  ["an unmarked audience finding about the total", `观众喜欢本剧共${String(n)}集的体量。`, "market_statistic", "viewing_count"],
];

describe("E. the work's total at its frozen value in a pending audience question", () => {
  describe.each([1, 3, 60])("%i episodes frozen", (n) => {
    it("classifier: the restated total passes as written in a design and in a plan; another total is a frozen conflict", () => {
      const frame = frameOf(n);
      for (const options of [{ structureDesign: true }, { structureDesign: true, verificationPlan: true }]) {
        expect(uncitedNumberReading(restated(n), frame, { unverified: true, ...options }), JSON.stringify(options)).toEqual({ refusal: null, unverified: [] });
        expect(uncitedNumberReading(restated(n + 1), frame, { unverified: true, ...options }).refusal, JSON.stringify(options))
          .toMatchObject({ semantic: "frozen_conflict", rule: "episode_count" });
      }
    });

    it.each(sameValueRefused(n))("classifier: %s at the same value is refused as before: %s", (_label, text, semantic, rule) => {
      for (const options of [{ structureDesign: true }, { structureDesign: true, verificationPlan: true }]) {
        expect(uncitedNumberReading(text, frameOf(n), { unverified: true, ...options }).refusal, JSON.stringify(options)).toMatchObject({ semantic, rule });
      }
    });

    describe.each(paths(n).map((path) => [path.name, path] as const))("%s", (_name, path) => {
      it("the restated total passes in application (with or without a method) and howToVerify, kept as written, no notice", () => {
        for (const parts of [{ pattern: restated(n) }, { why: restated(n), referenceId: catalogId(path) }, { howToVerify: restated(n) }, { opportunity: restated(n) }]) {
          const result = path.check(answer(path.mode, parts));
          expect(result, JSON.stringify(parts)).toMatchObject({ ok: true });
          expect(result.output!.unverified).toEqual([]);
        }
        const output = path.check(answer(path.mode, { pattern: restated(n), howToVerify: restated(n) })).output!;
        expect(output.contentStructure[FIFTH]!.application.pattern).toBe(restated(n));
        expect(output.hypotheses[0]!.howToVerify).toBe(restated(n));
        expect(output.serverRecord.settings.items.find((item) => item.key === "episodes")?.value).toBe(`共 ${String(n)} 集`);
      });

      it("another total is refused in application and howToVerify", () => {
        expect(path.check(answer(path.mode, { pattern: restated(n + 1) })))
          .toMatchObject({ ok: false, code: "constraint_violation", field: `${APPLICATION}.pattern`, semantic: "frozen_conflict", rule: "episode_count" });
        expect(path.check(answer(path.mode, { howToVerify: restated(n + 1) })))
          .toMatchObject({ ok: false, code: "constraint_violation", field: "hypotheses[0].howToVerify", semantic: "frozen_conflict", rule: "episode_count" });
      });

      it("the same value counting a viewing, a habit, a result or an unmarked finding is refused in application and howToVerify", () => {
        for (const [label, text, semantic, rule] of sameValueRefused(n)) {
          expect(path.check(answer(path.mode, { pattern: text })), label).toMatchObject({ ok: false, field: `${APPLICATION}.pattern`, semantic, rule });
          expect(path.check(answer(path.mode, { howToVerify: text })), label).toMatchObject({ ok: false, field: "hypotheses[0].howToVerify", semantic, rule });
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Review of eeac41c (checks v12, before release; synthetic samples, not a real refused answer). With 60 episodes frozen,
// a total the work's own words take (总集数为三集, 本剧设计为三集, 全剧分三集) was kept with an episode-scope notice, and a
// verification activity already done (已完成前三集的试读, 曾用前三集样稿进行试读) passed a howToVerify as a local range: the
// plan's own rule refuses it, and the design reading after it let it back in. On 12951c8 all five were refused.

/** A total of the work its own words take, at another value than the frozen one. */
const WORK_TOTALS = ["总集数为三集。", "本剧设计为三集。", "全剧分三集。"];
/** A verification activity already done over a local range. */
const DONE_ACTIVITIES = ["已完成前三集的试读。", "曾用前三集样稿进行试读。"];

describe("F. a total the work's words take, and an activity already done, are no local design", () => {
  it.each(WORK_TOTALS)("classifier: %s is a frozen conflict in a design and in a plan", (text) => {
    for (const options of [{ structureDesign: true }, { structureDesign: true, verificationPlan: true }]) {
      expect(uncitedNumberReading(text, frameOf(EPISODES), { unverified: true, ...options }), JSON.stringify(options))
        .toEqual({ refusal: expect.objectContaining({ semantic: "frozen_conflict", rule: "episode_count" }), unverified: [] });
    }
  });

  it.each(DONE_ACTIVITIES)("classifier: %s is refused as before, in a plan and elsewhere", (text) => {
    for (const options of [{ structureDesign: true }, { structureDesign: true, verificationPlan: true }]) {
      expect(uncitedNumberReading(text, frameOf(EPISODES), { unverified: true, ...options }), JSON.stringify(options))
        .toEqual({ refusal: expect.objectContaining({ semantic: "frozen_conflict", rule: "episode_count" }), unverified: [] });
    }
  });

  it("classifier: the bounds follow the run; a local range written with 设计 stays local; the frozen total restated still passes", () => {
    const read = (text: string, n: number, plan = false) => uncitedNumberReading(text, frameOf(n), { unverified: true, structureDesign: true, verificationPlan: plan });
    for (const plan of [false, true]) {
      expect(read("本剧设计为两集。", 3, plan).refusal).toMatchObject({ semantic: "frozen_conflict", rule: "episode_count" });
      expect(read("全剧分三集。", 1, plan).refusal).toMatchObject({ semantic: "frozen_conflict", rule: "episode_count" });
      expect(read("总集数为两集。", 1, plan).refusal).toMatchObject({ semantic: "frozen_conflict", rule: "episode_count" });
      for (const [text, n] of [["全剧分三集。", 3], ["本剧设计为六十集。", 60], ["总集数为1集。", 1]] as const) {
        expect(read(text, n, plan), `${text} ${String(n)}`).toEqual({ refusal: null, unverified: [] });
      }
      for (const n of [1, 3, 60]) {
        expect(read(`待验证观众是否喜欢总集数为${String(n)}集的安排。`, n, plan), String(n)).toEqual({ refusal: null, unverified: [] });
        expect(read(`待验证观众是否喜欢总集数为${String(n + 1)}集的安排。`, n, plan).refusal).toMatchObject({ semantic: "frozen_conflict", rule: "episode_count" });
      }
      for (const text of ["前三集的设计围绕主角的处境。", "本剧前三集设计为铺垫。", "用前三集建立主角与对手的冲突。"]) {
        expect(read(text, EPISODES, plan), text).toEqual({ refusal: null, unverified: [] });
      }
    }
    expect(read("计划试读前三集并收集反馈。", EPISODES, true)).toEqual({ refusal: null, unverified: [] });
  });

  describe.each(paths().map((path) => [path.name, path] as const))("%s", (_name, path) => {
    it("a total the work's words take is refused in application (with or without a method), howToVerify and an opportunity", () => {
      for (const text of WORK_TOTALS) {
        for (const [parts, field] of [[{ pattern: text }, `${APPLICATION}.pattern`], [{ why: text, referenceId: catalogId(path) }, `${APPLICATION}.why`],
          [{ howToVerify: text }, "hypotheses[0].howToVerify"], [{ opportunity: text }, "opportunities[0]"]] as const) {
          expect(path.check(answer(path.mode, parts)), `${text} ${field}`)
            .toMatchObject({ ok: false, code: "constraint_violation", field, semantic: "frozen_conflict", rule: "episode_count" });
        }
      }
    });

    it("an activity already done is refused in howToVerify and in a hypothesis; a future reading and a local design still pass", () => {
      for (const text of DONE_ACTIVITIES) {
        expect(path.check(answer(path.mode, { howToVerify: text })), text)
          .toMatchObject({ ok: false, code: "constraint_violation", field: "hypotheses[0].howToVerify", semantic: "frozen_conflict", rule: "episode_count" });
        expect(path.check(answer(path.mode, { statement: text })), text)
          .toMatchObject({ ok: false, code: "constraint_violation", field: "hypotheses[0].statement", semantic: "frozen_conflict", rule: "episode_count" });
      }
      for (const parts of [{ howToVerify: "计划试读前三集并收集反馈。" }, { howToVerify: LOCAL[1]! }, { pattern: LOCAL[1]! }, { pattern: "前三集的设计围绕主角的处境。" }]) {
        const result = path.check(answer(path.mode, parts));
        expect(result, JSON.stringify(parts)).toMatchObject({ ok: true });
        expect(result.output!.unverified).toEqual([]);
      }
    });

    it("a legal local design is followed by a refused total in a later field: the answer is refused whole", () => {
      expect(path.check(answer(path.mode, { pattern: LOCAL[1]!, opportunity: WORK_TOTALS[0]! })))
        .toMatchObject({ ok: false, field: "opportunities[0]", semantic: "frozen_conflict", rule: "episode_count" });
      expect(path.check(answer(path.mode, { pattern: UNCONFIRMED[0]!, howToVerify: DONE_ACTIVITIES[0]! })))
        .toMatchObject({ ok: false, field: "hypotheses[0].howToVerify", semantic: "frozen_conflict", rule: "episode_count" });
    });
  });
});
