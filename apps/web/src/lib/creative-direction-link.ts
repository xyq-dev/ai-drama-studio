import {
  CATEGORIES,
  DIRECTION_STORAGE_KEY,
  TAGS,
  formatCreativeDirection,
  parseDirectionDraft,
  type DirectionDraft,
} from "./creative-taxonomy";

/**
 * Carries a category-center direction into a new work and its story assistant. Everything here lives in this
 * browser's localStorage only; nothing is written to project fields and the URL only carries a flag.
 */
const PROJECT_DIRECTION_PREFIX = "ads-creative-direction:project:";

export interface ProjectDirection {
  version: 1;
  projectId: string;
  direction: DirectionDraft;
}

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

export function readSelectedDirection(storage: ReadableStorage): DirectionDraft | null {
  try {
    const raw = storage.getItem(DIRECTION_STORAGE_KEY);
    const parsed = raw ? parseDirectionDraft(raw) : null;
    return parsed && parsed.categoryId ? parsed : null;
  } catch {
    return null;
  }
}

export type AppendResult = { ok: true; text: string; changed: boolean } | { ok: false; reason: "too_long" };

/** Appends a block once. A repeated apply leaves the text unchanged instead of adding a second copy. */
export function appendOnce(text: string, block: string, maxChars: number): AppendResult {
  if (text.includes(block)) return { ok: true, text, changed: false };
  const next = text.trim().length === 0 ? block : `${text.replace(/\s+$/u, "")}\n\n${block}`;
  if (next.length > maxChars) return { ok: false, reason: "too_long" };
  return { ok: true, text: next, changed: true };
}

export type RemoveResult = { ok: true; text: string } | { ok: false; reason: "not_found" | "ambiguous" };

/**
 * Removes the one verbatim copy of a block that appendOnce added, together with the blank line appendOnce put before
 * it. Text the block is not found in exactly once is left alone: nothing is guessed or fuzzily matched.
 */
export function removeOnce(text: string, block: string): RemoveResult {
  const at = text.indexOf(block);
  if (at < 0) return { ok: false, reason: "not_found" };
  if (text.indexOf(block, at + 1) >= 0) return { ok: false, reason: "ambiguous" };
  let before = text.slice(0, at);
  let after = text.slice(at + block.length);
  if (before.endsWith("\n\n")) before = before.slice(0, -2);
  else if (after.startsWith("\n\n")) after = after.slice(2);
  return { ok: true, text: `${before}${after}` };
}

export type SwitchResult = { ok: true; text: string; changed: boolean } | { ok: false; reason: "too_long" | "edited" };

/**
 * Moves the text from the block this page added (`applied`, null when none) to `next` (null removes it). Only the
 * applied block itself is taken out; when it is no longer in the text verbatim, the text is returned as "edited" and
 * nothing changes.
 */
export function switchBlock(text: string, applied: string | null, next: string | null, maxChars: number): SwitchResult {
  if (applied !== null && applied === next) return appendOnce(text, next, maxChars);
  let base = text;
  if (applied !== null) {
    const removed = removeOnce(text, applied);
    if (!removed.ok) return { ok: false, reason: "edited" };
    base = removed.text;
  }
  if (next === null) return { ok: true, text: base, changed: base !== text };
  const added = appendOnce(base, next, maxChars);
  if (!added.ok) return added;
  return { ok: true, text: added.text, changed: added.text !== text };
}

export function premiseBlock(direction: DirectionDraft): string {
  return formatCreativeDirection(direction);
}

/** A compact one-line note for the assistant's genre field. */
export function assistantNote(direction: DirectionDraft): string {
  const category = CATEGORIES.find((item) => item.id === direction.categoryId);
  const tags = TAGS.filter((tag) => direction.tagIds.includes(tag.id)).map((tag) => tag.name);
  return `分类方向：${category?.name ?? "未选择"}${tags.length ? `；标签：${tags.join("、")}` : ""}`;
}

export function projectDirectionKey(projectId: string): string {
  return `${PROJECT_DIRECTION_PREFIX}${projectId}`;
}

export function bindDirectionToProject(storage: WritableStorage, projectId: string, direction: DirectionDraft): boolean {
  try {
    const value: ProjectDirection = { version: 1, projectId, direction };
    storage.setItem(projectDirectionKey(projectId), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Returns the direction bound to exactly this project, or null when it belongs to another or is damaged. */
export function readProjectDirection(storage: ReadableStorage, projectId: string): DirectionDraft | null {
  try {
    const raw = storage.getItem(projectDirectionKey(projectId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ProjectDirection> | null;
    if (!value || value.version !== 1 || value.projectId !== projectId) return null;
    const direction = parseDirectionDraft(JSON.stringify(value.direction));
    return direction && direction.categoryId ? direction : null;
  } catch {
    return null;
  }
}
