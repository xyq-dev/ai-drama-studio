import type { EpisodeRecord } from "./project-base";

/**
 * Unsaved work, read from the drafts the existing editors keep in this tab's sessionStorage
 * (`ads-draft:<projectId>:<entityKey>:<base>`). An editor writes its draft on every change and removes it only
 * when the submitted snapshot is still the latest one, so a draft present here is real unsaved content: restored
 * after a reload, typed during a save, or kept after a conflict. Nothing here changes how editors save.
 */
export interface UnsavedDraft {
  key: string;
  entityKey: string;
  label: string;
}

interface ReadableStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
}

function isDraftRecord(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { fingerprint?: unknown; idempotencyKey?: unknown };
    return typeof parsed.fingerprint === "string" && typeof parsed.idempotencyKey === "string";
  } catch {
    return false;
  }
}

export function draftLabel(entityKey: string, episodes: readonly EpisodeRecord[]): string {
  const [kind, id] = entityKey.split(":");
  const episodeNo = (episodeId: string | undefined) => episodes.find((item) => item.id === episodeId)?.episodeNo;
  switch (kind) {
    case "story": return "故事";
    case "script": return episodeNo(id) ? `第 ${episodeNo(id)} 集剧本` : "剧本";
    case "character": return id === "new" ? "新建角色" : "角色";
    case "location": return id === "new" ? "新建场地" : "场地";
    case "scene-new": return "新建场景";
    case "scene": return "场景";
    case "shot-new": return "新建镜头";
    case "shot": return "镜头";
    default: return "内容";
  }
}

export function listUnsavedDrafts(storage: ReadableStorage, projectId: string, episodes: readonly EpisodeRecord[]): UnsavedDraft[] {
  const prefix = `ads-draft:${projectId}:`;
  const drafts: UnsavedDraft[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix) || !isDraftRecord(storage.getItem(key))) continue;
    const rest = key.slice(prefix.length);
    // The last segment is the base revision; the entity key itself may contain a colon.
    const entityKey = rest.slice(0, rest.lastIndexOf(":"));
    drafts.push({ key, entityKey, label: draftLabel(entityKey, episodes) });
  }
  return drafts.sort((left, right) => left.key.localeCompare(right.key));
}

export function safeUnsavedDrafts(projectId: string, episodes: readonly EpisodeRecord[]): UnsavedDraft[] {
  try {
    return listUnsavedDrafts(window.sessionStorage, projectId, episodes);
  } catch {
    return [];
  }
}

/**
 * "服务器已保存" / "本标签页草稿" / "有未保存修改". Unsaved work is whatever drafts the editors still hold for this
 * project, by object; the last editor event only adds why (saving, conflict, failure). Saving one object never
 * hides a draft that another object still holds.
 */
export function saveText(drafts: readonly UnsavedDraft[], lastEvent: string): { text: string; unsaved: boolean } {
  if (drafts.length > 0) {
    const names = [...new Set(drafts.map((draft) => draft.label))].join("、");
    const reason = lastEvent.includes("冲突") ? "；服务器上的版本已变化，需要你确认后再保存"
      : lastEvent.includes("失败") ? "；上次保存没有成功"
        : lastEvent === "保存中" ? "；正在保存" : "";
    return { text: `有未保存修改（本标签页草稿）：${names}${reason}`, unsaved: true };
  }
  if (lastEvent === "保存中") return { text: "正在保存到服务器", unsaved: false };
  if (lastEvent === "已保存") return { text: "服务器已保存", unsaved: false };
  return { text: "没有未保存的修改", unsaved: false };
}
