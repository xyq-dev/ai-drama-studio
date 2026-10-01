import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { PersistenceError, type MediaAssetRecord } from "@ai-drama/database";

const COMPOSE_KEY = /^compose\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f]{64})\.mp4$/;
const MAX_COMPOSE_BYTES = 64 * 1024 * 1024;

export async function readCompositeContent(
  root: string,
  workspaceId: string,
  asset: MediaAssetRecord,
): Promise<{ mimeType: string; bytes: Buffer }> {
  if (!isAbsolute(root)) throw new PersistenceError("CONFIGURATION_ERROR", "Local compose content is not enabled");
  if (asset.status === "DELETED" || asset.status === "FAILED") {
    throw new PersistenceError("NOT_FOUND", "Asset content is unavailable");
  }
  if (asset.kind !== "COMPOSITE" || asset.mimeType !== "video/mp4" || asset.storageProvider !== "local-compose") {
    throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content is not a local composite");
  }
  if (asset.providerRequestId !== null || !asset.sourceGenerationJobId || !asset.sourceJobAttemptId) {
    throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content is not a local composite");
  }
  const match = COMPOSE_KEY.exec(asset.objectKey);
  if (
    !match ||
    match[1] !== workspaceId ||
    match[2] !== asset.projectId ||
    match[3] !== asset.sourceGenerationJobId ||
    match[4] !== asset.sourceJobAttemptId ||
    match[5] !== asset.checksumSha256 ||
    asset.byteSize <= 0 ||
    asset.byteSize > MAX_COMPOSE_BYTES
  ) {
    throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content is not a local composite");
  }
  const base = await realpath(root);
  const absolute = resolve(base, asset.objectKey);
  if (!absolute.startsWith(base.endsWith(sep) ? base : base + sep)) {
    throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content is not a local composite");
  }
  const info = await lstat(absolute).catch(() => {
    throw new PersistenceError("NOT_FOUND", "Asset content is unavailable");
  });
  if (!info.isFile() || info.isSymbolicLink() || info.size !== asset.byteSize || info.size > MAX_COMPOSE_BYTES) {
    throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content does not match its record");
  }
  const handle = await open(absolute, "r");
  try {
    const bytes = await handle.readFile();
    if (bytes.length !== asset.byteSize || createHash("sha256").update(bytes).digest("hex") !== asset.checksumSha256) {
      throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content does not match its record");
    }
    return { mimeType: "video/mp4", bytes };
  } finally {
    await handle.close();
  }
}
