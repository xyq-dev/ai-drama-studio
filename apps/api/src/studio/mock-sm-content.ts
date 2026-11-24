import { isMockDialogueSubtitle, MAX_MOCK_SUBTITLE_BYTES, MOCK_AUDIO_FIXTURE, MOCK_SUBTITLE_DURATION_MS, MOCK_SUBTITLE_FIXTURE } from "@ai-drama/providers";
import { PersistenceError, type MediaAssetRecord } from "@ai-drama/database";
import { readBoundedMockObject } from "./mock-image-content";

const SUBTITLE_KEY = /^mock-subtitles\/([^/]+)\/([^/]+)\/([0-9a-f]{64})\.vtt$/;
const MUSIC_KEY = /^mock-music\/([^/]+)\/([^/]+)\/([0-9a-f]{64})\.wav$/;

export function assertReadableMockSm(asset: MediaAssetRecord): void {
  if (asset.status === "DELETED" || asset.status === "FAILED") {
    throw new PersistenceError("NOT_FOUND", "Asset content is unavailable");
  }
  const isSubtitle = asset.kind === "SUBTITLE" && asset.mimeType === "text/vtt";
  const isMusic = asset.kind === "MUSIC" && asset.mimeType === "audio/wav";
  const fixed = isSubtitle ? MOCK_SUBTITLE_FIXTURE : MOCK_AUDIO_FIXTURE;
  const fixedRecording = asset.durationMs === fixed.durationMs && asset.byteSize === fixed.byteLength
    && asset.checksumSha256 === fixed.checksumSha256;
  const dialogueRecording = isSubtitle && asset.durationMs === MOCK_SUBTITLE_DURATION_MS
    && Number.isSafeInteger(asset.byteSize) && asset.byteSize > 0 && asset.byteSize <= MAX_MOCK_SUBTITLE_BYTES;
  if ((!isSubtitle && !isMusic) || (!fixedRecording && !dialogueRecording)
    || asset.storageProvider !== "mock-object-store" || !asset.sourceGenerationJobId) {
    throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content is not a stored mock recording");
  }
  const pattern = asset.kind === "SUBTITLE" ? SUBTITLE_KEY : MUSIC_KEY;
  const match = pattern.exec(asset.objectKey);
  if (
    !match ||
    match[1] !== asset.projectId ||
    match[2] !== asset.sourceGenerationJobId ||
    match[3] !== asset.checksumSha256 ||
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
  const bytes = await readBoundedMockObject(root, asset.objectKey, {
    byteSize: asset.byteSize,
    checksumSha256: asset.checksumSha256,
  }, {
    keyPattern: asset.kind === "SUBTITLE" ? SUBTITLE_KEY : MUSIC_KEY,
    minimumBytes: 1,
    invalidMessage: "Asset content is not a stored mock recording",
  });
  if (asset.kind === "SUBTITLE" && asset.durationMs === MOCK_SUBTITLE_DURATION_MS && !isMockDialogueSubtitle(bytes)) {
    throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content does not match its record");
  }
  return bytes;
}
