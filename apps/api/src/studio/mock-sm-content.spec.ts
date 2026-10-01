import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MOCK_AUDIO_FIXTURE, MOCK_SUBTITLE_FIXTURE } from "@ai-drama/providers";
import type { MediaAssetRecord } from "@ai-drama/database";
import { assertReadableMockSm, readBoundedMockSm } from "./mock-sm-content";

const projectId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";

function asset(kind: "SUBTITLE" | "MUSIC", overrides: Partial<MediaAssetRecord> = {}): MediaAssetRecord {
  const fixture = kind === "SUBTITLE" ? MOCK_SUBTITLE_FIXTURE : MOCK_AUDIO_FIXTURE;
  const folder = kind === "SUBTITLE" ? "mock-subtitles" : "mock-music";
  const extension = kind === "SUBTITLE" ? "vtt" : "wav";
  return {
    id: "33333333-3333-4333-8333-333333333333",
    projectId,
    kind,
    storageProvider: "mock-object-store",
    objectKey: `${folder}/${projectId}/${jobId}/${fixture.checksumSha256}.${extension}`,
    mimeType: fixture.mimeType,
    byteSize: fixture.byteLength,
    checksumSha256: fixture.checksumSha256,
    width: null,
    height: null,
    durationMs: fixture.durationMs,
    status: "ACTIVE",
    reviewStatus: "DRAFT",
    sourceJobAttemptId: "44444444-4444-4444-8444-444444444444",
    sourceGenerationJobId: jobId,
    sourceShotRevisionId: "55555555-5555-4555-8555-555555555555",
    providerRequestId: "mock-media|sync|subtitle.generate|job:1",
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("mock subtitle and music content", () => {
  const root = resolve(tmpdir(), `m3-sm-content-${process.pid}`);

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });

  it("reads the fixed vtt and wav and rejects kind, path, damage, and oversize mismatches", async () => {
    const subtitle = asset("SUBTITLE");
    const music = asset("MUSIC");
    await mkdir(join(root, "mock-subtitles", projectId, jobId), { recursive: true });
    await mkdir(join(root, "mock-music", projectId, jobId), { recursive: true });
    await writeFile(join(root, subtitle.objectKey), MOCK_SUBTITLE_FIXTURE.bytes);
    await writeFile(join(root, music.objectKey), MOCK_AUDIO_FIXTURE.bytes);
    await expect(readBoundedMockSm(root, subtitle)).resolves.toEqual(MOCK_SUBTITLE_FIXTURE.bytes);
    expect((await readBoundedMockSm(root, subtitle)).toString("utf8")).toContain("Mock subtitle");
    await expect(readBoundedMockSm(root, music)).resolves.toEqual(MOCK_AUDIO_FIXTURE.bytes);

    expect(() => assertReadableMockSm(asset("MUSIC", { kind: "AUDIO", objectKey: `mock-audio/${projectId}/${jobId}/${MOCK_AUDIO_FIXTURE.checksumSha256}.wav` }))).toThrow(/not a stored mock recording/);
    expect(() => assertReadableMockSm(asset("SUBTITLE", { objectKey: `mock-subtitles/${projectId}/${jobId}/not-a-hash.vtt` }))).toThrow(/not a stored mock recording/);
    expect(() => assertReadableMockSm(asset("MUSIC", { byteSize: MOCK_AUDIO_FIXTURE.byteLength + 1 }))).toThrow(/not a stored mock recording/);
    expect(() => assertReadableMockSm(asset("SUBTITLE", { width: 1 }))).toThrow(/not a stored mock recording/);

    const damaged = Buffer.from("WEBVTT\n\nnot the fixture\n");
    await writeFile(join(root, subtitle.objectKey), damaged);
    await expect(readBoundedMockSm(root, subtitle)).rejects.toMatchObject({ code: "ASSET_CONTENT_INVALID" });

    const huge = Buffer.alloc(MOCK_SUBTITLE_FIXTURE.byteLength + 8, 1);
    const hugeAsset = asset("SUBTITLE", { byteSize: huge.length, checksumSha256: "ab".repeat(32), objectKey: `mock-subtitles/${projectId}/${jobId}/${"ab".repeat(32)}.vtt` });
    expect(() => assertReadableMockSm(hugeAsset)).toThrow(/not a stored mock recording/);
  });
});
