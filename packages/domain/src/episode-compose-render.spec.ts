import { describe, expect, it } from "vitest";
import { COMPOSE_JOB_SCHEMA, COMPOSE_RENDER_PROFILE } from "./compose-render";
import { EPISODE_COMPOSE_ASSET_SCHEMA, buildEpisodeComposePreflight, type EpisodeCompositeFacts } from "./episode-compose-preflight";
import {
  EPISODE_COMPOSE_JOB_SCHEMA,
  EPISODE_COMPOSE_OUTPUT_SCHEMA,
  EPISODE_RENDER_PROFILE,
  buildEpisodeComposeJobSnapshot,
  parseEpisodeComposeRenderRequest,
} from "./episode-compose-render";
import { canonicalInputHash } from "./text-chain";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const episodeId = "33333333-3333-4333-8333-333333333333";

function facts(index: number, durationMs = 1000): EpisodeCompositeFacts {
  const assetId = `4444444${index}-4444-4444-8444-444444444444`;
  const shotId = `5555555${index}-5555-4555-8555-555555555555`;
  const shotRevisionId = `6666666${index}-6666-4666-8666-666666666666`;
  const jobId = `7777777${index}-7777-4777-8777-777777777777`;
  const attemptId = `8888888${index}-8888-4888-8888-888888888888`;
  return {
    assetId, workspaceId, projectId, episodeId, shotId, shotRevisionId,
    checksumSha256: `${index}`.repeat(64).slice(0, 64),
    byteSize: 1200 + index, width: 1080, height: 1920, durationMs, mimeType: "video/mp4",
    kind: "COMPOSITE", status: "ACTIVE", reviewStatus: "APPROVED", sourceKind: "LOCAL_JOB",
    storageProvider: "local-compose", reviewedContentHash: `${index}`.repeat(64).slice(0, 64),
    rowVersion: 3, metadataSchema: EPISODE_COMPOSE_ASSET_SCHEMA, renderProfile: { ...COMPOSE_RENDER_PROFILE },
    providerConfigurationId: null, providerRequestId: null, sourceGenerationJobId: jobId, sourceJobAttemptId: attemptId,
    sourceUsable: true,
    job: { id: jobId, workspaceId, projectId, shotRevisionId, kind: "MEDIA_COMPOSE", state: "SUCCEEDED", schema: COMPOSE_JOB_SCHEMA },
    attempt: { id: attemptId, generationJobId: jobId, finished: true, isLatest: true },
  };
}

function sources(items: EpisodeCompositeFacts[], preflight: ReturnType<typeof buildEpisodeComposePreflight>) {
  return preflight.manifest.segments.map((segment, index) => {
    const item = items[index];
    if (!item) throw new Error("segment");
    return {
      assetId: segment.assetId,
      shotId: segment.shotId,
      shotRevisionId: segment.shotRevisionId,
      storageProvider: "local-compose",
      objectKey: `compose/${workspaceId}/${projectId}/${item.sourceGenerationJobId}/${item.sourceJobAttemptId}/${segment.checksumSha256}.mp4`,
      byteSize: segment.byteSize,
      checksumSha256: segment.checksumSha256,
      durationMs: segment.durationMs,
      startMs: segment.startMs,
      endMs: segment.endMs,
    };
  });
}

describe("episode compose render contract", () => {
  it("freezes ordered sources under the episode schema and leaves the shot schema unchanged", () => {
    const first = facts(1, 1500);
    const second = facts(2, 2500);
    const preflight = buildEpisodeComposePreflight({
      workspaceId, projectId, episodeId, staleRecalculationPending: false, composites: [first, second],
    });
    const request = parseEpisodeComposeRenderRequest({
      compositeAssetIds: [first.assetId, second.assetId],
      expectedInputHash: preflight.inputHash,
    });
    expect(request.compositeAssetIds).toEqual([first.assetId, second.assetId]);
    expect(() => parseEpisodeComposeRenderRequest({ ...request, objectKey: "client/path.mp4" })).toThrow(/unknown field/i);
    const built = buildEpisodeComposeJobSnapshot(preflight, sources([first, second], preflight));
    expect(built.snapshot.schema).toBe(EPISODE_COMPOSE_JOB_SCHEMA);
    expect(built.snapshot.schema).not.toBe(COMPOSE_JOB_SCHEMA);
    expect(EPISODE_COMPOSE_OUTPUT_SCHEMA).not.toBe(EPISODE_COMPOSE_ASSET_SCHEMA);
    expect(built.snapshot.input.renderProfile).toEqual(EPISODE_RENDER_PROFILE);
    expect(built.snapshot.input.renderProfile.id).not.toBe(COMPOSE_RENDER_PROFILE.id);
    expect(built.inputHash).toBe(canonicalInputHash(built.snapshot.input));
    expect(built.inputHash).not.toBe(preflight.inputHash);
    expect(built.snapshot.preflightInputHash).toBe(preflight.inputHash);
    expect("sourceShotRevisionId" in built.snapshot.input).toBe(false);
    expect(built.snapshot.input.sourceObjects.map((item) => item.assetId)).toEqual([first.assetId, second.assetId]);
    const reversed = buildEpisodeComposePreflight({
      workspaceId, projectId, episodeId, staleRecalculationPending: false, composites: [second, first],
    });
    const other = buildEpisodeComposeJobSnapshot(reversed, sources([second, first], reversed));
    expect(other.inputHash).not.toBe(built.inputHash);
    expect(other.snapshot.input.sourceObjects.map((item) => item.shotId)).toEqual([second.shotId, first.shotId]);
  });
});
