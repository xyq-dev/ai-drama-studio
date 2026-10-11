import {
  SCRIPT_BREAKDOWN_LIMITS,
  SCRIPT_BREAKDOWN_OUTPUT_SCHEMA,
  scriptBreakdownOutputSchema,
  type ScriptBreakdownFrozenInput,
  type ScriptBreakdownOutput,
  type ScriptBreakdownRejection,
  type ScriptBreakdownScene,
  type ScriptBreakdownShot,
} from "@ai-drama/contracts";

/**
 * Prompt, output checks and stored text of a script breakdown. Provider-neutral, like title writing: adapters only
 * carry the system and user text plus the schema. The answer is accepted only as it is; nothing is repaired,
 * continued or replaced by the one-scene, one-shot template.
 */
export const SCRIPT_BREAKDOWN_SYSTEM_PROMPT = [
  "你是中文竖屏短剧的分镜师。",
  "只输出一个 json 对象，不要 Markdown 代码围栏，不要解释，不要工具调用。",
  "只拆解给出的剧本，不要增加剧本里没有的情节、人物或对白。",
  "不要包含 HTML、网址、projectId、reviewStatus、APPROVED 或 CURRENT。",
  "输出是待创作者修改和审核的草稿，不是审核结论；预计时长是计划，不是成片时长。",
].join("");

export interface ScriptBreakdownPrompt {
  system: string;
  user: string;
}

/** The text of a script revision the breakdown can read: only the editor's `{ text }` shape. */
export function scriptTextOf(content: unknown): string | null {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const record = content as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.text !== "string") return null;
  return record.text;
}

const L = SCRIPT_BREAKDOWN_LIMITS;

export function buildScriptBreakdownPrompt(input: ScriptBreakdownFrozenInput): ScriptBreakdownPrompt {
  const characters = input.characters.length === 0
    ? ["（作品还没有角色设定：characterKeys 一律输出空数组 []）"]
    : input.characters.map((item) => `${item.key}：${item.name}`);
  const target = input.targetEpisodeSeconds === null
    ? "作品没有记录每集目标时长：各镜预计秒数之和控制在 60–90 秒左右。"
    : `每集目标约 ${String(input.targetEpisodeSeconds)} 秒：各镜预计秒数之和尽量接近这个目标。`;
  return {
    system: SCRIPT_BREAKDOWN_SYSTEM_PROMPT,
    user: [
      `任务：把第 ${String(input.episodeNo)} 集剧本拆成场景和镜头，输出 json。`,
      target,
      "",
      "范围（超出即视为无效，不会被修补）：",
      `- 场景 ${String(L.minScenes)}–${String(L.maxScenes)} 场，按剧本顺序，键依次为 S1、S2……。`,
      `- 镜头共 ${String(L.minShots)}–${String(L.maxShots)} 镜，每场 1–${String(L.maxShotsPerScene)} 镜；按场景顺序排列，同一场的镜头连续给出。`,
      "- 镜头键写成“场景键-序号”，例如 S1-1、S1-2、S2-1，不能重复；sceneKey 必须是上面已有的场景键。",
      `- plannedSeconds 为 ${String(L.minShotSeconds)}–${String(L.maxShotSeconds)} 的整数秒；全集合计 ${String(L.minTotalSeconds)}–${String(L.maxTotalSeconds)} 秒。`,
      `- heading ≤${String(L.headingMaxChars)} 字（如“内景 咖啡馆”），timeOfDay ≤${String(L.timeOfDayMaxChars)} 字（不知道时给空字符串），description ≤${String(L.descriptionMaxChars)} 字。`,
      `- shotType ≤${String(L.shotTypeMaxChars)} 字（如远景、全景、中景、近景、特写），camera 写机位、构图和运镜 ≤${String(L.cameraMaxChars)} 字，action ≤${String(L.actionMaxChars)} 字。`,
      `- dialogue 每镜最多 ${String(L.maxLinesPerShot)} 句：line 必须逐字摘自剧本正文，speaker 必须是剧本里出现的说话人名字；没有对白时给 []。`,
      "- speaker 和 line 必须来自同一处明确的“说话人（可选表演提示）：对白”标注；旁白也须明确标注。不得换说话人或把动作说明当对白。",
      "- characterKeys 只能使用下面角色表里的键；表里没有的人物不要引用。",
      "",
      "角色表：",
      ...characters,
      "",
      "剧本正文（开始）",
      input.scriptText,
      "剧本正文（结束）",
      "",
      `episodeNo 必须是 ${String(input.episodeNo)}，schema 必须是 "${SCRIPT_BREAKDOWN_OUTPUT_SCHEMA}"。`,
      `示例结构：{"schema":"${SCRIPT_BREAKDOWN_OUTPUT_SCHEMA}","episodeNo":${String(input.episodeNo)},"scenes":[{"key":"S1","heading":"…","timeOfDay":"夜","description":"…"}],"shots":[{"key":"S1-1","sceneKey":"S1","shotType":"中景","camera":"…","action":"…","dialogue":[{"speaker":"…","line":"…"}],"characterKeys":["C1"],"plannedSeconds":4}]}`,
    ].join("\n"),
  };
}

export type ScriptBreakdownValidation =
  | { ok: true; output: ScriptBreakdownOutput }
  | { ok: false; code: ScriptBreakdownRejection };

function unsafeText(value: string): boolean {
  return /<\/?[a-zA-Z]/.test(value)
    || /javascript\s*:/i.test(value)
    || /https?:\/\//i.test(value)
    || /data:\s*text\/html/i.test(value);
}

function containsUnsafe(value: unknown): boolean {
  if (typeof value === "string") return unsafeText(value);
  if (Array.isArray(value)) return value.some((item) => containsUnsafe(item));
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).some((item) => containsUnsafe(item));
  return false;
}

/** Whitespace never decides a match: spaces, tabs, line breaks and full-width spaces are removed on both sides. */
export function normalizeForMatch(value: string): string {
  // NFKC turns the full-width space into a plain one, and \s covers both anyway.
  return value.normalize("NFKC").replace(/\s+/gu, "");
}

const QUOTES = /^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/gu;

/** True when the line, without surrounding quotes and whitespace, occurs in the script exactly. */
export function lineInScript(line: string, normalizedScript: string): boolean {
  const normalized = normalizeForMatch(line).replace(QUOTES, "");
  return normalized.length > 0 && normalizedScript.includes(normalized);
}

/**
 * Read explicit speaker labels, not names and sentences found anywhere in the script. Supports colon variants,
 * optional parenthesized performance notes after the speaker and quoted dialogue. A label on its own may introduce
 * one following quoted line; an unmarked action or prose line never inherits the previous speaker.
 */
function attributedDialogue(script: string): Array<{ speaker: string; line: string }> {
  const result: Array<{ speaker: string; line: string }> = [];
  let pendingSpeaker: string | null = null;
  for (const rawLine of script.split(/\r?\n/u)) {
    const line = normalizeForMatch(rawLine);
    const labelled = /^([^:]{1,160}):(.*)$/u.exec(line);
    if (labelled) {
      pendingSpeaker = null;
      const label = labelled[1]!.replace(QUOTES, "");
      const speaker = /^([^():]{1,20})(?:\([^()]{0,120}\))?$/u.exec(label)?.[1];
      if (!speaker) continue;
      const dialogue = labelled[2]!.replace(QUOTES, "");
      if (dialogue.length > 0) result.push({ speaker, line: dialogue });
      else pendingSpeaker = speaker;
    } else {
      if (pendingSpeaker && /^["'“‘「『].+["'”’」』]$/u.test(line)) {
        result.push({ speaker: pendingSpeaker, line: line.replace(QUOTES, "") });
      }
      pendingSpeaker = null;
    }
  }
  return result;
}

export function plannedTotalSeconds(output: ScriptBreakdownOutput): number {
  return output.shots.reduce((sum, shot) => sum + shot.plannedSeconds, 0);
}

function duplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

/**
 * Accepts a model answer only when it is one JSON object of the output schema for exactly the frozen episode, with
 * unique keys, every scene and character reference present, at least one shot per scene, shots grouped in scene
 * order, every dialogue line attributed to its speaker in the frozen script, and a total planned duration inside the range.
 */
export function validateScriptBreakdownOutput(content: string, input: ScriptBreakdownFrozenInput): ScriptBreakdownValidation {
  if (content.trim().length === 0) return { ok: false, code: "invalid_json" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return { ok: false, code: "invalid_json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, code: "invalid_json" };
  const claimed = (parsed as { episodeNo?: unknown }).episodeNo;
  if (typeof claimed === "number" && claimed !== input.episodeNo) return { ok: false, code: "episode_mismatch" };
  const result = scriptBreakdownOutputSchema.safeParse(parsed);
  if (!result.success) return { ok: false, code: "invalid_output" };
  const output = result.data;
  if (output.episodeNo !== input.episodeNo) return { ok: false, code: "episode_mismatch" };
  if (containsUnsafe(output)) return { ok: false, code: "unsafe_content" };
  if (duplicates(output.scenes.map((scene) => scene.key)) || duplicates(output.shots.map((shot) => shot.key))) {
    return { ok: false, code: "duplicate_key" };
  }
  const sceneIndex = new Map(output.scenes.map((scene, index) => [scene.key, index] as const));
  const characterKeys = new Set(input.characters.map((item) => item.key));
  for (const shot of output.shots) {
    if (!sceneIndex.has(shot.sceneKey)) return { ok: false, code: "missing_reference" };
    if (shot.characterKeys.some((key) => !characterKeys.has(key)) || duplicates(shot.characterKeys)) {
      return { ok: false, code: "missing_reference" };
    }
  }
  if (output.scenes.some((scene) => !output.shots.some((shot) => shot.sceneKey === scene.key))) {
    return { ok: false, code: "missing_reference" };
  }
  // Shots come scene by scene in scene order, so the shot order inside a scene is the order given.
  let previous = 0;
  for (const shot of output.shots) {
    const index = sceneIndex.get(shot.sceneKey)!;
    if (index < previous) return { ok: false, code: "invalid_output" };
    previous = index;
  }
  if (output.scenes.some((scene) => output.shots.filter((shot) => shot.sceneKey === scene.key).length > L.maxShotsPerScene)) {
    return { ok: false, code: "invalid_output" };
  }
  const dialogue = attributedDialogue(input.scriptText);
  for (const shot of output.shots) {
    for (const item of shot.dialogue) {
      const speaker = normalizeForMatch(item.speaker).replace(QUOTES, "");
      if (!dialogue.some((source) => source.speaker === speaker && lineInScript(item.line, source.line))) {
        return { ok: false, code: "dialogue_not_in_script" };
      }
    }
  }
  const total = plannedTotalSeconds(output);
  if (total < L.minTotalSeconds || total > L.maxTotalSeconds) return { ok: false, code: "duration_out_of_range" };
  return { ok: true, output };
}

/** Shots of one scene in their order. */
export function shotsOfScene(output: ScriptBreakdownOutput, sceneKey: string): ScriptBreakdownShot[] {
  return output.shots.filter((shot) => shot.sceneKey === sceneKey);
}

/** The dialogue column of a shot revision: one "speaker：line" per line, null without dialogue. */
export function breakdownDialogueText(shot: ScriptBreakdownShot): string | null {
  return shot.dialogue.length === 0 ? null : shot.dialogue.map((item) => `${item.speaker.trim()}：${item.line.trim()}`).join("\n");
}

/** The visual prompt column of a shot revision, composed from the separate fields; nothing is invented. */
export function breakdownShotPromptText(scene: ScriptBreakdownScene, shot: ScriptBreakdownShot): string {
  const time = scene.timeOfDay.trim();
  return [`${scene.heading.trim()}${time ? `（${time}）` : ""}`, shot.shotType.trim(), shot.camera.trim(), shot.action.trim()].join("；");
}
