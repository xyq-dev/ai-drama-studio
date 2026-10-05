import { describe, expect, it } from "vitest";
import { QWEN_TEXT_TRIAL_LIMITS, parseQwenTextTrialDraft, parseQwenTextTrialInput } from "./qwen-text-trial";

const input = {
  schema: "qwen.text.trial.input.v1",
  idea: "雨夜便利店里，实习店员把最后一盒临期饭团让给了赶末班车的陌生人。",
  tone: "克制",
  targetDurationSeconds: 75,
};

function draft(patch: Record<string, unknown> = {}) {
  return {
    schema: "qwen.text.trial.draft.v1",
    title: "末班饭团",
    logline: "店员把最后一只饭团让给了赶车的人。",
    characters: [{ name: "小林", summary: "夜班店员" }],
    scenes: [{
      ordinal: 1,
      title: "柜台",
      action: "小林把饭团推过柜台。",
      dialogue: [{ character: "小林", line: "还热着。" }],
    }],
    ...patch,
  };
}

describe("qwen text trial contracts", () => {
  it("accepts a bounded input and defaults the writing target to 60 seconds", () => {
    const parsed = parseQwenTextTrialInput({ schema: input.schema, idea: `  ${input.idea}  ` });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.data.targetDurationSeconds).toBe(QWEN_TEXT_TRIAL_LIMITS.durationDefault);
  });

  it("rejects an idea over the limit, a duration outside 60-90, and business identity fields", () => {
    expect(parseQwenTextTrialInput({ ...input, idea: "雨".repeat(QWEN_TEXT_TRIAL_LIMITS.ideaMax + 1) }).ok).toBe(false);
    expect(parseQwenTextTrialInput({ ...input, targetDurationSeconds: 59 }).ok).toBe(false);
    expect(parseQwenTextTrialInput({ ...input, targetDurationSeconds: 91 }).ok).toBe(false);
    expect(parseQwenTextTrialInput({ ...input, revisionId: "rev" }).ok).toBe(false);
  });

  it("requires contiguous scenes, unique names, and dialogue speakers from the character list", () => {
    expect(parseQwenTextTrialDraft(draft()).ok).toBe(true);
    const duplicate = draft({ characters: [{ name: "小林", summary: "甲" }, { name: "小林", summary: "乙" }] });
    expect(parseQwenTextTrialDraft(duplicate).ok).toBe(false);
    const gap = draft({
      scenes: [
        { ordinal: 1, title: "甲", action: "走进店里。", dialogue: [] },
        { ordinal: 3, title: "乙", action: "离开柜台。", dialogue: [] },
      ],
    });
    expect(parseQwenTextTrialDraft(gap).ok).toBe(false);
    const stranger = draft({
      scenes: [{ ordinal: 1, title: "柜台", action: "递出饭团。", dialogue: [{ character: "路人", line: "谢谢。" }] }],
    });
    expect(parseQwenTextTrialDraft(stranger).ok).toBe(false);
    expect(parseQwenTextTrialDraft({ ...draft(), actualDurationSeconds: 60, status: "APPROVED" }).ok).toBe(false);
  });
});
