import { z } from "zod";
import { DRAMA_TEXT_SKILL_VERSION } from "./writing-assistant";
import { creatorSkillIdSchema, type CreatorSkillId } from "./creator-skills";

export const CREATOR_SKILL_RELEASES = {
  "short-drama-write": { label: "短剧编剧", version: DRAMA_TEXT_SKILL_VERSION },
  "short-drama-storyboard": { label: "短剧分镜", version: DRAMA_TEXT_SKILL_VERSION },
  "qc-skill": { label: "成片质检", version: "1.4.5" },
} as const satisfies Record<CreatorSkillId, { label: string; version: string }>;

export const skillToggleSchema = z.object({
  expectedRevision: z.number().int().nonnegative().safe(),
  enabled: z.boolean(),
}).strict();

export const skillSettingsViewSchema = z.object({
  revision: z.number().int().nonnegative(),
  canManage: z.boolean(),
  canViewRuns: z.boolean(),
  skills: z.array(z.object({
    id: creatorSkillIdSchema,
    label: z.string(),
    version: z.string(),
    enabled: z.boolean(),
  }).strict()),
}).strict();

export const skillRunSchema = z.object({
  id: z.string().uuid(),
  skill: creatorSkillIdSchema,
  version: z.string().max(128),
  project: z.string().max(200),
  at: z.string().datetime(),
  status: z.enum(["running", "succeeded", "failed", "unknown", "issues"]),
  reasons: z.array(z.string().regex(/^[A-Za-z0-9_]{1,128}$/)).max(64),
}).strict();
export type SkillSettingsView = z.infer<typeof skillSettingsViewSchema>;
export type SkillRunView = z.infer<typeof skillRunSchema>;
