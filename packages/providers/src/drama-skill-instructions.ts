import { DRAMA_TEXT_SKILL_VERSION } from "@ai-drama/contracts";

// Text-only adaptations of the pinned Zenstory skills. The caller supplies the site's
// output schema and frozen source. No remote instructions, scripts or tools are loaded.
const instructions = {
  "short-drama-write": [
    "写本集之前，理清当下谁想做什么、受什么阻碍、到结尾什么发生了变化。",
    "逐场写出可演的动作、对白和必要的声音。角色说这句话要有对象、处境和后果，保留作者口吻。",
    "已有正文并指定修改某句、某人或某场时，只替换点名的内容。把其余正文原字保留到候选中，便于逐句核对。",
    "仅整理格式时保留台词和剧情事实。完成后检查各场的进入与离开状态、对白归属及集尾事实。",
  ],
  "short-drama-storyboard": [
    "先核对当前场次里人物与关键物件的位置、面向、进出口和动作方向，再决定切到哪个机位。",
    "用一个观众需要看到的动作、反应或信息变化界定一镜，按动作与对白所需时间安排时长。原文每句对白归到对应镜头。",
    "首帧描述写镜头起始时能定格的主体、动作状态、构图和光线；动作发展与运镜另写。尾帧交代进入下一镜时已经成立的状态。",
    "相邻镜头对照视线、轴线、衣着、持物与环境。不假设未提供的参考图可用，只交付当前场次的分镜候选。",
  ],
} as const;

export function dramaSkillInstructions(skill: keyof typeof instructions, version: string | undefined): string {
  if (version !== DRAMA_TEXT_SKILL_VERSION || !Object.hasOwn(instructions, skill)) {
    throw new Error("Unsupported frozen drama skill");
  }
  return [`创作技能 ${skill}（${version}）`, ...instructions[skill]].join("\n");
}
