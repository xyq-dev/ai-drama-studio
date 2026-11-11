import { z } from "zod";
/** Versioned authoring data lives inside the existing story/script revision content. */
export const SCRIPT_WORKBENCH_SCHEMA = "script-workbench.v1" as const;
export interface ScriptWorkbenchCharacter {
  id: string; name: string; appearance: string; voice: string; aliases: string; knownInformation: string;
}
export interface ScriptWorkbenchPlan {
  brief: { genre: string; audience: string; productionConstraints: string; logline: string; targetEpisodeSeconds: number; dialogueQuota: number };
  bible: { ending: string; characters: ScriptWorkbenchCharacter[]; openThreads: string };
  outline: { episodes: { episodeNo: number; title: string; openingHook: string; change: string; endingHandoff: string }[] };
}
export interface ScriptWorkbenchBeat {
  id: string; kind: "action" | "dialogue" | "sound" | "pause"; characterId?: string; text: string; seconds: number;
}
export interface ScriptWorkbenchScene {
  id: string; heading: string; interiorExterior: "INT" | "EXT"; timeOfDay: "DAY" | "NIGHT";
  characterIds: string[]; beats: ScriptWorkbenchBeat[];
}
export interface ScriptWorkbenchScript {
  title: string; previousRevisionId: string | null; previousHandoff: string; openingHook: string; change: string;
  endingHandoff: string; characterKnowledge: string; unresolvedThreads: string;
  scenes: ScriptWorkbenchScene[];
  /** A human watches/reads the selected revision, then records these checks before approval. */
  review?: { identityClear: boolean; goalClear: boolean; obstacleClear: boolean; continuityChecked: boolean; lockedMaterialsChecked: boolean; note: string };
}
export interface ScriptWorkbenchDocumentVersions { brief: number; synopsis: number; bible: number; outline: number }
export interface ScriptWorkbenchPlanContent { schema: typeof SCRIPT_WORKBENCH_SCHEMA; plan: ScriptWorkbenchPlan; documentVersions: ScriptWorkbenchDocumentVersions }
export interface ScriptWorkbenchScriptContent { schema: typeof SCRIPT_WORKBENCH_SCHEMA; script: ScriptWorkbenchScript }
export interface ScriptWorkbenchEstimate { seconds: number; dialogueCount: number; dialogueSeconds: number; actionSeconds: number; pauseSeconds: number; soundSeconds: number }
export interface ScriptWorkbenchRevision {
  id: string; revisionNo: number; reviewStatus: string; freshnessStatus: string; reviewVersion: number;
  content: Record<string, unknown>; createdAt: string;
}
export interface ScriptWorkbenchEpisode {
  id: string; episodeNo: number; title: string; rowVersion: number;
  currentScriptRevisionId: string | null; approvedScriptRevisionId: string | null;
  script: ScriptWorkbenchRevision | null; history: ScriptWorkbenchRevision[];
}
export interface ScriptWorkbenchSnapshot {
  project: { id: string; title: string; version: number; episodeCount: number; writingMode: "short" | "series"; targetEpisodeSeconds: number | null };
  story: ScriptWorkbenchRevision | null; storyHistory: ScriptWorkbenchRevision[]; episodes: ScriptWorkbenchEpisode[];
}

const text = z.string().max(8000);
const stableId = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
export const scriptWorkbenchPlanSchema = z.object({
  brief: z.object({ genre: text, audience: text, productionConstraints: text, logline: text,
    targetEpisodeSeconds: z.number().int().min(5).max(3600), dialogueQuota: z.number().int().min(0).max(1000) }).strict(),
  bible: z.object({ ending: text, openThreads: text, characters: z.array(z.object({ id: stableId, name: z.string().min(1).max(100),
    appearance: text, voice: text, aliases: text, knownInformation: text }).strict()).max(100) }).strict(),
  outline: z.object({ episodes: z.array(z.object({ episodeNo: z.number().int().min(1).max(60), title: text,
    openingHook: text, change: text, endingHandoff: text }).strict()).max(60) }).strict(),
}).strict();
export const scriptWorkbenchScriptSchema = z.object({
  title: text, previousRevisionId: z.string().uuid().nullable(), previousHandoff: text, openingHook: text, change: text,
  endingHandoff: text, characterKnowledge: text, unresolvedThreads: text,
  scenes: z.array(z.object({ id: stableId, heading: text, interiorExterior: z.enum(["INT", "EXT"]), timeOfDay: z.enum(["DAY", "NIGHT"]),
    characterIds: z.array(stableId).max(100), beats: z.array(z.object({ id: stableId, kind: z.enum(["action", "dialogue", "sound", "pause"]),
      characterId: stableId.optional(), text, seconds: z.number().min(0).max(3600) }).strict()).max(200) }).strict()).max(100),
  review: z.object({ identityClear: z.boolean(), goalClear: z.boolean(), obstacleClear: z.boolean(),
    continuityChecked: z.boolean(), lockedMaterialsChecked: z.boolean(), note: text }).strict().optional(),
}).strict();

/** Sequential estimate; an explicit dialogue duration may extend, never shorten, its speaking-time estimate. */
export function estimateScriptWorkbench(script: ScriptWorkbenchScript): ScriptWorkbenchEstimate {
  const result: ScriptWorkbenchEstimate = { seconds: 0, dialogueCount: 0, dialogueSeconds: 0, actionSeconds: 0, pauseSeconds: 0, soundSeconds: 0 };
  for (const scene of script.scenes) for (const beat of scene.beats) {
    const explicit = Number.isFinite(beat.seconds) ? Math.max(0, beat.seconds) : 0;
    const seconds = beat.kind === "dialogue" ? Math.max(explicit, Array.from(beat.text.replace(/\s/g, "")).length / 4) : explicit;
    if (beat.kind === "dialogue") { result.dialogueCount += 1; result.dialogueSeconds += seconds; }
    else if (beat.kind === "action") result.actionSeconds += seconds;
    else if (beat.kind === "pause") result.pauseSeconds += seconds;
    else result.soundSeconds += seconds;
    result.seconds += seconds;
  }
  for (const key of ["seconds", "dialogueSeconds", "actionSeconds", "pauseSeconds", "soundSeconds"] as const) result[key] = Math.round(result[key] * 100) / 100;
  return result;
}
