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
  removeOwned,
  switchBlock,
  trackOwned,
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
  const ownedAt = (text: string) => ({ block, at: text.lastIndexOf(block) });

  it("removes only the owned occurrence with the blank line it was added with", () => {
    const tail = `开头\n\n${block}`;
    expect(removeOwned(tail, ownedAt(tail))).toEqual({ ok: true, text: "开头" });
    const middle = `开头\n\n${block}\n\n结尾`;
    expect(removeOwned(middle, ownedAt(middle))).toEqual({ ok: true, text: "开头\n\n结尾" });
    expect(removeOwned(`${block}！`, { block, at: 0 })).toEqual({ ok: true, text: "！" });
    // The user's pasted copy at the start stays; only the recorded occurrence goes.
    const two = `${block}\n\n${block}`;
    expect(removeOwned(two, ownedAt(two))).toEqual({ ok: true, text: block });
    expect(removeOwned(`开头${block.slice(1)}`, { block, at: 2 })).toEqual({ ok: false, reason: "not_found" });
  });

  it("follows the owned block through edits before and after it, and drops it when an edit touches it", () => {
    const text = `开头\n\n${block}`;
    const owned = ownedAt(text);
    expect(trackOwned(text, `更长的开头\n\n${block}`, owned)).toEqual({ block, at: owned.at + 3 });
    expect(trackOwned(text, `${text}\n\n结尾`, owned)).toEqual(owned);
    expect(trackOwned(text, text.replace("请围绕", "我改过：请围绕"), owned)).toBeNull();
    // Paste a pristine copy first, then edit the original: the copy is never taken as the page's.
    const pasted = `${block}\n\n${text}`;
    const afterPaste = trackOwned(text, pasted, owned)!;
    expect(afterPaste.at).toBe(pasted.lastIndexOf(block));
    expect(trackOwned(pasted, `${block}\n\n开头\n\n${block.replace("请围绕", "改：请围绕")}`, afterPaste)).toBeNull();
  });

  it("swaps only the owned block, refuses edited text, and keeps the length limit", () => {
    const appended = switchBlock("开头", null, block, 4000);
    expect(appended).toEqual({ ok: true, text: `开头\n\n${block}`, changed: true, owned: { block, at: 4 } });
    const text = `开头\n\n${block}`;
    expect(switchBlock(text, ownedAt(text), block, 4000)).toEqual({ ok: true, text, changed: false, owned: ownedAt(text) });
    const middle = `开头\n\n${block}\n\n结尾`;
    const swapped = `开头\n\n结尾\n\n${other}`;
    expect(switchBlock(middle, ownedAt(middle), other, 4000)).toEqual({ ok: true, text: swapped, changed: true, owned: { block: other, at: swapped.length - other.length } });
    expect(switchBlock(text, ownedAt(text), null, 4000)).toEqual({ ok: true, text: "开头", changed: true, owned: null });
    const edited = text.replace("创作方向", "我的方向");
    expect(switchBlock(edited, ownedAt(text), other, 4000)).toEqual({ ok: false, reason: "edited" });
    expect(switchBlock(edited, ownedAt(text), null, 4000)).toEqual({ ok: false, reason: "edited" });
    expect(switchBlock(edited, ownedAt(text), block, 4000)).toEqual({ ok: false, reason: "edited" });
    expect(switchBlock("开头", null, block, 5)).toEqual({ ok: false, reason: "too_long" });
    // A user-written copy of the new direction is kept and not taken as owned.
    const userOther = `${other}\n\n${block}`;
    expect(switchBlock(userOther, ownedAt(userOther), other, 4000)).toEqual({ ok: true, text: other, changed: true, owned: null });
  });
});
