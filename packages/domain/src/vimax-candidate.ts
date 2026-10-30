import { createHash } from "node:crypto";
import {
  VIMAX_CANDIDATE_FROZEN_SCHEMA,
  VIMAX_PLATFORM_INPUT_SCHEMA,
  VIMAX_UPSTREAM_REVISION,
  vimaxCandidateCreateSchema,
  vimaxCandidateFrozenSchema,
  vimaxCandidatePlaceShotsSchema,
  vimaxCandidateSaveSceneSchema,
  vimaxCandidateTargetSchema,
  vimaxPlatformSourceSnapshotSchema,
  type ScriptBreakdownShot,
  type VimaxCandidateCreate,
  type VimaxCandidateFrozen,
  type VimaxCandidatePlaceShots,
  type VimaxCandidateSaveScene,
  type VimaxCandidateTarget,
  type VimaxPlatformSourceSnapshot,
} from "@ai-drama/contracts";
import { evaluateVimaxPlatformPreview } from "./vimax-evaluation";

/** Only strict-schema JSON reaches hashing. Baseline/expected versions are deliberately part of this request identity. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

/** PostgreSQL jsonb cannot store NUL or unpaired UTF-16 surrogates; only E2-B persistence has this extra boundary. */
function postgresCompatibleJson(value: unknown): boolean {
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const unit = value.charCodeAt(index);
      if (unit === 0) return false;
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(++index);
        if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return false;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    }
    return true;
  }
  if (Array.isArray(value)) return value.every(postgresCompatibleJson);
  if (value !== null && typeof value === "object") return Object.entries(value).every(([key, item]) => postgresCompatibleJson(key) && postgresCompatibleJson(item));
  return true;
}

export function hashVimaxCandidateRequest(projectId: string, episodeId: string, body: VimaxCandidateCreate): string {
  return digest({ schema: "ads.vimax-candidate.request-identity.v1", projectId, episodeId, body: vimaxCandidateCreateSchema.parse(body) });
}
export function hashVimaxCandidateCommand(operation: "save_scene" | "place_shots", body: VimaxCandidateSaveScene | VimaxCandidatePlaceShots): string {
  const parsed = operation === "save_scene" ? vimaxCandidateSaveSceneSchema.parse(body) : vimaxCandidatePlaceShotsSchema.parse(body);
  return digest({ schema: "ads.vimax-candidate.command-identity.v1", operation, body: parsed });
}
export function hashVimaxCandidateFrozen(frozen: VimaxCandidateFrozen): string {
  return digest(vimaxCandidateFrozenSchema.parse(frozen));
}

export function sameVimaxCandidateSource(current: VimaxPlatformSourceSnapshot, submitted: VimaxCandidateCreate["request"]["source"]): boolean {
  return current.scriptRevisionId === submitted.scriptRevisionId && current.scriptContentHash === submitted.scriptContentHash
    && current.characters.length === submitted.characters.length
    && current.characters.every((character, index) => {
      const other = submitted.characters[index];
      return other !== undefined && character.key === other.key && character.characterId === other.characterId
        && character.revisionId === other.revisionId && character.name === other.name;
    });
}

export type VimaxCandidateFreeze =
  | { ok: true; frozen: VimaxCandidateFrozen; frozenHash: string }
  | { ok: false; code: "source_changed" | "target_changed" | "candidate_blocked" };

/** Re-evaluate a server-read source and target; no caller-provided report or approval can grant save rights. */
export function freezeVimaxCandidate(sourceValue: VimaxPlatformSourceSnapshot, targetValue: VimaxCandidateTarget,
  createValue: VimaxCandidateCreate): VimaxCandidateFreeze {
  const source = vimaxPlatformSourceSnapshotSchema.parse(sourceValue);
  const target = vimaxCandidateTargetSchema.parse(targetValue);
  const body = vimaxCandidateCreateSchema.parse(createValue);
  const request = body.request;
  if (!postgresCompatibleJson(source) || !postgresCompatibleJson(target) || !postgresCompatibleJson(request)) {
    return { ok: false, code: "candidate_blocked" };
  }
  if (!sameVimaxCandidateSource(source, request.source)) return { ok: false, code: "source_changed" };
  const selectedIndex = request.sceneSpans.findIndex((scene) => scene.key === request.selectedSceneKeys[0]);
  const selected = request.sceneSpans[selectedIndex];
  if (!selected || target.sceneId !== body.target.sceneId || target.sceneRevisionId !== body.target.sceneRevisionId
    || target.rowVersion !== body.target.rowVersion || target.sourceScriptRevisionId !== source.scriptRevisionId
    || target.ordinal !== selectedIndex + 1 || target.heading !== selected.heading) return { ok: false, code: "target_changed" };
  const evaluation = evaluateVimaxPlatformPreview({
    schema: VIMAX_PLATFORM_INPUT_SCHEMA, sourceKind: "workspace", upstreamRevision: VIMAX_UPSTREAM_REVISION,
    writingMode: "short", projectId: source.projectId, episodeId: source.episodeId, episodeNo: source.episodeNo,
    scriptRevisionId: source.scriptRevisionId, scriptContentHash: source.scriptContentHash, scriptText: source.scriptText,
    reviewStatus: "APPROVED", isCurrent: true, isStale: false, characters: source.characters,
    sceneSpans: request.sceneSpans, selectedSceneKeys: request.selectedSceneKeys,
    sourceDialogue: request.sourceDialogue, requirements: request.requirements,
  }, request.candidate, request.supplements);
  if (evaluation.status !== "ready_for_review" || evaluation.provenance === null) return { ok: false, code: "candidate_blocked" };
  const frozen = vimaxCandidateFrozenSchema.parse({ schema: VIMAX_CANDIDATE_FROZEN_SCHEMA, source, target, request, evaluation });
  return { ok: true, frozen, frozenHash: hashVimaxCandidateFrozen(frozen) };
}

/** A local typed projection only: extra upstream fields remain in frozen JSON, never hidden in camera or promptText. */
export function vimaxCandidateShotPlans(frozenValue: VimaxCandidateFrozen): ScriptBreakdownShot[] {
  const frozen = vimaxCandidateFrozenSchema.parse(frozenValue);
  return frozen.request.supplements.shots.map((shot, index) => ({
    key: `S1-${String(index + 1)}`, sceneKey: "S1", shotType: shot.shotType, camera: shot.camera, action: shot.action,
    dialogue: shot.dialogue.map((line) => ({ speaker: line.speaker, line: line.line })),
    characterKeys: [...shot.characterKeys], plannedSeconds: shot.plannedSeconds,
  }));
}
