import { createHash } from "node:crypto";
import { types } from "node:util";
import {
  SCRIPT_BREAKDOWN_OUTPUT_SCHEMA,
  SCRIPT_BREAKDOWN_LIMITS,
  VIMAX_EVALUATION_LIMITS,
  VIMAX_EVALUATION_REPORT_SCHEMA,
  VIMAX_UPSTREAM_REVISION,
  VIMAX_PLATFORM_PREVIEW_REPORT_SCHEMA,
  vimaxEvaluationInputSchema,
  vimaxEvaluationSupplementsSchema,
  vimaxPlanCandidateSchema,
  vimaxPlatformInputSchema,
  type VimaxEvaluationCode,
  type VimaxEvaluationDiagnostic,
  type VimaxEvaluationInput,
  type VimaxEvaluationProvenance,
  type VimaxEvaluationReport,
  type VimaxEvaluationSupplements,
  type VimaxPlanCandidate,
  type VimaxPlatformInput,
  type VimaxPlatformPreviewReport,
} from "@ai-drama/contracts";
import { validateScriptBreakdownOutput } from "./script-breakdown";

const GAPS = [
  "semantic_review_required",
  "single_scene_write_not_implemented",
  "planned_duration_not_measured",
  "frozen_metadata_not_live_verified",
] as const;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const diagnostic = (code: VimaxEvaluationCode, path: string): VimaxEvaluationDiagnostic => ({ code, path });
const duplicates = (items: readonly unknown[]) => new Set(items).size !== items.length;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
type PlanningInput = VimaxEvaluationInput | VimaxPlatformInput;

/** Inspect descriptors before schema parsing: getters, exotic objects, cycles and shared JS objects are not JSON. */
function jsonBoundary(value: unknown, path: string): VimaxEvaluationDiagnostic | null {
  const stack = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  try {
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (++nodes > VIMAX_EVALUATION_LIMITS.maxNodes || next.depth > VIMAX_EVALUATION_LIMITS.maxDepth) {
        return diagnostic("input_too_large", path);
      }
      const item = next.value;
      if (typeof item === "string") bytes += Buffer.byteLength(item, "utf8");
      else if (typeof item === "number") {
        if (!Number.isFinite(item)) return diagnostic("non_json_value", path);
      } else if (item !== null && typeof item !== "boolean") {
        if (typeof item !== "object" || types.isProxy(item) || seen.has(item)) return diagnostic("non_json_value", path);
        seen.add(item);
        const array = Array.isArray(item);
        const prototype = Object.getPrototypeOf(item);
        // Array subclasses/custom prototypes can inherit executable toJSON or map methods too.
        if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
          return diagnostic("non_json_value", path);
        }
        const entries = Reflect.ownKeys(item);
        if (entries.length > VIMAX_EVALUATION_LIMITS.maxNodes) return diagnostic("input_too_large", path);
        if (array && item.length > VIMAX_EVALUATION_LIMITS.maxNodes) return diagnostic("input_too_large", path);
        for (const key of entries) {
          if (typeof key !== "string") return diagnostic("non_json_value", path);
          if (array && key === "length") continue;
          const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
          if (!descriptor.enumerable || !("value" in descriptor)) return diagnostic("non_json_value", path);
          if (array && !/^(0|[1-9][0-9]*)$/.test(key)) return diagnostic("non_json_value", path);
          bytes += Buffer.byteLength(key, "utf8");
          stack.push({ value: descriptor.value as unknown, depth: next.depth + 1 });
        }
        if (array && entries.length !== item.length + 1) return diagnostic("non_json_value", path);
      }
      if (bytes > VIMAX_EVALUATION_LIMITS.maxJsonBytes) return diagnostic("input_too_large", path);
    }
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > VIMAX_EVALUATION_LIMITS.maxJsonBytes) {
      return diagnostic("input_too_large", path);
    }
  } catch {
    return diagnostic("non_json_value", path);
  }
  return null;
}

/** Canonical JSON: object keys sorted lexically, array order preserved; only bounded JSON reaches this function. */
function canonical(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
}
const jsonHash = (value: unknown) => sha256(canonical(value as Json));

interface SourceLine { start: number; end: number; text: string }
function linesOf(text: string, offset: number): SourceLine[] {
  const lines: SourceLine[] = [];
  const pattern = /([^\r\n]*)(\r\n|\r|\n|$)/g;
  for (const match of text.matchAll(pattern)) {
    if (match[0].length === 0) break;
    lines.push({ start: offset + match.index, end: offset + match.index + match[1]!.length, text: match[1]! });
  }
  return lines;
}

function sourceCheck(input: PlanningInput): VimaxEvaluationDiagnostic | null {
  if (sha256(input.scriptText) !== input.scriptContentHash) return diagnostic("source_hash_mismatch", "input.scriptContentHash");
  let end = 0;
  for (const [index, scene] of input.sceneSpans.entries()) {
    if (scene.key !== `S${String(index + 1)}` || scene.start !== end || scene.end <= scene.start
      || scene.end > input.scriptText.length || (scene.start > 0 && !/[\r\n]/.test(input.scriptText[scene.start - 1]!))
      || (input.scriptText[scene.start] === "\n" && input.scriptText[scene.start - 1] === "\r")) {
      return diagnostic("scene_scope_invalid", `input.sceneSpans[${String(index)}]`);
    }
    const lines = linesOf(input.scriptText.slice(scene.start, scene.end), scene.start);
    if (lines[0]?.text !== `【场景】${scene.heading}` || lines.slice(1).some((line) => line.text.startsWith("【场景】"))) {
      return diagnostic("scene_scope_invalid", `input.sceneSpans[${String(index)}]`);
    }
    end = scene.end;
  }
  const selected = input.sceneSpans.find((scene) => scene.key === input.selectedSceneKeys[0]);
  if (end !== input.scriptText.length || !selected) return diagnostic("scene_scope_invalid", "input.sceneSpans");
  if (duplicates(input.characters.map((item) => item.key)) || duplicates(input.characters.map((item) => item.characterId))
    || duplicates(input.characters.map((item) => item.revisionId))) return diagnostic("duplicate_character", "input.characters");
  const expected: Array<SourceLine & { speaker: string; line: string }> = [];
  for (const physical of linesOf(input.scriptText.slice(selected.start, selected.end), selected.start).slice(1)) {
    if (/^\s*$/.test(physical.text)) continue;
    if (physical.text.startsWith("【动作】") && physical.text.slice(4).trim().length > 0) continue;
    const spoken = /^([^：\r\n【】]{1,20})：(.+)$/u.exec(physical.text);
    if (!spoken) return diagnostic("source_format_unsupported", "input.scriptText");
    expected.push({ ...physical, speaker: spoken[1]!, line: spoken[2]! });
  }
  if (duplicates(input.sourceDialogue.map((item) => item.id)) || input.sourceDialogue.length !== expected.length) {
    return diagnostic("source_dialogue_invalid", "input.sourceDialogue");
  }
  for (const [index, source] of input.sourceDialogue.entries()) {
    const physical = expected[index]!;
    if (source.start !== physical.start || source.end !== physical.end || source.speaker !== physical.speaker || source.line !== physical.line) {
      return diagnostic("source_dialogue_invalid", `input.sourceDialogue[${String(index)}]`);
    }
    const known = input.characters.filter((character) => character.name === source.speaker);
    if (known.length === 0) return diagnostic("unknown_character", `input.sourceDialogue[${String(index)}].characterKey`);
    if (!known.some((character) => character.key === source.characterKey)) {
      return diagnostic("character_mapping_invalid", `input.sourceDialogue[${String(index)}].characterKey`);
    }
  }
  return null;
}

function candidateCheck(candidate: VimaxPlanCandidate): VimaxEvaluationDiagnostic | null {
  if (candidate.characters.some((item, index) => item.idx !== index) || duplicates(candidate.characters.map((item) => item.identifier_in_scene))) {
    return diagnostic("duplicate_character", "candidate.characters");
  }
  if (candidate.storyboard.length !== candidate.shot_descriptions.length
    || candidate.storyboard.some((shot, index) => shot.idx !== index || shot.is_last !== (index === candidate.storyboard.length - 1))) {
    return diagnostic("shot_sequence_invalid", "candidate.storyboard");
  }
  for (const [index, shot] of candidate.shot_descriptions.entries()) {
    const brief = candidate.storyboard[index]!;
    if (shot.idx !== brief.idx || shot.is_last !== brief.is_last || shot.cam_idx !== brief.cam_idx
      || shot.visual_desc !== brief.visual_desc || shot.audio_desc !== brief.audio_desc) {
      return diagnostic("shot_detail_mismatch", `candidate.shot_descriptions[${String(index)}]`);
    }
    for (const field of ["ff_vis_char_idxs", "lf_vis_char_idxs"] as const) {
      if (duplicates(shot[field]) || shot[field].some((idx) => !candidate.characters[idx]?.is_visible)) {
        return diagnostic("unknown_character", `candidate.shot_descriptions[${String(index)}].${field}`);
      }
    }
  }
  if (candidate.camera_tree.some((camera, index) => camera.idx !== index)) return diagnostic("camera_reference_invalid", "candidate.camera_tree");
  const root = candidate.camera_tree[0]!;
  if (root.parent_cam_idx !== null || root.parent_shot_idx !== null || candidate.storyboard[0]!.cam_idx !== root.idx
    || candidate.camera_tree.slice(1).some((camera) => camera.parent_cam_idx === null || camera.parent_shot_idx === null)) {
    return diagnostic("camera_root_invalid", "candidate.camera_tree");
  }
  const members: number[] = [];
  for (const camera of candidate.camera_tree) {
    if (camera.active_shot_idxs.some((idx) => candidate.storyboard[idx]?.cam_idx !== camera.idx) || duplicates(camera.active_shot_idxs)) {
      return diagnostic("camera_membership_invalid", `candidate.camera_tree[${String(camera.idx)}].active_shot_idxs`);
    }
    members.push(...camera.active_shot_idxs);
    if (camera.parent_cam_idx !== null) {
      const parent = candidate.camera_tree[camera.parent_cam_idx];
      if (!parent || parent.idx === camera.idx || camera.parent_shot_idx === null || !parent.active_shot_idxs.includes(camera.parent_shot_idx)) {
        return diagnostic("camera_reference_invalid", `candidate.camera_tree[${String(camera.idx)}]`);
      }
    }
  }
  if (duplicates(members) || members.length !== candidate.storyboard.length) return diagnostic("camera_membership_invalid", "candidate.camera_tree");
  for (const camera of candidate.camera_tree) {
    const seen = new Set<number>();
    let current: number | null = camera.idx;
    while (current !== null) {
      if (seen.has(current)) return diagnostic("camera_cycle", "candidate.camera_tree");
      seen.add(current);
      current = candidate.camera_tree[current]!.parent_cam_idx;
    }
  }
  return null;
}

function supplementCheck(input: PlanningInput, candidate: VimaxPlanCandidate, supplements: VimaxEvaluationSupplements): VimaxEvaluationDiagnostic | null {
  if (supplements.characters.length !== candidate.characters.length
    || supplements.characters.some((item, index) => item.vimaxIndex !== index)
    || duplicates(supplements.characters.map((item) => item.characterKey))) return diagnostic("character_mapping_invalid", "supplements.characters");
  const keys = new Set(input.characters.map((item) => item.key));
  if (supplements.characters.some((item) => !keys.has(item.characterKey))) return diagnostic("unknown_character", "supplements.characters");
  if (supplements.shots.length !== candidate.storyboard.length || supplements.shots.some((item, index) => item.vimaxShotIndex !== index)) {
    return diagnostic("supplement_mapping_invalid", "supplements.shots");
  }
  const sourceById = new Map(input.sourceDialogue.map((item) => [item.id, item]));
  const actualIds: string[] = [];
  for (const [index, shot] of supplements.shots.entries()) {
    if (duplicates(shot.characterKeys) || shot.characterKeys.some((key) => !keys.has(key))) {
      return diagnostic("unknown_character", `supplements.shots[${String(index)}].characterKeys`);
    }
    const detail = candidate.shot_descriptions[index]!;
    if ([...detail.ff_vis_char_idxs, ...detail.lf_vis_char_idxs].some((idx) => !shot.characterKeys.includes(supplements.characters[idx]!.characterKey))) {
      return diagnostic("character_mapping_invalid", `supplements.shots[${String(index)}].characterKeys`);
    }
    for (const [lineIndex, line] of shot.dialogue.entries()) {
      const source = sourceById.get(line.sourceDialogueId);
      if (!source || source.speaker !== line.speaker || source.line !== line.line || source.characterKey !== line.characterKey) {
        return diagnostic("dialogue_changed", `supplements.shots[${String(index)}].dialogue[${String(lineIndex)}]`);
      }
      if (line.characterKey !== null && !shot.characterKeys.includes(line.characterKey)) {
        return diagnostic("character_mapping_invalid", `supplements.shots[${String(index)}].dialogue[${String(lineIndex)}].characterKey`);
      }
      actualIds.push(line.sourceDialogueId);
    }
  }
  if (actualIds.length !== input.sourceDialogue.length || actualIds.some((id, index) => id !== input.sourceDialogue[index]!.id)) {
    return diagnostic("dialogue_coverage_invalid", "supplements.shots");
  }
  return null;
}

/** An internal validator coordinate projection only; this is never returned, imported, or sent to a save operation. */
function secondaryCheck(input: PlanningInput, supplements: VimaxEvaluationSupplements): VimaxEvaluationDiagnostic | null {
  const scene = input.sceneSpans.find((item) => item.key === input.selectedSceneKeys[0])!;
  const output = { schema: SCRIPT_BREAKDOWN_OUTPUT_SCHEMA, episodeNo: input.episodeNo,
    scenes: [{ key: "S1", heading: scene.heading, timeOfDay: scene.timeOfDay, description: scene.description }],
    shots: supplements.shots.map((shot, index) => ({ key: `S1-${String(index + 1)}`, sceneKey: "S1",
      shotType: shot.shotType, camera: shot.camera, action: shot.action, plannedSeconds: shot.plannedSeconds,
      characterKeys: shot.characterKeys, dialogue: shot.dialogue.map(({ speaker, line }) => ({ speaker, line })),
    })),
  };
  const checked = validateScriptBreakdownOutput(JSON.stringify(output), {
    // Exact source and dialogue checks above precede this legacy parser's line-ending accommodation.
    episodeNo: input.episodeNo, scriptText: input.scriptText.replace(/\r\n?|\n/g, "\n"), characters: input.characters,
  });
  if (checked.ok) return null;
  const total = supplements.shots.reduce((sum, shot) => sum + shot.plannedSeconds, 0);
  // The existing minimum describes a complete episode, not a selected scene. No whole-episode validity is claimed.
  if (checked.code === "duration_out_of_range" && total < SCRIPT_BREAKDOWN_LIMITS.minTotalSeconds) return null;
  return diagnostic(checked.code === "unsafe_content" ? "unsafe_content" : "invalid_supplements", "supplements");
}

/** Pure local evaluation. No provider, store, clock, environment, filesystem, or network is consulted. */
export function evaluateVimaxPlan(inputValue: unknown, candidateValue: unknown, supplementsValue: unknown): VimaxEvaluationReport {
  return evaluatePlan(inputValue, candidateValue, supplementsValue, false);
}

/**
 * Pure validation of a separately versioned workspace snapshot. The API must build and verify that snapshot from
 * its own scoped database reads. This function alone proves no live permissions, approval, freshness or save rights.
 * E1 retains its own input/report schemas, source kinds, diagnostics and deterministic hashes unchanged.
 */
export function evaluateVimaxPlatformPreview(inputValue: unknown, candidateValue: unknown, supplementsValue: unknown): VimaxPlatformPreviewReport {
  const report = evaluatePlan(inputValue, candidateValue, supplementsValue, true);
  const gaps = report.gaps.filter((gap) => gap !== "frozen_metadata_not_live_verified");
  return { ...report, schema: VIMAX_PLATFORM_PREVIEW_REPORT_SCHEMA, gaps: [...gaps, "source_can_change_after_preview"] };
}

function evaluatePlan(inputValue: unknown, candidateValue: unknown, supplementsValue: unknown, platform: boolean): VimaxEvaluationReport {
  let provenance: VimaxEvaluationProvenance | null = null;
  const blocked = (issue: VimaxEvaluationDiagnostic): VimaxEvaluationReport => ({
    schema: VIMAX_EVALUATION_REPORT_SCHEMA, status: "blocked", writeAllowed: false, provenance,
    diagnostics: [issue], review: null, gaps: [...GAPS, ...(issue.code === "source_format_unsupported" ? ["source_format_adapter_required"] : [])],
  });
  for (const [path, value] of [["input", inputValue], ["candidate", candidateValue], ["supplements", supplementsValue]] as const) {
    const error = jsonBoundary(value, path);
    if (error) return blocked(error);
  }
  const parsedInput = platform ? vimaxPlatformInputSchema.safeParse(inputValue) : vimaxEvaluationInputSchema.safeParse(inputValue);
  if (!parsedInput.success) {
    return blocked(diagnostic(parsedInput.error.issues.some((issue) => issue.path[0] === "selectedSceneKeys") ? "scene_scope_invalid" : "invalid_input", "input"));
  }
  const input = parsedInput.data;
  provenance = { upstreamRevision: VIMAX_UPSTREAM_REVISION, inputHash: jsonHash(inputValue), candidateHash: jsonHash(candidateValue),
    supplementsHash: jsonHash(supplementsValue), projectId: input.projectId, episodeId: input.episodeId,
    episodeNo: input.episodeNo, scriptRevisionId: input.scriptRevisionId, scriptContentHash: input.scriptContentHash,
    selectedSceneKey: input.selectedSceneKeys[0]!,
  };
  const sourceError = sourceCheck(input);
  if (sourceError) return blocked(sourceError);
  const parsedCandidate = vimaxPlanCandidateSchema.safeParse(candidateValue);
  if (!parsedCandidate.success) return blocked(diagnostic("invalid_candidate", "candidate"));
  const parsedSupplements = vimaxEvaluationSupplementsSchema.safeParse(supplementsValue);
  if (!parsedSupplements.success) {
    return blocked(diagnostic(parsedSupplements.error.issues.some((issue) => issue.path.at(-1) === "plannedSeconds") ? "missing_duration" : "invalid_supplements", "supplements"));
  }
  const candidate = parsedCandidate.data;
  const supplements = parsedSupplements.data;
  const failure = candidateCheck(candidate) ?? supplementCheck(input, candidate, supplements) ?? secondaryCheck(input, supplements);
  if (failure) return blocked(failure);
  const cameraGenerationOrder: number[] = [];
  const addCamera = (idx: number): void => {
    if (cameraGenerationOrder.includes(idx)) return;
    const parent = candidate.camera_tree[idx]!.parent_cam_idx;
    if (parent !== null) addCamera(parent);
    cameraGenerationOrder.push(idx);
  };
  candidate.camera_tree.forEach((camera) => addCamera(camera.idx));
  const scene = input.sceneSpans.find((item) => item.key === input.selectedSceneKeys[0])!;
  return { schema: VIMAX_EVALUATION_REPORT_SCHEMA, status: "ready_for_review", writeAllowed: false, provenance,
    gaps: [...GAPS], diagnostics: [], review: {
      scene, sourceSceneText: input.scriptText.slice(scene.start, scene.end), requirements: input.requirements,
      characters: supplements.characters.map((mapping) => ({ ...input.characters.find((item) => item.key === mapping.characterKey)!, vimaxIndex: mapping.vimaxIndex })),
      shots: supplements.shots, plannedTotalSeconds: supplements.shots.reduce((sum, shot) => sum + shot.plannedSeconds, 0),
      targetSceneSeconds: input.requirements.targetSceneSeconds, cameraGenerationOrder, candidate,
    },
  };
}
