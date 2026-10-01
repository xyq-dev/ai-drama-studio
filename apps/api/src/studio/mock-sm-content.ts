import { MOCK_AUDIO_FIXTURE, MOCK_SUBTITLE_FIXTURE } from "@ai-drama/providers";
import { PersistenceError, type MediaAssetRecord } from "@ai-drama/database";
import { MAX_MOCK_PNG_BYTES, readBoundedMockObject } from "./mock-image-content";

const SUBTITLE_KEY = /^mock-subtitles\/([^/]+)\/([^/]+)\/([0-9a-f]{64})\.vtt$/;
const MUSIC_KEY = /^mock-music\/([^/]+)\/([^/]+)\/([0-9a-f]{64})\.wav$/;

export function assertReadableMockSm(asset: MediaAssetRecord): void {
  if (asset.status === "DELETED" || asset.status === "FAILED") {
    throw new PersistenceError("NOT_FOUND", "Asset content is unavailable");
  }
  const fixture = asset.kind === "SUBTITLE" && asset.mimeType === "text/vtt"
    ? MOCK_SUBTITLE_FIXTURE
    : asset.kind === "MUSIC" && asset.mimeType === "audio/wav"
      ? MOCK_AUDIO_FIXTURE
      : null;
  if (!fixture || asset.storageProvider !== "mock-object-store" || !asset.sourceGenerationJobId) {
    throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content is not a stored mock recording");
  }
  const pattern = asset.kind === "SUBTITLE" ? SUBTITLE_KEY : MUSIC_KEY;
  const match = pattern.exec(asset.objectKey);
  if (
    !match ||
    match[1] !== asset.projectId ||
    match[2] !== asset.sourceGenerationJobId ||
    match[3] !== asset.checksumSha256 ||
    asset.checksumSha256 !== fixture.checksumSha256 ||
    asset.byteSize !== fixture.byteLength ||
    asset.durationMs !== fixture.durationMs ||
    asset.width !== null ||
    asset.height !== null
  ) {
    throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content is not a stored mock recording");
  }
}

export async function readBoundedMockSm(
  root: string,
  asset: MediaAssetRecord,
): Promise<Buffer> {
  assertReadableMockSm(asset);
  const fixture = asset.kind === "SUBTITLE" ? MOCK_SUBTITLE_FIXTURE : MOCK_AUDIO_FIXTURE;
  const bytes = await readBoundedMockObject(root, asset.objectKey, {
    byteSize: asset.byteSize,
    checksumSha256: asset.checksumSha256,
  }, {
    keyPattern: asset.kind === "SUBTITLE" ? SUBTITLE_KEY : MUSIC_KEY,
    minimumBytes: 1,
    invalidMessage: "Asset content is not a stored mock recording",
  });
  if (bytes.length > MAX_MOCK_PNG_BYTES || !bytes.equals(fixture.bytes)) {
    throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content does not match its record");
  }
  if (asset.kind === "SUBTITLE" && bytes.toString("utf8") !== fixture.bytes.toString("utf8")) {
    throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content does not match its record");
  }
  return bytes;
}
