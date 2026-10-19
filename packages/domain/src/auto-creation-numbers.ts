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
 * 计划, 拟…), else it reads as a finding. The judgement is deterministic and names its rule; nothing here sends.
 */

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
  "(?:数据|调查|统计|测试|实测|结果|研究|报告|样本|资料|后台|平台|调研)(?:显示|表明|证明|发现|指出|证实)",
  "测得|实测|测过|试过|投放过|上线过|跑过|对比过|比较过|胜出|跑赢",
  "已(?:经)?(?:比较|对比|测试|验证|观察|统计|调查|投放|测出|证明|证实|上线)",
  "(?:经过?|通过)[^，。]{0,4}?(?:测试|验证|统计|调查|调研|投放|试看)",
].join("|"), "u");
/** Verbs of a verification plan (对比两个版本, 收集反馈): a plan by its wording, not by its field. */
const PLAN_VERBS = /对比(?!过)|统计(?!显示|表明|发现)|收集|邀请|跟踪|追踪|试看|投放(?!过)|测试(?!显示|发现|表明|过)|观察(?!到)|比较(?=[两二三几\d]|不同|各)|上线后/u;
/** Wording that keeps an audience judgement pending or makes it a plan. 目标 is no such word (目标观众 is a target, not a doubt). */
const PENDING = new RegExp(`是否|能否|会不会|可能|或许|也许|待验证|待检验|有待|需验证|需要验证|假设|推测|猜测|预计|预期|计划|(?<![模虚])拟|打算|准备|如果|若|假如|设想|之后再|再判断|再决定|尚未|${PLAN_VERBS.source}`, "u");

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
 * second run). A person's own audience constraint, restated verbatim, is removed the same way.
 */
function sentencesOf(value: string, exempt: ReadonlyArray<AutoExemptNumber>, frozenAudience = ""): string[][] {
  return value
    .replace(INVISIBLE, "")
    .replace(ITEM_ID, " ")
    .replace(/S-[A-Z]+(?:-[A-Z0-9]+)*/g, " ")
    .replace(/9\s*[:：]\s*16/g, " ")
    .replace(/％/gu, "%")
    .split(/(?<=[。；;！？!?\n])/u)
    .map((sentence) => sentence.split(/(?<=[，,])/u).map((raw) => clauseOf(raw, exempt, frozenAudience)))
    .filter((sentence) => sentence.some((clause) => clause.length > 0));
}

function clausesOf(value: string, exempt: ReadonlyArray<AutoExemptNumber>, frozenAudience = ""): string[] {
  return sentencesOf(value, exempt, frozenAudience).flat();
}

function clauseOf(raw: string, exempt: ReadonlyArray<AutoExemptNumber>, frozenAudience: string): string {
  return [raw]
    .map((clause) => clause.replace(/\s+/gu, "").replace(ORDINARY_WORDS, GAP))
    .map((clause) => (frozenAudience.length >= 2 ? clause.split(frozenAudience).join(GAP) : clause))
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

const DURATION = /^(?:多|余|来)?(?:个)?(秒钟|秒|分钟|个小时|小时|天|个星期|星期|周|个月|年)/u;
/** A character named right before an age: 主角二十八岁, 女主 32 岁, 主角是二十八岁. */
const CHARACTER_BEFORE = /(?:主人公|主角|女主角?|男主角?|配角|反派|角色|人物)(?:是|为|设定为|今年|已经|才|刚|刚满)?$/u;
/** People an age may describe that are an audience, not a character: 二十多岁的女性, 25 岁的她们. */
const AUDIENCE_PEOPLE = /^的?(?:女性|男性|女生|男生|女人|男人|人|年轻人|群体|人群|观众|用户|受众|粉丝|网友|她们|他们|上班族|学生|宝妈|白领|中年人|老人)/u;
const AGE_BUCKET = /^(?:多|余|来)?(?:周)?岁(?:以上|以下|之间|上下|到|至|-|~|–)/u;

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

type Role = { allowed: true; rule: string } | { allowed: false; semantic: AutoNumberSemantic; rule: string };

function refuse(semantic: AutoNumberSemantic, rule: string): Role {
  return { allowed: false, semantic, rule };
}

/** The role of one number in an uncited clause. */
function roleOf(hit: NumberHit, clause: string, sentence: string, market: boolean, frame: AutoNumberFrame): Role {
  const kind = numberKind(hit.token);
  if (kind === "rank") return refuse("market_statistic", "ranking");
  const tail = clause.slice(hit.numeralEnd);
  if (kind === "percent" || /^(?:多|余)?(?:%|成|分之)/u.test(tail)) return refuse("market_statistic", "proportion");
  if (/^(?:多|余|来)?(?:[十百千]?[万亿]|倍|人次)/u.test(tail) || /[万亿倍]$/u.test(hit.token)) return refuse("market_statistic", "magnitude");
  if (/^后/u.test(tail)) return refuse("market_statistic", "audience_age");
  if (RESULT.test(sentence)) return refuse("result_claim", "measured_result");
  if (market && RATE.test(clause)) return refuse("market_statistic", "rate_or_average");
  if (/^(?:比|[:：])/u.test(tail)) return refuse("market_statistic", "proportion");
  const value = hit.value;
  // Dates and ranges: 2026-10-18, 10 月, 25-35 岁. A range of ages is an age distribution.
  const before = clause.slice(0, hit.start);
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
      // A moment of this episode asked about as pending (观众是否会在前 3 秒被吸引) is the episode's timeline.
      if (unit === "秒" || unit === "秒钟" || unit === "分钟") {
        const seconds = value === null ? Infinity : unit === "分钟" ? value * 60 : value;
        const moment = /(?:前|开头|开场|头)$/u.test(before) && seconds <= frame.episodeSeconds && PENDING.test(sentence);
        return moment ? { allowed: true, rule: "story_time" } : refuse("market_statistic", "viewing_duration");
      }
      // Days of observation only in a plan's wording (上线后观察七天); a hedge alone (可能三天内流失) is a claim.
      const days = value === null ? null : planDays(value, unit);
      if (days === null || !PLAN_VERBS.test(sentence)) return refuse("market_statistic", "viewing_duration");
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
    // The run's own episode count was removed already where it may be restated.
    return market ? refuse("market_statistic", "viewing_count") : refuse("frozen_conflict", "episode_count");
  }
  const counted = countedNoun(tail);
  if (!counted) return market ? refuse("market_statistic", "market_clause") : refuse("unclassified", "no_role");
  if (counted.group === "audience") return refuse("market_statistic", "audience_count");
  if (counted.group === "cast") {
    // People counted in a clause about viewers or the market are viewers (三百人愿意付费), not a cast.
    if (market && counted.noun === "人") return refuse("market_statistic", "audience_count");
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
 * audience, a direction's audience fit), so every clause is read as a market clause.
 */
export function uncitedNumberFinding(text: string, frame: AutoNumberFrame, options: { market?: boolean } = {}): AutoNumberFinding | null {
  for (const clauses of sentencesOf(text, frame.exempt, frame.frozenAudience)) {
    // Viewers, the market and a measured result named anywhere in the sentence carry over its commas (数据显示，三个人里…).
    const sentence = clauses.join("");
    const sentenceMarket = options.market === true || MARKET_CLAUSE.test(sentence);
    for (const clause of clauses) {
      const market = sentenceMarket;
      const proportion = market ? PROPORTION_WORDS.exec(clause)?.[0] : undefined;
      if (proportion) return { token: proportion, kind: "percent", semantic: "market_statistic", rule: "proportion" };
      const ratio = RATIO.exec(clause)?.[0] ?? RATIO_WRITTEN.exec(clause)?.[0];
      if (ratio) return { token: ratio, kind: numberKind(ratio), semantic: "market_statistic", rule: "proportion" };
      for (const hit of hitsOf(clause, market)) {
        const role = roleOf(hit, clause, sentence, market, frame);
        if (!role.allowed) return { token: hit.token, kind: numberKind(hit.token), semantic: role.semantic, rule: role.rule };
        // A story or plan quantity next to viewers or the market reads as a finding unless the sentence says it is pending.
        if (market && role.rule !== "story_age" && !PENDING.test(sentence)) {
          return { token: hit.token, kind: numberKind(hit.token), semantic: "result_claim", rule: "unmarked_audience_judgement" };
        }
      }
    }
  }
  return null;
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
