import {
  EPISODE_DRAFT_SCHEMA,
  STORY_PLAN_SCHEMA,
  WRITING_BODY_MAX_CHARS,
  WRITING_IMPORT_MAX_BYTES,
  WRITING_NOTE_MAX_CHARS,
  WRITING_PROMPT_VERSION,
  episodeDraftCandidateSchema,
  storyPlanCandidateSchema,
  type EpisodeDraftCandidate,
  type StoryPlanCandidate,
} from "@ai-drama/contracts";
import { DomainError } from "./errors";

export {
  EPISODE_DRAFT_SCHEMA,
  STORY_PLAN_SCHEMA,
  WRITING_BODY_MAX_CHARS,
  WRITING_IMPORT_MAX_BYTES,
  WRITING_NOTE_MAX_CHARS,
  WRITING_PROMPT_VERSION,
};
export { DomainError };
export type { EpisodeDraftCandidate, StoryPlanCandidate };

export interface StoryPlanRequest {
  premise: string;
  genre: string;
  audience: string;
  characters: string;
  mustKeep: string;
  mustNotChange: string;
  currentText: string;
}

export interface EpisodeDraftRequest {
  episodeNo: number;
  premise: string;
  genre: string;
  audience: string;
  characters: string;
  confirmedStory: string;
  currentText: string;
  revisionRequest: string;
  mustKeep: string;
  mustKeepDialogue: string;
  mustKeepEnding: string;
}

export interface WritingTargetSnapshot {
  projectId: string;
  entityKey: string;
  mode: "story" | "episode";
  episodeNo: number | null;
  sourceRevisionId: string | null;
  ifMatch: number | null;
  draftFingerprint: string;
  currentText: string;
  loaded: boolean;
}

export interface FrozenWritingContext extends WritingTargetSnapshot {
  promptVersion: string;
  inputFingerprint: string;
  loaded: true;
}

export type WritingImport =
  | { mode: "story"; plan: StoryPlanCandidate }
  | { mode: "episode"; draft: EpisodeDraftCandidate };

const STORY_RULES = [
  "创作者写明的事实、必须保留的内容和禁止改动的内容优先于创作建议。",
  "人物行动要有目标、阻力和后果。",
  "核心冲突要能在人物关系里持续发生，而不是只换题材标签。",
  "三集都要写清进入状态、目标、行动、转折、结果，以及交给下一集的事实。",
  "相邻集的事实和人物状态要能交接。",
  "不强制每一集使用相同的反转、钩子或节拍公式。",
  "这些是创作建议，不是平台审核结论，不能把结果标成 APPROVED 或 CURRENT。",
].join("\n");

const EPISODE_RULES = [
  "创作者写明的事实、必须保留的对白、结局和禁止改动的内容优先于创作建议。",
  "人物行动要有目标、阻力和后果。",
  "每个场景要推动信息、关系、风险或状态变化；没有变化的场景不要凑数。",
  "对白承担人物行动，不堆解释。",
  "可用声音标记标明必要的画外声或音效，不要把标记写成第二份剧情说明。",
  "局部修改保留没有点名的段落。",
  "写出下一集必须继承的事实，使相邻集的人物状态能够交接。",
  "不强制使用固定反转、钩子或节拍公式。",
  "这些是创作建议，不是平台审核结论，不能把结果标成 APPROVED 或 CURRENT。",
].join("\n");

function assertNote(label: string, value: string): void {
  if (value.length > WRITING_NOTE_MAX_CHARS) {
    throw new DomainError("WRITING_TOO_LARGE", `${label}超过 ${WRITING_NOTE_MAX_CHARS} 字，已拒绝`);
  }
  if (value.includes("\u0000")) {
    throw new DomainError("WRITING_INVALID_CANDIDATE", `${label}含有空字符`);
  }
}

function assertBody(value: string): void {
  if (value.length > WRITING_BODY_MAX_CHARS) {
    throw new DomainError("WRITING_TOO_LARGE", `当前正文超过 ${WRITING_BODY_MAX_CHARS} 字，已拒绝`);
  }
}

function assertSavedBody(label: string, value: string): void {
  if (value.length > WRITING_BODY_MAX_CHARS) {
    throw new DomainError("WRITING_TOO_LARGE", `${label}超过 ${WRITING_BODY_MAX_CHARS} 字，已拒绝，没有截断`);
  }
  if (value.includes("\u0000")) {
    throw new DomainError("WRITING_INVALID_CANDIDATE", `${label}含有空字符`);
  }
}

function stableWritingJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableWritingJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableWritingJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function writingInputFingerprint(value: unknown): string {
  return `${WRITING_PROMPT_VERSION}|${stableWritingJson(value)}`;
}

function header(mode: string): string[] {
  return [
    `提示词版本：${WRITING_PROMPT_VERSION}`,
    "本轮通过外部 AI 创作，网页不会自动调用模型。",
    `模式：${mode}`,
    "只返回一个 JSON 对象，不要使用 Markdown 代码围栏。",
    "不要包含 projectId、If-Match、reviewStatus、HTML、URL 或工具调用。",
  ];
}

export function buildStoryPlanInstruction(request: StoryPlanRequest): string {
  assertNote("梗概", request.premise);
  assertNote("题材", request.genre);
  assertNote("目标观众", request.audience);
  assertNote("人物设定", request.characters);
  assertNote("必须保留", request.mustKeep);
  assertNote("禁止改动", request.mustNotChange);
  assertBody(request.currentText);
  return [
    ...header("故事策划"),
    "创作建议：",
    STORY_RULES,
    "作品梗概：",
    request.premise,
    "题材（只属于本次助手草稿，不是已保存的项目配置）：",
    request.genre,
    "目标观众（只属于本次助手草稿，不是已保存的项目配置）：",
    request.audience,
    "人物设定（只属于本次助手草稿，不是已保存的项目配置）：",
    request.characters,
    "必须保留：",
    request.mustKeep,
    "禁止改动：",
    request.mustNotChange,
    "当前正文：",
    request.currentText,
    "请输出 schema 为 ads.writing.story-plan.v1 的 JSON。",
    "字段：logline、protagonistGoal、opposition、coreConflict、relationships[{name,pressure}]、episodes 共 3 项。",
    "episodes 的 episodeNo 必须正好是 1、2、3 且不重复。",
    "每一项包含 entryState、goal、action、turn、result、handoff。",
  ].join("\n");
}

export function buildEpisodeDraftInstruction(request: EpisodeDraftRequest): string {
  if (request.episodeNo !== 1 && request.episodeNo !== 2 && request.episodeNo !== 3) {
    throw new DomainError("WRITING_EPISODE_MISMATCH", "当前试制只接受第 1、2、3 集");
  }
  assertNote("梗概", request.premise);
  assertNote("题材", request.genre);
  assertNote("目标观众", request.audience);
  assertNote("人物设定", request.characters);
  assertSavedBody("已确认的故事材料", request.confirmedStory);
  assertNote("修改要求", request.revisionRequest);
  assertNote("必须保留", request.mustKeep);
  assertNote("必须保留的对白", request.mustKeepDialogue);
  assertNote("必须保留的结局", request.mustKeepEnding);
  assertBody(request.currentText);
  return [
    ...header("单集写作"),
    "创作建议：",
    EPISODE_RULES,
    `当前集：第 ${request.episodeNo} 集`,
    "作品梗概：",
    request.premise,
    "题材（只属于本次助手草稿，不是已保存的项目配置）：",
    request.genre,
    "目标观众（只属于本次助手草稿，不是已保存的项目配置）：",
    request.audience,
    "人物设定（只属于本次助手草稿，不是已保存的项目配置）：",
    request.characters,
    "创作者确认使用的故事与分集材料：",
    request.confirmedStory,
    "修改要求：",
    request.revisionRequest,
    "必须保留的事实：",
    request.mustKeep,
    "必须保留的对白：",
    request.mustKeepDialogue,
    "必须保留的结局：",
    request.mustKeepEnding,
    "当前正文：",
    request.currentText,
    "请输出 schema 为 ads.writing.episode-draft.v1 的 JSON。",
    `episodeNo 必须是 ${request.episodeNo}。`,
    "字段：title、screenplay、scenes[{heading,action,dialogue,sound}]、handoffFacts。",
    "screenplay 写完整单集剧本，包含场景、动作、对白和必要的声音标记。",
  ].join("\n");
}

function unsafeText(value: string): boolean {
  return /<\/?[a-zA-Z]/.test(value)
    || /javascript\s*:/i.test(value)
    || /https?:\/\//i.test(value)
    || /data:\s*text\/html/i.test(value);
}

function assertSafe(value: unknown): void {
  if (typeof value === "string") {
    if (unsafeText(value)) {
      throw new DomainError("WRITING_UNSAFE_CONTENT", "候选含有 HTML、URL 或可执行标记，已拒绝");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSafe(item);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) assertSafe(item);
  }
}

export function parseWritingImport(
  bytes: Uint8Array,
  expected: { mode: "story" | "episode"; episodeNo: number | null },
): WritingImport {
  if (bytes.byteLength > WRITING_IMPORT_MAX_BYTES) {
    throw new DomainError("WRITING_TOO_LARGE", `导入文件超过 ${WRITING_IMPORT_MAX_BYTES} 字节，已拒绝`);
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DomainError("WRITING_INVALID_JSON", "导入内容不是 UTF-8 文本");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new DomainError("WRITING_INVALID_JSON", "导入内容不是合法 JSON");
  }
  const schema = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as { schema?: unknown }).schema
    : undefined;
  if (expected.mode === "story") {
    if (schema !== STORY_PLAN_SCHEMA) {
      throw new DomainError("WRITING_INVALID_CANDIDATE", "故事策划需要 ads.writing.story-plan.v1");
    }
    const result = storyPlanCandidateSchema.safeParse(parsed);
    if (!result.success) {
      throw new DomainError("WRITING_INVALID_CANDIDATE", result.error.issues[0]?.message ?? "故事策划候选无效");
    }
    assertSafe(result.data);
    return { mode: "story", plan: result.data };
  }
  if (schema !== EPISODE_DRAFT_SCHEMA) {
    throw new DomainError("WRITING_INVALID_CANDIDATE", "单集写作需要 ads.writing.episode-draft.v1");
  }
  const result = episodeDraftCandidateSchema.safeParse(parsed);
  if (!result.success) {
    throw new DomainError("WRITING_INVALID_CANDIDATE", result.error.issues[0]?.message ?? "单集剧本候选无效");
  }
  if (result.data.episodeNo !== expected.episodeNo) {
    throw new DomainError("WRITING_EPISODE_MISMATCH", `候选是第 ${result.data.episodeNo} 集，当前选择的是第 ${expected.episodeNo ?? "?"} 集`);
  }
  assertSafe(result.data);
  return { mode: "episode", draft: result.data };
}

function assertFormatted(text: string): string {
  if (text.length > WRITING_BODY_MAX_CHARS) {
    throw new DomainError("WRITING_TOO_LARGE", `整理后的正文超过 ${WRITING_BODY_MAX_CHARS} 字，已拒绝，没有截断`);
  }
  return text;
}

export function formatStoryPlan(plan: StoryPlanCandidate): string {
  const episodes = [...plan.episodes].sort((left, right) => left.episodeNo - right.episodeNo);
  const lines = [
    "一句话故事",
    plan.logline,
    "",
    "主角目标",
    plan.protagonistGoal,
    "",
    "阻力",
    plan.opposition,
    "",
    "核心冲突",
    plan.coreConflict,
    "",
    "人物关系",
    ...plan.relationships.map((item) => `${item.name}：${item.pressure}`),
    "",
    "三集大纲",
  ];
  for (const episode of episodes) {
    lines.push(
      `第 ${episode.episodeNo} 集`,
      `进入状态：${episode.entryState}`,
      `目标：${episode.goal}`,
      `行动：${episode.action}`,
      `转折：${episode.turn}`,
      `结果：${episode.result}`,
      `交接事实：${episode.handoff}`,
      "",
    );
  }
  return assertFormatted(lines.join("\n").trimEnd());
}

export function formatEpisodeDraft(draft: EpisodeDraftCandidate): string {
  const lines = [
    `第 ${draft.episodeNo} 集 ${draft.title}`,
    "",
    draft.screenplay.trim(),
    "",
    "场景",
  ];
  for (const scene of draft.scenes) {
    lines.push(
      scene.heading,
      `动作：${scene.action}`,
      scene.dialogue.length > 0 ? `对白：${scene.dialogue}` : "对白：无",
      scene.sound.length > 0 ? `声音：${scene.sound}` : "声音：无",
      "",
    );
  }
  lines.push("下一集需要继承的事实");
  for (const fact of draft.handoffFacts) lines.push(`- ${fact}`);
  return assertFormatted(lines.join("\n").trimEnd());
}

export function formatWritingImport(imported: WritingImport): string {
  return imported.mode === "story" ? formatStoryPlan(imported.plan) : formatEpisodeDraft(imported.draft);
}

export function freezeWritingContext(
  target: WritingTargetSnapshot,
  inputFingerprint: string,
): FrozenWritingContext {
  if (!target.loaded) {
    throw new DomainError("WRITING_NOT_LOADED", "目标数据尚未加载成功，不能准备指令");
  }
  if (target.ifMatch === null) {
    throw new DomainError("WRITING_NOT_LOADED", "还没有编辑基线，不能准备指令");
  }
  return {
    ...target,
    ifMatch: target.ifMatch,
    loaded: true,
    promptVersion: WRITING_PROMPT_VERSION,
    inputFingerprint,
  };
}

export function canAdopt(
  frozen: FrozenWritingContext,
  live: WritingTargetSnapshot,
  liveInputFingerprint: string,
): { ok: true } | { ok: false; differences: string[] } {
  const differences: string[] = [];
  if (frozen.promptVersion !== WRITING_PROMPT_VERSION) differences.push("提示词版本已变化");
  if (frozen.inputFingerprint !== liveInputFingerprint) differences.push("创作要求已变化，请重新准备指令");
  if (frozen.projectId !== live.projectId) differences.push("项目已切换");
  if (frozen.entityKey !== live.entityKey) differences.push("编辑对象已切换");
  if (frozen.mode !== live.mode) differences.push("助手模式已切换");
  if (frozen.episodeNo !== live.episodeNo) differences.push("集数已切换");
  if (frozen.sourceRevisionId !== live.sourceRevisionId) differences.push("来源版本已变化");
  if (frozen.ifMatch !== live.ifMatch) differences.push("编辑基线已变化。候选仍保留，不能改用新的 If-Match。");
  if (frozen.draftFingerprint !== live.draftFingerprint) differences.push("正文草稿已变化。候选仍保留，不能直接覆盖。");
  if (!live.loaded || !frozen.loaded) differences.push("目标数据尚未加载成功");
  return differences.length === 0 ? { ok: true } : { ok: false, differences };
}
