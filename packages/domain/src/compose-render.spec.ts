import { describe, expect, it } from "vitest";
import { canonicalInputHash } from "./text-chain";
import { buildComposePreflight, type ComposeAssetFacts } from "./compose-preflight";
import {
  COMPOSE_RENDER_PROFILE,
  assertExpectedPreflightHash,
  buildComposeJobSnapshot,
  parseComposeRenderRequest,
  parseComposeReviewRequest,
} from "./compose-render";

const videoId = "44444444-4444-4444-8444-444444444444";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const shotId = "33333333-3333-4333-8333-333333333333";

function video(): ComposeAssetFacts {
  const jobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  return {
    id: videoId, workspaceId, projectId, shotRevisionId: shotId, kind: "VIDEO", mimeType: "video/mp4",
    byteSize: 100, checksumSha256: "ab".repeat(32), width: 16, height: 16, durationMs: 1000,
    status: "ACTIVE", reviewStatus: "DRAFT", storageProvider: "mock-object-store",
    sourceGenerationJobId: jobId, sourceJobAttemptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    providerRequestId: `mock-media|sync|video.generate|${jobId}:1`, providerConfigurationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    rowVersion: 2,
    job: { id: jobId, workspaceId, projectId, shotRevisionId: shotId, kind: "MEDIA_VIDEO", state: "SUCCEEDED" },
    attempt: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", generationJobId: jobId, attemptNo: 1, finished: true,
      providerRequestId: `mock-media|sync|video.generate|${jobId}:1`, providerConfigurationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
  };
}

describe("compose render contract", () => {
  it("requires the preflight hash and rejects client render fields", () => {
    expect(parseComposeRenderRequest({ videoAssetId: videoId, expectedInputHash: "ab".repeat(32) }).audioAssetId).toBeNull();
    expect(() => parseComposeRenderRequest({ videoAssetId: videoId, expectedInputHash: "ab".repeat(32), objectKey: "x" })).toThrow(/invalid/i);
    expect(() => parseComposeReviewRequest({ decision: "APPROVE", note: "", contentHash: "ab".repeat(32), workspaceId: workspaceId })).toThrow(/invalid/i);
  });

  it("hashes the manifest, profile, and source objects without guards", () => {
    const preflight = buildComposePreflight({ workspaceId, projectId, shotRevisionId: shotId, assets: { video: video(), audio: null, music: null, subtitle: null } });
    const source = { role: "video" as const, assetId: videoId, storageProvider: "mock-object-store", objectKey: "mock-videos/p/j/" + "ab".repeat(32) + ".mp4", byteSize: 100, checksumSha256: "ab".repeat(32) };
    const built = buildComposeJobSnapshot(preflight, [source]);
    expect(built.inputHash).toBe(canonicalInputHash(built.snapshot.input));
    expect(built.inputHash).not.toBe(preflight.inputHash);
    expect(JSON.stringify(built.snapshot.input)).toContain(COMPOSE_RENDER_PROFILE.id);
    expect(JSON.stringify(built.snapshot.input)).not.toContain("rowVersion");
    const changed = buildComposeJobSnapshot(preflight, [{ ...source, objectKey: "mock-videos/other/" + "ab".repeat(32) + ".mp4" }]);
    expect(changed.inputHash).not.toBe(built.inputHash);
    expect(() => assertExpectedPreflightHash(preflight.inputHash, "cd".repeat(32))).toThrow(/changed/i);
  });
});
