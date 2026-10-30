import { createHash } from "node:crypto";
import dns from "node:dns";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { resolve } from "node:path";
import tls from "node:tls";
import { describe, expect, it, vi } from "vitest";
import {
  SCRIPT_BREAKDOWN_OUTPUT_SCHEMA,
  VIMAX_EVALUATION_REPORT_SCHEMA,
  scriptBreakdownOutputSchema,
  vimaxEvaluationInputSchema,
  vimaxEvaluationSupplementsSchema,
  vimaxPlanCandidateSchema,
  type VimaxEvaluationCode,
  type VimaxEvaluationInput,
  type VimaxEvaluationSupplements,
  type VimaxPlanCandidate,
} from "@ai-drama/contracts";
import { evaluateVimaxPlan } from "./vimax-evaluation";

interface Fixture {
  fixtureKind: "synthetic";
  input: VimaxEvaluationInput;
  candidate: VimaxPlanCandidate;
  supplements: VimaxEvaluationSupplements;
}

// Hand-authored synthetic upstream-shaped artifacts, not model or production output.
const rawFixture: unknown = JSON.parse(readFileSync(resolve(__dirname, "../../../scripts/vimax-evaluation/fixtures/single-scene.json"), "utf8"));
function fixture(): Fixture {
  const value = structuredClone(rawFixture) as Fixture;
  expect(value.fixtureKind).toBe("synthetic");
  return {
    fixtureKind: value.fixtureKind,
    input: vimaxEvaluationInputSchema.parse(value.input),
    candidate: vimaxPlanCandidateSchema.parse(value.candidate),
    supplements: vimaxEvaluationSupplementsSchema.parse(value.supplements),
  };
}
const evaluate = (f: Fixture) => evaluateVimaxPlan(f.input, f.candidate, f.supplements);
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function rehash(f: Fixture) { f.input.scriptContentHash = digest(f.input.scriptText); }
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}
function blocked(f: Fixture, code?: VimaxEvaluationCode) {
  const result = evaluate(f);
  expect(result.status).toBe("blocked");
  expect(result.writeAllowed).toBe(false);
  expect(result.review).toBeNull();
  expect(result.diagnostics.length).toBeGreaterThan(0);
  if (code) expect(result.diagnostics.map((item) => item.code)).toContain(code);
  return result;
}
function ready(f: Fixture) {
  const result = evaluate(f);
  expect(result.status).toBe("ready_for_review");
  expect(result.writeAllowed).toBe(false);
  expect(result.diagnostics).toEqual([]);
  if (result.status !== "ready_for_review") throw new Error(JSON.stringify(result.diagnostics));
  return result;
}
function addSecondScene(f: Fixture) {
  const start = f.input.scriptText.length;
  f.input.scriptText += "【场景】外景 街道\n【动作】行人走过路口。\n";
  f.input.sceneSpans.push({ key: "S2", start, end: f.input.scriptText.length, heading: "外景 街道", timeOfDay: "夜", description: "行人走过街道。" });
  rehash(f);
}
function threeCameras(f: Fixture) {
  f.candidate.storyboard[2]!.cam_idx = 2;
  f.candidate.shot_descriptions[2]!.cam_idx = 2;
  f.candidate.camera_tree[0]!.active_shot_idxs = [0];
  f.candidate.camera_tree.push({ idx: 2, active_shot_idxs: [2], parent_cam_idx: 0, parent_shot_idx: 0, reason: "同一场景的空间参考。", is_parent_fully_covers_child: true, missing_info: null });
}

describe("ViMax E1 offline fixture and report boundaries", () => {
  it("maps the synthetic two-character single scene without inventing fields or approval", () => {
    const f = fixture();
    const report = ready(f);
    expect(report.schema).toBe(VIMAX_EVALUATION_REPORT_SCHEMA);
    expect(report.review.scene).toEqual(f.input.sceneSpans[0]);
    expect(report.review.sourceSceneText).toBe(f.input.scriptText);
    expect(report.review.requirements).toEqual(f.input.requirements);
    expect(report.review.characters).toEqual(f.input.characters.map((item, vimaxIndex) => ({ ...item, vimaxIndex })));
    expect(report.review.shots).toEqual(f.supplements.shots);
    expect(report.review.plannedTotalSeconds).toBe(13);
    expect(report.review.targetSceneSeconds).toBe(13);
    expect(report.review.cameraGenerationOrder).toEqual([0, 1]);
    expect(report.review.candidate).toEqual(f.candidate);
    expect(report.gaps).toEqual(expect.arrayContaining(["semantic_review_required", "single_scene_write_not_implemented"]));
    expect(report.schema).not.toBe(SCRIPT_BREAKDOWN_OUTPUT_SCHEMA);
    expect(scriptBreakdownOutputSchema.safeParse(report).success).toBe(false);
    expect(scriptBreakdownOutputSchema.safeParse(report.review).success).toBe(false);
    expect(report.provenance).toMatchObject({
      upstreamRevision: f.input.upstreamRevision, projectId: f.input.projectId, episodeId: f.input.episodeId,
      scriptRevisionId: f.input.scriptRevisionId, scriptContentHash: digest(f.input.scriptText), selectedSceneKey: "S1",
      inputHash: expect.stringMatching(/^[a-f0-9]{64}$/), candidateHash: expect.stringMatching(/^[a-f0-9]{64}$/), supplementsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("does not mutate deeply frozen successful or blocked inputs and is deterministic", () => {
    for (const broken of [false, true]) {
      const f = fixture();
      if (broken) f.supplements.shots[1]!.dialogue[0]!.line = "改写后的台词。";
      const before = JSON.stringify(f);
      frozen(f);
      const a = evaluate(f);
      const b = evaluate(f);
      expect(a).toEqual(b);
      expect(JSON.stringify(f)).toBe(before);
      expect(a.writeAllowed).toBe(false);
    }
  });

  it("retains free-text candidate intentions instead of silently treating them as canonical dialogue", () => {
    const f = fixture();
    f.candidate.storyboard[0]!.audio_desc = "雨声；角色准备开口。这是声音意图，不是结构化台词。";
    f.candidate.shot_descriptions[0]!.audio_desc = f.candidate.storyboard[0]!.audio_desc;
    const report = ready(f);
    expect(report.review.candidate).toEqual(f.candidate);
    expect(report.review.shots.flatMap((s) => s.dialogue).map((d) => d.line)).toEqual(f.input.sourceDialogue.map((d) => d.line));
  });

  it("reports planned rather than measured duration without auto-scaling to the target", () => {
    const f = fixture();
    f.input.requirements.targetSceneSeconds = 16;
    const result = ready(f);
    expect(result.review.plannedTotalSeconds).toBe(13);
    expect(result.review.targetSceneSeconds).toBe(16);
    expect(result.review.shots.map((s) => s.plannedSeconds)).toEqual([4, 4, 5]);
  });
});

describe("strict artifacts, source identity and scene selection", () => {
  const cases: Array<[string, (f: Fixture) => void, VimaxEvaluationCode?]> = [
    ["extra input field", (f) => Object.assign(f.input, { ignored: true }), "invalid_input"],
    ["missing pinned revision", (f) => { Reflect.deleteProperty(f.input, "upstreamRevision"); }, "invalid_input"],
    ["unapproved source", (f) => Object.assign(f.input, { reviewStatus: "DRAFT" }), "invalid_input"],
    ["stale source", (f) => Object.assign(f.input, { isStale: true }), "invalid_input"],
    ["noncurrent source", (f) => Object.assign(f.input, { isCurrent: false }), "invalid_input"],
    ["series mode", (f) => Object.assign(f.input, { writingMode: "series" }), "invalid_input"],
    ["hash mismatch", (f) => { f.input.scriptContentHash = "0".repeat(64); }, "source_hash_mismatch"],
    ["unidentified scene", (f) => { f.input.selectedSceneKeys = ["S2"]; }, "scene_scope_invalid"],
    ["two selected scenes", (f) => { addSecondScene(f); f.input.selectedSceneKeys = ["S1", "S2"]; }],
    ["selected range cuts the scene", (f) => { f.input.sceneSpans[0]!.end--; }, "scene_scope_invalid"],
    ["selected range starts inside heading", (f) => { f.input.sceneSpans[0]!.start = 1; }, "scene_scope_invalid"],
    ["incorrect heading", (f) => { f.input.sceneSpans[0]!.heading = "外景 天台"; }],
    ["one range combines two scene headers", (f) => { addSecondScene(f); f.input.sceneSpans[0]!.end = f.input.scriptText.length; f.input.sceneSpans.pop(); }],
    ["overlapping scene spans", (f) => { addSecondScene(f); f.input.sceneSpans[1]!.start--; }, "scene_scope_invalid"],
    ["extra candidate field", (f) => Object.assign(f.candidate, { approved: true }), "invalid_candidate"],
    ["missing upstream detail field", (f) => { Reflect.deleteProperty(f.candidate.shot_descriptions[0]!, "ff_desc"); }, "invalid_candidate"],
    ["extra nested field", (f) => Object.assign(f.candidate.camera_tree[0]!, { autoRepair: true }), "invalid_candidate"],
    ["extra supplement field", (f) => Object.assign(f.supplements.shots[0]!, { approved: true }), "invalid_supplements"],
    ["missing explicit supplement", (f) => { f.supplements.shots.pop(); }, "supplement_mapping_invalid"],
    ["duplicate explicit supplement", (f) => { f.supplements.shots[1]!.vimaxShotIndex = 0; }, "supplement_mapping_invalid"],
    ["unbounded candidate text", (f) => { f.candidate.shot_descriptions[0]!.ff_desc = "文".repeat(4001); }, "invalid_candidate"],
    ["overlong action", (f) => { f.supplements.shots[0]!.action = "动".repeat(121); }, "invalid_supplements"],
    ["too many shots", (f) => { f.candidate.storyboard = Array.from({ length: 9 }, () => ({ ...f.candidate.storyboard[0]! })); }, "invalid_candidate"],
  ];
  it.each(cases)("blocks %s without silently trimming or repairing", (_, mutate, code) => {
    const f = fixture(); mutate(f); blocked(f, code);
  });

  it("can select one explicitly bounded scene from a complete multiscene script", () => {
    const f = fixture(); addSecondScene(f);
    expect(ready(f).review.scene).toEqual(f.input.sceneSpans[0]);
  });

  it.each(["\n", "\r\n", "\r"])("preserves source and dialogue exactly with newline %j", (newline) => {
    const f = fixture();
    f.input.scriptText = f.input.scriptText.replaceAll("\n", newline);
    f.input.sceneSpans[0]!.end = f.input.scriptText.length;
    for (const source of f.input.sourceDialogue) {
      const physical = `${source.speaker}：${source.line}`;
      source.start = f.input.scriptText.indexOf(physical);
      source.end = source.start + physical.length;
    }
    rehash(f);
    const result = ready(f);
    expect(result.review.sourceSceneText).toBe(f.input.scriptText);
    expect(result.review.shots.flatMap((shot) => shot.dialogue).map((line) => `${line.speaker}：${line.line}`))
      .toEqual(f.input.sourceDialogue.map((line) => f.input.scriptText.slice(line.start, line.end)));
  });

  it("uses UTF-16 offsets and the exact UTF-8 source hash, including non-BMP characters", () => {
    const f = fixture();
    f.input.scriptText = f.input.scriptText.replace("旧信放", "旧信📩放");
    f.input.sceneSpans[0]!.end += 2;
    f.input.sourceDialogue.forEach((d) => { d.start += 2; d.end += 2; });
    rehash(f);
    ready(f);
    f.input.sourceDialogue[0]!.start--;
    blocked(f, "source_dialogue_invalid");
  });
});

describe("character identity and source-exact dialogue", () => {
  const cases: Array<[string, (f: Fixture) => void, VimaxEvaluationCode?]> = [
    ["duplicate upstream character index", (f) => { f.candidate.characters[1]!.idx = 0; }, "duplicate_character"],
    ["duplicate frozen key", (f) => { f.input.characters[1]!.key = "C1"; }, "duplicate_character"],
    ["missing explicit mapping", (f) => { f.supplements.characters.pop(); }, "character_mapping_invalid"],
    ["unknown frozen mapping", (f) => { f.supplements.characters[0]!.characterKey = "C3"; }, "unknown_character"],
    ["two candidate identities mapped to one character", (f) => { f.supplements.characters[1]!.characterKey = "C1"; }, "character_mapping_invalid"],
    ["unknown first-frame index", (f) => { f.candidate.shot_descriptions[0]!.ff_vis_char_idxs = [2]; }, "unknown_character"],
    ["unknown last-frame index", (f) => { f.candidate.shot_descriptions[0]!.lf_vis_char_idxs = [2]; }, "unknown_character"],
    ["duplicate first-frame identity", (f) => { f.candidate.shot_descriptions[0]!.ff_vis_char_idxs = [0, 0]; }],
    ["unknown supplemented visible character", (f) => { f.supplements.shots[0]!.characterKeys = ["C3"]; }, "unknown_character"],
    ["unknown source speaker", (f) => { f.input.sourceDialogue[0]!.characterKey = "C3"; }],
    ["known source speaker bypasses identity via null", (f) => { f.input.sourceDialogue[0]!.characterKey = null; f.supplements.shots[0]!.dialogue[0]!.characterKey = null; }],
    ["dialogue paraphrase", (f) => { f.supplements.shots[0]!.dialogue[0]!.line = "信是你写的吗？"; }, "dialogue_changed"],
    ["dialogue punctuation changed", (f) => { f.supplements.shots[0]!.dialogue[0]!.line = "这封信是你留下的吗!"; }, "dialogue_changed"],
    ["speaker renamed", (f) => { f.supplements.shots[0]!.dialogue[0]!.speaker = "小林"; }, "dialogue_changed"],
    ["speaker identity swapped", (f) => { f.supplements.shots[0]!.dialogue[0]!.characterKey = "C2"; }, "dialogue_changed"],
    ["unknown source dialogue id", (f) => { f.supplements.shots[0]!.dialogue[0]!.sourceDialogueId = "D4"; }],
    ["dialogue omitted", (f) => { f.supplements.shots[0]!.dialogue = []; }, "dialogue_coverage_invalid"],
    ["dialogue repeated", (f) => { f.supplements.shots[2]!.dialogue.push({ ...f.supplements.shots[0]!.dialogue[0]! }); }, "dialogue_coverage_invalid"],
    ["dialogue reordered", (f) => { const a = f.supplements.shots[0]!.dialogue; f.supplements.shots[0]!.dialogue = f.supplements.shots[1]!.dialogue; f.supplements.shots[1]!.dialogue = a; }, "dialogue_coverage_invalid"],
    ["source catalog silently omits a line", (f) => { f.input.sourceDialogue.pop(); f.supplements.shots[2]!.dialogue = []; }, "source_dialogue_invalid"],
    ["source catalog repeats a line", (f) => { f.input.sourceDialogue.push({ ...f.input.sourceDialogue[0]!, id: "D4" }); }, "source_dialogue_invalid"],
    ["source catalog reorders lines", (f) => { f.input.sourceDialogue.reverse(); }, "source_dialogue_invalid"],
    ["source range only covers unlabelled line", (f) => { f.input.sourceDialogue[0]!.start += 3; }, "source_dialogue_invalid"],
  ];
  it.each(cases)("blocks %s", (_, mutate, code) => { const f = fixture(); mutate(f); blocked(f, code); });

  it("blocks an unknown speaker instead of using a null identity to bypass frozen characters", () => {
    const f = fixture();
    f.input.scriptText = f.input.scriptText.replaceAll("陈默", "陌客");
    f.input.sourceDialogue[1]!.speaker = "陌客";
    f.input.sourceDialogue[1]!.characterKey = null;
    f.supplements.shots[1]!.dialogue[0]!.speaker = "陌客";
    f.supplements.shots[1]!.dialogue[0]!.characterKey = null;
    rehash(f);
    blocked(f, "unknown_character");
  });

  it("keeps same-name identities distinct through explicit frozen mappings", () => {
    const f = fixture();
    f.input.characters[1]!.name = "林晚";
    f.input.scriptText = f.input.scriptText.replaceAll("陈默", "林晚");
    f.input.sourceDialogue[1]!.speaker = "林晚";
    f.supplements.shots[1]!.dialogue[0]!.speaker = "林晚";
    f.candidate.characters[0]!.identifier_in_scene = "年轻的林晚";
    f.candidate.characters[1]!.identifier_in_scene = "年长的林晚";
    rehash(f);
    const report = ready(f);
    expect(report.review.characters.map((c) => c.name)).toEqual(["林晚", "林晚"]);
    expect(report.review.characters.map((c) => c.characterId)).toEqual(f.input.characters.map((c) => c.characterId));
    expect(report.review.shots.flatMap((s) => s.dialogue).map((d) => d.characterKey)).toEqual(["C1", "C2", "C1"]);
    f.input.sourceDialogue[1]!.characterKey = null;
    f.supplements.shots[1]!.dialogue[0]!.characterKey = null;
    blocked(f);
  });
});

describe("duration, playback and visual dependency topology", () => {
  it("reports a missing duration instead of extracting it from candidate prose", () => {
    const f = fixture();
    f.candidate.storyboard[0]!.visual_desc = "这一镜预计4秒。";
    f.candidate.shot_descriptions[0]!.visual_desc = f.candidate.storyboard[0]!.visual_desc;
    Reflect.deleteProperty(f.supplements.shots[0]!, "plannedSeconds");
    blocked(f, "missing_duration");
  });
  it.each([0, 1, 11, 2.5, NaN, Infinity])("refuses illegal planned duration %s", (plannedSeconds) => {
    const f = fixture(); Object.assign(f.supplements.shots[0]!, { plannedSeconds }); blocked(f);
  });
  it.each([2, 10])("accepts boundary planned duration %s without correction", (plannedSeconds) => {
    const f = fixture(); f.supplements.shots[0]!.plannedSeconds = plannedSeconds;
    expect(ready(f).review.shots[0]!.plannedSeconds).toBe(plannedSeconds);
  });
  const cases: Array<[string, (f: Fixture) => void, VimaxEvaluationCode?]> = [
    ["non-contiguous playback indices", (f) => { f.candidate.storyboard[1]!.idx = 3; }, "shot_sequence_invalid"],
    ["duplicate playback index", (f) => { f.candidate.storyboard[1]!.idx = 0; }, "shot_sequence_invalid"],
    ["early last shot flag", (f) => { f.candidate.storyboard[0]!.is_last = true; f.candidate.shot_descriptions[0]!.is_last = true; }, "shot_sequence_invalid"],
    ["no last shot flag", (f) => { f.candidate.storyboard[2]!.is_last = false; f.candidate.shot_descriptions[2]!.is_last = false; }, "shot_sequence_invalid"],
    ["missing shot detail", (f) => { f.candidate.shot_descriptions.pop(); }, "shot_sequence_invalid"],
    ["duplicate detail", (f) => { f.candidate.shot_descriptions[1]!.idx = 0; }, "shot_detail_mismatch"],
    ["brief/detail visual disagreement", (f) => { f.candidate.shot_descriptions[0]!.visual_desc += "不同的动作。"; }, "shot_detail_mismatch"],
    ["brief/detail audio disagreement", (f) => { f.candidate.shot_descriptions[0]!.audio_desc += "额外声音。"; }, "shot_detail_mismatch"],
    ["brief/detail camera disagreement", (f) => { f.candidate.shot_descriptions[0]!.cam_idx = 1; }, "shot_detail_mismatch"],
    ["duplicate camera index", (f) => { f.candidate.camera_tree[1]!.idx = 0; }],
    ["duplicate shot membership", (f) => { f.candidate.camera_tree[0]!.active_shot_idxs.push(0); }, "camera_membership_invalid"],
    ["shot in two cameras", (f) => { f.candidate.camera_tree[1]!.active_shot_idxs.push(0); }, "camera_membership_invalid"],
    ["orphan shot", (f) => { f.candidate.camera_tree[0]!.active_shot_idxs = [0]; }, "camera_membership_invalid"],
    ["wrong camera ownership", (f) => { f.candidate.camera_tree[0]!.active_shot_idxs = [0, 1]; f.candidate.camera_tree[1]!.active_shot_idxs = [2]; }, "camera_membership_invalid"],
    ["unknown camera reference", (f) => { f.candidate.camera_tree[1]!.parent_cam_idx = 7; }, "camera_reference_invalid"],
    ["unknown parent shot", (f) => { f.candidate.camera_tree[1]!.parent_shot_idx = 7; }, "camera_reference_invalid"],
    ["parent shot outside parent camera", (f) => { f.candidate.camera_tree[1]!.parent_shot_idx = 1; }, "camera_reference_invalid"],
    ["multiple roots", (f) => { f.candidate.camera_tree[1]!.parent_cam_idx = null; f.candidate.camera_tree[1]!.parent_shot_idx = null; }, "camera_root_invalid"],
    ["missing root", (f) => { f.candidate.camera_tree[0]!.parent_cam_idx = 1; f.candidate.camera_tree[0]!.parent_shot_idx = 1; }, "camera_root_invalid"],
    ["first camera not root", (f) => { f.candidate.camera_tree[0]!.parent_cam_idx = 1; f.candidate.camera_tree[0]!.parent_shot_idx = 1; f.candidate.camera_tree[1]!.parent_cam_idx = null; f.candidate.camera_tree[1]!.parent_shot_idx = null; }, "camera_root_invalid"],
    ["root with parent-shot reference", (f) => { f.candidate.camera_tree[0]!.parent_shot_idx = 1; }],
    ["non-root missing parent-shot reference", (f) => { f.candidate.camera_tree[1]!.parent_shot_idx = null; }, "camera_root_invalid"],
    ["self-cycle", (f) => { f.candidate.camera_tree[1]!.parent_cam_idx = 1; f.candidate.camera_tree[1]!.parent_shot_idx = 1; }, "camera_reference_invalid"],
    ["disconnected multi-camera cycle", (f) => { threeCameras(f); f.candidate.camera_tree[1]!.parent_cam_idx = 2; f.candidate.camera_tree[1]!.parent_shot_idx = 2; f.candidate.camera_tree[2]!.parent_cam_idx = 1; f.candidate.camera_tree[2]!.parent_shot_idx = 1; }, "camera_cycle"],
  ];
  it.each(cases)("blocks %s", (_, mutate, code) => { const f = fixture(); mutate(f); blocked(f, code); });

  it("allows a later playback shot as a visual reference without reordering dialogue or playback", () => {
    const f = fixture();
    f.candidate.camera_tree[1]!.parent_shot_idx = 2;
    const report = ready(f);
    expect(report.review.cameraGenerationOrder).toEqual([0, 1]);
    expect(report.review.candidate.storyboard.map((s) => s.idx)).toEqual([0, 1, 2]);
    expect(report.review.shots.flatMap((s) => s.dialogue).map((d) => d.sourceDialogueId)).toEqual(["D1", "D2", "D3"]);
  });

  it("topologically orders reference generation independently of camera index and playback", () => {
    const f = fixture(); threeCameras(f);
    f.candidate.camera_tree[1]!.parent_cam_idx = 2;
    f.candidate.camera_tree[1]!.parent_shot_idx = 2;
    const report = ready(f);
    expect(report.review.cameraGenerationOrder).toEqual([0, 2, 1]);
    expect(report.review.shots.map((s) => s.vimaxShotIndex)).toEqual([0, 1, 2]);
  });
});

describe("offline evaluator cannot spend or write", () => {
  it("does not use network primitives for successful, refused or missing artifacts", () => {
    const deny = () => { throw new Error("network call is forbidden in E1"); };
    const spies = [
      vi.spyOn(globalThis, "fetch").mockImplementation(deny),
      vi.spyOn(http, "request").mockImplementation(deny), vi.spyOn(http, "get").mockImplementation(deny),
      vi.spyOn(https, "request").mockImplementation(deny), vi.spyOn(https, "get").mockImplementation(deny),
      vi.spyOn(net, "connect").mockImplementation(deny), vi.spyOn(net, "createConnection").mockImplementation(deny),
      vi.spyOn(net.Socket.prototype, "connect").mockImplementation(deny), vi.spyOn(tls, "connect").mockImplementation(deny),
      vi.spyOn(dns, "lookup").mockImplementation(deny), vi.spyOn(dns, "resolve").mockImplementation(deny),
    ];
    try {
      const f = fixture();
      ready(f);
      f.supplements.shots[0]!.dialogue[0]!.line = "不属于原文。";
      blocked(f);
      for (const args of [[undefined, undefined, undefined], [f.input, undefined, undefined], [f.input, f.candidate, undefined]]) {
        const result = evaluateVimaxPlan(args[0], args[1], args[2]);
        expect(result.status).toBe("blocked");
        expect(result.writeAllowed).toBe(false);
      }
      spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  it("imports no provider, database, runtime or transport from its source module", () => {
    const source = readFileSync(resolve(__dirname, "vimax-evaluation.ts"), "utf8");
    const imports = [...source.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*["']([^"']+)["']/g)].map((match) => match[1]!);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((name) => /providers|database|runtime|transport|node:(?:http|https|net|tls|dns)/.test(name))).toEqual([]);
  });

  it("rejects getters and custom serialization without invoking user code", () => {
    const f = fixture();
    const getter = vi.fn(() => f.candidate.characters);
    const toJSON = vi.fn(() => f.candidate);
    for (const candidate of [Object.defineProperty({}, "characters", { enumerable: true, get: getter }), { toJSON }]) {
      const result = evaluateVimaxPlan(f.input, candidate, f.supplements);
      expect(result.status).toBe("blocked");
      expect(result.writeAllowed).toBe(false);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("blocks an array subclass before inherited toJSON can execute", () => {
    const f = fixture();
    const inheritedToJSON = vi.fn();
    class SerializableArray<T> extends Array<T> {
      toJSON() {
        inheritedToJSON();
        return Array.from(this);
      }
    }
    f.candidate.storyboard = new SerializableArray(...f.candidate.storyboard);
    const result = evaluate(f);
    expect(inheritedToJSON).not.toHaveBeenCalled();
    expect(result.status).toBe("blocked");
    expect(result.diagnostics).toEqual([{ code: "non_json_value", path: "candidate" }]);
    expect(result.writeAllowed).toBe(false);
  });

  it("blocks a custom array prototype before inherited toJSON can execute", () => {
    const f = fixture();
    const inheritedToJSON = vi.fn(() => []);
    Object.setPrototypeOf(f.input.sourceDialogue, Object.create(Array.prototype, {
      toJSON: { value: inheritedToJSON },
    }));
    const result = evaluate(f);
    expect(inheritedToJSON).not.toHaveBeenCalled();
    expect(result.status).toBe("blocked");
    expect(result.diagnostics).toEqual([{ code: "non_json_value", path: "input" }]);
    expect(result.writeAllowed).toBe(false);
  });

  it("blocks a custom array prototype before inherited map can escape the report boundary", () => {
    const f = fixture();
    const inheritedMap = vi.fn(() => { throw new Error("inherited array map must never execute"); });
    Object.setPrototypeOf(f.supplements.shots, Object.create(Array.prototype, {
      map: { value: inheritedMap },
    }));
    const result = evaluate(f);
    expect(inheritedMap).not.toHaveBeenCalled();
    expect(result.status).toBe("blocked");
    expect(result.diagnostics).toEqual([{ code: "non_json_value", path: "supplements" }]);
    expect(result.writeAllowed).toBe(false);
  });

  it("blocks a null-prototype array without throwing during canonical hashing", () => {
    const f = fixture();
    Object.setPrototypeOf(f.candidate.camera_tree, null);
    const result = evaluate(f);
    expect(result.status).toBe("blocked");
    expect(result.diagnostics).toEqual([{ code: "non_json_value", path: "candidate" }]);
    expect(result.writeAllowed).toBe(false);
  });

  it("still accepts plain JSON arrays, empty arrays and null-prototype plain objects", () => {
    const f = fixture();
    Object.setPrototypeOf(f.candidate, null);
    f.candidate.shot_descriptions[0]!.ff_vis_char_idxs = [];
    f.candidate.shot_descriptions[0]!.lf_vis_char_idxs = [];
    const result = ready(f);
    expect(result.review.candidate.shot_descriptions[0]!.ff_vis_char_idxs).toEqual([]);
    expect(result.review.candidate.storyboard.map((shot) => shot.idx)).toEqual([0, 1, 2]);
  });

  it.each(["object", "array"])("rejects a %s Proxy without executing reflection traps", (shape) => {
    const f = fixture();
    const trap = vi.fn(() => { throw new Error("Proxy trap must never execute"); });
    const proxy = new Proxy(shape === "object" ? f.candidate : f.candidate.storyboard, {
      getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, get: trap,
    });
    const result = evaluateVimaxPlan(f.input, proxy, f.supplements);
    expect(trap).not.toHaveBeenCalled();
    expect(result.status).toBe("blocked");
    expect(result.diagnostics).toEqual([{ code: "non_json_value", path: "candidate" }]);
    expect(result.writeAllowed).toBe(false);
  });

  it.each(["bytes", "depth", "nodes"])("blocks excessive %s before schema parsing", (limit) => {
    const f = fixture();
    let candidate: unknown;
    if (limit === "bytes") candidate = { text: "文".repeat(90_000) };
    else if (limit === "nodes") candidate = Array.from({ length: 10_001 }, () => null);
    else {
      candidate = null;
      for (let i = 0; i < 20; i++) candidate = { nested: candidate };
    }
    const result = evaluateVimaxPlan(f.input, candidate, f.supplements);
    expect(result.status).toBe("blocked");
    expect(result.diagnostics).toEqual([{ code: "input_too_large", path: "candidate" }]);
    expect(result.writeAllowed).toBe(false);
  });

  it("does not include refused raw text in diagnostics or review", () => {
    const f = fixture();
    const refused = "仅用于测试的拒收文本，不应进入诊断报告。";
    f.supplements.shots[0]!.dialogue[0]!.line = refused;
    const report = blocked(f, "dialogue_changed");
    expect(JSON.stringify(report)).not.toContain(refused);
  });

  it("rejects circular and non-JSON inputs without trusting or executing their contents", () => {
    const f = fixture();
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const inputs: unknown[] = [cyclic, { value: () => "never" }, { value: BigInt(1) }, new Date(), new Map()];
    for (const candidate of inputs) {
      const result = evaluateVimaxPlan(f.input, candidate, f.supplements);
      expect(result.status).toBe("blocked");
      expect(result.writeAllowed).toBe(false);
    }
  });
});
