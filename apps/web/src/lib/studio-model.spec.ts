import { describe, expect, it } from "vitest";
import {
  aggregateVersion,
  applyPage,
  applyTextContent,
  attachSeenBaseline,
  clearDraft,
  confirmConflictDraft,
  displayedConflict,
  currentStoryRevision,
  describeRevision,
  shouldApplyLoad,
  diffJson,
  draftStorageKey,
  nextDraft,
  readDraft,
  releaseSubmittedDraft,
  reviewActions,
  reviewRequest,
  shouldPoll,
  sourceUsable,
  writeDraft,
  type JsonStorage,
} from "./studio-model";

function memory(): JsonStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

describe("studio model", () => {
  it("reads aggregate versions from the owning record", () => {
    expect(aggregateVersion("story", { projectVersion: 4 })).toBe(4);
    expect(aggregateVersion("character-create", { projectVersion: 4 })).toBe(4);
    expect(aggregateVersion("script", { episodeRowVersion: 2 })).toBe(2);
    expect(aggregateVersion("scene-create", { episodeRowVersion: 2 })).toBe(2);
    expect(aggregateVersion("shot-create", { entityRowVersion: 7 })).toBe(7);
    expect(aggregateVersion("shot", { entityRowVersion: 9 })).toBe(9);
    expect(reviewRequest({ reviewVersion: 3 }, "APPROVED", " 备注 ")).toEqual({
      to: "APPROVED",
      expectedReviewVersion: 3,
      reviewNote: "备注",
    });
  });

  it("keeps unknown JSON fields and ignores object key order", () => {
    const merged = applyTextContent({ text: "旧", mood: "冷", tags: ["a", "b"] }, "新");
    expect(merged).toEqual({ text: "新", mood: "冷", tags: ["a", "b"] });
    expect(diffJson({ b: 1, a: { z: 2, y: 1 } }, { a: { y: 1, z: 2 }, b: 1 })).toEqual([]);
    const changed = diffJson({ tags: ["a", "b"], text: "甲\n乙" }, { tags: ["b", "a"], text: "甲\n丙" });
    expect(changed.map((row) => row.path)).toEqual(["tags[0]", "tags[1]", "text"]);
    expect(changed.find((row) => row.path === "text")?.lines).toEqual([
      { kind: "del", text: "乙" },
      { kind: "add", text: "丙" },
    ]);
  });

  it("reuses a draft key until the baseline changes", () => {
    const storage = memory();
    const key = draftStorageKey("project", "story", "rev-1");
    const first = nextDraft(null, { content: { text: "草稿", extra: true } }, 3, () => "key-1");
    writeDraft(storage, key, first);
    const edited = nextDraft(readDraft(storage, key), { content: { extra: true, text: "草稿" } }, 3, () => "key-2");
    expect(edited.idempotencyKey).toBe("key-1");
    writeDraft(storage, key, edited);
    expect(readDraft(storage, key)?.payload).toEqual({ content: { extra: true, text: "草稿" } });
    const confirmed = confirmConflictDraft(edited, 4, () => "key-3");
    expect(confirmed.idempotencyKey).toBe("key-3");
    expect(confirmed.ifMatch).toBe(4);
    expect(confirmed.payload).toEqual(edited.payload);
    const retried = confirmConflictDraft(confirmed, 4, () => "key-4");
    expect(retried.idempotencyKey).toBe("key-3");
    expect(releaseSubmittedDraft(storage, key, { ...first, fingerprint: "changed" })).toBe(false);
    clearDraft(storage, "other");
    expect(readDraft(storage, key)?.idempotencyKey).toBe("key-1");
    expect(releaseSubmittedDraft(storage, key, readDraft(storage, key)!)).toBe(true);
    expect(readDraft(storage, key)).toBeNull();
  });

  it("shows a moved baseline without replacing the draft If-Match", () => {
    const draft = nextDraft(null, { text: "草稿" }, 2, () => "key-1");
    const typed = nextDraft(draft, { text: "继续" }, 2, () => "key-2");
    expect(typed.ifMatch).toBe(2);
    expect(typed.idempotencyKey).toBe("key-2");
    expect(displayedConflict(typed, 2, { text: "页面" })).toEqual({ blocked: false, seen: null });
    expect(displayedConflict(typed, 5, { text: "新页面" })).toEqual({
      blocked: true,
      seen: { ifMatch: 5, server: { text: "新页面" } },
    });
    const snapshotted = attachSeenBaseline(typed, { ifMatch: 5, server: { text: "冲突" } });
    expect(displayedConflict(snapshotted, 2, { text: "页面" }).seen).toEqual({ ifMatch: 5, server: { text: "冲突" } });
    const confirmed = confirmConflictDraft(snapshotted, 5, () => "key-3");
    expect(displayedConflict(confirmed, 2, { text: "页面" }).blocked).toBe(false);
    const nextConflict = attachSeenBaseline(confirmed, { ifMatch: 8, server: { text: "再冲突" } });
    expect(displayedConflict(nextConflict, 2, { text: "页面" }).seen?.ifMatch).toBe(8);
    expect(displayedConflict(nextConflict, 9, { text: "刷新" }).seen).toEqual({ ifMatch: 9, server: { text: "刷新" } });
  });

  it("resets pagination when the scope changes and describes a null revision", () => {
    const first = applyPage(null, { scope: "p1:episode-a", items: [1], nextCursor: "c", append: false });
    const appended = applyPage(first, { scope: "p1:episode-a", items: [2], nextCursor: null, append: true });
    expect(appended.items).toEqual([1, 2]);
    const switched = applyPage(appended, { scope: "p1:episode-b", items: [9], nextCursor: null, append: true });
    expect(switched.items).toEqual([9]);
    expect(shouldApplyLoad(2, 2)).toBe(true);
    expect(shouldApplyLoad(1, 2)).toBe(false);
    expect(describeRevision(null)).toBe("empty");
    expect(describeRevision({ id: "rev" })).toBe("present");
  });

  it("stops polling on a terminal workflow and blocks stale sources", () => {
    expect(shouldPoll("RUNNING", false)).toBe(true);
    expect(shouldPoll("SUCCEEDED", false)).toBe(false);
    expect(shouldPoll("RUNNING", true)).toBe(false);
    expect(reviewActions({ reviewStatus: "DRAFT", freshnessStatus: "STALE", isCurrent: true })[0]?.enabled).toBe(false);
    expect(sourceUsable({
      reviewStatus: "APPROVED",
      freshnessStatus: "CURRENT",
      currentId: "new",
      approvedId: "old",
      revisionId: "old",
    }).usable).toBe(false);
    expect(currentStoryRevision([{ revisionNo: 1 }, { revisionNo: 3 }, { revisionNo: 2 }])?.revisionNo).toBe(3);
  });
});
