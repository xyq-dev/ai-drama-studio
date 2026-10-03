import { DomainError } from "./errors";
import { canonicalInputHash } from "./text-chain";
import {
  COMPOSE_PREFLIGHT_SCHEMA,
  type ComposePreflightResponse,
  type ComposePreflightSelection,
  parseComposePreflightRequest,
} from "./compose-preflight";

export const COMPOSE_JOB_SCHEMA = "m4.shot.compose.v1";
export const COMPOSE_RENDER_PROFILE_ID = "local-ffmpeg-v1";
export const COMPOSE_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;

export const COMPOSE_RENDER_PROFILE = {
  id: COMPOSE_RENDER_PROFILE_ID,
  width: 1080,
  height: 1920,
  frameRate: 25,
  container: "mp4",
  videoCodec: "libx264",
  pixelFormat: "yuv420p",
  crf: 23,
  preset: "veryfast",
  faststart: true,
  videoFit: "contain-center-black",
  sar: "1",
  stretchTimeline: false,
  includeSourceAudio: false,
  speechGain: 1,
  musicGain: 0.25,
  peakLimit: true,
  audioCodec: "aac",
  audioSampleRate: 48000,
  audioChannels: 2,
  silenceWhenNoAudio: true,
  audioOverflow: "trim-to-video-end",
  audioUnderflow: "pad-silence",
  audioLoop: false,
  musicOverflow: "trim-to-video-end",
  musicUnderflow: "pad-silence",
  musicLoop: false,
  subtitleMode: "burn-in-plain-text",
  fontId: "dejavu-sans",
  fontStyleVersion: "m4-subtitle-style-v1",
  ffmpegThreads: 2,
  renderTimeoutSec: 300,
  probeTimeoutSec: 30,
  maxOutputBytes: COMPOSE_OUTPUT_MAX_BYTES,
} as const;

const RENDER_KEYS = ["videoAssetId", "audioAssetId", "musicAssetId", "subtitleAssetId", "expectedInputHash"] as const;

export interface ComposeRenderRequest extends ComposePreflightSelection {
  expectedInputHash: string;
}

export interface ComposeSourceObject {
  role: "video" | "audio" | "music" | "subtitle";
  assetId: string;
  storageProvider: string;
  objectKey: string;
  byteSize: number;
  checksumSha256: string;
}

export interface ComposeJobSnapshot {
  schema: typeof COMPOSE_JOB_SCHEMA;
  input: {
    manifest: ComposePreflightResponse["manifest"];
    renderProfile: typeof COMPOSE_RENDER_PROFILE;
    sourceObjects: ComposeSourceObject[];
  };
  preflightInputHash: string;
  guards: ComposePreflightResponse["guards"];
}

export function parseComposeRenderRequest(body: unknown): ComposeRenderRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new DomainError("VALIDATION_ERROR", "Request body is invalid");
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!RENDER_KEYS.includes(key as (typeof RENDER_KEYS)[number])) {
      throw new DomainError("VALIDATION_ERROR", "Request body is invalid");
    }
  }
  if (typeof record.expectedInputHash !== "string" || !/^[0-9a-f]{64}$/.test(record.expectedInputHash)) {
    throw new DomainError("VALIDATION_ERROR", "Request body is invalid");
  }
  const selection = parseComposePreflightRequest({
    videoAssetId: record.videoAssetId,
    ...(Object.hasOwn(record, "audioAssetId") ? { audioAssetId: record.audioAssetId } : {}),
    ...(Object.hasOwn(record, "musicAssetId") ? { musicAssetId: record.musicAssetId } : {}),
    ...(Object.hasOwn(record, "subtitleAssetId") ? { subtitleAssetId: record.subtitleAssetId } : {}),
  });
  return { ...selection, expectedInputHash: record.expectedInputHash };
}

export function parseComposeReviewRequest(body: unknown): { decision: "APPROVE" | "REJECT"; note: string; contentHash: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new DomainError("VALIDATION_ERROR", "Request body is invalid");
  }
  const record = body as Record<string, unknown>;
  const keys = ["decision", "note", "contentHash"];
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) throw new DomainError("VALIDATION_ERROR", "Request body is invalid");
  }
  if (record.decision !== "APPROVE" && record.decision !== "REJECT") {
    throw new DomainError("VALIDATION_ERROR", "Request body is invalid");
  }
  if (typeof record.note !== "string" || record.note.length > 500) {
    throw new DomainError("VALIDATION_ERROR", "Request body is invalid");
  }
  if (typeof record.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(record.contentHash)) {
    throw new DomainError("VALIDATION_ERROR", "Request body is invalid");
  }
  return { decision: record.decision, note: record.note, contentHash: record.contentHash };
}

export function buildComposeJobSnapshot(
  preflight: ComposePreflightResponse,
  sourceObjects: readonly ComposeSourceObject[],
): { snapshot: ComposeJobSnapshot; inputHash: string } {
  if (preflight.schema !== COMPOSE_PREFLIGHT_SCHEMA) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Compose preflight schema is not current");
  }
  const roles = sourceObjects.map((item) => item.role);
  const expected = preflight.manifest.sources.flatMap((slot) => (slot.asset ? [slot.role] : []));
  if (roles.join() !== expected.join()) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Compose source objects do not match the manifest");
  }
  for (const source of sourceObjects) {
    const slot = preflight.manifest.sources.find((item) => item.role === source.role);
    if (!slot?.asset || slot.asset.assetId !== source.assetId || slot.asset.checksumSha256 !== source.checksumSha256 || slot.asset.byteSize !== source.byteSize) {
      throw new DomainError("COMPOSE_INPUT_INVALID", "Compose source object does not match the manifest");
    }
    if (source.storageProvider !== "mock-object-store" || !/^[0-9a-f]{64}$/.test(source.checksumSha256)) {
      throw new DomainError("COMPOSE_INPUT_INVALID", "Compose source object is not a stored mock file");
    }
    if (source.objectKey.includes("..") || source.objectKey.startsWith("/") || source.objectKey.includes("\\")) {
      throw new DomainError("COMPOSE_INPUT_INVALID", "Compose source object key is not usable");
    }
  }
  const input = {
    manifest: preflight.manifest,
    renderProfile: COMPOSE_RENDER_PROFILE,
    sourceObjects: sourceObjects.map((item) => ({ ...item })),
  };
  const snapshot: ComposeJobSnapshot = {
    schema: COMPOSE_JOB_SCHEMA,
    input,
    preflightInputHash: preflight.inputHash,
    guards: preflight.guards,
  };
  return { snapshot, inputHash: canonicalInputHash(input) };
}

export function assertExpectedPreflightHash(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new DomainError("COMPOSE_INPUT_CHANGED", "Compose inputs changed since the preflight");
  }
}
