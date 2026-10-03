import { DomainError } from "./errors";
import { COMPOSE_JOB_SCHEMA, COMPOSE_OUTPUT_MAX_BYTES, COMPOSE_RENDER_PROFILE } from "./compose-render";
import { canonicalInputHash } from "./text-chain";

export const EPISODE_COMPOSE_PREFLIGHT_SCHEMA = "m4.episode.compose.preflight.v1";
export const EPISODE_COMPOSE_ASSET_SCHEMA = "m4.shot.compose.asset.v1";
export const EPISODE_COMPOSE_MIN_SEGMENTS = 2;
export const EPISODE_COMPOSE_MAX_SEGMENTS = 30;
export const EPISODE_COMPOSE_MAX_DURATION_MS = 90_000;
export const EPISODE_COMPOSE_TARGET_MIN_MS = 60_000;
export const EPISODE_COMPOSE_STATUS_NOTE = "预检通过，尚未执行多镜合成";
export const EPISODE_COMPOSE_SHORT_NOTICE = "尚未达到 V1 的 60–90 秒目标";

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_KEYS = ["compositeAssetIds"] as const;

export interface EpisodeComposePreflightRequest {
  compositeAssetIds: string[];
}

export interface EpisodeComposeJobFacts {
  id: string;
  workspaceId: string;
  projectId: string;
  shotRevisionId: string | null;
  kind: string;
  state: string;
  schema: string | null;
}

export interface EpisodeComposeAttemptFacts {
  id: string;
  generationJobId: string;
  finished: boolean;
  isLatest: boolean;
}

export interface EpisodeCompositeFacts {
  assetId: string;
  workspaceId: string;
  projectId: string;
  episodeId: string;
  shotId: string;
  shotRevisionId: string;
  checksumSha256: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  mimeType: string;
  kind: string;
  status: string;
  reviewStatus: string;
  sourceKind: string | null;
  storageProvider: string;
  reviewedContentHash: string | null;
  rowVersion: number;
  metadataSchema: string | null;
  renderProfile: unknown;
  providerConfigurationId: string | null;
  providerRequestId: string | null;
  sourceGenerationJobId: string | null;
  sourceJobAttemptId: string | null;
  sourceUsable: boolean;
  job: EpisodeComposeJobFacts | null;
  attempt: EpisodeComposeAttemptFacts | null;
}

export interface EpisodeComposeSegment {
  position: number;
  assetId: string;
  shotId: string;
  shotRevisionId: string;
  checksumSha256: string;
  byteSize: number;
  width: number;
  height: number;
  durationMs: number;
  startMs: number;
  endMs: number;
}

export interface EpisodeComposePreflightResponse {
  schema: typeof EPISODE_COMPOSE_PREFLIGHT_SCHEMA;
  verification: "metadata";
  diskContentChecked: false;
  decoded: false;
  executed: false;
  statusNote: typeof EPISODE_COMPOSE_STATUS_NOTE;
  durationNotice: string | null;
  manifest: {
    workspaceId: string;
    projectId: string;
    episodeId: string;
    segments: EpisodeComposeSegment[];
    plan: {
      width: 1080;
      height: 1920;
      frameRate: 25;
      container: "mp4";
      cut: "hard-cut-in-order";
      audio: "keep-segment-audio";
      subtitles: "already-burned";
      durationMs: number;
    };
  };
  inputHash: string;
  guards: {
    episodeId: string;
    assets: Array<{ assetId: string; rowVersion: number }>;
  };
}

export function parseEpisodeComposePreflightRequest(body: unknown): EpisodeComposePreflightRequest {
  if (!isPlainObject(body)) failRequest("Episode compose preflight body must be an object");
  const keys = Object.keys(body);
  if (keys.length !== REQUEST_KEYS.length || keys.some((key) => !REQUEST_KEYS.includes(key as typeof REQUEST_KEYS[number]))) {
    failRequest("Episode compose preflight contains an unknown field");
  }
  const ids = body.compositeAssetIds;
  if (!Array.isArray(ids)) failRequest("compositeAssetIds must be an array");
  if (ids.length < EPISODE_COMPOSE_MIN_SEGMENTS || ids.length > EPISODE_COMPOSE_MAX_SEGMENTS) {
    failRequest("Episode compose preflight must select 2 to 30 composites");
  }
  const compositeAssetIds = ids.map((id) => {
    if (typeof id !== "string" || !UUID_TEXT.test(id)) failRequest("compositeAssetIds must contain UUIDs");
    return id.toLowerCase();
  });
  if (new Set(compositeAssetIds).size !== compositeAssetIds.length) {
    failRequest("compositeAssetIds must not contain duplicates");
  }
  return { compositeAssetIds };
}

export function buildEpisodeComposePreflight(input: {
  workspaceId: string;
  projectId: string;
  episodeId: string;
  staleRecalculationPending: boolean;
  composites: readonly EpisodeCompositeFacts[];
}): EpisodeComposePreflightResponse {
  if (input.staleRecalculationPending) {
    throw new DomainError("STALE_RECALCULATION_PENDING", "Episode compose is blocked until stale propagation completes");
  }
  if (input.composites.length < EPISODE_COMPOSE_MIN_SEGMENTS || input.composites.length > EPISODE_COMPOSE_MAX_SEGMENTS) {
    failRequest("Episode compose preflight must select 2 to 30 composites");
  }
  const seenAssets = new Set<string>();
  const seenShots = new Set<string>();
  const segments: EpisodeComposeSegment[] = [];
  let cursor = 0;
  for (const [index, composite] of input.composites.entries()) {
    assertComposite(input.workspaceId, input.projectId, input.episodeId, composite);
    if (seenAssets.has(composite.assetId)) failRequest("compositeAssetIds must not contain duplicates");
    seenAssets.add(composite.assetId);
    if (seenShots.has(composite.shotId)) {
      throw new DomainError("COMPOSE_INPUT_INVALID", "同一个镜头只能选择一份成片");
    }
    seenShots.add(composite.shotId);
    const durationMs = positiveDurationMs(composite);
    const startMs = cursor;
    cursor += durationMs;
    if (cursor > EPISODE_COMPOSE_MAX_DURATION_MS) {
      throw new DomainError("COMPOSE_INPUT_INVALID", "Episode compose duration exceeds 90000 ms");
    }
    segments.push({
      position: index + 1,
      assetId: composite.assetId,
      shotId: composite.shotId,
      shotRevisionId: composite.shotRevisionId,
      checksumSha256: composite.checksumSha256,
      byteSize: composite.byteSize,
      width: 1080,
      height: 1920,
      durationMs,
      startMs,
      endMs: startMs + durationMs,
    });
  }
  const manifest = {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    episodeId: input.episodeId,
    segments,
    plan: {
      width: 1080 as const,
      height: 1920 as const,
      frameRate: 25 as const,
      container: "mp4" as const,
      cut: "hard-cut-in-order" as const,
      audio: "keep-segment-audio" as const,
      subtitles: "already-burned" as const,
      durationMs: cursor,
    },
  };
  return {
    schema: EPISODE_COMPOSE_PREFLIGHT_SCHEMA,
    verification: "metadata",
    diskContentChecked: false,
    decoded: false,
    executed: false,
    statusNote: EPISODE_COMPOSE_STATUS_NOTE,
    durationNotice: cursor < EPISODE_COMPOSE_TARGET_MIN_MS ? EPISODE_COMPOSE_SHORT_NOTICE : null,
    manifest,
    inputHash: canonicalInputHash(manifest),
    guards: {
      episodeId: input.episodeId,
      assets: input.composites.map((composite) => ({
        assetId: composite.assetId,
        rowVersion: composite.rowVersion,
      })),
    },
  };
}

export function assertEpisodeCompositeEligible(
  workspaceId: string,
  projectId: string,
  episodeId: string,
  composite: EpisodeCompositeFacts,
): void {
  if (composite.workspaceId !== workspaceId || composite.projectId !== projectId) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite is outside this project");
  }
  if (composite.episodeId !== episodeId) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite is outside this episode");
  }
  if (!composite.sourceUsable) {
    throw new DomainError("REVIEW_REQUIRED", "Episode compose requires current approved shot and scene revisions");
  }
  if (composite.kind !== "COMPOSITE" || composite.status !== "ACTIVE" || composite.reviewStatus !== "APPROVED") {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite is not an active approved single-shot output");
  }
  if (composite.reviewedContentHash !== composite.checksumSha256 || !/^[0-9a-f]{64}$/.test(composite.checksumSha256)) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite review hash does not match its checksum");
  }
  if (composite.sourceKind !== "LOCAL_JOB" || composite.storageProvider !== "local-compose") {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite is not a local single-shot output");
  }
  if (composite.providerConfigurationId !== null || composite.providerRequestId !== null) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite records a provider");
  }
  if (composite.mimeType !== "video/mp4" || composite.width !== 1080 || composite.height !== 1920) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite does not match the single-shot render profile");
  }
  if (!Number.isSafeInteger(composite.byteSize) || composite.byteSize <= 0 || composite.byteSize > COMPOSE_OUTPUT_MAX_BYTES) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite byte size is not usable");
  }
  if (composite.metadataSchema !== EPISODE_COMPOSE_ASSET_SCHEMA || !sameProfile(composite.renderProfile)) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite metadata is not the accepted single-shot schema");
  }
  positiveDurationMs(composite);
  const job = composite.job;
  const attempt = composite.attempt;
  if (!job || !attempt || job.id !== composite.sourceGenerationJobId || attempt.id !== composite.sourceJobAttemptId) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite is not tied to its compose job");
  }
  if (
    job.workspaceId !== workspaceId
    || job.projectId !== projectId
    || job.shotRevisionId !== composite.shotRevisionId
    || job.kind !== "MEDIA_COMPOSE"
    || job.state !== "SUCCEEDED"
    || job.schema !== COMPOSE_JOB_SCHEMA
  ) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite job is not a succeeded single-shot compose");
  }
  if (!attempt.finished || !attempt.isLatest || attempt.generationJobId !== job.id) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite is not the latest finished compose attempt");
  }
}

function assertComposite(
  workspaceId: string,
  projectId: string,
  episodeId: string,
  composite: EpisodeCompositeFacts,
): void {
  assertEpisodeCompositeEligible(workspaceId, projectId, episodeId, composite);
}

function positiveDurationMs(composite: EpisodeCompositeFacts): number {
  const durationMs = composite.durationMs;
  if (typeof durationMs !== "number" || !Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite duration must be a positive integer millisecond value");
  }
  return durationMs;
}

function sameProfile(value: unknown): boolean {
  try {
    return canonicalInputHash(value) === canonicalInputHash(COMPOSE_RENDER_PROFILE);
  } catch (error) {
    if (error instanceof DomainError) return false;
    throw error;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failRequest(message: string): never {
  throw new DomainError("VALIDATION_ERROR", message);
}
