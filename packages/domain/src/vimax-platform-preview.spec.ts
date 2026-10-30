import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  VIMAX_PLATFORM_INPUT_SCHEMA,
  VIMAX_PLATFORM_PREVIEW_REQUEST_SCHEMA,
  vimaxEvaluationInputSchema,
  vimaxEvaluationSupplementsSchema,
  vimaxPlanCandidateSchema,
  vimaxPlatformInputSchema,
  vimaxPlatformPreviewReportSchema,
  vimaxPlatformPreviewRequestSchema,
} from "@ai-drama/contracts";
import { evaluateVimaxPlan, evaluateVimaxPlatformPreview } from "./vimax-evaluation";

function fixture() {
  const raw = JSON.parse(readFileSync(resolve(__dirname, "../../../scripts/vimax-evaluation/fixtures/single-scene.json"), "utf8")) as Record<string, unknown>;
  const offline = vimaxEvaluationInputSchema.parse(raw.input);
  return {
    offline,
    input: vimaxPlatformInputSchema.parse({ ...offline, schema: VIMAX_PLATFORM_INPUT_SCHEMA, sourceKind: "workspace" }),
    candidate: vimaxPlanCandidateSchema.parse(raw.candidate),
    supplements: vimaxEvaluationSupplementsSchema.parse(raw.supplements),
  };
}

describe("ViMax platform preview has a distinct read-only contract", () => {
  it("retains exact source and candidate, without granting save or claiming measured media", () => {
    const f = fixture();
    const before = JSON.stringify(f);
    const report = evaluateVimaxPlatformPreview(f.input, f.candidate, f.supplements);
    expect(vimaxPlatformPreviewReportSchema.safeParse(report).success).toBe(true);
    expect(report.status).toBe("ready_for_review");
    expect(report.writeAllowed).toBe(false);
    expect(report.gaps).toEqual(expect.arrayContaining([
      "semantic_review_required", "preview_is_not_write_authorization", "planned_duration_not_measured", "source_can_change_after_preview",
    ]));
    if (report.status !== "ready_for_review") throw new Error("fixture blocked");
    expect(report.review.sourceSceneText).toBe(f.input.scriptText);
    expect(report.review.candidate).toEqual(f.candidate);
    expect(report.review.shots).toEqual(f.supplements.shots);
    expect(report.review.plannedTotalSeconds).toBe(13);
    expect(evaluateVimaxPlatformPreview(f.input, f.candidate, f.supplements)).toEqual(report);
    expect(JSON.stringify(f)).toBe(before);
  });

  it("rejects E1 fixtures as platform snapshots, and platform snapshots as E1 fixtures", () => {
    const f = fixture();
    expect(evaluateVimaxPlatformPreview(f.offline, f.candidate, f.supplements).diagnostics).toEqual([{ code: "invalid_input", path: "input" }]);
    expect(evaluateVimaxPlan(f.input, f.candidate, f.supplements).diagnostics).toEqual([{ code: "invalid_input", path: "input" }]);
    const platform = evaluateVimaxPlatformPreview(f.input, f.candidate, f.supplements);
    const offline = evaluateVimaxPlan(f.offline, f.candidate, f.supplements);
    expect(platform.schema).not.toBe(offline.schema);
    expect(platform.provenance!.inputHash).not.toBe(offline.provenance!.inputHash);
    expect(platform.provenance!.candidateHash).toBe(offline.provenance!.candidateHash);
    expect(platform.provenance!.supplementsHash).toBe(offline.provenance!.supplementsHash);
    expect(offline.gaps).toContain("frozen_metadata_not_live_verified");
  });

  it.each(["synthetic", "redacted", "live", "production"])("does not relabel %s as workspace data", (sourceKind) => {
    const f = fixture();
    expect(evaluateVimaxPlatformPreview({ ...f.input, sourceKind }, f.candidate, f.supplements).status).toBe("blocked");
  });

  it.each(["dialogue", "camera", "hash", "identity"])("preserves the strict E1 %s refusal", (failure) => {
    const f = fixture();
    if (failure === "dialogue") f.supplements.shots[1]!.dialogue[0]!.line = "不是原文的台词";
    if (failure === "camera") f.candidate.camera_tree[1]!.parent_cam_idx = 1;
    if (failure === "hash") f.input.scriptContentHash = f.offline.scriptContentHash = "0".repeat(64);
    if (failure === "identity") f.supplements.characters[0]!.characterKey = "C30";
    const actual = evaluateVimaxPlatformPreview(f.input, f.candidate, f.supplements);
    const original = evaluateVimaxPlan(f.offline, f.candidate, f.supplements);
    expect(actual.status).toBe("blocked");
    expect(actual.review).toBeNull();
    expect(actual.diagnostics).toEqual(original.diagnostics);
    expect(vimaxPlatformPreviewReportSchema.safeParse(actual).success).toBe(true);
  });

  it("does not execute getters before schema validation or include rejected private text", () => {
    const f = fixture();
    const getter = vi.fn(() => "private-rejected-line");
    Object.defineProperty(f.candidate, "characters", { enumerable: true, get: getter });
    const report = evaluateVimaxPlatformPreview(f.input, f.candidate, f.supplements);
    expect(getter).not.toHaveBeenCalled();
    expect(report.diagnostics).toEqual([{ code: "non_json_value", path: "candidate" }]);
    expect(JSON.stringify(report)).not.toContain("private-rejected-line");
    expect(vimaxPlatformPreviewReportSchema.safeParse(report).success).toBe(true);
  });

  it("accepts only explicit request source identities, never client-provided approval or source text", () => {
    const f = fixture();
    const request = {
      schema: VIMAX_PLATFORM_PREVIEW_REQUEST_SCHEMA,
      source: { scriptRevisionId: f.input.scriptRevisionId, scriptContentHash: f.input.scriptContentHash, characters: f.input.characters },
      sceneSpans: f.input.sceneSpans, selectedSceneKeys: f.input.selectedSceneKeys, sourceDialogue: f.input.sourceDialogue,
      requirements: f.input.requirements, candidate: f.candidate, supplements: f.supplements,
    };
    expect(vimaxPlatformPreviewRequestSchema.safeParse(request).success).toBe(true);
    for (const injection of [
      { ...request, input: f.offline }, { ...request, writeAllowed: true }, { ...request, projectId: f.input.projectId },
      { ...request, source: { ...request.source, scriptText: f.input.scriptText } },
      { ...request, source: { ...request.source, reviewStatus: "APPROVED" } },
    ]) expect(vimaxPlatformPreviewRequestSchema.safeParse(injection).success).toBe(false);
    const report = evaluateVimaxPlan(f.offline, f.candidate, f.supplements);
    expect(vimaxPlatformPreviewRequestSchema.safeParse(report).success).toBe(false);
  });
});
