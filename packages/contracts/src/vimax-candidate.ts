import { z } from "zod";
import { vimaxPlatformPreviewReportSchema, vimaxPlatformPreviewRequestSchema, vimaxPlatformSourceSnapshotSchema } from "./vimax-platform-preview";

export const VIMAX_CANDIDATE_CREATE_SCHEMA = "ads.vimax-candidate.create.v1" as const;
export const VIMAX_CANDIDATE_FROZEN_SCHEMA = "ads.vimax-candidate.frozen.v1" as const;
export const VIMAX_CANDIDATE_VIEW_SCHEMA = "ads.vimax-candidate.view.v1" as const;
export const VIMAX_CANDIDATE_RECEIPT_SCHEMA = "ads.vimax-candidate.receipt.v1" as const;
export const VIMAX_CANDIDATE_SAVE_SCENE_SCHEMA = "ads.vimax-candidate.save-scene.v1" as const;
export const VIMAX_CANDIDATE_PLACE_SHOTS_SCHEMA = "ads.vimax-candidate.place-shots.v1" as const;
export const VIMAX_CANDIDATE_SQL_DRAFT = "20261031000100_vimax_storyboard_candidate" as const;
const id = z.string().uuid();
const version = z.number().int().min(1).max(2_147_483_647);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().min(1).max(200);
const timestamp = z.string().datetime();

export const VIMAX_CANDIDATE_BLOCKERS = [
  "source_changed", "source_unavailable", "target_changed", "target_has_shots", "awaiting_scene_save",
  "awaiting_scene_approval", "active_breakdown", "stale_propagation_pending", "already_saved",
] as const;
export type VimaxCandidateBlocker = (typeof VIMAX_CANDIDATE_BLOCKERS)[number];

export const vimaxCandidateTargetSchema = z.object({
  sceneId: id, sceneRevisionId: id, rowVersion: version,
  sourceScriptRevisionId: id, ordinal: version,
  heading: z.string().min(1).max(400), timeOfDay: z.string().max(100).nullable(),
  summary: z.string().max(4000), locationRevisionId: id.nullable(),
}).strict();
export type VimaxCandidateTarget = z.infer<typeof vimaxCandidateTargetSchema>;
export const vimaxCandidateCreateSchema = z.object({
  schema: z.literal(VIMAX_CANDIDATE_CREATE_SCHEMA),
  target: vimaxCandidateTargetSchema.pick({ sceneId: true, sceneRevisionId: true, rowVersion: true }),
  request: vimaxPlatformPreviewRequestSchema,
}).strict();
export type VimaxCandidateCreate = z.infer<typeof vimaxCandidateCreateSchema>;

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export const vimaxCandidateFrozenSchema = z.object({
  schema: z.literal(VIMAX_CANDIDATE_FROZEN_SCHEMA),
  source: vimaxPlatformSourceSnapshotSchema,
  target: vimaxCandidateTargetSchema,
  request: vimaxPlatformPreviewRequestSchema,
  evaluation: vimaxPlatformPreviewReportSchema.options[1].extend({
    provenance: vimaxPlatformPreviewReportSchema.options[1].shape.provenance.unwrap(),
  }),
}).strict().superRefine((frozen, context) => {
  const source = frozen.source;
  const provenance = frozen.evaluation.provenance;
  const selected = frozen.request.sceneSpans.find((scene) => scene.key === frozen.request.selectedSceneKeys[0]);
  if (provenance.projectId !== source.projectId || provenance.episodeId !== source.episodeId
    || provenance.episodeNo !== source.episodeNo || provenance.scriptRevisionId !== source.scriptRevisionId
    || provenance.scriptContentHash !== source.scriptContentHash || provenance.selectedSceneKey !== selected?.key
    || frozen.target.sourceScriptRevisionId !== source.scriptRevisionId
    || frozen.request.source.scriptRevisionId !== source.scriptRevisionId || frozen.request.source.scriptContentHash !== source.scriptContentHash
    || !same(frozen.request.source.characters, source.characters)
    || !same(frozen.evaluation.review.scene, selected)
    || frozen.evaluation.review.sourceSceneText !== source.scriptText.slice(selected?.start, selected?.end)
    || !same(frozen.evaluation.review.requirements, frozen.request.requirements)
    || !same(frozen.evaluation.review.shots, frozen.request.supplements.shots)
    || !same(frozen.evaluation.review.candidate, frozen.request.candidate)) {
    context.addIssue({ code: "custom", message: "frozen_source_or_plan_mismatch" });
  }
});
export type VimaxCandidateFrozen = z.infer<typeof vimaxCandidateFrozenSchema>;

export const vimaxCandidateSaveSceneSchema = z.object({
  schema: z.literal(VIMAX_CANDIDATE_SAVE_SCENE_SCHEMA), expectedVersion: version, confirmedReview: z.literal(true),
}).strict();
export const vimaxCandidatePlaceShotsSchema = z.object({
  schema: z.literal(VIMAX_CANDIDATE_PLACE_SHOTS_SCHEMA), expectedVersion: version, confirmedReview: z.literal(true),
}).strict();
export type VimaxCandidateSaveScene = z.infer<typeof vimaxCandidateSaveSceneSchema>;
export type VimaxCandidatePlaceShots = z.infer<typeof vimaxCandidatePlaceShotsSchema>;

export const vimaxCandidateShotLinkSchema = z.object({
  index: z.number().int().min(0).max(7), shotId: id, shotRevisionId: id,
}).strict();
const receipt = {
  schema: z.literal(VIMAX_CANDIDATE_RECEIPT_SCHEMA), candidateId: id, projectId: id, episodeId: id,
  idempotencyKey: key, requestHash: hash, rowVersion: version,
  sceneId: id, sceneRevisionId: id, savedAt: timestamp,
};
export const vimaxCandidateReceiptSchema = z.discriminatedUnion("operation", [
  z.object({ ...receipt, operation: z.literal("save_scene"), state: z.literal("scene_saved"), rowVersion: z.literal(2), shots: z.tuple([]) }).strict(),
  z.object({ ...receipt, operation: z.literal("place_shots"), state: z.literal("shots_saved"), rowVersion: z.literal(3),
    shots: z.array(vimaxCandidateShotLinkSchema).min(1).max(8),
  }).strict(),
]);
export type VimaxCandidateReceipt = z.infer<typeof vimaxCandidateReceiptSchema>;

export const vimaxCandidateCurrentSceneSchema = z.object({
  sceneId: id, rowVersion: version, currentRevisionId: id.nullable(), approvedRevisionId: id.nullable(),
  reviewStatus: z.string().max(30).nullable(), freshnessStatus: z.string().max(30).nullable(),
  archived: z.boolean(), activeShotCount: z.number().int().min(0),
}).strict();
export const vimaxCandidateViewSchema = z.object({
  schema: z.literal(VIMAX_CANDIDATE_VIEW_SCHEMA), candidateId: id, projectId: id, episodeId: id,
  state: z.enum(["stored", "scene_saved", "shots_saved"]), rowVersion: version,
  requestKey: key, requestHash: hash, frozenHash: hash,
  createdAt: timestamp, updatedAt: timestamp,
  frozen: vimaxCandidateFrozenSchema,
  sceneReceipt: vimaxCandidateReceiptSchema.options[0].nullable(),
  shotsReceipt: vimaxCandidateReceiptSchema.options[1].nullable(),
  eligibility: z.object({
    canSaveScene: z.boolean(), canPlaceShots: z.boolean(),
    reasons: z.array(z.enum(VIMAX_CANDIDATE_BLOCKERS)).max(12),
    currentScene: vimaxCandidateCurrentSceneSchema.nullable(),
  }).strict(),
}).strict().superRefine((view, context) => {
  const issue = () => context.addIssue({ code: "custom", message: "candidate_view_lineage_or_state_mismatch" });
  if (view.frozen.source.projectId !== view.projectId || view.frozen.source.episodeId !== view.episodeId) issue();
  const expectedVersion = view.state === "stored" ? 1 : view.state === "scene_saved" ? 2 : 3;
  if (view.rowVersion !== expectedVersion || (view.sceneReceipt !== null) !== (view.state !== "stored")
    || (view.shotsReceipt !== null) !== (view.state === "shots_saved")) issue();
  for (const receipt of [view.sceneReceipt, view.shotsReceipt]) {
    if (receipt && (receipt.candidateId !== view.candidateId || receipt.projectId !== view.projectId
      || receipt.episodeId !== view.episodeId || receipt.sceneId !== view.frozen.target.sceneId)) issue();
  }
  const shots = view.shotsReceipt?.shots;
  if (shots && (view.shotsReceipt!.sceneRevisionId !== view.sceneReceipt?.sceneRevisionId
    || shots.length !== view.frozen.request.supplements.shots.length
    || shots.some((shot, index) => shot.index !== index)
    || new Set(shots.map((shot) => shot.shotId)).size !== shots.length
    || new Set(shots.map((shot) => shot.shotRevisionId)).size !== shots.length)) issue();
  if (view.eligibility.currentScene && view.eligibility.currentScene.sceneId !== view.frozen.target.sceneId) issue();
  if (view.eligibility.canSaveScene && (view.state !== "stored" || view.eligibility.reasons.length > 0)) issue();
  if (view.eligibility.canPlaceShots && (view.state !== "scene_saved" || view.eligibility.reasons.length > 0)) issue();
});
export type VimaxCandidateView = z.infer<typeof vimaxCandidateViewSchema>;

export const vimaxCandidateTargetsSchema = z.object({
  schema: z.literal("ads.vimax-candidate.targets.v1"), source: vimaxPlatformSourceSnapshotSchema,
  targets: z.array(vimaxCandidateTargetSchema.extend({
    activeShotCount: z.number().int().min(0), eligible: z.boolean(), reasons: z.array(z.enum(VIMAX_CANDIDATE_BLOCKERS)).max(12),
  }).strict()).max(100),
}).strict();
export type VimaxCandidateTargets = z.infer<typeof vimaxCandidateTargetsSchema>;
export const vimaxCandidatePageSchema = z.object({
  schema: z.literal("ads.vimax-candidate.page.v1"), items: z.array(vimaxCandidateViewSchema).max(20), nextCursor: z.string().max(1000).nullable(),
}).strict();
export type VimaxCandidatePage = z.infer<typeof vimaxCandidatePageSchema>;
export const vimaxCandidateCreateResponseSchema = z.object({
  schema: z.literal("ads.vimax-candidate.create-response.v1"), replayed: z.boolean(), candidate: vimaxCandidateViewSchema,
}).strict();
export type VimaxCandidateCreateResponse = z.infer<typeof vimaxCandidateCreateResponseSchema>;
export const vimaxCandidateWriteResponseSchema = z.object({
  schema: z.literal("ads.vimax-candidate.write-response.v1"), replayed: z.boolean(), receipt: vimaxCandidateReceiptSchema,
}).strict();
export type VimaxCandidateWriteResponse = z.infer<typeof vimaxCandidateWriteResponseSchema>;
