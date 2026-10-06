import { describe, expect, it } from "vitest";
import {
  CHARACTER_REFERENCE_SNAPSHOT_SCHEMA,
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
