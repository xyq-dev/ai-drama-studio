import { DomainError } from "./errors";
import { COMPOSE_OUTPUT_MAX_BYTES } from "./compose-render";
import { canonicalInputHash } from "./text-chain";
import { type EpisodeComposeSegment } from "./episode-compose-preflight";
import {
  EPISODE_COMPOSE_JOB_SCHEMA,
  EPISODE_COMPOSE_OUTPUT_SCHEMA,
  EPISODE_RENDER_PROFILE,
  EPISODE_RENDER_PROFILE_ID,
  type EpisodeComposeSourceObject,
} from "./episode-compose-render";

export const EPISODE_EXPORT_MANIFEST_SCHEMA = "m4.episode.export.manifest.v1";

const MEDIA_ROLES = ["video", "audio", "music", "subtitle"] as const;
const HASH_TEXT = /^[0-9a-f]{64}$/;

export type EpisodeExportMediaRole = (typeof MEDIA_ROLES)[number];

export interface EpisodeExportMedia {
  role: EpisodeExportMediaRole;
  kind: string;
  assetId: string;
  checksumSha256: string;
  sourceJobId: string;
  sourceAttemptId: string;
}

export interface EpisodeExportSegment {
  position: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  shotAssetId: string;
  shotChecksumSha256: string;
  shotId: string;
  shotRevisionId: string;
  media: EpisodeExportMedia[];
}

export interface EpisodeExportCore {
  projectId: string;
  episodeId: string;
  episodeNo: number;
  assetId: string;
  checksumSha256: string;
  byteSize: number;
  objectKey: string;
  width: 1080;
  height: 1920;
  frameRate: 25;
  durationMs: number;
  reviewStatus: "APPROVED";
  rowVersion: number;
  reviewedContentHash: string;
  jobId: string;
  attemptId: string;
  inputHash: string;
  preflightInputHash: string;
  renderProfileId: typeof EPISODE_RENDER_PROFILE_ID;
}

export interface EpisodeExportFacts extends EpisodeExportCore {
  segments: EpisodeExportSegment[];
}

export interface EpisodeExportAssetFacts {
  id: string;
  workspaceId: string;
  projectId: string;
  kind: string;
  sourceKind: string | null;
  storageProvider: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  status: string;
  reviewStatus: string;
  reviewedContentHash: string | null;
  rowVersion: number;
  sourceShotRevisionId: string | null;
  objectKey: string;
  sourceJobId: string | null;
  sourceAttemptId: string | null;
  metadata: unknown;
}

export interface EpisodeExportJobFacts {
  id: string;
  workspaceId: string;
  projectId: string;
  shotRevisionId: string | null;
  kind: string;
  state: string;
  inputHash: string;
  snapshot: unknown;
}

export interface EpisodeExportAttemptFacts {
  id: string;
  jobId: string;
  finished: boolean;
  isLatest: boolean;
}

export function assertEpisodeExportRecord(input: {
  workspaceId: string;
  projectId: string;
  episodeId: string;
  episodeNo: number;
  expectedContentHash: string;
  stalePending: boolean;
  asset: EpisodeExportAssetFacts;
  job: EpisodeExportJobFacts | null;
  attempt: EpisodeExportAttemptFacts | null;
}): EpisodeExportCore {
  if (input.stalePending) {
    throw new DomainError("STALE_RECALCULATION_PENDING", "Episode export is blocked until stale propagation completes");
  }
  if (input.asset.workspaceId !== input.workspaceId || input.asset.projectId !== input.projectId) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite is outside this project");
  }
  if (!Number.isInteger(input.episodeNo) || input.episodeNo < 1 || input.episodeNo > 3) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Episode number is not usable");
  }
  const asset = input.asset;
  if (asset.kind !== "COMPOSITE" || asset.sourceKind !== "LOCAL_JOB" || asset.storageProvider !== "local-compose") {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite is not a local episode output");
  }
  if (asset.status !== "ACTIVE" || asset.reviewStatus !== "APPROVED") {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite is not an active approved episode output");
  }
  if (asset.sourceShotRevisionId !== null) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Episode composite records a shot revision");
  }
  if (
    !HASH_TEXT.test(asset.checksumSha256)
    || asset.reviewedContentHash !== asset.checksumSha256
    || input.expectedContentHash !== asset.checksumSha256
  ) {
    throw new DomainError("COMPOSE_CONTENT_HASH_MISMATCH", "Episode export hash does not match the approved composite");
  }
  if (asset.mimeType !== "video/mp4" || asset.width !== 1080 || asset.height !== 1920) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite does not match the episode render profile");
  }
  if (typeof asset.byteSize !== "number" || !Number.isSafeInteger(asset.byteSize) || asset.byteSize <= 0 || asset.byteSize > COMPOSE_OUTPUT_MAX_BYTES) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite byte size is not usable");
  }
  if (typeof asset.durationMs !== "number" || !Number.isSafeInteger(asset.durationMs) || asset.durationMs <= 0) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite duration must be a positive integer millisecond value");
  }
  if (!Number.isSafeInteger(asset.rowVersion) || asset.rowVersion < 1) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite review version is not usable");
  }
  const metadata = plain(asset.metadata);
  const output = plain(metadata?.output);
  if (
    !metadata
    || metadata.schema !== EPISODE_COMPOSE_OUTPUT_SCHEMA
    || metadata.episodeId !== input.episodeId
    || metadata.sourceJobId !== asset.sourceJobId
    || metadata.sourceAttemptId !== asset.sourceAttemptId
    || typeof metadata.preflightInputHash !== "string"
    || !HASH_TEXT.test(metadata.preflightInputHash)
    || !output
    || output.checksumSha256 !== asset.checksumSha256
    || output.byteSize !== asset.byteSize
    || output.durationMs !== asset.durationMs
    || output.width !== 1080
    || output.height !== 1920
  ) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Episode composite metadata does not match the stored output");
  }
  const job = input.job;
  const attempt = input.attempt;
  if (!job || !attempt || !asset.sourceJobId || !asset.sourceAttemptId || job.id !== asset.sourceJobId || attempt.id !== asset.sourceAttemptId) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite is not tied to its compose job");
  }
  if (
    job.workspaceId !== input.workspaceId
    || job.projectId !== input.projectId
    || job.shotRevisionId !== null
    || job.kind !== "MEDIA_COMPOSE"
    || job.state !== "SUCCEEDED"
  ) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite job is not a succeeded episode compose");
  }
  if (!attempt.finished || !attempt.isLatest || attempt.jobId !== job.id) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite is not the latest finished compose attempt");
  }
  const snapshot = plain(job.snapshot);
  const frozen = plain(snapshot?.input);
  if (!snapshot || snapshot.schema !== EPISODE_COMPOSE_JOB_SCHEMA || !frozen) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Frozen episode compose input is not the episode schema");
  }
  let hashed: string;
  try {
    hashed = canonicalInputHash(frozen);
  } catch (error) {
    if (error instanceof DomainError) {
      throw new DomainError("COMPOSE_INPUT_INVALID", "Frozen episode compose input does not match its hash");
    }
    throw error;
  }
  if (hashed !== job.inputHash) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Frozen episode compose input does not match its hash");
  }
  if (
    frozen.workspaceId !== input.workspaceId
    || frozen.projectId !== input.projectId
    || frozen.episodeId !== input.episodeId
    || snapshot.preflightInputHash !== metadata.preflightInputHash
    || !sameValue(frozen.manifest, metadata.manifest)
    || !sameValue(frozen.renderProfile, EPISODE_RENDER_PROFILE)
    || !sameValue(metadata.renderProfile, EPISODE_RENDER_PROFILE)
  ) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Frozen episode compose input does not match its metadata");
  }
  const expectedKey = `compose/${input.workspaceId}/${input.projectId}/${job.id}/${attempt.id}/${asset.checksumSha256}.mp4`;
  if (asset.objectKey !== expectedKey) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Compose object key does not belong to this attempt");
  }
  alignFrozenSegments(frozen);
  return {
    projectId: input.projectId,
    episodeId: input.episodeId,
    episodeNo: input.episodeNo,
    assetId: asset.id,
    checksumSha256: asset.checksumSha256,
    byteSize: asset.byteSize,
    objectKey: asset.objectKey,
    width: 1080,
    height: 1920,
    frameRate: 25,
    durationMs: asset.durationMs,
    reviewStatus: "APPROVED",
    rowVersion: asset.rowVersion,
    reviewedContentHash: asset.checksumSha256,
    jobId: job.id,
    attemptId: attempt.id,
    inputHash: job.inputHash,
    preflightInputHash: metadata.preflightInputHash,
    renderProfileId: EPISODE_RENDER_PROFILE_ID,
  };
}

export function assertDependencyEdges(
  workspaceId: string,
  projectId: string,
  expectedSourceIds: readonly string[],
  edges: ReadonlyArray<{ workspaceId: string; projectId: string; sourceAssetId: string }>,
): void {
  if (edges.some((edge) => edge.workspaceId !== workspaceId || edge.projectId !== projectId)) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite dependency is outside this project");
  }
  const expected = [...expectedSourceIds].sort();
  const actual = edges.map((edge) => edge.sourceAssetId).sort();
  if (
    expected.length !== new Set(expected).size
    || actual.length !== expected.length
    || actual.some((id, index) => id !== expected[index])
  ) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Composite dependencies do not match the frozen sources");
  }
}

export interface FrozenShotMediaInput {
  workspaceId: string;
  projectId: string;
  sources: ReadonlyArray<{ role: string; asset: { assetId: string; checksumSha256: string; kind: string } | null }>;
  sourceObjects: ReadonlyArray<{ role: string; assetId: string; checksumSha256: string }>;
  edges: ReadonlyArray<{ workspaceId: string; projectId: string; sourceAssetId: string }>;
  media: ReadonlyArray<{
    assetId: string;
    workspaceId: string;
    projectId: string;
    kind: string;
    checksumSha256: string;
    sourceJobId: string | null;
    sourceAttemptId: string | null;
  }>;
}

export function mediaFromFrozenShot(input: FrozenShotMediaInput): EpisodeExportMedia[] {
  const participating = input.sources.flatMap((slot) => {
    if (slot.asset === null) return [];
    if (!isRole(slot.role) || !HASH_TEXT.test(slot.asset.checksumSha256) || slot.asset.kind.length === 0) {
      throw new DomainError("COMPOSE_INPUT_INVALID", "Frozen shot source is not usable");
    }
    return [{ role: slot.role, assetId: slot.asset.assetId, checksumSha256: slot.asset.checksumSha256, kind: slot.asset.kind }];
  });
  if (new Set(participating.map((item) => item.role)).size !== participating.length) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Frozen shot source repeats a role");
  }
  const frozen = [...input.sourceObjects].map((item) => ({
    role: item.role,
    assetId: item.assetId,
    checksumSha256: item.checksumSha256,
  })).sort(byRole);
  const slots = participating.map((item) => ({
    role: item.role,
    assetId: item.assetId,
    checksumSha256: item.checksumSha256,
  })).sort(byRole);
  if (frozen.length !== slots.length || frozen.some((item, index) => item.role !== slots[index]?.role || item.assetId !== slots[index]?.assetId || item.checksumSha256 !== slots[index]?.checksumSha256)) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Frozen shot sources do not match the compose manifest");
  }
  assertDependencyEdges(input.workspaceId, input.projectId, participating.map((item) => item.assetId), input.edges);
  const rows = new Map(input.media.map((item) => [item.assetId, item]));
  if (rows.size !== input.media.length) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Frozen media source is duplicated");
  }
  return participating.map((slot) => {
    const row = rows.get(slot.assetId);
    if (!row || row.workspaceId !== input.workspaceId || row.projectId !== input.projectId || row.kind !== slot.kind || row.checksumSha256 !== slot.checksumSha256) {
      throw new DomainError("COMPOSE_INPUT_INVALID", "Frozen media source does not match the stored asset");
    }
    if (!row.sourceJobId || !row.sourceAttemptId) {
      throw new DomainError("COMPOSE_INPUT_INVALID", "Frozen media source has no compose job");
    }
    return {
      role: slot.role,
      kind: row.kind,
      assetId: row.assetId,
      checksumSha256: row.checksumSha256,
      sourceJobId: row.sourceJobId,
      sourceAttemptId: row.sourceAttemptId,
    };
  });
}

export function buildEpisodeExportManifest(facts: EpisodeExportFacts, verifiedAt: string) {
  if (Number.isNaN(Date.parse(verifiedAt))) {
    throw new DomainError("VALIDATION_ERROR", "Export verification time is invalid");
  }
  return {
    schema: EPISODE_EXPORT_MANIFEST_SCHEMA,
    verifiedAt,
    eligibility: "qualified" as const,
    projectId: facts.projectId,
    episodeId: facts.episodeId,
    episodeNo: facts.episodeNo,
    asset: {
      id: facts.assetId,
      checksumSha256: facts.checksumSha256,
      byteSize: facts.byteSize,
      width: facts.width,
      height: facts.height,
      frameRate: facts.frameRate,
      durationMs: facts.durationMs,
      reviewStatus: facts.reviewStatus,
      rowVersion: facts.rowVersion,
      reviewedContentHash: facts.reviewedContentHash,
    },
    compose: {
      jobId: facts.jobId,
      attemptId: facts.attemptId,
      inputHash: facts.inputHash,
      preflightInputHash: facts.preflightInputHash,
      renderProfileId: facts.renderProfileId,
    },
    segments: facts.segments.map((segment) => ({
      position: segment.position,
      startMs: segment.startMs,
      endMs: segment.endMs,
      durationMs: segment.durationMs,
      shotAssetId: segment.shotAssetId,
      shotChecksumSha256: segment.shotChecksumSha256,
      shotId: segment.shotId,
      shotRevisionId: segment.shotRevisionId,
      media: segment.media.map((item) => ({
        role: item.role,
        kind: item.kind,
        assetId: item.assetId,
        checksumSha256: item.checksumSha256,
        sourceJobId: item.sourceJobId,
        sourceAttemptId: item.sourceAttemptId,
      })),
    })),
    boundary: {
      sourceBoundary: "mock-provider" as const,
      localEncodeCostMetered: false,
      statement: "本清单只记录已批准集级成片的冻结来源。上游媒体来自 Mock 边界。本地编码成本未计量，不包含完整财务账本，也不构成生产分发许可。",
    },
  };
}

export function episodeExportFilenameStem(episodeNo: number, assetId: string): string {
  if (!Number.isInteger(episodeNo) || episodeNo < 1 || episodeNo > 3) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Episode number is not usable");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(assetId)) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Episode asset id is not usable");
  }
  return `episode-${String(episodeNo).padStart(2, "0")}-${assetId}`;
}

function alignFrozenSegments(frozen: Record<string, unknown>): void {
  const manifest = plain(frozen.manifest);
  const segments = Array.isArray(manifest?.segments) ? manifest.segments : null;
  const sources = Array.isArray(frozen.sourceObjects) ? frozen.sourceObjects : null;
  if (!segments || !sources || segments.length === 0 || segments.length !== sources.length) {
    throw new DomainError("COMPOSE_INPUT_INVALID", "Frozen episode segments do not match their sources");
  }
  segments.forEach((value, index) => {
    const segment = value as Partial<EpisodeComposeSegment>;
    const source = sources[index] as Partial<EpisodeComposeSourceObject>;
    if (
      !segment
      || !source
      || source.assetId !== segment.assetId
      || source.shotId !== segment.shotId
      || source.shotRevisionId !== segment.shotRevisionId
      || source.checksumSha256 !== segment.checksumSha256
      || source.byteSize !== segment.byteSize
      || source.durationMs !== segment.durationMs
      || source.startMs !== segment.startMs
      || source.endMs !== segment.endMs
    ) {
      throw new DomainError("COMPOSE_INPUT_INVALID", "Frozen episode source does not match the manifest");
    }
  });
}

function sameValue(left: unknown, right: unknown): boolean {
  try {
    return canonicalInputHash(left) === canonicalInputHash(right);
  } catch (error) {
    if (error instanceof DomainError) return false;
    throw error;
  }
}

function plain(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isRole(value: string): value is EpisodeExportMediaRole {
  return MEDIA_ROLES.includes(value as EpisodeExportMediaRole);
}

function byRole(left: { role: string }, right: { role: string }): number {
  return left.role < right.role ? -1 : left.role > right.role ? 1 : 0;
}
