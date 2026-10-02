import { describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import { EPISODE_COMPOSE_JOB_SCHEMA, EPISODE_COMPOSE_OUTPUT_SCHEMA, EPISODE_RENDER_PROFILE } from "./episode-compose-render";
import {
  assertDependencyEdges,
  assertEpisodeExportRecord,
  buildEpisodeExportManifest,
  episodeExportFilenameStem,
  mediaFromFrozenShot,
  type EpisodeExportAssetFacts,
  type EpisodeExportFacts,
  type FrozenShotMediaInput,
} from "./episode-export";
import { canonicalInputHash } from "./text-chain";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const episodeId = "33333333-3333-4333-8333-333333333333";
const assetId = "44444444-4444-4444-8444-444444444444";
const jobId = "55555555-5555-4555-8555-555555555555";
const attemptId = "66666666-6666-4666-8666-666666666666";
const shotAssetId = "77777777-7777-4777-8777-777777777777";
const shotId = "88888888-8888-4888-8888-888888888888";
const shotRevisionId = "99999999-9999-4999-8999-999999999999";
const videoId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const audioId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const imageId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const hash = "ab".repeat(32);
const shotHash = "cd".repeat(32);
const videoHash = "ef".repeat(32);
const audioHash = "12".repeat(32);

function qualified() {
  const manifest = {
    workspaceId,
    projectId,
    episodeId,
    segments: [{
      position: 1,
      assetId: shotAssetId,
      shotId,
      shotRevisionId,
      checksumSha256: shotHash,
      byteSize: 20,
      width: 1080,
      height: 1920,
      durationMs: 1000,
      startMs: 0,
      endMs: 1000,
    }],
    plan: {
      width: 1080,
      height: 1920,
      frameRate: 25,
      container: "mp4",
      cut: "hard-cut-in-order",
      audio: "keep-segment-audio",
      subtitles: "already-burned",
      durationMs: 1000,
    },
  };
  const input = {
    workspaceId,
    projectId,
    episodeId,
    manifest,
    renderProfile: EPISODE_RENDER_PROFILE,
    sourceObjects: [{
      assetId: shotAssetId,
      shotId,
      shotRevisionId,
      storageProvider: "local-compose",
      objectKey: "compose/hidden/source.mp4",
      byteSize: 20,
      checksumSha256: shotHash,
      durationMs: 1000,
      startMs: 0,
      endMs: 1000,
    }],
  };
  const preflightInputHash = canonicalInputHash(manifest);
  const snapshot = {
    schema: EPISODE_COMPOSE_JOB_SCHEMA,
    input,
    preflightInputHash,
    guards: { episodeId, assets: [{ assetId: shotAssetId, rowVersion: 2 }] },
  };
  const asset: EpisodeExportAssetFacts = {
    id: assetId,
    workspaceId,
    projectId,
    kind: "COMPOSITE",
    sourceKind: "LOCAL_JOB",
    storageProvider: "local-compose",
    mimeType: "video/mp4",
    byteSize: 32,
    checksumSha256: hash,
    width: 1080,
    height: 1920,
    durationMs: 1000,
    status: "ACTIVE",
    reviewStatus: "APPROVED",
    reviewedContentHash: hash,
    rowVersion: 2,
    sourceShotRevisionId: null,
    objectKey: `compose/${workspaceId}/${projectId}/${jobId}/${attemptId}/${hash}.mp4`,
    sourceJobId: jobId,
    sourceAttemptId: attemptId,
    metadata: {
      schema: EPISODE_COMPOSE_OUTPUT_SCHEMA,
      episodeId,
      manifest,
      renderProfile: EPISODE_RENDER_PROFILE,
      preflightInputHash,
      sourceJobId: jobId,
      sourceAttemptId: attemptId,
      output: { checksumSha256: hash, byteSize: 32, durationMs: 1000, width: 1080, height: 1920, elapsedMs: 4 },
    },
  };
  return {
    workspaceId,
    projectId,
    episodeId,
    episodeNo: 1,
    expectedContentHash: hash,
    stalePending: false,
    asset,
    job: {
      id: jobId,
      workspaceId,
      projectId,
      shotRevisionId: null,
      kind: "MEDIA_COMPOSE",
      state: "SUCCEEDED",
      inputHash: canonicalInputHash(input),
      snapshot,
    },
    attempt: { id: attemptId, jobId, finished: true, isLatest: true },
  };
}

function mediaInput(overrides: Partial<FrozenShotMediaInput> = {}): FrozenShotMediaInput {
  return {
    workspaceId,
    projectId,
    sources: [
      { role: "video", asset: { assetId: videoId, checksumSha256: videoHash, kind: "VIDEO" } },
      { role: "audio", asset: { assetId: audioId, checksumSha256: audioHash, kind: "AUDIO" } },
      { role: "music", asset: null },
      { role: "subtitle", asset: null },
    ],
    sourceObjects: [
      { role: "audio", assetId: audioId, checksumSha256: audioHash },
      { role: "video", assetId: videoId, checksumSha256: videoHash },
    ],
    edges: [
      { workspaceId, projectId, sourceAssetId: videoId },
      { workspaceId, projectId, sourceAssetId: audioId },
    ],
    media: [
      { assetId: videoId, workspaceId, projectId, kind: "VIDEO", checksumSha256: videoHash, sourceJobId: jobId, sourceAttemptId: attemptId },
      { assetId: audioId, workspaceId, projectId, kind: "AUDIO", checksumSha256: audioHash, sourceJobId: jobId, sourceAttemptId: attemptId },
    ],
    ...overrides,
  };
}

describe("episode export eligibility", () => {
  it("accepts an active approved episode composite and ignores unused image slots", () => {
    const facts = assertEpisodeExportRecord(qualified());
    expect(facts.reviewStatus).toBe("APPROVED");
    expect(facts.objectKey).toContain(hash);
    const media = mediaFromFrozenShot(mediaInput());
    expect(media.map((item) => item.role)).toEqual(["video", "audio"]);
    expect(JSON.stringify(media)).not.toContain(imageId);
    expect(JSON.stringify(media)).not.toContain("objectKey");
  });

  it.each([
    ["DRAFT", (input: ReturnType<typeof qualified>) => { input.asset.reviewStatus = "DRAFT"; }],
    ["REJECTED", (input: ReturnType<typeof qualified>) => { input.asset.reviewStatus = "REJECTED"; }],
    ["STALE", (input: ReturnType<typeof qualified>) => { input.asset.status = "STALE"; }],
    ["hash", (input: ReturnType<typeof qualified>) => { input.expectedContentHash = "cd".repeat(32); }],
    ["schema", (input: ReturnType<typeof qualified>) => { (input.asset.metadata as { schema: string }).schema = "m4.shot.compose.asset.v1"; }],
    ["attempt", (input: ReturnType<typeof qualified>) => { input.attempt = { ...input.attempt, isLatest: false }; }],
    ["stale-pending", (input: ReturnType<typeof qualified>) => { input.stalePending = true; }],
  ] as const)("rejects %s", (_name, change) => {
    const input = qualified();
    change(input);
    expect(() => assertEpisodeExportRecord(input)).toThrow(DomainError);
  });

  it("rejects missing, extra, and cross-project dependency edges", () => {
    const expected = [shotAssetId];
    expect(() => assertDependencyEdges(workspaceId, projectId, expected, [])).toThrow(/dependencies/);
    expect(() => assertDependencyEdges(workspaceId, projectId, expected, [
      { workspaceId, projectId, sourceAssetId: shotAssetId },
      { workspaceId, projectId, sourceAssetId: videoId },
    ])).toThrow(/dependencies/);
    expect(() => assertDependencyEdges(workspaceId, projectId, expected, [
      { workspaceId, projectId: episodeId, sourceAssetId: shotAssetId },
    ])).toThrow(/outside this project/);
    expect(() => mediaFromFrozenShot(mediaInput({
      media: mediaInput().media.map((item) => item.assetId === videoId ? { ...item, checksumSha256: hash } : item),
    }))).toThrow(/does not match/);
  });
});

describe("episode export manifest", () => {
  it("uses one filename stem and omits paths, object keys, and a fabricated cost", () => {
    const core = assertEpisodeExportRecord(qualified());
    const facts: EpisodeExportFacts = {
      ...core,
      segments: [{
        position: 1,
        startMs: 0,
        endMs: 1000,
        durationMs: 1000,
        shotAssetId,
        shotChecksumSha256: shotHash,
        shotId,
        shotRevisionId,
        media: mediaFromFrozenShot(mediaInput()),
      }],
    };
    const manifest = buildEpisodeExportManifest(facts, "2026-10-02T00:00:00.000Z");
    const stem = episodeExportFilenameStem(1, assetId);
    expect(stem).toBe(`episode-01-${assetId}`);
    expect(`${stem}.mp4`).toBe(`${episodeExportFilenameStem(facts.episodeNo, facts.assetId)}.mp4`);
    expect(`${stem}.json`.replace(/\.json$/, "")).toBe(stem);
    expect(manifest.schema).toBe("m4.episode.export.manifest.v1");
    expect(manifest.eligibility).toBe("qualified");
    expect(manifest.asset.checksumSha256).toBe(hash);
    expect(manifest.compose.inputHash).toBe(facts.inputHash);
    expect(manifest.compose.preflightInputHash).toBe(facts.preflightInputHash);
    expect(manifest.segments[0]?.media.map((item) => item.assetId)).toEqual([videoId, audioId]);
    expect(manifest.boundary.localEncodeCostMetered).toBe(false);
    expect(manifest.boundary.statement).toContain("未计量");
    const encoded = JSON.stringify(manifest);
    expect(encoded).not.toContain("objectKey");
    expect(encoded).not.toContain("compose/hidden");
    expect(encoded).not.toContain("postgres");
    expect(encoded).not.toContain("\"cost\"");
    expect(encoded).not.toContain(imageId);
  });
});
