import type {
  EpisodeDraftCandidate,
  EpisodeOutline,
  TitleConcept,
  TitleWritingCallState,
  TitleWritingFrozenInput,
  TitleWritingProviderKey,
  TitleWritingStoredProviderKey,
  TitleWritingRunState,
  TitleWritingScriptSave,
  TitleWritingStepKey,
  TitleWritingStepState,
  TitleWritingStorySave,
  TitleWritingUsageView,
} from "./title-writing";
import type {
  ScriptBreakdownFrozenInput,
  ScriptBreakdownOutput,
  ScriptBreakdownSave,
  ScriptBreakdownSceneView,
} from "./script-breakdown";

/** The frozen input of a run of either kind: a title run (v1 or v2) or a script breakdown run. */
export type TitleRunInput = TitleWritingFrozenInput | ScriptBreakdownFrozenInput;

/** The independently authorized kinds executed by the shared writing engine. */
export type TitleRunKind = "title" | "script_breakdown";

/** Storage contract of title writing runs, shared by the run engine (providers) and the PostgreSQL store (database). */
export interface TitleRunRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  actorId: string;
  idempotencyKey: string;
  inputHash: string;
  input: TitleRunInput;
  state: TitleWritingRunState;
  errorCode: string | null;
  cancelRequestedAt: string | null;
  executorId: string | null;
  leaseUntil: string | null;
  callCap: number;
  callsUsed: number;
  storySave: TitleWritingStorySave;
  storyRevisionId: string | null;
  /** Save state of a script breakdown run's result; null for a title run. */
  breakdownSave?: ScriptBreakdownSave | null;
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
  output: TitleConcept | EpisodeOutline | EpisodeDraftCandidate | ScriptBreakdownOutput | null;
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
  providerKey: TitleWritingStoredProviderKey;
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
  | { kind: "blocked"; code: "TITLE_WRITING_ACTIVE_RUN_CAP" }
  | { kind: "blocked"; code: "TITLE_WRITING_DAILY_QUOTA_LOW"; requiredCalls: number; remainingCalls: number };

/**
 * Limits checked when a new run would be created, after the idempotency lookup (a replay of an existing run is never
 * refused by them). The quota check only reads the rolling 24-hour call count: it reserves nothing, and every send
 * still reserves its own call under the workspace call lock.
 */
export interface TitleRunCreationLimits {
  maxActiveRuns: number;
  quota?: { sinceIso: string; maxCallsPerDay: number; requiredCalls: number };
}

/**
 * source_changed: a script breakdown whose frozen script is no longer the episode's current, approved, CURRENT script.
 * conflict: the episode's current scene/shot ids or row versions differ from the frozen replacement set.
 * Checked under the run, project and episode locks in the same transaction as the reservation; nothing is reserved.
 */
export type TitleCallReservation =
  | { kind: "reserved" }
  | { kind: "canceled" | "lost" | "source_changed" | "conflict" }
  | { kind: "blocked"; code: "TITLE_WRITING_DAILY_CAP" | "TITLE_WRITING_RUN_CAP" };

export type TitleCallSubmission = "submitted" | "canceled" | "lost";

/** Error code of a reserved call closed because the run was canceled before it was sent. Nothing was sent. */
export const TITLE_WRITING_CANCELED_BEFORE_SEND = "canceled_before_send";

/** Error code of a run stopped because its kind is switched off. Nothing new was sent; a resume can continue it. */
export const TITLE_WRITING_RUN_KIND_DISABLED = "run_kind_disabled";

/**
 * How a run whose steps all completed ends once its save is settled, the same as the engine's own finish: a saved
 * result completes it, a refused save needs attention with the engine's code. Null while the save is still pending
 * (or the value is not a settled one), so the caller keeps its own rule.
 */
export function settledSaveOutcome(breakdown: boolean, save: unknown):
  { state: "completed" | "needs_attention"; errorCode: string | null } | null {
  if (save === "saved") return { state: "completed", errorCode: null };
  if (breakdown) {
    if (save === "source_changed") return { state: "needs_attention", errorCode: "breakdown_source_changed" };
    if (save === "conflict") return { state: "needs_attention", errorCode: "breakdown_conflict" };
    return null;
  }
  return save === "conflict" ? { state: "needs_attention", errorCode: "story_conflict" } : null;
}

export interface TitleCallFinish {
  state: "completed" | "rejected" | "unknown";
  errorCode: string | null;
  providerRequestId: string | null;
  responseModel: string | null;
  usage: TitleWritingUsageView;
  output: TitleStepRecord["output"];
  outputHash: string | null;
}

/**
 * replayed: this resume action (same key, same confirmation) was already applied; nothing changes and nothing is sent.
 * stale_confirmation: the confirmed calls are not exactly the current uncertain calls.
 * key_conflict: the key was used for a different confirmation on this run.
 * source_changed: a script breakdown whose frozen script was replaced, left unapproved or made STALE; nothing changes.
 * conflict: a script breakdown's frozen scene/shot set changed; no resume receipt or new call is created.
 * provider_unconfigured: the resume would send a call again but the run's provider or model cannot send; nothing changes.
 */
export type TitleResumePreparation =
  | { kind: "ok" | "replayed"; bundle: TitleRunBundle }
  | { kind: "not_resumable" | "needs_confirmation" | "stale_confirmation" | "key_conflict" | "active" | "active_cap" | "not_found" | "source_changed" | "conflict" | "provider_unconfigured" };

export interface TitleResumeRequest {
  /** Identity of one resume action, from the Idempotency-Key header. */
  resumeKey: string;
  /** Hash of the confirmed call ids; a replay with the same key must carry the same confirmation. */
  requestHash: string;
  confirmedCallIds: readonly string[];
  maxActiveRuns: number;
  /**
   * Whether the run's provider and model can send now. Consulted only when this resume will send a call (it resets a step,
   * or a step was never reserved); a resume that only saves a stored answer needs no provider. Absent means ready.
   */
  providerReady?: boolean;
}

/** What a breakdown start reads, in one consistent snapshot, before anything is created or sent. */
export type ScriptBreakdownSourceRead =
  | {
    kind: "ok";
    episodeNo: number;
    scriptRevisionId: string;
    scriptRevisionNo: number;
    scriptContentHash: string;
    scriptContent: unknown;
    targetEpisodeSeconds: number | null;
    /** Current revisions of the project's characters that are not archived, oldest first. */
    characters: Array<{ characterId: string; revisionId: string; name: string }>;
    /** The episode's scenes and their shots that are not archived. */
    scenes: Array<{ sceneId: string; rowVersion: number }>;
    shots: Array<{ shotId: string; rowVersion: number }>;
  }
  | { kind: "not_found" | "script_missing" | "script_review_required" };

/** Per scene key, what one shot placement did. */
export interface ScriptBreakdownPlacementOutcome {
  placed: string[];
  /** The scene is not approved yet (or its current revision is not the approved one). */
  awaitingApproval: string[];
  /** The approved scene revision differs from the one this breakdown wrote; needs acceptSceneChanged. */
  sceneChanged: string[];
  /** A referenced character revision is no longer current; nothing is written for that scene. */
  charactersChanged: string[];
  /** The scene was archived or is no longer usable. */
  unavailable: string[];
}

export type ScriptBreakdownPlacement =
  | { kind: "ok"; bundle: TitleRunBundle; outcome: ScriptBreakdownPlacementOutcome }
  /** Pending shots cannot change the frozen scene set of another running breakdown in this episode. */
  | { kind: "not_found" | "not_ready" | "active" };

export interface ScriptBreakdownDetails {
  scenes: ScriptBreakdownSceneView[];
  episodeScript: { currentRevisionId: string | null; currentRevisionNo: number | null; approved: boolean };
}

export type TitleScriptPlacement =
  | { kind: "ok"; bundle: TitleRunBundle }
  | { kind: "not_found" | "not_ready" | "story_not_approved" | "story_changed" | "plan_mismatch" };

/**
 * Persistence of title writing runs. Every method that changes a running run is conditional on the executor that
 * holds a live lease, so a late or fenced executor cannot overwrite recovery, cancellation or another executor.
 * Every method is scoped to one workspace: an executor, recovery pass or reader of workspace A never sees, claims,
 * fences, sends for or writes a run of workspace B.
 */
export interface TitleWritingStore {
  storageReady(): Promise<boolean>;
  /**
   * Whether runs and calls of this provider can be stored. openai always can once storageReady(); anthropic only after
   * the provider migration (20261016000100_writing_provider_anthropic) is recorded and the provider CHECKs allow it;
   * deepseek needs no migration, but the live CHECKs must name it.
   * Callers refuse a new run of an unready provider before any write, reservation or send.
   */
  providerStorageReady(providerKey: TitleWritingProviderKey): Promise<boolean>;
  /**
   * Idempotency lookup, input comparison, active-run checks, the start quota check and insert of the run with its
   * N+2 steps (five for v1): one atomic step.
   */
  createRun(run: TitleRunRecord, limits: TitleRunCreationLimits): Promise<TitleRunCreation>;
  getRun(workspaceId: string, projectId: string, runId: string): Promise<TitleRunBundle | null>;
  /** Executor read: the run only when it belongs to this workspace. */
  getRunById(workspaceId: string, runId: string): Promise<TitleRunBundle | null>;
  latestRun(workspaceId: string, projectId: string): Promise<TitleRunBundle | null>;
  /** Takes a running run of this workspace whose lease is free or expired. */
  claimRun(workspaceId: string, runId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<boolean>;
  /** Checks workspace, ownership, cancellation, the run cap and the workspace daily cap, then inserts the call as reserved. */
  reserveCall(call: TitleCallRecord, limits: { sinceIso: string; maxCallsPerDay: number }, nowIso: string, leaseUntil: string): Promise<TitleCallReservation>;
  /**
   * Persisted before any network send, under the run lock. A cancel committed before this point closes the reserved
   * call as never sent ("canceled"); nothing may be sent then. A cancel committed after it leaves the call to finish.
   */
  markCallSubmitted(workspaceId: string, callId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<TitleCallSubmission>;
  finishCall(workspaceId: string, callId: string, executorId: string, patch: TitleCallFinish, nowIso: string): Promise<boolean>;
  /** Creates a DRAFT story revision only when the project has no current story; records it on the run atomically. */
  saveStory(workspaceId: string, runId: string, executorId: string, storyText: string, actorId: string, nowIso: string): Promise<"saved" | "conflict" | "lost">;
  finishRun(workspaceId: string, runId: string, executorId: string, state: Exclude<TitleWritingRunState, "running">, errorCode: string | null, nowIso: string): Promise<boolean>;
  requestCancel(workspaceId: string, projectId: string, runId: string, nowIso: string): Promise<TitleRunBundle | null>;
  /**
   * One transaction under the run lock: replay check by resume key, then state and cap checks, then the confirmation
   * must equal the current uncertain calls exactly. Only then are rejected, canceled and confirmed unknown steps reset.
   */
  prepareResume(workspaceId: string, projectId: string, runId: string, request: TitleResumeRequest, nowIso: string): Promise<TitleResumePreparation>;
  /**
   * The receipt of a resume action already accepted for this run of this work, by its key; null when there is none.
   * Reads only: a replay is answered from it before any current gate (provider, source, run state) is applied.
   */
  findResume(workspaceId: string, projectId: string, runId: string, resumeKey: string): Promise<{ requestHash: string } | null>;
  /** Fences expired executors of this workspace: reserved calls were never sent, submitted calls become unknown. */
  recoverExpired(workspaceId: string, nowIso: string): Promise<number>;
  /**
   * Stops running runs of the given switched-off kinds of this workspace that no executor holds (unclaimed or with an
   * expired lease), without any send, so they no longer hold an active-run slot. Each run is settled under its row lock
   * like a fenced executor: reserved calls were never sent, submitted calls become unknown and the run needs attention;
   * otherwise a requested cancel ends as canceled; a run whose steps all completed and whose save was already settled
   * (its executor stopped before finishing it) ends as the engine would end it (settledSaveOutcome: saved completes,
   * story conflict, breakdown source_changed or conflict need attention with story_conflict, breakdown_source_changed
   * or breakdown_conflict); anything else needs attention with TITLE_WRITING_RUN_KIND_DISABLED.
   * Runs held under a live lease are left alone. Call records, uncertain calls and their cost are kept.
   */
  retireDisabledRuns(workspaceId: string, nowIso: string, disabledKinds: readonly TitleRunKind[]): Promise<number>;
  /** Optional kind policy is applied before the limit; omitted means both kinds, empty means neither. */
  listClaimable(workspaceId: string, nowIso: string, limit: number, allowedRunKinds?: readonly TitleRunKind[]): Promise<string[]>;
  /**
   * After the story was approved by a person: writes each saved screenplay into an episode that has no script yet.
   * plan_mismatch: the project's episodes are not exactly 1..N of this run; nothing is written.
   */
  placeScripts(workspaceId: string, projectId: string, runId: string, options: { acceptStoryChanged: boolean }, actorId: string, nowIso: string): Promise<TitleScriptPlacement>;

  // Script breakdown runs (migration 20261012000100_script_breakdown). A run of kind "script_breakdown" uses the
  // methods above for claiming, reserving, sending, finishing, cancelling, resuming and recovery.
  /** True only when the breakdown columns, the scene link table and shot_revision.planned_duration_ms exist. */
  breakdownStorageReady(): Promise<boolean>;
  /** The run created by this request identity, of any kind and project; null when the key is new. */
  findRunByKey(workspaceId: string, actorId: string, idempotencyKey: string): Promise<TitleRunBundle | null>;
  breakdownSource(workspaceId: string, projectId: string, episodeId: string): Promise<ScriptBreakdownSourceRead>;
  latestBreakdown(workspaceId: string, projectId: string, episodeId: string): Promise<TitleRunBundle | null>;
  /** The newest breakdown run of this episode whose result was saved (same order as latestBreakdown), or null. */
  latestSavedBreakdown(workspaceId: string, projectId: string, episodeId: string): Promise<TitleRunBundle | null>;
  breakdownDetails(workspaceId: string, run: TitleRunRecord): Promise<ScriptBreakdownDetails>;
  /**
   * Saves the validated result of a breakdown run whose step completed, under the run lock held by this executor:
   * source_changed when the frozen script or a referenced character is no longer current and approved; conflict when
   * the episode's scenes or shots differ from the frozen ones. Neither writes anything but the save state.
   */
  saveBreakdown(workspaceId: string, runId: string, executorId: string, actorId: string, nowIso: string): Promise<ScriptBreakdownSave | "lost">;
  /** Writes the proposed shots of every approved scene of a saved breakdown that has none written yet. */
  placeBreakdownShots(workspaceId: string, projectId: string, episodeId: string, runId: string, options: { acceptSceneChanged: boolean }, actorId: string, nowIso: string): Promise<ScriptBreakdownPlacement>;
}
