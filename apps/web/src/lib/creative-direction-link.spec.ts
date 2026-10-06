import { describe, expect, it } from "vitest";
import { CATEGORIES, DIRECTION_STORAGE_KEY, TAGS } from "./creative-taxonomy";
import {
  appendOnce,
  assistantNote,
  bindDirectionToProject,
  premiseBlock,
  projectDirectionKey,
  readProjectDirection,
  readSelectedDirection,
} from "./creative-direction-link";

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null { return this.items.get(key) ?? null; }
  setItem(key: string, value: string): void { this.items.set(key, value); }
}

const direction = { version: 1 as const, categoryId: CATEGORIES[0]!.id, tagIds: [TAGS[0]!.id, TAGS[1]!.id] };

describe("creative direction link", () => {
  it("reads only a valid selection with a main category", () => {
    const storage = new MemoryStorage();
    expect(readSelectedDirection(storage)).toBeNull();
    storage.setItem(DIRECTION_STORAGE_KEY, JSON.stringify({ version: 1, categoryId: null, tagIds: [] }));
    expect(readSelectedDirection(storage)).toBeNull();
    storage.setItem(DIRECTION_STORAGE_KEY, "{broken");
    expect(readSelectedDirection(storage)).toBeNull();
    storage.setItem(DIRECTION_STORAGE_KEY, JSON.stringify(direction));
    expect(readSelectedDirection(storage)).toEqual(direction);
  });

  it("appends once, keeps the original text and refuses to exceed the limit", () => {
    const block = premiseBlock(direction);
    const first = appendOnce("原有梗概", block, 2000);
    expect(first).toEqual({ ok: true, changed: true, text: `原有梗概\n\n${block}` });
    const again = appendOnce(first.ok ? first.text : "", block, 2000);
    expect(again).toEqual({ ok: true, changed: false, text: first.ok ? first.text : "" });
    expect(appendOnce("", block, 2000)).toEqual({ ok: true, changed: true, text: block });
    expect(appendOnce("长".repeat(10), block, 12)).toEqual({ ok: false, reason: "too_long" });
    expect(assistantNote(direction)).toContain(CATEGORIES[0]!.name);
    expect(assistantNote(direction)).toContain(TAGS[1]!.name);
  });

  it("binds a direction to one real project id and does not leak it to another project", () => {
    const storage = new MemoryStorage();
    expect(bindDirectionToProject(storage, "project-a", direction)).toBe(true);
    expect(readProjectDirection(storage, "project-a")).toEqual(direction);
    expect(readProjectDirection(storage, "project-b")).toBeNull();
    storage.setItem(projectDirectionKey("project-b"), JSON.stringify({ version: 1, projectId: "project-a", direction }));
    expect(readProjectDirection(storage, "project-b")).toBeNull();
    const failing = { setItem: () => { throw new Error("quota"); } };
    expect(bindDirectionToProject(failing, "project-c", direction)).toBe(false);
  });
});
