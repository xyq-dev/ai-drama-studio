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

/**
 * The block this page appended and where it starts. `separated` says the blank line right before it was also put there
 * by the page and is still untouched. Only that occurrence, and only that separator, is ever removed.
 */
export interface OwnedBlock {
  block: string;
  at: number;
  separated: boolean;
}

const SEPARATOR = "\n\n";

export type RemoveResult = { ok: true; text: string } | { ok: false; reason: "not_found" };

/**
 * Removes the owned block at its recorded position, together with the blank line appendOnce put before it. When the
 * text there is no longer the block verbatim, nothing is removed: nothing is guessed or fuzzily matched, and another
 * identical copy elsewhere (the user's) is never taken instead.
 */
export function removeOwned(text: string, owned: OwnedBlock): RemoveResult {
  if (text.slice(owned.at, owned.at + owned.block.length) !== owned.block) return { ok: false, reason: "not_found" };
  let before = text.slice(0, owned.at);
  const after = text.slice(owned.at + owned.block.length);
  // Separators the user typed, before or after the block, are theirs and stay.
  if (owned.separated && before.endsWith(SEPARATOR)) before = before.slice(0, -SEPARATOR.length);
  return { ok: true, text: `${before}${after}` };
}

/**
 * Follows the owned block through one edit by the user. The edit is the span between the unchanged start and end of
 * the text; an edit before the block shifts it, one after leaves it, and one touching it ends ownership (null).
 */
export function trackOwned(previous: string, next: string, owned: OwnedBlock): OwnedBlock | null {
  if (previous === next) return owned;
  const shortest = Math.min(previous.length, next.length);
  let prefix = 0;
  while (prefix < shortest && previous[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < shortest - prefix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1;
  const editEnd = previous.length - suffix;
  const blockEnd = owned.at + owned.block.length;
  let at: number;
  if (editEnd <= owned.at) at = owned.at + next.length - previous.length;
  else if (prefix >= blockEnd) at = owned.at;
  else return null;
  // An edit reaching the page's separator, or inserting right at the block's start, makes whatever blank line now
  // precedes the block the user's. The boundaries are inclusive: the diff cannot tell which side an insertion took,
  // and wrongly keeping one blank line is harmless where wrongly removing one merges the user's text.
  const separated = owned.separated && !(prefix <= owned.at && editEnd >= owned.at - SEPARATOR.length);
  return next.slice(at, at + owned.block.length) === owned.block ? { block: owned.block, at, separated } : null;
}

/** `owned` is set only when `next` was appended by this call: an identical block already in the text stays the user's. */
export type SwitchResult =
  | { ok: true; text: string; changed: boolean; owned: OwnedBlock | null }
  | { ok: false; reason: "too_long" | "edited" };

/**
 * Moves the text from the block this page owns (null when none) to `next` (null removes it). Only the owned
 * occurrence is taken out; when it is no longer at its place verbatim, the result is "edited" and nothing changes.
 */
export function switchBlock(text: string, owned: OwnedBlock | null, next: string | null, maxChars: number): SwitchResult {
  if (owned !== null && owned.block === next) {
    // The same direction again: fine while its block is intact; an edited block is never topped up with a fresh copy.
    return text.slice(owned.at, owned.at + next.length) === next
      ? { ok: true, text, changed: false, owned }
      : { ok: false, reason: "edited" };
  }
  let base = text;
  if (owned !== null) {
    const removed = removeOwned(text, owned);
    if (!removed.ok) return { ok: false, reason: "edited" };
    base = removed.text;
  }
  if (next === null) return { ok: true, text: base, changed: base !== text, owned: null };
  const added = appendOnce(base, next, maxChars);
  if (!added.ok) return added;
  return { ok: true, text: added.text, changed: added.text !== text,
    // appendOnce puts a blank line before the block unless the text was empty.
    owned: added.changed ? { block: next, at: added.text.length - next.length, separated: base.trim().length > 0 } : null };
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
