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
