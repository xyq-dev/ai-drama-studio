import type {
  EpisodeDraftCandidate,
  EpisodeOutline,
  TitleConcept,
  TitleWritingCallState,
  TitleWritingFrozenInput,
  TitleWritingProviderKey,
  TitleWritingRunState,
  TitleWritingScriptSave,
  TitleWritingStepKey,
  TitleWritingStepState,
  TitleWritingStorySave,
  TitleWritingUsageView,
} from "./title-writing";

/** Storage contract of title writing runs, shared by the run engine (providers) and the PostgreSQL store (database). */
export interface TitleRunRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  actorId: string;
  idempotencyKey: string;
  inputHash: string;
  input: TitleWritingFrozenInput;
  state: TitleWritingRunState;
  errorCode: string | null;
  cancelRequestedAt: string | null;
  executorId: string | null;
  leaseUntil: string | null;
  callCap: number;
  callsUsed: number;
  storySave: TitleWritingStorySave;
  storyRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TitleStepRecord {
  runId: string;
  stepKey: TitleWritingStepKey;
  ordinal: number;
  state: TitleWritingStepState;
  attemptNo: number;
  errorCode: string | null;
  output: TitleConcept | EpisodeOutline | EpisodeDraftCandidate | null;
  outputHash: string | null;
  scriptSave: TitleWritingScriptSave | null;
  scriptRevisionId: string | null;
  updatedAt: string;
}

export interface TitleCallRecord {
  id: string;
  runId: string;
  workspaceId: string;
  stepKey: TitleWritingStepKey;
  attemptNo: number;
  providerKey: TitleWritingProviderKey;
  model: string;
  requestHash: string;
  state: TitleWritingCallState;
  executorId: string;
  providerRequestId: string | null;
  responseModel: string | null;
  usage: TitleWritingUsageView;
  errorCode: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface TitleRunBundle {
  run: TitleRunRecord;
  steps: TitleStepRecord[];
  calls: TitleCallRecord[];
}

export type TitleRunCreation =
  | { kind: "created" | "existing" | "conflict" | "active"; bundle: TitleRunBundle }
  | { kind: "blocked"; code: "TITLE_WRITING_ACTIVE_RUN_CAP" };

export type TitleCallReservation =
  | { kind: "reserved" }
  | { kind: "canceled" | "lost" }
  | { kind: "blocked"; code: "TITLE_WRITING_DAILY_CAP" | "TITLE_WRITING_RUN_CAP" };

export interface TitleCallFinish {
  state: "completed" | "rejected" | "unknown";
  errorCode: string | null;
  providerRequestId: string | null;
  responseModel: string | null;
  usage: TitleWritingUsageView;
  output: TitleStepRecord["output"];
  outputHash: string | null;
}

export type TitleResumePreparation =
  | { kind: "ok"; bundle: TitleRunBundle }
  | { kind: "not_resumable" | "needs_confirmation" | "active" | "active_cap" | "not_found" };

export type TitleScriptPlacement =
  | { kind: "ok"; bundle: TitleRunBundle }
  | { kind: "not_found" | "not_ready" | "story_not_approved" | "story_changed" };

/**
 * Persistence of title writing runs. Every method that changes a running run is conditional on the executor that
 * holds a live lease, so a late or fenced executor cannot overwrite recovery, cancellation or another executor.
 * Every method is scoped to one workspace: an executor, recovery pass or reader of workspace A never sees, claims,
 * fences, sends for or writes a run of workspace B.
 */
export interface TitleWritingStore {
  storageReady(): Promise<boolean>;
  /** Idempotency lookup, input comparison, active-run checks and insert of the run with its five steps: one atomic step. */
  createRun(run: TitleRunRecord, limits: { maxActiveRuns: number }): Promise<TitleRunCreation>;
  getRun(workspaceId: string, projectId: string, runId: string): Promise<TitleRunBundle | null>;
  /** Executor read: the run only when it belongs to this workspace. */
  getRunById(workspaceId: string, runId: string): Promise<TitleRunBundle | null>;
  latestRun(workspaceId: string, projectId: string): Promise<TitleRunBundle | null>;
  /** Takes a running run of this workspace whose lease is free or expired. */
  claimRun(workspaceId: string, runId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<boolean>;
  /** Checks workspace, ownership, cancellation, the run cap and the workspace daily cap, then inserts the call as reserved. */
  reserveCall(call: TitleCallRecord, limits: { sinceIso: string; maxCallsPerDay: number }, nowIso: string, leaseUntil: string): Promise<TitleCallReservation>;
  /** Persisted before any network send. */
  markCallSubmitted(workspaceId: string, callId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<boolean>;
  finishCall(workspaceId: string, callId: string, executorId: string, patch: TitleCallFinish, nowIso: string): Promise<boolean>;
  /** Creates a DRAFT story revision only when the project has no current story; records it on the run atomically. */
  saveStory(workspaceId: string, runId: string, executorId: string, storyText: string, actorId: string, nowIso: string): Promise<"saved" | "conflict" | "lost">;
  finishRun(workspaceId: string, runId: string, executorId: string, state: Exclude<TitleWritingRunState, "running">, errorCode: string | null, nowIso: string): Promise<boolean>;
  requestCancel(workspaceId: string, projectId: string, runId: string, nowIso: string): Promise<TitleRunBundle | null>;
  prepareResume(workspaceId: string, projectId: string, runId: string, options: { confirmUncertain: boolean; maxActiveRuns: number }, nowIso: string): Promise<TitleResumePreparation>;
  /** Fences expired executors of this workspace: reserved calls were never sent, submitted calls become unknown. */
  recoverExpired(workspaceId: string, nowIso: string): Promise<number>;
  listClaimable(workspaceId: string, nowIso: string, limit: number): Promise<string[]>;
  /** After the story was approved by a person: writes each saved screenplay into an episode that has no script yet. */
  placeScripts(workspaceId: string, projectId: string, runId: string, options: { acceptStoryChanged: boolean }, actorId: string, nowIso: string): Promise<TitleScriptPlacement>;
}
