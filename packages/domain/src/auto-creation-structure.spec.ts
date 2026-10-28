import { describe, expect, it } from "vitest";
import {
  AUTO_CREATION_RESEARCH_ANSWER_SCHEMA,
  AUTO_CREATION_RESEARCH_SCHEMA,
  AUTO_CREATION_RESEARCH_SCHEMA_V1,
  AUTO_CREATION_RESEARCH_SCHEMA_V2,
  autoCreationConstraintsSchema,
  type AutoCreationFrozenInput,
  type AutoReferenceCatalog,
  type AutoStageRecord,
  type AutoStoredResearch,
} from "@ai-drama/contracts";
import { autoReferenceCatalog, quotedWhole, withoutWhitespace } from "./auto-creation-references";
import { OCEAN_ENGINE_ENTRY_URLS, collectSources } from "./auto-creation-sources";
import { autoContextFromStages, autoPackageJson, autoPackageMarkdown, buildAutoCreationPrompt, validateAutoStageOutput, type AutoCreationContext } from "./auto-creation";

/**
 * Research v2 (prompt v4, checks v4): a content structure keeps the method it quotes (reference) apart from this work's
 * own design (application). Prompt v9 / checks v10: the model names the method by a catalog id (referenceId) and the
 * server fills the quote in; the quote must still stand whole in the one source it cites, and the application is
 * checked as uncited text whatever it cites, so a reference never sources a story count, a statistic or a settled finding.
 */

const NOW = "2026-10-20T00:00:00.000Z";
/** A sentence of the built-in craft entry, verbatim, as the catalog cuts it. It has no number at all. */
const CRAFT_QUOTE = "关键结果来自主角的选择和行动，不靠旁人突然解围。";
/** A person's own notes with whole numbers and a share in them, read as reference material. */
const NOTES = "全片一百八十个镜头要在三天内拍完，每个镜头都服务冲突。共180个镜头。七成观众爱看复仇。"
  + "这部剧共十一集，每集160秒内必须完成一次反转。前二十一次反转都失败了，主角只能靠自己。"
  + "约1,800人观看了试映。受众为25-35岁的女性。累计10w播放。每集3小时拍完。90后观众偏多。"
  + "受众为25－35岁的女性群体。约1/3观众看完。比例3：1的男女。男女比为3比1的结构，节奏很快。";

function input(overrides: Partial<AutoCreationFrozenInput> = {}): AutoCreationFrozenInput {
  return {
    schema: "ads.auto-creation.input.v1", promptVersion: "ads.auto-creation.prompt.v4", selectionRules: "ads.auto-creation.selection-rules.v1",
    checksVersion: "ads.auto-creation.checks.v4", idea: "", constraints: autoCreationConstraintsSchema.parse({}),
    materials: [{ title: "拍摄笔记", kind: "notes", text: NOTES, rightsConfirmed: true }], referenceUrls: [],
    researchFetch: false, episodeCount: 1, episodeSeconds: 60, revisionRounds: 0, callBudget: 6, maxOutputTokens: 4096, providerKey: "deepseek",
    model: "deepseek-flash", authorization: { mode: "auto", proof: "site_session", initiatedBy: "a", executor: "auto-creation-engine" }, ...overrides,
  };
}

function context(frozen = input(), catalog?: AutoReferenceCatalog): AutoCreationContext {
  const sources = collectSources(frozen, [], NOW);
  return { sources, referenceCatalog: catalog ?? autoReferenceCatalog(sources), episodes: new Map(), reviews: [] };
}

const CATALOG = autoReferenceCatalog(collectSources(input(), [], NOW));
/** The catalog id of a passage this snapshot lists. */
const idOf = (quote: string) => CATALOG.entries.find((entry) => entry.quote === quote)!.referenceId;
const CRAFT = idOf(CRAFT_QUOTE);

type Item = { referenceId: string | null; application: { pattern: string; why: string } };

/** A legal limited-mode answer (prompt v9: none of the sourced contract's fields) with the given content structures. */
function answer(structures: unknown[], schema: string = AUTO_CREATION_RESEARCH_ANSWER_SCHEMA): string {
  return JSON.stringify({
    schema,
    hypotheses: [{ id: "H1", statement: "碎片时间的观众可能更愿意看一集内有明确兑现的故事。", howToVerify: "计划上线后观察七天再判断。" }],
    audience: { primary: "拟面向通勤时刷剧的成年观众（待验证）", viewingNeeds: ["一集内看到结果"], emotionalAppeals: ["扳回一局"] },
    contentStructure: structures,
    opportunities: ["小人物在一个夜晚完成一次反击"],
  });
}

/** The same answer as research v1–v3 wrote it (facts, observations, the audience's basis and sources): history only. */
function legacyAnswer(structures: unknown[], schema: string): string {
  const value = JSON.parse(answer([], schema)) as { audience: object };
  return JSON.stringify({ ...value, facts: [], observations: [], audience: { ...value.audience, basis: "hypothesis", sourceIds: [] }, contentStructure: structures });
}

const check = (structures: unknown[], frozen = input(), catalog?: AutoReferenceCatalog) =>
  validateAutoStageOutput("research", answer(structures), frozen, context(frozen, catalog));
const apply = (pattern: string, why = "这是本作品的创作设计。", referenceId: string | null = CRAFT): Item => ({ referenceId, application: { pattern, why } });
type Stored = { contentStructure: Array<{ reference: { sourceId: string; quote: string } | null; application: Item["application"] }> };

describe("A. the method quoted and the work's own design are two things", () => {
  it("the synthetic repro of the test-site refusal: v1 refused 两次 only because it cited; v1 is no longer accepted from a provider", () => {
    const v1 = (sourceIds: string[]) => legacyAnswer([{ pattern: "计划用两次反转推动主角主动选择。", why: "这是本作品的创作设计。", sourceIds }], AUTO_CREATION_RESEARCH_SCHEMA_V1);
    // On main (14758ea, checks v3) the cited item was refused as unsourced_number@contentStructure[0]:chinese_numeral+unsourced+not_in_cited_excerpt
    // and the uncited one passed (scratchpad before-fix log). Now neither old shape is taken: a new answer must keep the two apart.
    for (const ids of [["S-KB-CRAFT"], []]) {
      expect(validateAutoStageOutput("research", v1(ids), input(), context())).toMatchObject({ ok: false, code: "invalid_output" });
    }
  });

  it("a chosen method without 两次 and an application that designs two reversals: accepted, the quote filled in from the catalog word for word", () => {
    const sources = context().sources!.sources;
    expect(sources.find((source) => source.sourceId === "S-KB-CRAFT")!.excerpt).toContain(CRAFT_QUOTE);
    expect(sources.find((source) => source.sourceId === "S-KB-CRAFT")!.excerpt).not.toMatch(/两次|二次|2 ?次/u);
    const item = apply("计划用两次反转推动主角主动选择。");
    const result = check([item]);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && (result.output as unknown as Stored).contentStructure).toEqual([
      { reference: { sourceId: "S-KB-CRAFT", quote: CRAFT_QUOTE }, application: item.application }]);
  });

  it.each([
    "计划用两次反转推动主角主动选择。",
    "三名骑手被迫合作，在三天内找出真相。",
    "两个室友互相猜疑，主角二十八岁。",
    "两位房东争夺同一间铺面，前 3 秒抛出冲突。",
    "三名学生被卷进同一场考试风波。",
    "两名警察认为主角是凶手。",
    "三名室友一致决定隐瞒真相。",
    "两位房东都表示不知情。",
    "两个同事互相推荐对方背锅。",
    "本剧让三名骑手被迫合作。",
    "三名骑手用这种方式逃脱。",
    "主角调查发现站长在说谎。",
    "两个室友说好一起逃跑。",
    "两个女孩都很好看。",
    "本剧让两名学生喜欢上同一个人。",
    "三名骑手采用这种方式逃脱。",
    "主角经历三次误会后主动揭穿谎言。",
    "共 1 集，每集约 60 秒，只写 3 个出场人物。",
  ])("referenceId=null, a work's own design passes: %s", (pattern) => {
    const result = check([apply(pattern, "自主创作设计，没有对应的方法资料。", null)]);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && (result.output as unknown as Stored).contentStructure[0]!.reference).toBeNull();
    expect(check([apply(pattern)])).toMatchObject({ ok: true });
  });

  it("a chosen passage with numbers may stand beside an application with other numbers: the application's need not be in the quote", () => {
    expect(check([apply("主角二十八岁，三次误会后主动选择。", "拍摄要快。", idOf("全片一百八十个镜头要在三天内拍完，每个镜头都服务冲突。"))]))
      .toMatchObject({ ok: true });
  });
});

describe("B. a quote is a passage actually read, whole, from the one source it cites", () => {
  it("the catalog lists whole sentences of readable sources only, every one a whole quote of its own source", () => {
    const sources = new Map(collectSources(input(), [], NOW).sources.map((source) => [source.sourceId, source] as const));
    expect(CATALOG.entries.length).toBeGreaterThan(0);
    expect(new Set(CATALOG.entries.map((entry) => entry.sourceId))).toEqual(new Set(["S-KB-CRAFT", "S-USER-1"]));
    for (const entry of CATALOG.entries) {
      const source = sources.get(entry.sourceId)!;
      expect(source.status).toBe("read");
      expect(source.excerpt).toContain(entry.quote);
      expect(quotedWhole(withoutWhitespace(source.excerpt), withoutWhitespace(entry.quote))).toBe(true);
      expect(entry.quote).toMatch(/[。！？!?；;]$/u);
    }
    // The unread official entries give nothing.
    expect(CATALOG.entries.some((entry) => entry.sourceId.startsWith("S-OE-"))).toBe(false);
  });

  it.each([
    ["an invented quote", "反转次数以两次为最佳"],
    ["a quote changed by one character", "关键结果来自主角的选择与行动"],
    ["two sources joined", "收束，兑现整部作品承诺的情绪。全片一百八十个镜头"],
    ["two places of one source joined", "关键结果来自主角的选择和行动反转要有前文依据"],
    ["八十 cut out of 一百八十", "八十个镜头要在三天内拍完"],
    ["百八十 cut out of 一百八十", "百八十个镜头要在三天内拍完"],
    ["80 cut out of 180", "80个镜头。七成观众"],
    ["七 cut out of 七成", "每个镜头都服务冲突。共180个镜头。七"],
    ["60 秒 cut out of 160 秒", "60秒内必须完成一次反转"],
    ["一次 cut out of 二十一次", "一次反转都失败了，主角只能靠自己"],
    ["一集 cut out of 十一集", "一集，每集160秒内必须"],
  ] as const)("no catalog entry is %s, and the quote check refuses it as before", (_label, quote) => {
    expect(CATALOG.entries.some((entry) => withoutWhitespace(entry.quote) === withoutWhitespace(quote))).toBe(false);
    const all = collectSources(input(), [], NOW).sources.filter((source) => source.status === "read").map((source) => withoutWhitespace(source.excerpt));
    expect(all.some((excerpt) => quotedWhole(excerpt, withoutWhitespace(quote)))).toBe(false);
  });

  // Second review pass: a cut at a digit group, a letter suffix, a range or a unit outside the earlier list. quotedWhole
  // is the one the research check and the catalog both use.
  it.each([
    ["800 of 1,800", "800人观看了试映"],
    ["1 of 1,800", "反转的短剧。约1"],
    ["1 of 1,800 (no sentence before)", "主角只能靠自己。约1"],
    ["10 of 10w", "女性。累计10"],
    ["90 of 90后", "小时拍完。90"],
    ["35 of 25-35", "35岁的女性。累计"],
    ["3 of 3小时", "播放。每集3"],
    ["800 of 1,800, opening on the comma", ",800人观看了试映"],
    ["1 of 1,800, ending on the comma", "反转的短剧。约1,"],
    ["35 of 25-35, opening on the dash", "-35岁的女性。累计"],
    ["25 of 25-35, ending on the dash", "受众为25-"],
    ["35 of 25－35 (full-width dash)", "35岁的女性群体。约"],
    ["35 of 25－35, opening on the full-width dash", "－35岁的女性群体"],
    ["3 of 1/3", "3观众看完。比例"],
    ["1 of 3：1", "1的男女。约"],
    ["1 of 3比1", "1的结构，节奏很快"],
  ])("second pass: %s is no quote", (_label, quote) => {
    expect(quotedWhole(withoutWhitespace(NOTES), withoutWhitespace(quote))).toBe(false);
  });

  it("whole sentences with numbers in them are listed as they stand", () => {
    for (const quote of ["约1,800人观看了试映。", "受众为25-35岁的女性。", "这部剧共十一集，每集160秒内必须完成一次反转。", "前二十一次反转都失败了，主角只能靠自己。"]) {
      expect(CATALOG.entries.map((entry) => entry.quote)).toContain(quote);
      expect(check([apply("主角主动选择。", "写作方法。", idOf(quote))]), quote).toMatchObject({ ok: true });
    }
  });

  it("an id the catalog lacks refuses the whole answer, named by field: never dropped, set to null or swapped for a near id", () => {
    // Another run's snapshot (other notes of the person): its passages have ids this catalog does not list.
    const other = autoReferenceCatalog(collectSources(input({ materials: [{ title: "另一份笔记", kind: "notes", text: "主角每一场都要主动出手。反派从不解释动机。", rightsConfirmed: true }] }), [], NOW));
    const foreign = other.entries.find((entry) => entry.sourceId === "S-USER-1")!.referenceId;
    expect(CATALOG.entries.some((entry) => entry.referenceId === foreign)).toBe(false);
    const nearMiss = `${CRAFT.slice(0, -1)}${CRAFT.endsWith("0") ? "1" : "0"}`;
    for (const id of [foreign, nearMiss, "R-0000000000", "S-KB-CRAFT", CRAFT_QUOTE.slice(0, 40)]) {
      const result = check([apply("主角主动选择推动结果。", "写作方法。"), apply("计划用两次反转推动主角主动选择。", "写作方法。", id)]);
      expect(result, id).toEqual({ ok: false, code: "unknown_reference", detail: id, field: "contentStructure[1].referenceId" });
      expect("output" in result).toBe(false);
    }
  });

  it("every id is a digest of the catalog version, source and passage: the same passage keeps its id in another snapshot", () => {
    expect(CATALOG.version).toBe("ads.auto-creation.reference-catalog.v1");
    expect(CATALOG.entries.every((entry) => /^R-[0-9a-f]{10}$/u.test(entry.referenceId))).toBe(true);
    const sourced = autoReferenceCatalog(collectSources(input(), [{ url: OCEAN_ENGINE_ENTRY_URLS[0], status: "read", title: "合成市场样本页",
      text: "合成样本：本页只描述题材趋势，没有统计数字。", publishedAt: "2026-09-01T00:00:00.000Z", fetchedAt: NOW, note: "合成样本" }], NOW));
    expect(sourced.entries.find((entry) => entry.quote === CRAFT_QUOTE)!.referenceId).toBe(CRAFT);
    expect(sourced.hash).not.toBe(CATALOG.hash);
  });

  it.each([
    ["a quote of its own beside a valid id", { referenceId: CRAFT, quote: CRAFT_QUOTE }, "quote"],
    ["a source of its own", { referenceId: CRAFT, sourceId: "S-KB-CRAFT" }, "sourceId"],
    ["the old reference object", { reference: { sourceId: "S-KB-CRAFT", quote: CRAFT_QUOTE } }, "reference"],
    ["an empty reference", { referenceId: null, reference: null }, "reference"],
    ["the old reference with an id", { referenceId: CRAFT, reference: { sourceId: "S-KB-CRAFT", quote: CRAFT_QUOTE } }, "reference"],
  ] as const)("a model-written server field refuses the whole answer, even empty: %s", (_label, fields, key) => {
    const result = check([{ ...fields, application: { pattern: "主角主动选择推动结果。", why: "写作方法。" } }]);
    expect(result).toMatchObject({ ok: false, code: "invalid_output", field: `contentStructure[0].${key}`, category: "unrecognized_keys" });
    expect("semantic" in result).toBe(false);
  });

  it("a missing referenceId is refused, never read as null", () => {
    expect(check([{ application: { pattern: "主角主动选择推动结果。", why: "写作方法。" } }])).toMatchObject({ ok: false, code: "invalid_output",
      field: "contentStructure[0].referenceId" });
  });

  it("the old answer shape (research v4 schema, a quoted reference) is no longer accepted from a provider", () => {
    expect(validateAutoStageOutput("research", answer([{ reference: { sourceId: "S-KB-CRAFT", quote: CRAFT_QUOTE }, application: { pattern: "主角主动选择。", why: "写作方法。" } }],
      AUTO_CREATION_RESEARCH_SCHEMA), input(), context())).toMatchObject({ ok: false, code: "invalid_output" });
  });

  it("an empty catalog leaves null as the only choice", () => {
    const empty: AutoReferenceCatalog = { ...CATALOG, entries: [] };
    expect(check([apply("主角主动选择。", "自主设计。", null)], input(), empty)).toMatchObject({ ok: true });
    expect(check([apply("主角主动选择。")], input(), empty)).toMatchObject({ ok: false, code: "unknown_reference", field: "contentStructure[0].referenceId" });
  });

  it("no catalog in the context: nothing is checked as a research (the engines stop before sending)", () => {
    const { referenceCatalog: _catalog, ...bare } = context();
    expect(validateAutoStageOutput("research", answer([apply("主角主动选择。", "自主设计。", null)]), input(), bare)).toEqual({ ok: false, code: "research_sources_missing" });
  });

  // The quote check still stands behind the catalog: a catalog entry that is no whole quote of a readable source (as a
  // corrupted or forged catalog would have) refuses the answer exactly as a forged quote did before checks v10.
  it.each([
    ["an invented quote", { sourceId: "S-KB-CRAFT", quote: "反转次数以两次为最佳。" }, "evidence_not_in_source", "reference.quote"],
    ["a number cut out of the source", { sourceId: "S-USER-1", quote: "八十个镜头要在三天内拍完" }, "evidence_not_in_source", "reference.quote"],
    ["two places of one source joined", { sourceId: "S-KB-CRAFT", quote: "关键结果来自主角的选择和行动反转要有前文依据" }, "evidence_not_in_source", "reference.quote"],
    ["an unknown source", { sourceId: "S-KB-OTHER", quote: CRAFT_QUOTE }, "unknown_source", "reference.sourceId"],
    ["an unread official entry", { sourceId: "S-OE-1", quote: CRAFT_QUOTE }, "unread_source", "reference.sourceId"],
  ] as const)("a forged catalog entry is refused by the quote check: %s", (_label, forged, code, field) => {
    const catalog: AutoReferenceCatalog = { ...CATALOG, entries: [{ referenceId: "R-forged0000", ...forged }] };
    expect(check([apply("主角主动选择推动结果。", "写作方法。", "R-forged0000")], input(), catalog)).toMatchObject({ ok: false, code, field: `contentStructure[0].${field}` });
  });
});

describe("C. the application is checked as uncited text, whatever it cites", () => {
  it.each([
    ["a share", "约三成观众偏爱两次反转。", "unsourced_number", "market_statistic"],
    ["the quoted share repeated", "七成观众爱看复仇，所以写两次反转。", "unsourced_number", "market_statistic"],
    ["an audience count", "三千观众愿意为两次反转付费。", "unsourced_number", "market_statistic"],
    ["a ranking", "复仇题材在榜单排名第一。", "unsourced_number", "market_statistic"],
    ["a measured finding with a count", "数据显示观众更喜欢两次反转的版本。", "unsourced_number", "result_claim"],
    ["an unmarked audience judgement with a count", "观众更喜欢三次反转的剧本。", "unsourced_number", "result_claim"],
  ] as const)("%s in the application is refused even beside a quote that has it", (_label, text, code, semantic) => {
    const quoting = idOf("七成观众爱看复仇。");
    for (const [reference, field, item] of [
      [quoting, "application.pattern", apply(text, "写作方法。", quoting)],
      [CRAFT, "application.why", apply("主角主动选择。", text, CRAFT)],
      [null, "application.why", apply("主角主动选择。", text, null)],
    ] as const) {
      expect(check([item]), `${String(reference)} ${field}`).toMatchObject({ ok: false, code, semantic, field: `contentStructure[0].${field}` });
    }
  });

  it.each([
    "调查证明观众更喜欢反转。",
    "数据显示这类结尾最受欢迎。",
    "已验证观众爱看逆袭。",
    "经过调研，观众偏爱小人物逆袭。",
    "平台数据表明用户喜欢快节奏。",
  ])("a settled audience finding without a number is refused in the application: %s", (text) => {
    expect(check([apply("主角主动选择。", text)])).toEqual({ ok: false, code: "unsourced_claim", detail: "application", field: "contentStructure[0].application.why" });
    expect(check([apply(text, "写作方法。", null)])).toMatchObject({ ok: false, code: "unsourced_claim", field: "contentStructure[0].application.pattern" });
  });

  // Independent review: a marker word elsewhere in the clause, spacing and a few unlisted wordings passed.
  it.each([
    "调查证明观众更喜欢若即若离的感情线。",
    "已验证观众最爱看主角收集证据。",
    "数据显示观众更喜欢准备充分的主角。",
    "调查 证明观众更喜欢反转。",
    "调\u200b查证明观众更喜欢反转。",
    "据统计，观众偏爱结尾反转。",
    "实践证明观众更喜欢反转。",
    "业内公认观众爱看这种结构。",
    "业内公认这种结构最有效。",
    "观众期待的反转结尾数据显示最受欢迎。",
    "女将军题材经调查证明最受欢迎。",
    "若即若离的感情线经调查证明观众更喜欢。",
    "其他调查发现观众更喜欢反转。",
    "她调查发现观众更喜欢反转。",
    "他调查发现，观众更喜欢反转。",
  ])("review: a settled finding is refused however it is spaced or whatever follows it: %s", (text) => {
    expect(check([apply(text)])).toMatchObject({ ok: false, code: "unsourced_claim", field: "contentStructure[0].application.pattern" });
  });

  it.each([
    "八名试映嘉宾都给了好评。",
    "三位专家一致推荐。",
    "五位资深编剧都认为这种结构最抓人。",
    "三名学生都给了好评。",
    "两位老师一致推荐这种结尾。",
    "五位老师都给了高分，所以采用这种结构。",
    "三个记者都夸这个结尾。",
    "五名主播都用这种开场。",
    "八名学生试看后都说结尾好。",
    "三位老师一致推荐。",
    "五名学生都说好看。",
    "五个主播都在用这种开场。",
    "三位老师都觉得结尾不错。",
  ])("review: people counted as a source of a verdict are no cast: %s", (text) => {
    expect(check([apply(text)])).toMatchObject({ ok: false, code: "unsourced_number", field: "contentStructure[0].application.pattern" });
  });

  it.each([
    "计划用试看比较两个版本，待验证观众是否更喜欢两次反转。",
    "若数据显示观众更喜欢反转，再加强结尾。",
    "我们计划通过试看验证观众是否更喜欢反转。",
    "拟在上线后通过试看验证观众是否更喜欢反转。",
    "待验证观众是否更喜欢两次反转的版本。",
    "主角在三次误会后证明自己。",
    "可能契合想看小人物扳回一局的观众，待验证。",
  ])("a plan, a pending judgement or a story is no finding: %s", (text) => {
    expect(check([apply("主角主动选择。", text)])).toMatchObject({ ok: true });
  });

  it.each([
    [{ constraints: autoCreationConstraintsSchema.parse({ maxCharacters: 3 }) }, "四名骑手被迫合作。", "cast_over_limit"],
    [{ constraints: autoCreationConstraintsSchema.parse({ maxCharacters: 2 }) }, "三个室友互相猜疑。", "cast_over_limit"],
    [{ constraints: autoCreationConstraintsSchema.parse({ maxLocations: 2 }) }, "故事发生在四处场景。", "locations_over_limit"],
    [{}, "共 3 集，层层反转。", "episode_count"],
    [{}, "每集约 90 秒。", "over_length"],
  ] as const)("a frozen constraint still binds the application (%s)", (overrides, text, rule) => {
    const frozen = input(overrides);
    expect(check([apply(text)], frozen)).toMatchObject({ ok: false, code: "constraint_violation", semantic: "frozen_conflict", rule,
      field: "contentStructure[0].application.pattern" });
  });

  it("people counted by their trade in a clause about viewers are viewers", () => {
    expect(check([apply("三名学生观众更喜欢反转。")])).toMatchObject({ ok: false, code: "unsourced_number", semantic: "market_statistic", rule: "audience_count" });
    expect(check([apply("九名骑手轮番登场。")])).toMatchObject({ ok: false, code: "unsourced_number", rule: "count_out_of_range" });
  });

  it("the trade list is finite: an unlisted word after a count has no role, an unverified notice since checks v5; 人物 passes plainly", () => {
    // Product change (checks v5): these were refused as unclassified+no_role (a known over-refusal); the text is now kept
    // as written with a notice that the number is unverified.
    expect(check([apply("三个骑士被迫合作。")])).toMatchObject({ ok: true,
      output: { unverified: [{ field: "contentStructure[0].application.pattern", token: "三个", semantic: "unclassified", rule: "no_role" }] } });
    // A classifier alone does not say what is counted (三位数密码, 两位小数): 名 and 位 are no cast by themselves, so these
    // are notices too (PR #82 review); only a named cast (人物, 角色, the listed trades, 人) is held to the frozen limit.
    for (const [text, token] of [["三名骑士被迫合作。", "三名"], ["两位母亲争夺孩子。", "两位"]] as const) {
      expect(check([apply(text)]), text).toMatchObject({ ok: true, output: { unverified: [{ token, rule: "no_role" }] } });
    }
    expect(check([apply("三个人物被迫合作。")])).toMatchObject({ ok: true, output: { unverified: [] } });
    const pair = input({ constraints: autoCreationConstraintsSchema.parse({ maxCharacters: 2 }) });
    expect(check([apply("三个人物被迫合作。")], pair)).toMatchObject({ ok: false, code: "constraint_violation", rule: "cast_over_limit" });
    // Unnamed: kept with a notice; the setting stage still refuses a cast over the limit.
    for (const text of ["三个骑士被迫合作。", "三名骑士被迫合作。"]) {
      expect(check([apply(text)], pair), text).toMatchObject({ ok: true, output: { unverified: [{ rule: "no_role" }] } });
    }
    // A settled wording in a story sentence about a popular character is refused too (only over-refuses).
    expect(check([apply("事实证明最受欢迎的店员才是真凶。")])).toMatchObject({ ok: false, code: "unsourced_claim" });
  });
});

describe("E. a verdict or an investigation inside the story is the story (PR #81 review)", () => {
  /** The statement in application.pattern and application.why, each with reference=null and with a valid reference. */
  const placements = (text: string): Array<[string, Item]> => [
    ["pattern, reference=null", apply(text, "自主创作设计。", null)],
    ["pattern, reference", apply(text, "写作方法。")],
    ["why, reference=null", apply("主角主动选择。", text, null)],
    ["why, reference", apply("主角主动选择。", text)],
  ];
  const fieldOf = (placement: string) => `contentStructure[0].application.${placement.startsWith("why") ? "why" : "pattern"}`;

  // Each was refused on ea5f749: a verdict word anywhere in the clause made counted people a source of feedback.
  it.each([
    "三名学生因一条差评联手追查真相。",
    "三名骑手遭遇恶意差评后决定寻找证据。",
    "两名店员因为一条好评反目成仇。",
    "三名骑手收到差评后联手查清真相。",
  ])("a verdict that drives the plot keeps the cast a cast: %s", (text) => {
    for (const [placement, item] of placements(text)) expect(check([item]), placement).toMatchObject({ ok: true });
  });

  it.each([
    "三名学生都给了好评。",
    "三名学生看过剧本后都给了好评。",
    "三名学生被邀请试看后打了高分。",
    "三名学生因为喜欢这个结尾都给了好评。",
    "三名学生收到剧本都给了好评。",
    // Independent incremental review: the first version of this fix let these through as plot.
    "三名学生收到剧本后好评不断。",
    "三名学生收到样片后点赞。",
    "三名学生因为试映好评如潮。",
    "三名学生被感动后好评连连。",
    "三名学生因样片好评。",
    "三名学生由于剧情好叫好。",
    "三名学生被圈粉后高分推荐。",
    "三名学生因好评而决定续看。",
    "三名学生收到一个好评后决定再看一遍。",
    "五名学生都说好看。",
    "三名骑手试看后都给了差评。",
  ])("counted people giving a verdict on the work are still refused: %s", (text) => {
    for (const [placement, item] of placements(text)) {
      expect(check([item]), placement).toMatchObject({ ok: false, code: "unsourced_number", semantic: "result_claim", field: fieldOf(placement) });
    }
  });

  // Each was refused on ea5f749: only a character right before the result wording was read as the story.
  it.each([
    "主角的调查发现站长伪造账本。",
    "女主的调查发现邻居隐瞒了身份。",
    "主角调查发现站长伪造账本。",
    "主角的调查发现了真相。",
  ])("a character's own investigation is the story: %s", (text) => {
    for (const [placement, item] of placements(text)) expect(check([item]), placement).toMatchObject({ ok: true });
  });

  it.each([
    "主角的调查发现观众偏爱反转。",
    "女主的调查发现，观众更喜欢这种结尾。",
    "调查证明观众更喜欢这种结尾。",
    "主角的调查证明这种结尾最受欢迎。",
    "受众对主角的调研证明这种结构有效。",
    "观众对主角的调查表明这种结构最有效。",
    "用户关于女主的调查显示这种开场更抓人。",
    "同类短剧中主角的调查证明这种结构有效。",
    "观众眼中主角的调查证明这种结构有效。",
    "其他的调查发现观众更喜欢反转。",
    "主角的调查证明这种结构有效。",
    "她的调查证明这个结局最好。",
    "主角的调查发现这种开场留得住人。",
    "主角的调查显示这种节奏最抓人。",
    "主角调查证明本剧的设定最有效。",
    "她的调查证明这个故事最感人。",
    "主角的调查发现这种反转很有用。",
    "主角的调查证明这个人设最受用。",
    "主角的调查发现这个结果很感动。",
    "她的调查证明这种钩子很灵。",
    "主角的调查发现这条支线很妙。",
    "他的调查发现这个悬念够狠。",
  ])("a finding about viewers stays refused, whoever investigates: %s", (text) => {
    for (const [placement, item] of placements(text)) {
      expect(check([item]), placement).toMatchObject({ ok: false, code: "unsourced_claim", field: fieldOf(placement) });
    }
  });
});

describe("F. an ordinary word with 好, 灵, 更 or 最 in it is no evaluation (PR #81 final review)", () => {
  const placements = (text: string): Array<[string, Item]> => [
    ["pattern, reference=null", apply(text, "自主创作设计。", null)],
    ["pattern, reference", apply(text, "写作方法。")],
    ["why, reference=null", apply("主角主动选择。", text, null)],
    ["why, reference", apply("主角主动选择。", text)],
  ];

  // Each passed on ea5f749 and was refused on d2c04a9: a single character matched anywhere in the finding.
  it.each([
    "主角调查发现好友伪造账本。",
    "主角调查发现灵堂暗藏机关。",
    "主角调查发现更多线索。",
    "主角调查发现更衣室藏着证据。",
    "主角的调查发现好友伪造账本。",
    "主角的调查发现最后一页被撕掉。",
    "主角调查发现站长此后改了名字。",
    "主角调查发现站长从此以后搬了家。",
    "主角调查发现站长应该早就知情。",
    "主角的调查发现了真相。",
    "主角调查发现站长的好友伪造账本。",
    "主角调查发现站长因此改了口供。",
    "主角调查发现那时站长不在场。",
    "主角的调查发现这种毒药无色无味。",
    "主角调查发现这封信是伪造的。",
    "主角调查发现那个人是站长的弟弟。",
    "主角调查发现此事与站长有关。",
    "主角调查发现站长把账本藏在那里。",
    "主角调查发现站长好强的控制欲来自童年。",
    "主角调查发现站长比他强。",
    "主角调查发现站长下手狠。",
    "主角调查发现站长赶尽杀绝。",
    "主角调查发现药已见效。",
    "主角调查发现站长超市的账本被改。",
    "主角调查发现邻居超速逃逸。",
    "主角调查发现站长相当于共犯。",
    "主角调查发现站长尤其怕水。",
  ])("a plot finding with such a word stays the story: %s", (text) => {
    for (const [placement, item] of placements(text)) expect(check([item]), placement).toMatchObject({ ok: true });
  });

  it.each([
    "主角的调查发现观众偏爱反转。",
    "主角的调查证明这种结构有效。",
    "她的调查证明这个故事最感人。",
    "主角的调查发现这种反转很灵。",
    "主角的调查发现这种反转够狠。",
    "主角的调查发现这个结果很感动。",
    // Final review: evaluations with no listed demonstrative, other degree words, a degree after the predicate, a long tail.
    "主角的调查发现这招很灵。",
    "主角的调查发现那种手法很灵。",
    "主角的调查发现这一招很灵。",
    "主角的调查发现这手法挺妙。",
    "主角的调查发现这样安排非常精彩。",
    "主角的调查发现此法妙极了。",
    "主角的调查发现这种手法极妙。",
    "主角的调查发现这种手法超灵。",
    "主角的调查发现这种手法真灵。",
    "主角的调查发现这种安排好极了。",
    "主角的调查发现这种手法灵得很。",
    "主角的调查发现这种手法很吸引年轻人。",
    "主角的调查发现这种手法很灵并且值得保留。",
    "主角的调查发现这种安排的效果最为明显不过了。",
    "主角的调查发现这种手法好用。",
    "主角的调查发现这种做法成功了。",
    // Final review, second pass: judgements with no degree word, or a degree word before an unlisted evaluation.
    "主角的调查发现这招灵。",
    "主角的调查发现这种安排妙不可言。",
    "主角的调查发现这种安排更胜一筹。",
    "主角的调查发现这种手法更为高效。",
    "主角的调查发现这种手法最具感染力。",
    "主角的调查发现这样写更能留住人。",
    "主角的调查发现这种手法够味。",
    "主角的调查发现这种手法很快就见效了。",
    "主角的调查发现反派越狠越好。",
    // Final review, third pass: other determiners, connectives, or no determiner at all.
    "主角的调查发现该招灵。",
    "主角的调查发现其手法妙。",
    "主角的调查发现某种安排更胜一筹。",
    "主角的调查发现上述手法最具感染力。",
    "主角的调查发现本招妙不可言。",
    "主角的调查发现那时的安排更胜一筹。",
    "主角的调查发现如此安排更胜一筹。",
    "主角的调查发现那天的招数灵。",
    "主角的调查发现先抑后扬更胜一筹。",
    "主角的调查发现先抑后扬灵得出奇。",
    "主角的调查发现先抑后扬屡试屡灵。",
    "主角的调查发现开门见山更能留住人。",
    "主角的调查发现慢热开局更为高效。",
    // Final review, fourth pass.
    "主角的调查发现最妙的是先抑后扬。",
    "主角的调查发现更胜一筹的是开门见山。",
    "主角的调查发现先抑后扬更加精彩。",
    "主角的调查发现先抑后扬真好看。",
    "主角的调查发现开门见山蛮灵的。",
    "主角的调查发现这招灵呢。",
    "主角的调查发现这招灵验。",
    "主角的调查发现这才是灵招。",
    "主角的调查发现这招精妙绝伦。",
    "主角的调查发现这招绝了。",
  ])("a finding that judges the work or the market is still refused: %s", (text) => {
    for (const [placement, item] of placements(text)) {
      expect(check([item]), placement).toMatchObject({ ok: false, code: "unsourced_claim", field: `contentStructure[0].application.${placement.startsWith("why") ? "why" : "pattern"}` });
    }
  });
});

describe("F2. documented gaps: a craft conclusion with no listed word, structure or demonstrative passes (docs §3.3 漏检)", () => {
  it.each(["主角的调查发现开门见山效果显著。", "主角的调查发现先抑后扬有感染力。", "主角的调查发现开门见山更多人爱。",
    "主角的调查发现先抑后扬屡试不爽。", "主角的调查发现这种手法尤其出彩。", "主角的调查发现先抑后扬更早见效。",
    "主角的调查发现最妙之处在于先抑后扬。", "主角的调查发现最灵的一招是先抑后扬。", "主角的调查发现更好的办法是先抑后扬。",
    "主角的调查发现这招灵哦。"])("%s", (text) => {
    expect(check([apply(text)])).toMatchObject({ ok: true });
  });
});

describe("F3. documented over-refusals of plot findings (docs §3.3 多拒)", () => {
  it.each([
    "主角调查发现这把刀很锋利。",
    "主角调查发现站长很害怕。",
    "主角调查发现站长此后更加小心。",
    "主角调查发现站长躲进更衣室。",
    "主角调查发现站长的病好了。",
    "主角调查发现这个人很可疑。",
    "主角调查发现凶手很狡猾。",
    "主角调查发现站长最好的朋友是凶手。",
    "主角调查发现邻居与站长有冲突。",
    "主角的调查发现站长篡改了剧本。",
    "主角调查发现站长拿到了绝招。",
  ])("%s", (text) => {
    expect(check([apply(text)])).toMatchObject({ ok: false, code: "unsourced_claim" });
  });
});

describe("D. stored v1 research is read, shown and exported as it was", () => {
  /** A quote as research v2 stored it (a model wrote it before prompt v9): read as it was, never re-cut to a catalog sentence. */
  const STORED_CRAFT = { sourceId: "S-KB-CRAFT", quote: "关键结果来自主角的选择和行动" };
  const v1: AutoStoredResearch = {
    schema: AUTO_CREATION_RESEARCH_SCHEMA_V1,
    facts: [], observations: [],
    hypotheses: [{ id: "H1", statement: "观众可能偏爱一集内兑现。", howToVerify: "计划上线后观察七天。" }],
    audience: { primary: "成年观众（假设）", viewingNeeds: ["看到结果"], emotionalAppeals: ["扳回一局"], basis: "hypothesis", sourceIds: [] },
    contentStructure: [{ pattern: "主角主动选择推动结果", why: "知识库要求关键结果来自主角的行动。", sourceIds: ["S-KB-CRAFT"] }],
    opportunities: ["小人物反击"], limitations: ["没有市场数据"], appliedConstraints: [],
  };
  const v2: AutoStoredResearch = { ...v1, schema: AUTO_CREATION_RESEARCH_SCHEMA_V2, contentStructure: [
    { reference: STORED_CRAFT, application: { pattern: "计划用两次反转推动主角主动选择。", why: "本作品的创作设计。" } },
    { reference: null, application: { pattern: "三名骑手被迫合作。", why: "自主设计。" } },
  ] };
  const stage = (stageKey: string, ordinal: number, output: unknown): AutoStageRecord => ({ runId: "r", stageKey, ordinal, state: "completed", attemptNo: 1,
    errorCode: null, output: output as AutoStageRecord["output"], outputHash: "h", dependsOn: null, scriptSave: null, scriptRevisionId: null, updatedAt: NOW });
  const stagesWith = (research: AutoStoredResearch) => [stage("sources", 0, collectSources(input(), [], NOW)), stage("research", 1, research)];
  const meta = { runId: "r", projectId: "p", input: input(), quality: "pending", state: "running", callsUsed: 1, callCap: 6, revisionRoundsUsed: 0,
    storySave: "pending", generatedAt: NOW };

  it("a later prompt reads a v1 research as a historical item, never as a quote", () => {
    const prompt = buildAutoCreationPrompt("directions", input(), autoContextFromStages(stagesWith(v1))).user;
    expect(prompt).toContain("\"历史版本\":{\"pattern\":\"主角主动选择推动结果\"");
    expect(prompt).not.toContain("参考方法原文\":");
    const current = buildAutoCreationPrompt("directions", input(), autoContextFromStages(stagesWith(v2))).user;
    expect(current).toContain(`"参考方法原文":{"sourceId":"S-KB-CRAFT","quote":"${STORED_CRAFT.quote}"}`);
    expect(current).toContain("\"参考方法原文\":\"无（自主创作设计）\"");
    expect(current).toContain("\"本剧应用设计\":{\"pattern\":\"计划用两次反转推动主角主动选择。\"");
  });

  it("the Markdown package marks a v1 item as historical and invents no quote; v2 shows the quote and the design apart", () => {
    const old = autoPackageMarkdown(meta, stagesWith(v1));
    expect(old).toContain("- 结构 1（历史版本，未区分参考原文与本剧应用）：主角主动选择推动结果：知识库要求关键结果来自主角的行动。（S-KB-CRAFT）");
    expect(old).not.toContain("参考方法原文：");
    const current = autoPackageMarkdown(meta, stagesWith(v2));
    expect(current).toContain(`  - 参考方法原文：S-KB-CRAFT「${STORED_CRAFT.quote}」`);
    expect(current).toContain("  - 本剧应用设计：计划用两次反转推动主角主动选择。：本作品的创作设计。");
    expect(current).toContain("  - 参考方法原文：无（自主创作设计）");
    expect(current).toContain("不是平台真实用户画像");
  });

  it("the JSON package carries each research as stored, its schema naming its version", () => {
    for (const research of [v1, v2]) {
      const json = autoPackageJson(meta, stagesWith(research)) as { research: { analysis: unknown } };
      expect(json.research.analysis).toEqual(research);
    }
  });
});
