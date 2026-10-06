import { describe, expect, it } from "vitest";
import { CATEGORIES, TAG_GROUPS, TAGS, formatCreativeDirection, matchesSearch, parseDirectionDraft } from "./creative-taxonomy";

describe("creative taxonomy", () => {
  it("keeps the reference catalog and recommendations internally consistent", () => {
    expect(CATEGORIES).toHaveLength(12); expect(TAG_GROUPS).toHaveLength(6); expect(TAGS).toHaveLength(64);
    expect(new Set(TAGS.map((tag) => tag.id)).size).toBe(64);
    for (const category of CATEGORIES) for (const id of category.recommended) expect(TAGS.some((tag) => tag.id === id)).toBe(true);
  });
  it("rejects malformed, obsolete, or unknown browser values and normalizes duplicates", () => {
    for (const raw of ["{", "null", "[]", '{"version":2}', '{"version":1,"categoryId":"UNKNOWN","tagIds":[]}', '{"version":1,"categoryId":null,"tagIds":["unknown"]}']) expect(parseDirectionDraft(raw)).toBeNull();
    expect(parseDirectionDraft('{"version":1,"categoryId":"ROMANCE","tagIds":["background-0","background-0"]}')).toEqual({ version: 1, categoryId: "ROMANCE", tagIds: ["background-0"] });
  });
  it("matches words without regex interpretation and formats selected groups only", () => {
    expect(matchesSearch("crime SUSPENSE", "SUSPENSE_CRIME")).toBe(true);
    expect(matchesSearch("[", "科幻未来")).toBe(false);
    const text = formatCreativeDirection({ version: 1, categoryId: "ROMANCE", tagIds: ["relation-0"] });
    expect(text).toContain("爱情情感"); expect(text).toContain("甜宠爱情"); expect(text).not.toContain("背景标签");
  });
});
