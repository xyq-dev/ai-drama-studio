import { z } from "zod";
import type { SpeechGenerationInput, SpeechQuote } from "./speech";

export const SPEECH_BATCH_SCHEMA = "voice.episode.batch.v1";
export const SPEECH_BATCH_STORAGE_VERSION = "ads.speech.batch.storage.v1";
export const SPEECH_BATCH_MAX_OPERATIONS = 100;
export const SPEECH_BATCH_MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const SPEECH_BATCH_MAX_CONFIRM_BYTES = 128 * 1024;
export const SPEECH_BATCH_MAX_INVENTORY_LINES = 3000;
const id = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const amount = z.string().regex(/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,8})?$/);
export type SpeechBatchLineStatus = "selected" | "awaiting_selection" | "in_progress" | "uncertain" | "missing";
export interface SpeechBatchLine {
  shotRevisionId: string; planRevisionId: string; lineId: string; lineInputRevisionId: string;
  displayText: string; voiceName: string; status: SpeechBatchLineStatus; jobIds: string[];
}
export interface SpeechBatchBlocker { shotRevisionId: string | null; code: string; message: string }
export interface SpeechBatchInventory {
  projectId: string; episodeId: string; sourceHash: string; operationLimit: number;
  lines: SpeechBatchLine[]; blockers: SpeechBatchBlocker[];
}
export const speechBatchPreflightSchema = z.object({ sourceHash: hash,
  lineInputRevisionIds: z.array(id).min(1).max(SPEECH_BATCH_MAX_OPERATIONS),
}).strict().refine((v) => new Set(v.lineInputRevisionIds).size === v.lineInputRevisionIds.length);
export type SpeechBatchPreflightRequest = z.infer<typeof speechBatchPreflightSchema>;
export interface SpeechBatchBudget { currency: "CNY" | "USD"; estimatedAmount: string | null; maximumAmount: string }
export interface SpeechBatchFrozenOperation { id: string; input: SpeechGenerationInput; quote: SpeechQuote; idempotencyKey: string }
export interface SpeechBatchFrozen {
  schema: typeof SPEECH_BATCH_SCHEMA; projectId: string; episodeId: string; sourceHash: string;
  operations: SpeechBatchFrozenOperation[]; budgets: SpeechBatchBudget[]; expiresAt: string;
}
export const speechBatchConfirmSchema = z.object({ frozenHash: hash,
  maximumJobs: z.number().int().min(1).max(SPEECH_BATCH_MAX_OPERATIONS),
  budgets: z.array(z.object({ currency: z.enum(["CNY", "USD"]), maximumAmount: amount }).strict()).min(1).max(2),
  confirmPossibleCharges: z.literal(true), confirmedUncertainJobIds: z.array(id).max(2000).default([]),
}).strict();
export type SpeechBatchConfirmation = z.infer<typeof speechBatchConfirmSchema>;
export interface SpeechBatchOperationView {
  id: string; lineId: string; lineInputRevisionId: string; displayText: string; shotRevisionId: string;
  state: "pending" | "working" | "job_created" | "unknown" | "blocked" | "canceled";
  quote: SpeechQuote; maximumAmount: string; authorizationId: string | null;
  jobId: string | null; workflowRunId: string | null; jobState: string | null; errorCode: string | null;
}
export interface SpeechBatchView {
  id: string; projectId: string; episodeId: string; frozenHash: string; frozen: SpeechBatchFrozen;
  state: "quoted" | "dispatching" | "needs_attention" | "dispatched" | "canceled";
  confirmation: SpeechBatchConfirmation | null; cancelRequested: boolean; createdAt: string;
  operations: SpeechBatchOperationView[];
}
export interface SpeechBatchDispatchRef { batchId: string; operationId: string; dispatchToken: string }
export interface SpeechBatchClaim { ref: SpeechBatchDispatchRef; operation: SpeechBatchFrozenOperation; authorizationId: string | null }
