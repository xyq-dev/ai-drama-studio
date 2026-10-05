import { describe, expect, it } from "vitest";
import {
  characterReferenceAllowed,
  classifyGenerationAction,
  regenerationSeed,
  storyboardPreviewAllowed,
  videoGenerationAllowed,
} from "./media-gates";

describe("media gates", () => {
  it("allows a character reference from an approved current script without approving the character", () => {
    expect(characterReferenceAllowed({
      scriptApproved: true, scriptCurrent: true, characterFreshness: "CURRENT", inputValid: true,
    })).toBe(true);
    expect(characterReferenceAllowed({
      scriptApproved: true, scriptCurrent: true, characterFreshness: "STALE", inputValid: true,
    })).toBe(false);
    expect(characterReferenceAllowed({
      scriptApproved: false, scriptCurrent: true, characterFreshness: "CURRENT", inputValid: true,
    })).toBe(false);
  });

  it("allows storyboard preview before shot approval and keeps the video gate closed until every source is approved", () => {
    expect(storyboardPreviewAllowed({ shotCurrent: true, shotStale: false, sceneApproved: true })).toBe(true);
    expect(storyboardPreviewAllowed({ shotCurrent: true, shotStale: true, sceneApproved: true })).toBe(false);
    expect(videoGenerationAllowed({
      characterApproved: true,
      selectedReferenceApproved: true,
      referenceRole: "character_reference",
      shotApproved: true,
      shotCurrent: true,
    })).toBe(true);
    expect(videoGenerationAllowed({
      characterApproved: true,
      selectedReferenceApproved: false,
      referenceRole: "character_reference",
      shotApproved: true,
      shotCurrent: true,
    })).toBe(false);
    expect(videoGenerationAllowed({
      characterApproved: true,
      selectedReferenceApproved: true,
      referenceRole: "other",
      shotApproved: true,
      shotCurrent: true,
    })).toBe(false);
  });

  it("keeps failed-job retry distinct from an explicit regenerate", () => {
    expect(classifyGenerationAction({ endpoint: "retry", jobState: "FAILED", bypassCache: false })).toBe("retry");
    expect(classifyGenerationAction({ endpoint: "retry", jobState: "SUCCEEDED", bypassCache: true })).toBe("reject");
    expect(classifyGenerationAction({ endpoint: "content", jobState: "SUCCEEDED", bypassCache: true })).toBe("regenerate");
    expect(classifyGenerationAction({ endpoint: "content", jobState: "FAILED", bypassCache: false })).toBe("generate");
    expect(regenerationSeed("same", false, "0123456789")).toEqual({ seed: "same", bypassCache: false });
    expect(regenerationSeed("same", true, "regen-seed-1").bypassCache).toBe(true);
    expect(regenerationSeed("same", true, "regen-seed-1").seed).not.toBe("same");
  });
});
