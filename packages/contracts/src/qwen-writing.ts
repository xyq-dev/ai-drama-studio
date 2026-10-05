import { z } from "zod";
import { WRITING_BODY_MAX_CHARS, WRITING_NOTE_MAX_CHARS } from "./writing-assistant";

/** Local generator input. This is not a saved project revision. */
export const QWEN_WRITING_INPUT_SCHEMA = "qwen.writing.input.v1" as const;
export const QWEN_WRITING_RECEIPT_SCHEMA = "qwen.writing.receipt.v1" as const;

/** Large enough for a legal long story plus the other bounded notes. */
export const QWEN_WRITING_INPUT_MAX_BYTES = 256_000;

const note = z.string().max(WRITING_NOTE_MAX_CHARS).refine((value) => !value.includes("\u0000"), "文本含有空字符");
const body = z.string().max(WRITING_BODY_MAX_CHARS).refine((value) => !value.includes("\u0000"), "文本含有空字符");
const episodeNo = z.union([z.literal(1), z.literal(2), z.literal(3)]);

const storyInputSchema = z.object({
  schema: z.literal(QWEN_WRITING_INPUT_SCHEMA),
  mode: z.literal("story"),
  premise: note,
  genre: note,
  audience: note,
  characters: note,
  mustKeep: note,
  mustNotChange: note,
  currentText: body,
}).strict();

const episodeInputSchema = z.object({
  schema: z.literal(QWEN_WRITING_INPUT_SCHEMA),
  mode: z.literal("episode"),
  episodeNo,
  premise: note,
  genre: note,
  audience: note,
  characters: note,
  confirmedStory: body,
  currentText: body,
  revisionRequest: note,
  mustKeep: note,
  mustKeepDialogue: note,
  mustKeepEnding: note,
}).strict();

export const qwenWritingInputSchema = z.discriminatedUnion("mode", [storyInputSchema, episodeInputSchema]);
export type QwenWritingInput = z.infer<typeof qwenWritingInputSchema>;

export const qwenWritingReceiptSchema = z.object({
  schema: z.literal(QWEN_WRITING_RECEIPT_SCHEMA),
  runId: z.string().uuid(),
  createdAt: z.string().datetime(),
  mode: z.enum(["story", "episode"]),
  candidateSchema: z.enum(["ads.writing.story-plan.v1", "ads.writing.episode-draft.v1"]),
  promptVersion: z.literal("ads.writing.prompt.v1"),
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
  candidateAccepted: z.boolean(),
  candidateFile: z.enum(["written", "not_written", "failed"]),
  errorCode: z.string().min(1).max(64).nullable(),
  providerResult: z.enum(["completed", "unknown"]),
  billing: z.object({
    amount: z.null(),
    currency: z.null(),
    status: z.literal("unknown"),
  }).strict(),
  idempotencyNote: z.literal("local_run_id_is_not_a_provider_guarantee"),
}).strict();
export type QwenWritingReceipt = z.infer<typeof qwenWritingReceiptSchema>;

export function parseQwenWritingInput(value: unknown) {
  const parsed = qwenWritingInputSchema.safeParse(value);
  return parsed.success ? { ok: true as const, data: parsed.data } : { ok: false as const, code: "invalid_input" as const };
}
