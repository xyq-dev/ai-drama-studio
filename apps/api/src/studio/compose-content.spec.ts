import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaAssetRecord } from "@ai-drama/database";
import { afterEach, describe, expect, it } from "vitest";
import { readCompositeContent } from "./compose-content";

const created: string[] = [];
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "compose-read-"));
  created.push(dir);
  return dir;
}

function record(bytes: Buffer, objectKey: string): MediaAssetRecord {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    projectId,
    kind: "COMPOSITE",
    storageProvider: "local-compose",
    objectKey,
    mimeType: "video/mp4",
    byteSize: bytes.length,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    width: 1080,
    height: 1920,
    status: "ACTIVE",
    reviewStatus: "DRAFT",
    sourceJobAttemptId: attemptId,
    sourceGenerationJobId: jobId,
    sourceShotRevisionId: null,
    providerRequestId: null,
    durationMs: 1000,
    rowVersion: 1,
    createdAt: "2026-10-02T00:00:00.000Z",
  };
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("local composite content paths", () => {
  it("rejects an intermediate symlink instead of reading the outside file", async () => {
    const root = await tempDir();
    const outside = await tempDir();
    const secret = Buffer.from("secret-bytes");
    await writeFile(join(outside, "secret.mp4"), secret);
    const asset = record(secret, "");
    const key = `compose/${workspaceId}/${projectId}/${jobId}/${attemptId}/${asset.checksumSha256}.mp4`;
    await symlink(outside, join(root, "compose"), process.platform === "win32" ? "junction" : "dir");
    await expect(readCompositeContent(root, workspaceId, { ...asset, objectKey: key })).rejects.toThrow(/local composite/);
    expect(await readFile(join(outside, "secret.mp4"))).toEqual(secret);
  });
});
