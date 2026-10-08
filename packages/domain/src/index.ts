import { DomainError } from "./errors";

export { DomainError };

export const GENERATION_JOB_STATES = [
  "PENDING",
  "QUEUED",
  "RUNNING",
  "WAITING_EXTERNAL",
  "SUCCEEDED",
  "FAILED",
  "CANCELED",
] as const;
export type GenerationJobState = (typeof GENERATION_JOB_STATES)[number];

export const WORKFLOW_RUN_STATES = [
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "PARTIAL_FAILED",
  "FAILED",
  "CANCELED",
] as const;
export type WorkflowRunState = (typeof WORKFLOW_RUN_STATES)[number];

const transitions: Readonly<Record<GenerationJobState, readonly GenerationJobState[]>> = {
  PENDING: ["QUEUED", "CANCELED"],
  QUEUED: ["RUNNING", "CANCELED"],
  RUNNING: ["WAITING_EXTERNAL", "SUCCEEDED", "QUEUED", "FAILED", "CANCELED"],
  WAITING_EXTERNAL: ["RUNNING", "QUEUED", "SUCCEEDED", "FAILED", "CANCELED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELED: [],
};

export function canTransitionJob(from: GenerationJobState, to: GenerationJobState): boolean {
  return transitions[from].includes(to);
}

export function assertJobTransition(from: GenerationJobState, to: GenerationJobState): void {
  if (!canTransitionJob(from, to)) {
    throw new DomainError("JOB_INVALID_TRANSITION", `Generation job cannot transition from ${from} to ${to}`);
  }
}

export interface WorkflowJobSummary {
  state: GenerationJobState;
  isCritical: boolean;
}

export function deriveWorkflowRunState(jobs: readonly WorkflowJobSummary[]): WorkflowRunState {
  if (jobs.length === 0 || jobs.every(({ state }) => state === "PENDING")) {
    return "PENDING";
  }

  const terminal = new Set<GenerationJobState>(["SUCCEEDED", "FAILED", "CANCELED"]);
  if (jobs.some(({ state }) => !terminal.has(state))) {
    return "RUNNING";
  }

  const hasFailure = jobs.some(({ state }) => state === "FAILED");
  const hasCancellation = jobs.some(({ state }) => state === "CANCELED");
  if (hasCancellation && !hasFailure) {
    return "CANCELED";
  }
  if (jobs.some(({ state, isCritical }) => isCritical && state === "FAILED")) {
    return "FAILED";
  }
  if (hasFailure || hasCancellation) {
    return "PARTIAL_FAILED";
  }
  return "SUCCEEDED";
}

export {
  COMPOSE_PREFLIGHT_SCHEMA,
  COMPOSE_VIDEO_DURATION_MAX_MS,
  buildComposePreflight,
  parseComposePreflightRequest,
  type ComposeAssetFacts,
  type ComposeAttemptFacts,
  type ComposeJobFacts,
  type ComposePreflightResponse,
  type ComposePreflightRole,
  type ComposePreflightSelection,
} from "./compose-preflight";
export {
  EPISODE_COMPOSE_ASSET_SCHEMA,
  EPISODE_COMPOSE_MAX_DURATION_MS,
  EPISODE_COMPOSE_MAX_SEGMENTS,
  EPISODE_COMPOSE_MIN_SEGMENTS,
  EPISODE_COMPOSE_PREFLIGHT_SCHEMA,
  EPISODE_COMPOSE_SHORT_NOTICE,
  EPISODE_COMPOSE_STATUS_NOTE,
  EPISODE_COMPOSE_TARGET_MIN_MS,
  assertEpisodeCompositeEligible,
  buildEpisodeComposePreflight,
  parseEpisodeComposePreflightRequest,
  type EpisodeComposeAttemptFacts,
  type EpisodeComposeJobFacts,
  type EpisodeComposePreflightRequest,
  type EpisodeComposePreflightResponse,
  type EpisodeComposeSegment,
  type EpisodeCompositeFacts,
} from "./episode-compose-preflight";
export {
  PROJECT_COST_SUMMARY_SCHEMA,
  LOCAL_COMPOSE_JOB_SCHEMAS,
  assertLedgerAmount,
  addLedgerAmounts,
  summarizeRecordedLedger,
  buildProjectCostSummary,
  type RecordedLedgerFact,
  type ProjectCostCoverage,
  type ProjectCostCurrency,
  type ProjectCostSummary,
} from "./project-cost-summary";
export {
  EPISODE_EXPORT_MANIFEST_SCHEMA,
  assertDependencyEdges,
  assertEpisodeExportRecord,
  buildEpisodeExportManifest,
  episodeExportFilenameStem,
  mediaFromFrozenShot,
  type EpisodeExportAttemptFacts,
  type EpisodeExportAssetFacts,
  type EpisodeExportCore,
  type EpisodeExportFacts,
  type EpisodeExportJobFacts,
  type EpisodeExportMedia,
  type EpisodeExportSegment,
  type FrozenShotMediaInput,
} from "./episode-export";
export {
  EPISODE_COMPOSE_JOB_SCHEMA,
  EPISODE_COMPOSE_OUTPUT_SCHEMA,
  EPISODE_RENDER_PROFILE,
  EPISODE_RENDER_PROFILE_ID,
  buildEpisodeComposeJobSnapshot,
  parseEpisodeComposeRenderRequest,
  type EpisodeComposeJobSnapshot,
  type EpisodeComposeRenderRequest,
  type EpisodeComposeSourceObject,
} from "./episode-compose-render";
export {
  COMPOSE_JOB_SCHEMA,
  COMPOSE_OUTPUT_MAX_BYTES,
  COMPOSE_RENDER_PROFILE,
  COMPOSE_RENDER_PROFILE_ID,
  assertExpectedPreflightHash,
  buildComposeJobSnapshot,
  parseComposeRenderRequest,
  parseComposeReviewRequest,
  type ComposeJobSnapshot,
  type ComposeRenderRequest,
  type ComposeSourceObject,
} from "./compose-render";
export {
  EPISODE_DRAFT_SCHEMA,
  STORY_PLAN_SCHEMA,
  WRITING_BODY_MAX_CHARS,
  WRITING_IMPORT_MAX_BYTES,
  WRITING_PROMPT_VERSION,
  buildEpisodeDraftInstruction,
  buildStoryPlanInstruction,
  canAdopt,
  formatEpisodeDraft,
  formatStoryPlan,
  formatWritingImport,
  freezeWritingContext,
  parseWritingImport,
  writingInputFingerprint,
  type EpisodeDraftRequest,
  type FrozenWritingContext,
  type StoryPlanRequest,
  type WritingImport,
  type WritingTargetSnapshot,
} from "./writing-assistant";
export {
  characterReferenceAllowed,
  classifyGenerationAction,
  regenerationSeed,
  storyboardPreviewAllowed,
  videoGenerationAllowed,
  type CharacterReferenceGate,
  type GenerationAction,
  type VideoGenerationGate,
} from "./media-gates";
export {
  CHARACTER_REFERENCE_JOB_KIND,
  CHARACTER_REFERENCE_ROLE,
  CHARACTER_REFERENCE_SNAPSHOT_SCHEMA,
  parseCharacterReferenceGateMode,
  parseCharacterReferenceReviewRequest,
  parseCharacterReferenceSelectionRequest,
  parseCharacterReferenceSnapshot,
  selectedReferenceUsable,
  type CharacterReferenceGateMode,
  type CharacterReferenceReviewRequest,
  type CharacterReferenceSelectionRequest,
  type CharacterReferenceSnapshot,
  type SelectedReferenceState,
} from "./character-reference";
export {
  MAX_MANUAL_MEDIA_RETRIES,
  MEDIA_RETRY_JOB_KINDS,
  RETRYABLE_MEDIA_ERROR_CODES,
  isMediaRetryJobKind,
  mediaRetryDecision,
  type MediaRetryDecision,
  type MediaRetryJobKind,
  type MediaRetryRejection,
} from "./media-retry";
export {
  presentStoredAttempt,
  type PresentedAttempt,
  type StoredAttemptView,
} from "./attempt-presentation";
export {
  FRESHNESS_STATUSES,
  PRODUCTION_EPISODE_NUMBERS,
  REVIEW_STATUSES,
  assertProductionEpisodeSet,
  assertReviewTransition,
  canonicalInputHash,
  canonicalJson,
  type FreshnessStatus,
  type ReviewStatus,
} from "./text-chain";
export {
  TITLE_WRITING_SYSTEM_PROMPT,
  buildTitleWritingPrompt,
  episodeNoOf,
  formatTitleEpisode,
  formatTitleStory,
  screenplayCharTarget,
  validateTitleWritingOutput,
  type TitleWritingContext,
  type TitleWritingPrompt,
  type TitleWritingSchemaKind,
  type TitleWritingValidation,
} from "./title-writing";
