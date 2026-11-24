import { z } from "zod";

export const creatorSkillIdSchema = z.enum(["short-drama-write", "short-drama-storyboard", "qc-skill"]);
export type CreatorSkillId = z.infer<typeof creatorSkillIdSchema>;
export const creatorAgentStageSchema = z.enum(["script", "storyboard", "export"]);
export type CreatorAgentStage = z.infer<typeof creatorAgentStageSchema>;

export const creatorAgentResolveRequestSchema = z.object({
  stage: creatorAgentStageSchema,
  episodeNo: z.number().int().positive().optional(),
  command: z.string().trim().min(1).max(1000),
  skill: creatorSkillIdSchema.optional(),
}).strict();

export const creatorAgentResolveResponseSchema = z.object({
  skill: creatorSkillIdSchema.nullable(),
  instruction: z.string().max(1000),
}).strict();
