import {
  AUTO_CREATION_BIBLE_SCHEMA,
  AUTO_CREATION_DIRECTIONS_SCHEMA,
  AUTO_CREATION_EPISODE_SCHEMA,
  AUTO_CREATION_OUTLINE_SCHEMA,
  AUTO_CREATION_RESEARCH_SCHEMA,
  AUTO_CREATION_RESEARCH_SCHEMA_V1,
  AUTO_CREATION_RESEARCH_SCHEMA_V2,
  AUTO_CREATION_RESEARCH_SCHEMA_V3,
  AUTO_CREATION_REVIEW_SCHEMA,
  AUTO_REVIEW_DIMENSIONS,
  type AutoBible,
  type AutoDirections,
  type AutoEpisode,
  type AutoOutline,
  type AutoResearchAnswer,
  type AutoResearchLimitedAnswer,
  type AutoResearchV1,
  type AutoResearchV2,
  type AutoResearchV3,
  type AutoReview,
} from "@ai-drama/contracts";
import { ANTHROPIC_MESSAGES_URL, DEEPSEEK_CHAT_COMPLETIONS_URL, type WritingTransport } from "./text-writing";

/**
 * Controllable model double for automatic creation (tests and stubbed acceptances only; the runtime never wires it).
 * Every text says it is the double's sample. Stages are recognised from the provider-neutral prompt text.
 */

export type AutoFixtureStage = "research" | "directions" | "bible" | "outline" | `episode:${number}` | `revise:${number}:episode:${number}` | `review:${number}`;

export function autoFixtureStageOf(user: string): AutoFixtureStage {
  if (user.includes("任务：基于资料完成研究与创作定位") || user.includes("任务：创作定位与待验证假设")) return "research";
  if (user.includes("任务：提出 2–3 个")) return "directions";
  if (user.includes("任务：按选定方向写故事设定档案")) return "bible";
  if (user.includes("任务：把故事分成")) return "outline";
  const review = /审阅轮次：第 (\d) 轮/.exec(user)?.[1];
  if (review) return `review:${review}` as AutoFixtureStage;
  const revise = /任务：定向修改第 (\d) 集（第 (\d) 轮修改）/.exec(user);
  if (revise) return `revise:${revise[2]!}:episode:${revise[1]!}` as AutoFixtureStage;
  const episode = /任务：写第 (\d) 集剧本/.exec(user)?.[1];
  if (episode) return `episode:${episode}` as AutoFixtureStage;
  throw new Error("unrecognised auto creation prompt");
}

/** The research contract a prompt asks for: limited (AI creative planning) or sourced. */
export function autoFixtureResearchMode(user: string): "limited" | "sourced" {
  return user.includes("任务：创作定位与待验证假设") ? "limited" : "sourced";
}

/** The research ids a directions prompt allows (evidenceIds 只能引用研究里实际存在的编号：H1、H2), or null for an older prompt. */
export function autoFixtureAllowedIds(user: string): string[] | null {
  const line = /evidenceIds 只能引用研究里实际存在的编号：([^；\n]*)；/u.exec(user)?.[1];
  return line === undefined ? null : line === "无" ? [] : line.split("、");
}

export function autoFixtureEpisodeCount(user: string): number {
  return Number(/集数：(\d) 集；/.exec(user)?.[1] ?? "1");
}

export function autoFixtureEpisodeSeconds(user: string): number {
  return Number(/每集目标时长约 (\d+) 秒/.exec(user)?.[1] ?? "60");
}

/** The double's hypotheses of the durations plan (synthetic samples, not a real model's answer). */
export function fixtureAutoDurationHypotheses(kind: "creative" | "viewing", seconds: number): AutoResearchAnswer["hypotheses"] {
  if (kind === "viewing") {
    return [{ id: "H1", statement: `模型替身样例：观众通常观看${String(seconds)}秒后退出。`, howToVerify: "上线后用真实观看数据验证。" }];
  }
  return [
    { id: "H1", statement: `待验证观众是否喜欢本剧${String(seconds)}秒的紧凑叙事。`, howToVerify: "计划比较两个版本的试看反馈。" },
    { id: "H2", statement: `待验证：观众能否在${String(seconds)}秒内理解人物冲突。`, howToVerify: "计划邀请试看者复述人物关系。" },
  ];
}

/** The JSON of a data block the prompt carries, e.g. the issues a revision must answer. */
export function autoFixtureBlock(user: string, label: string): unknown {
  const start = user.indexOf(`<<<${label}\n`);
  if (start < 0) return null;
  const from = start + label.length + 4;
  const end = user.indexOf(`\n${label}>>>`, from);
  return JSON.parse(user.slice(from, end)) as unknown;
}

/** Story quantities of the double the checks cannot place (no_role): kept as unverified notices since checks v5. */
export const AUTO_FIXTURE_UNPLACED = { money: "主角只剩五十元，必须在午夜前讨回工资。", puzzle: "失踪者留下三块拼图，主角逐场拼出真相。" } as const;

/**
 * A limited-mode research answer that counts its own story and plans the way checks v3 accept (两个互不信任的人, 三次误会,
 * 拟比较两个版本, 上线后观察七天). hiddenStatistic puts one unsourced share inside the verification plan instead.
 * unplaced adds story quantities with no recognised role (五十元, 三块拼图); statisticAfterUnplaced adds, after them in
 * the same opportunity, an unsourced share (refused even so).
 */
export function fixtureAutoCreativeResearch(options: { hiddenStatistic?: boolean; episodeCount?: number; unplaced?: boolean; statisticAfterUnplaced?: boolean } = {}): AutoResearchAnswer {
  const base = fixtureAutoResearch({ citeCraft: false });
  return {
    ...base,
    // The test-site refusal's shape, now split: the method as quoted (no count in it) and this work's two reversals.
    contentStructure: [
      { reference: { sourceId: "S-KB-CRAFT", quote: "关键结果来自主角的选择和行动" },
        application: { pattern: "模型替身样例：计划用两次反转推动主角主动选择。", why: "这是本作品的创作设计。" } },
      { reference: null, application: { pattern: "模型替身样例：三名骑手被迫合作，三天内找出真相。", why: "自主创作设计，没有对应的方法资料。" } },
      ...(options.unplaced || options.statisticAfterUnplaced
        ? [{ reference: null, application: { pattern: AUTO_FIXTURE_UNPLACED.puzzle, why: "自主创作设计：用实物线索推动主角行动。" } }] : []),
    ],
    hypotheses: [
      { id: "H1", statement: "模型替身样例：两个互不信任的人被迫共同寻找真相，这种设定可能带来悬念。",
        howToVerify: options.hiddenStatistic ? "拟比较两个版本，女性观众占比约六成。" : "受众是否喜欢这种结尾，计划比较两个版本后再判断。" },
      { id: "H2", statement: "模型替身样例：通过三次误会逐步揭露人物动机，是本故事拟采用的创作方案。", howToVerify: "计划上线后观察七天，待验证观众是否更喜欢两次反转的版本。" },
    ],
    audience: { ...base.audience, primary: "模型替身样例：拟面向通勤时刷剧的成年观众（待验证，不是平台真实用户画像）" },
    opportunities: [
      `主角二十八岁，三天内必须讨回工资，开场前 3 秒抛出冲突，共 ${String(options.episodeCount ?? 1)} 集，每集约 60 秒`,
      ...(options.statisticAfterUnplaced ? [`${AUTO_FIXTURE_UNPLACED.money}七成观众偏爱反转。`] : options.unplaced ? [AUTO_FIXTURE_UNPLACED.money] : []),
    ],
  };
}

/** Fields a limited answer may not carry; the double adds them only when a plan says so (each refused whole). */
export type AutoFixtureLimitedInjection = "facts" | "observations" | "audience.basis" | "audience.sourceIds";

/**
 * A research answer as the double writes it for a limited prompt: the same creative parts, none of the sourced
 * contract's fields. inject adds the named ones back with empty or default values (the strict schema refuses each).
 */
export function fixtureAutoLimitedResearch(answer: AutoResearchAnswer, inject: readonly AutoFixtureLimitedInjection[] = []): AutoResearchLimitedAnswer & Record<string, unknown> {
  const { primary, viewingNeeds, emotionalAppeals } = answer.audience;
  return {
    schema: answer.schema,
    ...(inject.includes("facts") ? { facts: [] } : {}),
    ...(inject.includes("observations") ? { observations: [] } : {}),
    hypotheses: answer.hypotheses,
    audience: { primary, viewingNeeds, emotionalAppeals,
      ...(inject.includes("audience.basis") ? { basis: "hypothesis" } : {}), ...(inject.includes("audience.sourceIds") ? { sourceIds: [] } : {}) },
    contentStructure: answer.contentStructure,
    opportunities: answer.opportunities,
  };
}

/** Craft wording no source has: a quote the checks refuse (never dropped or set to null to pass). */
export const AUTO_FIXTURE_FORGED_QUOTE = "反转次数以两次为最佳";

export function fixtureAutoResearch(options: { fabricatedNumber?: boolean; citeCraft?: boolean; forgedQuote?: boolean; structureStatistic?: boolean } = {}): AutoResearchAnswer {
  return {
    schema: AUTO_CREATION_RESEARCH_SCHEMA,
    facts: options.citeCraft === false ? [] : [{
      id: "F1",
      statement: "项目知识库的写作方法要求关键结果来自主角的选择和行动。",
      sourceIds: ["S-KB-CRAFT"],
      evidence: "关键结果来自主角的选择和行动，不靠旁人突然解围。",
    }],
    observations: [],
    hypotheses: [{
      id: "H1",
      statement: options.fabricatedNumber ? "模型替身样例：约 70% 的观众偏爱逆袭题材。" : "模型替身样例：通勤碎片时间的观众可能偏爱一集内有明确兑现的故事。",
      howToVerify: "用真实投放或观看数据验证。",
    }],
    audience: {
      primary: "模型替身样例：通勤和睡前刷短剧的成年观众（假设）",
      viewingNeeds: ["一集内看到结果"],
      emotionalAppeals: ["被看见", "扳回一局"],
      basis: "hypothesis",
      sourceIds: [],
    },
    contentStructure: [{
      reference: { sourceId: "S-KB-CRAFT", quote: options.forgedQuote ? AUTO_FIXTURE_FORGED_QUOTE : "关键结果来自主角的选择和行动" },
      application: { pattern: options.structureStatistic ? "模型替身样例：约三成观众偏爱两次反转，所以主角主动选择。" : "主角主动选择推动结果",
        why: "知识库要求关键结果来自主角的行动。" },
    }],
    opportunities: ["小人物在一个夜晚完成一次反击"],
  };
}

/** What research before v3 had the model write (the gaps and the settings): history only. */
const LEGACY_RESEARCH_FIELDS = { limitations: ["官方入口页面没有读到正文，受众判断都是假设。"], appliedConstraints: ["单集、约一分钟"] };

/**
 * Research as the v3 code stored it (one answer contract in every mode, a craft fact in a limited run, the server's
 * record without an answer contract or market evidence): history only, never a new answer.
 */
export function fixtureAutoResearchV3(): AutoResearchV3 {
  return {
    ...fixtureAutoResearch(),
    schema: AUTO_CREATION_RESEARCH_SCHEMA_V3,
    serverRecord: {
      origin: "server_record",
      executedWith: { promptVersion: "ads.auto-creation.prompt.v5", checksVersion: "ads.auto-creation.checks.v5", researchSchema: AUTO_CREATION_RESEARCH_SCHEMA_V3 },
      settings: { origin: "user_setting", items: [{ key: "episodes", label: "集数", value: "共 1 集" }] },
      material: { origin: "source_snapshot", researchMode: "limited",
        read: [{ sourceId: "S-KB-CRAFT", title: "短剧写作方法（项目知识库，改编自 drama-skills MIT 版本）", readScope: "full_text", topic: "craft", note: "只涉及写作方法。" }],
        unread: [{ sourceId: "S-OE-1", title: "巨量引擎帮助中心条目（标题未能读取）", status: "unreadable", note: "没有读取正文。" }],
        gaps: ["没有可读取的近期市场资料（v3 历史样本）。"] },
    },
    unverified: [],
  };
}

/** Research as the v2 code stored it (the model restated the gaps and settings): history only, never a new answer. */
export function fixtureAutoResearchV2(): AutoResearchV2 {
  return { ...fixtureAutoResearch(), ...LEGACY_RESEARCH_FIELDS, schema: AUTO_CREATION_RESEARCH_SCHEMA_V2 };
}

/** Research as the v1 code stored it (pattern, why and sourceIds in one item): history only, never a new answer. */
export function fixtureAutoResearchV1(): AutoResearchV1 {
  const { contentStructure: _structure, ...rest } = fixtureAutoResearch();
  return { ...rest, ...LEGACY_RESEARCH_FIELDS, schema: AUTO_CREATION_RESEARCH_SCHEMA_V1,
    contentStructure: [{ pattern: "主角主动选择推动结果", why: "知识库要求关键结果来自主角的行动。", sourceIds: ["S-KB-CRAFT"] }] };
}

export function fixtureAutoDirections(): AutoDirections {
  const base = {
    protagonist: "外卖骑手陈默", goal: "在午夜前拿回被扣的工资", obstacle: "站长掌握他的考勤记录", stakes: "失去工作和房租",
    coreEmotion: "憋屈后的扬眉吐气", differentiation: "用一张手写送餐单反击", difficultyNote: "两处室内场景",
    audienceFit: "符合一集内兑现的假设 H1", evidenceIds: ["F1", "H1"],
  };
  return {
    schema: AUTO_CREATION_DIRECTIONS_SCHEMA,
    candidates: [
      { id: "D1", title: "午夜工资单", logline: "模型替身样例：骑手用一张手写送餐单在午夜前拿回工资。", productionDifficulty: "low",
        ratings: { audienceFit: 4, conflictStrength: 4, originality: 3, feasibility: 5, constraintFit: 5 }, ...base },
      { id: "D2", title: "雨夜的差评", logline: "模型替身样例：骑手为一条恶意差评追到顾客家门口。", productionDifficulty: "medium",
        ratings: { audienceFit: 3, conflictStrength: 4, originality: 4, feasibility: 3, constraintFit: 4 }, ...base },
      { id: "D3", title: "天台上的订单", logline: "模型替身样例：骑手在天台拦下一份写着求救的订单。", productionDifficulty: "high",
        ratings: { audienceFit: 4, conflictStrength: 5, originality: 4, feasibility: 2, constraintFit: 3 }, ...base },
    ],
  };
}

/**
 * Directions whose notes count their own story (两次反转, 两处室内场景, 3 个人物) and whose audience fit is a marked judgement.
 * unplaced: the chosen direction's difference also counts something the checks cannot place (三块拼图).
 */
export function fixtureAutoCreativeDirections(options: { unplaced?: boolean } = {}): AutoDirections {
  const directions = fixtureAutoDirections();
  return {
    ...directions,
    candidates: directions.candidates.map((candidate, index) => ({ ...candidate,
      differentiation: options.unplaced && index === 0 ? "用两次反转和三块拼图代替常见的三角恋" : "用两次反转代替常见的三角恋", difficultyNote: "只需两处室内场景和 3 个人物",
      audienceFit: "两次反转可能契合想看小人物扳回一局的观众，待验证 H1", evidenceIds: ["H1"] })),
  };
}

export function fixtureAutoBible(): AutoBible {
  return {
    schema: AUTO_CREATION_BIBLE_SCHEMA,
    title: "午夜工资单",
    logline: "模型替身样例：被克扣工资的骑手陈默，用一张手写送餐单在午夜前当众拿回工资。",
    synopsis: "模型替身样例：站长赵强篡改考勤扣下陈默的工资。陈默翻出自己每单手写的送餐记录，在站点例会上对质，最终拿回工资并让赵强的造假被总部看见。",
    story: {
      protagonistId: "C1",
      desire: "拿回自己挣的钱，交上房租",
      weakness: "不敢和上级争",
      goal: "午夜前拿回被扣的工资",
      stakes: "交不上房租会被赶出出租屋",
      obstacles: ["赵强掌握系统考勤", "同事不敢作证"],
      keyChoices: [{ choice: "陈默决定当众拿出手写送餐单", consequence: "他和赵强彻底撕破脸" }],
      twist: { reveal: "手写单上的顾客签名正是总部巡查员", setups: ["开场陈默请顾客在单子上签名"] },
      payoffs: ["陈默第一次当众说出不公平"],
      ending: "陈默拿回工资，巡查员当场让赵强停职，陈默把手写单折好放回口袋。",
      causalChain: ["赵强篡改考勤", "陈默发现工资被扣", "陈默翻出手写单", "巡查员认出自己的签名", "赵强被停职"],
    },
    characters: [
      { id: "C1", name: "陈默", identity: "外卖骑手", goal: "拿回工资", weakness: "不敢顶撞上级", motivation: "要交房租", voice: "话少，句子短", presence: "on_screen" },
      { id: "C2", name: "赵强", identity: "站长", goal: "掩盖克扣", weakness: "爱面子", motivation: "完成虚报的指标", voice: "官腔，爱打断人", presence: "on_screen" },
      { id: "C3", name: "林姐", identity: "总部巡查员", goal: "查清站点账目", weakness: "不轻易表态", motivation: "核实投诉", voice: "平静，问得具体", presence: "on_screen" },
      { id: "C4", name: "房东", identity: "陈默的房东", goal: "收房租", weakness: "急躁", motivation: "自己也要还贷", voice: "电话里催促", presence: "mentioned" },
    ],
    relationships: [
      { from: "C1", to: "C2", relation: "下属与站长", change: "从忍气吞声到当面对质" },
      { from: "C3", to: "C1", relation: "顾客与骑手", change: "从陌生人到证人" },
    ],
    locations: [
      { id: "L1", name: "站点办公室", intExt: "INT", timeOfDay: "夜", layout: "一张长桌，墙上挂考勤屏", productionNotes: "一盏顶灯即可" },
      { id: "L2", name: "小区楼道", intExt: "INT", timeOfDay: "夜", layout: "狭窄楼道，门口放餐盒", productionNotes: "注意收音" },
    ],
    props: [{ id: "P1", name: "手写送餐单", ownerId: "C1", purpose: "记录每单签名", change: "从被嘲笑的废纸到关键证据" }],
  };
}

/** A setting with one person on screen (C1) and one only mentioned (C2), for a one-person cast limit. */
export function fixtureAutoSoloBible(): AutoBible {
  const bible = fixtureAutoBible();
  return {
    ...bible,
    characters: [bible.characters[0]!, { ...bible.characters[3]!, id: "C2" }],
    relationships: [{ from: "C1", to: "C2", relation: "租客与房东", change: "从拖欠到交上房租" }],
  };
}

/** A setting with one person on screen (C1) and seven only mentioned (C2–C8), for many repeated check results. */
export function fixtureAutoCrowdedBible(): AutoBible {
  const bible = fixtureAutoBible();
  const mentioned = ["赵强", "林姐", "房东", "老周", "小吴", "阿梅", "表哥"].map((name, index) => ({
    id: `C${String(index + 2)}`, name, identity: "被提及的人", goal: "不出场", weakness: "无", motivation: "无", voice: "无", presence: "mentioned" as const,
  }));
  return {
    ...bible,
    characters: [bible.characters[0]!, ...mentioned],
    relationships: [{ from: "C1", to: "C2", relation: "下属与站长", change: "从忍气吞声到当面对质" }],
  };
}

export function fixtureAutoOutline(count: number): AutoOutline {
  return {
    schema: AUTO_CREATION_OUTLINE_SCHEMA,
    episodes: Array.from({ length: count }, (_, index) => ({
      episodeNo: index + 1,
      title: count === 1 ? "午夜工资单" : `午夜工资单（${String(index + 1)}）`,
      opening: "模型替身样例：陈默发现工资被扣。",
      goal: "拿回工资",
      obstacle: "赵强否认",
      action: "陈默拿出手写单",
      turn: "签名人是巡查员",
      result: index + 1 === count ? "陈默拿回工资" : "陈默找到证人",
      newInformation: "手写单签名的主人身份",
      emotionShift: "憋屈到扬眉吐气",
      handoff: index + 1 === count ? "结局：赵强停职，陈默交上房租" : "陈默要说服证人出面",
      characterIds: ["C1", "C2", "C3"],
      locationIds: ["L1"],
    })),
    resolution: "陈默拿回工资，赵强停职。",
  };
}

/** A sixty-second episode within every limit, or one with six scenes when tooManyScenes (a deterministic finding). */
export function fixtureAutoEpisode(episodeNo: number, options: { tooManyScenes?: boolean; tag?: string } = {}): AutoEpisode {
  const tag = options.tag ?? "模型替身样例";
  const scene = (sceneNo: number, seconds: number) => ({
    sceneNo,
    locationId: sceneNo === 1 ? "L2" : "L1",
    timeOfDay: "夜",
    characterIds: sceneNo === 1 ? ["C1", "C3"] : ["C1", "C2", "C3"],
    action: sceneNo === 1 ? `${tag}：陈默把餐盒放在门口，请顾客在手写单上签名。` : `${tag}：第 ${String(sceneNo)} 场，陈默把手写单拍在长桌上。`,
    dialogue: sceneNo === 1
      ? [{ characterId: "C3", line: "签哪儿？", delivery: "平静" }, { characterId: "C1", line: "这里，谢谢。", delivery: "" }]
      : [{ characterId: "C1", line: `第 ${String(episodeNo)} 集第 ${String(sceneNo)} 场：这是我每一单的记录。`, delivery: "压着火" }],
    sound: sceneNo === 1 ? "楼道感应灯咔嗒一声" : "",
    shots: Array.from({ length: Math.ceil(seconds / 10) }, (_, index) => ({ shotNo: index + 1, framing: index === 0 ? "近景" : "中景",
      description: index === 0 ? "手写单特写" : "陈默与对手的反应", seconds: Math.min(10, seconds - index * 10) })),
    assetNeeds: sceneNo === 1 ? ["手写送餐单道具"] : [],
  });
  const count = options.tooManyScenes ? 6 : 3;
  return {
    schema: AUTO_CREATION_EPISODE_SCHEMA,
    episodeNo,
    title: "午夜工资单",
    scenes: Array.from({ length: count }, (_, index) => scene(index + 1, Math.round(60 / count))),
    handoffFacts: [`第 ${String(episodeNo)} 集结束时陈默拿到了巡查员的签名。`],
  };
}

/** The solo setting's episode: only C1 speaks; the draft also puts the mentioned C2 on screen when mentionedOnScreen. */
export function fixtureAutoSoloEpisode(episodeNo: number, options: { mentionedOnScreen?: boolean; tag?: string } = {}): AutoEpisode {
  const episode = fixtureAutoEpisode(episodeNo, { tag: options.tag });
  return {
    ...episode,
    scenes: episode.scenes.map((scene) => ({
      ...scene,
      characterIds: options.mentionedOnScreen && scene.sceneNo === 2 ? ["C1", "C2"] : ["C1"],
      dialogue: [{ characterId: "C1", line: `第 ${String(episodeNo)} 集第 ${String(scene.sceneNo)} 场：这是我每一单的记录。`, delivery: "" }],
    })),
  };
}

/**
 * The crowded setting's episode: five short scenes, every one listing all eight people although only C1 is on screen.
 * Valid output (schema and references); each scene yields seven "mentioned on screen" check results, and from the second
 * episode on one "repeated line" result: 235 results over six episodes.
 */
export function fixtureAutoCrowdedEpisode(episodeNo: number, options: { tag?: string; padding?: number } = {}): AutoEpisode {
  const tag = options.tag ?? "模型替身样例";
  const pad = "夜".repeat(options.padding ?? 0);
  return {
    schema: AUTO_CREATION_EPISODE_SCHEMA,
    episodeNo,
    title: `午夜工资单（${String(episodeNo)}）`,
    scenes: Array.from({ length: 5 }, (_, index) => ({
      sceneNo: index + 1,
      locationId: "L1",
      timeOfDay: "夜",
      characterIds: ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"],
      action: `${tag}：第 ${String(episodeNo)} 集第 ${String(index + 1)} 场，陈默把手写单拍在长桌上。${index === 0 ? pad : ""}`,
      // The same line in every episode: episodes 2–6 each repeat episode 1 (a medium check result per scene).
      dialogue: [{ characterId: "C1", line: `第 ${String(index + 1)} 场：这是我每一单的记录。`, delivery: "压着火" }],
      sound: "",
      shots: [{ shotNo: 1, framing: "中景", description: "陈默与长桌", seconds: 12 }],
      assetNeeds: [],
    })),
    handoffFacts: [`第 ${String(episodeNo)} 集结束时陈默还在等工资。`],
  };
}

export interface AutoReviewPlan {
  /** Verified high-severity issue on episode 1 in these rounds (a revision is then due). */
  highIssueRounds?: number[];
  /** An issue whose quote is not in the text (kept, never acted on). */
  unverifiedIssue?: boolean;
  /** A verified high-severity issue on the bible in these rounds (no episode revision can fix it). */
  bibleIssueRounds?: number[];
  /** A high issue on episode 1 quoting a dialogue line joined to its delivery (two fields, so no quote). */
  joinedEvidenceRounds?: number[];
  /** A high issue on the bible quoting the end of the desire joined to the start of the weakness. */
  joinedBibleEvidenceRounds?: number[];
}

export function fixtureAutoReview(round: number, plan: AutoReviewPlan = {}): AutoReview {
  const issues: AutoReview["issues"] = [];
  if (plan.highIssueRounds?.includes(round)) {
    issues.push({ id: "R1", dimension: "conflictAction", severity: "high", target: "episode:1",
      evidence: "陈默把餐盒放在门口", problem: "开场动作没有体现陈默的主动选择。", suggestion: "让陈默主动请求签名并说明理由。" });
  }
  if (plan.bibleIssueRounds?.includes(round)) {
    issues.push({ id: "R3", dimension: "motivation", severity: "high", target: "bible",
      evidence: "完成虚报的指标", problem: "反派动机单薄。", suggestion: "补充赵强的压力来源。" });
  }
  if (plan.joinedEvidenceRounds?.includes(round)) {
    issues.push({ id: "R4", dimension: "dialogue", severity: "high", target: "episode:1",
      evidence: "签哪儿？平静", problem: "（替身）跨字段拼接的引用。", suggestion: "无" });
  }
  if (plan.joinedBibleEvidenceRounds?.includes(round)) {
    issues.push({ id: "R5", dimension: "characters", severity: "high", target: "bible",
      evidence: "交上房租不敢和上级争", problem: "（替身）跨字段拼接的引用。", suggestion: "无" });
  }
  if (plan.unverifiedIssue) {
    issues.push({ id: "R2", dimension: "dialogue", severity: "high", target: "episode:1",
      evidence: "这句话并不在剧本里", problem: "（替身）编造的引用。", suggestion: "无" });
  }
  return {
    schema: AUTO_CREATION_REVIEW_SCHEMA,
    verdict: issues.some((item) => item.severity === "high") ? "revise" : "pass",
    dimensions: AUTO_REVIEW_DIMENSIONS.map((key) => ({ key, assessment: `模型替身样例：${key} 检查说明。`, internalScore: 4 })),
    issues,
  };
}

export interface AutoFixturePlan {
  review?: AutoReviewPlan;
  /** The first draft of these episodes has six scenes (over the sixty-second limit). */
  longEpisodes?: number[];
  /** Every revision still has six scenes (so the run ends at needs work). */
  revisionsStayLong?: boolean;
  fabricatedNumber?: boolean;
  /** A structure quote found in no source (refused at research). */
  forgedQuote?: boolean;
  /** A share in a structure's application beside a real quote (refused at research). */
  structureStatistic?: boolean;
  /** Research and directions that count their own story and plans (checks v3 accepts them). */
  creativeQuantities?: boolean;
  /** Like creativeQuantities, with an unsourced share hidden in a verification plan (refused). */
  hiddenStatistic?: boolean;
  /** Like creativeQuantities, with story quantities the checks cannot place (五十元, 三块拼图): unverified notices, not refusals. */
  unplacedQuantities?: boolean;
  /** Like unplacedQuantities, with 七成观众偏爱反转 after 五十元 in the same opportunity (refused: the notice opens nothing). */
  statisticAfterUnplaced?: boolean;
  /** A research answer that also writes the server's appliedConstraints and limitations (refused by the strict answer schema). */
  serverFieldsInAnswer?: boolean;
  /** For a limited prompt: fields of the sourced contract the double adds anyway, empty or default (refused whole). */
  limitedInjection?: AutoFixtureLimitedInjection[];
  /** For a limited prompt: answer with the sourced contract's whole research (the craft fact F1 and all) instead. */
  ignoreLimitedContract?: boolean;
  /** Every structure is this work's own design (reference null): for a snapshot with nothing readable to quote. */
  noReferences?: boolean;
  /** The craft fact quotes wording its source does not have (refused in a sourced run). */
  forgedFactEvidence?: boolean;
  /** The craft fact also states a share its source does not carry (refused in a sourced run). */
  unsourcedFactNumber?: boolean;
  /**
   * Research hypotheses with the prompt's own episode length (checks v7). creative: the work's length (本剧60秒的紧凑叙事)
   * and a pending question whose duration the checks cannot place (an unverified notice). viewing: an actual viewing
   * time as a habit (refused).
   */
  durations?: "creative" | "viewing";
  /**
   * Four hypotheses, the fourth with a synthetic `extra` field (prompt v8 says never to add one; the strict schema refuses
   * the answer whole at hypotheses[3]). The key a real refused answer carried was never kept: this is not its text.
   */
  extraHypothesisField?: boolean;
  /** One person on screen and one mentioned; the first drafts put the mentioned one on screen, revisions do not. */
  soloCast?: boolean;
  /** One person on screen, seven mentioned, and every scene of every draft lists all eight (hundreds of check results). */
  crowdedCast?: boolean;
  /** Extra characters in the first scene of every crowded draft (a longer, still valid episode). */
  crowdedPadding?: number;
}

/** Hypotheses the double adds to reach four (synthetic samples). */
const FIXTURE_MORE_HYPOTHESES: AutoResearchAnswer["hypotheses"] = [
  { id: "H2", statement: "模型替身样例：误会在结尾解开，可能比中途解开更有悬念。", howToVerify: "计划比较两种解开时机的试看反馈。" },
  { id: "H3", statement: "模型替身样例：反派有可理解的动机，可能让冲突更可信。", howToVerify: "计划请试看者说出反派想要什么。" },
  { id: "H4", statement: "模型替身样例：结尾留一个小悬念，可能让观众想看下一集。", howToVerify: "计划询问试看者是否想知道后续。" },
];

/** The double's answer for one prompt. */
export function autoFixtureAnswer(user: string, plan: AutoFixturePlan = {}): unknown {
  const stage = autoFixtureStageOf(user);
  const count = autoFixtureEpisodeCount(user);
  if (stage === "research") {
    const research = plan.creativeQuantities || plan.hiddenStatistic || plan.unplacedQuantities || plan.statisticAfterUnplaced
      ? fixtureAutoCreativeResearch({ hiddenStatistic: plan.hiddenStatistic, episodeCount: count, unplaced: plan.unplacedQuantities,
        statisticAfterUnplaced: plan.statisticAfterUnplaced })
      : fixtureAutoResearch({ fabricatedNumber: plan.fabricatedNumber, forgedQuote: plan.forgedQuote, structureStatistic: plan.structureStatistic });
    const adjusted: AutoResearchAnswer = {
      ...research,
      facts: research.facts.map((fact) => ({ ...fact,
        ...(plan.forgedFactEvidence ? { evidence: "知识库里没有这句话" } : {}),
        ...(plan.unsourcedFactNumber ? { statement: `${fact.statement}七成观众偏爱这种写法。` } : {}) })),
      contentStructure: plan.noReferences ? research.contentStructure.map((item) => ({ ...item, reference: null })) : research.contentStructure,
      ...(plan.durations ? { hypotheses: fixtureAutoDurationHypotheses(plan.durations, autoFixtureEpisodeSeconds(user)) } : {}),
      ...(plan.extraHypothesisField ? { hypotheses: [...research.hypotheses, ...FIXTURE_MORE_HYPOTHESES.filter((item) => !research.hypotheses.some((own) => own.id === item.id))].slice(0, 4)
        .map((item, index) => index === 3 ? { ...item, extra: "模型替身样例：合成多余字段" } : item) } : {}),
    };
    // The double follows the contract the prompt asks for, unless a plan says to break it.
    const answer = autoFixtureResearchMode(user) === "limited" && !plan.ignoreLimitedContract
      ? fixtureAutoLimitedResearch(adjusted, plan.limitedInjection) : adjusted;
    return plan.serverFieldsInAnswer ? { ...answer, ...LEGACY_RESEARCH_FIELDS } : answer;
  }
  if (stage === "directions") {
    const directions = plan.creativeQuantities || plan.unplacedQuantities ? fixtureAutoCreativeDirections({ unplaced: plan.unplacedQuantities }) : fixtureAutoDirections();
    // A direction cites only the ids the prompt lists (a limited research has H ids only).
    const allowed = autoFixtureAllowedIds(user);
    return allowed === null ? directions
      : { ...directions, candidates: directions.candidates.map((candidate) => ({ ...candidate, evidenceIds: candidate.evidenceIds.filter((id) => allowed.includes(id)) })) };
  }
  if (stage === "bible") return plan.soloCast ? fixtureAutoSoloBible() : plan.crowdedCast ? fixtureAutoCrowdedBible() : fixtureAutoBible();
  if (stage === "outline") {
    const outline = fixtureAutoOutline(count);
    return plan.soloCast || plan.crowdedCast ? { ...outline, episodes: outline.episodes.map((episode) => ({ ...episode, characterIds: ["C1"] })) } : outline;
  }
  if (stage.startsWith("review:")) return fixtureAutoReview(Number(stage.split(":")[1]), plan.review);
  const episodeNo = Number(stage.split(":").at(-1));
  if (stage.startsWith("revise:")) {
    // Each entry names the issue ids it covers (repeated check results are grouped); an older prompt used one id.
    const issues = (autoFixtureBlock(user, "需要解决的问题") as Array<{ id?: string; ids?: string[] }> | null) ?? [];
    const ids = issues.flatMap((issue) => issue.ids ?? (issue.id ? [issue.id] : [])).slice(0, 10);
    const revised = plan.soloCast ? fixtureAutoSoloEpisode(episodeNo, { tag: "模型替身样例（修订）" })
      : plan.crowdedCast ? fixtureAutoCrowdedEpisode(episodeNo, { tag: "模型替身样例（修订）", padding: plan.crowdedPadding })
        : fixtureAutoEpisode(episodeNo, { tooManyScenes: plan.revisionsStayLong, tag: "模型替身样例（修订）" });
    return { ...revised, changes: ids.map((issueId) => ({ issueId, change: "按问题定向修改。" })) };
  }
  if (plan.soloCast) return fixtureAutoSoloEpisode(episodeNo, { mentionedOnScreen: true });
  if (plan.crowdedCast) return fixtureAutoCrowdedEpisode(episodeNo, { padding: plan.crowdedPadding });
  return fixtureAutoEpisode(episodeNo, { tooManyScenes: plan.longEpisodes?.includes(episodeNo) });
}

function wire(url: string, value: unknown): unknown {
  const textValue = JSON.stringify(value);
  if (url === DEEPSEEK_CHAT_COMPLETIONS_URL) {
    return { id: "ds_auto_fixture", object: "chat.completion", model: "fixture-model",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: textValue } }],
      usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100, completion_tokens: 200, total_tokens: 300 } };
  }
  if (url === ANTHROPIC_MESSAGES_URL) {
    return { id: "msg_auto_fixture", type: "message", role: "assistant", model: "fixture-model",
      content: [{ type: "text", text: textValue }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 200 } };
  }
  return { id: "resp_auto_fixture", model: "fixture-model", status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: textValue }] }],
    usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 } };
}

export interface AutoFixtureExchange {
  stage: AutoFixtureStage;
  url: string;
  user: string;
  system: string;
}

/** A transport speaking each endpoint's own wire format, answering every automatic creation stage. */
export function autoFixtureTransport(options: {
  plan?: AutoFixturePlan;
  seen?: AutoFixtureExchange[];
  override?: (stage: AutoFixtureStage, attempt: number) => { status: number; body: unknown } | "hang" | "throw" | undefined;
} = {}): WritingTransport {
  const attempts = new Map<string, number>();
  return async (request) => {
    const body = JSON.parse(request.body) as Record<string, unknown>;
    const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
    const contentText = (value: unknown): string => typeof value === "string" ? value
      : Array.isArray(value) ? value.map((part) => (part as { text?: string }).text ?? "").join("") : "";
    const user = contentText(messages?.find((message) => message.role === "user")?.content) || String(body.input ?? "");
    const system = contentText(messages?.find((message) => message.role === "system")?.content) || String(body.instructions ?? body.system ?? "");
    const stage = autoFixtureStageOf(user);
    const attempt = (attempts.get(stage) ?? 0) + 1;
    attempts.set(stage, attempt);
    options.seen?.push({ stage, url: request.url, user, system });
    const custom = options.override?.(stage, attempt);
    if (custom === "throw") throw new TypeError("fetch failed");
    if (custom === "hang") {
      return new Promise((_, reject) => {
        request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    const answer = custom ?? { status: 200, body: wire(request.url, autoFixtureAnswer(user, options.plan)) };
    return {
      status: answer.status,
      headers: { get: (name: string) => name.toLowerCase() === "x-request-id" ? `auto-fixture-${stage}-${String(attempt)}` : null },
      body: new TextEncoder().encode(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body)),
    };
  };
}
