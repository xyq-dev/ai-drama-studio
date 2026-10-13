import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EPISODE_DRAFT_SCHEMA,
  EPISODE_OUTLINE_SCHEMA_V2,
  TITLE_CONCEPT_SCHEMA,
  TITLE_WRITING_INPUT_SCHEMA_V2,
  TITLE_WRITING_PROMPT_VERSION_V2,
  TITLE_WRITING_PROMPT_VERSION_V3,
  titleWritingJsonSchemas,
  type TitleWritingFrozenInput,
} from "@ai-drama/contracts";
import { buildTitleWritingPrompt, validateTitleWritingOutput } from "./title-writing";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const input = (promptVersion: typeof TITLE_WRITING_PROMPT_VERSION_V2 | typeof TITLE_WRITING_PROMPT_VERSION_V3, episodeCount = 3): TitleWritingFrozenInput => ({
  schema: TITLE_WRITING_INPUT_SCHEMA_V2, promptVersion, title: "夜班证词", settings: { episodeCount, episodeSeconds: 90, style: "" },
  providerKey: "qwen", model: "q-1" });
const concept = { schema: TITLE_CONCEPT_SCHEMA, genre: "g", logline: "l", synopsis: "s", protagonistGoal: "p", opposition: "o",
  coreConflict: "c", direction: "d", characters: [{ name: "甲", role: "r", profile: "p" }, { name: "乙", role: "r", profile: "p" }],
  relationships: [{ name: "甲与乙", pressure: "x" }] } as const;
const outline = (count: number) => ({ schema: EPISODE_OUTLINE_SCHEMA_V2, episodes: Array.from({ length: count }, (_, index) => ({
  episodeNo: index + 1, title: "t", entryState: "e", goal: "g", action: "a", turn: "t", result: "r", handoff: "h" })) });
const episode = (episodeNo: number) => ({ schema: EPISODE_DRAFT_SCHEMA, episodeNo, title: "t", screenplay: "s",
  scenes: [{ heading: "h", action: "a", dialogue: "", sound: "" }], handoffFacts: ["f"] });
const prompts = (frozen: TitleWritingFrozenInput) => [
  buildTitleWritingPrompt("concept", frozen, {}),
  buildTitleWritingPrompt("outline", frozen, { concept }),
  buildTitleWritingPrompt("episode:1", frozen, { concept, outline: outline(3), episodes: [] }),
  buildTitleWritingPrompt("episode:3", frozen, { concept, outline: outline(3), episodes: [episode(1), episode(2)] as never[] }),
];

describe("stored v2 runs keep their exact prompts", () => {
  // Computed from origin/main 70abefb9c0da055c75b216164483aebcbeb34e0d before prompt v3 existed: a stored run frozen
  // with ads.title-writing.prompt.v2 that is resumed after this change sends byte-identical prompts.
  it("builds the v2 prompts byte for byte as before", () => {
    expect(sha(JSON.stringify(prompts(input(TITLE_WRITING_PROMPT_VERSION_V2))))).toBe("6198cd81c3b0e19cbcc00b690baa02a354a3f9708364a108806f817b3756b44c");
    for (const prompt of prompts(input(TITLE_WRITING_PROMPT_VERSION_V2))) expect(prompt.user).not.toContain(TITLE_WRITING_PROMPT_VERSION_V3);
  });
});

describe("prompt v3 adds the writing requirements inside the existing structure", () => {
  it("names the version and asks each step for its answers in existing fields", () => {
    const [conceptPrompt, outlinePrompt, firstEpisode, lastEpisode] = prompts(input(TITLE_WRITING_PROMPT_VERSION_V3)).map((prompt) => prompt.user);
    for (const text of [conceptPrompt, outlinePrompt, firstEpisode, lastEpisode]) expect(text).toContain(TITLE_WRITING_PROMPT_VERSION_V3);
    expect(conceptPrompt).toContain("整部期待");
    for (const field of ["entryState：", "goal：", "action：", "turn：", "result：", "handoff："]) expect(outlinePrompt).toContain(field);
    expect(outlinePrompt).toContain("不新增字段");
    expect(firstEpisode).toContain("不凭空新增解围人物或决定性证据");
    expect(lastEpisode).toContain("不改变人物身份、关系和大纲中的结局走向");
    // There is no step where a person confirms the outline: the prompt names the outline this run saved, nothing more.
    expect(firstEpisode).toContain("本集按本次创作保存的分集大纲执行");
    for (const text of [conceptPrompt, outlinePrompt, firstEpisode, lastEpisode]) expect(text).not.toMatch(/已确认|确认的(计划|大纲)/);
  });

  it("keeps every v2 line in the same order: v3 only inserts lines", () => {
    const v2 = prompts(input(TITLE_WRITING_PROMPT_VERSION_V2));
    const v3 = prompts(input(TITLE_WRITING_PROMPT_VERSION_V3));
    v2.forEach((prompt, index) => {
      const guided = v3[index]!;
      expect(guided.system).toBe(prompt.system);
      expect(guided.schemaKind).toBe(prompt.schemaKind);
      const lines = guided.user.split("\n");
      const kept = lines.filter((line) => prompt.user.split("\n").includes(line));
      expect(kept.join("\n")).toBe(prompt.user);
    });
  });

  it("expects the same output structure and provider schemas as prompt v2", () => {
    expect(titleWritingJsonSchemas(input(TITLE_WRITING_PROMPT_VERSION_V3))).toEqual(titleWritingJsonSchemas(input(TITLE_WRITING_PROMPT_VERSION_V2)));
    const v3 = input(TITLE_WRITING_PROMPT_VERSION_V3);
    expect(validateTitleWritingOutput("concept", JSON.stringify(concept), v3).ok).toBe(true);
    expect(validateTitleWritingOutput("outline", JSON.stringify(outline(3)), v3).ok).toBe(true);
    expect(validateTitleWritingOutput("episode:2", JSON.stringify(episode(2)), v3).ok).toBe(true);
    expect(validateTitleWritingOutput("outline", JSON.stringify({ ...outline(3), extra: "x" }), v3).ok).toBe(false);
  });
});
