import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { crc32 } from "node:zlib";
import { PersistenceError, type MediaAssetRecord } from "@ai-drama/database";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MOCK_IMAGE_KEY = /^mock-images\/([^/]+)\/([^/]+)\/([0-9a-f]{64})\.png$/;
/** Hard ceiling for a development Mock PNG. Larger files are rejected before the body is read. */
export const MAX_MOCK_PNG_BYTES = 1024 * 1024;

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
  const bytes = await readBoundedMockObject(root, objectKey, expected, {
    keyPattern: MOCK_IMAGE_KEY,
    minimumBytes: PNG_SIGNATURE.length,
    invalidMessage: "Asset content is not a stored mock image",
  });
  assertPngBytes(bytes);
  return bytes;
}

/** Error codes that prove the path does not exist. Anything else is an operational failure, not a missing object. */
const MISSING_PATH_CODES = new Set(["ENOENT", "ENOTDIR"]);

function isMissingPath(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && MISSING_PATH_CODES.has(code);
}

/**
 * NOT_FOUND only when the filesystem proved the object is absent. Permission, file-handle and I/O failures become
 * ASSET_STORAGE_ERROR so callers (for example input reuse) never mistake them for a missing object. The message
 * never carries the path.
 */
function storageFailure(error: unknown): PersistenceError {
  return isMissingPath(error)
    ? new PersistenceError("NOT_FOUND", "Asset content is unavailable")
    : new PersistenceError("ASSET_STORAGE_ERROR", "Asset storage could not be read");
}

export async function readBoundedMockObject(
  root: string,
  objectKey: string,
  expected: { byteSize: number; checksumSha256: string },
  rules: { keyPattern: RegExp; minimumBytes: number; invalidMessage: string },
): Promise<Buffer> {
  if (!isAbsolute(root) || !rules.keyPattern.test(objectKey)) {
    throw new PersistenceError("ASSET_CONTENT_INVALID", rules.invalidMessage);
  }
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch (error) {
    if (isMissingPath(error)) throw new PersistenceError("CONFIGURATION_ERROR", "Mock object storage is not configured");
    throw new PersistenceError("ASSET_STORAGE_ERROR", "Asset storage could not be read");
  }
  const segments = objectKey.split("/");
  let current = rootReal;
  let info: Awaited<ReturnType<typeof lstat>> | null = null;
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new PersistenceError("ASSET_CONTENT_INVALID", rules.invalidMessage);
    }
    const next = join(current, segment);
    try {
      info = await lstat(next);
    } catch (error) {
      throw storageFailure(error);
    }
    if (info.isSymbolicLink()) {
      throw new PersistenceError("ASSET_CONTENT_INVALID", rules.invalidMessage);
    }
    let resolved: string;
    try {
      resolved = await realpath(next);
    } catch (error) {
      throw storageFailure(error);
    }
    if (!isInside(rootReal, resolved)) {
      throw new PersistenceError("ASSET_CONTENT_INVALID", rules.invalidMessage);
    }
    current = resolved;
  }
  if (!info?.isFile()) {
    throw new PersistenceError("ASSET_CONTENT_INVALID", rules.invalidMessage);
  }
  if (
    !Number.isSafeInteger(expected.byteSize) ||
    expected.byteSize < rules.minimumBytes ||
    expected.byteSize > MAX_MOCK_PNG_BYTES ||
    info.size > MAX_MOCK_PNG_BYTES ||
    info.size !== expected.byteSize
  ) {
    throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content does not match its record");
  }
  const bytes = Buffer.alloc(expected.byteSize);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(current, "r");
  } catch (error) {
    throw storageFailure(error);
  }
  try {
    const { bytesRead } = await handle.read(bytes, 0, expected.byteSize, 0);
    if (bytesRead !== expected.byteSize) {
      throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content does not match its record");
    }
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    // A read that fails after a successful open is an I/O fault, never proof that the object is missing.
    throw new PersistenceError("ASSET_STORAGE_ERROR", "Asset storage could not be read");
  } finally {
    await handle.close();
  }
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (checksum !== expected.checksumSha256) {
    throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content does not match its record");
  }
  return bytes;
}

function assertPngBytes(bytes: Buffer): void {
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content does not match its record");
  }
  let offset = PNG_SIGNATURE.length;
  let sawHeader = false;
  let sawEnd = false;
  let sawIdat = false;
  let idatClosed = false;
  let idatLength = 0;
  while (offset < bytes.length) {
    if (sawEnd || bytes.length - offset < 12) {
      throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content does not match its record");
    }
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) {
      throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content does not match its record");
    }
    const type = bytes.subarray(offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const storedCrc = bytes.readUInt32BE(offset + 8 + length);
    const computedCrc = crc32(Buffer.concat([type, data])) >>> 0;
    if (computedCrc !== storedCrc) {
      throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content does not match its record");
    }
    const name = type.toString("latin1");
    if (!sawHeader) {
      if (name !== "IHDR" || length !== 13 || !validIhdr(data)) {
        throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content does not match its record");
      }
      sawHeader = true;
    } else if (name === "IHDR") {
      throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content does not match its record");
    }
    if (name === "IDAT") {
      if (idatClosed) {
        throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content does not match its record");
      }
      sawIdat = true;
      idatLength += length;
    } else if (sawIdat) {
      idatClosed = true;
    }
    offset += 12 + length;
    if (name === "IEND") {
      if (length !== 0 || offset !== bytes.length) {
        throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content does not match its record");
      }
      sawEnd = true;
    }
  }
  if (!sawHeader || !sawEnd || !sawIdat || idatLength === 0) {
    throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content does not match its record");
  }
}

function validIhdr(data: Buffer): boolean {
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const bitDepth = data[8] ?? 0;
  const colorType = data[9] ?? 0;
  const compression = data[10] ?? 1;
  const filter = data[11] ?? 1;
  const interlace = data[12] ?? 2;
  if (width === 0 || height === 0 || compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)) {
    return false;
  }
  const allowed: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  return allowed[colorType]?.includes(bitDepth) ?? false;
}

function isInside(root: string, target: string): boolean {
  const left = process.platform === "win32" ? root.toLowerCase() : root;
  const right = process.platform === "win32" ? target.toLowerCase() : target;
  const prefix = left.endsWith(sep) ? left : `${left}${sep}`;
  return right.startsWith(prefix);
}
