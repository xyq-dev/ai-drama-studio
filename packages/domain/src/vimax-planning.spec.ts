import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { vimaxPlanningStartSchema, vimaxPlatformSourceSnapshotSchema } from "@ai-drama/contracts";
import { freezeVimaxPlanning, hashVimaxPlanningFrozen, hashVimaxPlanningRequest } from "./vimax-planning";
// Explicit projection also verifies that fixture-only approval/identity fields cannot enter the server source.
function setup() {
  const raw = JSON.parse(readFileSync(resolve(__dirname, "../../../scripts/vimax-evaluation/fixtures/single-scene.json"), "utf8"));
  const i = raw.input;
  const source = vimaxPlatformSourceSnapshotSchema.parse({ schema: "ads.vimax-platform-source.v1", scriptRevisionNo: 1, projectId: i.projectId,
    episodeId: i.episodeId, episodeNo: i.episodeNo, scriptRevisionId: i.scriptRevisionId, scriptContentHash: i.scriptContentHash, scriptText: i.scriptText, characters: i.characters });
  const request = vimaxPlanningStartSchema.parse({ schema: "ads.vimax-planning.start.v1", target: { sceneId: "99999999-9999-4999-8999-999999999991", sceneRevisionId: "99999999-9999-4999-8999-999999999992", rowVersion: 3 },
    source: { scriptRevisionId: i.scriptRevisionId, scriptContentHash: i.scriptContentHash, characters: i.characters },
    sceneSpans: i.sceneSpans, selectedSceneKeys: i.selectedSceneKeys, sourceDialogue: i.sourceDialogue, requirements: i.requirements, confirmedTextSend: true });
  const target = { ...request.target, sourceScriptRevisionId: i.scriptRevisionId, ordinal: 1, heading: i.sceneSpans[0].heading, timeOfDay: "夜", summary: "原场景", locationRevisionId: null };
  return { source, request, target };
}
describe("governed ViMax planning admission", () => {
  it("freezes only exact server source and selected existing target with a single send budget", () => {
    const f = setup(), result = freezeVimaxPlanning(f.source, f.target, f.request, "openai", "gpt-4.1");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("fixture blocked");
    expect(result.input.budget).toEqual({ maxCalls: 1, maxOutputTokens: 4096, timeoutMs: 120000 });
    expect(result.frozenHash).toBe(hashVimaxPlanningFrozen(result.input));
    expect(result.input.source.scriptText).toBe(f.source.scriptText);
  });
  it.each(["script", "character", "target", "span", "dialogue"])("refuses changed %s before any send reservation", (kind) => {
    const f = setup();
    if (kind === "script") f.request.source.scriptContentHash = "0".repeat(64);
    if (kind === "character") f.request.source.characters[0]!.name += " ";
    if (kind === "target") f.target.rowVersion++;
    if (kind === "span") f.request.sceneSpans[0]!.end--;
    if (kind === "dialogue") f.request.sourceDialogue[0]!.line += "改写";
    expect(freezeVimaxPlanning(f.source, f.target, f.request, "openai", "gpt-4.1").ok).toBe(false);
  });
  it("hashes versions, original whitespace and uncertain confirmation without text normalization", () => {
    const f = setup(), h = () => hashVimaxPlanningRequest(f.source.projectId, f.source.episodeId, f.request);
    const original = h(); f.request.target.rowVersion++; expect(h()).not.toBe(original); f.request.target.rowVersion--;
    f.request.requirements.style += " "; expect(h()).not.toBe(original); f.request.requirements.style = f.request.requirements.style.slice(0, -1);
    f.request.confirmUncertainRequestId = "99999999-9999-4999-8999-999999999993"; expect(h()).not.toBe(original);
    f.request.requirements.style = "café"; const composed = h(); f.request.requirements.style = "cafe\u0301"; expect(h()).not.toBe(composed);
  });
  it("rejects unpaired surrogates and spoofed send permissions", () => {
    const f = setup(); f.request.requirements.style = "\ud800";
    expect(() => hashVimaxPlanningRequest(f.source.projectId, f.source.episodeId, f.request)).toThrow();
    expect(freezeVimaxPlanning(f.source, f.target, f.request, "openai", "gpt-4.1").ok).toBe(false);
    expect(vimaxPlanningStartSchema.safeParse({ ...f.request, providerKey: "openai" }).success).toBe(false);
    expect(vimaxPlanningStartSchema.safeParse({ ...f.request, confirmedTextSend: false }).success).toBe(false);
  });
});
