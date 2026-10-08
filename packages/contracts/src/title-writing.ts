import { z } from "zod";
import { EPISODE_DRAFT_SCHEMA, episodeDraftCandidateSchema, type EpisodeDraftCandidate } from "./writing-assistant";

/** Title-driven automatic writing: title → concept → episode outline → every episode script. Text only. */
export const TITLE_WRITING_INPUT_SCHEMA = "ads.title-writing.input.v1" as const;
export const TITLE_CONCEPT_SCHEMA = "ads.writing.title-concept.v1" as const;
export const EPISODE_OUTLINE_SCHEMA = "ads.writing.episode-outline.v1" as const;
export const TITLE_WRITING_PROMPT_VERSION = "ads.title-writing.prompt.v1" as const;

export const TITLE_WRITING_PROVIDER_KEYS = ["qwen", "openai", "deepseek"] as const;
export type TitleWritingProviderKey = (typeof TITLE_WRITING_PROVIDER_KEYS)[number];

/** The production scope is fixed at three episodes (domain PRODUCTION_EPISODE_NUMBERS). */
export const TITLE_WRITING_EPISODE_COUNT = 3 as const;
export const TITLE_WRITING_DEFAULT_EPISODE_SECONDS = 90;
export const TITLE_WRITING_TITLE_MAX_CHARS = 60;

export const TITLE_WRITING_STEP_KEYS = ["concept", "outline", "episode:1", "episode:2", "episode:3"] as const;
export type TitleWritingStepKey = (typeof TITLE_WRITING_STEP_KEYS)[number];

const MODEL_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Required text counts only visible content: spaces, tabs or line breaks alone are empty. The value is kept as sent. */
function text(min: number, max: number) {
  return z.string().max(max)
    .refine((value) => value.trim().length >= min, "必填内容不能为空白")
    .refine((value) => !value.includes("\u0000"), "文本含有空字符");
}

const titleText = z.string().trim().min(1, "请填写剧名").max(TITLE_WRITING_TITLE_MAX_CHARS, `剧名最多 ${TITLE_WRITING_TITLE_MAX_CHARS} 字`)
  // eslint-disable-next-line no-control-regex
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "剧名不能包含控制字符");

export const titleWritingSettingsSchema = z.object({
  episodeCount: z.literal(TITLE_WRITING_EPISODE_COUNT).default(TITLE_WRITING_EPISODE_COUNT),
  episodeSeconds: z.number().int().min(30).max(180).default(TITLE_WRITING_DEFAULT_EPISODE_SECONDS),
  style: z.string().trim().max(40).default(""),
}).strict();
export type TitleWritingSettings = z.infer<typeof titleWritingSettingsSchema>;

/** Start request body. The title is the only required creative field. */
export const titleWritingStartSchema = z.object({
  title: titleText,
  providerKey: z.enum(TITLE_WRITING_PROVIDER_KEYS).optional(),
  model: z.string().regex(MODEL_ID).optional(),
  settings: titleWritingSettingsSchema.partial().strict().optional(),
}).strict();
export type TitleWritingStart = z.infer<typeof titleWritingStartSchema>;

/** Frozen, hashed input of one run. Provider and model are resolved by the server against its allowlist. */
export interface TitleWritingFrozenInput {
  schema: typeof TITLE_WRITING_INPUT_SCHEMA;
  promptVersion: typeof TITLE_WRITING_PROMPT_VERSION;
  title: string;
  settings: TitleWritingSettings;
  providerKey: TitleWritingProviderKey;
  model: string;
}

const characterSchema = z.object({
  name: text(1, 20),
  role: text(1, 40),
  profile: text(1, 200),
}).strict();

const relationshipSchema = z.object({
  name: text(1, 40),
  pressure: text(1, 200),
}).strict();

export const titleConceptSchema = z.object({
  schema: z.literal(TITLE_CONCEPT_SCHEMA),
  genre: text(1, 40),
  logline: text(1, 300),
  synopsis: text(1, 800),
  protagonistGoal: text(1, 300),
  opposition: text(1, 300),
  coreConflict: text(1, 400),
  direction: text(1, 600),
  characters: z.array(characterSchema).min(2).max(6),
  relationships: z.array(relationshipSchema).min(1).max(6),
}).strict().superRefine((value, context) => {
  const names = value.characters.map((item) => item.name.trim());
  if (new Set(names).size !== names.length) context.addIssue({ code: "custom", message: "人物名称不能重复" });
});
export type TitleConcept = z.infer<typeof titleConceptSchema>;

const outlineEpisodeSchema = z.object({
  episodeNo: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  title: text(1, 40),
  entryState: text(1, 400),
  goal: text(1, 400),
  action: text(1, 400),
  turn: text(1, 400),
  result: text(1, 400),
  handoff: text(1, 400),
}).strict();

export const episodeOutlineSchema = z.object({
  schema: z.literal(EPISODE_OUTLINE_SCHEMA),
  episodes: z.array(outlineEpisodeSchema).length(TITLE_WRITING_EPISODE_COUNT),
}).strict().superRefine((value, context) => {
  const numbers = value.episodes.map((episode) => episode.episodeNo);
  if (numbers.some((episodeNo, index) => episodeNo !== index + 1)) {
    context.addIssue({ code: "custom", message: "分集大纲必须按第 1、2、3 集顺序给出且不重复" });
  }
});
export type EpisodeOutline = z.infer<typeof episodeOutlineSchema>;

export { EPISODE_DRAFT_SCHEMA, episodeDraftCandidateSchema, type EpisodeDraftCandidate };

/**
 * JSON Schemas for providers that enforce a schema (OpenAI strict mode). Only keywords strict mode accepts:
 * every property required, additionalProperties false, no pattern. The zod schemas above stay the authority.
 */
function stringField(maxLength: number) {
  return { type: "string", maxLength } as const;
}

function objectOf(properties: Record<string, unknown>) {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties } as const;
}

const episodeNoJson = { type: "integer", enum: [1, 2, 3] } as const;

export const TITLE_WRITING_JSON_SCHEMAS: Readonly<Record<"concept" | "outline" | "episode", { name: string; schema: Record<string, unknown> }>> = {
  concept: {
    name: "title_concept",
    schema: objectOf({
      schema: { type: "string", enum: [TITLE_CONCEPT_SCHEMA] },
      genre: stringField(40),
      logline: stringField(300),
      synopsis: stringField(800),
      protagonistGoal: stringField(300),
      opposition: stringField(300),
      coreConflict: stringField(400),
      direction: stringField(600),
      characters: { type: "array", minItems: 2, maxItems: 6,
        items: objectOf({ name: stringField(20), role: stringField(40), profile: stringField(200) }) },
      relationships: { type: "array", minItems: 1, maxItems: 6,
        items: objectOf({ name: stringField(40), pressure: stringField(200) }) },
    }),
  },
  outline: {
    name: "episode_outline",
    schema: objectOf({
      schema: { type: "string", enum: [EPISODE_OUTLINE_SCHEMA] },
      episodes: { type: "array", minItems: 3, maxItems: 3, items: objectOf({
        episodeNo: episodeNoJson, title: stringField(40), entryState: stringField(400), goal: stringField(400),
        action: stringField(400), turn: stringField(400), result: stringField(400), handoff: stringField(400),
      }) },
    }),
  },
  episode: {
    name: "episode_draft",
    schema: objectOf({
      schema: { type: "string", enum: [EPISODE_DRAFT_SCHEMA] },
      episodeNo: episodeNoJson,
      title: stringField(80),
      screenplay: stringField(12_000),
      scenes: { type: "array", minItems: 1, maxItems: 12,
        items: objectOf({ heading: stringField(80), action: stringField(400), dialogue: stringField(400), sound: stringField(120) }) },
      handoffFacts: { type: "array", minItems: 1, maxItems: 8, items: stringField(200) },
    }),
  },
};

export type TitleWritingRunState = "running" | "completed" | "partial" | "needs_attention" | "canceled" | "failed";
export type TitleWritingStepState = "pending" | "reserved" | "submitted" | "completed" | "rejected" | "unknown" | "canceled";
export type TitleWritingCallState = "reserved" | "submitted" | "completed" | "rejected" | "unknown";
export type TitleWritingStorySave = "pending" | "saved" | "conflict";
export type TitleWritingScriptSave = "awaiting_story_approval" | "saved" | "conflict" | "pending";

export interface TitleWritingUsageView {
  status: "present" | "unknown";
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface TitleWritingCallView {
  callId: string;
  stepKey: TitleWritingStepKey;
  attemptNo: number;
  providerKey: TitleWritingProviderKey;
  model: string;
  responseModel: string | null;
  providerRequestId: string | null;
  state: TitleWritingCallState;
  errorCode: string | null;
  usage: TitleWritingUsageView;
  /** Cost is never estimated as zero. Amount stays unknown until a reliable price source exists. */
  billingStatus: "unknown";
  createdAt: string;
  finishedAt: string | null;
}

export interface TitleWritingStepView {
  stepKey: TitleWritingStepKey;
  state: TitleWritingStepState;
  attemptNo: number;
  errorCode: string | null;
  /** Validated structured output; null until the step completed. */
  output: TitleConcept | EpisodeOutline | EpisodeDraftCandidate | null;
  /** Readable text of the output (story plan or screenplay), the same text the editors save. */
  text: string | null;
  scriptSave: TitleWritingScriptSave | null;
  scriptRevisionId: string | null;
}

export interface TitleWritingRunView {
  runId: string;
  projectId: string;
  title: string;
  settings: TitleWritingSettings;
  providerKey: TitleWritingProviderKey;
  model: string;
  state: TitleWritingRunState;
  errorCode: string | null;
  cancelRequested: boolean;
  callCap: number;
  callsUsed: number;
  storySave: TitleWritingStorySave;
  storyRevisionId: string | null;
  storyText: string | null;
  steps: TitleWritingStepView[];
  calls: TitleWritingCallView[];
  createdAt: string;
  updatedAt: string;
}

export interface TitleWritingProviderOption {
  providerKey: TitleWritingProviderKey;
  label: string;
  ready: boolean;
  models: string[];
  defaultModel: string | null;
  /** Names of server variables that are missing or invalid. Never values. */
  missing: string[];
}

export interface TitleWritingOptionsView {
  enabled: boolean;
  code: string;
  storageReady: boolean;
  operatorTokenRequired: true;
  defaultProvider: TitleWritingProviderKey | null;
  providers: TitleWritingProviderOption[];
  maxCallsPerDay: number;
  maxActiveRuns: number;
  callCapPerRun: number;
  billing: "unknown";
  defaults: TitleWritingSettings;
}
