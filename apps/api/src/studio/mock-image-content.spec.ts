import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PersistenceError, type MediaAssetRecord } from "@ai-drama/database";
import { MAX_MOCK_PNG_BYTES, assertReadableMockImage, readBoundedMockPng } from "./mock-image-content";

const projectId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const checksum = createHash("sha256").update(PNG).digest("hex");
const key = `mock-images/${projectId}/${jobId}/${checksum}.png`;

function asset(overrides: Partial<MediaAssetRecord> = {}): MediaAssetRecord {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    projectId,
    kind: "IMAGE",
    storageProvider: "mock-object-store",
    objectKey: key,
    mimeType: "image/png",
    byteSize: PNG.length,
    checksumSha256: checksum,
    width: 1,
    height: 1,
    status: "ACTIVE",
    reviewStatus: "DRAFT",
    sourceJobAttemptId: "44444444-4444-4444-8444-444444444444",
    sourceGenerationJobId: jobId,
    sourceShotRevisionId: "55555555-5555-4555-8555-555555555555",
    providerRequestId: null,
    createdAt: "2026-09-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("mock image content", () => {
  const root = resolve(tmpdir(), `m3-content-${process.pid}`);

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });

  it("reads a matching PNG and rejects status, identity, traversal, and content mismatches", async () => {
    await mkdir(join(root, "mock-images", projectId, jobId), { recursive: true });
    await writeFile(join(root, key), PNG);
    expect(assertReadableMockImage(asset())).toBeUndefined();
    await expect(readBoundedMockPng(root, key, { byteSize: PNG.length, checksumSha256: checksum })).resolves.toEqual(PNG);

    expect(() => assertReadableMockImage(asset({ status: "DELETED" }))).toThrow(PersistenceError);
    expect(() => assertReadableMockImage(asset({ status: "FAILED" }))).toThrow(/unavailable/);
    expect(() => assertReadableMockImage(asset({ storageProvider: "s3" }))).toThrow(/not a stored mock image/);
    expect(() => assertReadableMockImage(asset({ objectKey: "../secret.png" }))).toThrow(/not a stored mock image/);
    expect(() => assertReadableMockImage(asset({ checksumSha256: "a".repeat(64) }))).toThrow(/not a stored mock image/);

    await expect(readBoundedMockPng(root, `mock-images/${projectId}/${jobId}/${"b".repeat(64)}.png`, {
      byteSize: PNG.length,
      checksumSha256: "b".repeat(64),
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    await writeFile(join(root, "mock-images", projectId, jobId, `${"c".repeat(64)}.png`), Buffer.from("not-a-png"));
    await expect(readBoundedMockPng(root, `mock-images/${projectId}/${jobId}/${"c".repeat(64)}.png`, {
      byteSize: 9,
      checksumSha256: createHash("sha256").update("not-a-png").digest("hex"),
    })).rejects.toMatchObject({ code: "ASSET_CONTENT_INVALID" });
  });

  it("accepts the fixed PNG fixture and rejects signature-only, truncated, corrupt, oversized, and non-file content", async () => {
    const directory = join(root, "mock-images", projectId, jobId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(root, key), PNG);
    await expect(readBoundedMockPng(root, key, { byteSize: PNG.length, checksumSha256: checksum })).resolves.toEqual(PNG);

    const signature = PNG.subarray(0, 8);
    const signatureSum = createHash("sha256").update(signature).digest("hex");
    const signatureKey = `mock-images/${projectId}/${jobId}/${signatureSum}.png`;
    await writeFile(join(root, signatureKey), signature);
    await expect(readBoundedMockPng(root, signatureKey, { byteSize: signature.length, checksumSha256: signatureSum })).rejects.toMatchObject({
      code: "ASSET_CONTENT_INVALID",
    });

    const truncated = PNG.subarray(0, 16);
    const truncatedSum = createHash("sha256").update(truncated).digest("hex");
    const truncatedKey = `mock-images/${projectId}/${jobId}/${truncatedSum}.png`;
    await writeFile(join(root, truncatedKey), truncated);
    await expect(readBoundedMockPng(root, truncatedKey, { byteSize: truncated.length, checksumSha256: truncatedSum })).rejects.toMatchObject({
      code: "ASSET_CONTENT_INVALID",
    });

    const corrupt = Buffer.from(PNG);
    corrupt[corrupt.length - 1] ^= 0xff;
    const corruptSum = createHash("sha256").update(corrupt).digest("hex");
    const corruptKey = `mock-images/${projectId}/${jobId}/${corruptSum}.png`;
    await writeFile(join(root, corruptKey), corrupt);
    await expect(readBoundedMockPng(root, corruptKey, { byteSize: corrupt.length, checksumSha256: corruptSum })).rejects.toMatchObject({
      code: "ASSET_CONTENT_INVALID",
    });

    const larger = Buffer.concat([PNG, Buffer.from([0])]);
    await writeFile(join(root, key), larger);
    await expect(readBoundedMockPng(root, key, { byteSize: PNG.length, checksumSha256: checksum })).rejects.toMatchObject({
      code: "ASSET_CONTENT_INVALID",
    });

    const cappedSum = "d".repeat(64);
    const cappedKey = `mock-images/${projectId}/${jobId}/${cappedSum}.png`;
    await writeFile(join(root, cappedKey), Buffer.alloc(MAX_MOCK_PNG_BYTES + 1, 1));
    await expect(readBoundedMockPng(root, cappedKey, {
      byteSize: MAX_MOCK_PNG_BYTES + 1,
      checksumSha256: cappedSum,
    })).rejects.toMatchObject({ code: "ASSET_CONTENT_INVALID" });

    const directoryKey = `mock-images/${projectId}/${jobId}/${"e".repeat(64)}.png`;
    await mkdir(join(root, directoryKey));
    await expect(readBoundedMockPng(root, directoryKey, { byteSize: PNG.length, checksumSha256: checksum })).rejects.toMatchObject({
      code: "ASSET_CONTENT_INVALID",
    });
  });

  it("rejects a directory junction that escapes the configured root", async () => {
    const outside = resolve(tmpdir(), `m3-content-outside-${process.pid}`);
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, `${checksum}.png`), PNG);
    await mkdir(join(root, "mock-images", projectId), { recursive: true });
    try {
      await symlink(outside, join(root, "mock-images", projectId, jobId), "junction");
    } catch (error) {
      const { rm } = await import("node:fs/promises");
      await rm(outside, { recursive: true, force: true });
      throw error;
    }
    await expect(readBoundedMockPng(root, key, { byteSize: PNG.length, checksumSha256: checksum })).rejects.toMatchObject({
      code: "ASSET_CONTENT_INVALID",
    });
    const { rm } = await import("node:fs/promises");
    await rm(outside, { recursive: true, force: true });
  });
});
