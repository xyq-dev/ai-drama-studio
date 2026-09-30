import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { PersistenceError, type MediaAssetRecord } from "@ai-drama/database";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MOCK_IMAGE_KEY = /^mock-images\/([^/]+)\/([^/]+)\/([0-9a-f]{64})\.png$/;

export function assertReadableMockImage(asset: MediaAssetRecord): void {
  if (asset.status === "DELETED" || asset.status === "FAILED") {
    throw new PersistenceError("NOT_FOUND", "Asset content is unavailable");
  }
  if (asset.storageProvider !== "mock-object-store" || asset.kind !== "IMAGE" || asset.mimeType !== "image/png") {
    throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content is not a stored mock image");
  }
  if (!asset.sourceGenerationJobId) {
    throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content is not a stored mock image");
  }
  const match = MOCK_IMAGE_KEY.exec(asset.objectKey);
  if (
    !match ||
    match[1] !== asset.projectId ||
    match[2] !== asset.sourceGenerationJobId ||
    match[3] !== asset.checksumSha256
  ) {
    throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content is not a stored mock image");
  }
}

export async function readBoundedMockPng(
  root: string,
  objectKey: string,
  expected: { byteSize: number; checksumSha256: string },
): Promise<Buffer> {
  if (!isAbsolute(root) || !MOCK_IMAGE_KEY.test(objectKey)) {
    throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content is not a stored mock image");
  }
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    throw new PersistenceError("CONFIGURATION_ERROR", "Mock image storage is not configured");
  }
  const segments = objectKey.split("/");
  let current = rootReal;
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content is not a stored mock image");
    }
    const next = join(current, segment);
    let linked: boolean;
    try {
      linked = (await lstat(next)).isSymbolicLink();
    } catch {
      throw new PersistenceError("NOT_FOUND", "Asset content is unavailable");
    }
    if (linked) throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content is not a stored mock image");
    let resolved: string;
    try {
      resolved = await realpath(next);
    } catch {
      throw new PersistenceError("NOT_FOUND", "Asset content is unavailable");
    }
    if (!isInside(rootReal, resolved)) {
      throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content is not a stored mock image");
    }
    current = resolved;
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(current);
  } catch {
    throw new PersistenceError("NOT_FOUND", "Asset content is unavailable");
  }
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== expected.byteSize || checksum !== expected.checksumSha256 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content does not match its record");
  }
  return bytes;
}

function isInside(root: string, target: string): boolean {
  const left = process.platform === "win32" ? root.toLowerCase() : root;
  const right = process.platform === "win32" ? target.toLowerCase() : target;
  const prefix = left.endsWith(sep) ? left : `${left}${sep}`;
  return right.startsWith(prefix);
}
