import type { CreatorAgentStage, CreatorSkillId } from "@ai-drama/contracts";

// Routing is side-effect free. Compound and unclear requests stay in the chooser.
const intents: ReadonlyArray<[CreatorSkillId, RegExp]> = [
  ["short-drama-write", /改(?:写|一改)|润色|编剧|续写|(?:写|改|调整|优化|精简|缩短|加|补|重写).{0,15}(?:剧本|对白|台词|独白|对话|场戏|段戏|一集|一段)|(?:台词|对白|独白|剧本|对话|这句).{0,16}(?:改|自然|口语|精简|缩短|重写)|screenwrit|rewrite|dialogue/i],
  ["short-drama-storyboard", /分镜|拆镜|拆.{0,8}镜头|首帧提示词|镜头表|(?:规划|设计|列|拆|安排).{0,10}拍法|怎么拍|storyboard|shot list/i],
  ["qc-skill", /质检|黑屏|黑帧|静音|无声|没(?:有)?声音|(?:检查|检测|验收|核对|分析|查看|看下|看看).{0,15}(?:成片|导出|视频|音轨|字幕|声音|报告)|(?:成片|音轨|字幕|声音).{0,10}(?:有问题|查一下|检查|对不对)|quality check|\bqc\b|black frame|silent audio/i],
];
const stageSkills: Record<CreatorAgentStage, CreatorSkillId> = {
  script: "short-drama-write", storyboard: "short-drama-storyboard", export: "qc-skill",
};
const stageActions: Record<CreatorAgentStage, RegExp> = {
  script: /(?:自然|口语|说话|语气|对白|台词|对话|写得|人物动机|改一改|修改这句)/,
  storyboard: /(?:机位|镜头|拍法|景别|焦距|运镜|构图)/,
  export: /(?:音轨|画面异常|音画|检测结果|质量报告)/,
};

function unquoted(command: string): string {
  return command.normalize("NFKC").replace(/“[^”]*”|「[^」]*」|‘[^’]*’|"[^"]*"/g, " ");
}

function episodeNumber(value: string): number {
  const digits = "零一二三四五六七八九";
  const label = value.replace(/两/g, "二").replace(/〇/g, "零");
  const [tens, ones] = label.split("十");
  return ones === undefined
    ? Number(label.replace(/[零一二三四五六七八九]/g, char => String(digits.indexOf(char))))
    : (tens ? digits.indexOf(tens) : 1) * 10 + (ones ? digits.indexOf(ones) : 0);
}

export function targetsOtherEpisode(command: string, current: number): boolean {
  const text = unquoted(command);
  const mentions = /第\s*([\d零〇一二两三四五六七八九十]+(?:\s*(?:[、,~～-]|和|与|及|至|到)\s*第?\s*[\d零〇一二两三四五六七八九十]+)*)\s*集|[上下]一?集|本集|这一?集/gu;
  const opening = /(?:^|[,。；;！？!?\n])\s*(?:请问|请|麻烦)?(?:你)?(?:帮我|帮忙)?\s*$/u;
  const action = /(?:把|为|给|将|针对|处理|改|改写|重写|写|续写|做|润色|优化|调整|精简|缩短|拆解|规划|设计|检查|检测|核对|生成|查看|看下|看看)(?:一下|一遍)?\s*$/u;
  let previousTargetEnd = -1;
  for (const match of text.matchAll(mentions)) {
    const before = text.slice(0, match.index);
    const end = match.index + match[0].length;
    const coordinated = previousTargetEnd >= 0 && /^\s*(?:[、,~～-]|和|与|及|以及|至|到)\s*$/u.test(before.slice(previousTargetEnd));
    const negated = /(?:不要|不用|不必|无需|暂不|先不|不想|(?<![分区特个鉴识])别)[^,。；;！？!?\n]{0,12}$/u.test(before);
    const narrative = /^(?:[中里](?!的)|提过|提到|讲了|讲的是)/u.test(text.slice(end));
    // A reference (e.g. 承接第二集) and its coordinated references don't select the editing target.
    if (negated || !((opening.test(before) && !narrative) || action.test(before) || coordinated)) {
      previousTargetEnd = -1;
      continue;
    }
    previousTargetEnd = end;
    if (/^[上下]/u.test(match[0])) return true;
    const numbers = match[1]?.match(/[\d零〇一二两三四五六七八九十]+/gu) ?? [];
    if (numbers.some(label => episodeNumber(label) !== current)) return true;
  }
  return false;
}

export function chooseCreatorSkill(command: string, stage: CreatorAgentStage): CreatorSkillId | null {
  const text = unquoted(command);
  const clauses = text.split(/[，,。；;！？!?\n]|(?:然后|接着|再帮我)/)
    .map(clause => clause.replace(/(?:不用|不要|别|无需|不必|暂不|先不|不想).*/, ""));
  const hits = intents.filter(([, pattern]) => clauses.some(clause => pattern.test(clause)));
  if (hits.length === 1) return hits[0]![0];
  if (hits.length > 1) return null;
  return clauses.some(clause => stageActions[stage].test(clause)) ? stageSkills[stage] : null;
}
