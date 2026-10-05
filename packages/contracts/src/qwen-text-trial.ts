import { z } from "zod";

/** Independent from the M2 text adapter. This draft is not a business asset. */
export const QWEN_TEXT_TRIAL_INPUT_SCHEMA = "qwen.text.trial.input.v1" as const;
export const QWEN_TEXT_TRIAL_DRAFT_SCHEMA = "qwen.text.trial.draft.v1" as const;
export const QWEN_TEXT_TRIAL_RECEIPT_SCHEMA = "qwen.text.trial.receipt.v1" as const;

export const QWEN_TEXT_TRIAL_LIMITS = {
  inputFileMaxBytes: 16_384,
  ideaMax: 4_000,
  toneMax: 200,
  durationMin: 60,
  durationMax: 90,
  durationDefault: 60,
  titleMax: 40,
  loglineMax: 160,
  characterNameMax: 20,
  characterSummaryMax: 80,
  charactersMin: 1,
  charactersMax: 4,
  sceneTitleMax: 40,
  actionMax: 300,
  scenesMin: 1,
  scenesMax: 4,
  dialogueLineMax: 80,
  dialogueMaxPerScene: 4,
} as const;

const limits = QWEN_TEXT_TRIAL_LIMITS;

function trimmedText(max: number) {
  return z.preprocess(
    (value) => (typeof value === "string" ? value.trim() : value),
    z.string().min(1).max(max),
  );
}

export const qwenTextTrialInputSchema = z.object({
  schema: z.literal(QWEN_TEXT_TRIAL_INPUT_SCHEMA),
  idea: trimmedText(limits.ideaMax),
  tone: trimmedText(limits.toneMax).optional(),
  targetDurationSeconds: z.number().int().min(limits.durationMin).max(limits.durationMax).default(limits.durationDefault),
}).strict();
export type QwenTextTrialInput = z.infer<typeof qwenTextTrialInputSchema>;

const characterSchema = z.object({
  name: trimmedText(limits.characterNameMax),
  summary: trimmedText(limits.characterSummaryMax),
}).strict();

const dialogueSchema = z.object({
  character: trimmedText(limits.characterNameMax),
  line: trimmedText(limits.dialogueLineMax),
}).strict();

const sceneSchema = z.object({
  ordinal: z.number().int().min(1).max(limits.scenesMax),
  title: trimmedText(limits.sceneTitleMax),
  action: trimmedText(limits.actionMax),
  dialogue: z.array(dialogueSchema).max(limits.dialogueMaxPerScene),
}).strict();

export const qwenTextTrialDraftSchema = z.object({
  schema: z.literal(QWEN_TEXT_TRIAL_DRAFT_SCHEMA),
  title: trimmedText(limits.titleMax),
  logline: trimmedText(limits.loglineMax),
  characters: z.array(characterSchema).min(limits.charactersMin).max(limits.charactersMax),
  scenes: z.array(sceneSchema).min(limits.scenesMin).max(limits.scenesMax),
}).strict().superRefine((draft, ctx) => {
  const names = draft.characters.map((character) => character.name);
  if (new Set(names).size !== names.length) {
    ctx.addIssue({ code: "custom", message: "character names must be unique", path: ["characters"] });
  }
  draft.scenes.forEach((scene, sceneIndex) => {
    if (scene.ordinal !== sceneIndex + 1) {
      ctx.addIssue({
        code: "custom",
        message: "scene ordinals must be contiguous starting at 1",
        path: ["scenes", sceneIndex, "ordinal"],
      });
    }
    scene.dialogue.forEach((line, lineIndex) => {
      if (!names.includes(line.character)) {
        ctx.addIssue({
          code: "custom",
          message: "dialogue character must match the character list",
          path: ["scenes", sceneIndex, "dialogue", lineIndex, "character"],
        });
      }
    });
  });
});
export type QwenTextTrialDraft = z.infer<typeof qwenTextTrialDraftSchema>;

export const qwenTextTrialReceiptSchema = z.object({
  schema: z.literal(QWEN_TEXT_TRIAL_RECEIPT_SCHEMA),
  runId: z.string().uuid(),
  createdAt: z.string().datetime(),
  requestContentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  requestedModel: z.string().min(1).max(128),
  responseModel: z.string().min(1).max(128).nullable(),
  serverRequestId: z.string().min(1).max(128).nullable(),
  usage: z.object({
    status: z.enum(["present", "unknown"]),
    promptTokens: z.number().int().nonnegative().nullable(),
    completionTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
  }).strict(),
  draftAccepted: z.boolean(),
  draftFile: z.enum(["written", "not_written", "failed"]),
  errorCode: z.string().min(1).max(64).nullable(),
  providerResult: z.enum(["completed", "unknown"]),
  billing: z.object({
    amount: z.null(),
    currency: z.null(),
    status: z.literal("unknown"),
  }).strict(),
  durationNote: z.literal("writing_target_only"),
  reviewNote: z.literal("candidate_draft_pending_human_review"),
}).strict();
export type QwenTextTrialReceipt = z.infer<typeof qwenTextTrialReceiptSchema>;

export function parseQwenTextTrialInput(value: unknown) {
  const parsed = qwenTextTrialInputSchema.safeParse(value);
  return parsed.success ? { ok: true as const, data: parsed.data } : { ok: false as const, code: "invalid_input" as const };
}

export function parseQwenTextTrialDraft(value: unknown) {
  const parsed = qwenTextTrialDraftSchema.safeParse(value);
  return parsed.success ? { ok: true as const, data: parsed.data } : { ok: false as const, code: "invalid_draft" as const };
}
