import { vimaxPlanningStartSchema, type VimaxCandidateTarget, type VimaxPlanningStart, type VimaxPlatformSourceSnapshot } from "@ai-drama/contracts";
interface PhysicalLine { start: number; end: number; text: string }
export interface PlanningScene { key: string; start: number; end: number; heading: string; timeOfDay: string; description: string }
export interface PlanningDialogue { id: string; start: number; end: number; speaker: string; line: string }
function lines(text: string, offset = 0): PhysicalLine[] {
  return [...text.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)].filter(m => m[0].length > 0)
    .map(m => ({ start: offset + m.index, end: offset + m.index + m[1]!.length, text: m[1]! }));
}
/** Only explicit source syntax is recognized. Neither headings nor speakers are inferred from prose. */
export function planningSceneBoundaries(text: string): PlanningScene[] {
  const headings = lines(text).filter(l => l.text.startsWith("【场景】"));
  if (!headings.length || headings.length > 8 || headings[0]!.start !== 0 || headings.some(l => !l.text.slice(4).trim())) {
    throw new Error("请先把剧本原文明确标为“【场景】场景标题”，每场单独一行；此入口不会猜测场景边界或改写原文。");
  }
  return headings.map((heading, index) => ({ key: `S${index + 1}`, start: heading.start, end: headings[index + 1]?.start ?? text.length,
    heading: heading.text.slice(4), timeOfDay: "", description: "严格依据本场原文规划，保留事件与对白。" }));
}
export function planningSceneDialogue(text: string, scene: PlanningScene): PlanningDialogue[] {
  const result: PlanningDialogue[] = [];
  for (const physical of lines(text.slice(scene.start, scene.end), scene.start).slice(1)) {
    if (/^\s*$/.test(physical.text) || (physical.text.startsWith("【动作】") && physical.text.slice(4).trim())) continue;
    const spoken = /^([^：\r\n【】]{1,20})：(.+)$/u.exec(physical.text);
    if (!spoken) throw new Error("选中原文含未明确标注的行。请在剧本中使用“【动作】动作”或“角色名：对白”，批准新版本后重读；不会猜测说话人。");
    result.push({ id: `D${result.length + 1}`, start: physical.start, end: physical.end, speaker: spoken[1]!, line: spoken[2]! });
  }
  return result;
}
export function buildPlanningSourceDraft(source: VimaxPlatformSourceSnapshot, target: VimaxCandidateTarget,
  mappings: Record<string, string>, style: string, seconds: number): VimaxPlanningStart {
  const sceneSpans = planningSceneBoundaries(source.scriptText), selected = sceneSpans[target.ordinal - 1];
  if (!selected || selected.heading !== target.heading || target.sourceScriptRevisionId !== source.scriptRevisionId) throw new Error("目标场景的序号、标题或来源与原文范围不一致，请重新读取或先核对场景草稿。");
  const dialogue = planningSceneDialogue(source.scriptText, selected);
  const sourceDialogue = dialogue.map(line => {
    const matches = source.characters.filter(c => c.name === line.speaker);
    const key = mappings[line.id] ?? (matches.length === 1 ? matches[0]!.key : undefined);
    if (!key || !matches.some(c => c.key === key)) throw new Error(`请为 ${line.id} 的说话人“${line.speaker}”明确选择同名角色身份；未登记说话人需先补齐角色资料。`);
    return { ...line, characterKey: key };
  });
  return vimaxPlanningStartSchema.parse({ schema: "ads.vimax-planning.start.v1", target: { sceneId: target.sceneId,
    sceneRevisionId: target.sceneRevisionId, rowVersion: target.rowVersion },
    source: { scriptRevisionId: source.scriptRevisionId, scriptContentHash: source.scriptContentHash, characters: source.characters },
    sceneSpans, selectedSceneKeys: [selected.key], sourceDialogue, requirements: { aspectRatio: "9:16", targetSceneSeconds: seconds, style }, confirmedTextSend: true });
}
