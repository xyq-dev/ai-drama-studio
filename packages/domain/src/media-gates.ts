import { DomainError } from "./errors";

export interface CharacterReferenceGate {
  scriptApproved: boolean;
  scriptCurrent: boolean;
  characterFreshness: "CURRENT" | "STALE";
  inputValid: boolean;
}

/** Character reference images do not require the character revision to be approved first. */
export function characterReferenceAllowed(input: CharacterReferenceGate): boolean {
  return input.scriptApproved && input.scriptCurrent && input.characterFreshness === "CURRENT" && input.inputValid;
}

export function storyboardPreviewAllowed(input: {
  shotCurrent: boolean;
  shotStale: boolean;
  sceneApproved: boolean;
}): boolean {
  return input.shotCurrent && !input.shotStale && input.sceneApproved;
}

export interface VideoGenerationGate {
  characterApproved: boolean;
  selectedReferenceApproved: boolean;
  referenceRole: "character_reference" | "other" | null;
  shotApproved: boolean;
  shotCurrent: boolean;
}

export function videoGenerationAllowed(input: VideoGenerationGate): boolean {
  return input.characterApproved
    && input.selectedReferenceApproved
    && input.referenceRole === "character_reference"
    && input.shotApproved
    && input.shotCurrent;
}

export type GenerationAction = "retry" | "regenerate" | "generate" | "reject";

export function classifyGenerationAction(input: {
  endpoint: "retry" | "content";
  jobState: "SUCCEEDED" | "FAILED" | "CANCELED" | "RUNNING" | "QUEUED";
  bypassCache: boolean;
}): GenerationAction {
  if (input.endpoint === "retry") {
    if (input.jobState === "FAILED" || input.jobState === "CANCELED") return "retry";
    return "reject";
  }
  return input.bypassCache ? "regenerate" : "generate";
}

export function regenerationSeed(
  seed: string | null,
  bypassCache: boolean,
  nextSeed: string,
): { seed: string | null; bypassCache: boolean } {
  if (classifyGenerationAction({ endpoint: "content", jobState: "SUCCEEDED", bypassCache }) !== "regenerate") {
    return { seed, bypassCache: false };
  }
  if (!/^[\w-]{8,80}$/.test(nextSeed)) {
    throw new DomainError("VALIDATION_ERROR", "regeneration seed is invalid");
  }
  return { seed: nextSeed, bypassCache: true };
}
