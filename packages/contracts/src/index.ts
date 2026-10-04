import { z } from "zod";

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

const sceneSourceSchema = z.object({
  episodeId: z.string().uuid(), episodeNo: z.number().int().min(1).max(3),
  episodeVersion: z.number().int().positive(), scriptRevisionId: z.string().uuid(),
  scriptContent: z.unknown(),
}).strict();
const shotSourceSchema = z.object({
  episodeId: z.string().uuid(), episodeNo: z.number().int().min(1).max(3),
  sceneId: z.string().uuid(), sceneVersion: z.number().int().positive(),
  sceneRevisionId: z.string().uuid(),
  sceneContent: z.object({ heading: z.string(), timeOfDay: z.string().nullable(), summary: z.string() }).strict(),
}).strict();

export const textGenerationRequestSchema = z.discriminatedUnion("kind", [
  z.object({ schema: z.literal("m2.text.request.v1"), kind: z.literal("SCENES"),
    projectId: z.string().uuid(), sources: z.array(sceneSourceSchema).length(3) }).strict(),
  z.object({ schema: z.literal("m2.text.request.v1"), kind: z.literal("SHOTS"),
    projectId: z.string().uuid(), sources: z.array(shotSourceSchema).length(3) }).strict(),
]);
export type TextGenerationRequest = z.infer<typeof textGenerationRequestSchema>;

export const sceneBatchOutputSchema = z.object({
  schema: z.literal("m2.text.scenes.output.v1"),
  scenes: z.array(z.object({
    projectId: z.string().uuid(), episodeId: z.string().uuid(), episodeNo: z.number().int().min(1).max(3),
    sourceScriptRevisionId: z.string().uuid(), ordinal: z.number().int().positive(),
    heading: z.string().min(1).max(400), timeOfDay: z.string().max(100).nullable().optional(),
    summary: z.string().max(4000),
  }).strict()).length(3),
}).strict();
export type SceneBatchOutput = z.infer<typeof sceneBatchOutputSchema>;

export const shotBatchOutputSchema = z.object({
  schema: z.literal("m2.text.shots.output.v1"),
  shots: z.array(z.object({
    projectId: z.string().uuid(), episodeId: z.string().uuid(), episodeNo: z.number().int().min(1).max(3),
    sceneId: z.string().uuid(), sourceSceneRevisionId: z.string().uuid(), ordinal: z.number().int().positive(),
    shotType: z.string().min(1).max(100), camera: z.string().max(1000), action: z.string().max(4000),
    dialogue: z.string().max(4000).nullable().optional(), durationHint: z.string().max(200).nullable().optional(),
    promptText: z.string().max(8000),
  }).strict()).length(3),
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
