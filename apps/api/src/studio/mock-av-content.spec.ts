import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MOCK_AUDIO_FIXTURE, MOCK_VIDEO_FIXTURE } from "@ai-drama/providers";
import type { MediaAssetRecord } from "@ai-drama/database";
import { assertReadableMockAv, readBoundedMockAv } from "./mock-av-content";

const projectId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";

function asset(fixture: typeof MOCK_VIDEO_FIXTURE | typeof MOCK_AUDIO_FIXTURE, overrides: Partial<MediaAssetRecord> = {}): MediaAssetRecord {
  const extension = fixture.mimeType === "video/mp4" ? "mp4" : "wav";
  const folder = fixture.mimeType === "video/mp4" ? "mock-videos" : "mock-audio";
  return {
    id: "33333333-3333-4333-8333-333333333333",
    projectId,
    kind: fixture.mimeType === "video/mp4" ? "VIDEO" : "AUDIO",
    storageProvider: "mock-object-store",
    objectKey: `${folder}/${projectId}/${jobId}/${fixture.checksumSha256}.${extension}`,
    mimeType: fixture.mimeType,
    byteSize: fixture.byteLength,
    checksumSha256: fixture.checksumSha256,
    width: fixture.width,
    height: fixture.height,
    durationMs: fixture.durationMs,
    status: "ACTIVE",
    reviewStatus: "DRAFT",
    sourceJobAttemptId: "44444444-4444-4444-8444-444444444444",
    sourceGenerationJobId: jobId,
    sourceShotRevisionId: "55555555-5555-4555-8555-555555555555",
    providerRequestId: "mock-media|sync|video.generate|job:1",
    createdAt: "2026-09-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("mock AV content", () => {
  const root = resolve(tmpdir(), `m3-av-content-${process.pid}`);

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });

  it("reads the canonical video and audio fixtures and rejects signatures, metadata, and directories", async () => {
    const video = asset(MOCK_VIDEO_FIXTURE);
    const audio = asset(MOCK_AUDIO_FIXTURE);
    await mkdir(join(root, "mock-videos", projectId, jobId), { recursive: true });
    await mkdir(join(root, "mock-audio", projectId, jobId), { recursive: true });
    await writeFile(join(root, video.objectKey), MOCK_VIDEO_FIXTURE.bytes);
    await writeFile(join(root, audio.objectKey), MOCK_AUDIO_FIXTURE.bytes);
    await expect(readBoundedMockAv(root, video)).resolves.toEqual(MOCK_VIDEO_FIXTURE.bytes);
    await expect(readBoundedMockAv(root, audio)).resolves.toEqual(MOCK_AUDIO_FIXTURE.bytes);
    const { rm } = await import("node:fs/promises");
    await rm(join(root, video.objectKey));

    const fake = Buffer.from("ftyp-not-a-playable-mp4");
    const fakeAsset = asset(MOCK_VIDEO_FIXTURE, {
      byteSize: fake.length,
      checksumSha256: "ab".repeat(32),
      objectKey: `mock-videos/${projectId}/${jobId}/${"ab".repeat(32)}.mp4`,
    });
    expect(() => assertReadableMockAv(fakeAsset)).toThrow(/not a stored mock recording/);
    expect(() => assertReadableMockAv(asset(MOCK_VIDEO_FIXTURE, { durationMs: 0 }))).toThrow(/not a stored mock recording/);
    expect(() => assertReadableMockAv(asset(MOCK_VIDEO_FIXTURE, { kind: "IMAGE", mimeType: "image/png" }))).toThrow(/not a stored mock recording/);

    await mkdir(join(root, video.objectKey), { recursive: true });
    await expect(readBoundedMockAv(root, video)).rejects.toMatchObject({ code: "ASSET_CONTENT_INVALID" });
  });
});
