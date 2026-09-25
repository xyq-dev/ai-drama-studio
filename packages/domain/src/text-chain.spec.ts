import { describe, expect, it } from "vitest";
import {
  assertProductionEpisodeSet,
  assertReviewTransition,
  canonicalInputHash,
  canonicalJson,
  DomainError,
} from "./index";

describe("review and episode gates", () => {
  it("keeps review and freshness as separate transitions", () => {
    expect(() => assertReviewTransition("DRAFT", "IN_REVIEW")).not.toThrow();
    expect(() => assertReviewTransition("IN_REVIEW", "APPROVED")).not.toThrow();
    expect(() => assertReviewTransition("IN_REVIEW", "REJECTED")).not.toThrow();
    expect(() => assertReviewTransition("DRAFT", "APPROVED")).toThrowError(
      expect.objectContaining({ code: "REVIEW_INVALID_TRANSITION" }),
    );
    expect(() => assertReviewTransition("APPROVED", "DRAFT")).toThrow(DomainError);
  });

  it("requires production episodes to be exactly {1,2,3}", () => {
    expect(() => assertProductionEpisodeSet([3, 1, 2])).not.toThrow();
    expect(() => assertProductionEpisodeSet([1, 2])).toThrowError(
      expect.objectContaining({ code: "EPISODE_SET_INVALID" }),
    );
    expect(() => assertProductionEpisodeSet([1, 2, 3, 4])).toThrow(DomainError);
  });
});

describe("canonical input hash", () => {
  it("is stable across object key order and preserves array order", () => {
    const left = canonicalInputHash({
      schema: "m2.story.revision.v1",
      sourceRevisionId: "story-1",
      sourceContentHash: "a".repeat(64),
      generation: { temperature: 0, beats: ["b", "a"] },
    });
    const right = canonicalInputHash({
      generation: { beats: ["b", "a"], temperature: 0 },
      sourceContentHash: "a".repeat(64),
      schema: "m2.story.revision.v1",
      sourceRevisionId: "story-1",
    });
    expect(left).toBe(right);
    expect(left).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson({ z: 1, a: [2, 1] })).toBe('{"a":[2,1],"z":1}');
    expect(canonicalInputHash({ schema: "m2.story.revision.v1", beats: ["a", "b"] })).not.toBe(
      canonicalInputHash({ schema: "m2.story.revision.v1", beats: ["b", "a"] }),
    );
  });

  it("rejects lifecycle and clock fields", () => {
    expect(() => canonicalInputHash({ schema: "m2.story.revision.v1", created_at: "now" })).toThrowError(
      expect.objectContaining({ code: "CANONICAL_INPUT_FORBIDDEN" }),
    );
    expect(() => canonicalInputHash({ review_version: 1 })).toThrow(DomainError);
    expect(() => canonicalInputHash({ rowVersion: 2 })).toThrow(DomainError);
  });
});
