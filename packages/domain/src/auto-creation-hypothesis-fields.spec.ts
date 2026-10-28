import { describe, expect, it } from "vitest";
import {
  AUTO_CREATION_RESEARCH_ANSWER_SCHEMA,
  autoCreationConstraintsSchema,
  autoResearchAnswerSchema,
  autoResearchLimitedAnswerSchema,
  type AutoCreationFrozenInput,
} from "@ai-drama/contracts";
import { OCEAN_ENGINE_ENTRY_URLS, collectSources } from "./auto-creation-sources";
import { buildAutoCreationPrompt, validateAutoStageOutput, type AutoCreationContext } from "./auto-creation";
import { autoReferenceCatalogOf } from "./auto-creation-references";

/** Prompt v9: the catalog the research of a context chooses from, cut from its saved snapshot as the engines cut it. */
const withCatalog = (context: AutoCreationContext): AutoCreationContext => ({ ...context, referenceCatalog: autoReferenceCatalogOf(context.sources) });

// Hypothesis fields (prompt v8). A real series run (DeepSeek, 60 episodes of 60 s, plan + episodes 1–3) was refused at
// its first research call as invalid_output@hypotheses[3]:unrecognized_keys; the refused answer was not kept, so the
// extra key is NOT known and nothing here reproduces it. The `extra` field and every text below are SYNTHETIC samples.

const NOW = "2026-10-25T00:00:00.000Z";

function input(): AutoCreationFrozenInput {
  return {
    schema: "ads.auto-creation.input.v1", promptVersion: "ads.auto-creation.prompt.v8", selectionRules: "ads.auto-creation.selection-rules.v1",
    checksVersion: "ads.auto-creation.checks.v7", idea: "", constraints: autoCreationConstraintsSchema.parse({}), materials: [], referenceUrls: [],
    researchFetch: false, episodeCount: 1, episodeSeconds: 60, revisionRounds: 0, callBudget: 6, maxOutputTokens: 4096, providerKey: "deepseek",
    model: "m", authorization: { mode: "auto", proof: "site_session", initiatedBy: "a", executor: "auto-creation-engine" },
  };
}

const limitedContext = (): AutoCreationContext => (withCatalog({ sources: collectSources(input(), [], NOW), episodes: new Map(), reviews: [] }));

/** A recent, readable market page (synthetic, no number in it): the snapshot is then sourced. */
const sourcedContext = (): AutoCreationContext => withCatalog({
  sources: collectSources(input(), [{ url: OCEAN_ENGINE_ENTRY_URLS[0], status: "read", title: "合成市场样本页", text: "合成样本：本页只描述题材趋势，没有统计数字。",
    publishedAt: "2026-09-01T00:00:00.000Z", fetchedAt: NOW, note: "合成样本" }], NOW),
  episodes: new Map(), reviews: [],
});

const MODES = [["limited", limitedContext], ["sourced", sourcedContext]] as const;

/** Four legal hypotheses (synthetic). */
const FOUR = [
  { id: "H1", statement: "合成样本：开场就让主角做出冒险选择，可能更容易让观众代入。", howToVerify: "计划请试看者复述主角的选择。" },
  { id: "H2", statement: "合成样本：误会在结尾解开，可能比中途解开更有悬念。", howToVerify: "计划比较两种解开时机的试看反馈。" },
  { id: "H3", statement: "合成样本：反派有可理解的动机，可能让冲突更可信。", howToVerify: "计划请试看者说出反派想要什么。" },
  { id: "H4", statement: "合成样本：结尾留一个小悬念，可能让观众想看下一集。", howToVerify: "计划询问试看者是否想知道后续。" },
];

function answer(mode: "limited" | "sourced", hypotheses: unknown[]): string {
  const creative = {
    hypotheses,
    contentStructure: [{ referenceId: null, application: { pattern: "主角主动选择推动结果", why: "自主创作设计，没有对应的方法资料。" } }],
    opportunities: ["小人物在一个夜晚完成一次反击"],
  };
  const audience = { primary: "在通勤和睡前刷短剧的成年观众（待验证假设）", viewingNeeds: ["一集内看到结果"], emotionalAppeals: ["扳回一局"] };
  return JSON.stringify(mode === "limited"
    ? { schema: AUTO_CREATION_RESEARCH_ANSWER_SCHEMA, ...creative, audience }
    : { schema: AUTO_CREATION_RESEARCH_ANSWER_SCHEMA, facts: [], observations: [], ...creative, audience: { ...audience, basis: "hypothesis", sourceIds: [] } });
}

/** The example object the prompt gives for one hypothesis. */
function promptExample(prompt: string): Record<string, unknown> {
  const match = /假设对象示例[^：]*：(\{[^\n]*?\})/u.exec(prompt);
  expect(match, "the prompt gives a hypothesis example").not.toBeNull();
  return JSON.parse(match![1]!) as Record<string, unknown>;
}

describe("A. both research prompts name every field of one hypothesis (prompt v8)", () => {
  it.each(MODES)("%s: hypotheses is an array of objects with exactly id, statement and howToVerify, nothing else", (_mode, context) => {
    const prompt = buildAutoCreationPrompt("research", input(), context()).user;
    expect(prompt).toContain("提示版本：ads.auto-creation.prompt.v11");
    expect(prompt).toContain("hypotheses 是数组");
    expect(prompt).toContain("每条假设是一个对象，只包含 id、statement、howToVerify 三个字段，三个都必填");
    expect(prompt).toContain("不要给假设添加任何其他字段");
    expect(prompt).toMatch(/空值、空数组/u);
    expect(prompt).toContain("H1");
    expect(prompt).toContain("200");
    expect(prompt).toContain("150");
  });

  it("the two modes share one field description (no drift)", () => {
    const fieldLines = (context: AutoCreationContext) => buildAutoCreationPrompt("research", input(), context).user.split("\n")
      .filter((line) => line.startsWith("hypotheses 是数组") || line.startsWith("假设对象示例"));
    const limited = fieldLines(limitedContext());
    expect(limited).toHaveLength(2);
    expect(fieldLines(sourcedContext())).toEqual(limited);
  });

  it.each(MODES)("%s: the example has only the three fields and passes the contract and the checks of its mode", (mode, context) => {
    const example = promptExample(buildAutoCreationPrompt("research", input(), context()).user);
    expect(Object.keys(example)).toEqual(["id", "statement", "howToVerify"]);
    // No market statistic, count or survey result: the example carries no number at all.
    const prose = `${String(example.statement)}${String(example.howToVerify)}`;
    expect(prose).not.toMatch(/[0-9０-９%％]|[一二三四五六七八九十百千万两]|几成/u);
    expect(prose).not.toMatch(/调查显示|数据显示|已经测试|已测得/u);
    expect(validateAutoStageOutput("research", answer(mode, [example]), input(), context())).toMatchObject({ ok: true });
  });

  it("the limited prompt still names no field of the sourced contract or of the server", () => {
    const prompt = buildAutoCreationPrompt("research", input(), limitedContext()).user;
    for (const field of ["facts", "observations", "basis", "sourceIds", "limitations", "appliedConstraints", "evidence"]) expect(prompt, field).not.toContain(field);
  });
});

describe("B. the strict contract is unchanged: one extra key refuses the whole answer, nothing is stripped", () => {
  it.each(MODES)("%s: four legal hypotheses pass", (mode, context) => {
    const result = validateAutoStageOutput("research", answer(mode, FOUR), input(), context());
    expect(result).toMatchObject({ ok: true });
    const output = (result as { output: { hypotheses: Array<Record<string, unknown>> } }).output;
    expect(output.hypotheses.map((item) => Object.keys(item))).toEqual(FOUR.map(() => ["id", "statement", "howToVerify"]));
  });

  it.each(MODES)("%s: a synthetic extra field on the fourth hypothesis is refused whole at hypotheses[3], unrecognized_keys", (mode, context) => {
    const hypotheses = [...FOUR.slice(0, 3), { ...FOUR[3], extra: "合成多余字段" }];
    const result = validateAutoStageOutput("research", answer(mode, hypotheses), input(), context());
    expect(result).toMatchObject({ ok: false, code: "invalid_output", field: "hypotheses[3]", category: "unrecognized_keys" });
    expect(result).not.toHaveProperty("output");
    // Not a fixed contract field: neither the limited rule nor a server key is named.
    expect(result).not.toHaveProperty("semantic");
    // The schema itself refuses it: nothing is dropped before the check.
    const schema = mode === "limited" ? autoResearchLimitedAnswerSchema : autoResearchAnswerSchema;
    expect(schema.safeParse(JSON.parse(answer(mode, hypotheses))).success).toBe(false);
  });

  it.each([[null], [""], [[]]])("an extra field that is empty (%j) is refused the same way", (value) => {
    const hypotheses = [...FOUR.slice(0, 3), { ...FOUR[3], extra: value }];
    expect(validateAutoStageOutput("research", answer("limited", hypotheses), input(), limitedContext()))
      .toMatchObject({ ok: false, code: "invalid_output", field: "hypotheses[3]", category: "unrecognized_keys" });
  });

  it.each([
    ["a missing howToVerify", { id: "H4", statement: FOUR[3]!.statement }, "hypotheses[3].howToVerify", "invalid_type"],
    ["a missing id", { statement: FOUR[3]!.statement, howToVerify: FOUR[3]!.howToVerify }, "hypotheses[3].id", "invalid_type"],
    ["a number as statement", { ...FOUR[3], statement: 3 }, "hypotheses[3].statement", "invalid_type"],
    ["an array as howToVerify", { ...FOUR[3], howToVerify: ["计划询问试看者"] }, "hypotheses[3].howToVerify", "invalid_type"],
  ])("%s is still refused", (_label, fourth, field, category) => {
    for (const [mode, context] of MODES) {
      expect(validateAutoStageOutput("research", answer(mode, [...FOUR.slice(0, 3), fourth]), input(), context()), mode)
        .toMatchObject({ ok: false, code: "invalid_output", field, category });
    }
  });
});
