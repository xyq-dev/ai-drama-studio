import { z } from "zod";
import type { TitleWritingCallView, TitleWritingProviderKey, TitleWritingStoredProviderKey, TitleWritingProviderOption, TitleWritingRunState, TitleWritingStepState } from "./title-writing";
import { TITLE_WRITING_STORED_PROVIDER_KEYS, type DEEPSEEK_PROVIDER_ADAPTER } from "./title-writing";
import { WRITING_BODY_MAX_CHARS } from "./writing-assistant";

/**
 * Script breakdown: one approved script revision of one episode → scenes and proposed shots, text only. A breakdown
 * run is a title writing run of kind "script_breakdown" with the single step "breakdown"; it shares the call ledger,
 * the daily quota, cancellation, lease recovery and the "unknown is never resent" rule with title writing.
 *
 * Planned seconds are a writing plan. They are never a measured length of any media.
 */
export const SCRIPT_BREAKDOWN_INPUT_SCHEMA = "ads.script-breakdown.input.v1" as const;
export const SCRIPT_BREAKDOWN_OUTPUT_SCHEMA = "ads.script-breakdown.output.v1" as const;
export const SCRIPT_BREAKDOWN_PROMPT_VERSION = "ads.script-breakdown.prompt.v1" as const;
export const SCRIPT_BREAKDOWN_STEP_KEY = "breakdown" as const;

/**
 * Bounds of one breakdown, shown on the page. Scenes and shots follow the production plan (60 s: 2–4 scenes, 90 s:
 * 3–6 scenes, about 5 s per shot). Field bounds limit size but do not guarantee a fit in the 4,096-token output cap;
 * a truncated answer is rejected, never silently shortened or continued.
 */
export const SCRIPT_BREAKDOWN_LIMITS = {
  scriptMaxChars: WRITING_BODY_MAX_CHARS,
  maxCharacters: 30,
  minScenes: 1,
  maxScenes: 8,
  minShots: 1,
  maxShots: 20,
  maxShotsPerScene: 8,
  minShotSeconds: 2,
  maxShotSeconds: 10,
  minTotalSeconds: 5,
  maxTotalSeconds: 180,
  headingMaxChars: 40,
  timeOfDayMaxChars: 20,
  descriptionMaxChars: 200,
  shotTypeMaxChars: 20,
  cameraMaxChars: 80,
  actionMaxChars: 120,
  speakerMaxChars: 20,
  lineMaxChars: 120,
  maxLinesPerShot: 4,
} as const;

/** One call is needed; two more sends are allowed after a rejected or a confirmed uncertain call. */
export const SCRIPT_BREAKDOWN_REQUIRED_CALLS = 1;
export const SCRIPT_BREAKDOWN_CALL_CAP = 3;

export interface ScriptBreakdownCharacter {
  /** Key the model uses to reference this character ("C1"…). Only meaningful inside this run. */
  key: string;
  characterId: string;
  /** The character's current revision when the run was started. */
  revisionId: string;
  name: string;
}

/** Frozen input of one breakdown run. The prompt is built from this copy only; nothing is read again before sending. */
export interface ScriptBreakdownFrozenInput {
  schema: typeof SCRIPT_BREAKDOWN_INPUT_SCHEMA;
  promptVersion: typeof SCRIPT_BREAKDOWN_PROMPT_VERSION;
  episodeId: string;
  episodeNo: number;
  scriptRevisionId: string;
  scriptRevisionNo: number;
  scriptContentHash: string;
  scriptText: string;
  /** The project's target seconds per episode; null when the project never recorded one. A target, not a length. */
  targetEpisodeSeconds: number | null;
  characters: ScriptBreakdownCharacter[];
  /** The episode's scenes and shots when the run started. They are replaced only if still exactly these versions. */
  replace: { scenes: Array<{ sceneId: string; rowVersion: number }>; shots: Array<{ shotId: string; rowVersion: number }> };
  providerKey: TitleWritingStoredProviderKey;
  model: string;
  /** DeepSeek runs created by the current server only (DEEPSEEK_PROVIDER_ADAPTER). Absent on every older run. */
  providerAdapter?: typeof DEEPSEEK_PROVIDER_ADAPTER;
}

export function isScriptBreakdownInput(input: unknown): input is ScriptBreakdownFrozenInput {
  return Boolean(input && typeof input === "object" && (input as { schema?: unknown }).schema === SCRIPT_BREAKDOWN_INPUT_SCHEMA);
}

const MODEL_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Start request body. The episode comes from the route; the script, characters and scenes are read by the server. */
export const scriptBreakdownStartSchema = z.object({
  providerKey: z.enum(TITLE_WRITING_STORED_PROVIDER_KEYS).optional(),
  model: z.string().regex(MODEL_ID).optional(),
  /** Required when the episode already has scenes: the new result replaces them (old versions are kept). */
  replaceExisting: z.boolean().default(false),
}).strict();
export type ScriptBreakdownStart = z.infer<typeof scriptBreakdownStartSchema>;

export const scriptBreakdownPlaceSchema = z.object({
  /** Write shots under a scene a person changed after the breakdown, using the approved changed version. */
  acceptSceneChanged: z.boolean().default(false),
}).strict();

/** Required text counts only visible content; the value is kept as sent. */
function text(min: number, max: number) {
  return z.string().max(max)
    .refine((value) => value.trim().length >= min, "必填内容不能为空白")
    .refine((value) => !value.includes("\u0000"), "文本含有空字符");
}

const L = SCRIPT_BREAKDOWN_LIMITS;
export const SCENE_KEY = /^S[1-8]$/;
export const SHOT_KEY = /^S[1-8]-[1-8]$/;
export const CHARACTER_KEY = /^C([1-9]|[12][0-9]|30)$/;

export const scriptBreakdownOutputSchema = z.object({
  schema: z.literal(SCRIPT_BREAKDOWN_OUTPUT_SCHEMA),
  episodeNo: z.number().int().min(1).max(6),
  scenes: z.array(z.object({
    key: z.string().regex(SCENE_KEY),
    heading: text(1, L.headingMaxChars),
    timeOfDay: text(0, L.timeOfDayMaxChars),
    description: text(1, L.descriptionMaxChars),
  }).strict()).min(L.minScenes).max(L.maxScenes),
  shots: z.array(z.object({
    key: z.string().regex(SHOT_KEY),
    sceneKey: z.string().regex(SCENE_KEY),
    shotType: text(1, L.shotTypeMaxChars),
    camera: text(1, L.cameraMaxChars),
    action: text(1, L.actionMaxChars),
    dialogue: z.array(z.object({ speaker: text(1, L.speakerMaxChars), line: text(1, L.lineMaxChars) }).strict())
      .max(L.maxLinesPerShot),
    characterKeys: z.array(z.string().regex(CHARACTER_KEY)).max(L.maxCharacters),
    plannedSeconds: z.number().int().min(L.minShotSeconds).max(L.maxShotSeconds),
  }).strict()).min(L.minShots).max(L.maxShots),
}).strict();
export type ScriptBreakdownOutput = z.infer<typeof scriptBreakdownOutputSchema>;
export type ScriptBreakdownScene = ScriptBreakdownOutput["scenes"][number];
export type ScriptBreakdownShot = ScriptBreakdownOutput["shots"][number];

function stringField(maxLength: number) {
  return { type: "string", maxLength } as const;
}

function objectOf(properties: Record<string, unknown>) {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties } as const;
}

/** JSON Schema for providers that enforce one (OpenAI strict mode). The zod schema and domain checks stay the authority. */
export function scriptBreakdownJsonSchema(episodeNo: number): { name: string; schema: Record<string, unknown> } {
  return {
    name: "script_breakdown",
    schema: objectOf({
      schema: { type: "string", enum: [SCRIPT_BREAKDOWN_OUTPUT_SCHEMA] },
      episodeNo: { type: "integer", enum: [episodeNo] },
      scenes: { type: "array", minItems: L.minScenes, maxItems: L.maxScenes, items: objectOf({
        key: stringField(2), heading: stringField(L.headingMaxChars), timeOfDay: stringField(L.timeOfDayMaxChars),
        description: stringField(L.descriptionMaxChars),
      }) },
      shots: { type: "array", minItems: L.minShots, maxItems: L.maxShots, items: objectOf({
        key: stringField(4), sceneKey: stringField(2), shotType: stringField(L.shotTypeMaxChars),
        camera: stringField(L.cameraMaxChars), action: stringField(L.actionMaxChars),
        dialogue: { type: "array", maxItems: L.maxLinesPerShot,
          items: objectOf({ speaker: stringField(L.speakerMaxChars), line: stringField(L.lineMaxChars) }) },
        characterKeys: { type: "array", maxItems: L.maxCharacters, items: stringField(3) },
        plannedSeconds: { type: "integer", minimum: L.minShotSeconds, maximum: L.maxShotSeconds },
      }) },
    }),
  };
}

/** Why a model answer was refused. Each one fails the step; nothing is repaired, continued or replaced by a template. */
export type ScriptBreakdownRejection =
  | "invalid_json"
  | "invalid_output"
  | "episode_mismatch"
  | "duplicate_key"
  | "missing_reference"
  | "dialogue_not_in_script"
  | "unsafe_content"
  | "duration_out_of_range";

/** pending until the result is saved; source_changed and conflict keep the result in the run without writing it. */
export type ScriptBreakdownSave = "pending" | "saved" | "source_changed" | "conflict";

export interface ScriptBreakdownSceneView {
  key: string;
  ordinal: number;
  sceneId: string;
  /** The scene revision this breakdown wrote. */
  sceneRevisionId: string;
  shotSave: "pending" | "saved";
  /** The approved scene revision the shots were written under; null until written. */
  placedSceneRevisionId: string | null;
  /** The scene's state now. */
  current: {
    archived: boolean;
    currentRevisionId: string | null;
    approvedRevisionId: string | null;
    reviewStatus: string | null;
    freshnessStatus: string | null;
  };
}

export interface ScriptBreakdownRunView {
  runId: string;
  projectId: string;
  episodeId: string;
  episodeNo: number;
  scriptRevisionId: string;
  scriptRevisionNo: number;
  targetEpisodeSeconds: number | null;
  characters: Array<{ key: string; characterId: string; revisionId: string; name: string }>;
  replacedScenes: number;
  providerKey: TitleWritingStoredProviderKey;
  model: string;
  state: TitleWritingRunState;
  errorCode: string | null;
  cancelRequested: boolean;
  callCap: number;
  callsUsed: number;
  step: { state: TitleWritingStepState; attemptNo: number; errorCode: string | null };
  /** Validated output; null until the step completed. */
  output: ScriptBreakdownOutput | null;
  /** Sum of planned shot seconds of the output. A plan, not a measured length. */
  plannedTotalSeconds: number | null;
  save: ScriptBreakdownSave;
  scenes: ScriptBreakdownSceneView[];
  /** The episode's script now, to tell whether this run's source is still the current one. */
  episodeScript: { currentRevisionId: string | null; currentRevisionNo: number | null; approved: boolean };
  calls: TitleWritingCallView[];
  /** True for a DeepSeek run stored before the retirement: it is never sent for again. Absent from older APIs. */
  legacyProviderRun?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ScriptBreakdownOptionsView {
  enabled: boolean;
  code: string;
  storageReady: boolean;
  /**
   * False when the signed-in site administrator is the operator (the site login is on): the page sends no token and the
   * server checks the session, origin and CSRF token instead. True only when the API runs without the site login.
   */
  operatorTokenRequired: boolean;
  defaultProvider: TitleWritingProviderKey | null;
  providers: TitleWritingProviderOption[];
  maxCallsPerDay: number;
  callCapPerRun: number;
  billing: "unknown";
  limits: typeof SCRIPT_BREAKDOWN_LIMITS;
}
