import { z } from "zod";
import { CHARACTER_KEY, SCENE_KEY, SCRIPT_BREAKDOWN_LIMITS, scriptBreakdownOutputSchema } from "./script-breakdown";

/** Local, offline evaluation artifacts only. These schemas are not HTTP or database write contracts. */
export const VIMAX_EVALUATION_INPUT_SCHEMA = "ads.vimax-evaluation.input.v1" as const;
export const VIMAX_EVALUATION_SUPPLEMENTS_SCHEMA = "ads.vimax-evaluation.supplements.v1" as const;
export const VIMAX_EVALUATION_REPORT_SCHEMA = "ads.vimax-evaluation.report.v1" as const;
export const VIMAX_UPSTREAM_REVISION = "fd4b72e7731be6e5f88486206d25ea59849b0285" as const;
export const VIMAX_EVALUATION_LIMITS = { maxJsonBytes: 262_144, maxDepth: 16, maxNodes: 10_000, maxTextChars: 4_000 } as const;

const L = SCRIPT_BREAKDOWN_LIMITS;
const id = z.string().uuid();
const key = z.string().regex(CHARACTER_KEY);
const index = z.number().int().min(0).max(L.maxCharacters - 1);
const shotIndex = z.number().int().min(0).max(L.maxShotsPerScene - 1);
const offset = z.number().int().min(0).max(L.scriptMaxChars);
const text = (max: number, empty = false) => z.string().max(max)
  .refine((value) => empty || value.trim().length > 0, "empty_text")
  .refine((value) => !value.includes("\u0000"), "nul_text");
const rawText = () => text(VIMAX_EVALUATION_LIMITS.maxTextChars, true);

/** Offsets are UTF-16 code units, [start, end), matching JavaScript String.slice. */
export const vimaxEvaluationInputSchema = z.object({
  schema: z.literal(VIMAX_EVALUATION_INPUT_SCHEMA),
  upstreamRevision: z.literal(VIMAX_UPSTREAM_REVISION),
  sourceKind: z.enum(["synthetic", "redacted"]),
  writingMode: z.literal("short"),
  projectId: id,
  episodeId: id,
  episodeNo: z.number().int().min(1).max(6),
  scriptRevisionId: id,
  scriptContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  scriptText: text(L.scriptMaxChars),
  reviewStatus: z.literal("APPROVED"),
  isCurrent: z.literal(true),
  isStale: z.literal(false),
  sceneSpans: z.array(z.object({
    key: z.string().regex(SCENE_KEY), start: offset, end: offset,
    heading: text(L.headingMaxChars), timeOfDay: text(L.timeOfDayMaxChars, true), description: text(L.descriptionMaxChars),
  }).strict()).min(1).max(L.maxScenes),
  selectedSceneKeys: z.array(z.string().regex(SCENE_KEY)).length(1),
  characters: z.array(z.object({ key, characterId: id, revisionId: id, name: text(L.speakerMaxChars) }).strict()).max(L.maxCharacters),
  sourceDialogue: z.array(z.object({
    id: z.string().regex(/^D[1-9][0-9]{0,2}$/), start: offset, end: offset,
    speaker: text(L.speakerMaxChars), line: text(L.lineMaxChars), characterKey: key.nullable(),
  }).strict()).max(L.maxShotsPerScene * L.maxLinesPerShot),
  requirements: z.object({
    aspectRatio: z.literal("9:16"), targetSceneSeconds: z.number().int().min(2).max(L.maxShotsPerScene * L.maxShotSeconds),
    style: text(300),
  }).strict(),
}).strict();
export type VimaxEvaluationInput = z.infer<typeof vimaxEvaluationInputSchema>;

// Property names mirror the pinned upstream Pydantic artifacts; limits are local E1 admission bounds.
const character = z.object({
  idx: index, identifier_in_scene: text(120), is_visible: z.boolean(),
  static_features: rawText(), dynamic_features: rawText().nullable(),
}).strict();
const briefFields = {
  idx: shotIndex, is_last: z.boolean(), cam_idx: shotIndex, visual_desc: rawText(), audio_desc: rawText(),
};
const brief = z.object(briefFields).strict();
const detail = z.object({
  ...briefFields,
  variation_type: z.enum(["large", "medium", "small"]), variation_reason: rawText(),
  ff_desc: rawText(), ff_vis_char_idxs: z.array(index).max(L.maxCharacters),
  lf_desc: rawText(), lf_vis_char_idxs: z.array(index).max(L.maxCharacters), motion_desc: rawText(),
}).strict();
const camera = z.object({
  idx: shotIndex, active_shot_idxs: z.array(shotIndex).min(1).max(L.maxShotsPerScene),
  parent_cam_idx: shotIndex.nullable(), parent_shot_idx: shotIndex.nullable(),
  reason: rawText().nullable(), is_parent_fully_covers_child: z.boolean().nullable(), missing_info: rawText().nullable(),
}).strict();
export const vimaxPlanCandidateSchema = z.object({
  characters: z.array(character).max(L.maxCharacters),
  storyboard: z.array(brief).min(1).max(L.maxShotsPerScene),
  shot_descriptions: z.array(detail).min(1).max(L.maxShotsPerScene),
  camera_tree: z.array(camera).min(1).max(L.maxShotsPerScene),
}).strict();
export type VimaxPlanCandidate = z.infer<typeof vimaxPlanCandidateSchema>;

const shotFields = scriptBreakdownOutputSchema.shape.shots.element.shape;
/** Explicit human/fixture additions. ViMax free text is never parsed into these missing fields. */
export const vimaxEvaluationSupplementsSchema = z.object({
  schema: z.literal(VIMAX_EVALUATION_SUPPLEMENTS_SCHEMA),
  characters: z.array(z.object({ vimaxIndex: index, characterKey: key }).strict()).max(L.maxCharacters),
  shots: z.array(z.object({
    vimaxShotIndex: shotIndex,
    shotType: shotFields.shotType, camera: shotFields.camera, action: shotFields.action,
    plannedSeconds: shotFields.plannedSeconds, characterKeys: shotFields.characterKeys,
    dialogue: z.array(z.object({ sourceDialogueId: z.string().regex(/^D[1-9][0-9]{0,2}$/),
      speaker: text(L.speakerMaxChars), line: text(L.lineMaxChars), characterKey: key.nullable(),
    }).strict()).max(L.maxLinesPerShot),
  }).strict()).min(1).max(L.maxShotsPerScene),
}).strict();
export type VimaxEvaluationSupplements = z.infer<typeof vimaxEvaluationSupplementsSchema>;

/** The same report contract covers domain evaluation and the offline CLI's input/setup failures. */
export const VIMAX_EVALUATION_CODES = [
  "invalid_input", "invalid_candidate", "invalid_supplements", "input_too_large", "non_json_value",
  "source_hash_mismatch", "scene_scope_invalid", "source_format_unsupported", "source_dialogue_invalid",
  "duplicate_character", "character_mapping_invalid", "unknown_character", "shot_sequence_invalid",
  "shot_detail_mismatch", "camera_membership_invalid", "camera_reference_invalid", "camera_root_invalid", "camera_cycle",
  "supplement_mapping_invalid", "missing_duration", "dialogue_changed", "dialogue_coverage_invalid", "unsafe_content",
  "invalid_arguments", "fixture_not_file", "fixture_too_large", "invalid_fixture_json", "invalid_fixture_envelope",
  "offline_network_attempt", "evaluator_build_required", "fixture_not_found", "offline_evaluation_failed",
] as const;
export type VimaxEvaluationCode = (typeof VIMAX_EVALUATION_CODES)[number];
export interface VimaxEvaluationDiagnostic { code: VimaxEvaluationCode; path: string }
export interface VimaxEvaluationProvenance {
  upstreamRevision: typeof VIMAX_UPSTREAM_REVISION;
  inputHash: string;
  candidateHash: string | null;
  supplementsHash: string | null;
  projectId: string;
  episodeId: string;
  episodeNo: number;
  scriptRevisionId: string;
  scriptContentHash: string;
  selectedSceneKey: string;
}
export interface VimaxEvaluationReview {
  scene: VimaxEvaluationInput["sceneSpans"][number];
  sourceSceneText: string;
  requirements: VimaxEvaluationInput["requirements"];
  characters: Array<VimaxEvaluationInput["characters"][number] & { vimaxIndex: number }>;
  shots: VimaxEvaluationSupplements["shots"];
  plannedTotalSeconds: number;
  targetSceneSeconds: number;
  /** Reference generation order only; playback remains storyboard order. */
  cameraGenerationOrder: number[];
  candidate: VimaxPlanCandidate;
}
interface VimaxEvaluationReportBase {
  schema: typeof VIMAX_EVALUATION_REPORT_SCHEMA;
  writeAllowed: false;
  /** These are evaluation limits, not automatic approval or claims that prose was semantically validated. */
  gaps: readonly string[];
  provenance: VimaxEvaluationProvenance | null;
}
export type VimaxEvaluationReport = VimaxEvaluationReportBase & (
  | { status: "blocked"; diagnostics: VimaxEvaluationDiagnostic[]; review: null }
  | { status: "ready_for_review"; diagnostics: []; review: VimaxEvaluationReview }
);
