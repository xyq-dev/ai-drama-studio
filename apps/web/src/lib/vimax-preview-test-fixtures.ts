// Synthetic test-only data. This module is never imported by the application.
import fixture from "../../../../scripts/vimax-evaluation/fixtures/single-scene.json";
import {
  VIMAX_PLATFORM_PREVIEW_REQUEST_SCHEMA,
  VIMAX_PLATFORM_PREVIEW_REPORT_SCHEMA,
  VIMAX_PLATFORM_PREVIEW_RESPONSE_SCHEMA,
  VIMAX_PLATFORM_SOURCE_SCHEMA,
  VIMAX_UPSTREAM_REVISION,
  vimaxPlatformPreviewRequestSchema,
  vimaxPlatformPreviewResponseSchema,
  vimaxPlatformSourceSnapshotSchema,
} from "@ai-drama/contracts";

export function vimaxPreviewFixture() {
  const value = structuredClone(fixture);
  const { input } = value;
  const source = vimaxPlatformSourceSnapshotSchema.parse({
    schema: VIMAX_PLATFORM_SOURCE_SCHEMA, projectId: input.projectId, episodeId: input.episodeId,
    episodeNo: input.episodeNo, scriptRevisionId: input.scriptRevisionId, scriptRevisionNo: 2,
    scriptText: input.scriptText, scriptContentHash: input.scriptContentHash, characters: input.characters,
  });
  const request = vimaxPlatformPreviewRequestSchema.parse({
    schema: VIMAX_PLATFORM_PREVIEW_REQUEST_SCHEMA,
    source: { scriptRevisionId: source.scriptRevisionId, scriptContentHash: source.scriptContentHash, characters: source.characters },
    sceneSpans: input.sceneSpans, selectedSceneKeys: input.selectedSceneKeys, sourceDialogue: input.sourceDialogue,
    requirements: input.requirements, candidate: value.candidate, supplements: value.supplements,
  });
  const scene = request.sceneSpans[0]!;
  const response = vimaxPlatformPreviewResponseSchema.parse({
    schema: VIMAX_PLATFORM_PREVIEW_RESPONSE_SCHEMA, source, verifiedAt: "2026-10-31T00:00:00.000Z", modelCalls: 0, persisted: false,
    report: { schema: VIMAX_PLATFORM_PREVIEW_REPORT_SCHEMA, status: "ready_for_review", writeAllowed: false,
      gaps: ["semantic_review_required", "single_scene_write_not_implemented", "planned_duration_not_measured"], diagnostics: [],
      provenance: { upstreamRevision: VIMAX_UPSTREAM_REVISION, inputHash: "a".repeat(64), candidateHash: "b".repeat(64), supplementsHash: "c".repeat(64),
        projectId: source.projectId, episodeId: source.episodeId, episodeNo: source.episodeNo, scriptRevisionId: source.scriptRevisionId,
        scriptContentHash: source.scriptContentHash, selectedSceneKey: request.selectedSceneKeys[0] },
      review: { scene, sourceSceneText: source.scriptText.slice(scene.start, scene.end), requirements: request.requirements,
        characters: request.supplements.characters.map((mapping) => ({ ...source.characters.find((character) => character.key === mapping.characterKey)!, vimaxIndex: mapping.vimaxIndex })),
        shots: request.supplements.shots, plannedTotalSeconds: request.supplements.shots.reduce((total, shot) => total + shot.plannedSeconds, 0),
        targetSceneSeconds: request.requirements.targetSceneSeconds, cameraGenerationOrder: [0, 1], candidate: request.candidate },
    },
  });
  return { source, request, response };
}
