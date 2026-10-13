import { DomainError } from "./errors";

/**
 * Character reference images. Generation needs an approved current script source and a CURRENT, current character
 * revision, but not an approved character. Video generation under the strict gate needs every referenced character
 * revision approved and current, plus a selected reference image that is ACTIVE, approved on its exact bytes and
 * produced from that same character revision.
 */
export const CHARACTER_REFERENCE_JOB_KIND = "MEDIA_CHARACTER_REFERENCE" as const;
export const CHARACTER_REFERENCE_SNAPSHOT_SCHEMA = "m3.mock.character-reference.v1" as const;
export const CHARACTER_REFERENCE_ROLE = "character_reference" as const;

/**
 * legacy: the existing Mock video contract. Referenced characters must be approved and current; no reference image
 *         is required. This is what every existing deployment runs.
 * strict: the reviewed V1 baseline. It needs the reference-image schema; when that is absent the gate refuses
 *         video instead of falling back to legacy.
 */
export type CharacterReferenceGateMode = "legacy" | "strict";

export function parseCharacterReferenceGateMode(value: string | undefined): CharacterReferenceGateMode {
  if (value === undefined || value === "" || value === "legacy") return "legacy";
  if (value === "strict") return "strict";
  throw new DomainError("VALIDATION_ERROR", "Character reference gate must be legacy or strict");
}

export interface CharacterReferenceSnapshot {
  schema: typeof CHARACTER_REFERENCE_SNAPSHOT_SCHEMA;
  characterRevisionId: string;
  characterContentHash: string;
  seed: string | null;
  bypassCache: boolean;
  outcome: "success";
  executionMode: "sync";
  capability: "image.generate";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Exactly the frozen generation snapshot; anything else is not a character reference job. */
export function parseCharacterReferenceSnapshot(value: unknown): CharacterReferenceSnapshot {
  const keys = ["bypassCache", "capability", "characterContentHash", "characterRevisionId", "executionMode",
    "outcome", "schema", "seed"];
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== keys.join(",")) {
    throw new DomainError("VALIDATION_ERROR", "Character reference snapshot is invalid");
  }
  if (value.schema !== CHARACTER_REFERENCE_SNAPSHOT_SCHEMA || value.outcome !== "success"
    || value.executionMode !== "sync" || value.capability !== "image.generate"
    || typeof value.characterRevisionId !== "string" || !UUID.test(value.characterRevisionId)
    || typeof value.characterContentHash !== "string" || !SHA256.test(value.characterContentHash)
    || (value.seed !== null && typeof value.seed !== "string") || typeof value.bypassCache !== "boolean") {
    throw new DomainError("VALIDATION_ERROR", "Character reference snapshot is invalid");
  }
  return value as unknown as CharacterReferenceSnapshot;
}

export interface CharacterReferenceReviewRequest {
  decision: "APPROVED" | "REJECTED";
  expectedRowVersion: number;
  contentHash: string;
  note: string | null;
}

export function parseCharacterReferenceReviewRequest(value: unknown): CharacterReferenceReviewRequest {
  if (!isRecord(value)) throw new DomainError("VALIDATION_ERROR", "Review request must be an object");
  const allowed = new Set(["decision", "expectedRowVersion", "contentHash", "note"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new DomainError("VALIDATION_ERROR", "Review request has unknown fields");
  }
  if (value.decision !== "APPROVED" && value.decision !== "REJECTED") {
    throw new DomainError("VALIDATION_ERROR", "decision must be APPROVED or REJECTED");
  }
  if (!Number.isSafeInteger(value.expectedRowVersion) || (value.expectedRowVersion as number) < 1) {
    throw new DomainError("VALIDATION_ERROR", "expectedRowVersion must be a positive integer");
  }
  if (typeof value.contentHash !== "string" || !SHA256.test(value.contentHash)) {
    throw new DomainError("VALIDATION_ERROR", "contentHash must be the reviewed SHA-256");
  }
  const note = value.note === undefined || value.note === null ? null : value.note;
  if (note !== null && (typeof note !== "string" || note.length > 2000)) {
    throw new DomainError("VALIDATION_ERROR", "note must be at most 2000 characters");
  }
  if (value.decision === "REJECTED" && (note === null || note.trim().length === 0)) {
    throw new DomainError("VALIDATION_ERROR", "A rejection needs a note");
  }
  return { decision: value.decision, expectedRowVersion: value.expectedRowVersion as number,
    contentHash: value.contentHash, note };
}

export interface CharacterReferenceSelectionRequest {
  assetId: string;
  /** The selection the caller saw; null when none. A different current selection is a 409. */
  expectedSelectedAssetId: string | null;
}

export function parseCharacterReferenceSelectionRequest(value: unknown): CharacterReferenceSelectionRequest {
  if (!isRecord(value)) throw new DomainError("VALIDATION_ERROR", "Selection request must be an object");
  const allowed = new Set(["assetId", "expectedSelectedAssetId"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || !("expectedSelectedAssetId" in value)) {
    throw new DomainError("VALIDATION_ERROR", "Selection request must be { assetId, expectedSelectedAssetId }");
  }
  if (typeof value.assetId !== "string" || !UUID.test(value.assetId)) {
    throw new DomainError("VALIDATION_ERROR", "assetId must be a UUID");
  }
  const expected = value.expectedSelectedAssetId;
  if (expected !== null && (typeof expected !== "string" || !UUID.test(expected))) {
    throw new DomainError("VALIDATION_ERROR", "expectedSelectedAssetId must be a UUID or null");
  }
  return { assetId: value.assetId.toLowerCase(), expectedSelectedAssetId: expected === null ? null : (expected as string).toLowerCase() };
}

/** What makes one selected reference usable as a video source right now. */
export interface SelectedReferenceState {
  assetStatus: string;
  reviewStatus: string;
  reviewedContentHash: string | null;
  checksumSha256: string;
  referenceRole: string | null;
  sourceCharacterRevisionId: string | null;
}

export function selectedReferenceUsable(reference: SelectedReferenceState, characterRevisionId: string): boolean {
  return reference.assetStatus === "ACTIVE"
    && reference.reviewStatus === "APPROVED"
    && reference.reviewedContentHash === reference.checksumSha256
    && reference.referenceRole === CHARACTER_REFERENCE_ROLE
    && reference.sourceCharacterRevisionId === characterRevisionId;
}

/**
 * Why a character cannot yet feed a strict-gate video, in a fixed order. Empty means usable. The listing and the
 * strict video gate both decide with this one function, so the page never says "usable" when the gate would refuse.
 */
export type CharacterReferenceBlocker =
  | "CHARACTER_REVISION_MISSING"
  | "CHARACTER_REVISION_NOT_CURRENT"
  | "CHARACTER_REVISION_STALE"
  | "CHARACTER_REVISION_NOT_APPROVED"
  | "REFERENCE_NOT_SELECTED"
  | "REFERENCE_SELECTION_OTHER_REVISION"
  | "REFERENCE_UNAVAILABLE"
  | "REFERENCE_NOT_ACTIVE"
  | "REFERENCE_NOT_APPROVED"
  | "REFERENCE_REVIEW_HASH_MISMATCH"
  | "REFERENCE_OTHER_REVISION";

export interface CharacterVideoReadinessInput {
  /** The revision the video needs: the shot's referenced revision, or the character's current one for the page. */
  requiredRevisionId: string | null;
  currentRevisionId: string | null;
  approvedRevisionId: string | null;
  revisionReviewStatus: string | null;
  revisionFreshness: string | null;
  /** null: no selection row. */
  selection: { sourceCharacterRevisionId: string; assetId: string } | null;
  /** null: the selected asset could not be read in this character's scope. */
  selectedAsset: SelectedReferenceState | null;
}

export function characterReferenceVideoBlockers(input: CharacterVideoReadinessInput): CharacterReferenceBlocker[] {
  const blockers: CharacterReferenceBlocker[] = [];
  const revisionId = input.requiredRevisionId;
  if (revisionId === null) {
    blockers.push("CHARACTER_REVISION_MISSING");
  } else {
    if (input.currentRevisionId !== revisionId) blockers.push("CHARACTER_REVISION_NOT_CURRENT");
    if (input.revisionFreshness !== "CURRENT") blockers.push("CHARACTER_REVISION_STALE");
    if (input.approvedRevisionId !== revisionId || input.revisionReviewStatus !== "APPROVED") {
      blockers.push("CHARACTER_REVISION_NOT_APPROVED");
    }
  }
  if (input.selection === null) {
    blockers.push("REFERENCE_NOT_SELECTED");
    return blockers;
  }
  if (revisionId !== null && input.selection.sourceCharacterRevisionId !== revisionId) {
    blockers.push("REFERENCE_SELECTION_OTHER_REVISION");
  }
  const asset = input.selectedAsset;
  if (asset === null || asset.referenceRole !== CHARACTER_REFERENCE_ROLE) {
    blockers.push("REFERENCE_UNAVAILABLE");
    return blockers;
  }
  if (asset.assetStatus !== "ACTIVE") blockers.push("REFERENCE_NOT_ACTIVE");
  if (asset.reviewStatus !== "APPROVED") blockers.push("REFERENCE_NOT_APPROVED");
  else if (asset.reviewedContentHash !== asset.checksumSha256) blockers.push("REFERENCE_REVIEW_HASH_MISMATCH");
  if (revisionId !== null && asset.sourceCharacterRevisionId !== revisionId) blockers.push("REFERENCE_OTHER_REVISION");
  return blockers;
}
