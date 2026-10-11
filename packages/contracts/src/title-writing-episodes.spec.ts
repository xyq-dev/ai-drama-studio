import { describe, expect, it } from "vitest";
import {
  TITLE_WRITING_INPUT_SCHEMA,
  TITLE_WRITING_INPUT_SCHEMA_V2,
  TITLE_WRITING_JSON_SCHEMAS,
  TITLE_WRITING_MAX_CONFIRMED_CALLS,
  TITLE_WRITING_PROMPT_VERSION,
  TITLE_WRITING_PROMPT_VERSION_V2,
  TITLE_WRITING_STEP_KEYS,
  episodeOutlineV2Schema,
  titleWritingCallCap,
  titleWritingCallCapFor,
  titleWritingEpisodeCount,
  titleWritingJsonSchemas,
  titleWritingRequiredCalls,
  titleWritingResumeSchema,
  titleWritingSettingsSchema,
  titleWritingStartSchema,
  titleWritingStepKeysFor,
  type TitleWritingFrozenInput,
} from "./title-writing";
import { episodeDraftCandidateSchema } from "./writing-assistant";

const v1 = (episodeSeconds = 90): TitleWritingFrozenInput => ({ schema: TITLE_WRITING_INPUT_SCHEMA, promptVersion: TITLE_WRITING_PROMPT_VERSION,
  title: "t", settings: { episodeCount: 3, episodeSeconds, style: "" }, providerKey: "qwen", model: "q" });
const v2 = (episodeCount: number): TitleWritingFrozenInput => ({ schema: TITLE_WRITING_INPUT_SCHEMA_V2, promptVersion: TITLE_WRITING_PROMPT_VERSION_V2,
  title: "t", settings: { episodeCount, episodeSeconds: 90, style: "" }, providerKey: "qwen", model: "q" });

describe("run shape by version", () => {
  it("a v1 run has its original five steps and cap 8, whatever seconds it stored", () => {
    for (const seconds of [30, 120, 180]) {
      expect(titleWritingStepKeysFor(v1(seconds))).toEqual([...TITLE_WRITING_STEP_KEYS]);
      expect(titleWritingCallCapFor(v1(seconds))).toBe(8);
      expect(titleWritingEpisodeCount(v1(seconds))).toBe(3);
    }
    expect(titleWritingJsonSchemas(v1())).toBe(TITLE_WRITING_JSON_SCHEMAS);
  });

  it.each([1, 3, 6])("a v2 run of N=%i has N+2 steps, needs N+2 calls and is capped at N+5", (count) => {
    expect(titleWritingStepKeysFor(v2(count))).toEqual(["concept", "outline", ...Array.from({ length: count }, (_, index) => `episode:${String(index + 1)}`)]);
    expect(titleWritingRequiredCalls(count)).toBe(count + 2);
    expect(titleWritingCallCap(count)).toBe(count + 5);
    expect(titleWritingCallCapFor(v2(count))).toBe(count + 5);
    const schemas = titleWritingJsonSchemas(v2(count));
    const episodes = (schemas.outline.schema.properties as { episodes: { minItems: number; maxItems: number; items: { properties: { episodeNo: { enum: number[] } } } } }).episodes;
    expect([episodes.minItems, episodes.maxItems]).toEqual([count, count]);
    expect(episodes.items.properties.episodeNo.enum).toEqual(Array.from({ length: count }, (_, index) => index + 1));
    expect((schemas.episode.schema.properties as { episodeNo: { enum: number[] } }).episodeNo.enum).toHaveLength(count);
    // The shared v1 constant is never changed by building a v2 schema.
    expect((TITLE_WRITING_JSON_SCHEMAS.episode.schema.properties as { episodeNo: { enum: number[] } }).episodeNo.enum).toEqual([1, 2, 3]);
  });

  it("the v2 outline schema needs exactly N items numbered 1..N", () => {
    const item = (episodeNo: number) => ({ episodeNo, title: "t", entryState: "e", goal: "g", action: "a", turn: "t", result: "r", handoff: "h" });
    const outline = (numbers: number[]) => ({ schema: "ads.writing.episode-outline.v2", episodes: numbers.map(item) });
    expect(episodeOutlineV2Schema(2).safeParse(outline([1, 2])).success).toBe(true);
    expect(episodeOutlineV2Schema(2).safeParse(outline([1])).success).toBe(false);
    expect(episodeOutlineV2Schema(2).safeParse(outline([2, 1])).success).toBe(false);
    expect(episodeOutlineV2Schema(2).safeParse(outline([1, 3])).success).toBe(false);
  });
});

describe("request bodies", () => {
  it("the start body accepts episode counts 1–6 only, and the v1 settings stay three episodes and 30–180 seconds", () => {
    for (const episodeCount of [1, 6]) expect(titleWritingStartSchema.safeParse({ title: "t", settings: { episodeCount } }).success).toBe(true);
    for (const episodeCount of [0, 7, 2.5]) expect(titleWritingStartSchema.safeParse({ title: "t", settings: { episodeCount } }).success).toBe(false);
    expect(titleWritingStartSchema.safeParse({ title: "t", settings: { episodeSeconds: 181 } }).success).toBe(false);
    expect(titleWritingSettingsSchema.safeParse({ episodeCount: 4 }).success).toBe(false);
    expect(titleWritingSettingsSchema.parse({ episodeSeconds: 180 })).toEqual({ episodeCount: 3, episodeSeconds: 180, style: "" });
  });

  it("a resume may confirm one uncertain call per step of a six-episode run, and no more", () => {
    const ids = (count: number) => Array.from({ length: count }, (_, index) => `00000000-0000-4000-8000-00000000000${String(index)}`);
    expect(TITLE_WRITING_MAX_CONFIRMED_CALLS).toBe(8);
    expect(titleWritingResumeSchema.safeParse({ confirmUncertainCallIds: ids(8) }).success).toBe(true);
    expect(titleWritingResumeSchema.safeParse({ confirmUncertainCallIds: [...ids(8), "00000000-0000-4000-8000-000000000099"] }).success).toBe(false);
  });

  it("an episode draft may be any episode 1–6", () => {
    const draft = (episodeNo: number) => ({ schema: "ads.writing.episode-draft.v1", episodeNo, title: "t", screenplay: "s",
      scenes: [{ heading: "h", action: "a", dialogue: "", sound: "" }], handoffFacts: ["f"] });
    expect(episodeDraftCandidateSchema.safeParse(draft(6)).success).toBe(true);
    expect(episodeDraftCandidateSchema.safeParse(draft(7)).success).toBe(false);
    expect(episodeDraftCandidateSchema.safeParse(draft(0)).success).toBe(false);
  });
});
