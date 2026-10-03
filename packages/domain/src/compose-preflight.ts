import {
  SAMPLE_VIDEO_DESCRIPTIONS,
  frozenSampleFields,
  looksLikeSampleVideoRequestId,
  parseSampleVideoRequestId,
} from "@ai-drama/contracts";
import { DomainError } from "./errors";
import { canonicalInputHash } from "./text-chain";

export const COMPOSE_PREFLIGHT_SCHEMA = "m4.shot.compose.preflight.v1";
export const COMPOSE_VIDEO_DURATION_MAX_MS = 90_000;

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_KEYS = ["videoAssetId", "audioAssetId", "musicAssetId", "subtitleAssetId"] as const;

const OUTPUT_PLAN = {
  width: 1080,
  height: 1920,
  frameRate: 25,
  container: "mp4",
  videoFit: "contain-center-black",
  videoStartMs: 0,
  audioStartMs: 0,
  musicStartMs: 0,
  audioOverflow: "trim-to-video-end",
  audioUnderflow: "pad-silence",
  audioLoop: false,
  musicOverflow: "trim-to-video-end",
  musicUnderflow: "pad-silence",
  musicLoop: false,
  subtitleMode: "burn-in",
  timelineEditable: false,
} as const;

const SLOT_RULES = {
  video: { kind: "VIDEO", mimeType: "video/mp4", jobKind: "MEDIA_VIDEO", capability: "video.generate", dimensions: true },
  audio: { kind: "AUDIO", mimeType: "audio/wav", jobKind: "MEDIA_TTS", capability: "audio.tts", dimensions: false },
  music: { kind: "MUSIC", mimeType: "audio/wav", jobKind: "MEDIA_MUSIC", capability: "audio.music", dimensions: false },
  subtitle: { kind: "SUBTITLE", mimeType: "text/vtt", jobKind: "MEDIA_SUBTITLE", capability: "subtitle.generate", dimensions: false },
} as const;

export type ComposePreflightRole = keyof typeof SLOT_RULES;

export interface ComposePreflightSelection {
  videoAssetId: string;
  audioAssetId: string | null;
  musicAssetId: string | null;
  subtitleAssetId: string | null;
}

export interface ComposeAttemptFacts {
  id: string;
  generationJobId: string;
  attemptNo: number;
  providerRequestId: string | null;
  providerConfigurationId: string | null;
  finished: boolean;
}

export interface ComposeJobFacts {
  id: string;
  workspaceId: string;
  projectId: string;
  shotRevisionId: string | null;
  kind: string;
  state: string;
  inputSnapshot?: unknown;
}

export interface ComposeAssetFacts {
  id: string;
  workspaceId: string;
  projectId: string;
  shotRevisionId: string | null;
  kind: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  status: string;
  reviewStatus: string;
  storageProvider: string;
  sourceGenerationJobId: string | null;
  sourceJobAttemptId: string | null;
  providerRequestId: string | null;
  providerConfigurationId: string | null;
  rowVersion: number;
  metadata?: unknown;
  job: ComposeJobFacts | null;
  attempt: ComposeAttemptFacts | null;
}

export interface ComposePreflightResponse {
  schema: typeof COMPOSE_PREFLIGHT_SCHEMA;
  manifest: {
    workspaceId: string;
    projectId: string;
    shotRevisionId: string;
    sources: Array<{
      role: ComposePreflightRole;
      asset: {
        assetId: string;
        checksumSha256: string;
        kind: string;
        mimeType: string;
        byteSize: number;
        width: number | null;
        height: number | null;
        durationMs: number;
      } | null;
    }>;
    plan: {
      width: 1080;
      height: 1920;
      frameRate: 25;
      container: "mp4";
      videoFit: "contain-center-black";
      videoStartMs: 0;
      audioStartMs: 0;
      musicStartMs: 0;
      audioOverflow: "trim-to-video-end";
      audioUnderflow: "pad-silence";
      audioLoop: false;
      musicOverflow: "trim-to-video-end";
      musicUnderflow: "pad-silence";
      musicLoop: false;
      subtitleMode: "burn-in";
      timelineEditable: false;
      durationMs: number;
    };
  };
  inputHash: string;
  guards: {
    shotRevisionId: string;
    assets: Array<{ role: ComposePreflightRole; assetId: string | null; rowVersion: number | null }>;
  };
}

export function parseComposePreflightRequest(body: unknown): ComposePreflightSelection {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new DomainError("VALIDATION_ERROR", "Request body is invalid");
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!REQUEST_KEYS.includes(key as (typeof REQUEST_KEYS)[number])) {
      throw new DomainError("VALIDATION_ERROR", "Request body is invalid");
    }
  }
  if (!("videoAssetId" in record)) {
    throw new DomainError("VALIDATION_ERROR", "Request body is invalid");
  }
  const videoAssetId = requiredUuid(record.videoAssetId);
  const audioAssetId = optionalUuid(record, "audioAssetId");
  const musicAssetId = optionalUuid(record, "musicAssetId");
  const subtitleAssetId = optionalUuid(record, "subtitleAssetId");
  const ids = [videoAssetId, audioAssetId, musicAssetId, subtitleAssetId].filter((id): id is string => id !== null);
  if (new Set(ids).size !== ids.length) {
    throw new DomainError("VALIDATION_ERROR", "Compose preflight rejects duplicate assets");
  }
  return { videoAssetId, audioAssetId, musicAssetId, subtitleAssetId };
}

export function buildComposePreflight(input: {
  workspaceId: string;
  projectId: string;
  shotRevisionId: string;
  assets: {
    video: ComposeAssetFacts;
    audio: ComposeAssetFacts | null;
    music: ComposeAssetFacts | null;
    subtitle: ComposeAssetFacts | null;
  };
}): ComposePreflightResponse {
  const video = checkedSource(input, "video", input.assets.video);
  const audio = input.assets.audio ? checkedSource(input, "audio", input.assets.audio) : null;
  const music = input.assets.music ? checkedSource(input, "music", input.assets.music) : null;
  const subtitle = input.assets.subtitle ? checkedSource(input, "subtitle", input.assets.subtitle) : null;
  const manifest = {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    shotRevisionId: input.shotRevisionId,
    sources: [
      { role: "video" as const, asset: video.asset },
      { role: "audio" as const, asset: audio?.asset ?? null },
      { role: "music" as const, asset: music?.asset ?? null },
      { role: "subtitle" as const, asset: subtitle?.asset ?? null },
    ],
    plan: { ...OUTPUT_PLAN, durationMs: video.asset.durationMs },
  };
  return {
    schema: COMPOSE_PREFLIGHT_SCHEMA,
    manifest,
    inputHash: canonicalInputHash(manifest),
    guards: {
      shotRevisionId: input.shotRevisionId,
      assets: [
        { role: "video", assetId: input.assets.video.id, rowVersion: input.assets.video.rowVersion },
        { role: "audio", assetId: input.assets.audio?.id ?? null, rowVersion: input.assets.audio?.rowVersion ?? null },
        { role: "music", assetId: input.assets.music?.id ?? null, rowVersion: input.assets.music?.rowVersion ?? null },
        { role: "subtitle", assetId: input.assets.subtitle?.id ?? null, rowVersion: input.assets.subtitle?.rowVersion ?? null },
      ],
    },
  };
}

function checkedSource(
  scope: { workspaceId: string; projectId: string; shotRevisionId: string },
  role: ComposePreflightRole,
  asset: ComposeAssetFacts,
): { asset: NonNullable<ComposePreflightResponse["manifest"]["sources"][number]["asset"]> } {
  const rule = SLOT_RULES[role];
  if (asset.workspaceId !== scope.workspaceId || asset.projectId !== scope.projectId || asset.shotRevisionId !== scope.shotRevisionId) {
    throw new DomainError("COMPOSE_INPUT_INVALID", `Compose input ${role} is outside this shot`);
  }
  if (asset.status !== "ACTIVE" || asset.reviewStatus !== "DRAFT") {
    throw new DomainError("COMPOSE_INPUT_INVALID", `Compose input ${role} is not an active draft`);
  }
  if (asset.kind !== rule.kind || asset.mimeType !== rule.mimeType || asset.storageProvider !== "mock-object-store") {
    throw new DomainError("COMPOSE_INPUT_INVALID", `Compose input ${role} is not a supported mock source`);
  }
  if (!/^[0-9a-f]{64}$/.test(asset.checksumSha256) || !positiveInteger(asset.byteSize)) {
    throw new DomainError("COMPOSE_INPUT_INVALID", `Compose input ${role} metadata is unusable`);
  }
  if (!positiveInteger(asset.durationMs) || (role === "video" && asset.durationMs > COMPOSE_VIDEO_DURATION_MAX_MS)) {
    throw new DomainError("COMPOSE_INPUT_INVALID", `Compose input ${role} duration is unusable`);
  }
  if (rule.dimensions) {
    if (!positiveInteger(asset.width) || !positiveInteger(asset.height)) {
      throw new DomainError("COMPOSE_INPUT_INVALID", `Compose input ${role} metadata is unusable`);
    }
  } else if (asset.width !== null || asset.height !== null) {
    throw new DomainError("COMPOSE_INPUT_INVALID", `Compose input ${role} metadata is unusable`);
  }
  if (!positiveInteger(asset.rowVersion)) {
    throw new DomainError("COMPOSE_INPUT_INVALID", `Compose input ${role} is not usable`);
  }
  const job = asset.job;
  const attempt = asset.attempt;
  if (!job || !attempt || !asset.sourceGenerationJobId || !asset.sourceJobAttemptId || !asset.providerRequestId || !asset.providerConfigurationId) {
    throw new DomainError("COMPOSE_INPUT_INVALID", `Compose input ${role} does not come from a successful generation`);
  }
  const requestId = sampleRequestId(role, asset, job, attempt) ?? `mock-media|sync|${rule.capability}|${job.id}:${attempt.attemptNo}`;
  if (
    job.id !== asset.sourceGenerationJobId ||
    job.workspaceId !== scope.workspaceId ||
    job.projectId !== scope.projectId ||
    job.shotRevisionId !== scope.shotRevisionId ||
    job.kind !== rule.jobKind ||
    job.state !== "SUCCEEDED" ||
    attempt.id !== asset.sourceJobAttemptId ||
    attempt.generationJobId !== job.id ||
    attempt.finished !== true ||
    !positiveInteger(attempt.attemptNo) ||
    attempt.providerRequestId !== requestId ||
    asset.providerRequestId !== requestId ||
    attempt.providerConfigurationId !== asset.providerConfigurationId
  ) {
    throw new DomainError("COMPOSE_INPUT_INVALID", `Compose input ${role} does not match its generation source`);
  }
  return {
    asset: {
      assetId: asset.id,
      checksumSha256: asset.checksumSha256,
      kind: asset.kind,
      mimeType: asset.mimeType,
      byteSize: asset.byteSize,
      width: asset.width,
      height: asset.height,
      durationMs: asset.durationMs,
    },
  };
}

function sampleRequestId(
  role: ComposePreflightRole,
  asset: ComposeAssetFacts,
  job: ComposeJobFacts,
  attempt: ComposeAttemptFacts,
): string | null {
  const providerRequestId = asset.providerRequestId ?? "";
  if (!looksLikeSampleVideoRequestId(providerRequestId)) return null;
  if (role !== "video") {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Compose input video sample identity is not valid for this slot");
  }
  const parsed = parseSampleVideoRequestId(providerRequestId);
  const description = parsed ? SAMPLE_VIDEO_DESCRIPTIONS[parsed.fixtureId] : null;
  const jobFrozen = frozenSampleFields(job.inputSnapshot);
  const assetFrozen = frozenSampleFields(asset.metadata);
  if (
    !parsed ||
    !description ||
    !jobFrozen ||
    !assetFrozen ||
    parsed.jobId !== job.id ||
    parsed.attemptNo !== attempt.attemptNo ||
    jobFrozen.fixtureId !== parsed.fixtureId ||
    assetFrozen.fixtureId !== parsed.fixtureId ||
    asset.checksumSha256 !== description.checksumSha256 ||
    asset.byteSize !== description.byteSize ||
    asset.durationMs !== description.durationMs ||
    asset.width !== description.width ||
    asset.height !== description.height
  ) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Compose input video does not match its sample fixture");
  }
  return providerRequestId;
}

function positiveInteger(value: number | null): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function requiredUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_TEXT.test(value)) {
    throw new DomainError("VALIDATION_ERROR", "Request body is invalid");
  }
  return value.toLowerCase();
}

function optionalUuid(record: Record<string, unknown>, key: (typeof REQUEST_KEYS)[number]): string | null {
  if (!Object.hasOwn(record, key) || record[key] === null) return null;
  return requiredUuid(record[key]);
}
