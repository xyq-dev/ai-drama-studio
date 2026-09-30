import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { MockImageObjectStore } from "./mock-image-generation";

/** Explicitly configured Mock-only local storage; deterministic keys make recovery idempotent. */
export class LocalMockObjects implements MockImageObjectStore {
  constructor(private readonly directory: string) {}

  async put(input: {
    key: string;
    bytes: Buffer;
    mimeType: "image/png" | "video/mp4" | "audio/wav";
    checksumSha256: string;
  }): Promise<void> {
    if (!allowedMockObject(input.key, input.mimeType)) {
      throw new Error("Invalid Mock object key");
    }
    if (createHash("sha256").update(input.bytes).digest("hex") !== input.checksumSha256) {
      throw new Error("Mock object checksum mismatch");
    }
    const path = join(resolve(this.directory), input.key);
    await mkdir(dirname(path), { recursive: true });
    try {
      const existing = await readFile(path);
      if (!existing.equals(input.bytes)) throw new Error("Mock object key contains different bytes");
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx");
      try {
        await handle.writeFile(input.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
      const directoryHandle = await open(dirname(path), "r");
      try {
        try {
          await directoryHandle.sync();
        } catch (error) {
          // Non-production Windows NTFS rejects directory fsync with EPERM.
          // File bytes were already synced before rename. Continuing here does
          // not make the directory entry durable across power loss and is not
          // equivalent to a successful directory fsync.
          if (process.platform !== "win32" || !isDirectorySyncEperm(error)) throw error;
        }
      } finally {
        await directoryHandle.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

function allowedMockObject(key: string, mimeType: "image/png" | "video/mp4" | "audio/wav"): boolean {
  if (mimeType === "image/png") return /^mock-images\/[0-9a-f-]+\/[0-9a-f-]+\/[0-9a-f]{64}\.png$/.test(key);
  if (mimeType === "video/mp4") return /^mock-videos\/[0-9a-f-]+\/[0-9a-f-]+\/[0-9a-f]{64}\.mp4$/.test(key);
  return /^mock-audio\/[0-9a-f-]+\/[0-9a-f-]+\/[0-9a-f]{64}\.wav$/.test(key);
}

function isDirectorySyncEperm(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
}
