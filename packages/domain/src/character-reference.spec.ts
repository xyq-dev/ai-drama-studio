import { describe, expect, it } from "vitest";
import {
  CHARACTER_REFERENCE_SNAPSHOT_SCHEMA,
  characterReferenceVideoBlockers,
  parseCharacterReferenceGateMode,
  parseCharacterReferenceReviewRequest,
  parseCharacterReferenceSelectionRequest,
  parseCharacterReferenceSnapshot,
  selectedReferenceUsable,
} from "./character-reference";

const REVISION = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222";
const HASH = "ab".repeat(32);

describe("character reference rules", () => {
  it("keeps legacy as the default gate and accepts only legacy or strict", () => {
    expect(parseCharacterReferenceGateMode(undefined)).toBe("legacy");
    expect(parseCharacterReferenceGateMode("")).toBe("legacy");
    expect(parseCharacterReferenceGateMode("strict")).toBe("strict");
    expect(() => parseCharacterReferenceGateMode("lenient")).toThrow(/legacy or strict/);
  });

  it("accepts only the exact frozen generation snapshot", () => {
    const snapshot = { schema: CHARACTER_REFERENCE_SNAPSHOT_SCHEMA, characterRevisionId: REVISION,
      characterContentHash: HASH, seed: null, bypassCache: false, outcome: "success", executionMode: "sync",
      capability: "image.generate" };
    expect(parseCharacterReferenceSnapshot(snapshot)).toEqual(snapshot);
    expect(() => parseCharacterReferenceSnapshot({ ...snapshot, extra: 1 })).toThrow();
    expect(() => parseCharacterReferenceSnapshot({ ...snapshot, capability: "video.generate" })).toThrow();
    expect(() => parseCharacterReferenceSnapshot({ ...snapshot, characterRevisionId: "nope" })).toThrow();
  });

  it("parses a review that pins the reviewed bytes and needs a note to reject", () => {
    expect(parseCharacterReferenceReviewRequest({ decision: "APPROVED", expectedRowVersion: 1, contentHash: HASH }))
      .toEqual({ decision: "APPROVED", expectedRowVersion: 1, contentHash: HASH, note: null });
    expect(() => parseCharacterReferenceReviewRequest({ decision: "REJECTED", expectedRowVersion: 1, contentHash: HASH }))
      .toThrow(/note/);
    expect(() => parseCharacterReferenceReviewRequest({ decision: "APPROVED", expectedRowVersion: 0, contentHash: HASH }))
      .toThrow();
    expect(() => parseCharacterReferenceReviewRequest({ decision: "APPROVED", expectedRowVersion: 1, contentHash: "x" }))
      .toThrow();
    expect(() => parseCharacterReferenceReviewRequest({ decision: "APPROVED", expectedRowVersion: 1, contentHash: HASH,
      reviewer: "x" })).toThrow();
  });

  it("parses a compare-and-set selection", () => {
    expect(parseCharacterReferenceSelectionRequest({ assetId: ASSET.toUpperCase(), expectedSelectedAssetId: null }))
      .toEqual({ assetId: ASSET, expectedSelectedAssetId: null });
    expect(() => parseCharacterReferenceSelectionRequest({ assetId: ASSET })).toThrow();
    expect(() => parseCharacterReferenceSelectionRequest({ assetId: "x", expectedSelectedAssetId: null })).toThrow();
  });

  it("treats only an ACTIVE reference approved on its bytes from the same revision as usable", () => {
    const good = { assetStatus: "ACTIVE", reviewStatus: "APPROVED", reviewedContentHash: HASH, checksumSha256: HASH,
      referenceRole: "character_reference", sourceCharacterRevisionId: REVISION };
    expect(selectedReferenceUsable(good, REVISION)).toBe(true);
    expect(selectedReferenceUsable({ ...good, assetStatus: "STALE" }, REVISION)).toBe(false);
    expect(selectedReferenceUsable({ ...good, reviewStatus: "DRAFT" }, REVISION)).toBe(false);
    expect(selectedReferenceUsable({ ...good, reviewedContentHash: "cd".repeat(32) }, REVISION)).toBe(false);
    expect(selectedReferenceUsable({ ...good, referenceRole: null }, REVISION)).toBe(false);
    expect(selectedReferenceUsable(good, ASSET)).toBe(false);
  });
});

describe("characterReferenceVideoBlockers", () => {
  const reference = { assetStatus: "ACTIVE", reviewStatus: "APPROVED", reviewedContentHash: "a".repeat(64),
    checksumSha256: "a".repeat(64), referenceRole: "character_reference", sourceCharacterRevisionId: REVISION };
  const ready = { requiredRevisionId: REVISION, currentRevisionId: REVISION, approvedRevisionId: REVISION,
    revisionReviewStatus: "APPROVED", revisionFreshness: "CURRENT",
    selection: { sourceCharacterRevisionId: REVISION, assetId: ASSET }, selectedAsset: reference };

  it("is empty only when the character revision and its selected reference both pass", () => {
    expect(characterReferenceVideoBlockers(ready)).toEqual([]);
    expect(characterReferenceVideoBlockers({ ...ready, approvedRevisionId: null, revisionReviewStatus: "DRAFT" }))
      .toEqual(["CHARACTER_REVISION_NOT_APPROVED"]);
    expect(characterReferenceVideoBlockers({ ...ready, revisionFreshness: "STALE" })).toEqual(["CHARACTER_REVISION_STALE"]);
    expect(characterReferenceVideoBlockers({ ...ready, currentRevisionId: ASSET })).toEqual(["CHARACTER_REVISION_NOT_CURRENT"]);
    expect(characterReferenceVideoBlockers({ ...ready, requiredRevisionId: null })).toEqual(["CHARACTER_REVISION_MISSING"]);
    expect(characterReferenceVideoBlockers({ ...ready, selection: null })).toEqual(["REFERENCE_NOT_SELECTED"]);
    expect(characterReferenceVideoBlockers({ ...ready, selectedAsset: null })).toEqual(["REFERENCE_UNAVAILABLE"]);
    expect(characterReferenceVideoBlockers({ ...ready, selectedAsset: { ...reference, reviewStatus: "DRAFT" } }))
      .toEqual(["REFERENCE_NOT_APPROVED"]);
    expect(characterReferenceVideoBlockers({ ...ready, selectedAsset: { ...reference, reviewedContentHash: "b".repeat(64) } }))
      .toEqual(["REFERENCE_REVIEW_HASH_MISMATCH"]);
  });

  it("agrees with selectedReferenceUsable on the reference half of the rule", () => {
    const variants = [reference, { ...reference, assetStatus: "STALE" }, { ...reference, reviewStatus: "REJECTED" },
      { ...reference, reviewedContentHash: null }, { ...reference, referenceRole: null },
      { ...reference, sourceCharacterRevisionId: ASSET }];
    for (const selectedAsset of variants) {
      expect(characterReferenceVideoBlockers({ ...ready, selectedAsset }).length === 0)
        .toBe(selectedReferenceUsable(selectedAsset, REVISION));
    }
  });
});
