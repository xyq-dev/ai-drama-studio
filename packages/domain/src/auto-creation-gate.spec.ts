import { describe, expect, it } from "vitest";
import {
  AUTO_CREATION_DIRECTIONS_SCHEMA,
  AUTO_CREATION_RESEARCH_ANSWER_SCHEMA,
  AUTO_CREATION_RESEARCH_SCHEMA,
  autoCreationConstraintsSchema,
  type AutoCreationFrozenInput,
  type AutoResearch,
  type AutoStageRecord,
} from "@ai-drama/contracts";
import { OCEAN_ENGINE_ENTRY_URLS, collectSources } from "./auto-creation-sources";
import {
  autoContextFromStages, autoPackageJson, autoPackageMarkdown, autoResearchServerRecord, buildAutoCreationPrompt, validateAutoStageOutput, type AutoCreationContext,
} from "./auto-creation";
import { autoReferenceCatalog, autoReferenceCatalogOf } from "./auto-creation-references";
import { builtInSources } from "./auto-creation-sources";

/** Prompt v9: the catalog the research of a context chooses from, cut from its saved snapshot as the engines cut it. */
const withCatalog = (context: AutoCreationContext): AutoCreationContext => ({ ...context, referenceCatalog: autoReferenceCatalogOf(context.sources) });
/** The catalog id of the craft entry's sentence on a structure's key result (the same id in every snapshot that has it). */
const CRAFT_ID = autoReferenceCatalog({ schema: "ads.auto-creation.sources.v1", sources: builtInSources(), researchMode: "limited", notes: [] })
  .entries.find((entry) => entry.quote === "关键结果来自主角的选择和行动，不靠旁人突然解围。")!.referenceId;

/**
 * Research gate (research v3, prompt v5, checks v5). The settings and the source gaps are the server's record, never
 * the model's answer; a number the checks cannot place in creative text is kept as written with an unverified notice;
 * every other refusal stands and the whole answer is still read. Samples are synthetic, written for these tests: the
 * refused online answer (runId eb5632cc…, appliedConstraints[1]:chinese_numeral+unclassified+no_role) was not stored.
 */

const NOW = "2026-10-20T00:00:00.000Z";
const MONEY = "主角只剩五十元，必须在午夜前讨回工资。";
const PUZZLE = "失踪者留下三块拼图，主角逐场拼出真相。";

function input(overrides: Partial<AutoCreationFrozenInput> = {}): AutoCreationFrozenInput {
  return {
    schema: "ads.auto-creation.input.v1", promptVersion: "ads.auto-creation.prompt.v5", selectionRules: "ads.auto-creation.selection-rules.v1",
    checksVersion: "ads.auto-creation.checks.v5", idea: "", constraints: autoCreationConstraintsSchema.parse({}), materials: [], referenceUrls: [],
    researchFetch: false, episodeCount: 1, episodeSeconds: 60, revisionRounds: 0, callBudget: 6, maxOutputTokens: 4096, providerKey: "deepseek",
    model: "deepseek-flash", authorization: { mode: "auto", proof: "site_session", initiatedBy: "a", executor: "auto-creation-engine" }, ...overrides,
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

/** A legal answer to the limited contract (research v4): none of the sourced contract's fields. */
function answer(overrides: Record<string, unknown> = {}): string {
  const { facts: _facts, observations: _observations, audience, ...rest } = JSON.parse(sourcedAnswer(overrides)) as { audience: Record<string, unknown> } & Record<string, unknown>;
  const { basis: _basis, sourceIds: _sourceIds, ...text } = audience;
  return JSON.stringify({ ...rest, audience: text });
}

/** A legal answer to the sourced contract (the v3 shape: an observation of the craft entry, the audience a hypothesis). */
function sourcedAnswer(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: AUTO_CREATION_RESEARCH_ANSWER_SCHEMA,
    facts: [],
    observations: [{ id: "O1", statement: "写作方法资料强调关键结果来自主角自己的选择。", sourceIds: ["S-KB-CRAFT"] }],
    hypotheses: [{ id: "H1", statement: "碎片时间的观众可能更愿意看一集内有明确兑现的故事。", howToVerify: "计划上线后观察七天再判断。" }],
    audience: { primary: "拟面向通勤时刷剧的成年观众（待验证）", viewingNeeds: ["一集内看到结果"], emotionalAppeals: ["扳回一局"], basis: "hypothesis", sourceIds: [] },
    contentStructure: [{ referenceId: CRAFT_ID, application: { pattern: "主角主动选择推动结果", why: "写作方法要求。" } }],
    opportunities: ["小人物在一个夜晚完成一次反击"],
    ...overrides,
  });
}

const check = (overrides: Record<string, unknown>, frozen = input()) => validateAutoStageOutput("research", answer(overrides), frozen, context(frozen));
const checkSourced = (overrides: Record<string, unknown>, frozen = input()) => validateAutoStageOutput("research", sourcedAnswer(overrides), frozen, sourcedContext(frozen));
/** The limited contract with fields added on top as written: nothing stripped. */
const checkRaw = (extra: Record<string, unknown>) => validateAutoStageOutput("research", JSON.stringify({ ...JSON.parse(answer()) as object, ...extra }), input(), context());
const structure = (pattern: string, why = "自主创作设计。") => ({ contentStructure: [{ referenceId: null, application: { pattern, why } }] });
const hypothesis = (statement: string, howToVerify = "计划上线后观察七天再判断。") => ({ hypotheses: [{ id: "H1", statement, howToVerify }] });

describe("1. the settings and the source gaps are the server's record, from the frozen input and the snapshot only", () => {
  it("a legal answer is stored with the server's record and notices beside it, the answer itself unchanged", () => {
    const frozen = input({ constraints: autoCreationConstraintsSchema.parse({ genre: "都市", audience: "通勤上班族", maxCharacters: 3, forbiddenThemes: ["血腥"],
      endingRequirement: "主角拿回工资" }) });
    const result = check({}, frozen);
    expect(result.ok).toBe(true);
    const output = (result as { output: AutoResearch }).output;
    // The limited answer as written, and what the server assembles around it: no finding, the audience a hypothesis, the
    // stored schema research v4 and the chosen passage filled in from the catalog (prompt v9).
    const written = JSON.parse(answer()) as { audience: object; contentStructure: Array<{ application: object }> };
    expect({ ...written, schema: AUTO_CREATION_RESEARCH_SCHEMA, facts: [], observations: [], audience: { ...written.audience, basis: "hypothesis", sourceIds: [] },
      contentStructure: [{ reference: { sourceId: "S-KB-CRAFT", quote: "关键结果来自主角的选择和行动，不靠旁人突然解围。" }, application: written.contentStructure[0]!.application }] })
      .toEqual(Object.fromEntries(Object.entries(output).filter(([key]) => key !== "serverRecord" && key !== "unverified")));
    expect(output.unverified).toEqual([]);
    expect(output.serverRecord).toEqual(autoResearchServerRecord(frozen, context(frozen).sources!, context(frozen).referenceCatalog));
    expect(output.serverRecord.executedWith).toMatchObject({ promptVersion: "ads.auto-creation.prompt.v10", checksVersion: "ads.auto-creation.checks.v13",
      researchSchema: AUTO_CREATION_RESEARCH_SCHEMA, answerContract: "limited", answerSchema: AUTO_CREATION_RESEARCH_ANSWER_SCHEMA,
      referenceCatalogVersion: "ads.auto-creation.reference-catalog.v1", referenceCatalogHash: context(frozen).referenceCatalog!.hash });
    expect(output.serverRecord.settings).toEqual({ origin: "user_setting", items: [
      { key: "episodes", label: "集数", value: "共 1 集" },
      { key: "seconds", label: "每集时长", value: "约 60 秒，竖屏 9:16（写作目标，不是成片实测长度）" },
      { key: "genre", label: "题材", value: "都市" },
      { key: "audience", label: "目标观众", value: "通勤上班族（用户指定的创作目标，不是平台用户画像）" },
      { key: "maxCharacters", label: "出场人物上限", value: "最多 3 人" },
      { key: "forbiddenThemes", label: "禁止题材或元素", value: "血腥" },
      { key: "endingRequirement", label: "结局要求", value: "主角拿回工资" },
    ] });
  });

  it("a limit that was not set stays unset: no extra limit is made up", () => {
    const items = autoResearchServerRecord(input(), context().sources!).settings.items;
    expect(items.map((item) => item.key)).toEqual(["episodes", "seconds"]);
  });

  it("the material is the snapshot's: mode, what was read and how far, what could not be read, the gaps", () => {
    const frozen = input({ materials: [{ title: "我的笔记", kind: "notes", text: "主角是骑手。", rightsConfirmed: true }] });
    const material = autoResearchServerRecord(frozen, context(frozen).sources!).material;
    expect(material).toMatchObject({ origin: "source_snapshot", researchMode: "limited" });
    expect(material.read.map((item) => [item.sourceId, item.readScope])).toEqual([["S-KB-CRAFT", "full_text"], ["S-USER-1", "full_text"]]);
    expect(material.unread.map((item) => [item.sourceId, item.status])).toEqual([["S-OE-1", "unreadable"], ["S-OE-2", "unreadable"], ["S-OE-3", "unreadable"]]);
    expect(material.gaps).toEqual(context(frozen).sources!.notes);
    expect(material.gaps.join("")).toContain("不是实时市场验证");
  });

  it("the server's own text is never number-checked: a record full of numbers is stored as written", () => {
    // The online refusal's field was the model's restated constraints; the server writes them now, from trusted data.
    const frozen = input({ episodeCount: 6, episodeSeconds: 90, constraints: autoCreationConstraintsSchema.parse({ maxCharacters: 8, maxLocations: 6,
      endingRequirement: "三年后两人重逢，主角还清五十万" }) });
    const result = check({}, frozen);
    expect(result).toMatchObject({ ok: true, output: { unverified: [] } });
    expect((result as { output: AutoResearch }).output.serverRecord.settings.items.at(-1)).toEqual({ key: "endingRequirement", label: "结局要求",
      value: "三年后两人重逢，主角还清五十万" });
  });

  it.each([
    ["appliedConstraints", ["共 1 集，每集约 60 秒"]],
    ["limitations", ["官方条目没有读到正文。"]],
    ["serverRecord", { origin: "server_record", settings: { origin: "user_setting", items: [] } }],
    ["unverified", []],
  ])("a model sending %s is refused by the strict answer schema, named, never stripped", (key, value) => {
    expect(check({ [key]: value })).toEqual(expect.objectContaining({ ok: false, code: "invalid_output", field: key, category: "unrecognized_keys" }));
  });

  it("any other extra key is refused too, without its name (a model's key is model text)", () => {
    const result = check({ 采用约束: ["x"] });
    expect(result).toMatchObject({ ok: false, code: "invalid_output", category: "unrecognized_keys" });
    expect((result as { field?: string }).field).toBe("");
  });
});

describe("2. a number with no recognised role in creative text is an unverified notice; the text stays as written", () => {
  it.each([
    ["hypotheses[0].statement", hypothesis(MONEY), "五十元"],
    ["hypotheses[0].howToVerify", hypothesis("碎片时间的观众可能偏爱一集内兑现。", "计划先试看主角只剩五十元那一场，再决定是否保留。"), "五十元"],
    ["contentStructure[0].application.pattern", structure(PUZZLE), "三块"],
    ["contentStructure[0].application.why", structure("实物线索推动主角行动", PUZZLE), "三块"],
    ["opportunities[0]", { opportunities: [MONEY] }, "五十元"],
  ])("%s", (field, overrides, token) => {
    const result = check(overrides);
    expect(result).toMatchObject({ ok: true, output: { unverified: [{ origin: "server_check", field, token, semantic: "unclassified", rule: "no_role",
      note: "程序未能判定数字含义，未核实" }] } });
    // Kept word for word: every text of the answer is in the stored output, nothing removed, cut or rewritten (but the
    // answer schema and the catalog ids, which the server replaces with research v4 and the chosen passages).
    const written = textsOf(JSON.parse(answer(overrides))).filter((text) => text !== AUTO_CREATION_RESEARCH_ANSWER_SCHEMA && text !== CRAFT_ID);
    expect(textsOf((result as { output: AutoResearch }).output)).toEqual(expect.arrayContaining(written));
  });

  it("each such number gets its own notice, and a cited structure's application is read the same way", () => {
    const result = check({ ...structure(PUZZLE), opportunities: [MONEY, "门牌 302 的住户最后出现。"],
      contentStructure: [{ referenceId: CRAFT_ID, application: { pattern: PUZZLE, why: MONEY } }] });
    expect(result).toMatchObject({ ok: true, output: { unverified: [
      { field: "contentStructure[0].application.pattern", token: "三块" },
      { field: "contentStructure[0].application.why", token: "五十元" },
      { field: "opportunities[0]", token: "五十元" },
      { field: "opportunities[1]", token: "302" },
    ] } });
  });

  it("the other unclassified sub-rules are not relaxed: a date and a count out of range are still refused", () => {
    expect(check({ opportunities: ["2026-10-18 之后再上线"] })).toMatchObject({ ok: false, semantic: "unclassified", rule: "date_or_range" });
    expect(check({ opportunities: ["主角带着四十个同事罢工"] })).toMatchObject({ ok: false, semantic: "unclassified", rule: "count_out_of_range" });
  });

  it("a cited text or an audience gets no notice: those numbers still need their source or a pending mark", () => {
    expect(checkSourced({ observations: [{ id: "O1", statement: MONEY, sourceIds: ["S-KB-CRAFT"] }] }))
      .toMatchObject({ ok: false, code: "unsourced_number", semantic: "unsourced", field: "observations[0].statement" });
    expect(check({ audience: { primary: "只剩五十元的年轻人（待验证）", viewingNeeds: ["x"], emotionalAppeals: ["y"], basis: "hypothesis", sourceIds: [] } }))
      .toMatchObject({ ok: false, code: "unsourced_number", field: "audience.primary" });
  });
});

describe("3. a notice opens nothing: every later number, quote, claim and setting in the answer is still checked", () => {
  it.each([
    ["a share later in the same clause", { opportunities: ["主角只剩五十元，七成观众偏爱反转。"] }, "opportunities[0]", "market_statistic"],
    ["a share in the next sentence of the same field", { opportunities: ["主角只剩五十元。七成观众偏爱反转。"] }, "opportunities[0]", "market_statistic"],
    ["a share in a later field", { ...hypothesis(MONEY), opportunities: ["七成观众偏爱反转"] }, "opportunities[0]", "market_statistic"],
    ["an audience count after a notice", { opportunities: [`${MONEY}五百用户会追更。`] }, "opportunities[0]", "market_statistic"],
    ["a measured result after a notice", { opportunities: ["主角只剩五十元，调查显示两个版本中反转版更受欢迎。"] }, "opportunities[0]", "result_claim"],
    ["a reception by counted people after a notice", { opportunities: [`${MONEY}八名试映嘉宾都给了好评。`] }, "opportunities[0]", "result_claim"],
  ])("%s", (_label, overrides, field, semantic) => {
    expect(check(overrides)).toMatchObject({ ok: false, code: "unsourced_number", field, semantic });
  });

  it("a frozen conflict after a notice: episodes, length, cast and places", () => {
    const frozen = input({ constraints: autoCreationConstraintsSchema.parse({ maxCharacters: 2, maxLocations: 1 }) });
    for (const [statement, rule] of [[`${MONEY}共 3 集讲完。`, "episode_count"], [`${MONEY}每集约 90 秒。`, "over_length"],
      [`${MONEY}三个人物被迫合作。`, "cast_over_limit"], [`${MONEY}地点最多 3 个。`, "locations_over_limit"], [`${PUZZLE}人物最多 5 个。`, "cast_over_limit"]] as const) {
      expect(check({ opportunities: [statement] }, frozen), statement).toMatchObject({ ok: false, code: "constraint_violation", semantic: "frozen_conflict", rule });
    }
  });

  it("a model-written quote, an id the catalog lacks and a settled claim after a notice", () => {
    const later = (item: unknown) => ({ contentStructure: [{ referenceId: null, application: { pattern: PUZZLE, why: "自主创作设计。" } }, item] });
    expect(check(later({ reference: { sourceId: "S-KB-CRAFT", quote: "反转次数以两次为最佳" }, application: { pattern: "p", why: "w" } })))
      .toMatchObject({ ok: false, code: "invalid_output", field: "contentStructure[1].reference", category: "unrecognized_keys" });
    expect(check(later({ referenceId: "R-0000000000", application: { pattern: "p", why: "w" } })))
      .toMatchObject({ ok: false, code: "unknown_reference", field: "contentStructure[1].referenceId" });
    expect(check(later({ referenceId: null, application: { pattern: "调查证明观众更喜欢反转。", why: "w" } })))
      .toMatchObject({ ok: false, code: "unsourced_claim", field: "contentStructure[1].application.pattern" });
    expect(checkSourced({ ...structure(PUZZLE), facts: [{ id: "F1", statement: "x", sourceIds: ["S-KB-CRAFT"], evidence: "知识库里没有这句话" }] }))
      .toMatchObject({ ok: false, code: "evidence_not_in_source", field: "facts[0].evidence" });
  });

  it("a sourced audience, a duplicate id and a schema error after a notice", () => {
    // research v4: a limited answer has no audience basis at all (refused whole); a sourced one may not claim it from craft.
    expect(checkRaw({ ...structure(PUZZLE), audience: { primary: "成年观众", viewingNeeds: ["x"], emotionalAppeals: ["y"], basis: "sourced", sourceIds: ["S-KB-CRAFT"] } }))
      .toMatchObject({ ok: false, code: "invalid_output", field: "audience.basis", semantic: "limited_contract", rule: "forbidden_field" });
    expect(checkSourced({ ...structure(PUZZLE), audience: { primary: "成年观众", viewingNeeds: ["x"], emotionalAppeals: ["y"], basis: "sourced", sourceIds: ["S-KB-CRAFT"] } }))
      .toMatchObject({ ok: false, code: "unsourced_claim", field: "audience.basis" });
    expect(check({ ...structure(PUZZLE), hypotheses: [{ id: "H1", statement: MONEY, howToVerify: "计划试看。" }, { id: "H1", statement: "s", howToVerify: "h" }] }))
      .toMatchObject({ ok: false, code: "duplicate_id" });
    expect(check({ ...structure(PUZZLE), opportunities: [] })).toMatchObject({ ok: false, code: "invalid_output", field: "opportunities" });
  });
});

describe("4. later prompts and the package keep a notice a hypothesis or design, never a fact", () => {
  const stage = (stageKey: string, ordinal: number, output: unknown): AutoStageRecord => ({ runId: "r", stageKey, ordinal, state: "completed", attemptNo: 1,
    errorCode: null, output: output as AutoStageRecord["output"], outputHash: "h", dependsOn: null, scriptSave: null, scriptRevisionId: null, updatedAt: NOW });
  const research = () => (check({ ...structure(PUZZLE), opportunities: [MONEY] }) as { output: AutoResearch }).output;
  const directions = (differentiation: string) => JSON.stringify({ schema: AUTO_CREATION_DIRECTIONS_SCHEMA,
    candidates: ["D1", "D2"].map((id, index) => ({ id, title: id, logline: `${id}：一个故事`, protagonist: "p", goal: "g", obstacle: "o", stakes: "s", coreEmotion: "e",
      differentiation: index === 0 ? differentiation : "d", productionDifficulty: "low", difficultyNote: "n", audienceFit: "可能契合想看小人物扳回一局的观众，待验证 H1",
      evidenceIds: ["H1"], ratings: { audienceFit: 4, conflictStrength: 4, originality: 4, feasibility: 4, constraintFit: 4 } })) });

  it("a direction's notes get notices the same way; its audience fit and every other check stay as they were", () => {
    const ctx = { ...context(), research: research() };
    expect(validateAutoStageOutput("directions", directions("用三块拼图代替三角恋"), input(), ctx)).toMatchObject({ ok: true,
      output: { unverified: [{ field: "candidates[0].differentiation", token: "三块" }] } });
    expect(validateAutoStageOutput("directions", directions("用三块拼图代替三角恋，七成观众偏爱反转"), input(), ctx))
      .toMatchObject({ ok: false, field: "candidates[0].differentiation", semantic: "market_statistic" });
  });

  it("the directions prompt names the record and every notice as unverified, apart from the hypotheses", () => {
    const stages = [stage("sources", 0, collectSources(input(), [], NOW)), stage("research", 1, research())];
    const prompt = buildAutoCreationPrompt("directions", input(), autoContextFromStages(stages)).user;
    expect(prompt).toContain("\"资料记录\":{\"说明\":\"服务端按本次资料快照记录，不是 AI 调研结论\"");
    expect(prompt).toContain("\"未核实提示\":[\"第1条内容结构的本剧应用设计中的「三块」：程序未能判定数字含义，未核实");
    expect(prompt).toContain("第1条机会中的「五十元」：程序未能判定数字含义，未核实");
    expect(prompt).toContain("不能写成事实、平台用户画像或已验证的市场结论");
    expect(prompt).not.toContain("\"serverRecord\"");
    // No fetch date of an unread entry is offered for quoting.
    expect(prompt.slice(prompt.indexOf("\"资料记录\""))).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
  });

  it("the Markdown and JSON package keep the answer, the record and the notices apart", () => {
    const stages = [stage("sources", 0, collectSources(input(), [], NOW)), stage("research", 1, research())];
    const meta = { runId: "r", projectId: "p", input: input(), quality: "pending", state: "running", callsUsed: 1, callCap: 6, revisionRoundsUsed: 0,
      storySave: "pending", generatedAt: NOW };
    const markdown = autoPackageMarkdown(meta, stages);
    expect(markdown).toContain("**AI 创作假设与验证计划**（假设未经验证；验证计划尚未执行，不是调查结果）");
    expect(markdown).toContain(`**机会**（AI 创作判断）：${MONEY}〔含未核实数字，见下方未核实提示〕`);
    expect(markdown).toContain(`  - 本剧应用设计：${PUZZLE}：自主创作设计。〔含未核实数字，见下方未核实提示〕`);
    expect(markdown).toContain("**用户设定与资料记录**（来自用户设定和服务端记录，不是 AI 调研结论）");
    expect(markdown).toContain("- 资料模式：AI 创作策划（市场证据不可用，不是实时市场验证）");
    expect(markdown).toContain("- 未读取：S-OE-1「巨量引擎帮助中心条目（标题未能读取）」（unreadable）");
    expect(markdown).toContain("- 第1条内容结构的本剧应用设计中的「三块」：程序未能判定数字含义，未核实");
    expect(markdown).not.toContain("**局限**");
    const json = autoPackageJson(meta, stages) as { research: { analysis: AutoResearch; identity: Record<string, string> } };
    expect(json.research.analysis).toEqual(research());
    expect(json.research.identity.serverRecord).toContain("不是 AI 调研结论");
    expect(json.research.identity.unverified).toContain("程序未能判定数字或时长含义，未核实");
  });
});

describe("5. structural protections are unchanged", () => {
  it("a setting over the frozen cast or place limit is refused, whatever the research said", () => {
    const frozen = input({ constraints: autoCreationConstraintsSchema.parse({ maxCharacters: 2, maxLocations: 1 }) });
    const bible = (characters: number, locations: number) => JSON.stringify({
      schema: "ads.auto-creation.bible.v1", title: "t", logline: "l", synopsis: "s",
      story: { protagonistId: "C1", desire: "d", weakness: "w", goal: "g", stakes: "s", obstacles: ["o"], keyChoices: [{ choice: "c", consequence: "q" }],
        twist: { reveal: "r", setups: ["s"] }, payoffs: ["p"], ending: "e", causalChain: ["a", "b", "c"] },
      characters: Array.from({ length: characters }, (_, index) => ({ id: `C${String(index + 1)}`, name: `人${String(index + 1)}`, identity: "i", goal: "g", weakness: "w",
        motivation: "m", voice: "v", presence: "on_screen" })),
      relationships: [],
      locations: Array.from({ length: locations }, (_, index) => ({ id: `L${String(index + 1)}`, name: `地${String(index + 1)}`, intExt: "INT", timeOfDay: "夜",
        layout: "l", productionNotes: "p" })),
      props: [],
    });
    const ctx = context(frozen);
    expect(validateAutoStageOutput("bible", bible(3, 1), frozen, ctx)).toMatchObject({ ok: false, code: "constraint_violation", detail: "maxCharacters" });
    expect(validateAutoStageOutput("bible", bible(2, 2), frozen, ctx)).toMatchObject({ ok: false, code: "constraint_violation", detail: "maxLocations" });
    expect(validateAutoStageOutput("bible", bible(2, 1), frozen, ctx)).toMatchObject({ ok: true });
  });
});

describe("6. PR #82 review: a count is a cast, a place or a verdict only when it counts one; a notice names its item's place", () => {
  /** The statement in every creative field the review named: hypothesis, opportunity, and an application with and without a reference. */
  const places = (statement: string): Array<[string, Record<string, unknown>]> => [
    ["hypotheses[0].statement", hypothesis(statement)],
    ["hypotheses[0].howToVerify", hypothesis("碎片时间的观众可能偏爱一集内兑现。", statement)],
    ["opportunities[0]", { opportunities: [statement] }],
    ["contentStructure[0].application.pattern", structure(statement)],
    ["contentStructure[0].application.why", structure("实物线索推动主角行动", statement)],
    ["contentStructure[0].application.pattern", { contentStructure: [{ referenceId: CRAFT_ID, application: { pattern: statement, why: "本剧设计。" } }] }],
    ["contentStructure[0].application.why", { contentStructure: [{ referenceId: CRAFT_ID, application: { pattern: "实物线索推动主角行动", why: statement } }] }],
  ];
  const cast2 = input({ constraints: autoCreationConstraintsSchema.parse({ maxCharacters: 2 }) });
  const place2 = input({ constraints: autoCreationConstraintsSchema.parse({ maxLocations: 2 }) });

  it.each([
    // 1. 位 alone says nothing of people: digits of a code, decimal places.
    ["主角破解三位数密码。", "三位", cast2],
    ["账本金额保留两位小数，主角发现差额。", "两位", cast2],
    // 2. The amount counts no reviewer: the bad review is a prop of the plot.
    ["主角用五十元购买一条差评作为追凶线索。", "五十元", input()],
    // 3. 场景为 / 角色为 before a count of something else is no place or cast.
    ["场景为三块拼图散落在桌上。", "三块", place2],
    ["角色为五十元奖金冒险。", "五十元", cast2],
  ] as const)("%s is kept with an unverified notice in every creative field", (statement, token, frozen) => {
    for (const [field, overrides] of places(statement)) {
      const result = check(overrides, frozen);
      expect(result, `${field}: ${statement}`).toMatchObject({ ok: true, output: { unverified: [{ field, token, semantic: "unclassified", rule: "no_role" }] } });
      expect(textsOf((result as { output: AutoResearch }).output)).toContain(statement);
    }
  });

  it.each([
    ["三位专家一致推荐。", input(), "result_claim"],
    ["八名试映嘉宾都给了好评。", input(), "result_claim"],
    ["三名学生都给了好评。", input(), "result_claim"],
    ["五位资深编剧都认为这种结构最抓人。", input(), "result_claim"],
    ["约三成观众偏爱反转。", input(), "market_statistic"],
    ["主角破解三位数密码，七成观众偏爱反转。", cast2, "market_statistic"],
    ["主角用五十元购买一条差评作为追凶线索。三位专家一致推荐。", input(), "result_claim"],
  ] as const)("still refused in every creative field: %s", (statement, frozen, semantic) => {
    for (const [field, overrides] of places(statement)) {
      expect(check(overrides, frozen), `${field}: ${statement}`).toMatchObject({ ok: false, code: "unsourced_number", field, semantic });
    }
  });

  it.each([
    ["地点最多 4 个。", input({ constraints: autoCreationConstraintsSchema.parse({ maxLocations: 3 }) }), "locations_over_limit"],
    ["场景不超过 3 个。", place2, "locations_over_limit"],
    ["人物上限 3 人。", cast2, "cast_over_limit"],
    ["角色上限 5。", cast2, "cast_over_limit"],
    ["三个人物被迫合作。", cast2, "cast_over_limit"],
    ["场景为三块拼图散落在桌上，地点最多 3 个。", place2, "locations_over_limit"],
  ] as const)("a real limit conflict is still a frozen conflict in every creative field: %s", (statement, frozen, rule) => {
    for (const [field, overrides] of places(statement)) {
      expect(check(overrides, frozen), `${field}: ${statement}`).toMatchObject({ ok: false, code: "constraint_violation", field, rule });
    }
  });

  it("4. a notice names the item by its position and keeps the model's own id; ids need not follow the order", () => {
    const stage = (stageKey: string, ordinal: number, output: unknown): AutoStageRecord => ({ runId: "r", stageKey, ordinal, state: "completed", attemptNo: 1,
      errorCode: null, output: output as AutoStageRecord["output"], outputHash: "h", dependsOn: null, scriptSave: null, scriptRevisionId: null, updatedAt: NOW });
    const meta = { runId: "r", projectId: "p", input: input(), quality: "pending", state: "running", callsUsed: 1, callCap: 6, revisionRoundsUsed: 0,
      storySave: "pending", generatedAt: NOW };
    for (const [hypotheses, expected] of [
      [[{ id: "H3", statement: MONEY, howToVerify: "计划试看。" }], "第1条假设（H3）中的「五十元」"],
      [[{ id: "H3", statement: "可能偏爱一集内兑现。", howToVerify: "计划试看。" }, { id: "H1", statement: MONEY, howToVerify: "计划试看。" }], "第2条假设（H1）中的「五十元」"],
      [[{ id: "H3", statement: "可能偏爱一集内兑现。", howToVerify: `计划先试看${MONEY}` }], "第1条假设（H3）的验证计划中的「五十元」"],
    ] as const) {
      const result = check({ hypotheses });
      expect(result.ok).toBe(true);
      const research = (result as { output: AutoResearch }).output;
      const stages = [stage("sources", 0, collectSources(input(), [], NOW)), stage("research", 1, research)];
      const markdown = autoPackageMarkdown(meta, stages);
      const prompt = buildAutoCreationPrompt("directions", input(), autoContextFromStages(stages)).user;
      for (const text of [markdown, prompt]) {
        expect(text).toContain(expected);
        expect(text).not.toMatch(/假设 H\d中的/u);
      }
    }
    // Other items by position; a direction keeps its id, which the directions check holds to D1, D2… in order.
    const opportunity = (check({ ...structure(PUZZLE), opportunities: ["小人物反击", MONEY] }) as { output: AutoResearch }).output;
    const stages = [stage("sources", 0, collectSources(input(), [], NOW)), stage("research", 1, opportunity)];
    const markdown = autoPackageMarkdown(meta, stages);
    expect(markdown).toContain("- 第1条内容结构的本剧应用设计中的「三块」");
    expect(markdown).toContain("- 第2条机会中的「五十元」");
  });
});

function textsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textsOf);
  if (value && typeof value === "object") return Object.values(value).flatMap(textsOf);
  return [];
}
