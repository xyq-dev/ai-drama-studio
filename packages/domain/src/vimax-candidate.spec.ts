import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VIMAX_CANDIDATE_CREATE_SCHEMA, VIMAX_CANDIDATE_SAVE_SCENE_SCHEMA, VIMAX_CANDIDATE_PLACE_SHOTS_SCHEMA,
  vimaxCandidateCreateSchema, vimaxCandidateFrozenSchema,
  type VimaxCandidateCreate, type VimaxCandidateTarget, type VimaxPlatformSourceSnapshot,
} from "@ai-drama/contracts";
import {
  freezeVimaxCandidate, hashVimaxCandidateCommand, hashVimaxCandidateFrozen, hashVimaxCandidateRequest,
  sameVimaxCandidateSource, vimaxCandidateShotPlans,
} from "./vimax-candidate";
import { breakdownDialogueText } from "./script-breakdown";

function fixture() {
  const raw = JSON.parse(readFileSync(resolve(__dirname, "../../../scripts/vimax-evaluation/fixtures/single-scene.json"), "utf8"));
  const input = raw.input;
  const source: VimaxPlatformSourceSnapshot = {
    schema: "ads.vimax-platform-source.v1", projectId: input.projectId, episodeId: input.episodeId, episodeNo: input.episodeNo,
    scriptRevisionId: input.scriptRevisionId, scriptRevisionNo: 2, scriptText: input.scriptText,
    scriptContentHash: input.scriptContentHash, characters: input.characters,
  };
  const target: VimaxCandidateTarget = {
    sceneId: "80000000-0000-4000-8000-000000000001", sceneRevisionId: "80000000-0000-4000-8000-000000000002",
    rowVersion: 4, sourceScriptRevisionId: source.scriptRevisionId, ordinal: 1, heading: input.sceneSpans[0].heading,
    timeOfDay: "夜", summary: "原有人工场景摘要。", locationRevisionId: "80000000-0000-4000-8000-000000000003",
  };
  const body: VimaxCandidateCreate = vimaxCandidateCreateSchema.parse({
    schema: VIMAX_CANDIDATE_CREATE_SCHEMA, target: { sceneId: target.sceneId, sceneRevisionId: target.sceneRevisionId, rowVersion: target.rowVersion },
    request: { schema: "ads.vimax-platform-preview.request.v1",
      source: { scriptRevisionId: source.scriptRevisionId, scriptContentHash: source.scriptContentHash, characters: source.characters },
      sceneSpans: input.sceneSpans, selectedSceneKeys: input.selectedSceneKeys, sourceDialogue: input.sourceDialogue,
      requirements: input.requirements, candidate: raw.candidate, supplements: raw.supplements },
  });
  return { source, target, body };
}
const freeze = (f: ReturnType<typeof fixture>) => freezeVimaxCandidate(f.source, f.target, f.body);

describe("ViMax candidate immutable input and explicit local projection", () => {
  it("freezes the server snapshot, original upstream fields and target baseline without approval or mutation", () => {
    const f = fixture();
    const before = JSON.stringify(f);
    const result = freeze(f);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(vimaxCandidateFrozenSchema.safeParse(result.frozen).success).toBe(true);
    expect(result.frozen.source).toEqual(f.source);
    expect(result.frozen.target).toEqual(f.target);
    expect(result.frozen.request).toEqual(f.body.request);
    expect(result.frozen.evaluation.writeAllowed).toBe(false);
    expect(result.frozen.evaluation.gaps).toContain("preview_is_not_write_authorization");
    expect(result.frozenHash).toBe(hashVimaxCandidateFrozen(result.frozen));
    expect(freeze(f)).toEqual(result);
    expect(JSON.stringify(f)).toBe(before);
    const projected = vimaxCandidateShotPlans(result.frozen);
    expect(projected.map((shot) => shot.plannedSeconds)).toEqual([4, 4, 5]);
    expect(projected.map(breakdownDialogueText)).toEqual(f.body.request.supplements.shots.map((shot) =>
      shot.dialogue.length > 0 ? shot.dialogue.map((line) => `${line.speaker}：${line.line}`).join("\n") : null));
    expect(projected.every((shot) => !shot.camera.includes("ff_desc"))).toBe(true);
    expect(result.frozen.evaluation.review.candidate).toEqual(f.body.request.candidate);
  });

  it.each(["revision", "hash", "character_revision", "character_name", "new_character", "reorder"])("rejects changed %s identity", (kind) => {
    const f = fixture();
    if (kind === "revision") f.source.scriptRevisionId = "90000000-0000-4000-8000-000000000001";
    if (kind === "hash") f.source.scriptContentHash = "0".repeat(64);
    if (kind === "character_revision") f.source.characters[0]!.revisionId = "90000000-0000-4000-8000-000000000002";
    if (kind === "character_name") f.source.characters[0]!.name = "新名字";
    if (kind === "new_character") f.source.characters.push({ key: "C3", characterId: "90000000-0000-4000-8000-000000000003", revisionId: "90000000-0000-4000-8000-000000000004", name: "路人" });
    if (kind === "reorder") f.source.characters.reverse();
    expect(sameVimaxCandidateSource(f.source, f.body.request.source)).toBe(false);
    expect(freeze(f)).toEqual({ ok: false, code: "source_changed" });
  });

  it.each(["scene", "revision", "version", "ordinal", "heading", "script"])("rejects changed target %s", (kind) => {
    const f = fixture();
    if (kind === "scene") f.target.sceneId = "90000000-0000-4000-8000-000000000001";
    if (kind === "revision") f.target.sceneRevisionId = "90000000-0000-4000-8000-000000000002";
    if (kind === "version") f.target.rowVersion += 1;
    if (kind === "ordinal") f.target.ordinal = 2;
    if (kind === "heading") f.target.heading = "其他场景";
    if (kind === "script") f.target.sourceScriptRevisionId = "90000000-0000-4000-8000-000000000003";
    expect(freeze(f)).toEqual({ ok: false, code: "target_changed" });
  });

  it("does not admit a candidate that changes source dialogue, even if all IDs are current", () => {
    const f = fixture();
    f.body.request.supplements.shots[0]!.dialogue[0]!.line = "改写后的对白。";
    expect(freeze(f)).toEqual({ ok: false, code: "candidate_blocked" });
  });

  it("hashes request intent independently from later snapshot reads and includes scope and baseline versions", () => {
    const f = fixture();
    const original = hashVimaxCandidateRequest(f.source.projectId, f.source.episodeId, f.body);
    f.source.scriptRevisionNo += 1;
    f.target.summary = "后来场景快照";
    expect(hashVimaxCandidateRequest(f.source.projectId, f.source.episodeId, f.body)).toBe(original);
    expect(hashVimaxCandidateRequest("90000000-0000-4000-8000-000000000001", f.source.episodeId, f.body)).not.toBe(original);
    f.body.target.rowVersion += 1;
    expect(hashVimaxCandidateRequest(f.source.projectId, f.source.episodeId, f.body)).not.toBe(original);
  });

  it("uses stable key order and hashes planned scene versions without the legacy volatile-key exclusion", () => {
    const f = fixture();
    // Reorder the same JSON structure recursively without dropping nested properties.
    const reverse = (value: unknown): unknown => value && typeof value === "object"
      ? Array.isArray(value) ? value.map(reverse) : Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverse(item)]))
      : value;
    expect(hashVimaxCandidateRequest(f.source.projectId, f.source.episodeId, reverse(f.body) as VimaxCandidateCreate))
      .toBe(hashVimaxCandidateRequest(f.source.projectId, f.source.episodeId, f.body));
    const a = { schema: VIMAX_CANDIDATE_SAVE_SCENE_SCHEMA, expectedVersion: 1, confirmedReview: true } as const;
    expect(hashVimaxCandidateCommand("save_scene", a)).toBe(hashVimaxCandidateCommand("save_scene", { confirmedReview: true, expectedVersion: 1, schema: a.schema }));
    expect(hashVimaxCandidateCommand("save_scene", a)).not.toBe(hashVimaxCandidateCommand("save_scene", { ...a, expectedVersion: 2 }));
    expect(hashVimaxCandidateCommand("save_scene", a)).not.toBe(hashVimaxCandidateCommand("place_shots", { ...a, schema: VIMAX_CANDIDATE_PLACE_SHOTS_SCHEMA }));
  });

  it("rejects uploaded reports and false manual-review confirmations", () => {
    const f = fixture();
    expect(vimaxCandidateCreateSchema.safeParse({ ...f.body, evaluation: { status: "ready_for_review" } }).success).toBe(false);
    expect(() => hashVimaxCandidateCommand("save_scene", { schema: VIMAX_CANDIDATE_SAVE_SCENE_SCHEMA, expectedVersion: 1, confirmedReview: false } as never)).toThrow();
  });

  it("detects a mismatched frozen plan before storage or response acceptance", () => {
    const result = freeze(fixture());
    if (!result.ok) throw new Error(result.code);
    const changed = structuredClone(result.frozen);
    changed.evaluation.review.candidate.storyboard[0]!.audio_desc = "被替换的音轨";
    expect(vimaxCandidateFrozenSchema.safeParse(changed).success).toBe(false);
  });

  it.each(["\ud800", "\udfff", "前\ud800后", "\ud800\ud800\udc00"])("refuses unpaired Unicode at the E2-B persistence boundary", (bad) => {
    const f = fixture();
    f.body.request.candidate.storyboard[0]!.visual_desc = bad;
    f.body.request.candidate.shot_descriptions[0]!.visual_desc = bad;
    expect(freeze(f)).toEqual({ ok: false, code: "candidate_blocked" });
  });

  it("preserves valid emoji and paired surrogates in free descriptions", () => {
    const f = fixture();
    f.body.request.candidate.storyboard[0]!.visual_desc = "两人在雨中相望，车票上有 🏀 标记。";
    f.body.request.candidate.shot_descriptions[0]!.visual_desc = f.body.request.candidate.storyboard[0]!.visual_desc;
    const result = freeze(f);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.frozen.request.candidate.storyboard[0]!.visual_desc).toContain("🏀");
  });
});
