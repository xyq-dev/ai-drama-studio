import { describe, expect, it } from "vitest";
import {
  AUTO_CREATION_RESEARCH_SCHEMA,
  AUTO_CREATION_RESEARCH_SCHEMA_V1,
  AUTO_CREATION_RESEARCH_SCHEMA_V2,
  autoCreationConstraintsSchema,
  type AutoCreationFrozenInput,
  type AutoStageRecord,
  type AutoStoredResearch,
} from "@ai-drama/contracts";
import { collectSources } from "./auto-creation-sources";
import { autoContextFromStages, autoPackageJson, autoPackageMarkdown, buildAutoCreationPrompt, validateAutoStageOutput, type AutoCreationContext } from "./auto-creation";

/**
 * Research v2 (prompt v4, checks v4): a content structure keeps the method it quotes (reference) apart from this work's
 * own design (application). The quote must stand whole in the one source it cites; the application is checked as
 * uncited text whatever it cites, so a reference never sources a story count, a statistic or a settled finding.
 */

const NOW = "2026-10-20T00:00:00.000Z";
/** A passage of the built-in craft entry, verbatim. It has no number at all. */
const CRAFT_QUOTE = "关键结果来自主角的选择和行动";
const CRAFT = { sourceId: "S-KB-CRAFT", quote: CRAFT_QUOTE };
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

function context(frozen = input()): AutoCreationContext {
  return { sources: collectSources(frozen, [], NOW), episodes: new Map(), reviews: [] };
}

type Item = { reference: { sourceId: string; quote: string } | null; application: { pattern: string; why: string } };

/** A legal limited-mode answer (research v4: none of the sourced contract's fields) with the given content structures. */
function answer(structures: Item[], schema: string = AUTO_CREATION_RESEARCH_SCHEMA): string {
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

const check = (structures: Item[], frozen = input()) => validateAutoStageOutput("research", answer(structures), frozen, context(frozen));
const apply = (pattern: string, why = "这是本作品的创作设计。", reference: Item["reference"] = CRAFT): Item => ({ reference, application: { pattern, why } });

describe("A. the method quoted and the work's own design are two things", () => {
  it("the synthetic repro of the test-site refusal: v1 refused 两次 only because it cited; v1 is no longer accepted from a provider", () => {
    const v1 = (sourceIds: string[]) => legacyAnswer([{ pattern: "计划用两次反转推动主角主动选择。", why: "这是本作品的创作设计。", sourceIds }], AUTO_CREATION_RESEARCH_SCHEMA_V1);
    // On main (14758ea, checks v3) the cited item was refused as unsourced_number@contentStructure[0]:chinese_numeral+unsourced+not_in_cited_excerpt
    // and the uncited one passed (scratchpad before-fix log). Now neither old shape is taken: a new answer must keep the two apart.
    for (const ids of [["S-KB-CRAFT"], []]) {
      expect(validateAutoStageOutput("research", v1(ids), input(), context())).toMatchObject({ ok: false, code: "invalid_output" });
    }
  });

  it("a quoted method without 两次 and an application that designs two reversals: accepted, kept word for word", () => {
    const sources = context().sources!.sources;
    expect(sources.find((source) => source.sourceId === "S-KB-CRAFT")!.excerpt).toContain(CRAFT_QUOTE);
    expect(sources.find((source) => source.sourceId === "S-KB-CRAFT")!.excerpt).not.toMatch(/两次|二次|2 ?次/u);
    const item = apply("计划用两次反转推动主角主动选择。");
    const result = check([item]);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && (result.output as { contentStructure: Item[] }).contentStructure).toEqual([item]);
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
  ])("reference=null, a work's own design passes: %s", (pattern) => {
    expect(check([apply(pattern, "自主创作设计，没有对应的方法资料。", null)])).toMatchObject({ ok: true });
    expect(check([apply(pattern)])).toMatchObject({ ok: true });
  });

  it("a quote with numbers may stand beside an application with other numbers: the application's need not be in the quote", () => {
    expect(check([apply("主角二十八岁，三次误会后主动选择。", "拍摄要快。", { sourceId: "S-USER-1", quote: "一百八十个镜头要在三天内拍完" })]))
      .toMatchObject({ ok: true });
  });
});

describe("B. a quote is a passage actually read, whole, from the one source it cites", () => {
  it.each([
    ["an invented quote", { sourceId: "S-KB-CRAFT", quote: "反转次数以两次为最佳" }, "evidence_not_in_source", "reference.quote"],
    ["a quote changed by one character", { sourceId: "S-KB-CRAFT", quote: "关键结果来自主角的选择与行动" }, "evidence_not_in_source", "reference.quote"],
    ["a quote of another source cited under the craft entry", { sourceId: "S-KB-CRAFT", quote: "每个镜头都服务冲突" }, "evidence_not_in_source", "reference.quote"],
    ["two sources joined", { sourceId: "S-KB-CRAFT", quote: "收束，兑现整部作品承诺的情绪。全片一百八十个镜头" }, "evidence_not_in_source", "reference.quote"],
    ["two places of one source joined", { sourceId: "S-KB-CRAFT", quote: "关键结果来自主角的选择和行动反转要有前文依据" }, "evidence_not_in_source", "reference.quote"],
    ["an unknown source", { sourceId: "S-KB-OTHER", quote: CRAFT_QUOTE }, "unknown_source", "reference.sourceId"],
    ["an unread official entry", { sourceId: "S-OE-1", quote: CRAFT_QUOTE }, "unread_source", "reference.sourceId"],
  ] as const)("%s is refused, named by field", (_label, reference, code, field) => {
    expect(check([apply("主角主动选择推动结果。", "写作方法。", reference)])).toMatchObject({ ok: false, code, field: `contentStructure[0].${field}` });
  });

  it.each([
    ["八十 cut out of 一百八十", "八十个镜头要在三天内拍完", "chinese_numeral"],
    ["百八十 cut out of 一百八十", "百八十个镜头要在三天内拍完", "chinese_numeral"],
    ["80 cut out of 180", "80个镜头。七成观众", "digits"],
  ] as const)("a whole-number boundary is kept: %s is no quote", (_label, quote) => {
    expect(NOTES.replace(/\s/gu, "")).toContain(quote);
    expect(check([apply("主角主动选择。", "写作方法。", { sourceId: "S-USER-1", quote })])).toMatchObject({
      ok: false, code: "evidence_not_in_source", field: "contentStructure[0].reference.quote" });
  });

  it("a number cut before its unit (七 of 七成) is no supported number either", () => {
    expect(check([apply("主角主动选择。", "写作方法。", { sourceId: "S-USER-1", quote: "每个镜头都服务冲突。共180个镜头。七" })])).toMatchObject({
      ok: false, code: "evidence_not_in_source", field: "contentStructure[0].reference.quote" });
    expect(check([apply("主角主动选择。", "写作方法。", { sourceId: "S-USER-1", quote: "每个镜头都服务冲突。共180个镜头。七成" })])).toMatchObject({ ok: true });
  });

  // Independent review: the run's own 60 秒 and 1 集, and the bare article 一次, were exempt from the token check.
  it.each([
    ["60 秒 cut out of 160 秒", "60秒内必须完成一次反转"],
    ["一次 cut out of 二十一次", "一次反转都失败了，主角只能靠自己"],
    ["一集 cut out of 十一集", "一集，每集160秒内必须"],
  ])("no number is cut at a quote's edge, the run's own settings included: %s", (_label, quote) => {
    expect(check([apply("主角主动选择。", "写作方法。", { sourceId: "S-USER-1", quote })])).toMatchObject({
      ok: false, code: "evidence_not_in_source", field: "contentStructure[0].reference.quote" });
    expect(check([apply("主角主动选择。", "写作方法。", { sourceId: "S-USER-1", quote: `1${quote}` })])).toMatchObject({ ok: quote.startsWith("60") });
  });

  // Second review pass: a cut at a digit group, a letter suffix, a range or a unit outside the earlier list.
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
    expect(check([apply("主角主动选择。", "写作方法。", { sourceId: "S-USER-1", quote })])).toMatchObject({
      ok: false, code: "evidence_not_in_source", field: "contentStructure[0].reference.quote" });
  });

  it("a whole quote with the run's own numbers in it is a quote", () => {
    expect(check([apply("主角主动选择。", "写作方法。", { sourceId: "S-USER-1", quote: "约1,800人观看了试映。" })])).toMatchObject({ ok: true });
    expect(check([apply("主角主动选择。", "写作方法。", { sourceId: "S-USER-1", quote: "受众为25-35岁的女性" })])).toMatchObject({ ok: true });
    expect(check([apply("主角主动选择。", "写作方法。", { sourceId: "S-USER-1", quote: "每集160秒内必须完成一次反转" })])).toMatchObject({ ok: true });
    expect(check([apply("主角主动选择。", "写作方法。", { sourceId: "S-USER-1", quote: "前二十一次反转都失败了" })])).toMatchObject({ ok: true });
  });

  it("a quote's minimum length is counted without whitespace", () => {
    expect(check([apply("主角主动选择。", "写作方法。", { sourceId: "S-USER-1", quote: "共 1 8 0" })])).toMatchObject({ ok: false, code: "invalid_output" });
  });

  it("a quote shorter than a passage or longer than the limit is refused by the schema", () => {
    expect(check([apply("主角主动选择。", "写作方法。", { sourceId: "S-KB-CRAFT", quote: "主角" })])).toMatchObject({ ok: false, code: "invalid_output" });
    expect(check([apply("主角主动选择。", "写作方法。", { sourceId: "S-KB-CRAFT", quote: "主".repeat(81) })])).toMatchObject({ ok: false, code: "invalid_output" });
  });

  it("a wrong quote refuses the whole answer: it is never dropped, set to null or passed on", () => {
    const wrong = apply("计划用两次反转推动主角主动选择。", "写作方法。", { sourceId: "S-KB-CRAFT", quote: "反转次数以两次为最佳" });
    const result = check([apply("主角主动选择推动结果。", "写作方法。"), wrong]);
    expect(result).toEqual({ ok: false, code: "evidence_not_in_source", detail: "S-KB-CRAFT", field: "contentStructure[1].reference.quote" });
    expect("output" in result).toBe(false);
  });

  it("a quote may differ from the excerpt in whitespace only; other punctuation is refused (a known over-refusal)", () => {
    expect(check([apply("主角主动选择。", "写作方法。", { sourceId: "S-KB-CRAFT", quote: "关键结果 来自主角的选择和行动" })])).toMatchObject({ ok: true });
    expect(check([apply("主角主动选择。", "写作方法。", { sourceId: "S-KB-CRAFT", quote: "关键结果来自主角的选择和行动." })]))
      .toMatchObject({ ok: false, code: "evidence_not_in_source" });
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
    const quoting = { sourceId: "S-USER-1", quote: "七成观众爱看复仇" };
    for (const [reference, field, item] of [
      [quoting, "application.pattern", apply(text, "写作方法。", quoting)],
      [CRAFT, "application.why", apply("主角主动选择。", text, CRAFT)],
      [null, "application.why", apply("主角主动选择。", text, null)],
    ] as const) {
      expect(check([item]), `${String(reference?.sourceId)} ${field}`).toMatchObject({ ok: false, code, semantic, field: `contentStructure[0].${field}` });
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
  const v1: AutoStoredResearch = {
    schema: AUTO_CREATION_RESEARCH_SCHEMA_V1,
    facts: [], observations: [],
    hypotheses: [{ id: "H1", statement: "观众可能偏爱一集内兑现。", howToVerify: "计划上线后观察七天。" }],
    audience: { primary: "成年观众（假设）", viewingNeeds: ["看到结果"], emotionalAppeals: ["扳回一局"], basis: "hypothesis", sourceIds: [] },
    contentStructure: [{ pattern: "主角主动选择推动结果", why: "知识库要求关键结果来自主角的行动。", sourceIds: ["S-KB-CRAFT"] }],
    opportunities: ["小人物反击"], limitations: ["没有市场数据"], appliedConstraints: [],
  };
  const v2: AutoStoredResearch = { ...v1, schema: AUTO_CREATION_RESEARCH_SCHEMA_V2, contentStructure: [
    { reference: CRAFT, application: { pattern: "计划用两次反转推动主角主动选择。", why: "本作品的创作设计。" } },
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
    expect(current).toContain(`"参考方法原文":{"sourceId":"S-KB-CRAFT","quote":"${CRAFT_QUOTE}"}`);
    expect(current).toContain("\"参考方法原文\":\"无（自主创作设计）\"");
    expect(current).toContain("\"本剧应用设计\":{\"pattern\":\"计划用两次反转推动主角主动选择。\"");
  });

  it("the Markdown package marks a v1 item as historical and invents no quote; v2 shows the quote and the design apart", () => {
    const old = autoPackageMarkdown(meta, stagesWith(v1));
    expect(old).toContain("- 结构 1（历史版本，未区分参考原文与本剧应用）：主角主动选择推动结果：知识库要求关键结果来自主角的行动。（S-KB-CRAFT）");
    expect(old).not.toContain("参考方法原文：");
    const current = autoPackageMarkdown(meta, stagesWith(v2));
    expect(current).toContain(`  - 参考方法原文：S-KB-CRAFT「${CRAFT_QUOTE}」`);
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
