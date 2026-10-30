// Synthetic test fixtures only; never imported by application code.
import {
  VIMAX_CANDIDATE_CREATE_SCHEMA,
  VIMAX_CANDIDATE_FROZEN_SCHEMA,
  VIMAX_CANDIDATE_RECEIPT_SCHEMA,
  VIMAX_CANDIDATE_VIEW_SCHEMA,
  vimaxCandidateCreateSchema,
  vimaxCandidateFrozenSchema,
  vimaxCandidatePageSchema,
  vimaxCandidateReceiptSchema,
  vimaxCandidateTargetsSchema,
  vimaxCandidateViewSchema,
} from "@ai-drama/contracts";
import { vimaxPreviewFixture } from "./vimax-preview-test-fixtures";

export function vimaxCandidateFixture() {
  const { source, request, response: previewResponse } = vimaxPreviewFixture();
  if (previewResponse.report.status !== "ready_for_review") throw new Error("fixture must be ready");
  const candidateId = "a0000000-0000-4000-8000-000000000001";
  const createKey = "a0000000-0000-4000-8000-000000000002";
  const sceneKey = "a0000000-0000-4000-8000-000000000003";
  const shotsKey = "a0000000-0000-4000-8000-000000000004";
  const target = {
    sceneId: "a0000000-0000-4000-8000-000000000005",
    sceneRevisionId: "a0000000-0000-4000-8000-000000000006",
    rowVersion: 5, sourceScriptRevisionId: source.scriptRevisionId, ordinal: 1,
    heading: request.sceneSpans[0]!.heading, timeOfDay: request.sceneSpans[0]!.timeOfDay,
    summary: request.sceneSpans[0]!.description, locationRevisionId: null,
  };
  const create = vimaxCandidateCreateSchema.parse({ schema: VIMAX_CANDIDATE_CREATE_SCHEMA,
    target: { sceneId: target.sceneId, sceneRevisionId: target.sceneRevisionId, rowVersion: target.rowVersion }, request });
  const frozen = vimaxCandidateFrozenSchema.parse({ schema: VIMAX_CANDIDATE_FROZEN_SCHEMA,
    source, target, request, evaluation: previewResponse.report });
  const currentScene = { sceneId: target.sceneId, rowVersion: 5, currentRevisionId: target.sceneRevisionId,
    approvedRevisionId: target.sceneRevisionId, reviewStatus: "APPROVED", freshnessStatus: "CURRENT", archived: false, activeShotCount: 0 };
  const stored = vimaxCandidateViewSchema.parse({ schema: VIMAX_CANDIDATE_VIEW_SCHEMA, candidateId,
    projectId: source.projectId, episodeId: source.episodeId, state: "stored", rowVersion: 1,
    requestKey: createKey, requestHash: "d".repeat(64), frozenHash: "e".repeat(64),
    createdAt: "2026-10-31T00:00:00.000Z", updatedAt: "2026-10-31T00:00:00.000Z", frozen,
    sceneReceipt: null, shotsReceipt: null,
    eligibility: { canSaveScene: true, canPlaceShots: false, reasons: [], currentScene },
  });
  const savedSceneRevisionId = "a0000000-0000-4000-8000-000000000007";
  const sceneReceipt = vimaxCandidateReceiptSchema.options[0].parse({ schema: VIMAX_CANDIDATE_RECEIPT_SCHEMA,
    candidateId, projectId: source.projectId, episodeId: source.episodeId, operation: "save_scene", state: "scene_saved",
    idempotencyKey: sceneKey, requestHash: "f".repeat(64), rowVersion: 2,
    sceneId: target.sceneId, sceneRevisionId: savedSceneRevisionId, savedAt: "2026-10-31T00:01:00.000Z", shots: [],
  });
  const sceneSaved = vimaxCandidateViewSchema.parse({ ...stored, state: "scene_saved", rowVersion: 2,
    updatedAt: sceneReceipt.savedAt, sceneReceipt,
    eligibility: { canSaveScene: false, canPlaceShots: false, reasons: ["awaiting_scene_approval"],
      currentScene: { ...currentScene, rowVersion: 6, currentRevisionId: savedSceneRevisionId,
        reviewStatus: "DRAFT", approvedRevisionId: target.sceneRevisionId } },
  });
  const approved = vimaxCandidateViewSchema.parse({ ...sceneSaved,
    eligibility: { canSaveScene: false, canPlaceShots: true, reasons: [],
      currentScene: { ...sceneSaved.eligibility.currentScene, rowVersion: 8, reviewStatus: "APPROVED", approvedRevisionId: savedSceneRevisionId } },
  });
  const shotsReceipt = vimaxCandidateReceiptSchema.options[1].parse({ schema: VIMAX_CANDIDATE_RECEIPT_SCHEMA,
    candidateId, projectId: source.projectId, episodeId: source.episodeId, operation: "place_shots", state: "shots_saved",
    idempotencyKey: shotsKey, requestHash: "a".repeat(64), rowVersion: 3,
    sceneId: target.sceneId, sceneRevisionId: savedSceneRevisionId, savedAt: "2026-10-31T00:02:00.000Z",
    shots: request.supplements.shots.map((_, index) => ({ index,
      shotId: `b0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      shotRevisionId: `c0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    })),
  });
  const shotsSaved = vimaxCandidateViewSchema.parse({ ...approved, state: "shots_saved", rowVersion: 3,
    updatedAt: shotsReceipt.savedAt, shotsReceipt,
    eligibility: { canSaveScene: false, canPlaceShots: false, reasons: ["already_saved"],
      currentScene: { ...approved.eligibility.currentScene, rowVersion: 11, activeShotCount: shotsReceipt.shots.length } },
  });
  const targets = vimaxCandidateTargetsSchema.parse({ schema: "ads.vimax-candidate.targets.v1", source,
    targets: [{ ...target, activeShotCount: 0, eligible: true, reasons: [] }] });
  const page = vimaxCandidatePageSchema.parse({ schema: "ads.vimax-candidate.page.v1", items: [stored], nextCursor: null });
  return { source, request, previewResponse, candidateId, createKey, sceneKey, shotsKey, target, create,
    stored, sceneSaved, approved, shotsSaved, targets, page, sceneReceipt, shotsReceipt };
}
