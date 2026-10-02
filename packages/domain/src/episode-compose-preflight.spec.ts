import { describe, expect, it } from "vitest";
import { COMPOSE_JOB_SCHEMA, COMPOSE_RENDER_PROFILE } from "./compose-render";
import {
  EPISODE_COMPOSE_ASSET_SCHEMA,
  EPISODE_COMPOSE_MAX_DURATION_MS,
  EPISODE_COMPOSE_SHORT_NOTICE,
  EPISODE_COMPOSE_STATUS_NOTE,
  buildEpisodeComposePreflight,
  parseEpisodeComposePreflightRequest,
  type EpisodeCompositeFacts,
} from "./episode-compose-preflight";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const episodeId = "33333333-3333-4333-8333-333333333333";
const otherEpisodeId = "34343434-3434-4434-8434-343434343434";
const otherProjectId = "35353535-3535-4353-8353-353535353535";

function facts(index: number, overrides: Partial<EpisodeCompositeFacts> = {}): EpisodeCompositeFacts {
  const assetId = `4444444${index}-4444-4444-8444-444444444444`;
  const shotId = `5555555${index}-5555-4555-8555-555555555555`;
  const shotRevisionId = `6666666${index}-6666-4666-8666-666666666666`;
  const jobId = `7777777${index}-7777-4777-8777-777777777777`;
  const attemptId = `8888888${index}-8888-4888-8888-888888888888`;
  return {
    assetId,
    workspaceId,
    projectId,
    episodeId,
    shotId,
    shotRevisionId,
    checksumSha256: `${index}`.repeat(64).slice(0, 64),
    byteSize: 1200 + index,
    width: 1080,
    height: 1920,
    durationMs: 1000,
    mimeType: "video/mp4",
    kind: "COMPOSITE",
    status: "ACTIVE",
    reviewStatus: "APPROVED",
    sourceKind: "LOCAL_JOB",
    storageProvider: "local-compose",
    reviewedContentHash: `${index}`.repeat(64).slice(0, 64),
    rowVersion: 3 + index,
    metadataSchema: EPISODE_COMPOSE_ASSET_SCHEMA,
    renderProfile: { ...COMPOSE_RENDER_PROFILE },
    providerConfigurationId: null,
    providerRequestId: null,
    sourceGenerationJobId: jobId,
    sourceJobAttemptId: attemptId,
    sourceUsable: true,
    job: {
      id: jobId,
      workspaceId,
      projectId,
      shotRevisionId,
      kind: "MEDIA_COMPOSE",
      state: "SUCCEEDED",
      schema: COMPOSE_JOB_SCHEMA,
    },
    attempt: { id: attemptId, generationJobId: jobId, finished: true, isLatest: true },
    ...overrides,
  };
}

function build(composites: EpisodeCompositeFacts[], extra: { staleRecalculationPending?: boolean } = {}) {
  return buildEpisodeComposePreflight({
    workspaceId,
    projectId,
    episodeId,
    staleRecalculationPending: extra.staleRecalculationPending ?? false,
    composites,
  });
}

describe("episode compose preflight", () => {
  it("keeps request order, accumulates milliseconds, and hashes only the manifest", () => {
    const first = facts(1, { durationMs: 1500 });
    const second = facts(2, { durationMs: 2500 });
    const result = build([first, second]);
    expect(result.schema).toBe("m4.episode.compose.preflight.v1");
    expect(result.verification).toBe("metadata");
    expect(result.diskContentChecked).toBe(false);
    expect(result.decoded).toBe(false);
    expect(result.executed).toBe(false);
    expect(result.statusNote).toBe(EPISODE_COMPOSE_STATUS_NOTE);
    expect(result.durationNotice).toBe(EPISODE_COMPOSE_SHORT_NOTICE);
    expect(result.manifest.segments.map((segment) => [segment.position, segment.startMs, segment.endMs, segment.durationMs])).toEqual([
      [1, 0, 1500, 1500],
      [2, 1500, 4000, 2500],
    ]);
    expect(result.manifest.plan).toMatchObject({
      width: 1080,
      height: 1920,
      frameRate: 25,
      container: "mp4",
      cut: "hard-cut-in-order",
      audio: "keep-segment-audio",
      subtitles: "already-burned",
      durationMs: 4000,
    });
    expect(JSON.stringify(result.manifest)).not.toContain("rowVersion");
    expect(result.guards.assets.map((asset) => asset.rowVersion)).toEqual([4, 5]);
    const swapped = build([second, first]);
    expect(swapped.inputHash).not.toBe(result.inputHash);
    expect(swapped.manifest.segments[0]?.startMs).toBe(0);
    expect(swapped.manifest.segments[0]?.endMs).toBe(2500);
    expect(swapped.manifest.segments[1]?.startMs).toBe(2500);
    expect(build([first, second]).inputHash).toBe(result.inputHash);
    const versioned = build([
      facts(1, { durationMs: 1500, rowVersion: 90 }),
      facts(2, { durationMs: 2500, rowVersion: 91 }),
    ]);
    expect(versioned.inputHash).toBe(result.inputHash);
    expect(versioned.guards.assets[0]?.rowVersion).toBe(90);
  });

  it("accepts the 60 and 90 second boundaries and rejects a longer total", () => {
    const onTarget = build([facts(1, { durationMs: 30_000 }), facts(2, { durationMs: 30_000 })]);
    expect(onTarget.durationNotice).toBeNull();
    expect(onTarget.manifest.plan.durationMs).toBe(60_000);
    const atMax = build([facts(1, { durationMs: 45_000 }), facts(2, { durationMs: 45_000 })]);
    expect(atMax.manifest.plan.durationMs).toBe(EPISODE_COMPOSE_MAX_DURATION_MS);
    expect(atMax.durationNotice).toBeNull();
    expect(() => build([facts(1, { durationMs: 45_000 }), facts(2, { durationMs: 45_001 })])).toThrow(/90000/);
  });

  it("rejects malformed requests before source checks", () => {
    const left = facts(1).assetId;
    const right = facts(2).assetId;
    expect(parseEpisodeComposePreflightRequest({ compositeAssetIds: [left, right] }).compositeAssetIds).toEqual([left, right]);
    expect(() => parseEpisodeComposePreflightRequest({ compositeAssetIds: [left, right], workspaceId })).toThrow(/unknown field/);
    expect(() => parseEpisodeComposePreflightRequest({ compositeAssetIds: [left] })).toThrow(/2 to 30/);
    expect(() => parseEpisodeComposePreflightRequest({ compositeAssetIds: Array.from({ length: 31 }, () => left) })).toThrow(/duplicates|2 to 30/);
    expect(() => parseEpisodeComposePreflightRequest({ compositeAssetIds: [left, left] })).toThrow(/duplicates/);
    expect(() => parseEpisodeComposePreflightRequest({ compositeAssetIds: [left, "not-a-uuid"] })).toThrow(/UUID/);
    expect(() => parseEpisodeComposePreflightRequest({ compositeAssetIds: [left.toUpperCase(), right] })).not.toThrow();
  });

  it("rejects duplicate shots and composites outside the episode, project, or workspace", () => {
    expect(() => build([facts(1), facts(1, { assetId: facts(2).assetId })])).toThrow(/同一个镜头只能选择一份成片/);
    expect(() => build([facts(1), facts(2, { episodeId: otherEpisodeId })])).toThrow(/outside this episode/);
    expect(() => build([facts(1), facts(2, { projectId: otherProjectId, job: { ...facts(2).job!, projectId: otherProjectId } })])).toThrow(/outside this project/);
    expect(() => build([facts(1), facts(2, { workspaceId: "99999999-9999-4999-8999-999999999999" })])).toThrow(/outside this project/);
  });

  it("rejects draft, rejected, stale, and unusable revisions", () => {
    expect(() => build([facts(1, { reviewStatus: "DRAFT", reviewedContentHash: null }), facts(2)])).toThrow(/active approved/);
    expect(() => build([facts(1, { reviewStatus: "REJECTED" }), facts(2)])).toThrow(/active approved/);
    expect(() => build([facts(1, { status: "STALE" }), facts(2)])).toThrow(/active approved/);
    expect(() => build([facts(1, { sourceUsable: false }), facts(2)])).toThrow(/current approved/);
    expect(() => build([facts(1), facts(2)], { staleRecalculationPending: true })).toThrow(/stale propagation/);
  });

  it("rejects a forged source, a failed job, and an attempt that is not the latest finished one", () => {
    expect(() => build([facts(1, { job: { ...facts(1).job!, kind: "MEDIA_VIDEO" } }), facts(2)])).toThrow(/succeeded single-shot/);
    expect(() => build([facts(1, { job: { ...facts(1).job!, schema: "forged" } }), facts(2)])).toThrow(/succeeded single-shot/);
    expect(() => build([facts(1, { job: { ...facts(1).job!, state: "FAILED" } }), facts(2)])).toThrow(/succeeded single-shot/);
    expect(() => build([facts(1, { attempt: { ...facts(1).attempt!, finished: false } }), facts(2)])).toThrow(/latest finished/);
    expect(() => build([facts(1, { attempt: { ...facts(1).attempt!, isLatest: false } }), facts(2)])).toThrow(/latest finished/);
    expect(() => build([facts(1, { storageProvider: "mock-object-store" }), facts(2)])).toThrow(/local single-shot/);
    expect(() => build([facts(1, { renderProfile: { ...COMPOSE_RENDER_PROFILE, crf: 18 } }), facts(2)])).toThrow(/metadata/);
  });
});
