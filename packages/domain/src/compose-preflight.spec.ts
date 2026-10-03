import { describe, expect, it } from "vitest";
import { SAMPLE_VIDEO_DESCRIPTIONS, SAMPLE_VIDEO_SCHEMA } from "@ai-drama/contracts";
import {
  COMPOSE_PREFLIGHT_SCHEMA,
  COMPOSE_VIDEO_DURATION_MAX_MS,
  buildComposePreflight,
  canonicalInputHash,
  parseComposePreflightRequest,
  type ComposeAssetFacts,
  type ComposePreflightRole,
  DomainError,
} from "./index";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const shotRevisionId = "33333333-3333-4333-8333-333333333333";
const videoId = "44444444-4444-4444-8444-444444444444";
const audioId = "55555555-5555-4555-8555-555555555555";
const musicId = "99999999-9999-4999-8999-999999999999";
const subtitleId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function facts(role: ComposePreflightRole, overrides: Partial<ComposeAssetFacts> = {}): ComposeAssetFacts {
  const rule = {
    video: { id: videoId, kind: "VIDEO", mimeType: "video/mp4", jobKind: "MEDIA_VIDEO", capability: "video.generate", width: 16, height: 16, durationMs: 1000 },
    audio: { id: audioId, kind: "AUDIO", mimeType: "audio/wav", jobKind: "MEDIA_TTS", capability: "audio.tts", width: null, height: null, durationMs: 100 },
    music: { id: musicId, kind: "MUSIC", mimeType: "audio/wav", jobKind: "MEDIA_MUSIC", capability: "audio.music", width: null, height: null, durationMs: 100 },
    subtitle: { id: subtitleId, kind: "SUBTITLE", mimeType: "text/vtt", jobKind: "MEDIA_SUBTITLE", capability: "subtitle.generate", width: null, height: null, durationMs: 100 },
  }[role];
  const jobId = `66666666-6666-4666-8666-${role === "video" ? "666666666666" : role === "audio" ? "666666666667" : role === "music" ? "666666666668" : "666666666669"}`;
  const attemptId = `77777777-7777-4777-8777-${role === "video" ? "777777777777" : role === "audio" ? "777777777778" : role === "music" ? "777777777779" : "777777777770"}`;
  const providerConfigurationId = "88888888-8888-4888-8888-888888888888";
  const requestId = `mock-media|sync|${rule.capability}|${jobId}:1`;
  return {
    id: rule.id,
    workspaceId,
    projectId,
    shotRevisionId,
    kind: rule.kind,
    mimeType: rule.mimeType,
    byteSize: 1552,
    checksumSha256: "ab".repeat(32),
    width: rule.width,
    height: rule.height,
    durationMs: rule.durationMs,
    status: "ACTIVE",
    reviewStatus: "DRAFT",
    storageProvider: "mock-object-store",
    sourceGenerationJobId: jobId,
    sourceJobAttemptId: attemptId,
    providerRequestId: requestId,
    providerConfigurationId,
    rowVersion: 4,
    job: {
      id: jobId,
      workspaceId,
      projectId,
      shotRevisionId,
      kind: rule.jobKind,
      state: "SUCCEEDED",
    },
    attempt: {
      id: attemptId,
      generationJobId: jobId,
      attemptNo: 1,
      providerRequestId: requestId,
      providerConfigurationId,
      finished: true,
    },
    ...overrides,
  };
}

function preflight(videoOverrides: Partial<ComposeAssetFacts> = {}) {
  return buildComposePreflight({
    workspaceId,
    projectId,
    shotRevisionId,
    assets: { video: facts("video", videoOverrides), audio: null, music: null, subtitle: null },
  });
}

describe("compose preflight request", () => {
  it("normalizes missing optional assets to null", () => {
    expect(parseComposePreflightRequest({ videoAssetId: videoId })).toEqual({
      videoAssetId: videoId,
      audioAssetId: null,
      musicAssetId: null,
      subtitleAssetId: null,
    });
    expect(parseComposePreflightRequest({
      videoAssetId: videoId.toUpperCase(),
      audioAssetId: null,
      musicAssetId: null,
      subtitleAssetId: null,
    }).videoAssetId).toBe(videoId);
  });

  it("rejects extra fields, duplicates, and non-uuid values", () => {
    const extras = [
      { videoAssetId: videoId, objectKey: "mock/video.mp4" },
      { videoAssetId: videoId, url: "https://example.test/video.mp4" },
      { videoAssetId: videoId, path: "/tmp/video.mp4" },
      { videoAssetId: videoId, workspaceId },
      { videoAssetId: videoId, projectId },
      { videoAssetId: videoId, volume: 1 },
      { videoAssetId: videoId, audioAssetId: videoId },
      { videoAssetId: "not-a-uuid" },
      { audioAssetId: audioId },
      null,
      [],
    ];
    for (const body of extras) {
      expect(() => parseComposePreflightRequest(body)).toThrowError(
        expect.objectContaining({ name: "DomainError", code: "VALIDATION_ERROR" }),
      );
    }
    expect(() => parseComposePreflightRequest({ videoAssetId: videoId, audioAssetId: videoId })).toThrow(
      /duplicate assets/,
    );
  });
});

describe("compose preflight manifest", () => {
  it("hashes the same manifest without row versions or timestamps", () => {
    const first = preflight();
    const second = preflight({ rowVersion: 9 });
    expect(first.schema).toBe(COMPOSE_PREFLIGHT_SCHEMA);
    expect(first.inputHash).toBe(second.inputHash);
    expect(first.inputHash).toBe(canonicalInputHash(first.manifest));
    expect(first.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(first.manifest)).not.toMatch(/rowVersion|reviewVersion|createdAt|traceId/);
    expect(first.guards.assets[0]).toEqual({ role: "video", assetId: videoId, rowVersion: 4 });
    expect(second.guards.assets[0]?.rowVersion).toBe(9);
    expect(first.manifest.plan).toMatchObject({
      width: 1080,
      height: 1920,
      frameRate: 25,
      container: "mp4",
      videoStartMs: 0,
      audioLoop: false,
      subtitleMode: "burn-in",
      timelineEditable: false,
      durationMs: 1000,
    });
    expect(first.manifest.sources.map((slot) => slot.role)).toEqual(["video", "audio", "music", "subtitle"]);
  });

  it("changes the hash when the source asset changes", () => {
    const original = preflight();
    const replaced = preflight({ checksumSha256: "cd".repeat(32) });
    expect(replaced.inputHash).not.toBe(original.inputHash);
  });

  it("accepts the duration cap and rejects a longer video", () => {
    expect(preflight({ durationMs: COMPOSE_VIDEO_DURATION_MAX_MS }).manifest.plan.durationMs).toBe(90_000);
    expect(() => preflight({ durationMs: COMPOSE_VIDEO_DURATION_MAX_MS + 1 })).toThrowError(
      expect.objectContaining({ code: "COMPOSE_INPUT_INVALID" }),
    );
  });

  it("rejects constructed rows that are rejected, inactive, or missing metadata", () => {
    const cases: Array<Partial<ComposeAssetFacts>> = [
      { reviewStatus: "REJECTED" },
      { reviewStatus: "APPROVED" },
      { status: "STALE" },
      { status: "SUPERSEDED" },
      { durationMs: null },
      { durationMs: 0 },
      { width: null },
      { kind: "IMAGE", mimeType: "image/png" },
      { storageProvider: "s3" },
      { shotRevisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      { job: { ...facts("video").job!, state: "FAILED" } },
      { providerRequestId: "mock-media|sync|video.generate|other:1" },
    ];
    for (const overrides of cases) {
      expect(() => preflight(overrides)).toThrow(DomainError);
      try {
        preflight(overrides);
      } catch (error) {
        expect(error).toMatchObject({ code: "COMPOSE_INPUT_INVALID" });
      }
    }
  });

  it("accepts a sample video only when the request, snapshot, and asset describe the same fixture", () => {
    const description = SAMPLE_VIDEO_DESCRIPTIONS["sample-15s-a-v1"];
    const base = facts("video");
    const requestId = `mock-media|sample-sync-v1|video.generate|sample-15s-a-v1|${base.job?.id}:1`;
    const frozen = { schema: SAMPLE_VIDEO_SCHEMA, ...description };
    const accepted = preflight({
      providerRequestId: requestId,
      checksumSha256: description.checksumSha256,
      byteSize: description.byteSize,
      width: description.width,
      height: description.height,
      durationMs: description.durationMs,
      metadata: frozen,
      job: { ...base.job!, inputSnapshot: { ...frozen, shotRevisionId, sourceText: "技术验收样片" } },
      attempt: { ...base.attempt!, providerRequestId: requestId },
    });
    expect(accepted.manifest.sources[0]?.asset?.durationMs).toBe(15000);
    const other = SAMPLE_VIDEO_DESCRIPTIONS["sample-15s-b-v1"];
    expect(() => preflight({
      providerRequestId: requestId,
      checksumSha256: description.checksumSha256,
      byteSize: description.byteSize,
      width: description.width,
      height: description.height,
      durationMs: description.durationMs,
      metadata: { schema: SAMPLE_VIDEO_SCHEMA, ...other },
      job: { ...base.job!, inputSnapshot: frozen },
      attempt: { ...base.attempt!, providerRequestId: requestId },
    })).toThrowError(expect.objectContaining({ code: "COMPOSE_INPUT_INVALID" }));
    expect(() => preflight({
      providerRequestId: `mock-media|sample-sync-v1|video.generate|sample-15s-a-v1|${base.job?.id}`,
      metadata: frozen,
      job: { ...base.job!, inputSnapshot: frozen },
    })).toThrowError(expect.objectContaining({ code: "COMPOSE_INPUT_INVALID" }));
  });
});
