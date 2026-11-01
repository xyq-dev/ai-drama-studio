import { createHash } from "node:crypto";
import {
  VIMAX_PLANNING_BUDGET, VIMAX_PLANNING_PROMPT_VERSION, VIMAX_UPSTREAM_REVISION,
  vimaxCandidateTargetSchema, vimaxPlanningFrozenSchema, vimaxPlanningStartSchema, vimaxPlatformSourceSnapshotSchema,
  type TitleWritingProviderKey, type VimaxCandidateCreate, type VimaxCandidateTarget, type VimaxPlanningFrozen, type VimaxPlanningStart,
  type VimaxPlatformInput, type VimaxPlatformSourceSnapshot,
} from "@ai-drama/contracts";
import { sameVimaxCandidateSource } from "./vimax-candidate";
import { validateVimaxPlatformPlanningInput } from "./vimax-evaluation";

/** Version fields and byte-exact strings are meaningful here; never use text-chain normalization. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}
function compatible(value: unknown): boolean {
  if (typeof value === "string") {
    for (let n = 0; n < value.length; n += 1) {
      const c = value.charCodeAt(n);
      if (c === 0) return false;
      if (c >= 0xd800 && c <= 0xdbff) { const next = value.charCodeAt(++n); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
      else if (c >= 0xdc00 && c <= 0xdfff) return false;
    }
  }
  if (Array.isArray(value)) return value.every(compatible);
  if (value !== null && typeof value === "object") return Object.entries(value).every(([k, v]) => compatible(k) && compatible(v));
  return true;
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value), "utf8").digest("hex");
export function hashVimaxPlanningRequest(projectId: string, episodeId: string, request: VimaxPlanningStart): string {
  const body = vimaxPlanningStartSchema.parse(request);
  if (!compatible(body)) throw new Error("Planning request is not PostgreSQL JSON compatible");
  return digest({ schema: "ads.vimax-planning.identity.v1", projectId, episodeId, body });
}
export function hashVimaxPlanningFrozen(input: VimaxPlanningFrozen): string {
  const parsed = vimaxPlanningFrozenSchema.parse(input);
  if (!compatible(parsed)) throw new Error("Planning snapshot is not PostgreSQL JSON compatible");
  return digest(parsed);
}
export function vimaxPlanningPlatformInput(source: VimaxPlatformSourceSnapshot, request: VimaxPlanningStart): VimaxPlatformInput {
  return { schema: "ads.vimax-platform-input.v1", sourceKind: "workspace", upstreamRevision: VIMAX_UPSTREAM_REVISION, writingMode: "short",
    projectId: source.projectId, episodeId: source.episodeId, episodeNo: source.episodeNo,
    scriptRevisionId: source.scriptRevisionId, scriptContentHash: source.scriptContentHash, scriptText: source.scriptText,
    reviewStatus: "APPROVED", isCurrent: true, isStale: false, characters: source.characters,
    sceneSpans: request.sceneSpans, selectedSceneKeys: request.selectedSceneKeys, sourceDialogue: request.sourceDialogue, requirements: request.requirements };
}
export function freezeVimaxPlanning(sourceValue: VimaxPlatformSourceSnapshot, targetValue: VimaxCandidateTarget,
  requestValue: VimaxPlanningStart, providerKey: TitleWritingProviderKey, model: string):
  { ok: true; input: VimaxPlanningFrozen; frozenHash: string } | { ok: false; code: string } {
  const source = vimaxPlatformSourceSnapshotSchema.parse(sourceValue), target = vimaxCandidateTargetSchema.parse(targetValue);
  const request = vimaxPlanningStartSchema.parse(requestValue);
  if (!compatible(source) || !compatible(target) || !compatible(request)) return { ok: false, code: "VIMAX_PLANNING_INVALID_REQUEST" };
  if (!sameVimaxCandidateSource(source, request.source)) return { ok: false, code: "VIMAX_PLANNING_SOURCE_CHANGED" };
  const selectedIndex = request.sceneSpans.findIndex((s) => s.key === request.selectedSceneKeys[0]);
  if (target.sceneId !== request.target.sceneId || target.sceneRevisionId !== request.target.sceneRevisionId || target.rowVersion !== request.target.rowVersion
    || target.sourceScriptRevisionId !== source.scriptRevisionId || target.ordinal !== selectedIndex + 1 || target.heading !== request.sceneSpans[selectedIndex]?.heading) {
    return { ok: false, code: "VIMAX_PLANNING_TARGET_CHANGED" };
  }
  if (validateVimaxPlatformPlanningInput(vimaxPlanningPlatformInput(source, request))) return { ok: false, code: "VIMAX_PLANNING_INPUT_BLOCKED" };
  const input = vimaxPlanningFrozenSchema.parse({ schema: "ads.vimax-planning.frozen.v1", promptVersion: VIMAX_PLANNING_PROMPT_VERSION,
    source, target, request, providerKey, model, budget: VIMAX_PLANNING_BUDGET });
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 1024 * 1024) return { ok: false, code: "VIMAX_PLANNING_INPUT_TOO_LARGE" };
  return { ok: true, input, frozenHash: hashVimaxPlanningFrozen(input) };
}

/** A validated answer may add artifacts, never replace the frozen source, target or planning requirements. */
export function sameVimaxPlanningOutputInput(input: VimaxPlanningFrozen, output: VimaxCandidateCreate): boolean {
  const r = output.request;
  const reconstructed: VimaxPlanningStart = { ...input.request, target: output.target, source: r.source,
    sceneSpans: r.sceneSpans, selectedSceneKeys: r.selectedSceneKeys, sourceDialogue: r.sourceDialogue, requirements: r.requirements };
  return hashVimaxPlanningRequest(input.source.projectId, input.source.episodeId, reconstructed)
    === hashVimaxPlanningRequest(input.source.projectId, input.source.episodeId, input.request);
}
