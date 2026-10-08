import { describe, expect, it } from "vitest";
import { EPISODE_DRAFT_SCHEMA, EPISODE_OUTLINE_SCHEMA, TITLE_CONCEPT_SCHEMA, type TitleWritingFrozenInput } from "@ai-drama/contracts";
import { buildTitleWritingPrompt, formatTitleStory, validateTitleWritingOutput } from "./title-writing";

const INPUT: TitleWritingFrozenInput = {
  schema: "ads.title-writing.input.v1", promptVersion: "ads.title-writing.prompt.v1", title: "夜班证词",
  settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "qwen", model: "q-1",
};
const CONCEPT = {
  schema: TITLE_CONCEPT_SCHEMA, genre: "悬疑", logline: "一句话", synopsis: "梗概", protagonistGoal: "目标", opposition: "阻力",
  coreConflict: "冲突", direction: "走向", characters: [{ name: "林夏", role: "主角", profile: "倔强" }, { name: "周岩", role: "刑警", profile: "冷淡" }],
  relationships: [{ name: "林夏与周岩", pressure: "互相怀疑" }],
};
const OUTLINE = { schema: EPISODE_OUTLINE_SCHEMA, episodes: [1, 2, 3].map((episodeNo) => ({ episodeNo, title: `集${episodeNo}`,
  entryState: "a", goal: "b", action: "c", turn: "d", result: "e", handoff: "f" })) };
const EPISODE = (episodeNo: number) => ({ schema: EPISODE_DRAFT_SCHEMA, episodeNo, title: "t", screenplay: "剧本",
  scenes: [{ heading: "h", action: "a", dialogue: "", sound: "" }], handoffFacts: [`第${episodeNo}集事实`] });

describe("title writing prompts", () => {
  it("the first step needs only the title and asks for json", () => {
    const prompt = buildTitleWritingPrompt("concept", INPUT, {});
    expect(prompt.user).toContain("剧名：夜班证词");
    expect(prompt.system).toContain("json");
    expect(prompt.user).toContain(TITLE_CONCEPT_SCHEMA);
  });

  it("later steps refuse to run without the saved earlier outputs", () => {
    expect(() => buildTitleWritingPrompt("outline", INPUT, {})).toThrow();
    expect(() => buildTitleWritingPrompt("episode:2", INPUT, { concept: CONCEPT as never, outline: OUTLINE as never, episodes: [] })).toThrow();
    const prompt = buildTitleWritingPrompt("episode:2", INPUT,
      { concept: CONCEPT as never, outline: OUTLINE as never, episodes: [EPISODE(1) as never] });
    expect(prompt.user).toContain("第 1 集交接事实：第1集事实");
    expect(prompt.user).toContain("episodeNo 必须是 2");
  });
});

describe("title writing output validation", () => {
  it("accepts valid outputs and rejects wrong episode, missing episodes, empty and non-JSON answers", () => {
    expect(validateTitleWritingOutput("concept", JSON.stringify(CONCEPT)).ok).toBe(true);
    expect(validateTitleWritingOutput("outline", JSON.stringify(OUTLINE)).ok).toBe(true);
    expect(validateTitleWritingOutput("episode:1", JSON.stringify(EPISODE(1))).ok).toBe(true);
    expect(validateTitleWritingOutput("episode:1", JSON.stringify(EPISODE(2)))).toEqual({ ok: false, code: "episode_mismatch" });
    expect(validateTitleWritingOutput("outline", JSON.stringify({ ...OUTLINE, episodes: OUTLINE.episodes.slice(0, 2) }))).toEqual({ ok: false, code: "invalid_output" });
    expect(validateTitleWritingOutput("outline", JSON.stringify({ ...OUTLINE, episodes: [OUTLINE.episodes[1], OUTLINE.episodes[0], OUTLINE.episodes[2]] })).ok).toBe(false);
    expect(validateTitleWritingOutput("concept", "")).toEqual({ ok: false, code: "invalid_output" });
    expect(validateTitleWritingOutput("concept", "```json\n{}\n```")).toEqual({ ok: false, code: "invalid_output" });
    expect(validateTitleWritingOutput("concept", JSON.stringify({ ...CONCEPT, logline: "见 https://x.example" }))).toEqual({ ok: false, code: "unsafe_content" });
    expect(validateTitleWritingOutput("concept", JSON.stringify({ ...CONCEPT, characters: [CONCEPT.characters[0], CONCEPT.characters[0]] })).ok).toBe(false);
  });

  it("formats the saved story text with title, characters and the outline", () => {
    const text = formatTitleStory("夜班证词", CONCEPT as never, OUTLINE as never);
    expect(text).toContain("剧名：夜班证词");
    expect(text).toContain("林夏（主角）：倔强");
    expect(text).toContain("第 3 集 集3");
  });
});
