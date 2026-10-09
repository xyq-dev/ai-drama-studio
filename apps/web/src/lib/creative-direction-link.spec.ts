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
  removeOnce,
  switchBlock,
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

describe("switching the direction block", () => {
  const block = premiseBlock(direction);
  const other = premiseBlock({ version: 1, categoryId: CATEGORIES[1]!.id, tagIds: [] });

  it("removes the one verbatim block with the blank line it was added with, and nothing else", () => {
    expect(removeOnce(`开头\n\n${block}`, block)).toEqual({ ok: true, text: "开头" });
    expect(removeOnce(`开头\n\n${block}\n\n结尾`, block)).toEqual({ ok: true, text: "开头\n\n结尾" });
    expect(removeOnce(`${block}\n\n结尾`, block)).toEqual({ ok: true, text: "结尾" });
    expect(removeOnce(`${block}！`, block)).toEqual({ ok: true, text: "！" });
    expect(removeOnce(`开头${block.slice(1)}`, block)).toEqual({ ok: false, reason: "not_found" });
    expect(removeOnce(`${block}\n\n${block}`, block)).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("swaps only the applied block, refuses edited text, and keeps the length limit", () => {
    expect(switchBlock("开头", null, block, 4000)).toEqual({ ok: true, text: `开头\n\n${block}`, changed: true, appended: true });
    expect(switchBlock(`开头\n\n${block}`, block, block, 4000)).toEqual({ ok: true, text: `开头\n\n${block}`, changed: false, appended: false });
    expect(switchBlock(`开头\n\n${block}\n\n结尾`, block, other, 4000)).toEqual({ ok: true, text: `开头\n\n结尾\n\n${other}`, changed: true, appended: true });
    expect(switchBlock(`开头\n\n${block}`, block, null, 4000)).toEqual({ ok: true, text: "开头", changed: true, appended: false });
    const edited = `开头\n\n${block.replace("创作方向", "我的方向")}`;
    expect(switchBlock(edited, block, other, 4000)).toEqual({ ok: false, reason: "edited" });
    expect(switchBlock(edited, block, null, 4000)).toEqual({ ok: false, reason: "edited" });
    expect(switchBlock(edited, block, block, 4000)).toEqual({ ok: false, reason: "edited" });
    expect(switchBlock("开头", null, block, 5)).toEqual({ ok: false, reason: "too_long" });
    // A user-written copy of the new direction is kept and not reported as appended.
    expect(switchBlock(`${other}

${block}`, block, other, 4000)).toEqual({ ok: true, text: other, changed: true, appended: false });
  });
});
