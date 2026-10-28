import { describe, expect, it } from "vitest";
import type { EpisodeRecord } from "./project-base";
import { listUnsavedDrafts, saveText } from "./unsaved-drafts";

function storage(entries: Record<string, string>) {
  const keys = Object.keys(entries);
  return { length: keys.length, key: (index: number) => keys[index] ?? null, getItem: (key: string) => entries[key] ?? null };
}

const draft = JSON.stringify({ fingerprint: "f", idempotencyKey: "k", payload: { text: "x" } });
const EPISODES: EpisodeRecord[] = [{ id: "e2", episodeNo: 2, title: "", rowVersion: 1, currentScriptRevisionId: null,
  approvedScriptRevisionId: null, currentScriptReviewStatus: null, currentScriptFreshnessStatus: null }];

describe("unsaved drafts per object (review)", () => {
  it("lists this project's stored editor drafts by object and ignores everything else", () => {
    const found = listUnsavedDrafts(storage({
      "ads-draft:p1:story:rev-1": draft,
      "ads-draft:p1:script:e2:rev-9": draft,
      "ads-draft:p1:character:c1:rev-3": draft,
      "ads-draft:p2:story:rev-1": draft,
      "ads-draft:new:project:new": draft,
      "ads-writing:p1:story": draft,
      "ads-draft:p1:location:new:new": "not json",
    }), "p1", EPISODES);
    expect(found.map((item) => [item.entityKey, item.label])).toEqual([
      ["character:c1", "角色"], ["script:e2", "第 2 集剧本"], ["story", "故事"]]);
  });

  it("keeps the story's unsaved draft visible after the script reports 已保存", () => {
    const remaining = listUnsavedDrafts(storage({ "ads-draft:p1:story:rev-1": draft }), "p1", EPISODES);
    expect(saveText(remaining, "已保存")).toEqual({ text: "有未保存修改（本标签页草稿）：故事", unsaved: true });
  });

  it("reports a restored draft as unsaved without any editor event", () => {
    const restored = listUnsavedDrafts(storage({ "ads-draft:p1:script:e2:rev-9": draft }), "p1", EPISODES);
    expect(saveText(restored, "尚未修改").unsaved).toBe(true);
  });

  it("keeps a draft typed during a save: the old success does not mark it saved", () => {
    // The editor released only the submitted snapshot; the newer input stays stored.
    const newer = listUnsavedDrafts(storage({ "ads-draft:p1:story:rev-2": draft }), "p1", EPISODES);
    expect(saveText(newer, "已保存").text).toBe("有未保存修改（本标签页草稿）：故事");
    expect(saveText([], "已保存")).toEqual({ text: "服务器已保存", unsaved: false });
    expect(saveText(newer, "版本冲突，草稿保留").text).toContain("需要你确认后再保存");
  });
});
