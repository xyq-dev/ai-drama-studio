import { MOCK_AUDIO_FIXTURE, MOCK_VIDEO_FIXTURE } from "@ai-drama/providers";
import { PersistenceError, type MediaAssetRecord } from "@ai-drama/database";
import { MAX_MOCK_PNG_BYTES, readBoundedMockObject } from "./mock-image-content";

const VIDEO_KEY = /^mock-videos\/([^/]+)\/([^/]+)\/([0-9a-f]{64})\.mp4$/;
const AUDIO_KEY = /^mock-audio\/([^/]+)\/([^/]+)\/([0-9a-f]{64})\.wav$/;

export function assertReadableMockAv(asset: MediaAssetRecord): void {
  if (asset.status === "DELETED" || asset.status === "FAILED") {
    throw new PersistenceError("NOT_FOUND", "Asset content is unavailable");
  }
  const fixture = asset.kind === "VIDEO" && asset.mimeType === "video/mp4"
    ? MOCK_VIDEO_FIXTURE
    : asset.kind === "AUDIO" && asset.mimeType === "audio/wav"
      ? MOCK_AUDIO_FIXTURE
      : null;
  if (!fixture || asset.storageProvider !== "mock-object-store" || !asset.sourceGenerationJobId) {
    throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content is not a stored mock recording");
  }
  const pattern = fixture.mimeType === "video/mp4" ? VIDEO_KEY : AUDIO_KEY;
  const match = pattern.exec(asset.objectKey);
  if (
    !match ||
    match[1] !== asset.projectId ||
    match[2] !== asset.sourceGenerationJobId ||
    match[3] !== asset.checksumSha256 ||
    asset.checksumSha256 !== fixture.checksumSha256 ||
    asset.byteSize !== fixture.byteLength ||
    asset.durationMs !== fixture.durationMs ||
    asset.width !== fixture.width ||
    asset.height !== fixture.height
  ) {
    throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content is not a stored mock recording");
  }
}

export async function readBoundedMockAv(
  root: string,
  asset: MediaAssetRecord,
): Promise<Buffer> {
  assertReadableMockAv(asset);
  const fixture = asset.mimeType === "video/mp4" ? MOCK_VIDEO_FIXTURE : MOCK_AUDIO_FIXTURE;
  const bytes = await readBoundedMockObject(root, asset.objectKey, {
    byteSize: asset.byteSize,
    checksumSha256: asset.checksumSha256,
  }, {
    keyPattern: fixture.mimeType === "video/mp4" ? VIDEO_KEY : AUDIO_KEY,
    minimumBytes: 1,
    invalidMessage: "Asset content is not a stored mock recording",
  });
  if (bytes.length > MAX_MOCK_PNG_BYTES || !bytes.equals(fixture.bytes)) {
    throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content does not match its record");
  }
  return bytes;
}
