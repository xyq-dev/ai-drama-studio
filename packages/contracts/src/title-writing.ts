import { z } from "zod";
import { EPISODE_DRAFT_SCHEMA, episodeDraftCandidateSchema, type EpisodeDraftCandidate } from "./writing-assistant";

/**
 * Title-driven automatic writing: title → concept → episode outline → every episode script. Text only.
 *
 * Two frozen input versions exist side by side and never convert into each other:
 * - v1 (ads.title-writing.input.v1): exactly three episodes, 30–180 seconds, five steps, eight calls. Runs stored with
 *   it keep their input, hash, prompts, steps and cap unchanged.
 * - v2 (ads.title-writing.input.v2): the project's episode count (1–6) and target seconds (60 or 90), N+2 steps and
 *   N+5 calls. The server takes N and the seconds from the project, never from the request alone.
 */
export const TITLE_WRITING_INPUT_SCHEMA = "ads.title-writing.input.v1" as const;
export const TITLE_WRITING_INPUT_SCHEMA_V2 = "ads.title-writing.input.v2" as const;
export const TITLE_CONCEPT_SCHEMA = "ads.writing.title-concept.v1" as const;
export const EPISODE_OUTLINE_SCHEMA = "ads.writing.episode-outline.v1" as const;
/** The v2 outline carries exactly the run's N episodes. */
export const EPISODE_OUTLINE_SCHEMA_V2 = "ads.writing.episode-outline.v2" as const;
export const TITLE_WRITING_PROMPT_VERSION = "ads.title-writing.prompt.v1" as const;
export const TITLE_WRITING_PROMPT_VERSION_V2 = "ads.title-writing.prompt.v2" as const;
/**
 * Prompts of a v2 input with the episode writing guidance: the same steps, fields, schemas and limits as prompt v2,
 * with added writing requirements (emotional promise, per-episode obstacle, protagonist action, change, payoff, new
 * information, ending question) and constraints that keep each episode to the run's own outline. New v2 runs freeze
 * this version; runs frozen with prompt v2 keep the v2 text byte for byte.
 */
export const TITLE_WRITING_PROMPT_VERSION_V3 = "ads.title-writing.prompt.v3" as const;
/**
 * Prompt v3 with position-aware episode endings: a non-final episode still leaves its ending question and the facts the
 * next episode inherits; the only or last episode closes the main story and its handoffFacts record the ending instead.
 * Same steps, fields, schemas and limits. New v2 runs freeze this version; runs frozen with prompt v2 or v3 keep theirs.
 */
export const TITLE_WRITING_PROMPT_VERSION_V4 = "ads.title-writing.prompt.v4" as const;

/**
 * The providers a new run, a resume that sends, an administrator update and a default may name. DeepSeek, retired on
 * 2026-10-16, is active again from 2026-10-17 with a new adapter, a new key entered in the console and a new default
 * model; runs stored before that keep their own provider, model and calls and are never sent for again
 * (isLegacyDeepseekRun: a DeepSeek run without the server-written DEEPSEEK_PROVIDER_ADAPTER mark).
 */
export const TITLE_WRITING_PROVIDER_KEYS = ["openai", "anthropic", "deepseek"] as const;
export type TitleWritingProviderKey = (typeof TITLE_WRITING_PROVIDER_KEYS)[number];
/**
 * Retired providers. Runs and calls stored with them stay readable with their real provider and model, and a lost
 * receipt of a request made with them is still answered from the stored run; nothing new is created or sent for them.
 */
export const TITLE_WRITING_RETIRED_PROVIDER_KEYS = ["qwen"] as const;
export type TitleWritingRetiredProviderKey = (typeof TITLE_WRITING_RETIRED_PROVIDER_KEYS)[number];
/**
 * The providers the first (three-provider) model configuration held besides OpenAI. Converting such a file leaves both
 * out, and the note of what was left out keeps naming them: DeepSeek's old key is never carried over or restored.
 */
export const TITLE_WRITING_V1_LEFT_OUT_PROVIDER_KEYS = ["qwen", "deepseek"] as const;
export type TitleWritingV1LeftOutProviderKey = (typeof TITLE_WRITING_V1_LEFT_OUT_PROVIDER_KEYS)[number];
/** Every provider a stored run or call may carry. */
export const TITLE_WRITING_STORED_PROVIDER_KEYS = [...TITLE_WRITING_PROVIDER_KEYS, ...TITLE_WRITING_RETIRED_PROVIDER_KEYS] as const;
export type TitleWritingStoredProviderKey = (typeof TITLE_WRITING_STORED_PROVIDER_KEYS)[number];
export const TITLE_WRITING_PROVIDER_LABELS: Readonly<Record<TitleWritingStoredProviderKey, string>> = {
  openai: "OpenAI",
  anthropic: "Claude",
  deepseek: "DeepSeek",
  qwen: "千问（已退役）",
};

/**
 * The adapter a DeepSeek run is frozen for. Only the server writes it, into the frozen input of every DeepSeek run it
 * creates (newTitleRun, newScriptBreakdownRun); no start body can carry it (the start schemas are strict). Runs stored
 * before the retirement never had it.
 */
export const DEEPSEEK_PROVIDER_ADAPTER = "deepseek.chat-completions.v1" as const;

/** The frozen-input mark of a provider's current adapter: only DeepSeek has one. */
export function frozenProviderAdapter(providerKey: string): { providerAdapter?: typeof DEEPSEEK_PROVIDER_ADAPTER } {
  return providerKey === "deepseek" ? { providerAdapter: DEEPSEEK_PROVIDER_ADAPTER } : {};
}

/**
 * A DeepSeek run stored by the code before the retirement: its frozen input has no adapter mark. Such a run is never
 * driven or sent for again, whatever is configured now; it keeps its frozen provider, model, input, hash, calls and
 * unknown costs, an answer it already stored can still be saved, and a lost receipt of its start is still answered.
 */
export function isLegacyDeepseekRun(input: { providerKey: string; providerAdapter?: unknown }): boolean {
  return input.providerKey === "deepseek" && input.providerAdapter !== DEEPSEEK_PROVIDER_ADAPTER;
}

export function isActiveTitleWritingProvider(key: string): key is TitleWritingProviderKey {
  return (TITLE_WRITING_PROVIDER_KEYS as readonly string[]).includes(key);
}

/**
 * The model list a provider gets when a key is configured and no model list is (the administrator only fills in the key).
 * Claude: the Claude API ID claude-opus-5-5, checked 2026-10-16 at
 * https://platform.claude.com/docs/en/about-claude/models/overview and listed as supporting structured outputs, effort
 * and adaptive thinking — every capability the Claude request uses. A pinned API ID, never a CLI alias. OpenAI keeps
 * needing its own explicit list, as before.
 */
export const TITLE_WRITING_DEFAULT_MODELS: Readonly<Record<TitleWritingProviderKey, readonly string[]>> = {
  openai: [],
  anthropic: ["claude-opus-5-5"],
  // DeepSeek: deepseek-flash (DeepSeek-V4.1-Flash), checked 2026-10-17 at https://api-docs.deepseek.com/ and
  // https://api-docs.deepseek.com/quick_start/pricing/ ("Use deepseek-flash as the model name"; JSON output supported).
  // The retired deepseek-chat / deepseek-reasoner list is not restored.
  deepseek: ["deepseek-flash"],
};

/**
 * Which ready provider is offered when no default provider is configured (or the configured one is not ready): Claude
 * first. Only a choice offered before a request; a failed request is never moved to another provider. Saving the
 * DeepSeek quick setup makes DeepSeek the configured default.
 */
export const TITLE_WRITING_PROVIDER_PREFERENCE: readonly TitleWritingProviderKey[] = ["anthropic", "openai", "deepseek"];

export const DEEPSEEK_API_KEY_MIN_LENGTH = 16;
export const DEEPSEEK_API_KEY_MAX_LENGTH = 256;
/**
 * Whether a value can be saved as a DeepSeek API key. DeepSeek documents no key format, so no prefix is required: only
 * a length that a key can have and printable ASCII without spaces (a value that can travel in an Authorization header
 * unchanged). Null only means the value may be saved; whether it is valid or funded only DeepSeek can answer.
 */
export function deepseekKeyProblem(value: string): "unsupported_format" | null {
  if (value.length < DEEPSEEK_API_KEY_MIN_LENGTH || value.length > DEEPSEEK_API_KEY_MAX_LENGTH) return "unsupported_format";
  return /^[\x21-\x7e]+$/u.test(value) ? null : "unsupported_format";
}

/**
 * Claude API keys created in the Claude Console, checked 2026-10-17 against
 * https://platform.claude.com/docs/en/manage-claude/authentication (personal keys, service account keys and legacy
 * workspace keys all authenticate Messages API requests) and the official TypeScript SDK 0.135.0 (sends any key as
 * x-api-key without reading its prefix). The documentation names only the sk-ant-api… form; personal keys created
 * with "Linked account = yourself" start sk-ant-usr- (observed on a real Console key) and service account keys
 * sk-ant-svc- (reported by tools that fixed the same misclassification). Unknown sk-ant- kinds are not accepted.
 */
const ANTHROPIC_API_KEY_SHAPE = /^sk-ant-(?:api|usr|svc)\d*-[A-Za-z0-9_-]{8,}$/u;
/**
 * Anthropic credentials that are not Messages API keys: subscription / Claude Code OAuth access and refresh tokens
 * (sk-ant-oat…, sk-ant-ort…), Admin API keys (sk-ant-admin…) and browser session values (sk-ant-sid…).
 */
const ANTHROPIC_NON_API_CREDENTIAL = /^sk-ant-(?:oat|ort|admin|sid)\d*-/u;
/** A JSON Web Token (federation or session tokens): never a static API key. */
const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\./u;
export const ANTHROPIC_API_KEY_MAX_LENGTH = 256;

/**
 * Why a value cannot be configured as a Claude API key, or null when it has the shape of one. A null answer only means
 * the value may be saved as a key: it says nothing about whether the key is valid, funded or allowed to use a model.
 * - not_api_credential: a known Anthropic credential of another kind (OAuth / setup token, Admin key, session) or a JWT.
 * - unsupported_format: anything else (another vendor's key, an unknown sk-ant- kind, spaces, control or other
 *   characters a header must not carry, too short or too long). The value itself is never altered.
 */
export function anthropicKeyProblem(value: string): "unsupported_format" | "not_api_credential" | null {
  if (value.length > ANTHROPIC_API_KEY_MAX_LENGTH) return "unsupported_format";
  if (ANTHROPIC_NON_API_CREDENTIAL.test(value) || JWT_SHAPE.test(value)) return "not_api_credential";
  return ANTHROPIC_API_KEY_SHAPE.test(value) ? null : "unsupported_format";
}

/**
 * A Claude Console workspace id (the ID column of platform.claude.com/settings/workspaces, e.g. wrkspc_01Jw…). Only an
 * identifier, not a secret; sent as anthropic-workspace-id when configured. Keys scoped to one workspace need none;
 * keys not scoped to a workspace must name one on every request.
 */
export const ANTHROPIC_WORKSPACE_ID_SHAPE = /^wrkspc_[A-Za-z0-9_-]{4,100}$/u;
export function anthropicWorkspaceIdValid(value: string): boolean {
  return ANTHROPIC_WORKSPACE_ID_SHAPE.test(value);
}

/** The v1 scope: three episodes (domain PRODUCTION_EPISODE_NUMBERS). */
export const TITLE_WRITING_EPISODE_COUNT = 3 as const;
export const TITLE_WRITING_DEFAULT_EPISODE_SECONDS = 90;
export const TITLE_WRITING_TITLE_MAX_CHARS = 60;
/** v2 project scope. The outline of all N episodes is one call under the 4096-token output cap, hence at most six. */
export const TITLE_WRITING_MIN_EPISODES = 1;
export const TITLE_WRITING_MAX_EPISODES = 6;
export const TITLE_WRITING_DEFAULT_EPISODE_COUNT = 3;
/** v2 target seconds per episode: "about 1 minute" and "about 1.5 minutes". A writing target, not a measured length. */
export const TITLE_WRITING_EPISODE_SECONDS_CHOICES = [60, 90] as const;
/** Calls a v2 run needs when every step succeeds the first time: concept, outline and one per episode. */
export function titleWritingRequiredCalls(episodeCount: number): number {
  return episodeCount + 2;
}
/** Hard cap of v2 calls per run: the required calls plus three resends. A count limit, not retries and not money. */
export function titleWritingCallCap(episodeCount: number): number {
  return episodeCount + 5;
}

/** Every step key any version may have. v1 runs use only the first five. */
export const TITLE_WRITING_ALL_STEP_KEYS = [
  "concept", "outline", "episode:1", "episode:2", "episode:3", "episode:4", "episode:5", "episode:6",
] as const;
/** A title run's steps, or the single "breakdown" step of a script breakdown run (script-breakdown.ts). */
export type TitleWritingStepKey = (typeof TITLE_WRITING_ALL_STEP_KEYS)[number] | "breakdown";
/** The five steps of a v1 run. */
export const TITLE_WRITING_STEP_KEYS = ["concept", "outline", "episode:1", "episode:2", "episode:3"] as const satisfies readonly TitleWritingStepKey[];

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

/** v1 settings: unchanged, including the 30–180 second range stored runs and replayed requests may carry. */
export const titleWritingSettingsSchema = z.object({
  episodeCount: z.literal(TITLE_WRITING_EPISODE_COUNT).default(TITLE_WRITING_EPISODE_COUNT),
  episodeSeconds: z.number().int().min(30).max(180).default(TITLE_WRITING_DEFAULT_EPISODE_SECONDS),
  style: z.string().trim().max(40).default(""),
}).strict();

const episodeCountSchema = z.number().int().min(TITLE_WRITING_MIN_EPISODES).max(TITLE_WRITING_MAX_EPISODES);

/** Settings of any version. v1 runs always have episodeCount 3. */
export interface TitleWritingSettings {
  episodeCount: number;
  episodeSeconds: number;
  style: string;
}

/**
 * Start request body. The title is the only required creative field. The server checks the settings against the
 * project: for a v2 project episodeCount and episodeSeconds, when sent, must equal the project's plan; for a project
 * without a plan the v1 settings rules apply unchanged. The request never chooses the version.
 */
export const titleWritingStartSchema = z.object({
  title: titleText,
  // A retired key is parsed only so that a lost receipt of an earlier start can still be answered; the server never
  // creates a run or sends a call for it.
  providerKey: z.enum(TITLE_WRITING_STORED_PROVIDER_KEYS).optional(),
  model: z.string().regex(MODEL_ID).optional(),
  settings: z.object({
    episodeCount: episodeCountSchema.optional(),
    episodeSeconds: z.number().int().min(30).max(180).optional(),
    style: z.string().trim().max(40).optional(),
  }).strict().optional(),
}).strict();
export type TitleWritingStart = z.infer<typeof titleWritingStartSchema>;

/** Frozen, hashed input of one v1 run. Provider and model are resolved by the server against its allowlist. */
export interface TitleWritingFrozenInputV1 {
  schema: typeof TITLE_WRITING_INPUT_SCHEMA;
  promptVersion: typeof TITLE_WRITING_PROMPT_VERSION;
  title: string;
  settings: TitleWritingSettings;
  providerKey: TitleWritingStoredProviderKey;
  model: string;
  /** DeepSeek runs created by the current server only (DEEPSEEK_PROVIDER_ADAPTER). Absent on every older run. */
  providerAdapter?: typeof DEEPSEEK_PROVIDER_ADAPTER;
}

/**
 * Frozen, hashed input of one v2 run. N and the target seconds were copied from the project's episode plan. Runs
 * created before the writing guidance carry prompt v2, runs created before the position-aware endings carry prompt v3;
 * newer runs carry prompt v4.
 */
export interface TitleWritingFrozenInputV2 {
  schema: typeof TITLE_WRITING_INPUT_SCHEMA_V2;
  promptVersion: typeof TITLE_WRITING_PROMPT_VERSION_V2 | typeof TITLE_WRITING_PROMPT_VERSION_V3 | typeof TITLE_WRITING_PROMPT_VERSION_V4;
  title: string;
  settings: TitleWritingSettings;
  providerKey: TitleWritingStoredProviderKey;
  model: string;
  /** DeepSeek runs created by the current server only (DEEPSEEK_PROVIDER_ADAPTER). Absent on every older run. */
  providerAdapter?: typeof DEEPSEEK_PROVIDER_ADAPTER;
}

export type TitleWritingFrozenInput = TitleWritingFrozenInputV1 | TitleWritingFrozenInputV2;

export function isTitleWritingInputV2(input: TitleWritingFrozenInput): input is TitleWritingFrozenInputV2 {
  return input.schema === TITLE_WRITING_INPUT_SCHEMA_V2;
}

/** N of a run. Any input that is not v2 is v1, which is three episodes whatever else it carries. */
export function titleWritingEpisodeCount(input: TitleWritingFrozenInput): number {
  return isTitleWritingInputV2(input) ? input.settings.episodeCount : TITLE_WRITING_EPISODE_COUNT;
}

/** The ordered step keys of a run: concept, outline, episode:1..N. A v1 run gets exactly its original five. */
export function titleWritingStepKeysFor(input: TitleWritingFrozenInput): TitleWritingStepKey[] {
  if (!isTitleWritingInputV2(input)) return [...TITLE_WRITING_STEP_KEYS];
  return TITLE_WRITING_ALL_STEP_KEYS.slice(0, titleWritingRequiredCalls(input.settings.episodeCount));
}

/** The call cap of a new run: eight for v1 (as before), N+5 for v2. Stored runs keep the cap they were created with. */
export function titleWritingCallCapFor(input: TitleWritingFrozenInput): number {
  return isTitleWritingInputV2(input) ? titleWritingCallCap(input.settings.episodeCount) : 8;
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

const outlineEpisodeFields = {
  title: text(1, 40),
  entryState: text(1, 400),
  goal: text(1, 400),
  action: text(1, 400),
  turn: text(1, 400),
  result: text(1, 400),
  handoff: text(1, 400),
};

const outlineEpisodeSchema = z.object({
  episodeNo: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  ...outlineEpisodeFields,
}).strict();

/** The v1 outline: exactly episodes 1, 2, 3. */
export const episodeOutlineSchema = z.object({
  schema: z.literal(EPISODE_OUTLINE_SCHEMA),
  episodes: z.array(outlineEpisodeSchema).length(TITLE_WRITING_EPISODE_COUNT),
}).strict().superRefine((value, context) => {
  const numbers = value.episodes.map((episode) => episode.episodeNo);
  if (numbers.some((episodeNo, index) => episodeNo !== index + 1)) {
    context.addIssue({ code: "custom", message: "分集大纲必须按第 1、2、3 集顺序给出且不重复" });
  }
});

/** The v2 outline of a run with N episodes: exactly N items numbered 1..N in order, none missing or repeated. */
export function episodeOutlineV2Schema(episodeCount: number) {
  return z.object({
    schema: z.literal(EPISODE_OUTLINE_SCHEMA_V2),
    episodes: z.array(z.object({ episodeNo: z.number().int().min(1).max(episodeCount), ...outlineEpisodeFields }).strict())
      .length(episodeCount),
  }).strict().superRefine((value, context) => {
    if (value.episodes.some((episode, index) => episode.episodeNo !== index + 1)) {
      context.addIssue({ code: "custom", message: `分集大纲必须按第 1 到第 ${String(episodeCount)} 集顺序给出且不重复` });
    }
  });
}

export interface EpisodeOutlineEpisode {
  episodeNo: number;
  title: string;
  entryState: string;
  goal: string;
  action: string;
  turn: string;
  result: string;
  handoff: string;
}

/** An outline of either version. */
export interface EpisodeOutline {
  schema: typeof EPISODE_OUTLINE_SCHEMA | typeof EPISODE_OUTLINE_SCHEMA_V2;
  episodes: EpisodeOutlineEpisode[];
}

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

/**
 * The provider JSON Schemas of one run. A v1 run gets the constant above unchanged; a v2 run's outline has exactly N
 * items and its episode numbers are limited to 1..N.
 */
export function titleWritingJsonSchemas(
  input: TitleWritingFrozenInput,
): Readonly<Record<"concept" | "outline" | "episode", { name: string; schema: Record<string, unknown> }>> {
  if (!isTitleWritingInputV2(input)) return TITLE_WRITING_JSON_SCHEMAS;
  const count = input.settings.episodeCount;
  const numbers = { type: "integer", enum: Array.from({ length: count }, (_, index) => index + 1) } as const;
  return {
    concept: TITLE_WRITING_JSON_SCHEMAS.concept,
    outline: {
      name: "episode_outline",
      schema: objectOf({
        schema: { type: "string", enum: [EPISODE_OUTLINE_SCHEMA_V2] },
        episodes: { type: "array", minItems: count, maxItems: count, items: objectOf({
          episodeNo: numbers, title: stringField(40), entryState: stringField(400), goal: stringField(400),
          action: stringField(400), turn: stringField(400), result: stringField(400), handoff: stringField(400),
        }) },
      }),
    },
    episode: {
      name: "episode_draft",
      schema: {
        ...TITLE_WRITING_JSON_SCHEMAS.episode.schema,
        properties: { ...(TITLE_WRITING_JSON_SCHEMAS.episode.schema.properties as Record<string, unknown>), episodeNo: numbers },
      },
    },
  };
}

export type TitleWritingRunState ="running" | "completed" | "partial" | "needs_attention" | "canceled" | "failed";
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
  providerKey: TitleWritingStoredProviderKey;
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
  /** 1 for a v1 run (three episodes, as stored), 2 for a run frozen from the project's episode plan. */
  inputVersion: 1 | 2;
  /** The prompt version frozen with the run. Absent in answers of an API from before the writing guidance. */
  promptVersion?: string;
  /** N of this run: its outline has N episodes and it has N episode steps. */
  episodeCount: number;
  settings: TitleWritingSettings;
  providerKey: TitleWritingStoredProviderKey;
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
  /** True for a DeepSeek run stored before the retirement: it is never sent for again. Absent from older APIs. */
  legacyProviderRun?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** At most one uncertain call per step can be open for confirmation, so the eight steps of a six-episode run bound the list. */
export const TITLE_WRITING_MAX_CONFIRMED_CALLS = TITLE_WRITING_ALL_STEP_KEYS.length;

/**
 * The uncertain calls a resume would resend: for every step that is currently unknown, the call of its current
 * attempt. A confirmation is valid only for exactly this set, so an old confirmation can never cover a newer
 * uncertain attempt. Server and browser use the same rule. Sorted for comparison.
 */
export function currentUncertainCallIds(
  steps: ReadonlyArray<{ stepKey: TitleWritingStepKey; state: TitleWritingStepState; attemptNo: number }>,
  calls: ReadonlyArray<{ callId: string; stepKey: TitleWritingStepKey; attemptNo: number; state: TitleWritingCallState }>,
): string[] {
  const ids: string[] = [];
  for (const step of steps) {
    if (step.state !== "unknown") continue;
    const call = calls.find((item) => item.stepKey === step.stepKey && item.attemptNo === step.attemptNo && item.state === "unknown");
    if (call) ids.push(call.callId);
  }
  return ids.sort();
}

/**
 * Resume request body. confirmUncertainCallIds names the uncertain calls the person saw and accepted may be billed
 * again; it must equal currentUncertainCallIds at the time the server applies it. The Idempotency-Key header is the
 * identity of this one resume action.
 */
export const titleWritingResumeSchema = z.object({
  confirmUncertainCallIds: z.array(z.string().uuid()).max(TITLE_WRITING_MAX_CONFIRMED_CALLS).default([]),
}).strict();
export type TitleWritingResume = z.infer<typeof titleWritingResumeSchema>;

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
  /**
   * False when the signed-in site administrator is the operator (the site login is on): the page sends no token and the
   * server checks the session, origin and CSRF token instead. True only when the API runs without the site login.
   */
  operatorTokenRequired: boolean;
  /**
   * The configured default provider even when it cannot be used now (its providers entry says why), else the first
   * ready provider. A configured default that is not ready is never replaced by another provider: a request without a
   * provider is refused until it is ready or the person explicitly names another one.
   */
  defaultProvider: TitleWritingProviderKey | null;
  providers: TitleWritingProviderOption[];
  /** A model configuration was saved in the console and waits for the API restart to apply it. Absent from older APIs. */
  configurationPending?: boolean;
  maxCallsPerDay: number;
  maxActiveRuns: number;
  /** The v1 cap, also the cap of a three-episode v2 run. A v2 run's own cap is N+5 (titleWritingCallCap). */
  callCapPerRun: number;
  billing: "unknown";
  defaults: TitleWritingSettings;
  /** The choices a new project may take: 1–6 episodes and 60 or 90 seconds per episode. */
  episodePlan: { minEpisodes: number; maxEpisodes: number; defaultEpisodes: number; secondsChoices: number[]; defaultSeconds: number };
  /** False until the episode plan migration is applied; projects with a plan cannot be created before that. */
  episodePlanReady: boolean;
}
