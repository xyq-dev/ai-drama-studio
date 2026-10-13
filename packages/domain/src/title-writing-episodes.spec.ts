import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EPISODE_DRAFT_SCHEMA,
  EPISODE_OUTLINE_SCHEMA,
  EPISODE_OUTLINE_SCHEMA_V2,
  TITLE_CONCEPT_SCHEMA,
  TITLE_WRITING_INPUT_SCHEMA,
  TITLE_WRITING_INPUT_SCHEMA_V2,
  TITLE_WRITING_JSON_SCHEMAS,
  TITLE_WRITING_PROMPT_VERSION,
  TITLE_WRITING_PROMPT_VERSION_V2,
  type TitleWritingFrozenInput,
} from "@ai-drama/contracts";
import { DomainError } from "./errors";
import { assertProductionEpisodeSet, productionEpisodeNumbers } from "./text-chain";
import { buildTitleWritingPrompt, episodeNoOf, validateTitleWritingOutput } from "./title-writing";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const V1: TitleWritingFrozenInput = { schema: TITLE_WRITING_INPUT_SCHEMA, promptVersion: TITLE_WRITING_PROMPT_VERSION, title: "夜班证词",
  settings: { episodeCount: 3, episodeSeconds: 180, style: "悬疑" }, providerKey: "qwen", model: "q-1" };
const v2 = (episodeCount: number, episodeSeconds = 90): TitleWritingFrozenInput => ({ schema: TITLE_WRITING_INPUT_SCHEMA_V2,
  promptVersion: TITLE_WRITING_PROMPT_VERSION_V2, title: "夜班证词", settings: { episodeCount, episodeSeconds, style: "" }, providerKey: "qwen", model: "q-1" });
const concept = { schema: TITLE_CONCEPT_SCHEMA, genre: "g", logline: "l", synopsis: "s", protagonistGoal: "p", opposition: "o",
  coreConflict: "c", direction: "d", characters: [{ name: "甲", role: "r", profile: "p" }, { name: "乙", role: "r", profile: "p" }],
  relationships: [{ name: "甲与乙", pressure: "x" }] } as const;
const outlineItem = (episodeNo: number) => ({ episodeNo, title: "t", entryState: "e", goal: "g", action: "a", turn: "t", result: "r", handoff: "h" });
const outlineV1 = { schema: EPISODE_OUTLINE_SCHEMA, episodes: [1, 2, 3].map(outlineItem) };
const outlineV2 = (count: number) => ({ schema: EPISODE_OUTLINE_SCHEMA_V2, episodes: Array.from({ length: count }, (_, index) => outlineItem(index + 1)) });
const episode = (episodeNo: number) => ({ schema: EPISODE_DRAFT_SCHEMA, episodeNo, title: "t", screenplay: "s",
  scenes: [{ heading: "h", action: "a", dialogue: "", sound: "" }], handoffFacts: ["f"] });
const drafts = (count: number) => Array.from({ length: count }, (_, index) => episode(index + 1)) as never[];

describe("v1 runs keep their exact prompts and provider schemas", () => {
  // Computed from the build of origin/main 722224891ae8d7e3cc9df1de9653170401de2573 with the same inputs: a stored v1
  // run that is resumed after this change sends byte-identical prompts and schemas.
  it("builds the v1 prompts byte for byte as before", () => {
    const prompts = [
      buildTitleWritingPrompt("concept", V1, {}),
      buildTitleWritingPrompt("outline", V1, { concept }),
      buildTitleWritingPrompt("episode:1", V1, { concept, outline: outlineV1, episodes: [] }),
      buildTitleWritingPrompt("episode:3", V1, { concept, outline: outlineV1, episodes: drafts(2) }),
    ];
    expect(sha(JSON.stringify(prompts))).toBe("f9d60262754fe9efe7a220ba720472f190c1ea545e172f9ebf7242df41fdd509");
    expect(sha(JSON.stringify(TITLE_WRITING_JSON_SCHEMAS))).toBe("e7d7a242b2e32a5dc5802185bcc9974bb12ae725f86cb707930a082b74e18b1c");
  });

  it("never builds or accepts a fourth episode for a v1 run", () => {
    expect(() => buildTitleWritingPrompt("episode:4", V1, { concept, outline: outlineV1, episodes: drafts(3) })).toThrow(DomainError);
    expect(validateTitleWritingOutput("episode:4", JSON.stringify(episode(4)), V1)).toEqual({ ok: false, code: "invalid_output" });
    // An answer claiming episode 4 for a v1 step keeps the v1 code: it never passed the v1 schema.
    expect(validateTitleWritingOutput("episode:2", JSON.stringify(episode(4)), V1)).toEqual({ ok: false, code: "invalid_output" });
    expect(validateTitleWritingOutput("episode:2", JSON.stringify(episode(3)), V1)).toEqual({ ok: false, code: "episode_mismatch" });
    expect(validateTitleWritingOutput("outline", JSON.stringify(outlineV2(3)), V1)).toEqual({ ok: false, code: "invalid_output" });
    expect(validateTitleWritingOutput("outline", JSON.stringify(outlineV1), V1).ok).toBe(true);
    // Without an input (older callers) the v1 rules apply.
    expect(validateTitleWritingOutput("outline", JSON.stringify(outlineV1)).ok).toBe(true);
  });
});

describe("v2 prompts and checks follow the run's N", () => {
  it("reads episode numbers 1 to 6 from step keys", () => {
    expect(["concept", "outline", "episode:1", "episode:4", "episode:6"].map((key) => episodeNoOf(key as never))).toEqual([null, null, 1, 4, 6]);
  });

  it.each([1, 3, 6])("N=%i: the prompts ask for exactly N episodes and name the target as a writing target", (count) => {
    const input = v2(count, 60);
    const outlinePrompt = buildTitleWritingPrompt("outline", input, { concept }).user;
    expect(outlinePrompt).toContain(`episodes 正好 ${String(count)} 项`);
    expect(outlinePrompt).toContain(EPISODE_OUTLINE_SCHEMA_V2);
    expect(outlinePrompt).toContain("每集目标时长：约 1 分钟（60 秒）");
    expect(buildTitleWritingPrompt("concept", input, {}).user).toContain(`故事能在 ${String(count)} 集内讲完`);
    const last = buildTitleWritingPrompt(`episode:${String(count)}` as never, input, { concept, outline: outlineV2(count), episodes: drafts(count - 1) }).user;
    expect(last).toContain(`（共 ${String(count)} 集）`);
    expect(last).toContain(count === 1 ? "唯一的一集" : "这是最后一集");
  });

  it("refuses an episode step beyond N and a context outline of another length", () => {
    expect(() => buildTitleWritingPrompt("episode:5", v2(4), { concept, outline: outlineV2(4), episodes: drafts(4) })).toThrow(DomainError);
    expect(() => buildTitleWritingPrompt("episode:1", v2(4), { concept, outline: outlineV2(3), episodes: [] })).toThrow(DomainError);
  });

  it.each([
    ["exactly N", outlineV2(4), true],
    ["one missing", outlineV2(3), false],
    ["one extra", outlineV2(5), false],
    ["repeated", { ...outlineV2(4), episodes: [1, 2, 2, 4].map(outlineItem) }, false],
    ["out of order", { ...outlineV2(4), episodes: [2, 1, 3, 4].map(outlineItem) }, false],
    ["the v1 schema value", { ...outlineV2(4), schema: EPISODE_OUTLINE_SCHEMA }, false],
  ])("a v2 outline of N=4 with %s episodes is accepted only when exact", (_label, outline, ok) => {
    expect(validateTitleWritingOutput("outline", JSON.stringify(outline), v2(4)).ok).toBe(ok);
  });

  it("an episode answer must carry its own number within 1..N", () => {
    expect(validateTitleWritingOutput("episode:5", JSON.stringify(episode(5)), v2(6)).ok).toBe(true);
    expect(validateTitleWritingOutput("episode:5", JSON.stringify(episode(6)), v2(6))).toEqual({ ok: false, code: "episode_mismatch" });
    expect(validateTitleWritingOutput("episode:5", JSON.stringify(episode(5)), v2(4))).toEqual({ ok: false, code: "invalid_output" });
    expect(validateTitleWritingOutput("episode:1", "不是 JSON", v2(2))).toEqual({ ok: false, code: "invalid_output" });
  });
});

describe("episode sets", () => {
  it.each([1, 3, 6])("N=%i requires exactly episodes 1..N", (count) => {
    expect(productionEpisodeNumbers(count)).toEqual(Array.from({ length: count }, (_, index) => index + 1));
    expect(() => assertProductionEpisodeSet(productionEpisodeNumbers(count), count)).not.toThrow();
    expect(() => assertProductionEpisodeSet([...productionEpisodeNumbers(count), count + 1], count)).toThrow(DomainError);
    expect(() => assertProductionEpisodeSet(productionEpisodeNumbers(count).slice(1), count)).toThrow(DomainError);
  });

  it("refuses duplicates, counts outside 1–6, and keeps the three-episode default", () => {
    expect(() => assertProductionEpisodeSet([1, 2, 2, 3], 3)).toThrow(DomainError);
    expect(() => assertProductionEpisodeSet([1, 2, 3])).not.toThrow();
    expect(() => assertProductionEpisodeSet([1, 2, 3, 4])).toThrow(DomainError);
    expect(() => productionEpisodeNumbers(0)).toThrow(DomainError);
    expect(() => productionEpisodeNumbers(7)).toThrow(DomainError);
  });
});
