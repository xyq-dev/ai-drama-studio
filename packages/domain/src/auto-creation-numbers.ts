/**
 * What a number in an automatic creation text means (checks v3, docs/AI_AUTO_CREATION.md §3.2).
 *
 * A cited text (a fact, an observation, a cited structure or audience) may carry only numbers its cited excerpts carry.
 * An uncited text (a hypothesis and how to verify it, an opportunity, a limitation, an applied constraint, an uncited
 * structure or audience, a direction's notes) may carry a number only when what it counts is the work itself or a plan:
 * the run's frozen settings, a position in the work (第 3 集), a story quantity (两个互不信任的人, 三次误会, 主角二十八岁,
 * 三天内) within the frozen limits, or a future plan (拟比较两个版本, 上线后观察七天). Every other number is refused:
 * a market statistic (shares, magnitudes, rankings, audience counts and ages, viewing durations and rates), a quantity
 * written as a measured result, a story quantity breaking a frozen setting, or a number with no recognised role. A
 * clause about viewers or the market that carries a story or plan quantity must say it is pending (是否, 可能, 待验证,
 * 计划, 拟…) in that clause, else it reads as a finding; a plan word in one clause never unlocks a finding in another.
 * The person's own audience constraint may be restated as the work's chosen target, never as evidence about real
 * viewers. The judgement is deterministic and names its rule; nothing here sends.
 */

import type { AutoViewingDurationReason } from "@ai-drama/contracts";

/** A number the run's own frozen input puts in text: its value and its unit (集, 秒, 分钟), or the limit it states. */
export type AutoExemptNumber = readonly [value: number, unit: "集" | "秒" | "分钟" | "人物上限" | "地点上限"];

/** The written form of a refused number. */
export type AutoNumberKind = "digits" | "percent" | "rank" | "chinese_numeral" | "fullwidth_digits";
/**
 * Why it was refused. market_statistic: a share, magnitude, ranking, audience count or age, viewing time or rate;
 * result_claim: a quantity presented as measured or as a settled audience finding; frozen_conflict: a story quantity
 * against the frozen episodes, length, cast or locations; unclassified: a number with no creative or plan role (a date,
 * a count of sources); unsourced: a cited text's number its sources do not carry.
 */
export type AutoNumberSemantic = "market_statistic" | "result_claim" | "frozen_conflict" | "unclassified" | "unsourced";

export interface AutoNumberFinding {
  /** The number as matched. Model text: for tests only, never stored. */
  token: string;
  kind: AutoNumberKind;
  semantic: AutoNumberSemantic;
  /** The sub-rule, a fixed slug (e.g. proportion, audience_age, cast_over_limit). */
  rule: string;
  /** For a viewing time (viewing_duration) only: which check refused it, a fixed slug. */
  reason?: AutoViewingDurationReason;
}

/** What an uncited text is judged against: the run's frozen settings. */
export interface AutoNumberFrame {
  exempt: ReadonlyArray<AutoExemptNumber>;
  /** The person's own audience constraint, restated verbatim (only when it carries no statistic itself). */
  frozenAudience: string;
  episodeCount: number;
  episodeSeconds: number;
  maxCharacters: number | null;
  maxLocations: number | null;
}

const CN_DIGITS = "〇零一二两俩仨三四五六七八九十百千几";
/** 几 counts as nine: the upper end of "a few", so 十几 is never taken for a small story count. */
const CN_VALUES: Readonly<Record<string, number>> = { 〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 俩: 2, 仨: 3, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 几: 9 };
const CN_UNITS: Readonly<Record<string, number>> = { 十: 10, 百: 100, 千: 1000 };
/** Units that make any Chinese numeral a claim, 一 included (一成 is ten percent). */
const CN_STRONG_UNITS = "成|万|亿|岁|倍|分之";
/** Measure words of people, times, places, money and durations. A bare 一 before them is the article (一个夜晚). */
const CN_COUNT_UNITS = "小时|分钟|名|人|位|个|次|遍|轮|元|块|集|场|天|周|年|月|户|家|条|部|份|秒|处";
/** Who a market counts. A Chinese numeral right before one of them is a number even with no measure word (五百用户). */
const AUDIENCE_NOUNS = "观众|用户|受众|粉丝|网友|会员|听众|读者|消费者";

const MARKET_WORDS = [
  "用户", "观众", "受众", "人群", "粉丝", "网友", "消费者", "会员", "人均", "平均", "日均", "每天", "每日", "每周", "每月", "完播", "留存",
  "流失", "追更", "追剧", "付费", "充值", "收入", "转化", "点击", "曝光", "流量", "占比", "比例", "播放", "观看", "热度", "人气", "排名", "排行",
  "榜", "名列", "位列", "位居", "冠军", "爆款", "热门", "热播", "头部", "同类", "行业", "市场", "平台", "样本", "数据", "案例", "调研", "调查",
  "统计", "最常见", "普遍", "多数", "大多", "主流", "流行", "受欢迎", "大部分", "少部分", "小部分", "划走", "弃剧", "跳出", "看完", "爱看", "最爱",
  "喜欢看", "刷剧", "刷过", "火了", "走红",
].join("|");
/** 前 3 名 or 前三个短剧 is a ranking; 前 3 秒 or 前两集 is a position in the work; 目前, 之前, 提前 are no ranking. */
const RANKING_FRONT = `(?<![目之提此以从面眼])前(?:\\d+|[${CN_DIGITS}]+)(?![\\d${CN_DIGITS}])(?!秒|分钟|集|场|幕)`;
/** A clause about viewers, a market, a ranking or other works: no number in it is the run's own setting. */
const MARKET_CLAUSE = new RegExp(`${MARKET_WORDS}|${RANKING_FRONT}`, "u");
const RANK_MARKERS = /排名|排行|榜|名列|位列|位居|热度|人气|冠军/u;
/** Rates and averages: in a market clause every number with one is a statistic, plan or not. */
const RATE = /每天|每日|每周|每月|每年|每人|每位|每次|每集|人均|日均|月均|平均/u;
/** Proportion words that are statistics in a market clause even without a digit. */
const PROPORTION_WORDS = /翻倍|翻番|成倍|倍增|减半|过半|半数|一半|大半|近半|超半|逾半|占(?:了)?多半|成千上万|成百上千|数以[万千百]计/u;
/** N 个 X 里 M 个: a share however it is written (三个人里两个人, 十个选题里八个). */
const RATIO = new RegExp(`(?:\\d+|[${CN_DIGITS}]+)(?:多|余)?[个位名部条][^，。\\d]{0,6}?(?:里|中|之中|当中)(?:就|有|只有|就有)*(?:\\d+|[${CN_DIGITS}]+)`, "u");
/** 三比一, 3:1 (9:16 is removed before): a share in any clause. */
const RATIO_WRITTEN = new RegExp(`(?:\\d+|[${CN_DIGITS}]+)(?:比|[:：])(?:\\d+|[${CN_DIGITS}]+)`, "u");
/** A quantity presented as measured: never in an uncited text, whatever it counts. Judged on the whole sentence. */
const RESULT = new RegExp([
  "(?:数据|调查|统计|测试|实测|结果|研究|报告|样本|资料|后台|平台|调研)(?:显示|表明|证明|发现|指出|证实|确认)",
  "测得|实测|测过|试过|投放过|上线过|跑过|对比过|比较过|胜出|跑赢|记录显示|收集到|跟踪下来",
  "已(?:经)?(?:比较|对比|测试|验证|观察|统计|调查|投放|测出|证明|证实|确认|上线)",
  "(?:经过?|通过)[^，。]{0,4}?(?:测试|验证|统计|调查|调研|投放|试看)",
].join("|"), "u");
/** Settled wordings without a result verb of RESULT (据统计, 实践证明, 业内公认). */
const SETTLED = /据(?:统计|调查|调研|数据|测算|观察)|(?:实践|事实|经验|研究)(?:证明|表明)|业内公认|行业公认|公认|普遍认为|众所周知/u;
/** Settled wordings about the market by themselves, with or without a viewer or market word (业内公认这种结构最有效). */
const SETTLED_MARKET = /据(?:统计|调查|调研|数据|测算)|业内公认|行业公认/u;
/**
 * A plan or a doubt that is all the clause says before its result wording, which keeps it pending (计划通过试看验证…,
 * 若数据显示…). Anything else before it (期待的…, 女将军题材, 若即若离的感情线) qualifies nothing.
 */
const SETTLED_QUALIFIER = /^(?:我们|团队|本剧|制作方)?(?:计划|拟|打算|准备|将要|如果|若|假如|假设|设想)(?:在[^，,。]{0,8}?[后前时])?(?:先|再|要|用|以)?$/u;
/**
 * A character as the subject right before a result wording, finding something that is not about viewers or the market
 * (主角调查发现站长在说谎, 主角的调查发现站长伪造账本): the story, not a finding. Only the character, alone before an
 * investigation's wording: 其他调查发现…, 观众对主角的调研证明…, 主角的数据显示… and 她调查发现观众… are findings.
 */
/**
 * A finding that names the work's own design or uses a word that only evaluates (这种结构有效, 这个人设最受用): never a
 * character's plot discovery. Whole words only: 好友, 灵堂, 更多 and 更衣室 are no evaluation.
 */
const WORK_VERDICT = /结尾|结局|结构|开场|开头|版本|剧本|剧情|故事|题材|写法|节奏|设定|人设|反转|桥段|套路|钩子|支线|冲突|悬念|本剧|该剧|此剧|这部剧|有效|有用|受用|管用|奏效|感人|感动|动人|带劲|抓人|吸引人|留得住|吸睛|好用|好使|灵验|灵光|精妙|绝伦|灵招|妙招|绝招|高招/u;
/**
 * An evaluation by its structure, not by a single character wherever it stands. A degree word in predicate position,
 * after a subject in the same part (这招很灵, 先抑后扬更胜一筹, 上述手法最具感染力, 这样写更能留住人); at the start of the
 * finding, or before a quantity or a time (更多线索, 更衣室藏着证据, 最后一页, 最早), it judges nothing. An evaluating word
 * ending its part (该招灵, 其手法妙, 反派越狠越好, 这种做法成功了), or an evaluating character carried on (妙不可言, 灵得出奇,
 * 妙极了). 好友, 灵堂 and 真相 are none of these.
 */
const EVALUATION = new RegExp([
  "(?<=[^，,。])(?:最为|更为|极其|极为|非常|十分|特别|最|更|很|太|够|极|挺)(?!多|少|后|初|终|近|早|先)",
  "(?<=[^，,。])相当(?!于)",
  "(?:超|真|蛮|颇)(?:好|灵|妙|棒|赞|精彩|厉害|出彩)",
  "^(?:最|更)[^，,。]{0,3}的(?:是|就是)",
  "(?:灵|妙|好|棒|成功|好用|管用|奏效)(?:了|啊|吧|呀|的|呢|嘛|哉)?$|绝了$",
  "(?:灵|妙|绝)(?:不可言|得|极|透)",
].join("|"), "u");
const STORY_FINDER = /^(?:主人公|主角|女主|男主|配角|反派|[她他])的?$/u;
/** Verbs of a verification plan (对比两个版本, 收集反馈): a plan by its wording, not by its field. */
const PLAN_VERBS = /对比(?!过)|统计(?!显示|表明|发现)|收集|邀请|跟踪|追踪|试看|投放(?!过)|测试(?!显示|发现|表明|过)|观察(?!到)|比较(?=[两二三几\d]|不同|各)|上线后/u;
/** Wording that keeps an audience judgement pending or makes it a plan. 目标 is no such word (目标观众 is a target, not a doubt). */
/** Doubt about a judgement, an open question a plan asks included (看哪个更受欢迎); 不可能, 无论哪种…都 and a bare 哪种 are none. */
const DOUBT = /是否|能否|会不会|(?<!不)可能|或许|也许|待验证|待检验|有待|需验证|需要验证|假设|推测|猜测|预计|预期|如果|若|假如|设想|之后再|再判断|再决定|尚未|(?:看|比较|对比|观察|测试|统计|判断|了解)[^，。；]{0,6}?(?<!无论|不管|不论)哪(?:个|一个|种|一种|版|一版|些)(?![^，。；]{0,4}?[都也])/u;
/** Plan wording: a plan states what will be done, not a doubt about what viewers think. */
const PLAN = new RegExp(`计划|(?<![模虚])拟|打算|准备|${PLAN_VERBS.source}`, "u");
const PENDING = new RegExp(`${DOUBT.source}|${PLAN.source}`, "u");
/**
 * What an audience prefers or how a work was received, a verdict between versions included (三次反转的版本口碑最好,
 * 版本胜过…): a finding unless doubted in its own clause.
 */
const PREFERENCE = new RegExp([
  "更(?:喜欢|爱|愿意|受欢迎|买账)|偏爱|爱看|喜欢看|买单|买账|追捧|反响|口碑|最受(?:欢迎|追捧|喜爱|关注|好评)|最吸引|受欢迎",
  "(?:版本|剧本|剧情|结尾|开场|开头|设定|方案)[^，。；]{0,4}?(?:最好|更好|最佳|胜过|不如|更强|最强)",
].join("|"), "u");
/**
 * A reception a plan collects or compares, as the last thing in its clause (收集观众口碑, 比较两个版本的观众反响): the
 * plan's object, no finding. Anything after it (…口碑最好, …口碑就知道) is read as written.
 */
const PLAN_OBJECT = new RegExp(`(?:${PLAN.source}|了解|看看)[^，。；]{0,12}?(?:反响|口碑|反馈)(?:反馈)?(?=[，,。；;！？!?]?$)`, "gu");
/**
 * A character's own taste or standing (女主爱看言情小说, 主角口碑很差, 她想买单): the story, not its audience. Only with the
 * character right before the word, and never about a version, a script or a plot (女主三次反转的版本口碑最好).
 */
const CHARACTER_TASTE = /(?:主人公|主角|女主|男主|配角|反派|[她他](?!们))[^，。；的]{0,4}?(?:爱看|喜欢看|口碑|买单|买账|反响)/u;
const NOT_A_CHARACTER = /版本|剧本|剧情|设定|故事|方案/u;
const AUDIENCE_NOUN = new RegExp(AUDIENCE_NOUNS, "u");

/** Whether a clause states what an audience prefers: not a character's own taste, not what a plan collects. */
function preference(clause: string): boolean {
  if (CHARACTER_TASTE.test(clause) && !NOT_A_CHARACTER.test(clause) && !AUDIENCE_NOUN.test(clause)) return false;
  return PREFERENCE.test(clause.replace(PLAN_OBJECT, GAP));
}

/** Wording that restates the person's audience constraint as the work's chosen target (目标观众：…, 拟面向…, 用户指定). */
const AUDIENCE_TARGET = /目标(?:观众|用户|人群|受众)|^(?:受众|观众|人群)[：:]|面向|针对|适合|邀请|(?:用户|人工)指定|拟定|用户约束|硬约束|用户设定|设定的/u;
/**
 * Wording anywhere in the sentence that turns a restated target into evidence about real viewers: a source or the
 * platform (数据显示, 本平台的受众, 抖音上的目标观众), or a profile, majority or ranking (多为, 付费最多的人群, 普遍爱看).
 */
const AUDIENCE_SOURCE = /平台|数据|统计|后台|样本|投放|抖音|快手|视频号|红果|小红书|B站|微博/u;
const AUDIENCE_PROFILE = /画像|真实用户|调研|调查|报告|行业|多为|大多|多数|大部分|主力|主体|最多|最高|最常见|普遍|头部|付费|占比|居多|偏多|为多|增长|舍得|花钱|消费|上的(?:目标)?(?:观众|用户|受众|人群)/u;
/** Wording that claims who the real viewers are, read only in the target's own clause (核心受众为…); elsewhere 主要看点 is craft. */
const AUDIENCE_PROFILE_NEAR = /主要|核心|集中|为主|真实|实际/u;
/** A disclaimer that the target is no profile or finding (不是平台真实用户画像, 非平台统计结果) claims none. */
const PROFILE_DISCLAIMER = /(?:不是|并非|不代表|不等于|不依赖|不基于|没有|非)[^，。；]{0,8}?(?:画像|结果|数据|统计|调研)/gu;
/** The only notes a restatement may carry in brackets: where the target came from, never a source (问卷所得, 同类剧观众). */
const TARGET_NOTE = /^(?:用户指定|用户约束|硬约束|用户设定|用户填写|拟定|目标|创作目标|待验证|尚待验证)$/u;

const PLAN_NUMBER = new RegExp(`(\\d+(?:\\.\\d+)?|[${CN_DIGITS}]+)\\s*(集|秒|分钟)`, "gu");
/** Ordinals, spaced or not: 第 3 集, 第二场, 播放量第 3. */
const ORDINAL = new RegExp(`第\\s*(?:\\d+|[${CN_DIGITS}]+)`, "gu");
/**
 * The ordinals that are a position in the work or the plan, never a place in a ranking: one followed by its own unit
 * (第 3 集, 第二场, 第 2 轮, 第一次, 第一时间), or an item number opening a clause (第一，…). Any other 第N is a place
 * (第三名, 播放量第 3) and needs a source.
 */
const STRUCTURAL_UNITS = "集|场|幕|章|节|季|话|回|段|镜|轮|稿|版|步|句|次|个|眼|人称|视角|印象|反应";
/** Positions in the story's own time (第 10 秒, 第二天): structural only outside a viewing or market clause. */
const STORY_TIME_UNITS = "秒|分钟|时间|天|晚|夜|日";
function structuralOrdinal(units: string): RegExp {
  return new RegExp(`${ORDINAL.source}\\s*(?=${units})|^\\s*${ORDINAL.source}\\s*(?=[，,、：:])`, "gu");
}
const STRUCTURAL_ORDINAL = structuralOrdinal(`${STRUCTURAL_UNITS}|${STORY_TIME_UNITS}`);
const STRUCTURAL_ORDINAL_IN_MARKET = structuralOrdinal(STRUCTURAL_UNITS);
/**
 * A step of a future verification plan (checks v13, a howToVerify only): 第一阶段, 第一项测试 / 验证 / 检查, 第一轮, 第一步.
 * It is a step whatever else its clause names (计划在第一轮试读后比较角色人气), so a ranking word elsewhere in the clause
 * makes it no place; the clause must be a plan by its own wording and claim nothing done or measured.
 */
const PLAN_STEP_ORDINAL = new RegExp(`${ORDINAL.source}(?=阶段|轮|步|项(?:测试|验证|检查))`, "gu");
/** A place the ordinal itself belongs to: a ranking, a chart or a metric right before it (排名第一, 榜单上位列第3, 人气第一轮). */
const RANK_PLACE_BEFORE = /(?:排名|排行|名次|榜单?|名列|位列|位居|播放量|销量|口碑|人气|热度|评分|收视率|点击量|票房)(?:上|中|里)?(?:为|是|在|居|列|达到|达)?$/u;
/** Marks an ordinal of a ranking so it is matched as one whole token (名次第三), in a statement and in a source alike. */
const RANK_PREFIX = "名次";
/** What a removed setting leaves behind: no digit, no noun, the end of any noun window. */
const GAP = "〓";

function limitPattern(words: string, units: string): RegExp {
  const number = `\\d+|[${CN_DIGITS}]+`;
  const limitWords = "\\s|最多|至多|不超过|上限为?|限制为?|限为|为|共|：|:";
  // After the word: only limit words between it and the number. Before the word: only right after a limit word.
  return new RegExp(`(?:${words})(?:${limitWords})*(${number})\\s*(?:${units})(?![\\d${CN_DIGITS}月年天周次小时])`
    + `|(?:最多|至多|不超过|上限|限)\\s*(${number})\\s*(?:${units})?\\s*(?:出场)?(?:${words})(?!化)`, "gu");
}

/**
 * A cast or location limit is restated only with the number right next to its own word: 人物最多 4 人, 最多四个人物,
 * 地点最多 3 个. A number elsewhere in a clause that merely mentions characters or places is not the limit.
 */
const LIMIT_PATTERNS: Readonly<Record<"人物上限" | "地点上限", RegExp>> = {
  人物上限: limitPattern("人物|角色", "人|名|位|个"),
  地点上限: limitPattern("地点|场景|场地", "个|处"),
};

const NUMBER_TOKEN = new RegExp([
  `${RANK_PREFIX}第(?:\\d+|[${CN_DIGITS}]+)`,
  "(?<![第\\d.])\\d+(?:\\.\\d+)?%?",
  "[０-９]+",
  `百分之[${CN_DIGITS}]+|百分百|[万千百]分之(?:\\d+|[${CN_DIGITS}]+)`,
  `(?<![${CN_DIGITS}])(?:上|过|破|近|逾|超|数)[万亿]`,
  // Generations of viewers: 九零后, 90 后.
  "[〇零一二三四五六七八九]{2}后|(?<![\\d.])\\d{2}后",
  `(?<![第${CN_DIGITS}])[${CN_DIGITS}]+(?:%|(?:多|余|来)?(?:${CN_STRONG_UNITS}|${CN_COUNT_UNITS})|(?=(?:多|余|来)?(?:${AUDIENCE_NOUNS})))`,
].join("|"), "gu");
const ARTICLE = new RegExp(`^一(?:${CN_COUNT_UNITS})$`, "u");

/** Ids of the run's own items: never numbers. Exactly the forms the schemas allow, so H13 is no id (H1 then 3). */
const ITEM_ID = /(?<![A-Za-z0-9])(?:[FOH][1-8]|D[1-3]|C[1-8]|L[1-6]|P[1-6])(?![0-9])/g;
/** Words that look like numerals and are not: 一成不变, 千万别 (must not), 万一 (in case), 万分 (extremely). */
const ORDINARY_WORDS = /一成不变|千万(?=别|不|要|小心|记住|注意)|万一|万分(?!之)|万万|十分(?!之|钟)|一一/gu;
/** Invisible characters that would split a numeral from its unit (三\u200b成). */
const INVISIBLE = /[\u200b-\u200d\u2060\ufeff\u00ad]/gu;

/** The value of a simple Chinese numeral (up to the thousands), or null. */
function chineseValue(text: string): number | null {
  let total = 0;
  let current: number | null = null;
  for (const char of text) {
    if (char in CN_VALUES) current = CN_VALUES[char]!;
    else if (char in CN_UNITS) {
      total += (current ?? 1) * CN_UNITS[char]!;
      current = null;
    } else return null;
  }
  return total + (current ?? 0);
}

function numberValue(numeral: string): number | null {
  if (/^\d/u.test(numeral)) return Number(numeral);
  if (/^[０-９]/u.test(numeral)) return Number(numeral.replace(/[０-９]/gu, (char) => String(char.charCodeAt(0) - 0xff10)));
  return chineseValue(numeral);
}

/**
 * The clauses of a text as the checks read them: ids, 9:16 and look-alike words removed, whitespace dropped (约 三 成
 * is 约三成), ordinals settled (a structural one removed, a ranking one kept whole as 名次第N), and the run's own
 * settings removed where a clause is not about viewers or the market (每天观看60秒 is a statistic even for a sixty-
 * second run). A person's own audience constraint, restated verbatim, is removed only as the chosen target: in a clause
 * that names it so (目标观众：…, 拟面向…) or holds it alone, with no profile claim in that clause (核心受众为…), in a
 * sentence that claims nothing measured or about real viewers with it (数据显示…, 根据调研…, 本平台的受众…, …多为…).
 * The constraint is the person's choice, never a source. planSteps: a verification plan, whose steps are removed as
 * structural ordinals before any ranking is read (checks v13, planStep).
 */
function sentencesOf(value: string, exempt: ReadonlyArray<AutoExemptNumber>, frozenAudience = "", planSteps = false): string[][] {
  return value
    .replace(INVISIBLE, "")
    .replace(ITEM_ID, " ")
    .replace(/S-[A-Z]+(?:-[A-Z0-9]+)*/g, " ")
    .replace(/9\s*[:：]\s*16/g, " ")
    .replace(/％/gu, "%")
    .split(/(?<=[。；;！？!?\n])/u)
    .map((sentence) => {
      const target = restatableAudience(sentence, frozenAudience);
      return sentence.split(/(?<=[，,])/u).map((raw) => clauseOf(raw, exempt, target, planSteps));
    })
    .filter((sentence) => sentence.some((clause) => clause.length > 0));
}

/** The frozen audience phrase when this sentence may restate it as the chosen target, else "" (nothing is removed). */
function restatableAudience(sentence: string, frozenAudience: string): string {
  if (frozenAudience.length < 2) return "";
  const compact = sentence.replace(/\s+/gu, "");
  if (!compact.includes(frozenAudience)) return "";
  const rest = compact.split(frozenAudience).join(GAP).replace(PROFILE_DISCLAIMER, GAP);
  if (RESULT.test(rest)) return "";
  // A source or the platform in a plan clause of its own (计划在平台投放两个版本) is where the plan runs; a profile,
  // majority or ranking word is a claim about the target in any clause (拟抢占这一付费最多的人群).
  return rest.split(/(?<=[，,])/u).some((clause) => AUDIENCE_PROFILE.test(clause)
    || (AUDIENCE_SOURCE.test(clause) && (clause.includes(GAP) || !PLAN.test(clause)))) ? "" : frozenAudience;
}

/** Whether a clause restates the frozen audience as the target: named so, or the phrase alone (a short note in brackets aside). */
function restatesTarget(clause: string, frozenAudience: string): boolean {
  if (frozenAudience.length < 2 || !clause.includes(frozenAudience)) return false;
  const rest = clause.split(frozenAudience).join(GAP).replace(PROFILE_DISCLAIMER, GAP);
  if (AUDIENCE_PROFILE_NEAR.test(rest)) return false;
  const notes = [...rest.matchAll(/[（(]([^）)]*)[）)]/gu)].map((note) => note[1]!);
  if (notes.some((note) => !TARGET_NOTE.test(note))) return false;
  const bare = rest.replace(/[（(][^）)]*[）)]/gu, "");
  return AUDIENCE_TARGET.test(bare) || bare.replace(/[\p{P}\s〓]/gu, "").length === 0;
}

/**
 * Whether the ordinal at this offset of a compact clause is a step of a future plan (checks v13): the clause plans by its
 * own wording (计划, 拟, 收集, 测试…), claims nothing done or measured (已, 试读过, 测得), and no ranking, chart or metric
 * takes the ordinal itself. Anything else keeps the reading it had: a structural unit, or a place in a ranking.
 */
function planStep(clause: string, offset: number): boolean {
  return PLAN.test(clause) && !SAMPLE_DONE.test(clause) && !RESULT.test(clause) && !RANK_PLACE_BEFORE.test(clause.slice(0, offset));
}

function clausesOf(value: string, exempt: ReadonlyArray<AutoExemptNumber>, frozenAudience = ""): string[] {
  return sentencesOf(value, exempt, frozenAudience).flat();
}

function clauseOf(raw: string, exempt: ReadonlyArray<AutoExemptNumber>, frozenAudience: string, planSteps: boolean): string {
  return [raw]
    .map((clause) => clause.replace(/\s+/gu, "").replace(ORDINARY_WORDS, GAP))
    .map((clause) => (restatesTarget(clause, frozenAudience) ? clause.split(frozenAudience).join(GAP) : clause))
    .map((clause) => (planSteps ? clause.replace(PLAN_STEP_ORDINAL, (ordinal, offset: number) => (planStep(clause, offset) ? GAP : ordinal)) : clause))
    // In a ranking clause no ordinal is a position; in a viewing clause 第 30 秒 is a viewing moment, not the story's.
    .map((clause) => (RANK_MARKERS.test(clause) ? clause : clause.replace(MARKET_CLAUSE.test(clause) ? STRUCTURAL_ORDINAL_IN_MARKET : STRUCTURAL_ORDINAL, GAP))
      .replace(ORDINAL, (ordinal) => `${GAP}${RANK_PREFIX}${ordinal}${GAP}`))
    .map((clause) => {
      if (MARKET_CLAUSE.test(clause)) return clause;
      let kept = clause.replace(PLAN_NUMBER, (whole, number: string, unit: string) =>
        exempt.some(([exemptValue, exemptUnit]) => exemptValue === numberValue(number) && exemptUnit === unit) ? GAP : whole);
      for (const [limit, pattern] of Object.entries(LIMIT_PATTERNS)) {
        kept = kept.replace(pattern, (whole, before: string | undefined, after: string | undefined) =>
          exempt.some(([exemptValue, exemptUnit]) => exemptUnit === limit && exemptValue === numberValue(before ?? after ?? "")) ? GAP : whole);
      }
      return kept;
    })[0]!;
}

interface NumberHit {
  token: string;
  /** Where the numeral itself ends (its unit, if any, follows). */
  numeralEnd: number;
  start: number;
  value: number | null;
}

const BARE_NUMERAL = new RegExp(`(?<![第${CN_DIGITS}])[${CN_DIGITS}]+(?![${CN_DIGITS}])`, "gu");
/** Words around a bare Chinese numeral that make it an amount: 约七十, 二十五到三十五, 三比一, 三千左右. */
const BARE_BEFORE = /(?:约|大约|大概|将近|接近|超过|达到|达|高达|只有|仅|近|在|是|为|占)$/u;
const BARE_AFTER = /^(?:左右|上下|比|到|至|之间|多|余|来)/u;

/**
 * The numbers of a clause. In a viewing or market clause a Chinese numeral is a number even with no measure word after it
 * (完播率约七十, 年龄二十五到三十五), so no statistic hides by dropping its unit. A bare 一 is the article.
 */
function hitsOf(clause: string, market = MARKET_CLAUSE.test(clause)): NumberHit[] {
  const hits: NumberHit[] = [];
  const covered: Array<[number, number]> = [];
  for (const match of clause.matchAll(NUMBER_TOKEN)) {
    const token = match[0];
    covered.push([match.index, match.index + token.length]);
    if (ARTICLE.test(token)) continue;
    const numeral = new RegExp(`^(?:${RANK_PREFIX}第)?(?:\\d+(?:\\.\\d+)?|[０-９]+|百分之[${CN_DIGITS}]+|百分百|[万千百]分之|[上过破近逾超数]|[${CN_DIGITS}]+)`, "u").exec(token)?.[0] ?? token;
    const bare = numeral.replace(new RegExp(`^${RANK_PREFIX}第`, "u"), "");
    hits.push({ token, start: match.index, numeralEnd: match.index + numeral.length, value: numberValue(bare) });
  }
  if (market) {
    for (const match of clause.matchAll(BARE_NUMERAL)) {
      const start = match.index;
      const end = start + match[0].length;
      if (covered.some(([from, to]) => start < to && end > from) || match[0] === "一") continue;
      const before = clause.slice(0, start);
      const after = clause.slice(end);
      if (!/[十百千]/u.test(match[0]) && !BARE_BEFORE.test(before) && !BARE_AFTER.test(after)) continue;
      hits.push({ token: match[0], start, numeralEnd: end, value: numberValue(match[0]) });
    }
    hits.sort((a, b) => a.start - b.start);
  }
  return hits;
}

/**
 * Number claims: digits, percentages and Chinese numerals with a unit (or right before an audience word), each as one
 * whole number, after the run's own settings and structural ordinals are removed. A cited text's tokens must each be
 * found whole among its sources' tokens; this is also how a source's numbers are read.
 */
export function numberTokens(value: string, exempt: ReadonlyArray<AutoExemptNumber> = []): string[] {
  return clausesOf(value, exempt).flatMap((clause) => hitsOf(clause).map((hit) => hit.token));
}

/** The kind of a refused number, for diagnosis without the text: rank, percent, Chinese numeral, full-width or plain digits. */
export function numberKind(token: string): AutoNumberKind {
  if (token.startsWith(RANK_PREFIX)) return "rank";
  if (/%|分之|百分百|成$/u.test(token)) return "percent";
  if (/^[０-９]/u.test(token)) return "fullwidth_digits";
  return /^\d/u.test(token) ? "digits" : "chinese_numeral";
}

const CLASSIFIERS = "个|位|名|次|处|场|幕|段|条|种|组|套|份|张|封|件|轮|遍|部|句|层|类|项|版|稿|对|双|股|方|批|伙|间|座|家|道|回|起|桩|笔|声|步";
/** Classifiers that count the work's own units by themselves (三场, 两次, 两处). */
const UNIT_CLASSIFIERS: Readonly<Record<string, NounGroup>> = { 场: "element", 幕: "element", 段: "element", 轮: "element", 次: "element",
  遍: "element", 回: "element", 步: "element", 处: "location" };
type NounGroup = "audience" | "cast" | "location" | "element";
/** Checked in this order at each position: an audience word wins over a story word that starts the same way (人群 before 人). */
const NOUNS: ReadonlyArray<readonly [NounGroup, readonly string[]]> = [
  ["audience", ["目标观众", "目标用户", "目标人群", "观众", "用户", "受众", "人群", "群体", "粉丝", "网友", "会员", "听众", "读者", "消费者", "人次", "人均", "人数", "人气", "人口",
    "样本", "账号", "平台", "短剧", "剧集", "作品", "爆款", "案例", "视频", "播放", "曝光", "点赞", "评论", "转发", "百分点"]],
  ["cast", ["主人公", "主角", "配角", "反派", "角色", "人物", "演员", "女主", "男主", "人"]],
  ["location", ["室内场景", "场景", "地点", "场地", "房间", "外景", "内景"]],
  ["element", ["反转", "误会", "误解", "伏笔", "转折", "冲突", "矛盾", "秘密", "线索", "谎言", "选择", "身份", "任务", "难关", "考验", "危机", "证据",
    "道具", "镜头", "戏", "情节", "悬念", "钩子", "笑点", "爆点", "泪点", "高潮", "结局", "结尾", "开头", "开场", "目标", "阻碍", "障碍", "困境",
    "关系", "阵营", "对手", "敌人", "朋友", "兄弟", "姐妹", "家庭", "事件", "谜题", "真相", "动作", "对话", "台词", "场面", "回合", "阶段", "主线",
    "支线", "视角", "时间线", "故事", "人设", "设定", "桥段", "版本", "方案", "方向", "选题", "标题", "节点", "情绪", "愿望", "约定", "承诺", "条件"]],
];
const NOUN_STOP = /[\d０-９，。；;！？!?,、：:（）()「」“”"'〓\s]/u;
/**
 * Common trades and roles of a short drama's people, right after a count's classifier. In a clause about viewers or the
 * market they are counted as 人, so a count of them there is still an audience count (三名学生观众).
 */
const OCCUPATION_NOUN = "职业人物";
/**
 * Counted people giving a verdict are a source, not a cast: a verdict by itself (三名学生都给了好评, 五名学生都说好看,
 * 三位老师一致推荐), or a weaker one about the work or a way of writing it (三个记者都夸这个结尾, 五名主播都用这种开场). A
 * story's own people may still think, agree, deny or recommend (两名警察认为主角是凶手, 两个同事互相推荐对方背锅), and a
 * sentence may still name the work or a way (本剧让三名骑手被迫合作, 三名骑手用这种方式逃脱).
 */
const VERDICT = /好评|差评|高分|低分|打分|评分|点赞|叫好|说好看|都说好(?!一起)|一致推荐|一致认可|都推荐|都认可|都满意|称赞/u;
const WEAK_VERDICT = /夸|赞|认可|推荐|满意|都说|都觉得|都认为|都用|都在用|都选|买单|爱看/u;
/**
 * A verdict the story is about rather than one the counted people give (三名学生因一条差评联手追查真相, 三名骑手遭遇恶意
 * 差评后决定寻找证据): a verdict noun right after a cause or an event, with at most a fixed modifier between, and a plot
 * consequence right after it. Anything else (收到剧本后好评不断, 因样片好评, 被感动后好评连连) is their verdict.
 */
const PLOT_CAUSE = /(?:因为?|由于|遭遇|遇到|收到)(?:一条|一则|一个|几条|一份|恶意|匿名|顾客的|客户的|网友的)?$/u;
const PLOT_VERDICT_NOUN = /^(?:好评|差评|高分|低分)/u;
const PLOT_CONSEQUENCE = /^(?:后|之后|而)|^(?:联手|决定|反目|追查|寻找|报复|陷入|失去|翻脸|结下|被开除|被停职|丢了)/u;
const WORK = /结尾|结局|结构|开场|开头|版本|剧本|剧情|题材|写法|节奏|设定|本剧|该剧|此剧|这部剧|这种|这类|这个/u;
const OCCUPATION = /^(?:骑手|外卖员|快递员|司机|医生|护士|警察|律师|老师|教师|学生|厨师|保安|保镖|服务员|店员|员工|职员|工人|记者|主播|网红|秘书|助理|经理|老板|总裁|室友|同事|邻居|乘客|租客|房客|房东|顾客|嫌疑人|证人|绑匪|小偷|保姆|村民|士兵|侦探|选手|歌手|女孩|男孩|少女|少年)/u;

function nounAt(text: string, at: number): { group: NounGroup; noun: string } | null {
  for (const [group, nouns] of NOUNS) {
    const noun = nouns.find((item) => text.startsWith(item, at));
    if (noun) return { group, noun };
  }
  return null;
}

/**
 * What a count counts: the noun after its classifier and modifiers (两个互不信任的人 → 人, 三次误会 → 误会). With a
 * 的 in the modifiers the head noun follows the last one (两个让观众意外的反转 → 反转); otherwise the first noun found.
 */
function countedNoun(tail: string): { group: NounGroup; noun: string } | null {
  const classifier = new RegExp(`^(?:${CLASSIFIERS})`, "u").exec(tail)?.[0] ?? "";
  const rest = tail.slice(classifier.length);
  let end = 0;
  while (end < rest.length && end < 12 && !NOUN_STOP.test(rest[end]!)) end += 1;
  const window = rest.slice(0, end);
  // People named by their trade or role right after the count (三名骑手, 两个室友) are a cast; see OCCUPATION_NOUN.
  if (OCCUPATION.test(window)) return { group: "cast", noun: OCCUPATION_NOUN };
  const de = window.lastIndexOf("的", 9);
  if (de >= 0) {
    const head = nounAt(window, de + 1);
    // 两个版本的评论, 两次以上反转的观众: the work's own noun right before 的 is what is counted, the rest is whose.
    const owner = NOUNS.filter(([group]) => group !== "audience").flatMap(([group, nouns]) => nouns
      .filter((item) => window.slice(0, de).endsWith(item)).map((noun) => ({ group, noun })))[0];
    if (owner && (!head || head.group === "audience")) return owner;
    if (head) return head;
  }
  for (let at = 0; at < Math.min(window.length, 9); at += 1) {
    const found = nounAt(window, at);
    if (found) return found;
  }
  const unit = UNIT_CLASSIFIERS[classifier];
  return unit ? { group: unit, noun: classifier } : null;
}

/**
 * A limit stated on the cast or the places (人物最多 5 个, 地点上限 4, 场景不超过 4 个, 角色上限：5): the cast or place
 * word, a limit word, the number, then at most a classifier of people or places before the clause ends. Only then is the
 * count a cast or the places, so a frozen limit is checked, never a number with no role. 场景为三块拼图 or 角色为五十元
 * states no limit: the count there is of something else.
 */
const LIMIT_WORDS_BEFORE = "(?:最多|至多|不超过|上限|限制|限|共)(?:为|是|：|:)?$";
const LIMIT_NOUN_BEFORE: ReadonlyArray<readonly [NounGroup, RegExp]> = [
  ["cast", new RegExp(`(?:人物|角色)${LIMIT_WORDS_BEFORE}`, "u")],
  ["location", new RegExp(`(?:地点|场景|场地)${LIMIT_WORDS_BEFORE}`, "u")],
];
const LIMIT_TAIL = /^(?:多|余)?(?:个|名|位|人|处|间)?(?=$|[，,。；;、）)！？!?])/u;

function limitNoun(before: string, tail: string): { group: NounGroup; noun: string } | null {
  if (!LIMIT_TAIL.test(tail)) return null;
  const found = LIMIT_NOUN_BEFORE.find(([, pattern]) => pattern.test(before));
  return found ? { group: found[0], noun: found[0] === "cast" ? "人物" : "地点" } : null;
}

/** A count of people (三位专家, 八名试映嘉宾, 五个网友): only these classifiers count those who could give a verdict. */
const PEOPLE_COUNTER = /^(?:多|余)?[名位个]/u;

const DURATION = /^(?:多|余|来)?(?:个)?(秒钟|秒|分钟|个小时|小时|天|个星期|星期|周|个月|年)/u;
/** A character named right before an age: 主角二十八岁, 女主 32 岁, 主角是二十八岁. */
const CHARACTER_BEFORE = /(?:主人公|主角|女主角?|男主角?|配角|反派|角色|人物)(?:是|为|设定为|今年|已经|才|刚|刚满)?$/u;
/** People an age may describe that are an audience, not a character: 二十多岁的女性, 25 岁的她们. */
const AUDIENCE_PEOPLE = /^的?(?:女性|男性|女生|男生|女人|男人|人|年轻人|群体|人群|观众|用户|受众|粉丝|网友|她们|他们|上班族|学生|宝妈|白领|中年人|老人)/u;
const AGE_BUCKET = /^(?:多|余|来)?(?:周)?岁(?:以上|以下|之间|上下|到|至|-|~|–)/u;

/**
 * A duration in a clause about viewers (checks v7) is one of three. A: the work's own length, named so right before it
 * (本剧60秒的故事, 每集约 60 秒的节奏, 本集60秒内): judged against the frozen setting, never by an equal value alone.
 * B: a viewing time, read from its own wording: a habit or a majority in the clause (通常, 一般, 大部分), a viewing verb
 * right before it (观看60秒, 看了60秒), also across a work reference it takes as its object (观看本剧60秒, 看了本集60秒:
 * how long they watch the work, unless the duration describes a noun after it, 观看本剧60秒的故事), or a viewer leaving
 * right after it (60秒后退出, 60秒就划走); averages, rates and
 * measured results are refused before (RATE, RESULT). C: a pending question whose duration names neither, within the
 * frozen length (观众能否在60秒内理解人物冲突): kept as written with a notice that its meaning is unconfirmed.
 */
const WORK_BEFORE = /(?:本剧|本集|该剧|此剧|这部剧|这集|本片|全剧|单集|整集|每集)(?:的)?(?:时长|篇幅|长度|片长)?(?:为|是|只有|仅|共|控制在)?(?:约|大约|大概)?$/u;
const WORK_AFTER = /^(?:钟)?(?=$|[，,。；;！？!?]|的|内|里|中|篇幅|时长|版本|长度)/u;
const VIEWING_HABIT = /通常|一般|往往|普遍|经常|常常|总是|习惯|大部分|大多|多数|大都/u;
const VIEWING_BEFORE = /(?:观看|看了|看|播放|停留|刷|浏览|坚持|待)(?:了)?(?:约|大约|大概|不到|超过|仅|只)?$/u;
const VIEWING_AFTER = /^(?:钟)?(?:左右|上下)?(?:后|之后|以后|就|便|即|内就|不到)*(?:会)?(?:退出|流失|划走|离开|关闭|跳出|弃剧|放弃|走掉|离场|停止|关掉|不看)/u;
/**
 * 每集 right before a number of seconds or minutes is the work's own unit, not a viewing rate (每集约 60 秒的节奏). For
 * another number of the clause it is the work's unit only when that number counts a named story thing (每集60秒内发生
 * 两次反转); a bare count of times beside it is still read with 每集 as a rate (把每集60秒的故事观看3次).
 */
const EPISODE_LENGTH_WORDS = "每集(?:的)?(?:时长|篇幅|长度|片长)?(?:为|是|只有|仅|共|控制在)?(?:约|大约|大概)?";
const EPISODE_LENGTH = new RegExp(`${EPISODE_LENGTH_WORDS}$`, "u");
const EPISODE_LENGTH_ANY = new RegExp(`每集(?=${EPISODE_LENGTH_WORDS.slice(2)}[\\d〇零一二两三四五六七八九十百]+(?:多|余|来)?(?:秒钟|秒|分钟))`, "gu");
/** A work-length duration that attributes a noun after it (本剧60秒的故事, 本剧60秒版本), not a time spent watching. */
const WORK_ATTRIBUTE = /^(?:钟)?(?:的|篇幅|时长|版本|长度)/u;

/**
 * The clause RATE reads for one number. A duration masks the 每集 right before it. Another number masks every 每集 that
 * is a work length only when it counts a named story thing: the noun it counts (反转, 误会, 人物), not a bare classifier.
 */
function rateText(clause: string, before: string, tail: string): string {
  if (/^(?:多|余|来)?(?:秒钟|秒|分钟)/u.test(tail)) {
    const unit = EPISODE_LENGTH.exec(before);
    return unit ? before.slice(0, unit.index) + GAP + clause.slice(unit.index + 2) : clause;
  }
  return countsStoryNoun(tail) ? clause.replace(EPISODE_LENGTH_ANY, GAP) : clause;
}

/** Whether a count names a story thing it counts (两次反转, 三个人物), not only a classifier of times (观看3次). */
function countsStoryNoun(tail: string): boolean {
  const counted = countedNoun(tail);
  if (!counted || counted.group === "audience") return false;
  const classifier = new RegExp(`^(?:${CLASSIFIERS})`, "u").exec(tail)?.[0];
  return !(classifier !== undefined && counted.noun === classifier && UNIT_CLASSIFIERS[classifier] !== undefined);
}

/**
 * A verification plan's sample of this work (checks v8), read only in a hypothesis' howToVerify: a count or a position
 * of episodes right before 样稿 or 样片, in a clause that says it is a plan (计划, 拟, 打算, 准备) to make, pick or read
 * that sample (计划制作三集样稿进行试读, 计划试读前三集样稿, 计划试读第 2 集样稿). Such a number is the sample, not the
 * work's total: it must lie within 1 and the frozen episode count. Nothing else of the clause is exempted: a sample
 * already taken (已, 曾, 试读过), a total changed (将本剧改为三集样稿) or a viewing habit (观众通常看完的三集样稿) is read as
 * before, and so is a rate, a share or a measured result anywhere in its sentence. checks v9: the sample verb must take
 * this very count as its object, right before it (制作三集样稿, 试读前三集样稿), with the plan word before that verb. A verb
 * elsewhere in the clause takes something else: 计划选取观众看完三集样稿后都弃剧的案例 picks cases and counts what viewers
 * watched; 计划把本剧缩至三集样稿后试读 cuts the work and reads it afterwards. Both are read as before.
 */
const SAMPLE_AFTER = /^集(?:的)?(?:样稿|样片)/u;
const SAMPLE_PLAN = /计划|(?<![模虚])拟|打算|准备/u;
/** Verbs that read or pick part of the work: their count is a sample by itself (checks v11). */
const SAMPLE_READ_VERBS = "选取|抽取|挑选|选出|抽出|试读|试看";
/** Verbs that make something: their count is a sample only when it names 样稿 or 样片 (checks v8). */
const SAMPLE_MAKE_VERBS = "制作|撰写";
const SAMPLE_VERB = new RegExp(`${SAMPLE_MAKE_VERBS}|${SAMPLE_READ_VERBS}`, "u");
/**
 * What may stand between a sample verb and its count: 前 or 头 (checks v9), and since checks v11 其中 or the work named
 * with a part of it (试读本剧前三集). Nothing else: a verb further off takes something else (计划选取观众看完三集…的案例).
 */
const SAMPLE_SCOPE = "(?:(?:本剧|该剧|此剧)的?(?:其中|前|头)|其中的?|前|头)?";
const SAMPLE_BOUND = new RegExp(`(?:${SAMPLE_MAKE_VERBS}|${SAMPLE_READ_VERBS})${SAMPLE_SCOPE}$`, "u");
const SAMPLE_READ_BOUND = new RegExp(`(?:${SAMPLE_READ_VERBS})${SAMPLE_SCOPE}$`, "u");
/** A reading or a sample already done: a result, not a plan. */
const SAMPLE_DONE = /已|曾|(?:制作|撰写|选取|抽取|挑选|试读|试看|观看|看|读|追|刷)(?:过|了)/u;
/**
 * A change of the work's own size (A): the work is not sampled, its total is rewritten. It is a change of this count
 * only when its wording takes the count, right before it (改为三集, 缩至三集, 压缩本剧到三集, 共计三集); an adjustment
 * elsewhere in the clause changes something else (把试读时间延长到三天) and leaves this count to be read for what it is.
 */
const TOTAL_CHANGE_BEFORE = new RegExp(`(?:${[
  "(?:改|缩|减|压|删|调整|变|扩|扩充|扩展|增|增加|延长|缩短|精简|浓缩|合并|拆)(?:成|为|至|到)",
  "(?:改编|缩减|压缩|删减|精简|浓缩|调整)(?:(?:本剧|全剧|该剧|此剧|整部剧)(?:的)?(?:集数)?)?(?:为|成|至|到)?",
  "共计|总共|一共|总计",
].map((part) => `(?:${part})`).join("|")})(?:约|大约|只有|仅)?$`, "u");
/** The work's total named right before the count (全剧三集, 本剧共三集). */
const TOTAL_BEFORE = /(?:本剧|全剧|该剧|此剧|整部剧)(?:的)?(?:总集数|集数)?(?:共|总共|一共|只有|仅有|仅|为|是|有)?(?:约)?$/u;
/** Viewers leaving after a count of episodes (B): a viewing statistic, plan word or not (看完三集后都弃剧). */
const EPISODE_LEAVING = /^集(?:的)?(?:样稿|样片)?(?:左右|上下)?(?:后|之后|以后|就|便|即)+(?:都|会|就|便)*(?:退出|流失|划走|离开|关闭|跳出|弃剧|放弃|走掉|离场|停止|关掉|不看|不再看)/u;
const EPISODE_ORDINAL = new RegExp(`第\\s*(\\d+|[０-９]+|[${CN_DIGITS}]+)\\s*集`, "gu");

/**
 * Whether a clause is a plan to sample this work: a plan word, a sample verb, no result, no habit. A new total is no
 * longer judged here, clause-wide: each count is checked against the wording that takes it (TOTAL_CHANGE_BEFORE), so
 * an adjustment of something else neither refuses a sample nor turns off the range check of a 第N集 sample.
 */
function samplePlan(clause: string): boolean {
  return SAMPLE_PLAN.test(clause) && SAMPLE_VERB.test(clause) && !SAMPLE_DONE.test(clause) && !VIEWING_HABIT.test(clause);
}

/**
 * Whether this count is the object of a sample verb, with a plan word before that verb (checks v9). A reading or picking
 * verb takes it as it is (试读前三集, 选取其中三集, checks v11); a making verb only as 样稿 or 样片 (制作三集样稿).
 */
function sampleBound(before: string, tail: string): boolean {
  const verb = (SAMPLE_AFTER.test(tail) ? SAMPLE_BOUND : SAMPLE_READ_BOUND).exec(before);
  return verb !== null && SAMPLE_PLAN.test(before.slice(0, verb.index));
}

/**
 * The scope of a count of episodes in a verification plan (checks v11), or null to read it as before (a total of the
 * work, or a viewing count next to viewers). Its order is the order of the rules: A, a new total of the work taking this
 * very count (改为三集, 本剧共三集; not an adjustment of something else in the clause) at another value than the frozen
 * one (at that value it is read by frozenTotal, checks v12), and B, a
 * viewing habit, viewers leaving after the count, or a reading already done, are refused as before; C, a sample its own
 * verb takes, must lie within the work; any other count of a future plan that is within the work is D, a scope the code
 * cannot place, kept as an unverified notice. A count larger than the work is no sample of it, whatever its scope.
 * Shares, rates, magnitudes and measured results were refused before this is asked.
 */
function verificationEpisodeScope(clause: string, clauses: readonly string[], before: string, tail: string, market: boolean, value: number | null,
  frame: AutoNumberFrame): Role | null {
  const total = totalWording(before);
  if (total) return value === frame.episodeCount ? frozenTotal(clause, clauses, before.slice(0, total.index), tail, market) : refuse("frozen_conflict", "episode_count");
  if (VIEWING_HABIT.test(clause) || EPISODE_LEAVING.test(tail) || SAMPLE_DONE.test(clause)) return null;
  const within = value !== null && value >= 1 && value <= frame.episodeCount;
  if (samplePlan(clause) && sampleBound(before, tail)) return within ? { allowed: true, rule: "verification_sample" } : refuse("frozen_conflict", "sample_out_of_range");
  // D needs a future plan of its own: the clause's plan word, or one earlier in the sentence for a clause not about
  // viewers; a clause about viewers must also be marked pending by itself, as every judgement there is.
  const index = clauses.indexOf(clause);
  const planned = market ? SAMPLE_PLAN.test(clause) && pendingJudgement(clause, clauses) : clauses.slice(0, index + 1).some((part) => SAMPLE_PLAN.test(part));
  if (!planned) return null;
  return within ? refuse("unclassified", "episode_scope_unconfirmed") : refuse("frozen_conflict", "episode_count");
}

/**
 * A sample position outside the work (计划试读第61集, 计划试读第61集样稿): the structural ordinal is removed before a clause
 * is read, so every position of episodes in a plan to sample the work is found here first, on the raw clause, and refused
 * as a frozen conflict when it lies outside 1 and the frozen episode count. Since checks v11 no 样稿 is needed.
 */
function sampleOrdinalRefusal(text: string, frame: AutoNumberFrame): AutoNumberFinding | null {
  for (const clause of text.replace(INVISIBLE, "").replace(/\s+/gu, "").split(/(?<=[，,。；;！？!?\n])/u)) {
    if (!samplePlan(clause)) continue;
    for (const match of clause.matchAll(EPISODE_ORDINAL)) {
      const value = numberValue(match[1]!);
      if (value === null || value < 1 || value > frame.episodeCount) {
        return { token: match[1]!, kind: numberKind(match[1]!), semantic: "frozen_conflict", rule: "sample_out_of_range" };
      }
    }
  }
  return null;
}

/**
 * A total of the work restated at its frozen value (checks v12, 待验证观众是否喜欢本剧共60集的体量 with 60 frozen): no
 * change of the work's size. The frozen value is removed before a clause not about viewers is read, so this is asked
 * for a clause about viewers, where it is kept: the total passes only when it is what the clause counts and the clause
 * is a pending judgement. The same value counts a viewing, not the work, after a reading or viewing verb (看完本剧共60集),
 * with viewers leaving after it (本剧60集后弃剧), beside a habit or a reading done, or with viewing or the market named
 * after it; nor does it pass in an unmarked finding (观众喜欢本剧共60集的体量). Null reads it as before. lead: the
 * clause before the total's wording. Measured results, rates and shares were refused before this is asked.
 */
function frozenTotal(clause: string, clauses: readonly string[], lead: string, tail: string, market: boolean): Role | null {
  if (VIEWING_HABIT.test(clause) || EPISODE_LEAVING.test(tail) || SAMPLE_DONE.test(clause) || DESIGN_TAKEN.test(lead)) return null;
  if (market && (!pendingJudgement(clause, clauses) || MARKET_CLAUSE.test(tail))) return null;
  return { allowed: true, rule: "work_total" };
}

/**
 * A range of the work's own structure (checks v12): a range word taking the count right before it, with at most the
 * work named before that word (本剧每三集, 每隔两集, 用三集, 用前三集, 本剧前三集). 目前, 之前 and 此前 are no range.
 */
const DESIGN_RANGE = /(?:(?:本剧|该剧|此剧)的?)?(?:每隔|每|用|(?<![目之提此以从面眼])前)$/u;
/**
 * A reading, viewing, picking or making verb that takes the count, over at most the work and a range word (试读前三集,
 * 看完前三集, 选取其中三集, 制作三集): what is counted is read or watched, not laid out. A verification plan's sample is a
 * howToVerify's own scope (verificationEpisodeScope); in a design the count is read as before. A count a making verb
 * takes (写三集, 拍三集) is how many episodes are made: read as before too.
 */
const DESIGN_TAKEN = new RegExp(`(?:${SAMPLE_MAKE_VERBS}|${SAMPLE_READ_VERBS}|观看|收看|阅读|浏览|播放|拍摄|看|读|追|刷|播|拍|写|做)(?:了|完|过)*`
  + "(?:(?:本剧|该剧|此剧)的?)?(?:每隔|每|其中的?|前|头)?$", "u");

/** A total named right before the count with no work named (共 3 集, 一共三集, 共计三集, 合计三集): a total, as 本剧共三集 is. */
const DESIGN_TOTAL = /(?:共|合计|总计)(?:有|计|是|为)?(?:约|大约|只有|仅)?$/u;
/**
 * The work's total its own words take, right before the count: the total named (总集数为三集, 本剧的集数是三集) or the
 * work laid out as a whole (本剧设计为三集, 全剧分三集, 本剧规划成三集). A part of the work comes first (本剧前三集设计为…,
 * 前三集的设计…) and is no total: the work's word must reach the count with nothing but these words between.
 */
const WORK_TOTAL_BEFORE = new RegExp("(?:(?:本剧|全剧|该剧|此剧|整部剧)的?(?:(?:总集数|集数)?(?:设计|规划|设定|定|安排|拆|划|分|计划)|总集数|集数)|总集数)"
  + "(?:成|为|是|共|有|分|到|至|只有|仅有|仅)?(?:约|大约)?$", "u");

/**
 * The wording of a total of the work taking this very count, or null: a change of its size (改为三集), the work or its
 * total named right before it (本剧共三集, 总集数为三集, 全剧分三集), or a total with no work named (共 3 集). The same in a
 * verification plan and in the work's own design (checks v12).
 */
function totalWording(before: string): RegExpExecArray | null {
  return TOTAL_CHANGE_BEFORE.exec(before) ?? TOTAL_BEFORE.exec(before) ?? WORK_TOTAL_BEFORE.exec(before) ?? DESIGN_TOTAL.exec(before);
}

/**
 * The scope of a count of episodes in the work's own design (checks v12): a structure's application, a hypothesis, its
 * plan, an opportunity, a direction's notes. Null reads it as before. A new total of the work taking this very count
 * (改为三集, 本剧共三集, 总集数为三集, 全剧分三集, 共 3 集; totalWording) at another value than the frozen one is refused as
 * before (frozenTotal reads it at that value); a reading or sample already done (已完成前三集的试读) is read as before; so is a viewing habit, viewers leaving after the count, or a count a reading,
 * viewing or sample verb takes. A count its own range word takes (每三集, 用前三集) or a position (第４集, its numeral
 * left by a full-width ordinal) is the work's structure: within 1 and the frozen episode count it is kept, else refused
 * as a range outside the work. In a clause about viewers it is read so only when that clause is marked pending and
 * nothing after the count names viewing or the market. Any other count of a clause not about viewers, nothing done,
 * within the work, is a scope the code cannot place: kept as written with an unverified notice; past the work, refused.
 */
function designEpisodeScope(clause: string, clauses: readonly string[], before: string, tail: string, market: boolean, value: number | null,
  frame: AutoNumberFrame): Role | null {
  const total = totalWording(before);
  if (total) return value === frame.episodeCount ? frozenTotal(clause, clauses, before.slice(0, total.index), tail, market) : refuse("frozen_conflict", "episode_count");
  if (VIEWING_HABIT.test(clause) || EPISODE_LEAVING.test(tail) || DESIGN_TAKEN.test(before)) return null;
  // A reading or sample already done (已完成前三集的试读, 曾用前三集样稿进行试读) is a result, not a range the work lays out.
  if (SAMPLE_DONE.test(clause) && SAMPLE_VERB.test(clause)) return null;
  if (market && (!pendingJudgement(clause, clauses) || MARKET_CLAUSE.test(tail))) return null;
  const within = value !== null && value >= 1 && value <= frame.episodeCount;
  if (/第$/u.test(before) || DESIGN_RANGE.test(before)) return within ? { allowed: true, rule: "episode_structure" } : refuse("frozen_conflict", "episode_range_out_of_range");
  if (market || SAMPLE_DONE.test(clause)) return null;
  return within ? refuse("unclassified", "episode_scope_unconfirmed") : refuse("frozen_conflict", "episode_count");
}

/**
 * A position of the work outside it, in its own design (checks v12): 第61集, 第六十一集, 第６１集 and 第零集 are refused as
 * a range outside the work. A structural ordinal is removed before a clause is read, so every 第N集 is found here first,
 * on the raw text; a ranking clause keeps its ordinals as places, and a cited text (a fact, a quote) is never read so.
 */
function designOrdinalRefusal(text: string, frame: AutoNumberFrame): AutoNumberFinding | null {
  for (const clause of text.replace(INVISIBLE, "").replace(/\s+/gu, "").split(/(?<=[，,。；;！？!?\n])/u)) {
    if (RANK_MARKERS.test(clause)) continue;
    for (const match of clause.matchAll(EPISODE_ORDINAL)) {
      const value = numberValue(match[1]!);
      if (value === null || value < 1 || value > frame.episodeCount) {
        return { token: match[1]!, kind: numberKind(match[1]!), semantic: "frozen_conflict", rule: "episode_range_out_of_range" };
      }
    }
  }
  return null;
}

/** Days a plan's duration takes, or null for a duration no plan uses (seconds, minutes, hours, years). */
function planDays(value: number, unit: string): number | null {
  if (unit === "天") return value;
  if (unit === "周" || unit.endsWith("星期")) return value * 7;
  if (unit === "个月") return value * 30;
  return null;
}

/** Most days a verification plan may run: a plan of a quarter is still a plan, a year of observation is a claim. */
const PLAN_MAX_DAYS = 90;
/** Most of one kind of story element a research text may count (the cast and places have their own limits). */
const STORY_MAX_COUNT = 30;
/** Largest cast a setting may have (the bible schema): a larger count of people is no story cast. */
const CAST_SCHEMA_MAX = 8;
const LOCATION_SCHEMA_MAX = 6;

type Role = { allowed: true; rule: string } | { allowed: false; semantic: AutoNumberSemantic; rule: string; reason?: AutoViewingDurationReason };

function refuse(semantic: AutoNumberSemantic, rule: string): Role {
  return { allowed: false, semantic, rule };
}

/** A viewing time, with the check that refused it (the rule and its meaning are unchanged). */
function viewingTime(reason: AutoViewingDurationReason): Role {
  return { allowed: false, semantic: "market_statistic", rule: "viewing_duration", reason };
}

/**
 * Whether the judgement a number belongs to is marked pending. A clause naming viewers or the market, or stating what an
 * audience prefers (更喜欢, 买账, 反响), is its own judgement and needs its own marker: a marker never crosses a comma to
 * unlock another clause's finding (计划比较两个版本，观众更喜欢三次反转的剧本 is a plan and a finding). A preference
 * needs a doubt (是否, 可能, 待验证…); a plan word beside it (计划比较两个版本观众更喜欢…, 上线后观众更喜欢…) is no doubt
 * about it. A story or plan clause is covered by its own marker, else by a marker in every judgement beside it.
 */
function pendingJudgement(clause: string, clauses: readonly string[]): boolean {
  const judgement = (text: string) => MARKET_CLAUSE.test(text) || preference(text);
  const marked = (text: string) => (preference(text) ? DOUBT.test(text) : PENDING.test(text));
  if (judgement(clause)) return marked(clause);
  // Its own plan word covers a plan clause, but not beside an undoubted preference (拟比较两个版本，观众更喜欢反转多的剧本).
  if (PENDING.test(clause)) return !clauses.some((other) => preference(other) && !DOUBT.test(other));
  const judgements = clauses.filter(judgement);
  return judgements.length > 0 && judgements.every(marked);
}

/** The role of one number in an uncited clause, read with the other clauses of its sentence. */
/** Whether a clause has a verdict its people give, not only one that befalls them in the story (三名学生因一条差评…). */
function givenVerdict(clause: string): boolean {
  const all = new RegExp(VERDICT.source, "gu");
  for (let found = all.exec(clause); found !== null; found = all.exec(clause)) {
    const rest = clause.slice(found.index);
    const plot = PLOT_CAUSE.test(clause.slice(0, found.index)) && PLOT_VERDICT_NOUN.test(rest)
      && PLOT_CONSEQUENCE.test(rest.slice(2)) && !/看|追更|付费|充值|买单/u.test(rest);
    if (!plot) return true;
  }
  return false;
}

function roleOf(hit: NumberHit, clause: string, clauses: readonly string[], market: boolean, frame: AutoNumberFrame, verificationPlan = false,
  structureDesign = false): Role {
  const sentence = clauses.join("");
  const kind = numberKind(hit.token);
  if (kind === "rank") return refuse("market_statistic", "ranking");
  const tail = clause.slice(hit.numeralEnd);
  if (kind === "percent" || /^(?:多|余)?(?:%|成|分之)/u.test(tail)) return refuse("market_statistic", "proportion");
  if (/^(?:多|余|来)?(?:[十百千]?[万亿]|倍|人次)/u.test(tail) || /[万亿倍]$/u.test(hit.token)) return refuse("market_statistic", "magnitude");
  if (/^后/u.test(tail)) return refuse("market_statistic", "audience_age");
  if (RESULT.test(sentence)) return refuse("result_claim", "measured_result");
  const before = clause.slice(0, hit.start);
  if (market && RATE.test(rateText(clause, before, tail))) return refuse("market_statistic", "rate_or_average");
  if (/^(?:比|[:：])/u.test(tail)) return refuse("market_statistic", "proportion");
  const value = hit.value;
  // Dates and ranges: 2026-10-18, 10 月, 25-35 岁. A range of ages is an age distribution.
  if (/^[-–~]|^(?:年\d|月|日|号)/u.test(tail) || (/年/u.test(tail.slice(0, 1)) && (value ?? 0) >= 1000)) {
    return /[-–~]\d+(?:周)?岁/u.test(tail) || /岁/u.test(tail.slice(0, 6)) ? refuse("market_statistic", "audience_age") : refuse("unclassified", "date_or_range");
  }
  if (/^(?:多|余|来)?(?:周)?岁/u.test(tail)) {
    // A story age stands next to its character (主角二十八岁) or describes a person who is no audience (30岁的单亲妈妈).
    const after = tail.replace(/^(?:多|余|来)?(?:周)?岁/u, "");
    const character = CHARACTER_BEFORE.test(before) || (!market && /^的/u.test(after) && !AUDIENCE_PEOPLE.test(after));
    const fictional = character && !AGE_BUCKET.test(tail) && !/[-–~到至]$/u.test(before) && !/^(?:多|余|来)/u.test(tail) && value !== null && value <= 100;
    return fictional ? { allowed: true, rule: "story_age" } : refuse("market_statistic", "audience_age");
  }
  const duration = DURATION.exec(tail);
  if (duration) {
    const unit = duration[1]!;
    if (market) {
      if (unit === "秒" || unit === "秒钟" || unit === "分钟") {
        const seconds = value === null ? Infinity : unit === "分钟" ? value * 60 : value;
        const after = tail.slice(duration[0].length);
        // B: a habit, a viewing verb or a viewer leaving makes it a viewing time, whatever it is next to or marked as.
        if (VIEWING_HABIT.test(clause)) return viewingTime("viewing_habit");
        if (VIEWING_AFTER.test(after)) return viewingTime("leaving_after");
        // A: the work's own length. The whole run (本剧, 全剧) may also be all its episodes together.
        const work = WORK_BEFORE.exec(before);
        // A viewing verb taking the work as its object measures the watching (观看本剧60秒), equal to the frozen value or not.
        if (work && VIEWING_BEFORE.test(before.slice(0, work.index)) && !WORK_ATTRIBUTE.test(after)) return viewingTime("viewing_the_work");
        if (work && WORK_AFTER.test(after)) {
          const whole = /(?:本剧|该剧|此剧|这部剧|本片|全剧)/u.test(before) ? frame.episodeSeconds * frame.episodeCount : frame.episodeSeconds;
          if (seconds === frame.episodeSeconds || seconds === whole) return { allowed: true, rule: "work_length" };
          return seconds > Math.max(whole, frame.episodeSeconds) ? refuse("frozen_conflict", "over_length") : refuse("frozen_conflict", "length_changed");
        }
        if (VIEWING_BEFORE.test(before)) return viewingTime("viewing_verb_before");
        if (seconds > frame.episodeSeconds) return viewingTime("over_episode_length");
        if (!pendingJudgement(clause, clauses)) return viewingTime("not_pending");
        // A moment of this episode asked about as pending (观众是否会在前 3 秒被吸引) is the episode's timeline.
        if (/(?:前|开头|开场|头)$/u.test(before)) return { allowed: true, rule: "story_time" };
        // C: pending, within the frozen length, naming neither the work nor a viewing time.
        return refuse("unclassified", "duration_unconfirmed");
      }
      // Days of observation only in a plan's wording (上线后观察七天); a hedge alone (可能三天内流失) is a claim.
      const days = value === null ? null : planDays(value, unit);
      // A day count in a clause with no market word may take its plan verb from the next one (上线七天后，计划比较…).
      if (days === null) return viewingTime("not_observation_unit");
      if (!PLAN_VERBS.test(MARKET_CLAUSE.test(clause) ? clause : sentence)) return viewingTime("no_plan_verb");
      if (days > PLAN_MAX_DAYS) return refuse("market_statistic", "long_observation");
      return { allowed: true, rule: "plan_duration" };
    }
    if (unit === "秒" || unit === "秒钟" || unit === "分钟") {
      const seconds = value === null ? Infinity : unit === "分钟" ? value * 60 : value;
      return seconds <= frame.episodeSeconds ? { allowed: true, rule: "story_time" } : refuse("frozen_conflict", "over_length");
    }
    return { allowed: true, rule: "story_time" };
  }
  if (/^集/u.test(tail)) {
    // A verification plan's count of episodes is read by its scope (checks v8, v9, v11): a sample its own verb takes
    // stays within the work, a scope the code cannot place is a notice, a new total or a viewing count is refused.
    const scope = verificationPlan ? verificationEpisodeScope(clause, clauses, before, tail, market, value, frame) : null;
    if (scope) return scope;
    // The work's own design lays out its parts by scope (checks v12); a plan's sample above stays its own. A plan the
    // rule above reads as done, a habit or viewers leaving (已完成前三集的试读) keeps that reading: no design after it.
    const settled = verificationPlan && (VIEWING_HABIT.test(clause) || EPISODE_LEAVING.test(tail) || SAMPLE_DONE.test(clause));
    const structure = structureDesign && !settled ? designEpisodeScope(clause, clauses, before, tail, market, value, frame) : null;
    if (structure) return structure;
    // The run's own episode count was removed already where it may be restated.
    return market ? refuse("market_statistic", "viewing_count") : refuse("frozen_conflict", "episode_count");
  }
  const counted = countedNoun(tail) ?? limitNoun(before, tail);
  if (!counted) {
    if (market) return refuse("market_statistic", "market_clause");
    // Counted people of any name giving a verdict (八名试映嘉宾都给了好评, 五位资深编剧都认为这种结构最抓人) are a reported
    // reaction, as counted trades are: never a number with no role, which checks v5 keeps as an unverified notice.
    // The verdict must come after the count and the count must be of people: 五十元购买一条差评 counts no reviewer.
    if (PEOPLE_COUNTER.test(tail) && (givenVerdict(tail) || (WEAK_VERDICT.test(tail) && WORK.test(tail)))) {
      return refuse("result_claim", "measured_result");
    }
    return refuse("unclassified", "no_role");
  }
  if (counted.group === "audience") return refuse("market_statistic", "audience_count");
  if (counted.group === "cast") {
    // People counted in a clause about viewers or the market are viewers (三百人愿意付费), not a cast.
    if (market && (counted.noun === "人" || counted.noun === OCCUPATION_NOUN)) return refuse("market_statistic", "audience_count");
    // Counted trades that judge or recommend are a reported reaction, not a story's cast.
    if (counted.noun === OCCUPATION_NOUN && (givenVerdict(clause) || (WEAK_VERDICT.test(clause) && WORK.test(clause)))) {
      return refuse("result_claim", "measured_result");
    }
    if (value === null || value > CAST_SCHEMA_MAX) return market ? refuse("market_statistic", "audience_count") : refuse("unclassified", "count_out_of_range");
    if (frame.maxCharacters !== null && value > frame.maxCharacters) return refuse("frozen_conflict", "cast_over_limit");
    return { allowed: true, rule: "story_cast" };
  }
  if (counted.group === "location") {
    if (value === null || value > LOCATION_SCHEMA_MAX) return refuse("unclassified", "count_out_of_range");
    if (frame.maxLocations !== null && value > frame.maxLocations) return refuse("frozen_conflict", "locations_over_limit");
    return { allowed: true, rule: "story_locations" };
  }
  if (value === null || value > STORY_MAX_COUNT) return refuse("unclassified", "count_out_of_range");
  return { allowed: true, rule: "story_count" };
}

/**
 * The first number an uncited text may not carry, or null. market: the whole text is about viewers (an uncited
 * audience, a direction's audience fit), so every clause is read as a market clause. A number refused for what it is (a
 * statistic, a measured result, a frozen conflict) is reported before one refused only for an unmarked judgement.
 */
export function uncitedNumberFinding(text: string, frame: AutoNumberFrame, options: { market?: boolean } = {}): AutoNumberFinding | null {
  return uncitedNumberReading(text, frame, options).refusal;
}

/**
 * The sub-rules kept as an unverified notice in creative text: no role (checks v5), a duration's meaning unconfirmed
 * (checks v7), and the scope of a count of episodes unconfirmed (checks v11 in a howToVerify; checks v12 in every
 * creative field read as the work's own design).
 */
export const AUTO_UNVERIFIED_RULES = ["no_role", "duration_unconfirmed", "episode_scope_unconfirmed"] as const;
const UNVERIFIED_RULES: ReadonlySet<string> = new Set(AUTO_UNVERIFIED_RULES);

/**
 * Every number of an uncited text read to the end (checks v5). unverified: creative text (a hypothesis, a plan, a
 * structure's application, an opportunity, a direction's notes) where a number with no recognised role (unclassified,
 * no_role) or a pending duration whose meaning the code cannot confirm (duration_unconfirmed, checks v7) is kept as
 * unverified instead of refused; the reading goes on past it, so any later number in the same clause, sentence or text is
 * still judged and refused for what it is. Only those sub-rules are kept: dates, counts out of range, statistics, viewing
 * times, measured results, frozen conflicts and unmarked judgements are refused as before. verificationPlan: a
 * hypothesis' howToVerify, where a plan's sample of this work is read as a sample, not the work's total (checks v8),
 * and a step of the plan (第一阶段, 第一轮) is its order, not a place in a ranking (checks v13, planStep).
 * structureDesign: a creative field (a structure's application, a hypothesis, its plan, an opportunity, a direction's
 * notes), where a count or position of episodes is read by its scope in the work (checks v12, designEpisodeScope).
 */
export function uncitedNumberReading(text: string, frame: AutoNumberFrame,
  options: { market?: boolean; unverified?: boolean; verificationPlan?: boolean; structureDesign?: boolean } = {}):
  { refusal: AutoNumberFinding | null; unverified: AutoNumberFinding[] } {
  const unverified: AutoNumberFinding[] = [];
  let unmarked: AutoNumberFinding | null = null;
  const verificationPlan = options.verificationPlan === true;
  const structureDesign = options.structureDesign === true;
  // A plan's sample keeps its own refusal; any other position outside the work is a range outside it.
  const outside = (verificationPlan ? sampleOrdinalRefusal(text, frame) : null) ?? (structureDesign ? designOrdinalRefusal(text, frame) : null);
  if (outside) return { refusal: outside, unverified };
  for (const clauses of sentencesOf(text, frame.exempt, frame.frozenAudience, verificationPlan)) {
    // Viewers, the market and a measured result named anywhere in the sentence carry over its commas (数据显示，三个人里…).
    const sentence = clauses.join("");
    // A stated audience preference makes the sentence about viewers even with no market word (大家更喜欢三次反转的剧本).
    const sentenceMarket = options.market === true || MARKET_CLAUSE.test(sentence) || clauses.some(preference);
    for (const clause of clauses) {
      const market = sentenceMarket;
      const proportion = market ? PROPORTION_WORDS.exec(clause)?.[0] : undefined;
      if (proportion) return { refusal: { token: proportion, kind: "percent", semantic: "market_statistic", rule: "proportion" }, unverified };
      const ratio = RATIO.exec(clause)?.[0] ?? RATIO_WRITTEN.exec(clause)?.[0];
      if (ratio) return { refusal: { token: ratio, kind: numberKind(ratio), semantic: "market_statistic", rule: "proportion" }, unverified };
      for (const hit of hitsOf(clause, market)) {
        const role = roleOf(hit, clause, clauses, market, frame, verificationPlan, structureDesign);
        if (!role.allowed) {
          const finding: AutoNumberFinding = { token: hit.token, kind: numberKind(hit.token), semantic: role.semantic, rule: role.rule,
            ...(role.reason ? { reason: role.reason } : {}) };
          if (options.unverified === true && role.semantic === "unclassified" && UNVERIFIED_RULES.has(role.rule)) {
            unverified.push(finding);
            continue;
          }
          return { refusal: finding, unverified };
        }
        // A story or plan quantity next to viewers or the market reads as a finding unless its judgement says it is pending.
        if (market && role.rule !== "story_age" && !pendingJudgement(clause, clauses)) {
          unmarked ??= { token: hit.token, kind: numberKind(hit.token), semantic: "result_claim", rule: "unmarked_audience_judgement" };
        }
      }
    }
  }
  return { refusal: unmarked, unverified };
}

/** The user's own audience constraint as a restatable phrase: only when it carries no share, magnitude or ranking. */
export function frozenAudiencePhrase(audience: string): string {
  const phrase = audience.replace(/\s+/gu, "");
  if (phrase.length < 2) return "";
  const statistic = clausesOf(phrase, []).some((clause) => hitsOf(clause).some((hit) => {
    const kind = numberKind(hit.token);
    return kind === "rank" || kind === "percent" || /^(?:%|成|[十百千]?[万亿]|倍)/u.test(clause.slice(hit.numeralEnd)) || /[万亿倍]$/u.test(hit.token);
  }));
  return statistic ? "" : phrase;
}

/**
 * Whether a text states a measured or settled finding about viewers or the market, numbers or not (调查证明观众更喜欢反转,
 * 已验证这类结尾受欢迎): a clause with a result's wording and no pending mark, in a sentence about viewers or the market.
 */
export function settledMarketClaim(text: string): boolean {
  return text.replace(INVISIBLE, "").replace(/\s+/gu, "").split(/[。；;！？!?]/u).some((sentence) => {
    const clauses = sentence.split(/(?<=[，,])/u);
    const market = MARKET_CLAUSE.test(sentence) || clauses.some(preference) || SETTLED_MARKET.test(sentence);
    return market && clauses.some((clause, index) => {
      const found = RESULT.exec(clause) ?? SETTLED.exec(clause);
      if (found === null) return false;
      const before = clause.slice(0, found.index);
      // What was found: the rest of the sentence, past its commas (他调查发现，观众更喜欢反转).
      const after = clause.slice(found.index + found[0].length) + clauses.slice(index + 1).join("");
      const story = STORY_FINDER.test(before) && found[0].startsWith("调查") && !MARKET_CLAUSE.test(after) && !preference(after)
        && !WORK_VERDICT.test(after) && !after.split(/[，,]/u).some((part) => EVALUATION.test(part));
      return !SETTLED_QUALIFIER.test(before) && !story;
    });
  });
}
