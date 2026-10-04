import { z } from "zod";

/** Adapted candidate for an external writing pass. Not an upstream drama-skills file. */
export const STORY_PLAN_SCHEMA = "ads.writing.story-plan.v1";
/** Adapted candidate for one episode. Not an upstream Markdown screenplay. */
export const EPISODE_DRAFT_SCHEMA = "ads.writing.episode-draft.v1";
export const WRITING_PROMPT_VERSION = "ads.writing.prompt.v1";

/** UTF-8 JSON import cap. Stays under the API JSON body limit after wrapping as content.text. */
export const WRITING_IMPORT_MAX_BYTES = 48_000;
/** Saved editor text cap. Over-long candidates are rejected, never truncated. */
export const WRITING_BODY_MAX_CHARS = 20_000;
export const WRITING_NOTE_MAX_CHARS = 1_000;

const episodeNoSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

function text(min: number, max: number) {
  return z.string().min(min).max(max).refine((value) => !value.includes("\u0000"), "文本含有空字符");
}

const relationshipSchema = z.object({
  name: text(1, 40),
  pressure: text(1, 200),
}).strict();

const storyEpisodeSchema = z.object({
  episodeNo: episodeNoSchema,
  entryState: text(1, 400),
  goal: text(1, 400),
  action: text(1, 400),
  turn: text(1, 400),
  result: text(1, 400),
  handoff: text(1, 400),
}).strict();

export const storyPlanCandidateSchema = z.object({
  schema: z.literal(STORY_PLAN_SCHEMA),
  logline: text(1, 300),
  protagonistGoal: text(1, 300),
  opposition: text(1, 300),
  coreConflict: text(1, 400),
  relationships: z.array(relationshipSchema).min(1).max(6),
  episodes: z.array(storyEpisodeSchema).length(3),
}).strict().superRefine((value, context) => {
  const numbers = new Set(value.episodes.map((episode) => episode.episodeNo));
  if (numbers.size !== 3 || ![1, 2, 3].every((episodeNo) => numbers.has(episodeNo as 1 | 2 | 3))) {
    context.addIssue({ code: "custom", message: "三集编号必须是 1、2、3 且不重复" });
  }
});
export type StoryPlanCandidate = z.infer<typeof storyPlanCandidateSchema>;

const sceneSchema = z.object({
  heading: text(1, 80),
  action: text(1, 400),
  dialogue: text(0, 400),
  sound: text(0, 120),
}).strict();

export const episodeDraftCandidateSchema = z.object({
  schema: z.literal(EPISODE_DRAFT_SCHEMA),
  episodeNo: episodeNoSchema,
  title: text(1, 80),
  screenplay: text(1, 12_000),
  scenes: z.array(sceneSchema).min(1).max(12),
  handoffFacts: z.array(text(1, 200)).min(1).max(8),
}).strict();
export type EpisodeDraftCandidate = z.infer<typeof episodeDraftCandidateSchema>;

export const writingCandidateSchema = z.discriminatedUnion("schema", [
  storyPlanCandidateSchema,
  episodeDraftCandidateSchema,
]);
export type WritingCandidate = z.infer<typeof writingCandidateSchema>;
