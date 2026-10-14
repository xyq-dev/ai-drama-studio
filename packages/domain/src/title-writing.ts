import {
  EPISODE_DRAFT_SCHEMA,
  EPISODE_OUTLINE_SCHEMA,
  EPISODE_OUTLINE_SCHEMA_V2,
  TITLE_CONCEPT_SCHEMA,
  TITLE_WRITING_PROMPT_VERSION_V3,
  TITLE_WRITING_PROMPT_VERSION_V4,
  WRITING_BODY_MAX_CHARS,
  episodeOutlineSchema,
  episodeOutlineV2Schema,
  isTitleWritingInputV2,
  titleConceptSchema,
  titleWritingEpisodeCount,
  type EpisodeDraftCandidate,
  type EpisodeOutline,
  type TitleConcept,
  type TitleWritingFrozenInput,
  type TitleWritingFrozenInputV2,
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

/** The episode number of an episode step ("episode:1" … "episode:6"), or null for concept and outline. */
export function episodeNoOf(stepKey: TitleWritingStepKey): number | null {
  const match = /^episode:([1-6])$/.exec(stepKey);
  return match ? Number(match[1]) : null;
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

/** v2: the run's N and target seconds, phrased as a writing target. Nothing here claims a finished length. */
function settingsLinesV2(input: TitleWritingFrozenInputV2): string[] {
  const seconds = input.settings.episodeSeconds;
  return [
    `剧名：${input.title}`,
    `集数：${String(input.settings.episodeCount)} 集`,
    `每集目标时长：约 ${seconds === 60 ? "1 分钟" : "1.5 分钟"}（${String(seconds)} 秒），竖屏 9:16。这是写作目标：按对白和动作的量控制篇幅。`,
    input.settings.style.length > 0 ? `风格：${input.settings.style}` : "风格：由你根据剧名判断",
  ];
}

type GuidedPromptVersion = typeof TITLE_WRITING_PROMPT_VERSION_V3 | typeof TITLE_WRITING_PROMPT_VERSION_V4;

/**
 * Writing requirements added by prompt v3 and kept by v4, headed by the run's own version. They ask for answers inside
 * the existing fields (no new field, same schema and limits) and are never sent for a run frozen with prompt v2.
 */
const guidedConceptLines = (version: GuidedPromptVersion) => [
  `编剧要求（${version}）：`,
  "protagonistGoal 写主角具体、能通过行动完成的目标；opposition 写清谁出于什么利益阻止主角。",
  "direction 先用一句话写整部期待：观众希望主角最终得到什么（例如尊严恢复、被理解、关系修复、真相揭晓），再写各集走向。",
  "关键结果来自主角的选择和行动，不靠旁人突然解围。人物设定按剧名和人物本身设计，不按性别或题材套用固定模式。",
];

const guidedOutlineLines = (version: GuidedPromptVersion) => [
  `编剧要求（${version}）：每集都要能回答下列问题，写进对应字段，不新增字段，每个字段控制在 150 字以内。`,
  "entryState：本集开场的局面，以及谁出于什么利益阻止主角。",
  "goal：主角本集要完成的具体目标。",
  "action：主角为此采取的行动；本集关键结果来自主角的选择。",
  "turn：谁获得了什么新信息，它如何改变行动、关系或判断；反转要有前文依据。",
  "result：相比开场局面发生了什么变化，本集兑现给观众的回报（解决一部分问题）。",
  "handoff：结尾留下的、与主线相关的问题，以及下一集如何回应它；最后一集写清主线问题如何收束。",
  "冲突逐集升级：增加代价、缩短时间或提高选择难度。不同集不重复同一冲突，不靠重复羞辱或人物故意不沟通拖延剧情。",
];

const guidedEpisodeLines = (version: GuidedPromptVersion) => [
  `编剧要求（${version}）：本集按本次创作保存的分集大纲执行。`,
  "保留本集大纲中主角的目标、行动和结果，以及前文埋下的伏笔。",
  "不凭空新增解围人物或决定性证据；关键信息必须来自故事策划、分集大纲或前面各集。",
  "不改变人物身份、关系和大纲中的结局走向。",
  "不靠重复羞辱或人物故意不沟通拖延剧情，不重复前面各集已经解决的冲突。",
];

/** The v3 closing line: every episode, the last one included, is asked for an ending question. Kept for v3 runs only. */
const V3_EPISODE_HANDOFF_LINE = "台词表达人物意图，不重复解释已经演出来的信息。handoffFacts 包括本集结尾留下的问题。";

/** v4: a non-final episode hands a question and facts to the next one; the only or last episode closes the story. */
function v4EpisodeHandoffLines(final: boolean): string[] {
  return final ? [
    "台词表达人物意图，不重复解释已经演出来的信息。",
    "本集是全剧结局：收束主线冲突，回应故事策划里观众对整部剧的期待；不为后续剧情新留悬念或未解决的问题。",
    "handoffFacts 记录结局事实：主线冲突如何收束、整部期待如何得到回应、主要人物的最终处境。",
  ] : [
    "台词表达人物意图，不重复解释已经演出来的信息。",
    "handoffFacts 包括本集结尾留下的、与主线相关的问题，以及下一集必须承接的事实。",
  ];
}

/**
 * v2 prompts: the same steps and fields as v1, for exactly the run's N episodes. Prompt v3 adds the guided lines; prompt
 * v4 keeps them and words the episode ending by position (non-final: question for the next episode; final: closure).
 */
function buildTitleWritingPromptV2(
  stepKey: TitleWritingStepKey,
  input: TitleWritingFrozenInputV2,
  context: TitleWritingContext,
): TitleWritingPrompt {
  const count = input.settings.episodeCount;
  const numbers = Array.from({ length: count }, (_, index) => String(index + 1)).join("、");
  const guided = input.promptVersion === TITLE_WRITING_PROMPT_VERSION_V3 || input.promptVersion === TITLE_WRITING_PROMPT_VERSION_V4
    ? input.promptVersion : null;
  if (stepKey === "concept") {
    return {
      stepKey,
      schemaKind: "concept",
      system: TITLE_WRITING_SYSTEM_PROMPT,
      user: [
        "任务：只根据剧名完成故事策划。创作者没有提供其他设定，题材、人物、梗概和走向都由你补全。",
        ...settingsLinesV2(input),
        `要求：人物有明确目标、阻力和代价；核心冲突能在人物关系里持续发生；故事能在 ${String(count)} 集内讲完并留有余味。`,
        ...(guided ? guidedConceptLines(guided) : []),
        `输出 json，schema 字段必须是 "${TITLE_CONCEPT_SCHEMA}"。`,
        `字段：genre（题材）、logline（一句话故事）、synopsis（故事梗概）、protagonistGoal、opposition、coreConflict、direction（${String(count)} 集故事走向）、characters[2-6]{name,role,profile}、relationships[1-6]{name,pressure}。`,
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
        ...settingsLinesV2(input),
        "已保存的故事策划（json）：",
        conceptBlock(context.concept),
        `输出 json，schema 字段必须是 "${EPISODE_OUTLINE_SCHEMA_V2}"。episodes 正好 ${String(count)} 项，episodeNo 依次为 ${numbers}，不能缺集、重复或多出。`,
        "每项字段：episodeNo、title、entryState（进入状态）、goal、action、turn（转折）、result、handoff（交给下一集的事实）。相邻集的 handoff 与下一集的 entryState 要能接上。",
        ...(guided ? guidedOutlineLines(guided) : []),
        `示例结构：{"schema":"${EPISODE_OUTLINE_SCHEMA_V2}","episodes":[{"episodeNo":1,"title":"…","entryState":"…","goal":"…","action":"…","turn":"…","result":"…","handoff":"…"}]}`,
      ].join("\n"),
    };
  }
  const episodeNo = episodeNoOf(stepKey);
  if (episodeNo === null || episodeNo > count) throw new DomainError("TITLE_WRITING_STEP_INVALID", "未知的创作步骤");
  if (!context.outline || context.outline.episodes.length !== count) {
    throw new DomainError("TITLE_WRITING_CONTEXT_MISSING", "缺少已保存的分集大纲");
  }
  const previous = context.episodes ?? [];
  if (previous.length !== episodeNo - 1 || previous.some((episode, index) => episode.episodeNo !== index + 1)) {
    throw new DomainError("TITLE_WRITING_CONTEXT_MISSING", "缺少前面各集已保存的剧本");
  }
  const outlineEpisode = context.outline.episodes[episodeNo - 1];
  const handoffs = previous.map((episode) => `第 ${String(episode.episodeNo)} 集交接事实：${episode.handoffFacts.join("；")}`);
  const target = screenplayCharTarget(input.settings.episodeSeconds);
  const position = count === 1 ? "这是全剧唯一的一集，要在本集内讲完核心冲突。"
    : episodeNo === count ? `这是最后一集（第 ${String(count)} 集），要收束核心冲突。` : null;
  // Only v4 tells the final episode apart: its handoffFacts describe the ending, not facts a next episode inherits.
  const v4Final = guided === TITLE_WRITING_PROMPT_VERSION_V4 && episodeNo === count;
  const guidedEpisode = guided === TITLE_WRITING_PROMPT_VERSION_V4 ? [...guidedEpisodeLines(guided), ...v4EpisodeHandoffLines(v4Final)]
    : guided ? [...guidedEpisodeLines(guided), V3_EPISODE_HANDOFF_LINE] : [];
  return {
    stepKey,
    schemaKind: "episode",
    system: TITLE_WRITING_SYSTEM_PROMPT,
    user: [
      `任务：写第 ${String(episodeNo)} 集（共 ${String(count)} 集）完整剧本。必须沿用故事策划和分集大纲中的人物名称、关系和事实，承接前一集的交接事实。`,
      ...settingsLinesV2(input),
      "已保存的故事策划（json）：",
      conceptBlock(context.concept),
      "已保存的分集大纲（json）：",
      JSON.stringify(context.outline),
      `本集大纲：${JSON.stringify(outlineEpisode)}`,
      ...(handoffs.length > 0 ? ["前面各集已写定的交接事实：", ...handoffs] : ["这是第一集。"]),
      ...(position ? [position] : []),
      ...guidedEpisode,
      `screenplay 写完整单集剧本，包含场景、动作、对白和必要的声音标记，约 ${String(target)} 字以内。每个场景都要推动信息、关系或风险变化。`,
      `输出 json，schema 字段必须是 "${EPISODE_DRAFT_SCHEMA}"，episodeNo 必须是 ${String(episodeNo)}。`,
      v4Final
        ? "字段：title、screenplay、scenes[1-12]{heading,action,dialogue,sound}、handoffFacts[1-8]（本集结局事实：主线如何收束、整部期待如何回应）。没有对白或声音时填空字符串。"
        : "字段：title、screenplay、scenes[1-12]{heading,action,dialogue,sound}、handoffFacts[1-8]（下一集必须继承的事实）。没有对白或声音时填空字符串。",
      `示例结构：{"schema":"${EPISODE_DRAFT_SCHEMA}","episodeNo":${String(episodeNo)},"title":"…","screenplay":"…","scenes":[{"heading":"…","action":"…","dialogue":"…","sound":""}],"handoffFacts":["…"]}`,
    ].join("\n"),
  };
}

/** The prompt of one step. A v1 run gets exactly the v1 text; only a v2 run gets the N-episode prompts. */
export function buildTitleWritingPrompt(
  stepKey: TitleWritingStepKey,
  input: TitleWritingFrozenInput,
  context: TitleWritingContext,
): TitleWritingPrompt {
  if (isTitleWritingInputV2(input)) return buildTitleWritingPromptV2(stepKey, input, context);
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
  if (episodeNo === null || episodeNo > 3) throw new DomainError("TITLE_WRITING_STEP_INVALID", "未知的创作步骤");
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

/** The episode number an answer claims, read without validating anything else. */
function claimedEpisodeNo(content: string): unknown {
  const parsed = parseJson(content);
  return parsed && typeof parsed === "object" ? (parsed as { episodeNo?: unknown }).episodeNo : undefined;
}

/**
 * Accepts a model answer only when it is one JSON object that passes the step schema of the run's version, has no
 * unsafe text and, for an episode, carries the requested episode number. A v2 outline must have exactly the run's N
 * episodes in order. Nothing is repaired, truncated or continued. Without an input the v1 rules apply.
 */
export function validateTitleWritingOutput(
  stepKey: TitleWritingStepKey,
  content: string,
  input?: TitleWritingFrozenInput,
): TitleWritingValidation {
  if (content.trim().length === 0) return { ok: false, code: "invalid_output" };
  const v2 = input !== undefined && isTitleWritingInputV2(input);
  const count = input ? titleWritingEpisodeCount(input) : 3;
  const episodeNo = episodeNoOf(stepKey);
  if (episodeNo !== null) {
    if (episodeNo > count) return { ok: false, code: "invalid_output" };
    try {
      const imported = parseWritingImport(new TextEncoder().encode(content), { mode: "episode", episodeNo });
      if (imported.mode !== "episode") return { ok: false, code: "invalid_output" };
      formatEpisodeDraft(imported.draft);
      return { ok: true, output: imported.draft };
    } catch (error) {
      if (error instanceof DomainError) {
        if (error.code === "WRITING_EPISODE_MISMATCH") {
          // v1 answers keep their v1 code: an episode number outside 1–3 never passed the v1 schema.
          const claimed = claimedEpisodeNo(content);
          return !v2 && typeof claimed === "number" && claimed > 3 ? { ok: false, code: "invalid_output" } : { ok: false, code: "episode_mismatch" };
        }
        if (error.code === "WRITING_UNSAFE_CONTENT") return { ok: false, code: "unsafe_content" };
        if (error.code === "WRITING_TOO_LARGE") return { ok: false, code: "too_large" };
      }
      return { ok: false, code: "invalid_output" };
    }
  }
  const parsed = parseJson(content);
  const result = stepKey === "concept" ? titleConceptSchema.safeParse(parsed)
    : v2 ? episodeOutlineV2Schema(count).safeParse(parsed) : episodeOutlineSchema.safeParse(parsed);
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

export function formatTitleEpisode(draft: EpisodeDraftCandidate, input: TitleWritingFrozenInput): string {
  const finale = input.promptVersion === TITLE_WRITING_PROMPT_VERSION_V4
    && draft.episodeNo === titleWritingEpisodeCount(input);
  return formatEpisodeDraft(draft, finale ? "本集结局事实" : "下一集需要继承的事实");
}
