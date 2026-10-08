import {
  EPISODE_DRAFT_SCHEMA,
  EPISODE_OUTLINE_SCHEMA,
  TITLE_CONCEPT_SCHEMA,
  WRITING_BODY_MAX_CHARS,
  episodeOutlineSchema,
  titleConceptSchema,
  type EpisodeDraftCandidate,
  type EpisodeOutline,
  type TitleConcept,
  type TitleWritingFrozenInput,
  type TitleWritingStepKey,
} from "@ai-drama/contracts";
import { DomainError } from "./errors";
import { formatEpisodeDraft, parseWritingImport } from "./writing-assistant";

/**
 * Prompts, output checks and saved text for title-driven writing. Provider-neutral: adapters only carry the
 * system and user text plus the schema name; nothing here knows which vendor answers.
 */
export const TITLE_WRITING_SYSTEM_PROMPT = [
  "你是中文竖屏短剧编剧。",
  "只输出一个 json 对象，不要 Markdown 代码围栏，不要解释，不要工具调用。",
  "不要包含 HTML、网址、projectId、reviewStatus、APPROVED 或 CURRENT。",
  "输出是待创作者修改和审核的草稿，不是审核结论。",
].join("");

export type TitleWritingSchemaKind = "concept" | "outline" | "episode";

export interface TitleWritingPrompt {
  stepKey: TitleWritingStepKey;
  schemaKind: TitleWritingSchemaKind;
  system: string;
  user: string;
}

export interface TitleWritingContext {
  concept?: TitleConcept;
  outline?: EpisodeOutline;
  /** Saved earlier episodes, in order. Episode N receives 1..N-1. */
  episodes?: EpisodeDraftCandidate[];
}

export function episodeNoOf(stepKey: TitleWritingStepKey): 1 | 2 | 3 | null {
  if (stepKey === "episode:1") return 1;
  if (stepKey === "episode:2") return 2;
  if (stepKey === "episode:3") return 3;
  return null;
}

/** A rough screenplay length that fits the episode duration; the schema cap stays 12,000 characters. */
export function screenplayCharTarget(seconds: number): number {
  return Math.min(3_000, Math.max(400, Math.round(seconds * 12)));
}

function settingsLines(input: TitleWritingFrozenInput): string[] {
  return [
    `剧名：${input.title}`,
    `集数：${input.settings.episodeCount} 集`,
    `每集时长：约 ${input.settings.episodeSeconds} 秒，竖屏 9:16`,
    input.settings.style.length > 0 ? `风格：${input.settings.style}` : "风格：由你根据剧名判断",
  ];
}

function conceptBlock(concept: TitleConcept): string {
  return JSON.stringify(concept);
}

export function buildTitleWritingPrompt(
  stepKey: TitleWritingStepKey,
  input: TitleWritingFrozenInput,
  context: TitleWritingContext,
): TitleWritingPrompt {
  if (stepKey === "concept") {
    return {
      stepKey,
      schemaKind: "concept",
      system: TITLE_WRITING_SYSTEM_PROMPT,
      user: [
        "任务：只根据剧名完成故事策划。创作者没有提供其他设定，题材、人物、梗概和走向都由你补全。",
        ...settingsLines(input),
        "要求：人物有明确目标、阻力和代价；核心冲突能在人物关系里持续发生；故事能在三集内讲完并留有余味。",
        `输出 json，schema 字段必须是 "${TITLE_CONCEPT_SCHEMA}"。`,
        "字段：genre（题材）、logline（一句话故事）、synopsis（故事梗概）、protagonistGoal、opposition、coreConflict、direction（三集故事走向）、characters[2-6]{name,role,profile}、relationships[1-6]{name,pressure}。",
        `示例结构：{"schema":"${TITLE_CONCEPT_SCHEMA}","genre":"…","logline":"…","synopsis":"…","protagonistGoal":"…","opposition":"…","coreConflict":"…","direction":"…","characters":[{"name":"…","role":"…","profile":"…"}],"relationships":[{"name":"甲与乙","pressure":"…"}]}`,
      ].join("\n"),
    };
  }
  if (!context.concept) throw new DomainError("TITLE_WRITING_CONTEXT_MISSING", "缺少已保存的故事策划");
  if (stepKey === "outline") {
    return {
      stepKey,
      schemaKind: "outline",
      system: TITLE_WRITING_SYSTEM_PROMPT,
      user: [
        "任务：根据已确定的故事策划写分集大纲。人物名称、关系和设定必须与策划一致，不新增主要人物。",
        ...settingsLines(input),
        "已保存的故事策划（json）：",
        conceptBlock(context.concept),
        `输出 json，schema 字段必须是 "${EPISODE_OUTLINE_SCHEMA}"。episodes 正好 3 项，episodeNo 依次为 1、2、3。`,
        "每项字段：episodeNo、title、entryState（进入状态）、goal、action、turn（转折）、result、handoff（交给下一集的事实）。相邻集的 handoff 与下一集的 entryState 要能接上。",
        `示例结构：{"schema":"${EPISODE_OUTLINE_SCHEMA}","episodes":[{"episodeNo":1,"title":"…","entryState":"…","goal":"…","action":"…","turn":"…","result":"…","handoff":"…"}]}`,
      ].join("\n"),
    };
  }
  const episodeNo = episodeNoOf(stepKey);
  if (episodeNo === null) throw new DomainError("TITLE_WRITING_STEP_INVALID", "未知的创作步骤");
  if (!context.outline) throw new DomainError("TITLE_WRITING_CONTEXT_MISSING", "缺少已保存的分集大纲");
  const previous = context.episodes ?? [];
  if (previous.length !== episodeNo - 1 || previous.some((episode, index) => episode.episodeNo !== index + 1)) {
    throw new DomainError("TITLE_WRITING_CONTEXT_MISSING", "缺少前面各集已保存的剧本");
  }
  const outlineEpisode = context.outline.episodes[episodeNo - 1];
  const handoffs = previous.map((episode) => `第 ${episode.episodeNo} 集交接事实：${episode.handoffFacts.join("；")}`);
  const target = screenplayCharTarget(input.settings.episodeSeconds);
  return {
    stepKey,
    schemaKind: "episode",
    system: TITLE_WRITING_SYSTEM_PROMPT,
    user: [
      `任务：写第 ${episodeNo} 集完整剧本。必须沿用故事策划和分集大纲中的人物名称、关系和事实，承接前一集的交接事实。`,
      ...settingsLines(input),
      "已保存的故事策划（json）：",
      conceptBlock(context.concept),
      "已保存的分集大纲（json）：",
      JSON.stringify(context.outline),
      `本集大纲：${JSON.stringify(outlineEpisode)}`,
      ...(handoffs.length > 0 ? ["前面各集已写定的交接事实：", ...handoffs] : ["这是第一集。"]),
      `screenplay 写完整单集剧本，包含场景、动作、对白和必要的声音标记，约 ${target} 字以内。每个场景都要推动信息、关系或风险变化。`,
      `输出 json，schema 字段必须是 "${EPISODE_DRAFT_SCHEMA}"，episodeNo 必须是 ${episodeNo}。`,
      "字段：title、screenplay、scenes[1-12]{heading,action,dialogue,sound}、handoffFacts[1-8]（下一集必须继承的事实）。没有对白或声音时填空字符串。",
      `示例结构：{"schema":"${EPISODE_DRAFT_SCHEMA}","episodeNo":${episodeNo},"title":"…","screenplay":"…","scenes":[{"heading":"…","action":"…","dialogue":"…","sound":""}],"handoffFacts":["…"]}`,
    ].join("\n"),
  };
}

export type TitleWritingValidation =
  | { ok: true; output: TitleConcept | EpisodeOutline | EpisodeDraftCandidate }
  | { ok: false; code: "invalid_output" | "episode_mismatch" | "unsafe_content" | "too_large" };

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

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Accepts a model answer only when it is one JSON object that passes the step schema, has no unsafe text and,
 * for an episode, carries the requested episode number. Nothing is repaired or truncated.
 */
export function validateTitleWritingOutput(
  stepKey: TitleWritingStepKey,
  content: string,
): TitleWritingValidation {
  if (content.trim().length === 0) return { ok: false, code: "invalid_output" };
  const episodeNo = episodeNoOf(stepKey);
  if (episodeNo !== null) {
    try {
      const imported = parseWritingImport(new TextEncoder().encode(content), { mode: "episode", episodeNo });
      if (imported.mode !== "episode") return { ok: false, code: "invalid_output" };
      formatEpisodeDraft(imported.draft);
      return { ok: true, output: imported.draft };
    } catch (error) {
      if (error instanceof DomainError) {
        if (error.code === "WRITING_EPISODE_MISMATCH") return { ok: false, code: "episode_mismatch" };
        if (error.code === "WRITING_UNSAFE_CONTENT") return { ok: false, code: "unsafe_content" };
        if (error.code === "WRITING_TOO_LARGE") return { ok: false, code: "too_large" };
      }
      return { ok: false, code: "invalid_output" };
    }
  }
  const parsed = parseJson(content);
  const result = stepKey === "concept" ? titleConceptSchema.safeParse(parsed) : episodeOutlineSchema.safeParse(parsed);
  if (!result.success) return { ok: false, code: "invalid_output" };
  if (containsUnsafe(result.data)) return { ok: false, code: "unsafe_content" };
  return { ok: true, output: result.data };
}

/** The story draft text saved to the project: concept plus outline, in the same plain-text style as the editor. */
export function formatTitleStory(title: string, concept: TitleConcept, outline: EpisodeOutline): string {
  const lines = [
    `剧名：${title}`,
    `题材：${concept.genre}`,
    "",
    "一句话故事",
    concept.logline,
    "",
    "故事梗概",
    concept.synopsis,
    "",
    "主角目标",
    concept.protagonistGoal,
    "",
    "阻力",
    concept.opposition,
    "",
    "核心冲突",
    concept.coreConflict,
    "",
    "人物",
    ...concept.characters.map((item) => `${item.name}（${item.role}）：${item.profile}`),
    "",
    "人物关系",
    ...concept.relationships.map((item) => `${item.name}：${item.pressure}`),
    "",
    "故事走向",
    concept.direction,
    "",
    "分集大纲",
  ];
  for (const episode of outline.episodes) {
    lines.push(
      `第 ${episode.episodeNo} 集 ${episode.title}`,
      `进入状态：${episode.entryState}`,
      `目标：${episode.goal}`,
      `行动：${episode.action}`,
      `转折：${episode.turn}`,
      `结果：${episode.result}`,
      `交接事实：${episode.handoff}`,
      "",
    );
  }
  const text = lines.join("\n").trimEnd();
  if (text.length > WRITING_BODY_MAX_CHARS) {
    throw new DomainError("WRITING_TOO_LARGE", `整理后的故事超过 ${WRITING_BODY_MAX_CHARS} 字，已拒绝，没有截断`);
  }
  return text;
}

export function formatTitleEpisode(draft: EpisodeDraftCandidate): string {
  return formatEpisodeDraft(draft);
}
