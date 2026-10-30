import { z } from "zod";
import {
  VIMAX_EVALUATION_CODES,
  VIMAX_UPSTREAM_REVISION,
  vimaxEvaluationInputSchema,
  vimaxEvaluationSupplementsSchema,
  vimaxPlanCandidateSchema,
} from "./vimax-evaluation";

export const VIMAX_PLATFORM_INPUT_SCHEMA = "ads.vimax-platform-input.v1" as const;
export const VIMAX_PLATFORM_SOURCE_SCHEMA = "ads.vimax-platform-source.v1" as const;
export const VIMAX_PLATFORM_PREVIEW_REQUEST_SCHEMA = "ads.vimax-platform-preview.request.v1" as const;
export const VIMAX_PLATFORM_PREVIEW_REPORT_SCHEMA = "ads.vimax-platform-preview.report.v1" as const;
export const VIMAX_PLATFORM_PREVIEW_RESPONSE_SCHEMA = "ads.vimax-platform-preview.response.v1" as const;
/** The entire imported envelope, aligned with the existing API's 300kb JSON body limit. */
export const VIMAX_PLATFORM_PREVIEW_MAX_BYTES = 300 * 1024;

const fields = vimaxEvaluationInputSchema.shape;
/** Server-built snapshot. Unlike E1 fixtures, workspace data is never labelled synthetic or redacted. */
export const vimaxPlatformInputSchema = vimaxEvaluationInputSchema.extend({
  schema: z.literal(VIMAX_PLATFORM_INPUT_SCHEMA),
  sourceKind: z.literal("workspace"),
}).strict();
export type VimaxPlatformInput = z.infer<typeof vimaxPlatformInputSchema>;

export const vimaxPlatformSourceSnapshotSchema = z.object({
  schema: z.literal(VIMAX_PLATFORM_SOURCE_SCHEMA),
  projectId: fields.projectId,
  episodeId: fields.episodeId,
  episodeNo: fields.episodeNo,
  scriptRevisionId: fields.scriptRevisionId,
  scriptRevisionNo: z.number().int().positive(),
  scriptText: fields.scriptText,
  scriptContentHash: fields.scriptContentHash,
  characters: fields.characters,
}).strict();
export type VimaxPlatformSourceSnapshot = z.infer<typeof vimaxPlatformSourceSnapshotSchema>;

/** No browser-supplied approval/current flags, workspace, project, episode number or script text are trusted. */
export const vimaxPlatformPreviewRequestSchema = z.object({
  schema: z.literal(VIMAX_PLATFORM_PREVIEW_REQUEST_SCHEMA),
  source: z.object({
    scriptRevisionId: fields.scriptRevisionId,
    scriptContentHash: fields.scriptContentHash,
    characters: fields.characters,
  }).strict(),
  sceneSpans: fields.sceneSpans,
  selectedSceneKeys: fields.selectedSceneKeys,
  sourceDialogue: fields.sourceDialogue,
  requirements: fields.requirements,
  candidate: vimaxPlanCandidateSchema,
  supplements: vimaxEvaluationSupplementsSchema,
}).strict();
export type VimaxPlatformPreviewRequest = z.infer<typeof vimaxPlatformPreviewRequestSchema>;

const provenanceSchema = z.object({
  upstreamRevision: z.literal(VIMAX_UPSTREAM_REVISION),
  inputHash: fields.scriptContentHash,
  candidateHash: fields.scriptContentHash.nullable(),
  supplementsHash: fields.scriptContentHash.nullable(),
  projectId: fields.projectId,
  episodeId: fields.episodeId,
  episodeNo: fields.episodeNo,
  scriptRevisionId: fields.scriptRevisionId,
  scriptContentHash: fields.scriptContentHash,
  selectedSceneKey: z.string().regex(/^S[1-8]$/),
}).strict();
const reviewSchema = z.object({
  scene: fields.sceneSpans.element,
  sourceSceneText: fields.scriptText,
  requirements: fields.requirements,
  characters: z.array(fields.characters.element.extend({ vimaxIndex: z.number().int().min(0).max(29) }).strict()).max(30),
  shots: vimaxEvaluationSupplementsSchema.shape.shots,
  plannedTotalSeconds: z.number().int().min(2).max(80),
  targetSceneSeconds: fields.requirements.shape.targetSceneSeconds,
  cameraGenerationOrder: z.array(z.number().int().min(0).max(7)).min(1).max(8),
  candidate: vimaxPlanCandidateSchema,
}).strict();
const base = {
  schema: z.literal(VIMAX_PLATFORM_PREVIEW_REPORT_SCHEMA),
  writeAllowed: z.literal(false),
  gaps: z.array(z.string().min(1).max(100)).max(10),
  provenance: provenanceSchema.nullable(),
};
export const vimaxPlatformPreviewReportSchema = z.discriminatedUnion("status", [
  z.object({ ...base, status: z.literal("blocked"),
    diagnostics: z.array(z.object({ code: z.enum(VIMAX_EVALUATION_CODES), path: z.string().max(300) }).strict()).min(1).max(20),
    review: z.null(),
  }).strict(),
  z.object({ ...base, status: z.literal("ready_for_review"), diagnostics: z.tuple([]), review: reviewSchema }).strict(),
]);
export type VimaxPlatformPreviewReport = z.infer<typeof vimaxPlatformPreviewReportSchema>;
export const vimaxPlatformPreviewResponseSchema = z.object({
  schema: z.literal(VIMAX_PLATFORM_PREVIEW_RESPONSE_SCHEMA),
  source: vimaxPlatformSourceSnapshotSchema,
  report: vimaxPlatformPreviewReportSchema,
  verifiedAt: z.string().datetime(),
  modelCalls: z.literal(0),
  persisted: z.literal(false),
}).strict();
export type VimaxPlatformPreviewResponse = z.infer<typeof vimaxPlatformPreviewResponseSchema>;
