import { z } from "zod";
export * from "./admin-models";
export * from "./auto-creation";
export * from "./series-writing";

export const SERVICE_NAME = {
  api: "api",
  worker: "worker",
  web: "web",
  comfyuiAdapter: "comfyui-adapter",
  mediaWorker: "media-worker",
} as const;

export type ServiceName = (typeof SERVICE_NAME)[keyof typeof SERVICE_NAME];

export const healthStatusSchema = z.enum(["ok", "degraded", "down"]);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

export const dependencyStatusSchema = z.enum(["ok", "down"]);
export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;

export const dependencyHealthSchema = z.object({
  status: dependencyStatusSchema,
});
export type DependencyHealth = z.infer<typeof dependencyHealthSchema>;

export const serviceHealthResponseSchema = z.object({
  service: z.string(),
  status: z.literal("ok"),
  version: z.string().optional(),
  timestamp: z.string(),
});
export type ServiceHealthResponse = z.infer<typeof serviceHealthResponseSchema>;

export const readyHealthResponseSchema = z.object({
  service: z.string(),
  status: z.enum(["ok", "degraded"]),
  timestamp: z.string(),
  dependencies: z.object({
    postgres: dependencyHealthSchema.optional(),
    redis: dependencyHealthSchema.optional(),
    objectStorage: dependencyHealthSchema.optional(),
  }),
});
export type ReadyHealthResponse = z.infer<typeof readyHealthResponseSchema>;

export const workerLiveResponseSchema = z.object({
  service: z.literal(SERVICE_NAME.worker),
  status: z.literal("ok"),
  version: z.string(),
  timestamp: z.string(),
});
export type WorkerLiveResponse = z.infer<typeof workerLiveResponseSchema>;

export const workerReadyResponseSchema = z.object({
  service: z.literal(SERVICE_NAME.worker),
  status: z.enum(["ok", "degraded"]),
  version: z.string(),
  timestamp: z.string(),
  dependencies: z.object({
    postgres: dependencyHealthSchema,
    redis: dependencyHealthSchema,
    queue: dependencyHealthSchema,
  }),
});
export type WorkerReadyResponse = z.infer<typeof workerReadyResponseSchema>;

export const adapterHealthResponseSchema = z.object({
  service: z.literal(SERVICE_NAME.comfyuiAdapter),
  status: z.enum(["ok", "degraded"]),
  mode: z.literal("stub"),
  comfyuiConfigured: z.boolean(),
  timestamp: z.string(),
});
export type AdapterHealthResponse = z.infer<typeof adapterHealthResponseSchema>;

export const mediaWorkerHealthResponseSchema = z.object({
  service: z.literal(SERVICE_NAME.mediaWorker),
  status: z.literal("ok"),
  mode: z.literal("stub"),
  ffmpegRequired: z.literal(false),
  timestamp: z.string(),
});
export type MediaWorkerHealthResponse = z.infer<typeof mediaWorkerHealthResponseSchema>;

export function parseReadyHealthResponse(value: unknown): ReadyHealthResponse | undefined {
  const parsed = readyHealthResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export const textProviderErrorCodeSchema = z.enum([
  "VALIDATION", "AUTH", "POLICY", "QUOTA", "RATE_LIMITED", "TIMEOUT", "TEMPORARY",
  "UNAVAILABLE", "CANCELED", "REMOTE_FAILED", "UNKNOWN",
]);
export type TextProviderErrorCode = z.infer<typeof textProviderErrorCodeSchema>;

export const textProviderErrorSchema = z.object({
  code: textProviderErrorCodeSchema,
  providerCode: z.string().max(200).optional(),
  message: z.string().max(1000),
  retryable: z.boolean(),
  retryAfterMs: z.number().int().nonnegative().optional(),
}).strict();
export type TextProviderError = z.infer<typeof textProviderErrorSchema>;

/**
 * Mock Scene and Shot batches cover every episode of a project: one to six (the episode plan), three for projects
 * without a plan. The database checks that a batch is exactly the project's episodes 1..N.
 */
export const MOCK_TEXT_MAX_EPISODES = 6;

const sceneSourceSchema = z.object({
  episodeId: z.string().uuid(), episodeNo: z.number().int().min(1).max(MOCK_TEXT_MAX_EPISODES),
  episodeVersion: z.number().int().positive(), scriptRevisionId: z.string().uuid(),
  scriptContent: z.unknown(),
}).strict();
const shotSourceSchema = z.object({
  episodeId: z.string().uuid(), episodeNo: z.number().int().min(1).max(MOCK_TEXT_MAX_EPISODES),
  sceneId: z.string().uuid(), sceneVersion: z.number().int().positive(),
  sceneRevisionId: z.string().uuid(),
  sceneContent: z.object({ heading: z.string(), timeOfDay: z.string().nullable(), summary: z.string() }).strict(),
}).strict();

export const textGenerationRequestSchema = z.discriminatedUnion("kind", [
  z.object({ schema: z.literal("m2.text.request.v1"), kind: z.literal("SCENES"),
    projectId: z.string().uuid(), sources: z.array(sceneSourceSchema).min(1).max(MOCK_TEXT_MAX_EPISODES) }).strict(),
  z.object({ schema: z.literal("m2.text.request.v1"), kind: z.literal("SHOTS"),
    projectId: z.string().uuid(), sources: z.array(shotSourceSchema).min(1).max(MOCK_TEXT_MAX_EPISODES) }).strict(),
]);
export type TextGenerationRequest = z.infer<typeof textGenerationRequestSchema>;

export const sceneBatchOutputSchema = z.object({
  schema: z.literal("m2.text.scenes.output.v1"),
  scenes: z.array(z.object({
    projectId: z.string().uuid(), episodeId: z.string().uuid(), episodeNo: z.number().int().min(1).max(MOCK_TEXT_MAX_EPISODES),
    sourceScriptRevisionId: z.string().uuid(), ordinal: z.number().int().positive(),
    heading: z.string().min(1).max(400), timeOfDay: z.string().max(100).nullable().optional(),
    summary: z.string().max(4000),
  }).strict()).min(1).max(MOCK_TEXT_MAX_EPISODES),
}).strict();
export type SceneBatchOutput = z.infer<typeof sceneBatchOutputSchema>;

export const shotBatchOutputSchema = z.object({
  schema: z.literal("m2.text.shots.output.v1"),
  shots: z.array(z.object({
    projectId: z.string().uuid(), episodeId: z.string().uuid(), episodeNo: z.number().int().min(1).max(MOCK_TEXT_MAX_EPISODES),
    sceneId: z.string().uuid(), sourceSceneRevisionId: z.string().uuid(), ordinal: z.number().int().positive(),
    shotType: z.string().min(1).max(100), camera: z.string().max(1000), action: z.string().max(4000),
    dialogue: z.string().max(4000).nullable().optional(), durationHint: z.string().max(200).nullable().optional(),
    promptText: z.string().max(8000),
  }).strict()).min(1).max(MOCK_TEXT_MAX_EPISODES),
}).strict();
export type ShotBatchOutput = z.infer<typeof shotBatchOutputSchema>;
export type TextGenerationOutput = SceneBatchOutput | ShotBatchOutput;
export const textGenerationOutputSchema = z.union([sceneBatchOutputSchema, shotBatchOutputSchema]);

export interface TextAdapterContext {
  requestId: string;
  idempotencyKey: string;
  providerKey: string;
}

export const textAdapterResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("succeeded"), output: textGenerationOutputSchema }).strict(),
  z.object({ kind: z.literal("failed"), error: textProviderErrorSchema }).strict(),
  z.object({ kind: z.literal("unknown"), error: textProviderErrorSchema.optional() }).strict(),
]);
export type TextAdapterResult = z.infer<typeof textAdapterResultSchema>;

/** Only replay-safe synchronous adapters are supported by the M2 recovery contract. */
export interface TextGenerationAdapter {
  readonly providerKey: string;
  readonly replayPolicy: "REPLAY_SAFE_SYNC";
  generate(request: TextGenerationRequest, context: TextAdapterContext): Promise<TextAdapterResult>;
}

export {
  EPISODE_DRAFT_SCHEMA,
  STORY_PLAN_SCHEMA,
  WRITING_BODY_MAX_CHARS,
  WRITING_IMPORT_MAX_BYTES,
  WRITING_NOTE_MAX_CHARS,
  WRITING_PROMPT_VERSION,
  episodeDraftCandidateSchema,
  storyPlanCandidateSchema,
  writingCandidateSchema,
  type EpisodeDraftCandidate,
  type StoryPlanCandidate,
  type WritingCandidate,
} from "./writing-assistant";
export {
  SAMPLE_VIDEO_DESCRIPTIONS,
  SAMPLE_VIDEO_FIXTURE_IDS,
  SAMPLE_VIDEO_SCHEMA,
  formatSampleVideoRequestId,
  frozenSampleFields,
  isSampleVideoFixtureId,
  isSampleVideoSnapshot,
  looksLikeSampleVideoRequestId,
  parseSampleVideoRequestId,
  sampleVideoDescription,
  sampleVideoGenerationEnabled,
  sampleVideoRequestIdFromSnapshot,
  type FrozenSampleVideoFields,
  type ParsedSampleVideoRequest,
  type SampleVideoDescription,
  type SampleVideoFixtureId,
} from "./sample-video";
export {
  EPISODE_OUTLINE_SCHEMA,
  EPISODE_OUTLINE_SCHEMA_V2,
  TITLE_CONCEPT_SCHEMA,
  TITLE_WRITING_ALL_STEP_KEYS,
  TITLE_WRITING_DEFAULT_EPISODE_COUNT,
  TITLE_WRITING_DEFAULT_EPISODE_SECONDS,
  TITLE_WRITING_EPISODE_COUNT,
  TITLE_WRITING_EPISODE_SECONDS_CHOICES,
  TITLE_WRITING_INPUT_SCHEMA,
  TITLE_WRITING_INPUT_SCHEMA_V2,
  TITLE_WRITING_JSON_SCHEMAS,
  TITLE_WRITING_MAX_EPISODES,
  TITLE_WRITING_MIN_EPISODES,
  TITLE_WRITING_PROMPT_VERSION,
  TITLE_WRITING_PROMPT_VERSION_V2,
  TITLE_WRITING_PROMPT_VERSION_V3,
  TITLE_WRITING_PROMPT_VERSION_V4,
  TITLE_WRITING_PROVIDER_KEYS,
  TITLE_WRITING_DEFAULT_MODELS,
  TITLE_WRITING_PROVIDER_PREFERENCE,
  anthropicKeyProblem,
  anthropicWorkspaceIdValid,
  deepseekKeyProblem,
  DEEPSEEK_API_KEY_MAX_LENGTH,
  DEEPSEEK_API_KEY_MIN_LENGTH,
  DEEPSEEK_PROVIDER_ADAPTER,
  frozenProviderAdapter,
  isLegacyDeepseekRun,
  TITLE_WRITING_V1_LEFT_OUT_PROVIDER_KEYS,
  ANTHROPIC_API_KEY_MAX_LENGTH,
  ANTHROPIC_WORKSPACE_ID_SHAPE,
  TITLE_WRITING_PROVIDER_LABELS,
  TITLE_WRITING_RETIRED_PROVIDER_KEYS,
  TITLE_WRITING_STORED_PROVIDER_KEYS,
  isActiveTitleWritingProvider,
  TITLE_WRITING_STEP_KEYS,
  TITLE_WRITING_TITLE_MAX_CHARS,
  episodeOutlineV2Schema,
  isTitleWritingInputV2,
  titleWritingCallCap,
  titleWritingCallCapFor,
  titleWritingEpisodeCount,
  titleWritingJsonSchemas,
  titleWritingRequiredCalls,
  titleWritingStepKeysFor,
  type EpisodeOutlineEpisode,
  type TitleWritingFrozenInputV1,
  type TitleWritingFrozenInputV2,
  episodeOutlineSchema,
  titleConceptSchema,
  titleWritingSettingsSchema,
  titleWritingStartSchema,
  titleWritingResumeSchema,
  currentUncertainCallIds,
  TITLE_WRITING_MAX_CONFIRMED_CALLS,
  type TitleWritingResume,
  type EpisodeOutline,
  type TitleConcept,
  type TitleWritingCallState,
  type TitleWritingCallView,
  type TitleWritingFrozenInput,
  type TitleWritingOptionsView,
  type TitleWritingProviderKey,
  type TitleWritingRetiredProviderKey,
  type TitleWritingV1LeftOutProviderKey,
  type TitleWritingStoredProviderKey,
  type TitleWritingProviderOption,
  type TitleWritingRunState,
  type TitleWritingRunView,
  type TitleWritingScriptSave,
  type TitleWritingSettings,
  type TitleWritingStart,
  type TitleWritingStepKey,
  type TitleWritingStepState,
  type TitleWritingStepView,
  type TitleWritingStorySave,
  type TitleWritingUsageView,
} from "./title-writing";
export {
  TITLE_WRITING_CANCELED_BEFORE_SEND,
  TITLE_WRITING_RUN_KIND_DISABLED,
  settledSaveOutcome,
  type TitleCallFinish,
  type TitleCallRecord,
  type TitleCallReservation,
  type TitleCallSubmission,
  type TitleResumePreparation,
  type TitleResumeRequest,
  type TitleRunBundle,
  type TitleRunCreation,
  type TitleRunCreationLimits,
  type TitleRunRecord,
  type TitleScriptPlacement,
  type TitleStepRecord,
  type TitleWritingStore,
  type TitleRunInput,
  type TitleRunKind,
  type ScriptBreakdownDetails,
  type ScriptBreakdownPlacement,
  type ScriptBreakdownPlacementOutcome,
  type ScriptBreakdownSourceRead,
} from "./title-writing-store";
export {
  CHARACTER_KEY,
  SCENE_KEY,
  SCRIPT_BREAKDOWN_CALL_CAP,
  SCRIPT_BREAKDOWN_INPUT_SCHEMA,
  SCRIPT_BREAKDOWN_LIMITS,
  SCRIPT_BREAKDOWN_OUTPUT_SCHEMA,
  SCRIPT_BREAKDOWN_PROMPT_VERSION,
  SCRIPT_BREAKDOWN_REQUIRED_CALLS,
  SCRIPT_BREAKDOWN_STEP_KEY,
  SHOT_KEY,
  isScriptBreakdownInput,
  scriptBreakdownJsonSchema,
  scriptBreakdownOutputSchema,
  scriptBreakdownPlaceSchema,
  scriptBreakdownStartSchema,
  type ScriptBreakdownCharacter,
  type ScriptBreakdownFrozenInput,
  type ScriptBreakdownOptionsView,
  type ScriptBreakdownOutput,
  type ScriptBreakdownRejection,
  type ScriptBreakdownRunView,
  type ScriptBreakdownSave,
  type ScriptBreakdownScene,
  type ScriptBreakdownSceneView,
  type ScriptBreakdownShot,
  type ScriptBreakdownStart,
} from "./script-breakdown";
export {
  WRITING_CANDIDATE_INPUT_SCHEMA,
  writingCandidateEpisodeRequestSchema,
  writingCandidateJsonSchema,
  writingCandidateStartSchema,
  writingCandidateStoryRequestSchema,
  type WritingCandidateCreation,
  type WritingCandidateEpisodeRequest,
  type WritingCandidateFinish,
  type WritingCandidateFrozenInput,
  type WritingCandidateMode,
  type WritingCandidateOptionsView,
  type WritingCandidateOutput,
  type WritingCandidateRecord,
  type WritingCandidateStart,
  type WritingCandidateState,
  type WritingCandidateStore,
  type WritingCandidateStoryRequest,
  type WritingCandidateView,
} from "./writing-candidate";
