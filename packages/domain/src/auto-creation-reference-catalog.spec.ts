import { describe, expect, it } from "vitest";
import {
  AUTO_CREATION_CHECKS_VERSION,
  AUTO_CREATION_PROMPT_MAX_CHARS,
  AUTO_CREATION_PROMPT_VERSION,
  AUTO_CREATION_RESEARCH_ANSWER_SCHEMA,
  AUTO_CREATION_RESEARCH_SCHEMA,
  AUTO_REFERENCE_CATALOG_MAX_CHARS,
  AUTO_REFERENCE_CATALOG_MAX_ENTRIES,
  AUTO_REFERENCE_CATALOG_PER_SOURCE,
  AUTO_REFERENCE_CATALOG_VERSION,
  SERIES_RESEARCH_CONTRACT,
  SERIES_WRITING_CHECKS_VERSION,
  SERIES_WRITING_INPUT_SCHEMA,
  SERIES_WRITING_PROMPT_VERSION,
  autoCreationConstraintsSchema,
  autoCreationJsonSchema,
  type AutoCreationFrozenInput,
  type AutoCreationMaterial,
  type AutoReferenceCatalog,
  type AutoResearch,
  type AutoSourcesOutput,
  type AutoStageRecord,
  type SeriesFrozenInput,
  type SeriesStageRecord,
} from "@ai-drama/contracts";
import { autoReferenceCatalog, autoReferenceCatalogOf, quotedWhole, withoutWhitespace } from "./auto-creation-references";
import { AUTO_SOURCE_EXCERPT_MAX, OCEAN_ENGINE_ENTRY_URLS, collectSources } from "./auto-creation-sources";
import {
  AUTO_REFERENCE_CATALOG_BLOCK, autoContextFromStages, buildAutoCreationPrompt, validateAutoStageOutput, type AutoCreationContext,
} from "./auto-creation";
import { buildSeriesPrompt, seriesAutoInput, seriesPlanContext, validateSeriesStageOutput } from "./series-writing";

/**
 * The reference catalog (prompt v9, checks v10): a structure's method is chosen by id from passages the server cut out
 * of the run's saved snapshot; the server fills the quote in, and the quote and application checks run as before.
 * Every text below is a SYNTHETIC sample. The refused real answer (evidence_not_in_source@contentStructure[2].reference.quote)
 * was never kept: nothing here reproduces or claims to know its sentence.
 */

const NOW = "2026-10-26T00:00:00.000Z";
const CRAFT_SENTENCE = "关键结果来自主角的选择和行动，不靠旁人突然解围。";

function input(overrides: Partial<AutoCreationFrozenInput> = {}): AutoCreationFrozenInput {
  return {
    schema: "ads.auto-creation.input.v1", promptVersion: AUTO_CREATION_PROMPT_VERSION, selectionRules: "ads.auto-creation.selection-rules.v1",
    checksVersion: AUTO_CREATION_CHECKS_VERSION, idea: "", constraints: autoCreationConstraintsSchema.parse({}), materials: [], referenceUrls: [],
    researchFetch: false, episodeCount: 1, episodeSeconds: 60, revisionRounds: 0, callBudget: 6, maxOutputTokens: 4096, providerKey: "deepseek",
    model: "m", authorization: { mode: "auto", proof: "site_session", initiatedBy: "a", executor: "auto-creation-engine" }, ...overrides,
  };
}

const notes = (text: string, title = "拍摄笔记"): AutoCreationMaterial => ({ title, kind: "notes", text, rightsConfirmed: true });
const MARKET = { url: OCEAN_ENGINE_ENTRY_URLS[0], status: "read" as const, title: "合成市场样本页", text: "合成样本：本页只描述题材趋势，没有统计数字。",
  publishedAt: "2026-09-01T00:00:00.000Z", fetchedAt: NOW, note: "合成样本" };

const stage = (stageKey: string, ordinal: number, output: unknown): AutoStageRecord => ({ runId: "r", stageKey, ordinal, state: "completed", attemptNo: 1,
  errorCode: null, output: output as AutoStageRecord["output"], outputHash: "h", dependsOn: null, scriptSave: null, scriptRevisionId: null, updatedAt: NOW });
/** The context the engine builds: from the stored stages, the catalog cut once with it. */
const contextOf = (sources: AutoSourcesOutput): AutoCreationContext => autoContextFromStages([stage("sources", 0, sources)]);

describe("A. the catalog is cut from the saved snapshot only, the same every time", () => {
  it("the same snapshot gives the same entries, order, ids and hash; a copy of it too", () => {
    const sources = collectSources(input({ materials: [notes("主角每一场都要主动出手。反派从不解释动机。")] }), [MARKET], NOW);
    const first = autoReferenceCatalog(sources);
    expect(autoReferenceCatalog(structuredClone(sources))).toEqual(first);
    expect(autoReferenceCatalog(sources)).toEqual(first);
    expect(first.version).toBe(AUTO_REFERENCE_CATALOG_VERSION);
    expect(new Set(first.entries.map((entry) => entry.referenceId)).size).toBe(first.entries.length);
    // Snapshot order, then excerpt order: the market page, the craft entry, the person's notes.
    expect([...new Set(first.entries.map((entry) => entry.sourceId))]).toEqual(["S-OE-1", "S-KB-CRAFT", "S-USER-1"]);
  });

  it("only readable sources give passages: unread, blocked and login pages give none, nor anything outside the snapshot", () => {
    const sources = collectSources(input(), [{ ...MARKET, status: "login_required", text: "" }], NOW);
    const catalog = autoReferenceCatalog(sources);
    expect(catalog.entries.every((entry) => entry.sourceId === "S-KB-CRAFT")).toBe(true);
    // An excerpt left on an unread entry is still no passage.
    const forged: AutoSourcesOutput = { ...sources, sources: sources.sources.map((source) => source.sourceId === "S-OE-2"
      ? { ...source, excerpt: "未读条目里不该出现的句子，绝不能进入目录。" } : source) };
    expect(autoReferenceCatalog(forged).entries.map((entry) => entry.quote)).not.toContain("未读条目里不该出现的句子，绝不能进入目录。");
  });

  it("each entry is one whole sentence or line of its own source, verbatim: never joined across sources or places, never cutting a number", () => {
    const text = "全片一百八十个镜头要在三天内拍完。\n共180个镜头\n七成观众爱看复仇。前二十一次反转都失败了，主角只能靠自己！约1,800人观看了试映；";
    const sources = collectSources(input({ materials: [notes(text)] }), [], NOW);
    const catalog = autoReferenceCatalog(sources);
    const user = catalog.entries.filter((entry) => entry.sourceId === "S-USER-1").map((entry) => entry.quote);
    expect(user).toEqual(["全片一百八十个镜头要在三天内拍完。", "共180个镜头", "七成观众爱看复仇。", "前二十一次反转都失败了，主角只能靠自己！", "约1,800人观看了试映；"]);
    for (const entry of catalog.entries) {
      const excerpt = sources.sources.find((source) => source.sourceId === entry.sourceId)!.excerpt;
      expect(excerpt).toContain(entry.quote);
      expect(quotedWhole(withoutWhitespace(excerpt), withoutWhitespace(entry.quote))).toBe(true);
    }
  });

  it("a passage too short or too long is skipped, never padded, joined or cut", () => {
    const long = `主角${"一路追查".repeat(20)}。`;
    const sources = collectSources(input({ materials: [notes(`短句。\n${long}\n主角每一场都要主动出手。`)] }), [], NOW);
    expect(autoReferenceCatalog(sources).entries.filter((entry) => entry.sourceId === "S-USER-1").map((entry) => entry.quote)).toEqual(["主角每一场都要主动出手。"]);
  });

  it("an excerpt cut at its length limit gives no last passage unless a sentence end closes it", () => {
    const sentence = "主角每一场都要主动出手。";
    const text = sentence.repeat(Math.ceil(AUTO_SOURCE_EXCERPT_MAX / sentence.length)) + "尾句被截断在共18";
    const sources = collectSources(input({ materials: [notes(`${text}0个镜头。`)] }), [], NOW);
    const excerpt = sources.sources.find((source) => source.sourceId === "S-USER-1")!.excerpt;
    expect(excerpt.length).toBe(AUTO_SOURCE_EXCERPT_MAX);
    expect(autoReferenceCatalog(sources).entries.every((entry) => entry.quote === sentence || entry.sourceId !== "S-USER-1")).toBe(true);
  });

  it("at most eight from one source and twenty-four in all; at the character limit whole entries are left out, never a quote cut", () => {
    const many = (prefix: string) => Array.from({ length: 12 }, (_, index) => `${prefix}第${"一二三四五六七八九十"[index % 10]!}场主角都要主动出手${String.fromCharCode(0x4e00 + index)}。`).join("");
    const materials = [notes(many("甲"), "笔记一"), notes(many("乙"), "笔记二"), notes(many("丙"), "笔记三")];
    const catalog = autoReferenceCatalog(collectSources(input({ materials }), [], NOW));
    const counts = new Map<string, number>();
    for (const entry of catalog.entries) counts.set(entry.sourceId, (counts.get(entry.sourceId) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(AUTO_REFERENCE_CATALOG_PER_SOURCE);
    expect(catalog.entries.length).toBeLessThanOrEqual(AUTO_REFERENCE_CATALOG_MAX_ENTRIES);
    expect(JSON.stringify(catalog.entries).length).toBeLessThanOrEqual(AUTO_REFERENCE_CATALOG_MAX_CHARS);
    // Passages near the quote limit: twenty-four of them still fit the character limit (it only ever leaves out whole
    // entries), and every entry kept is whole.
    const longs = (prefix: string) => Array.from({ length: 8 }, (_, index) => `${prefix}${String(index)}：${"主角每一场都主动出手推动结果".repeat(5)}。`).join("");
    const big = autoReferenceCatalog(collectSources(input({ materials: [notes(longs("甲"), "一"), notes(longs("乙"), "二"), notes(longs("丙"), "三")] }), [], NOW));
    expect(JSON.stringify(big.entries).length).toBeLessThanOrEqual(AUTO_REFERENCE_CATALOG_MAX_CHARS);
    expect(big.entries.length).toBe(AUTO_REFERENCE_CATALOG_MAX_ENTRIES);
    expect(big.entries.filter((item) => item.sourceId === "S-KB-CRAFT")).toHaveLength(AUTO_REFERENCE_CATALOG_PER_SOURCE);
    for (const entry of big.entries.filter((item) => item.sourceId.startsWith("S-USER-"))) expect(entry.quote).toMatch(/^[甲乙丙]\d：(主角每一场都主动出手推动结果){5}。$/u);
  });

  it("a snapshot with nothing quotable has a catalog with no entries; an invalid snapshot has none at all", () => {
    const sources: AutoSourcesOutput = { schema: "ads.auto-creation.sources.v1", researchMode: "limited", notes: [], sources: [] };
    expect(autoReferenceCatalogOf(sources)).toMatchObject({ version: AUTO_REFERENCE_CATALOG_VERSION, entries: [] });
    expect(autoReferenceCatalogOf(undefined)).toBeUndefined();
    expect(autoReferenceCatalogOf({ ...sources, researchMode: "other" } as never)).toBeUndefined();
    expect(contextOf(sources).referenceCatalog).toMatchObject({ entries: [] });
    expect("referenceCatalog" in autoContextFromStages([])).toBe(false);
  });
});

describe("B. one catalog builds the prompt, the JSON Schema and the check", () => {
  it.each([["limited", []], ["sourced", [MARKET]]] as const)("%s: the prompt carries exactly the context's catalog, within the prompt limit", (mode, pages) => {
    const context = contextOf(collectSources(input(), [...pages], NOW));
    const prompt = buildAutoCreationPrompt("research", input(), context);
    const block = prompt.user.slice(prompt.user.indexOf(`<<<${AUTO_REFERENCE_CATALOG_BLOCK}\n`) + AUTO_REFERENCE_CATALOG_BLOCK.length + 4);
    expect(JSON.parse(block.slice(0, block.indexOf(`\n${AUTO_REFERENCE_CATALOG_BLOCK}>>>`)))).toEqual(context.referenceCatalog!.entries);
    expect(prompt.user).toContain(`schema 固定为 "${AUTO_CREATION_RESEARCH_ANSWER_SCHEMA}"`);
    expect(prompt.user).toContain("每条只包含 referenceId 和 application 两个字段");
    expect(prompt.user).toContain("不要自己写 reference、sourceId、quote 或摘抄原文");
    expect(prompt.user).not.toContain("quote 从这一条资料的摘录正文里逐字摘");
    expect(prompt.system.length + prompt.user.length).toBeLessThanOrEqual(AUTO_CREATION_PROMPT_MAX_CHARS);
    const ids = ((autoCreationJsonSchema("research", 1, mode, context.referenceCatalog!).schema as { properties: { contentStructure: { items: { properties: {
      referenceId: { anyOf: Array<{ enum?: string[] }> } } } } } }).properties.contentStructure.items.properties.referenceId.anyOf[0]!.enum);
    expect(ids).toEqual(context.referenceCatalog!.entries.map((entry) => entry.referenceId));
  });

  it("an empty catalog: the prompt says null is the only choice", () => {
    const context = contextOf({ schema: "ads.auto-creation.sources.v1", researchMode: "limited", notes: [], sources: [] });
    expect(buildAutoCreationPrompt("research", input(), context).user).toContain("本次可引用方法片段目录为空，每条都只能写 null");
  });

  it("no catalog in the context: no research prompt is built and no answer is checked (the engines stop before reserving)", () => {
    const { referenceCatalog: _catalog, ...bare } = contextOf(collectSources(input(), [], NOW));
    expect(() => buildAutoCreationPrompt("research", input(), bare)).toThrow(/reference catalog/u);
    expect(validateAutoStageOutput("research", "{}", input(), bare)).toEqual({ ok: false, code: "research_sources_missing" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The whole research stage, limited, sourced and a series of 60 episodes.

const EPISODES = 60;
const seriesInput: SeriesFrozenInput = {
  schema: SERIES_WRITING_INPUT_SCHEMA, promptVersion: SERIES_WRITING_PROMPT_VERSION, checksVersion: SERIES_WRITING_CHECKS_VERSION, researchContract: SERIES_RESEARCH_CONTRACT,
  idea: "", constraints: { genre: "", audience: "", maxCharacters: 3, maxLocations: null, forbiddenThemes: [], endingRequirement: "" },
  materials: [], referenceUrls: [], researchFetch: false, episodeCount: EPISODES, episodeSeconds: 60, batchSize: 3, outlineChunk: 6,
};
const autoRun = input({ episodeCount: EPISODES, constraints: autoCreationConstraintsSchema.parse({ maxCharacters: 3 }) });

type Checked = { ok: true; output: AutoResearch } | ({ ok: false } & Record<string, unknown>);
interface Path { label: string; mode: "limited" | "sourced"; catalog: AutoReferenceCatalog; check: (content: string) => Checked }

function paths(): Path[] {
  const limited = contextOf(collectSources(autoRun, [], NOW));
  const sourced = contextOf(collectSources(autoRun, [MARKET], NOW));
  const autoInput = seriesAutoInput(seriesInput, { providerKey: "deepseek", model: "m", maxOutputTokens: 4096 });
  const seriesSources = collectSources(autoInput, [], NOW);
  // The series plan job's context from its stored sources stage, as the series engine builds it.
  const series = seriesPlanContext(seriesInput, [{ runId: "j", stageKey: "sources", ordinal: 0, state: "completed", attemptNo: 0, errorCode: null,
    output: seriesSources as never, outputHash: "h", dependsOn: null, reusedFrom: null, scriptSave: null, scriptRevisionId: null, updatedAt: NOW } satisfies SeriesStageRecord]);
  return [
    { label: "limited", mode: "limited", catalog: limited.referenceCatalog!, check: (content) => validateAutoStageOutput("research", content, autoRun, limited) as Checked },
    { label: "sourced", mode: "sourced", catalog: sourced.referenceCatalog!, check: (content) => validateAutoStageOutput("research", content, autoRun, sourced) as Checked },
    { label: "series (60 episodes)", mode: "limited", catalog: series.auto.referenceCatalog!,
      check: (content) => validateSeriesStageOutput("research", content, seriesInput, series, autoInput) as unknown as Checked },
  ];
}

function answer(mode: "limited" | "sourced", structures: unknown[]): string {
  const creative = {
    schema: AUTO_CREATION_RESEARCH_ANSWER_SCHEMA,
    hypotheses: [{ id: "H1", statement: "合成样本：开场就让主角做出冒险选择，可能更容易让观众代入。", howToVerify: "计划请试看者复述主角的选择和动机。" }],
    contentStructure: structures,
    opportunities: ["小人物在一个夜晚完成一次反击"],
  };
  const audience = { primary: "拟面向通勤时刷剧的成年观众（待验证）", viewingNeeds: ["一集内看到结果"], emotionalAppeals: ["扳回一局"] };
  return JSON.stringify(mode === "limited" ? { ...creative, audience }
    : { ...creative, facts: [], observations: [], audience: { ...audience, basis: "hypothesis", sourceIds: [] } });
}
const application = (pattern = "主角主动选择推动结果。", why = "写作方法。") => ({ pattern, why });

describe("C. limited, sourced and the series' borrowed research: an id maps to the passage word for word", () => {
  for (const path of paths()) {
    const craft = path.catalog.entries.find((entry) => entry.quote === CRAFT_SENTENCE)!;

    it(`${path.label}: a catalog id becomes the passage's source and verbatim quote, null stays null; the rest is stored as research v4`, () => {
      const result = path.check(answer(path.mode, [{ referenceId: craft.referenceId, application: application() },
        { referenceId: null, application: application("三个人物被迫合作。", "自主创作设计。") }]));
      expect(result.ok).toBe(true);
      const research = (result as { output: AutoResearch }).output;
      expect(research.schema).toBe(AUTO_CREATION_RESEARCH_SCHEMA);
      expect(research.contentStructure).toEqual([{ reference: { sourceId: "S-KB-CRAFT", quote: CRAFT_SENTENCE }, application: application() },
        { reference: null, application: application("三个人物被迫合作。", "自主创作设计。") }]);
      expect(JSON.stringify(research)).not.toContain("referenceId");
      expect(research.serverRecord.executedWith).toEqual({ promptVersion: AUTO_CREATION_PROMPT_VERSION, checksVersion: AUTO_CREATION_CHECKS_VERSION,
        researchSchema: AUTO_CREATION_RESEARCH_SCHEMA, answerContract: path.mode, answerSchema: AUTO_CREATION_RESEARCH_ANSWER_SCHEMA,
        referenceCatalogVersion: AUTO_REFERENCE_CATALOG_VERSION, referenceCatalogHash: path.catalog.hash });
    });

    it(`${path.label}: every entry of the catalog is accepted as a method`, () => {
      for (const entry of path.catalog.entries) {
        expect(path.check(answer(path.mode, [{ referenceId: entry.referenceId, application: application() }])), entry.quote).toMatchObject({ ok: true,
          output: { contentStructure: [{ reference: { sourceId: entry.sourceId, quote: entry.quote } }] } });
      }
    });

    it(`${path.label}: an id this catalog lacks refuses the whole answer, never nulled or swapped`, () => {
      const other = autoReferenceCatalog(collectSources(input({ materials: [notes("主角每一场都要主动出手。反派从不解释动机。")] }), [], NOW))
        .entries.find((entry) => entry.sourceId === "S-USER-1")!.referenceId;
      for (const id of [other, "R-0000000000", craft.referenceId.toUpperCase(), ` ${craft.referenceId}`, craft.sourceId]) {
        expect(path.check(answer(path.mode, [{ referenceId: null, application: application() }, { referenceId: id, application: application() }])), id)
          .toEqual({ ok: false, code: "unknown_reference", detail: id, field: "contentStructure[1].referenceId" });
      }
    });

    it(`${path.label}: a model-written reference, source or quote refuses the whole answer, even null`, () => {
      for (const [key, extra] of [["reference", { reference: null }], ["reference", { reference: { sourceId: "S-KB-CRAFT", quote: CRAFT_SENTENCE } }],
        ["sourceId", { sourceId: "S-KB-CRAFT" }], ["quote", { quote: CRAFT_SENTENCE }], ["quote", { quote: null }]] as const) {
        expect(path.check(answer(path.mode, [{ referenceId: craft.referenceId, ...extra, application: application() }])), key)
          .toMatchObject({ ok: false, code: "invalid_output", field: `contentStructure[0].${key}`, category: "unrecognized_keys" });
      }
    });

    it(`${path.label}: a chosen passage sources nothing of the application: a statistic, a settled claim or a frozen conflict is still refused`, () => {
      const cited = (pattern: string) => path.check(answer(path.mode, [{ referenceId: craft.referenceId, application: application(pattern) }]));
      expect(cited("约三成观众偏爱主角主动选择。")).toMatchObject({ ok: false, code: "unsourced_number", semantic: "market_statistic",
        field: "contentStructure[0].application.pattern" });
      expect(cited("调查证明观众更喜欢主角主动选择。")).toMatchObject({ ok: false, code: "unsourced_claim", field: "contentStructure[0].application.pattern" });
      expect(cited("四个人物被迫合作。")).toMatchObject({ ok: false, code: "constraint_violation", rule: "cast_over_limit" });
      expect(cited("共 3 集，层层反转。")).toMatchObject({ ok: false, code: "constraint_violation", rule: "episode_count" });
    });
  }

  it("the series prompt carries the plan job's own catalog", () => {
    const autoInput = seriesAutoInput(seriesInput, { providerKey: "deepseek", model: "m", maxOutputTokens: 4096 });
    const sources = collectSources(autoInput, [], NOW);
    const context = seriesPlanContext(seriesInput, [{ runId: "j", stageKey: "sources", ordinal: 0, state: "completed", attemptNo: 0, errorCode: null,
      output: sources as never, outputHash: "h", dependsOn: null, reusedFrom: null, scriptSave: null, scriptRevisionId: null, updatedAt: NOW }]);
    expect(context.auto.referenceCatalog).toEqual(autoReferenceCatalog(sources));
    expect(buildSeriesPrompt("research", seriesInput, context, autoInput).user).toContain(JSON.stringify(context.auto.referenceCatalog!.entries));
  });
});
