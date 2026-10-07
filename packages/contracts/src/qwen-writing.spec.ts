import { describe, expect, it } from "vitest";
import { WRITING_BODY_MAX_CHARS, WRITING_NOTE_MAX_CHARS } from "./writing-assistant";
import { QWEN_WRITING_INPUT_MAX_BYTES, QWEN_WRITING_INPUT_SCHEMA, parseQwenWritingInput, qwenWritingInputByteLength,
  qwenWritingInputWithinLimit } from "./qwen-writing";

const story = {
  schema: QWEN_WRITING_INPUT_SCHEMA,
  mode: "story" as const,
  premise: "夜班便利店",
  genre: "悬疑",
  audience: "成人",
  characters: "店员",
  mustKeep: "班次记录是真的",
  mustNotChange: "",
  currentText: "",
};

describe("qwen writing input", () => {
  it("accepts a saved story longer than a note and keeps the episode number", () => {
    const longStory = "故".repeat(WRITING_NOTE_MAX_CHARS + 1);
    expect(longStory.length).toBeLessThanOrEqual(WRITING_BODY_MAX_CHARS);
    const parsed = parseQwenWritingInput({
      schema: QWEN_WRITING_INPUT_SCHEMA,
      mode: "episode",
      episodeNo: 1,
      premise: "夜班便利店",
      genre: "悬疑",
      audience: "成人",
      characters: "店员",
      confirmedStory: longStory,
      currentText: longStory,
      revisionRequest: "只改开场",
      mustKeep: "",
      mustKeepDialogue: "",
      mustKeepEnding: "",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.data.mode === "episode") expect(parsed.data.confirmedStory).toBe(longStory);
  });

  it("rejects business identity, a note over the cap, and a body that would need truncation", () => {
    expect(parseQwenWritingInput({ ...story, projectId: "project-1" }).ok).toBe(false);
    expect(parseQwenWritingInput({ ...story, revisionId: "rev" }).ok).toBe(false);
    expect(parseQwenWritingInput({ ...story, ifMatch: 4 }).ok).toBe(false);
    expect(parseQwenWritingInput({ ...story, reviewStatus: "DRAFT" }).ok).toBe(false);
    expect(parseQwenWritingInput({ ...story, genre: "题".repeat(WRITING_NOTE_MAX_CHARS + 1) }).ok).toBe(false);
    expect(parseQwenWritingInput({ ...story, currentText: "文".repeat(WRITING_BODY_MAX_CHARS + 1) }).ok).toBe(false);
    expect(parseQwenWritingInput({ ...story, mode: "episode" }).ok).toBe(false);
  });

  it("meters the serialized input in UTF-8 bytes: Chinese, emoji, escapes and the exact boundary", () => {
    const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    expect(qwenWritingInputByteLength("a")).toBe(3);
    expect(qwenWritingInputByteLength("故")).toBe(5);
    expect(qwenWritingInputByteLength("😀")).toBe(6);
    expect(qwenWritingInputByteLength("\u0001")).toBe(8);
    expect(qwenWritingInputByteLength({ ...story, premise: "夜班😀" })).toBe(bytesOf({ ...story, premise: "夜班😀" }));
    const overhead = bytesOf({ ...story, currentText: "" });
    const fill = (bytes: number, unit: string, unitBytes: number) => unit.repeat(Math.floor(bytes / unitBytes))
      + "a".repeat(bytes % unitBytes);
    for (const [unit, unitBytes] of [["故", 3], ["😀", 4]] as const) {
      const at = { ...story, currentText: fill(QWEN_WRITING_INPUT_MAX_BYTES - overhead, unit, unitBytes) };
      const over = { ...story, currentText: `${at.currentText}a` };
      expect(qwenWritingInputByteLength(at)).toBe(QWEN_WRITING_INPUT_MAX_BYTES);
      expect(qwenWritingInputWithinLimit(at)).toBe(true);
      expect(qwenWritingInputByteLength(over)).toBe(QWEN_WRITING_INPUT_MAX_BYTES + 1);
      expect(qwenWritingInputWithinLimit(over)).toBe(false);
      // String length would have let both through.
      expect(JSON.stringify(over).length).toBeLessThan(QWEN_WRITING_INPUT_MAX_BYTES);
    }
  });
});
