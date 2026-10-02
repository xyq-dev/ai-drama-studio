import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistenceError, type MediaAssetStore } from "@ai-drama/database";
import type { EpisodeExportFacts } from "@ai-drama/domain";
import { afterEach, describe, expect, it } from "vitest";
import { StudioService } from "./studio.service";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const episodeId = "33333333-3333-4333-8333-333333333333";
const assetId = "44444444-4444-4444-8444-444444444444";
const hash = "ab".repeat(32);
const created: string[] = [];

function facts(rootBytes: Buffer): EpisodeExportFacts {
  const checksum = createHash("sha256").update(rootBytes).digest("hex");
  return {
    projectId,
    episodeId,
    episodeNo: 1,
    assetId,
    checksumSha256: checksum,
    byteSize: rootBytes.length,
    objectKey: `compose/${workspaceId}/${projectId}/55555555-5555-4555-8555-555555555555/66666666-6666-4666-8666-666666666666/${checksum}.mp4`,
    width: 1080,
    height: 1920,
    frameRate: 25,
    durationMs: 1000,
    reviewStatus: "APPROVED",
    rowVersion: 2,
    reviewedContentHash: checksum,
    jobId: "55555555-5555-4555-8555-555555555555",
    attemptId: "66666666-6666-4666-8666-666666666666",
    inputHash: hash,
    preflightInputHash: hash,
    renderProfileId: "local-ffmpeg-episode-v1",
    segments: [],
  };
}

afterEach(async () => {
  delete process.env.M4_EPISODE_EXPORT_LATCH_DIR;
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("episode composite export", () => {
  it("rechecks eligibility after the verified bytes and does not return them when the recheck fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "episode-export-"));
    created.push(root);
    const bytes = Buffer.from("approved-episode");
    const record = facts(bytes);
    await mkdir(join(root, "compose", workspaceId, projectId, record.jobId, record.attemptId), { recursive: true });
    await writeFile(join(root, record.objectKey), bytes);
    let reads = 0;
    let allowSecond = false;
    const inspectEpisodeCompositeExport = async () => {
      reads += 1;
      if (reads > 1 && !allowSecond) throw new PersistenceError("COMPOSE_INPUT_INVALID", "Episode compose sources changed before review");
      return record;
    };
    const studio = new StudioService(
      {} as never, {} as never, {} as never, workspaceId, undefined,
      { inspectEpisodeCompositeExport } as unknown as MediaAssetStore,
      false, null, false, false, false, root, true,
    );
    await expect(studio.exportEpisodeComposite(projectId, episodeId, assetId, {
      expectedContentHash: record.checksumSha256,
      workspaceId,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(reads).toBe(0);
    await expect(studio.exportEpisodeComposite(projectId, episodeId, assetId, {
      expectedContentHash: record.checksumSha256,
    })).rejects.toMatchObject({ code: "COMPOSE_INPUT_INVALID" });
    expect(reads).toBe(2);

    const dir = await mkdtemp(join(tmpdir(), "episode-export-latch-"));
    created.push(dir);
    process.env.M4_EPISODE_EXPORT_LATCH_DIR = dir;
    reads = 0;
    const pending = studio.exportEpisodeComposite(projectId, episodeId, assetId, {
      expectedContentHash: record.checksumSha256,
    });
    const readyAt = Date.now();
    while (Date.now() - readyAt < 5_000) {
      try {
        await writeFile(join(dir, "seen"), "");
        const { lstat } = await import("node:fs/promises");
        await lstat(join(dir, "ready"));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    allowSecond = false;
    await writeFile(join(dir, "release"), "");
    await expect(pending).rejects.toMatchObject({ code: "COMPOSE_INPUT_INVALID" });
  });

  it("returns the verified bytes only when the second eligibility check still matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "episode-export-ok-"));
    created.push(root);
    const bytes = Buffer.from("same-bytes");
    const record = facts(bytes);
    await mkdir(join(root, "compose", workspaceId, projectId, record.jobId, record.attemptId), { recursive: true });
    await writeFile(join(root, record.objectKey), bytes);
    const studio = new StudioService(
      {} as never, {} as never, {} as never, workspaceId, undefined,
      { inspectEpisodeCompositeExport: async () => record } as unknown as MediaAssetStore,
      false, null, false, false, false, root, true,
    );
    const exported = await studio.exportEpisodeComposite(projectId, episodeId, assetId, {
      expectedContentHash: record.checksumSha256,
    });
    expect(exported.bytes).toEqual(bytes);
    expect(exported.filenameStem).toBe(`episode-01-${assetId}`);
    expect(exported.manifest.asset.checksumSha256).toBe(record.checksumSha256);
    expect(JSON.stringify(exported.manifest)).not.toContain(record.objectKey);
    const closed = new StudioService({} as never, {} as never, {} as never, workspaceId);
    await expect(closed.exportEpisodeComposite(projectId, episodeId, assetId, {
      expectedContentHash: record.checksumSha256,
    })).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
  });
});
