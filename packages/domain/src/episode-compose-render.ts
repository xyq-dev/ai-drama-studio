import { DomainError } from "./errors";
import { canonicalInputHash } from "./text-chain";
import { COMPOSE_OUTPUT_MAX_BYTES } from "./compose-render";
import {
  EPISODE_COMPOSE_PREFLIGHT_SCHEMA,
  type EpisodeComposePreflightResponse,
} from "./episode-compose-preflight";

export const EPISODE_COMPOSE_JOB_SCHEMA = "m4.episode.compose.v1";
export const EPISODE_COMPOSE_OUTPUT_SCHEMA = "m4.episode.compose.asset.v1";
export const EPISODE_RENDER_PROFILE_ID = "local-ffmpeg-episode-v1";

export const EPISODE_RENDER_PROFILE = {
  id: EPISODE_RENDER_PROFILE_ID,
  width: 1080,
  height: 1920,
  frameRate: 25,
  sar: "1",
  container: "mp4",
  videoCodec: "libx264",
  pixelFormat: "yuv420p",
  crf: 23,
  preset: "veryfast",
  audioCodec: "aac",
  audioSampleRate: 48000,
  audioChannels: 2,
  faststart: true,
  cut: "hard-cut-in-order",
  audio: "keep-segment-audio",
  subtitles: "already-burned",
  ffmpegThreads: 2,
  decodeThreads: 2,
  renderTimeoutSec: 300,
  probeTimeoutSec: 30,
  maxOutputBytes: COMPOSE_OUTPUT_MAX_BYTES,
  maxInputBytes: COMPOSE_OUTPUT_MAX_BYTES,
  maxSegments: 30,
} as const;

const REQUEST_KEYS = ["compositeAssetIds", "expectedInputHash"] as const;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface EpisodeComposeRenderRequest {
  compositeAssetIds: string[];
  expectedInputHash: string;
}

export interface EpisodeComposeSourceObject {
  assetId: string;
  shotId: string;
  shotRevisionId: string;
  storageProvider: string;
  objectKey: string;
  byteSize: number;
  checksumSha256: string;
  durationMs: number;
  startMs: number;
  endMs: number;
}

export interface EpisodeComposeJobSnapshot {
  schema: typeof EPISODE_COMPOSE_JOB_SCHEMA;
  input: {
    workspaceId: string;
    projectId: string;
    episodeId: string;
    manifest: EpisodeComposePreflightResponse["manifest"];
    renderProfile: typeof EPISODE_RENDER_PROFILE;
    sourceObjects: EpisodeComposeSourceObject[];
  };
  preflightInputHash: string;
  guards: EpisodeComposePreflightResponse["guards"];
}

export function parseEpisodeComposeRenderRequest(body: unknown): EpisodeComposeRenderRequest {
  if (!isPlainObject(body)) fail("Episode compose body must be an object");
  const keys = Object.keys(body);
  if (keys.length !== REQUEST_KEYS.length || keys.some((key) => !REQUEST_KEYS.includes(key as typeof REQUEST_KEYS[number]))) {
    fail("Episode compose contains an unknown field");
  }
  const ids = body.compositeAssetIds;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !UUID_TEXT.test(id))) {
    fail("compositeAssetIds must contain UUIDs");
  }
  if (typeof body.expectedInputHash !== "string" || !/^[0-9a-f]{64}$/.test(body.expectedInputHash)) {
    fail("expectedInputHash must be a lowercase sha256");
  }
  return {
    compositeAssetIds: ids.map((id) => id.toLowerCase()),
    expectedInputHash: body.expectedInputHash,
  };
}

export function buildEpisodeComposeJobSnapshot(
  preflight: EpisodeComposePreflightResponse,
  sourceObjects: readonly EpisodeComposeSourceObject[],
): { snapshot: EpisodeComposeJobSnapshot; inputHash: string } {
  if (preflight.schema !== EPISODE_COMPOSE_PREFLIGHT_SCHEMA) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Episode compose preflight schema is not current");
  }
  const segments = preflight.manifest.segments;
  if (sourceObjects.length !== segments.length) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Episode compose sources do not match the manifest");
  }
  sourceObjects.forEach((source, index) => {
    const segment = segments[index];
    if (
      !segment
      || source.assetId !== segment.assetId
      || source.shotId !== segment.shotId
      || source.shotRevisionId !== segment.shotRevisionId
      || source.checksumSha256 !== segment.checksumSha256
      || source.byteSize !== segment.byteSize
      || source.durationMs !== segment.durationMs
      || source.startMs !== segment.startMs
      || source.endMs !== segment.endMs
    ) {
      throw new DomainError("COMPOSE_INPUT_INVALID", "Episode compose source does not match the manifest");
    }
    if (source.storageProvider !== "local-compose" || !/^[0-9a-f]{64}$/.test(source.checksumSha256)) {
      throw new DomainError("COMPOSE_INPUT_INVALID", "Episode compose source is not a local composite");
    }
    if (source.objectKey.includes("..") || source.objectKey.startsWith("/") || source.objectKey.includes("\\")) {
      throw new DomainError("COMPOSE_INPUT_INVALID", "Episode compose source key is not usable");
    }
  });
  const input = {
    workspaceId: preflight.manifest.workspaceId,
    projectId: preflight.manifest.projectId,
    episodeId: preflight.manifest.episodeId,
    manifest: preflight.manifest,
    renderProfile: EPISODE_RENDER_PROFILE,
    sourceObjects: sourceObjects.map((item) => ({ ...item })),
  };
  const snapshot: EpisodeComposeJobSnapshot = {
    schema: EPISODE_COMPOSE_JOB_SCHEMA,
    input,
    preflightInputHash: preflight.inputHash,
    guards: preflight.guards,
  };
  return { snapshot, inputHash: canonicalInputHash(input) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new DomainError("VALIDATION_ERROR", message);
}
