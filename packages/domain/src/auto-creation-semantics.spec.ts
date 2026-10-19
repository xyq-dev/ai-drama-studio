import { describe, expect, it } from "vitest";
import {
  AUTO_CREATION_DIRECTIONS_SCHEMA,
  AUTO_CREATION_RESEARCH_SCHEMA,
  autoCreationConstraintsSchema,
  type AutoCreationFrozenInput,
} from "@ai-drama/contracts";
import { collectSources } from "./auto-creation-sources";
import { buildAutoCreationPrompt, validateAutoStageOutput, type AutoCreationContext } from "./auto-creation";

// Research semantics (checks v3): a number is judged by what it counts. The failed real run (DeepSeek, 1 episode, 60 s,
// no rounds, budget 6, limited mode) was refused at unsourced_number@hypotheses[0].statement:chinese_numeral; its answer
// was not kept, so the sentence that tripped the check is NOT known. Every text below is a SYNTHETIC sample.

const NOW = "2026-10-18T00:00:00.000Z";

function input(overrides: Partial<AutoCreationFrozenInput> = {}): AutoCreationFrozenInput {
  return {
    schema: "ads.auto-creation.input.v1", promptVersion: "ads.auto-creation.prompt.v3", selectionRules: "ads.auto-creation.selection-rules.v1",
    checksVersion: "ads.auto-creation.checks.v3", idea: "", constraints: autoCreationConstraintsSchema.parse({}), materials: [], referenceUrls: [],
    researchFetch: false, episodeCount: 1, episodeSeconds: 60, revisionRounds: 0, callBudget: 6, maxOutputTokens: 4096, providerKey: "deepseek",
    model: "m", authorization: { mode: "auto", proof: "site_session", initiatedBy: "a", executor: "auto-creation-engine" }, ...overrides,
  };
}

function context(frozen = input()): AutoCreationContext {
  return { sources: collectSources(frozen, [], NOW), episodes: new Map(), reviews: [] };
}

/** A legal limited-mode answer: no facts, an observation of the craft entry, every audience judgement a hypothesis. */
function limited(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: AUTO_CREATION_RESEARCH_SCHEMA,
    facts: [],
    observations: [{ id: "O1", statement: "写作方法资料强调关键结果来自主角自己的选择。", sourceIds: ["S-KB-CRAFT"] }],
    hypotheses: [{ id: "H1", statement: "碎片时间的观众可能更愿意看一集内有明确兑现的故事。", howToVerify: "上线后用真实观看数据对比。" }],
    audience: { primary: "在通勤和睡前刷短剧的成年观众（待验证假设）", viewingNeeds: ["一集内看到结果"], emotionalAppeals: ["扳回一局"], basis: "hypothesis", sourceIds: [] },
    contentStructure: [{ pattern: "主角主动选择推动结果", why: "写作方法资料要求关键结果来自主角的行动。", sourceIds: ["S-KB-CRAFT"] }],
    opportunities: ["小人物在一个夜晚完成一次反击"],
    limitations: ["官方市场条目没有读到正文，受众和题材判断都是待验证假设。"],
    appliedConstraints: ["共 1 集，每集约 60 秒"],
    ...overrides,
  });
}

const hypothesis = (statement: string, howToVerify = "上线后用真实观看数据对比。") => ({ hypotheses: [{ id: "H1", statement, howToVerify }] });

describe("A. creative quantities and plans are not market claims", () => {
  // The three samples Codex reproduced against the deployed checks (each refused as chinese_numeral before v3).
  it.each([
    "两个互不信任的人被迫共同寻找真相，这种设定可能带来悬念。",
    "通过三次误会逐步揭露人物动机，是本故事拟采用的创作方案。",
    "受众是否喜欢这种结尾，计划比较两个版本后再判断。",
  ])("reproduced sample passes: %s", (statement) => {
    expect(validateAutoStageOutput("research", limited(hypothesis(statement)), input(), context())).toMatchObject({ ok: true });
  });

  it.each([
    ["两次反转", "主角经历两次反转后才发现真相，可能更有悬念。"],
    ["2 次反转（数字）", "主角经历 2 次反转后才发现真相，可能更有悬念。"],
    ["3 个人物", "只用 3 个人物讲完冲突，便于拍摄。"],
    ["两人", "两人在雨夜对峙，冲突集中。"],
    ["虚构年龄", "主角是二十八岁的外卖骑手，设定为一个人扛下全部债务。"],
    ["虚构年龄（数字）", "女主 32 岁，刚被公司裁员。"],
    ["故事内期限", "主角必须在三天内还清债务。"],
    ["开场秒数", "开场前 3 秒抛出冲突。"],
    ["开场秒数（中文）", "第十秒揭开第一个反转。"],
    ["多个伏笔", "埋下两个伏笔，最后一场全部兑现。"],
  ])("story quantity (%s) in a hypothesis passes", (_label, statement) => {
    expect(validateAutoStageOutput("research", limited(hypothesis(statement)), input(), context())).toMatchObject({ ok: true });
  });

  it.each([
    ["比较两个版本", "拟比较两个版本的结尾。"],
    ["观察七天", "计划上线后观察七天，再决定是否追加。"],
    ["观察 7 天完播", "上线后统计 7 天完播率，对比两个版本。"],
    ["两次反转版本是否更受喜欢", "待验证观众是否更喜欢两次反转的版本。"],
  ])("verification plan (%s) passes", (_label, howToVerify) => {
    expect(validateAutoStageOutput("research", limited(hypothesis("可能偏爱一集内兑现的故事。", howToVerify)), input(), context())).toMatchObject({ ok: true });
  });

  // Independent review (before commit): ordinary plan and story wording the first v3 draft refused.
  it.each([
    "对比两个版本的完播率。", "统计两个版本的完播率。", "收集观众对两个版本的反馈。", "拟比较两个结尾版本的观众留存。", "计划收集观众对两个版本的评论。",
    "收集观众对两个版本的评论。", "观众是否会在前3秒被钩子吸引。", "计划观察观众是否在前3秒被钩子吸引。", "观众可能在开头3秒内决定是否继续看。",
  ])("plan wording passes as a verification plan: %s", (howToVerify) => {
    expect(validateAutoStageOutput("research", limited(hypothesis("可能偏爱反转。", howToVerify)), input(), context()), howToVerify).toMatchObject({ ok: true });
  });

  it.each([
    "一位30岁的单亲妈妈被迫面对前夫。", "30岁的单亲妈妈为了女儿重返职场，这类设定可能有共鸣。", "二十八岁的外卖骑手在一个夜晚完成反击。",
    "第二天一早，她发现钱包里多了一张字条。",
  ])("story wording passes: %s", (statement) => {
    expect(validateAutoStageOutput("research", limited(hypothesis(statement)), input(), context()), statement).toMatchObject({ ok: true });
  });

  it("an age next to its character passes even in an audience text; a count before 的 is what is counted", () => {
    expect(validateAutoStageOutput("research", limited({ audience: { primary: "主角28岁，可能让同龄观众产生共鸣（待验证）", viewingNeeds: ["x"], emotionalAppeals: ["y"],
      basis: "hypothesis", sourceIds: [] } }), input(), context())).toMatchObject({ ok: true });
    expect(validateAutoStageOutput("research", limited({ audience: { primary: "喜欢两次以上反转的观众（待验证）", viewingNeeds: ["x"], emotionalAppeals: ["y"],
      basis: "hypothesis", sourceIds: [] } }), input(), context())).toMatchObject({ ok: true });
  });

  it("a chosen target group in words passes; the user's own audience constraint may be restated with its numbers", () => {
    expect(validateAutoStageOutput("research", limited(hypothesis("拟面向通勤时刷剧的成年观众开展创作。")), input(), context())).toMatchObject({ ok: true });
    const frozen = input({ constraints: autoCreationConstraintsSchema.parse({ audience: "25-35岁都市女性" }) });
    expect(validateAutoStageOutput("research", limited({ appliedConstraints: ["目标观众：25-35岁都市女性（用户指定）"] }), frozen, context(frozen))).toMatchObject({ ok: true });
  });

  it("ordinals, frozen settings and limits keep working, and a cast within the frozen limit may be designed", () => {
    const frozen = input({ episodeCount: 6, constraints: autoCreationConstraintsSchema.parse({ maxCharacters: 4, maxLocations: 3 }) });
    for (const statement of ["第 3 集揭开真相", "第二场交代目标", "共 6 集，每集约 60 秒", "出场人物最多 4 人", "三处地点", "只写两个主角和一个反派"]) {
      expect(validateAutoStageOutput("research", limited({ appliedConstraints: [statement] }), frozen, context(frozen)), statement).toMatchObject({ ok: true });
    }
  });

  it("a direction may count its own story elements in its notes; its audience fit stays a marked judgement", () => {
    const research = JSON.parse(limited()) as never;
    const directions = (fields: Record<string, string>) => JSON.stringify({
      schema: AUTO_CREATION_DIRECTIONS_SCHEMA,
      candidates: ["D1", "D2"].map((id) => ({
        id, title: id, logline: `${id}：骑手被扣了三个月工资，要在午夜前讨回`, protagonist: "p", goal: "g", obstacle: "o", stakes: "s", coreEmotion: "e",
        differentiation: "d", productionDifficulty: "low", difficultyNote: "n", audienceFit: "契合想看小人物扳回一局的观众（假设 H1）", evidenceIds: ["H1"],
        ratings: { audienceFit: 4, conflictStrength: 4, originality: 4, feasibility: 4, constraintFit: 4 }, ...fields,
      })),
    });
    const ctx = { ...context(), research };
    expect(validateAutoStageOutput("directions", directions({ differentiation: "用两次反转代替常见的三角恋", difficultyNote: "只需两处室内场景和 3 个人物" }), input(), ctx))
      .toMatchObject({ ok: true });
    expect(validateAutoStageOutput("directions", directions({ audienceFit: "两次反转可能契合想看逆袭的观众，待验证（H1）" }), input(), ctx)).toMatchObject({ ok: true });
  });
});

describe("the v3 prompt and the v3 checks say the same thing", () => {
  it("every example quantity the research prompt offers passes the check; the statistics it names are refused", () => {
    const prompt = buildAutoCreationPrompt("research", input(), context()).user;
    const examples = [...prompt.matchAll(/“([^”]+)”/gu)].map((match) => match[1]!)
      .filter((text) => !["假设", "计划", "建议", "是否、可能、待验证、计划、拟"].includes(text));
    expect(examples.length).toBeGreaterThan(8);
    for (const example of examples) {
      expect(validateAutoStageOutput("research", limited(hypothesis(`${example}，待验证。`)), input(), context()), example).toMatchObject({ ok: true });
    }
    expect(prompt).toContain("提示版本：ads.auto-creation.prompt.v3");
  });
});

describe("B. market facts and statistics still need a readable source, wherever they are put", () => {
  it.each([
    ["比例", "hypotheses[0].statement", hypothesis("约三成观众偏爱复仇题材。")],
    ["人数", "hypotheses[0].statement", hypothesis("三千观众愿意付费追更。")],
    ["人数（无单位）", "hypotheses[0].statement", hypothesis("五百用户会追更，可能偏爱复仇。")],
    ["年龄分布", "hypotheses[0].statement", hypothesis("主要观众可能是 25-40 岁女性。")],
    ["年龄（中文）", "hypotheses[0].statement", hypothesis("观众多为三十岁以上。")],
    ["播放量", "hypotheses[0].statement", hypothesis("同类短剧单集播放过万。")],
    ["播放量（近似）", "hypotheses[0].statement", hypothesis("同类短剧单集播放上万，可能偏爱复仇。")],
    ["排名", "hypotheses[0].statement", hypothesis("复仇题材在榜单排名第一。")],
    ["观看行为", "hypotheses[0].statement", hypothesis("用户平均每天观看 40 分钟。")],
    ["观看频次", "hypotheses[0].statement", hypothesis("观众每周看三次短剧。")],
    ["计划里的统计", "hypotheses[0].howToVerify", hypothesis("可能偏爱复仇。", "计划比较两个版本，已知女性观众占 60%。")],
    ["约束里的统计", "appliedConstraints[0]", { appliedConstraints: ["面向占比六成的女性观众"] }],
    ["局限里的统计", "limitations[0]", { limitations: ["平台用户以 18 岁以上为主"] }],
    ["机会里的统计", "opportunities[0]", { opportunities: ["复仇题材播放量是其他题材的两倍"] }],
    ["拟定人群写成年龄段", "hypotheses[0].statement", hypothesis("拟面向 18-24 岁的大学生观众。")],
  ])("%s is refused at its field", (_label, field, overrides) => {
    expect(validateAutoStageOutput("research", limited(overrides as Record<string, unknown>), input(), context()))
      .toMatchObject({ ok: false, code: "unsourced_number", field, semantic: "market_statistic" });
  });

  it.each([
    ["调查结论", hypothesis("调查显示两个版本中反转版更受欢迎。")],
    ["已测得", hypothesis("已经测试过两个版本，观众更喜欢反转版。")],
    ["资料里常见（无待验证标记）", { limitations: ["资料里3个角色定位最常见"] }],
    ["观众判断写成结论", hypothesis("观众更喜欢两次反转的版本。")],
  ])("a quantity written as a measured or settled audience finding is refused (%s)", (_label, overrides) => {
    expect(validateAutoStageOutput("research", limited(overrides as Record<string, unknown>), input(), context()))
      .toMatchObject({ ok: false, code: "unsourced_number", semantic: "result_claim" });
  });

  it("a statistic mixed into a legal plan is refused even when the plan part is fine", () => {
    for (const statement of ["拟比较两个版本，女性观众占比约六成。", "计划观察七天，同类剧完播率 30% 左右。", "两次反转的版本可能播放量翻倍"]) {
      expect(validateAutoStageOutput("research", limited(hypothesis("可能偏爱复仇。", statement)), input(), context()), statement)
        .toMatchObject({ ok: false, code: "unsourced_number", semantic: "market_statistic" });
    }
  });

  it("a market number equal to a frozen setting is still a market number", () => {
    const frozen = input({ constraints: autoCreationConstraintsSchema.parse({ maxCharacters: 3, maxLocations: 3 }) });
    for (const statement of ["用户平均每天观看 60 秒", "观众每天观看 1 集", "前 3 个短剧都只有三个人物", "热度第一的作品只有三个人物", "最多 3 名观众"]) {
      expect(validateAutoStageOutput("research", limited({ appliedConstraints: [statement] }), frozen, context(frozen)), statement)
        .toMatchObject({ ok: false, code: "unsourced_number" });
    }
  });

  it("a story quantity that breaks a frozen constraint is a constraint violation, named as such", () => {
    const frozen = input({ constraints: autoCreationConstraintsSchema.parse({ maxCharacters: 2, maxLocations: 1 }) });
    expect(validateAutoStageOutput("research", limited(hypothesis("三个人物各怀秘密。")), frozen, context(frozen)))
      .toMatchObject({ ok: false, code: "constraint_violation", semantic: "frozen_conflict", rule: "cast_over_limit" });
    expect(validateAutoStageOutput("research", limited(hypothesis("故事在两处地点之间切换。")), frozen, context(frozen)))
      .toMatchObject({ ok: false, code: "constraint_violation", semantic: "frozen_conflict", rule: "locations_over_limit" });
    expect(validateAutoStageOutput("research", limited(hypothesis("分三集讲完。")), input(), context()))
      .toMatchObject({ ok: false, code: "constraint_violation", semantic: "frozen_conflict", rule: "episode_count" });
    expect(validateAutoStageOutput("research", limited(hypothesis("开场 90 秒内交代全部关系。")), input(), context()))
      .toMatchObject({ ok: false, code: "constraint_violation", semantic: "frozen_conflict", rule: "over_length" });
  });

  it.each([
    ["空格", "约 三 成 观众偏爱复仇"],
    ["全角", "约３成观众偏爱复仇"],
    ["全角百分号", "女性观众占 60％"],
    ["中文百分之", "百分之 六十 的观众是女性"],
    ["编号后紧跟数字", "见 H13 成观众偏爱复仇"],
    ["近似数量", "十几万观众在追更"],
    ["序数写法", "该题材口碑第 一"],
    ["换单位", "该类型有 3 千万次播放"],
  ])("rewriting the number (%s) does not get past the check", (_label, statement) => {
    expect(validateAutoStageOutput("research", limited(hypothesis(statement)), input(), context()), statement).toMatchObject({ ok: false });
  });

  // Independent review (before commit): every string below passed the first v3 draft. Several also passed v2.
  it.each([
    "女性占比约六十，男性约四十。", "这类剧完播率约七十。", "同类短剧播放量普遍在三千左右。", "预计七天内播放量过三千。", "观众平均年龄约二十五。",
    "观众年龄集中在二十五到三十五之间。", "女性和男性大约是三比一。", "三十多万观众追更这类短剧。", "两千多名观众在评论区要求续集。",
    "三十余万用户收藏了同类作品。", "这类剧可能会有三百来万播放。", "成千上万的观众喜欢这种题材。", "八十%的观众偏爱逆袭结局。", "近半观众偏爱复仇题材。",
    "女性观众占了多半。", "万分之五的转化率说明付费意愿低。", "这类剧的主要观众是二十多岁的女性。", "九零后女性是这类剧的主要人群。", "90后女性是主要人群。",
    "25岁的她们最爱看复仇剧。", "女主角28岁的设定最受25岁女性欢迎。", "五个年轻人里就有两个人刷过复仇短剧。", "据说三个人里两个人喜欢甜宠。",
    "我们发现俩人里有一个人爱看甜宠。", "以往十个复仇选题里八个选题都火了。", "数据显示，三个人里有两个人爱看逆袭剧。", "在观众中，五个人里有四个人看完了。",
    "大部分人只看前10秒就划走。", "大部分人只看60秒就划走。", "大部分人只追1集就弃剧。", "之前测过两个版本，反转结尾的版本明显更受欢迎。",
    "投放过两个版本，反转结尾胜出。", "经过两轮投放，反转结尾胜出。", "观众可能每集看三遍。", "用户可能三天内就会流失。", "观众可能在第三十秒左右划走。",
    "三​成观众喜欢反转。",
  ])("review bypass is refused: %s", (statement) => {
    expect(validateAutoStageOutput("research", limited(hypothesis(statement)), input(), context()), statement).toMatchObject({ ok: false });
  });

  it("review bypass in a cited observation: a number the craft excerpt does not carry is refused however it is written", () => {
    for (const statement of ["八十%的观众偏爱主角主动选择。", "三十多万观众偏爱主角主动选择。"]) {
      expect(validateAutoStageOutput("research", limited({ observations: [{ id: "O1", statement, sourceIds: ["S-KB-CRAFT"] }] }), input(), context()), statement)
        .toMatchObject({ ok: false, code: "unsourced_number" });
    }
  });

  it("dates and counts of sources are still refused, now as numbers with no creative role", () => {
    for (const statement of ["官方条目在2026-10-18请求时只得到空壳。", "只有 1 条可读资料。"]) {
      expect(validateAutoStageOutput("research", limited({ limitations: [statement] }), input(), context()), statement)
        .toMatchObject({ ok: false, code: "unsourced_number", semantic: "unclassified" });
    }
    // A sentence that names the market reads every number in it as a market number (the market carries over its commas).
    expect(validateAutoStageOutput("research", limited({ limitations: ["只有 1 条可读资料，没有市场数据。"] }), input(), context()))
      .toMatchObject({ ok: false, code: "unsourced_number", semantic: "market_statistic" });
  });

  it("a direction's notes cannot carry a statistic either", () => {
    const ctx = { ...context(), research: JSON.parse(limited()) as never };
    const directions = (fields: Record<string, string>) => JSON.stringify({
      schema: AUTO_CREATION_DIRECTIONS_SCHEMA,
      candidates: ["D1", "D2"].map((id) => ({
        id, title: id, logline: `${id}：一个故事`, protagonist: "p", goal: "g", obstacle: "o", stakes: "s", coreEmotion: "e",
        differentiation: "d", productionDifficulty: "low", difficultyNote: "n", audienceFit: "契合想看小人物扳回一局的观众（假设 H1）", evidenceIds: ["H1"],
        ratings: { audienceFit: 4, conflictStrength: 4, originality: 4, feasibility: 4, constraintFit: 4 }, ...fields,
      })),
    });
    expect(validateAutoStageOutput("directions", directions({ differentiation: "同类爆款里 80% 都是复仇" }), input(), ctx))
      .toMatchObject({ ok: false, code: "unsourced_number", field: "candidates[0].differentiation" });
    expect(validateAutoStageOutput("directions", directions({ difficultyNote: "同类剧平均拍摄 3 天" }), input(), ctx))
      .toMatchObject({ ok: false, code: "unsourced_number", field: "candidates[0].difficultyNote" });
    expect(validateAutoStageOutput("directions", directions({ audienceFit: "两次反转契合观众" }), input(), ctx))
      .toMatchObject({ ok: false, code: "unsourced_number", field: "candidates[0].audienceFit", semantic: "result_claim" });
  });
});
