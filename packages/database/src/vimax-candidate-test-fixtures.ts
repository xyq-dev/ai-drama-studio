/** Synthetic test-only data. No database, provider or real user content; never exported by the package entrypoint. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  VIMAX_CANDIDATE_CREATE_SCHEMA, VIMAX_PLATFORM_PREVIEW_MAX_BYTES, VIMAX_PLATFORM_PREVIEW_REQUEST_SCHEMA,
  VIMAX_PLATFORM_SOURCE_SCHEMA, VIMAX_EVALUATION_SUPPLEMENTS_SCHEMA, VIMAX_EVALUATION_LIMITS,
  vimaxCandidateCreateSchema, vimaxEvaluationInputSchema, vimaxPlanCandidateSchema,
  type VimaxCandidateCreate, type VimaxCandidateTarget, type VimaxEvaluationInput, type VimaxEvaluationSupplements,
  type VimaxPlanCandidate, type VimaxPlatformSourceSnapshot,
} from "@ai-drama/contracts";
import { freezeVimaxCandidate } from "@ai-drama/domain";

export interface VimaxCandidateSyntheticFixture {
  input: VimaxEvaluationInput; candidate: VimaxPlanCandidate; supplements: VimaxEvaluationSupplements;
}

/** Maximal bounded descriptions expose JSON escaping/duplication in frozen data, including an unrelated scene. */
export function createLargeVimaxCandidateFixture() {
  const raw = JSON.parse(readFileSync(resolve(__dirname, "../../../scripts/vimax-evaluation/fixtures/single-scene.json"), "utf8")) as Record<string, unknown>;
  const original = vimaxEvaluationInputSchema.parse(raw.input);
  const upstream = vimaxPlanCandidateSchema.parse(raw.candidate);
  const heading = original.sceneSpans[0]!.heading;
  let scriptText = `【场景】${heading}\n【动作】${"\u0001".repeat(14_500)}\n`;
  const sourceDialogue: VimaxEvaluationInput["sourceDialogue"] = [];
  for (let index = 0; index < 32; index += 1) {
    const character = original.characters[index % original.characters.length]!;
    const line = "\u0001".repeat(120), start = scriptText.length;
    scriptText += `${character.name}：${line}`;
    sourceDialogue.push({ id: `D${index + 1}`, start, end: scriptText.length, speaker: character.name, line, characterKey: character.key });
    scriptText += "\n";
  }
  const firstEnd = scriptText.length;
  scriptText += "【场景】外景 街道\n【动作】行人穿过路口。\n";
  const scriptContentHash = createHash("sha256").update(scriptText, "utf8").digest("hex");
  const input = vimaxEvaluationInputSchema.parse({ ...original, scriptText, scriptContentHash, sourceDialogue,
    sceneSpans: [{ key: "S1", start: 0, end: firstEnd, heading, timeOfDay: "夜", description: "两人交谈。" },
      { key: "S2", start: firstEnd, end: scriptText.length, heading: "外景 街道", timeOfDay: "", description: "行人穿过路口。" }],
    requirements: { aspectRatio: "9:16", targetSceneSeconds: 16, style: "写实" } });
  const source: VimaxPlatformSourceSnapshot = { schema: VIMAX_PLATFORM_SOURCE_SCHEMA, projectId: input.projectId,
    episodeId: input.episodeId, episodeNo: 1, scriptRevisionId: input.scriptRevisionId, scriptRevisionNo: 1,
    scriptText, scriptContentHash, characters: input.characters };
  const make = (length: number): VimaxCandidateCreate => {
    const description = "\u0001".repeat(length);
    const storyboard: VimaxPlanCandidate["storyboard"] = [], details: VimaxPlanCandidate["shot_descriptions"] = [];
    const shots: VimaxEvaluationSupplements["shots"] = [];
    for (let index = 0; index < 8; index += 1) {
      const brief = { idx: index, is_last: index === 7, cam_idx: 0, visual_desc: description, audio_desc: description };
      storyboard.push(brief);
      details.push({ ...brief, variation_type: "small", variation_reason: description, ff_desc: description,
        ff_vis_char_idxs: [0, 1], lf_desc: description, lf_vis_char_idxs: [0, 1], motion_desc: description });
      shots.push({ vimaxShotIndex: index, shotType: "中景", camera: "固定", action: "两人交谈。", plannedSeconds: 2,
        characterKeys: input.characters.map((character) => character.key),
        dialogue: input.sourceDialogue.slice(index * 4, index * 4 + 4).map(({ id, speaker, line, characterKey }) =>
          ({ sourceDialogueId: id, speaker, line, characterKey })) });
    }
    return { schema: VIMAX_CANDIDATE_CREATE_SCHEMA,
      target: { sceneId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sceneRevisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", rowVersion: 1 },
      request: { schema: VIMAX_PLATFORM_PREVIEW_REQUEST_SCHEMA,
        source: { scriptRevisionId: source.scriptRevisionId, scriptContentHash, characters: source.characters },
        sceneSpans: input.sceneSpans, selectedSceneKeys: ["S1"], sourceDialogue, requirements: input.requirements,
        candidate: { characters: upstream.characters, storyboard, shot_descriptions: details,
          camera_tree: [{ idx: 0, active_shot_idxs: [0, 1, 2, 3, 4, 5, 6, 7], parent_cam_idx: null, parent_shot_idx: null,
            reason: null, is_parent_fully_covers_child: null, missing_info: null }] },
        supplements: { schema: VIMAX_EVALUATION_SUPPLEMENTS_SCHEMA,
          characters: input.characters.map((character, vimaxIndex) => ({ vimaxIndex, characterKey: character.key })), shots } } };
  };
  let lower = 0, upper = VIMAX_EVALUATION_LIMITS.maxTextChars;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2), next = make(middle);
    if (Buffer.byteLength(JSON.stringify(next), "utf8") <= VIMAX_PLATFORM_PREVIEW_MAX_BYTES
      && Buffer.byteLength(JSON.stringify(next.request.candidate), "utf8") <= VIMAX_EVALUATION_LIMITS.maxJsonBytes) lower = middle;
    else upper = middle - 1;
  }
  const body = vimaxCandidateCreateSchema.parse(make(lower));
  const target: VimaxCandidateTarget = { ...body.target, sourceScriptRevisionId: source.scriptRevisionId,
    ordinal: 1, heading, timeOfDay: "夜", summary: "两人交谈。", locationRevisionId: null };
  const evaluation = freezeVimaxCandidate(source, target, body);
  if (!evaluation.ok) throw new Error(`Large synthetic fixture was refused: ${evaluation.code}`);
  return { input, candidate: body.request.candidate, supplements: body.request.supplements, body, source, target, evaluation };
}
