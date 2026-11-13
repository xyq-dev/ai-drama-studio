import type { ScriptWorkbenchPlan, ScriptWorkbenchScript } from "@ai-drama/contracts";
import { nextDraft, readDraft, writeDraft, type JsonStorage } from "./studio-model";

export const WORKBENCH_DRAFT_PREFIX = "ads-workbench-draft:";
export const STORYBOARD_IMAGE_BATCH_PREFIX = "ads.storyboard.image-batch.v1:";
export const WORKBENCH_DRAFTS_CLEARED_EVENT = "ads-workbench-drafts-cleared";
export const IMPORTED_SCRIPT_TEXT_LIMIT = 8000;
const importedScriptKey = (projectId: string) => WORKBENCH_DRAFT_PREFIX + "import:" + projectId;

export function storeImportedScript(storage: JsonStorage, projectId: string, text: string): void {
  if (!text.trim() || text.length > IMPORTED_SCRIPT_TEXT_LIMIT) throw new Error("剧本文字长度不符合要求。");
  storage.setItem(importedScriptKey(projectId), text);
}
export function readImportedScript(storage: JsonStorage, projectId: string): string | null {
  const text = storage.getItem(importedScriptKey(projectId));
  return text?.trim() && text.length <= IMPORTED_SCRIPT_TEXT_LIMIT ? text : null;
}
export function clearImportedScript(storage: JsonStorage, projectId: string): void {
  storage.removeItem(importedScriptKey(projectId));
}
export interface WorkbenchEditingBaseline {
  plan: ScriptWorkbenchPlan | null;
  planVersion: number | null;
  planRevisionId: string | null;
  scripts: Record<string, ScriptWorkbenchScript>;
  scriptVersions: Record<string, number>;
  scriptRevisionIds: Record<string, string | null>;
  sourceStoryIds: Record<string, string | null>;
}
export interface WorkbenchSessionDraft {
  schema: 1;
  projectId: string;
  plan: ScriptWorkbenchPlan | null;
  scripts: Record<string, ScriptWorkbenchScript>;
  baseline: WorkbenchEditingBaseline;
  legacyConverted: string[];
  pendingKeys: Array<[string, string]>;
}
export function emptyWorkbenchBaseline(): WorkbenchEditingBaseline {
  return {
    plan: null,
    planVersion: null,
    planRevisionId: null,
    scripts: {},
    scriptVersions: {},
    scriptRevisionIds: {},
    sourceStoryIds: {},
  };
}
export const sameWorkbenchDraft = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Store only unsaved editing state and unresolved requests, never credentials or the complete server cache. */
export function persistWorkbenchDraft(storage: JsonStorage, data: WorkbenchSessionDraft): void {
  const key = WORKBENCH_DRAFT_PREFIX + data.projectId;
  const base = emptyWorkbenchBaseline();
  const plan = data.plan && !sameWorkbenchDraft(data.plan, data.baseline.plan) ? data.plan : null;
  if (plan) {
    base.plan = data.baseline.plan;
    base.planVersion = data.baseline.planVersion;
    base.planRevisionId = data.baseline.planRevisionId;
  }
  const scripts: Record<string, ScriptWorkbenchScript> = {};
  for (const [id, script] of Object.entries(data.scripts))
    if (!sameWorkbenchDraft(script, data.baseline.scripts[id])) {
      scripts[id] = script;
      base.scripts[id] = data.baseline.scripts[id]!;
      base.scriptVersions[id] = data.baseline.scriptVersions[id]!;
      base.scriptRevisionIds[id] = data.baseline.scriptRevisionIds[id] ?? null;
      base.sourceStoryIds[id] = data.baseline.sourceStoryIds[id] ?? null;
    }
  if (!plan && Object.keys(scripts).length === 0 && data.pendingKeys.length === 0) {
    storage.removeItem(key);
    return;
  }
  const payload = { ...data, plan, scripts, baseline: base };
  writeDraft(
    storage,
    key,
    nextDraft(readDraft(storage, key), payload, null, () => crypto.randomUUID()),
  );
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown, names: string[]): boolean =>
  object(value) && names.every((name) => typeof value[name] === "string");
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const version = (value: unknown): value is number =>
  finite(value) && Number.isInteger(value) && value > 0;
const nullableId = (value: unknown): boolean => value === null || typeof value === "string";
/** Drafts may be incomplete or exceed a server limit while the user is typing; validate their shape, not submission rules. */
function planShape(value: unknown): value is ScriptWorkbenchPlan {
  if (!object(value) || !object(value.brief) || !object(value.bible) || !object(value.outline))
    return false;
  return (
    strings(value.brief, ["genre", "audience", "productionConstraints", "logline"]) &&
    finite(value.brief.targetEpisodeSeconds) &&
    finite(value.brief.dialogueQuota) &&
    strings(value.bible, ["ending", "openThreads"]) &&
    Array.isArray(value.bible.characters) &&
    value.bible.characters.every((item) =>
      strings(item, ["id", "name", "appearance", "voice", "aliases", "knownInformation"]),
    ) &&
    Array.isArray(value.outline.episodes) &&
    value.outline.episodes.every(
      (item) =>
        object(item) &&
        finite(item.episodeNo) &&
        strings(item, ["title", "openingHook", "change", "endingHandoff"]),
    )
  );
}
function scriptShape(value: unknown): value is ScriptWorkbenchScript {
  if (
    !object(value) ||
    !strings(value, [
      "title",
      "previousHandoff",
      "openingHook",
      "change",
      "endingHandoff",
      "characterKnowledge",
      "unresolvedThreads",
    ]) ||
    !nullableId(value.previousRevisionId)
  )
    return false;
  return (
    Array.isArray(value.scenes) &&
    value.scenes.every(
      (scene) =>
        object(scene) &&
        strings(scene, ["id", "heading"]) &&
        ["INT", "EXT"].includes(String(scene.interiorExterior)) &&
        ["DAY", "NIGHT"].includes(String(scene.timeOfDay)) &&
        Array.isArray(scene.characterIds) &&
        scene.characterIds.every((id) => typeof id === "string") &&
        Array.isArray(scene.beats) &&
        scene.beats.every(
          (beat) =>
            object(beat) &&
            strings(beat, ["id", "text"]) &&
            ["action", "dialogue", "sound", "pause"].includes(String(beat.kind)) &&
            finite(beat.seconds) &&
            (beat.characterId === undefined || typeof beat.characterId === "string"),
        ),
    ) &&
    (value.review === undefined ||
      (object(value.review) &&
        strings(value.review, ["note"]) &&
        [
          "identityClear",
          "goalClear",
          "obstacleClear",
          "continuityChecked",
          "lockedMaterialsChecked",
        ].every((key) => typeof (value.review as Record<string, unknown>)[key] === "boolean")))
  );
}
export function restoreWorkbenchDraft(
  storage: JsonStorage,
  projectId: string,
): WorkbenchSessionDraft | null {
  const key = WORKBENCH_DRAFT_PREFIX + projectId;
  const data: unknown = readDraft(storage, key)?.payload;
  if (data == null) {
    if (storage.getItem(key) !== null) throw Error("工作台恢复草稿格式无效");
    return null;
  }
  if (
    !object(data) ||
    data.schema !== 1 ||
    data.projectId !== projectId ||
    !object(data.baseline) ||
    !object(data.scripts)
  )
    throw Error("工作台恢复草稿格式无效");
  const base = data.baseline;
  if (
    !object(base.scripts) ||
    !object(base.scriptVersions) ||
    !object(base.scriptRevisionIds) ||
    !object(base.sourceStoryIds) ||
    (data.plan !== null &&
      (!planShape(data.plan) ||
        !planShape(base.plan) ||
        !version(base.planVersion) ||
        !nullableId(base.planRevisionId))) ||
    !Object.entries(data.scripts).every(
      ([id, script]) =>
        scriptShape(script) &&
        scriptShape((base.scripts as Record<string, unknown>)[id]) &&
        version((base.scriptVersions as Record<string, unknown>)[id]) &&
        nullableId((base.scriptRevisionIds as Record<string, unknown>)[id]) &&
        nullableId((base.sourceStoryIds as Record<string, unknown>)[id]),
    ) ||
    !Array.isArray(data.legacyConverted) ||
    !data.legacyConverted.every((id) => typeof id === "string") ||
    !Array.isArray(data.pendingKeys) ||
    !data.pendingKeys.every(
      (item) =>
        Array.isArray(item) && item.length === 2 && item.every((part) => typeof part === "string"),
    )
  )
    throw Error("工作台恢复草稿缺少编辑基线");
  return data as unknown as WorkbenchSessionDraft;
}
/** Explicit logout clears this tab's workbench drafts; an expired session deliberately keeps them for re-login. */
export function clearWorkbenchSessionDrafts(
  storage: Pick<Storage, "length" | "key" | "removeItem">,
): void {
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (key?.startsWith(WORKBENCH_DRAFT_PREFIX) || key?.startsWith(STORYBOARD_IMAGE_BATCH_PREFIX)) storage.removeItem(key);
  }
}
