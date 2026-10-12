import { createHash, randomUUID } from "node:crypto";
import {
  TITLE_WRITING_CANCELED_BEFORE_SEND,
  type TitleCallFinish,
  type TitleCallRecord,
  type TitleCallReservation,
  type TitleCallSubmission,
  type TitleResumePreparation,
  type TitleResumeRequest,
  type TitleRunBundle,
  type TitleRunCreation,
  type TitleRunCreationLimits,
  type TitleRunRecord,
  type TitleScriptPlacement,
  type TitleStepRecord,
  type TitleWritingStore,
} from "@ai-drama/contracts";
import {
  SCRIPT_BREAKDOWN_STEP_KEY,
  isScriptBreakdownInput,
  scriptBreakdownJsonSchema,
  type ScriptBreakdownDetails,
  type ScriptBreakdownFrozenInput,
  type ScriptBreakdownOutput,
  type ScriptBreakdownPlacement,
  type ScriptBreakdownPlacementOutcome,
  type ScriptBreakdownSave,
  type ScriptBreakdownSourceRead,
} from "@ai-drama/contracts";
import {
  TITLE_WRITING_INPUT_SCHEMA,
  TITLE_WRITING_INPUT_SCHEMA_V2,
  TITLE_WRITING_PROMPT_VERSION,
  TITLE_WRITING_PROMPT_VERSION_V2,
  currentUncertainCallIds,
  isTitleWritingInputV2,
  titleWritingCallCapFor,
  titleWritingEpisodeCount,
  titleWritingJsonSchemas,
  titleWritingStepKeysFor,
  type EpisodeDraftCandidate,
  type EpisodeOutline,
  type TitleConcept,
  type TitleWritingCallView,
  type TitleWritingFrozenInput,
  type TitleWritingProviderKey,
  type TitleWritingRunState,
  type TitleWritingRunView,
  type TitleWritingSettings,
  type TitleWritingStepKey,
  type TitleWritingStepView,
} from "@ai-drama/contracts";
import {
  breakdownDialogueText,
  breakdownShotPromptText,
  shotsOfScene,
  buildScriptBreakdownPrompt,
  buildTitleWritingPrompt,
  canonicalInputHash,
  episodeNoOf,
  formatTitleEpisode,
  formatTitleStory,
  validateScriptBreakdownOutput,
  validateTitleWritingOutput,
  type TitleWritingContext,
} from "@ai-drama/domain";
import {
  TEXT_WRITING_MAX_OUTPUT_TOKENS,
  TEXT_WRITING_TIMEOUT_MS,
  WRITING_ADAPTERS,
  sendWriting,
  type WritingAdapter,
  type WritingExchange,
  type WritingProviderConfig,
  type WritingTransport,

} from "./text-writing";

/**
 * Cap of a v1 run: five required steps plus three resends for rejected or confirmed-uncertain steps. A v2 run's cap is
 * N+5 (titleWritingCallCap); a stored run keeps the cap it was created with.
 */
export const TITLE_WRITING_CALL_CAP_PER_RUN = 8;
export const TITLE_WRITING_MAX_CALLS_PER_DAY_DEFAULT = 30;
export const TITLE_WRITING_MAX_ACTIVE_RUNS_DEFAULT = 1;
/** The executor lease covers the capped send time twice over, as in the Qwen web writing store. */
export const TITLE_WRITING_LEASE_MS = TEXT_WRITING_TIMEOUT_MS * 2;
export const TITLE_WRITING_LOST_BEFORE_SEND = "executor_lost_before_send";
export const TITLE_WRITING_LOST_AFTER_SEND = "executor_lost";

export type {
  TitleResumeRequest,
  TitleCallFinish,
  TitleCallRecord,
  TitleCallReservation,
  TitleResumePreparation,
  TitleRunBundle,
  TitleRunCreation,
  TitleRunCreationLimits,
  TitleRunRecord,
  TitleScriptPlacement,
  TitleStepRecord,
  TitleWritingStore,
};

export function hashTitleWritingInput(projectId: string, input: TitleWritingFrozenInput): string {
  return canonicalInputHash({ projectId, input });
}

/** Identity of a resume action's content: the run and exactly which uncertain calls the person confirmed. */
export function hashTitleResume(runId: string, confirmedCallIds: readonly string[]): string {
  return canonicalInputHash({ runId, confirmUncertainCallIds: [...confirmedCallIds].sort() });
}

/** True when the confirmation names exactly the uncertain calls a resume would resend now. */
export function confirmationMatches(current: readonly string[], confirmed: readonly string[]): boolean {
  const sorted = [...confirmed].sort();
  return current.length === sorted.length && current.every((id, index) => id === sorted[index]);
}

export function uncertainCallIdsOf(steps: readonly TitleStepRecord[], calls: readonly TitleCallRecord[]): string[] {
  return currentUncertainCallIds(steps, calls.map((call) => ({ callId: call.id, stepKey: call.stepKey, attemptNo: call.attemptNo, state: call.state })));
}

export function newTitleRun(options: {
  workspaceId: string;
  projectId: string;
  actorId: string;
  idempotencyKey: string;
  title: string;
  settings: TitleWritingSettings;
  providerKey: TitleWritingProviderKey;
  model: string;
  now: Date;
  /** 2 freezes the project's episode plan (N, target seconds); 1, the default, is the unchanged three-episode input. */
  version?: 1 | 2;
}): TitleRunRecord {
  const common = { title: options.title, settings: options.settings, providerKey: options.providerKey, model: options.model };
  const input: TitleWritingFrozenInput = options.version === 2
    ? { schema: TITLE_WRITING_INPUT_SCHEMA_V2, promptVersion: TITLE_WRITING_PROMPT_VERSION_V2, ...common }
    : { schema: TITLE_WRITING_INPUT_SCHEMA, promptVersion: TITLE_WRITING_PROMPT_VERSION, ...common };
  const createdAt = options.now.toISOString();
  return {
    id: randomUUID(),
    workspaceId: options.workspaceId,
    projectId: options.projectId,
    actorId: options.actorId,
    idempotencyKey: options.idempotencyKey,
    inputHash: hashTitleWritingInput(options.projectId, input),
    input,
    state: "running",
    errorCode: null,
    cancelRequestedAt: null,
    executorId: null,
    leaseUntil: null,
    callCap: titleWritingCallCapFor(input),
    callsUsed: 0,
    storySave: "pending",
    storyRevisionId: null,
    breakdownSave: null,
    createdAt,
    updatedAt: createdAt,
  };
}

/** The title input of a run, or null for a script breakdown run. */
function titleInputOf(run: TitleRunRecord): TitleWritingFrozenInput | null {
  return isScriptBreakdownInput(run.input) ? null : run.input;
}

/**
 * concept, outline and episode:1..N of the run's own input; a v1 run gets its original five steps. A script breakdown
 * run has the single step "breakdown".
 */
export function initialSteps(run: TitleRunRecord): TitleStepRecord[] {
  const keys: TitleWritingStepKey[] = isScriptBreakdownInput(run.input) ? [SCRIPT_BREAKDOWN_STEP_KEY] : titleWritingStepKeysFor(run.input);
  return keys.map((stepKey, ordinal) => ({
    runId: run.id,
    stepKey,
    ordinal,
    state: "pending",
    attemptNo: 0,
    errorCode: null,
    output: null,
    outputHash: null,
    scriptSave: episodeNoOf(stepKey) === null ? null : "pending",
    scriptRevisionId: null,
    updatedAt: run.createdAt,
  }));
}

/** Context for a step is built only from saved, validated outputs of earlier steps. */
export function contextFromSteps(steps: readonly TitleStepRecord[]): TitleWritingContext {
  const byKey = new Map(steps.map((step) => [step.stepKey, step] as const));
  const concept = byKey.get("concept");
  const outline = byKey.get("outline");
  const episodes: EpisodeDraftCandidate[] = [];
  // Episodes in order up to the first one not completed; a run has exactly its own episode:1..N steps.
  const episodeSteps = steps.filter((step) => episodeNoOf(step.stepKey) !== null)
    .sort((left, right) => (episodeNoOf(left.stepKey) ?? 0) - (episodeNoOf(right.stepKey) ?? 0));
  for (const step of episodeSteps) {
    if (step.state !== "completed" || !step.output) break;
    episodes.push(step.output as EpisodeDraftCandidate);
  }
  return {
    ...(concept?.state === "completed" && concept.output ? { concept: concept.output as TitleConcept } : {}),
    ...(outline?.state === "completed" && outline.output ? { outline: outline.output as EpisodeOutline } : {}),
    episodes,
  };
}

function contextForStep(stepKey: TitleWritingStepKey, steps: readonly TitleStepRecord[]): TitleWritingContext {
  const context = contextFromSteps(steps);
  const episodeNo = episodeNoOf(stepKey);
  return { ...context, episodes: episodeNo === null ? [] : (context.episodes ?? []).slice(0, episodeNo - 1) };
}

export function storyTextOf(bundle: TitleRunBundle): string | null {
  const input = titleInputOf(bundle.run);
  if (!input) return null;
  const context = contextFromSteps(bundle.steps);
  if (!context.concept || !context.outline) return null;
  try {
    return formatTitleStory(input.title, context.concept, context.outline);
  } catch {
    return null;
  }
}

function stepText(step: TitleStepRecord): string | null {
  if (step.state !== "completed" || !step.output) return null;
  if (episodeNoOf(step.stepKey) !== null) return formatTitleEpisode(step.output as EpisodeDraftCandidate);
  return null;
}

/** Public view: no executor, idempotency key, request hash, raw response or credential. */
export function titleRunView(bundle: TitleRunBundle): TitleWritingRunView {
  const { run } = bundle;
  const input = titleInputOf(run);
  if (!input) throw new Error("not a title writing run");
  return {
    runId: run.id,
    projectId: run.projectId,
    title: input.title,
    inputVersion: isTitleWritingInputV2(input) ? 2 : 1,
    episodeCount: titleWritingEpisodeCount(input),
    settings: input.settings,
    providerKey: input.providerKey,
    model: input.model,
    state: run.state,
    errorCode: run.errorCode,
    cancelRequested: run.cancelRequestedAt !== null,
    callCap: run.callCap,
    callsUsed: run.callsUsed,
    storySave: run.storySave,
    storyRevisionId: run.storyRevisionId,
    storyText: storyTextOf(bundle),
    steps: [...bundle.steps].sort((left, right) => left.ordinal - right.ordinal).map((step) => ({
      stepKey: step.stepKey,
      state: step.state,
      attemptNo: step.attemptNo,
      errorCode: step.errorCode,
      // A title run never has a breakdown step, so its outputs are title outputs.
      output: step.state === "completed" ? step.output as TitleWritingStepView["output"] : null,
      text: stepText(step),
      scriptSave: step.scriptSave,
      scriptRevisionId: step.scriptRevisionId,
    })),
    calls: [...bundle.calls].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map((call): TitleWritingCallView => ({
      callId: call.id,
      stepKey: call.stepKey,
      attemptNo: call.attemptNo,
      providerKey: call.providerKey,
      model: call.model,
      responseModel: call.responseModel,
      providerRequestId: call.providerRequestId,
      state: call.state,
      errorCode: call.errorCode,
      usage: call.usage,
      billingStatus: "unknown",
      createdAt: call.createdAt,
      finishedAt: call.finishedAt,
    })),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export interface TitleWritingEngineDeps {
  /** The only workspace this engine claims, recovers, sends for and writes. */
  workspaceId: string;
  store: TitleWritingStore;
  providers: Record<TitleWritingProviderKey, WritingProviderConfig>;
  transport: WritingTransport;
  maxCallsPerDay: number;
  adapters?: Readonly<Record<TitleWritingProviderKey, WritingAdapter>>;
  clock?: () => Date;
  executorId?: string;
  leaseMs?: number;
  timeoutMs?: number;
  send?: typeof sendWriting;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Drives one run step by step inside the API process. The browser only starts, polls and shows. A step that was
 * completed is never called again; an uncertain call stops the run for a person to decide.
 */
export class TitleWritingEngine {
  readonly executorId: string;
  readonly workspaceId: string;
  private readonly running = new Set<string>();

  constructor(private readonly deps: TitleWritingEngineDeps) {
    this.executorId = deps.executorId ?? `title-writing:${randomUUID()}`;
    this.workspaceId = deps.workspaceId;
  }

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  private lease(from: Date): string {
    return new Date(from.getTime() + (this.deps.leaseMs ?? TITLE_WRITING_LEASE_MS)).toISOString();
  }

  /** Runs until the run reaches a resting state or another executor owns it. Safe to call repeatedly. */
  async drive(runId: string): Promise<void> {
    if (this.running.has(runId)) return;
    this.running.add(runId);
    try {
      const claimedAt = this.now();
      if (!await this.deps.store.claimRun(this.deps.workspaceId, runId, this.executorId, claimedAt.toISOString(), this.lease(claimedAt))) return;
      while (await this.advance(runId)) {
        // Each pass handles one step and re-reads the persisted run.
      }
    } finally {
      this.running.delete(runId);
    }
  }

  /** One maintenance pass over this engine's workspace: fence expired executors, then continue runs free to claim. */
  async maintain(limit = 5): Promise<void> {
    const nowIso = this.now().toISOString();
    await this.deps.store.recoverExpired(this.deps.workspaceId, nowIso);
    const runIds = await this.deps.store.listClaimable(this.deps.workspaceId, nowIso, limit);
    for (const runId of runIds) await this.drive(runId);
  }

  private async finish(runId: string, state: Exclude<TitleWritingRunState, "running">, errorCode: string | null): Promise<false> {
    await this.deps.store.finishRun(this.deps.workspaceId, runId, this.executorId, state, errorCode, this.now().toISOString());
    return false;
  }

  private async advance(runId: string): Promise<boolean> {
    const bundle = await this.deps.store.getRunById(this.deps.workspaceId, runId);
    if (!bundle || bundle.run.workspaceId !== this.deps.workspaceId || bundle.run.state !== "running"
      || bundle.run.executorId !== this.executorId) return false;
    const { run } = bundle;
    const anyCompleted = bundle.steps.some((step) => step.state === "completed");
    if (run.cancelRequestedAt !== null) return this.finish(runId, "canceled", null);
    const steps = [...bundle.steps].sort((left, right) => left.ordinal - right.ordinal);
    const next = steps.find((step) => step.state !== "completed");
    if (!next) return this.saveAndComplete(bundle);
    if (next.state === "unknown") return this.finish(runId, "needs_attention", next.errorCode ?? "uncertain_call");
    if (next.state === "rejected") return this.finish(runId, anyCompleted ? "partial" : "failed", next.errorCode);
    if (next.state === "reserved" || next.state === "submitted") {
      // A call of this run is still open under another lease; recovery decides its fate.
      return false;
    }
    const provider = this.deps.providers[run.input.providerKey];
    if (!provider.ok || !provider.models.includes(run.input.model)) {
      return this.finish(runId, "needs_attention", "provider_unconfigured");
    }
    const titleInput = titleInputOf(run);
    // v2: the story saved after the last episode must fit its storage limit. Checked once concept and outline exist,
    // before any episode is requested, so an unsavable story never costs the episode calls.
    if (titleInput && isTitleWritingInputV2(titleInput) && episodeNoOf(next.stepKey) !== null && storyTextOf(bundle) === null) {
      return this.finish(runId, "needs_attention", "story_too_large");
    }
    const adapter = (this.deps.adapters ?? WRITING_ADAPTERS)[run.input.providerKey];
    let prompt: { system: string; user: string };
    let schema: { name: string; schema: Record<string, unknown> };
    if (titleInput) {
      const titlePrompt = buildTitleWritingPrompt(next.stepKey, titleInput, contextForStep(next.stepKey, steps));
      prompt = titlePrompt;
      schema = titleWritingJsonSchemas(titleInput)[titlePrompt.schemaKind];
    } else {
      // A breakdown prompt is built from the frozen copy of the script only; nothing is read again before sending.
      const breakdown = run.input as ScriptBreakdownFrozenInput;
      if (next.stepKey !== SCRIPT_BREAKDOWN_STEP_KEY) return this.finish(runId, "failed", "invalid_step");
      prompt = buildScriptBreakdownPrompt(breakdown);
      schema = scriptBreakdownJsonSchema(breakdown.episodeNo);
    }
    const request = {
      model: run.input.model,
      system: prompt.system,
      user: prompt.user,
      schemaName: schema.name,
      jsonSchema: schema.schema,
      maxOutputTokens: TEXT_WRITING_MAX_OUTPUT_TOKENS,
    };
    const requestHash = sha256(`${provider.url}\n${adapter.buildBody(request)}`);
    const reservedAt = this.now();
    const call: TitleCallRecord = {
      id: randomUUID(),
      runId,
      workspaceId: this.deps.workspaceId,
      stepKey: next.stepKey,
      attemptNo: next.attemptNo + 1,
      providerKey: run.input.providerKey,
      model: run.input.model,
      requestHash,
      state: "reserved",
      executorId: this.executorId,
      providerRequestId: null,
      responseModel: null,
      usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null },
      errorCode: null,
      createdAt: reservedAt.toISOString(),
      finishedAt: null,
    };
    const reservation = await this.deps.store.reserveCall(call, {
      sinceIso: new Date(reservedAt.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      maxCallsPerDay: this.deps.maxCallsPerDay,
    }, reservedAt.toISOString(), this.lease(reservedAt));
    if (reservation.kind === "lost") return false;
    if (reservation.kind === "canceled") return this.finish(runId, "canceled", null);
    if (reservation.kind === "blocked") return this.finish(runId, anyCompleted ? "partial" : "failed", reservation.code);
    const submittedAt = this.now();
    const submission = await this.deps.store.markCallSubmitted(this.deps.workspaceId, call.id, this.executorId,
      submittedAt.toISOString(), this.lease(submittedAt));
    // A cancel committed before submission closed the reservation: nothing is sent.
    if (submission === "canceled") return this.finish(runId, "canceled", null);
    if (submission !== "submitted") return false;

    const exchange: WritingExchange = await (this.deps.send ?? sendWriting)({
      adapter,
      url: provider.url,
      apiKey: provider.apiKey,
      request,
      transport: this.deps.transport,
      ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
    });
    let patch: TitleCallFinish;
    if (exchange.outcome === "answered" && exchange.content !== null) {
      const checked = titleInput
        ? validateTitleWritingOutput(next.stepKey, exchange.content, titleInput)
        : validateScriptBreakdownOutput(exchange.content, run.input as ScriptBreakdownFrozenInput);
      patch = checked.ok
        ? { state: "completed", errorCode: null, output: checked.output, outputHash: canonicalInputHash(checked.output),
          providerRequestId: exchange.providerRequestId, responseModel: exchange.responseModel, usage: exchange.usage }
        : { state: "rejected", errorCode: checked.code, output: null, outputHash: null,
          providerRequestId: exchange.providerRequestId, responseModel: exchange.responseModel, usage: exchange.usage };
    } else {
      patch = {
        state: exchange.outcome === "unknown" ? "unknown" : "rejected",
        errorCode: exchange.errorCode ?? "invalid_output",
        output: null,
        outputHash: null,
        providerRequestId: exchange.providerRequestId,
        responseModel: exchange.responseModel,
        usage: exchange.usage,
      };
    }
    // A fenced executor's late answer is dropped: recovery already recorded the call as unknown.
    return this.deps.store.finishCall(this.deps.workspaceId, call.id, this.executorId, patch, this.now().toISOString());
  }

  private async saveAndComplete(bundle: TitleRunBundle): Promise<false> {
    const { run } = bundle;
    if (isScriptBreakdownInput(run.input)) return this.saveBreakdownAndComplete(run);
    if (run.storySave === "saved") return this.finish(run.id, "completed", null);
    if (run.storySave === "conflict") return this.finish(run.id, "needs_attention", "story_conflict");
    const text = storyTextOf(bundle);
    if (text === null) return this.finish(run.id, "needs_attention", "story_too_large");
    const saved = await this.deps.store.saveStory(this.deps.workspaceId, run.id, this.executorId, text, run.actorId, this.now().toISOString());
    if (saved === "lost") return false;
    return saved === "saved"
      ? this.finish(run.id, "completed", null)
      : this.finish(run.id, "needs_attention", "story_conflict");
  }

  /**
   * A breakdown result is saved only against its frozen sources. When the script, a referenced character or the
   * episode's scenes changed meanwhile, the result stays in the run and nothing is written or marked current.
   */
  private async saveBreakdownAndComplete(run: TitleRunRecord): Promise<false> {
    let save: ScriptBreakdownSave | "lost" = run.breakdownSave ?? "pending";
    if (save === "pending") {
      save = await this.deps.store.saveBreakdown(this.deps.workspaceId, run.id, this.executorId, run.actorId, this.now().toISOString());
    }
    if (save === "lost") return false;
    if (save === "saved") return this.finish(run.id, "completed", null);
    if (save === "source_changed") return this.finish(run.id, "needs_attention", "breakdown_source_changed");
    return this.finish(run.id, "needs_attention", "breakdown_conflict");
  }
}

interface MemoryProject {
  workspaceId: string;
  /** The project's episode count: its plan's N, or three without a plan. */
  episodeCount: number;
  stories: Array<{ id: string; text: string; reviewStatus: "DRAFT" | "APPROVED" }>;
  currentStoryId: string | null;
  approvedStoryId: string | null;
  episodes: Map<number, { id: string; currentScriptId: string | null; scripts: Array<{ id: string; text: string; sourceStoryId: string }> }>;
}

interface MemoryScript {
  id: string;
  revisionNo: number;
  content: unknown;
  contentHash: string;
  reviewStatus: "DRAFT" | "APPROVED";
  freshnessStatus: "CURRENT" | "STALE";
}

/** One episode of the breakdown memory model: its scripts and its scene and shot aggregates. */
export interface MemoryBreakdownEpisode {
  workspaceId: string;
  projectId: string;
  episodeId: string;
  episodeNo: number;
  targetEpisodeSeconds: number | null;
  scripts: MemoryScript[];
  currentScriptId: string | null;
  approvedScriptId: string | null;
}

export interface MemorySceneRevision {
  id: string;
  sourceScriptRevisionId: string;
  ordinal: number;
  heading: string;
  timeOfDay: string | null;
  summary: string;
  reviewStatus: "DRAFT" | "APPROVED";
  freshnessStatus: "CURRENT" | "STALE";
}

export interface MemoryScene {
  sceneId: string;
  episodeId: string;
  rowVersion: number;
  archived: boolean;
  revisions: MemorySceneRevision[];
  currentRevisionId: string | null;
  approvedRevisionId: string | null;
}

export interface MemoryShot {
  shotId: string;
  sceneId: string;
  rowVersion: number;
  archived: boolean;
  revisionId: string;
  sourceSceneRevisionId: string;
  ordinal: number;
  shotType: string;
  camera: string;
  action: string;
  dialogue: string | null;
  plannedDurationMs: number | null;
  promptText: string;
  characterRevisionIds: string[];
  freshnessStatus: "CURRENT" | "STALE";
}

export interface MemoryCharacter {
  projectId: string;
  characterId: string;
  revisionId: string;
  name: string;
  archived: boolean;
}

interface MemoryBreakdownLink {
  runId: string;
  sceneKey: string;
  ordinal: number;
  sceneId: string;
  sceneRevisionId: string;
  shotSave: "pending" | "saved";
  placedSceneRevisionId: string | null;
}

function expired(leaseUntil: string | null, nowIso: string): boolean {
  return leaseUntil === null || leaseUntil <= nowIso;
}

/**
 * In-process store for tests and the controllable-provider acceptance. Each method runs without an await between
 * its read and write, which gives the same atomicity the PostgreSQL store gets from row locks.
 */
export class InMemoryTitleWritingStore implements TitleWritingStore {
  readonly runs: TitleRunRecord[] = [];
  readonly steps: TitleStepRecord[] = [];
  readonly calls: TitleCallRecord[] = [];
  readonly projects = new Map<string, MemoryProject>();
  readonly resumes: Array<{ runId: string; key: string; requestHash: string; confirmedCallIds: string[]; createdAt: string }> = [];
  ready = true;
  breakdownReady = true;
  readonly breakdownEpisodes = new Map<string, MemoryBreakdownEpisode>();
  readonly scenes: MemoryScene[] = [];
  readonly shots: MemoryShot[] = [];
  readonly characters: MemoryCharacter[] = [];
  readonly breakdownLinks: MemoryBreakdownLink[] = [];

  addProject(workspaceId: string, projectId: string, episodeCount = 3): MemoryProject {
    const project: MemoryProject = { workspaceId, episodeCount, stories: [], currentStoryId: null, approvedStoryId: null, episodes: new Map() };
    this.projects.set(projectId, project);
    return project;
  }

  /** Test helper standing in for the person's review: approval creates the project's N episodes like the real chain. */
  approveCurrentStory(projectId: string): void {
    const project = this.requireProject(projectId);
    const story = project.stories.find((item) => item.id === project.currentStoryId);
    if (!story) throw new Error("no current story");
    story.reviewStatus = "APPROVED";
    project.approvedStoryId = story.id;
    for (let episodeNo = 1; episodeNo <= project.episodeCount; episodeNo += 1) {
      if (!project.episodes.has(episodeNo)) project.episodes.set(episodeNo, { id: randomUUID(), currentScriptId: null, scripts: [] });
    }
  }

  /** Test helper standing in for a person saving a story in the editor. */
  writeHumanStory(projectId: string, text: string): string {
    const project = this.requireProject(projectId);
    const id = randomUUID();
    project.stories.push({ id, text, reviewStatus: "DRAFT" });
    project.currentStoryId = id;
    return id;
  }

  async storageReady(): Promise<boolean> {
    return this.ready;
  }

  private bundle(run: TitleRunRecord): TitleRunBundle {
    return structuredClone({
      run,
      steps: this.steps.filter((step) => step.runId === run.id),
      calls: this.calls.filter((call) => call.runId === run.id),
    });
  }

  async createRun(run: TitleRunRecord, limits: TitleRunCreationLimits): Promise<TitleRunCreation> {
    const existing = this.runs.find((item) => item.workspaceId === run.workspaceId && item.actorId === run.actorId
      && item.idempotencyKey === run.idempotencyKey);
    if (existing) return { kind: existing.inputHash === run.inputHash ? "existing" : "conflict", bundle: this.bundle(existing) };
    const sameProject = this.runs.find((item) => item.projectId === run.projectId && item.state === "running");
    if (sameProject) return { kind: "active", bundle: this.bundle(sameProject) };
    if (this.runs.filter((item) => item.workspaceId === run.workspaceId && item.state === "running").length >= limits.maxActiveRuns) {
      return { kind: "blocked", code: "TITLE_WRITING_ACTIVE_RUN_CAP" };
    }
    if (limits.quota) {
      const { sinceIso, maxCallsPerDay, requiredCalls } = limits.quota;
      const recent = this.calls.filter((item) => item.workspaceId === run.workspaceId && item.createdAt >= sinceIso).length;
      const remainingCalls = Math.max(0, maxCallsPerDay - recent);
      if (remainingCalls < requiredCalls) return { kind: "blocked", code: "TITLE_WRITING_DAILY_QUOTA_LOW", requiredCalls, remainingCalls };
    }
    this.runs.push(structuredClone(run));
    this.steps.push(...initialSteps(run));
    return { kind: "created", bundle: this.bundle(this.requireRun(run.id)) };
  }

  async getRun(workspaceId: string, projectId: string, runId: string): Promise<TitleRunBundle | null> {
    const run = this.runs.find((item) => item.id === runId && item.workspaceId === workspaceId && item.projectId === projectId);
    return run ? this.bundle(run) : null;
  }

  async getRunById(workspaceId: string, runId: string): Promise<TitleRunBundle | null> {
    const run = this.runs.find((item) => item.id === runId && item.workspaceId === workspaceId);
    return run ? this.bundle(run) : null;
  }

  async latestRun(workspaceId: string, projectId: string): Promise<TitleRunBundle | null> {
    const runs = this.runs.filter((item) => item.workspaceId === workspaceId && item.projectId === projectId
      && !isScriptBreakdownInput(item.input));
    const latest = runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0];
    return latest ? this.bundle(latest) : null;
  }

  async claimRun(workspaceId: string, runId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<boolean> {
    const run = this.runs.find((item) => item.id === runId && item.workspaceId === workspaceId);
    if (!run || run.state !== "running") return false;
    if (run.executorId !== null && run.executorId !== executorId && !expired(run.leaseUntil, nowIso)) return false;
    const open = this.calls.some((call) => call.runId === runId && (call.state === "reserved" || call.state === "submitted"));
    if (open && run.executorId !== executorId) return false;
    Object.assign(run, { executorId, leaseUntil, updatedAt: nowIso });
    return true;
  }

  private owns(run: TitleRunRecord, workspaceId: string, executorId: string, nowIso: string): boolean {
    return run.workspaceId === workspaceId && run.state === "running" && run.executorId === executorId
      && !expired(run.leaseUntil, nowIso);
  }

  async reserveCall(call: TitleCallRecord, limits: { sinceIso: string; maxCallsPerDay: number }, nowIso: string, leaseUntil: string): Promise<TitleCallReservation> {
    const run = this.requireRun(call.runId);
    if (!this.owns(run, call.workspaceId, call.executorId, nowIso)) return { kind: "lost" };
    if (run.cancelRequestedAt !== null) return { kind: "canceled" };
    if (run.callsUsed >= run.callCap) return { kind: "blocked", code: "TITLE_WRITING_RUN_CAP" };
    const recent = this.calls.filter((item) => item.workspaceId === call.workspaceId && item.createdAt >= limits.sinceIso).length;
    if (recent >= limits.maxCallsPerDay) return { kind: "blocked", code: "TITLE_WRITING_DAILY_CAP" };
    const step = this.requireStep(call.runId, call.stepKey);
    if (step.state !== "pending") return { kind: "lost" };
    this.calls.push(structuredClone(call));
    Object.assign(step, { state: "reserved", attemptNo: call.attemptNo, errorCode: null, updatedAt: nowIso });
    Object.assign(run, { callsUsed: run.callsUsed + 1, leaseUntil, updatedAt: nowIso });
    return { kind: "reserved" };
  }

  async markCallSubmitted(workspaceId: string, callId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<TitleCallSubmission> {
    const call = this.requireCall(callId);
    const run = this.requireRun(call.runId);
    if (call.state !== "reserved" || call.executorId !== executorId || !this.owns(run, workspaceId, executorId, nowIso)) return "lost";
    const step = this.requireStep(call.runId, call.stepKey);
    if (run.cancelRequestedAt !== null) {
      Object.assign(call, { state: "rejected", errorCode: TITLE_WRITING_CANCELED_BEFORE_SEND, finishedAt: nowIso });
      Object.assign(step, { state: "canceled", errorCode: null, updatedAt: nowIso });
      run.updatedAt = nowIso;
      return "canceled";
    }
    call.state = "submitted";
    Object.assign(step, { state: "submitted", updatedAt: nowIso });
    Object.assign(run, { leaseUntil, updatedAt: nowIso });
    return "submitted";
  }

  async finishCall(workspaceId: string, callId: string, executorId: string, patch: TitleCallFinish, nowIso: string): Promise<boolean> {
    const call = this.requireCall(callId);
    const run = this.requireRun(call.runId);
    if (run.workspaceId !== workspaceId || call.state !== "submitted" || call.executorId !== executorId
      || run.executorId !== executorId) return false;
    Object.assign(call, { state: patch.state, errorCode: patch.errorCode, providerRequestId: patch.providerRequestId,
      responseModel: patch.responseModel, usage: patch.usage, finishedAt: nowIso });
    const step = this.requireStep(call.runId, call.stepKey);
    Object.assign(step, { state: patch.state, errorCode: patch.errorCode, output: patch.output, outputHash: patch.outputHash, updatedAt: nowIso });
    run.updatedAt = nowIso;
    return true;
  }

  async saveStory(workspaceId: string, runId: string, executorId: string, storyText: string, _actorId: string, nowIso: string): Promise<"saved" | "conflict" | "lost"> {
    const run = this.requireRun(runId);
    if (!this.owns(run, workspaceId, executorId, nowIso)) return "lost";
    if (run.storySave === "saved") return "saved";
    const project = this.requireProject(run.projectId);
    if (project.currentStoryId !== null) {
      Object.assign(run, { storySave: "conflict", updatedAt: nowIso });
      return "conflict";
    }
    const id = randomUUID();
    project.stories.push({ id, text: storyText, reviewStatus: "DRAFT" });
    project.currentStoryId = id;
    for (const step of this.steps.filter((item) => item.runId === runId && item.scriptSave !== null)) step.scriptSave = "awaiting_story_approval";
    Object.assign(run, { storySave: "saved", storyRevisionId: id, updatedAt: nowIso });
    return "saved";
  }

  async finishRun(workspaceId: string, runId: string, executorId: string, state: Exclude<TitleWritingRunState, "running">, errorCode: string | null, nowIso: string): Promise<boolean> {
    const run = this.requireRun(runId);
    if (run.workspaceId !== workspaceId || run.state !== "running" || run.executorId !== executorId) return false;
    if (state === "canceled") {
      for (const step of this.steps.filter((item) => item.runId === runId && item.state === "pending")) {
        Object.assign(step, { state: "canceled", updatedAt: nowIso });
      }
    }
    Object.assign(run, { state, errorCode, executorId: null, leaseUntil: null, updatedAt: nowIso });
    return true;
  }

  async requestCancel(workspaceId: string, projectId: string, runId: string, nowIso: string): Promise<TitleRunBundle | null> {
    const run = this.runs.find((item) => item.id === runId && item.workspaceId === workspaceId && item.projectId === projectId);
    if (!run) return null;
    if (run.state === "running" && run.cancelRequestedAt === null) Object.assign(run, { cancelRequestedAt: nowIso, updatedAt: nowIso });
    return this.bundle(run);
  }

  async prepareResume(workspaceId: string, projectId: string, runId: string, request: TitleResumeRequest, nowIso: string): Promise<TitleResumePreparation> {
    const run = this.runs.find((item) => item.id === runId && item.workspaceId === workspaceId && item.projectId === projectId);
    if (!run) return { kind: "not_found" };
    const previous = this.resumes.find((item) => item.runId === runId && item.key === request.resumeKey);
    if (previous) return previous.requestHash === request.requestHash ? { kind: "replayed", bundle: this.bundle(run) } : { kind: "key_conflict" };
    if (run.state === "running") return { kind: "active" };
    if (run.state === "completed") return { kind: "not_resumable" };
    if (this.runs.some((item) => item.projectId === projectId && item.state === "running")) return { kind: "active" };
    if (this.runs.filter((item) => item.workspaceId === workspaceId && item.state === "running").length >= request.maxActiveRuns) {
      return { kind: "active_cap" };
    }
    const steps = this.steps.filter((item) => item.runId === runId);
    const uncertain = uncertainCallIdsOf(steps, this.calls.filter((item) => item.runId === runId));
    if (uncertain.length > 0 && request.confirmedCallIds.length === 0) return { kind: "needs_confirmation" };
    if (!confirmationMatches(uncertain, request.confirmedCallIds)) return { kind: "stale_confirmation" };
    const redo = steps.filter((step) => step.state === "unknown" || step.state === "rejected" || step.state === "canceled");
    const savePending = isScriptBreakdownInput(run.input) ? run.breakdownSave === "pending" : run.storySave === "pending";
    if (redo.length === 0 && !savePending) return { kind: "not_resumable" };
    this.resumes.push({ runId, key: request.resumeKey, requestHash: request.requestHash, confirmedCallIds: [...request.confirmedCallIds].sort(), createdAt: nowIso });
    for (const step of redo) Object.assign(step, { state: "pending", updatedAt: nowIso });
    Object.assign(run, { state: "running", errorCode: null, cancelRequestedAt: null, executorId: null, leaseUntil: null, updatedAt: nowIso });
    return { kind: "ok", bundle: this.bundle(run) };
  }

  async recoverExpired(workspaceId: string, nowIso: string): Promise<number> {
    let recovered = 0;
    for (const run of this.runs) {
      if (run.workspaceId !== workspaceId || run.state !== "running" || run.executorId === null
        || !expired(run.leaseUntil, nowIso)) continue;
      recovered += 1;
      let uncertain = false;
      for (const call of this.calls.filter((item) => item.runId === run.id)) {
        const step = this.requireStep(run.id, call.stepKey);
        if (call.state === "reserved") {
          Object.assign(call, { state: "rejected", errorCode: TITLE_WRITING_LOST_BEFORE_SEND, finishedAt: nowIso });
          Object.assign(step, { state: "pending", updatedAt: nowIso });
        } else if (call.state === "submitted") {
          Object.assign(call, { state: "unknown", errorCode: TITLE_WRITING_LOST_AFTER_SEND, finishedAt: nowIso });
          Object.assign(step, { state: "unknown", errorCode: TITLE_WRITING_LOST_AFTER_SEND, updatedAt: nowIso });
          uncertain = true;
        }
      }
      Object.assign(run, uncertain
        ? { state: "needs_attention", errorCode: TITLE_WRITING_LOST_AFTER_SEND, executorId: null, leaseUntil: null, updatedAt: nowIso }
        : { executorId: null, leaseUntil: null, updatedAt: nowIso });
    }
    return recovered;
  }

  async listClaimable(workspaceId: string, nowIso: string, limit: number): Promise<string[]> {
    return this.runs
      .filter((run) => run.workspaceId === workspaceId && run.state === "running"
        && (run.executorId === null || expired(run.leaseUntil, nowIso)))
      .slice(0, limit)
      .map((run) => run.id);
  }

  async placeScripts(workspaceId: string, projectId: string, runId: string, options: { acceptStoryChanged: boolean }, _actorId: string, nowIso: string): Promise<TitleScriptPlacement> {
    const run = this.runs.find((item) => item.id === runId && item.workspaceId === workspaceId && item.projectId === projectId);
    if (!run || isScriptBreakdownInput(run.input)) return { kind: "not_found" };
    const steps = this.steps.filter((item) => item.runId === runId && item.scriptSave !== null);
    if (run.state === "running" || steps.every((step) => step.state !== "completed")) return { kind: "not_ready" };
    const project = this.requireProject(projectId);
    const approved = project.approvedStoryId;
    if (!approved || project.currentStoryId !== approved) return { kind: "story_not_approved" };
    if (approved !== run.storyRevisionId && !options.acceptStoryChanged) return { kind: "story_changed" };
    const count = titleWritingEpisodeCount(run.input as TitleWritingFrozenInput);
    if (project.episodeCount !== count || project.episodes.size !== count
      || [...project.episodes.keys()].some((episodeNo) => episodeNo < 1 || episodeNo > count)) return { kind: "plan_mismatch" };
    for (const step of steps) {
      if (step.state !== "completed" || step.scriptSave === "saved") continue;
      const episode = project.episodes.get(episodeNoOf(step.stepKey) ?? 0);
      if (!episode) continue;
      if (episode.currentScriptId !== null) {
        Object.assign(step, { scriptSave: "conflict", updatedAt: nowIso });
        continue;
      }
      const id = randomUUID();
      episode.scripts.push({ id, text: formatTitleEpisode(step.output as EpisodeDraftCandidate), sourceStoryId: approved });
      episode.currentScriptId = id;
      Object.assign(step, { scriptSave: "saved", scriptRevisionId: id, updatedAt: nowIso });
    }
    run.updatedAt = nowIso;
    return { kind: "ok", bundle: this.bundle(run) };
  }

  // --- Script breakdown: a small model of one episode's scripts, scenes, shots and the project's characters. ---

  /** Test helper: an episode whose current script is `text` (approved unless said otherwise). */
  addBreakdownEpisode(options: { workspaceId: string; projectId: string; episodeNo: number; text: string; approved?: boolean; targetEpisodeSeconds?: number | null }): MemoryBreakdownEpisode {
    const episode: MemoryBreakdownEpisode = {
      workspaceId: options.workspaceId, projectId: options.projectId, episodeId: randomUUID(), episodeNo: options.episodeNo,
      targetEpisodeSeconds: options.targetEpisodeSeconds ?? null, scripts: [], currentScriptId: null, approvedScriptId: null,
    };
    this.breakdownEpisodes.set(episode.episodeId, episode);
    this.writeScript(episode.episodeId, options.text, options.approved ?? true);
    return episode;
  }

  /** Test helper standing in for a script save (and optionally its approval): the old script's scenes and shots go STALE. */
  writeScript(episodeId: string, text: string, approve = true): string {
    const episode = this.requireBreakdownEpisode(episodeId);
    const content = { text };
    const script: MemoryScript = { id: randomUUID(), revisionNo: episode.scripts.length + 1, content, contentHash: canonicalInputHash(content),
      reviewStatus: approve ? "APPROVED" : "DRAFT", freshnessStatus: "CURRENT" };
    const previous = episode.currentScriptId;
    episode.scripts.push(script);
    episode.currentScriptId = script.id;
    if (approve) episode.approvedScriptId = script.id;
    if (previous) {
      for (const scene of this.scenes) {
        for (const revision of scene.revisions) {
          if (revision.sourceScriptRevisionId !== previous) continue;
          revision.freshnessStatus = "STALE";
          for (const shot of this.shots.filter((item) => item.sourceSceneRevisionId === revision.id)) shot.freshnessStatus = "STALE";
        }
      }
    }
    return script.id;
  }

  /** Test helper standing in for an upstream story replacement: the current script stays current but goes STALE. */
  staleScript(episodeId: string): void {
    const episode = this.requireBreakdownEpisode(episodeId);
    episode.scripts.find((item) => item.id === episode.currentScriptId)!.freshnessStatus = "STALE";
  }

  addCharacter(projectId: string, name: string): MemoryCharacter {
    const character: MemoryCharacter = { projectId, characterId: randomUUID(), revisionId: randomUUID(), name, archived: false };
    this.characters.push(character);
    return character;
  }

  /** Test helper: a new current revision of the character; shots referencing the old one go STALE. */
  reviseCharacter(characterId: string): string {
    const character = this.characters.find((item) => item.characterId === characterId);
    if (!character) throw new Error("character missing");
    const previous = character.revisionId;
    character.revisionId = randomUUID();
    for (const shot of this.shots.filter((item) => item.characterRevisionIds.includes(previous))) shot.freshnessStatus = "STALE";
    return character.revisionId;
  }

  /** Test helper standing in for a person creating a scene in the editor. */
  addManualScene(episodeId: string, heading: string): MemoryScene {
    const episode = this.requireBreakdownEpisode(episodeId);
    const ordinal = this.scenes.filter((item) => item.episodeId === episodeId && !item.archived).length + 1;
    return this.createScene(episode, ordinal, heading, null, "");
  }

  /** Test helper standing in for a person saving a new scene revision; shots under the old revision go STALE. */
  editScene(sceneId: string, summary: string): string {
    const scene = this.requireScene(sceneId);
    const current = scene.revisions.find((item) => item.id === scene.currentRevisionId)!;
    const revision: MemorySceneRevision = { ...current, id: randomUUID(), summary, reviewStatus: "DRAFT", freshnessStatus: "CURRENT" };
    scene.revisions.push(revision);
    scene.currentRevisionId = revision.id;
    scene.rowVersion += 1;
    for (const shot of this.shots.filter((item) => item.sourceSceneRevisionId === current.id)) shot.freshnessStatus = "STALE";
    return revision.id;
  }

  /** Test helper standing in for a person approving the scene's current revision. */
  approveScene(sceneId: string): void {
    const scene = this.requireScene(sceneId);
    const revision = scene.revisions.find((item) => item.id === scene.currentRevisionId)!;
    revision.reviewStatus = "APPROVED";
    scene.approvedRevisionId = revision.id;
    scene.rowVersion += 1;
  }

  private createScene(episode: MemoryBreakdownEpisode, ordinal: number, heading: string, timeOfDay: string | null, summary: string): MemoryScene {
    const revision: MemorySceneRevision = { id: randomUUID(), sourceScriptRevisionId: episode.currentScriptId!, ordinal, heading, timeOfDay,
      summary, reviewStatus: "DRAFT", freshnessStatus: "CURRENT" };
    const scene: MemoryScene = { sceneId: randomUUID(), episodeId: episode.episodeId, rowVersion: 1, archived: false,
      revisions: [revision], currentRevisionId: revision.id, approvedRevisionId: null };
    this.scenes.push(scene);
    return scene;
  }

  async breakdownStorageReady(): Promise<boolean> {
    return this.ready && this.breakdownReady;
  }

  async findRunByKey(workspaceId: string, actorId: string, idempotencyKey: string): Promise<TitleRunBundle | null> {
    const run = this.runs.find((item) => item.workspaceId === workspaceId && item.actorId === actorId && item.idempotencyKey === idempotencyKey);
    return run ? this.bundle(run) : null;
  }

  async breakdownSource(workspaceId: string, projectId: string, episodeId: string): Promise<ScriptBreakdownSourceRead> {
    const episode = this.breakdownEpisodes.get(episodeId);
    if (!episode || episode.workspaceId !== workspaceId || episode.projectId !== projectId) return { kind: "not_found" };
    const script = episode.scripts.find((item) => item.id === episode.currentScriptId);
    if (!script) return { kind: "script_missing" };
    if (episode.approvedScriptId !== script.id || script.reviewStatus !== "APPROVED" || script.freshnessStatus !== "CURRENT") {
      return { kind: "script_review_required" };
    }
    const scenes = this.scenes.filter((item) => item.episodeId === episodeId && !item.archived);
    return {
      kind: "ok", episodeNo: episode.episodeNo, scriptRevisionId: script.id, scriptRevisionNo: script.revisionNo,
      scriptContentHash: script.contentHash, scriptContent: structuredClone(script.content), targetEpisodeSeconds: episode.targetEpisodeSeconds,
      characters: this.characters.filter((item) => item.projectId === projectId && !item.archived)
        .map((item) => ({ characterId: item.characterId, revisionId: item.revisionId, name: item.name })),
      scenes: scenes.map((item) => ({ sceneId: item.sceneId, rowVersion: item.rowVersion })),
      shots: this.shots.filter((item) => !item.archived && scenes.some((scene) => scene.sceneId === item.sceneId))
        .map((item) => ({ shotId: item.shotId, rowVersion: item.rowVersion })),
    };
  }

  async latestBreakdown(workspaceId: string, projectId: string, episodeId: string): Promise<TitleRunBundle | null> {
    const runs = this.runs.filter((item) => item.workspaceId === workspaceId && item.projectId === projectId
      && isScriptBreakdownInput(item.input) && item.input.episodeId === episodeId);
    const latest = runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0];
    return latest ? this.bundle(latest) : null;
  }

  async breakdownDetails(workspaceId: string, run: TitleRunRecord): Promise<ScriptBreakdownDetails> {
    if (!isScriptBreakdownInput(run.input) || run.workspaceId !== workspaceId) throw new Error("not a breakdown run of this workspace");
    const episode = this.requireBreakdownEpisode(run.input.episodeId);
    const current = episode.scripts.find((item) => item.id === episode.currentScriptId) ?? null;
    return {
      scenes: this.breakdownLinks.filter((link) => link.runId === run.id).sort((left, right) => left.ordinal - right.ordinal).map((link) => {
        const scene = this.requireScene(link.sceneId);
        const revision = scene.revisions.find((item) => item.id === scene.currentRevisionId) ?? null;
        return {
          key: link.sceneKey, ordinal: link.ordinal, sceneId: link.sceneId, sceneRevisionId: link.sceneRevisionId, shotSave: link.shotSave,
          placedSceneRevisionId: link.placedSceneRevisionId,
          current: { archived: scene.archived, currentRevisionId: scene.currentRevisionId, approvedRevisionId: scene.approvedRevisionId,
            reviewStatus: revision?.reviewStatus ?? null, freshnessStatus: revision?.freshnessStatus ?? null },
        };
      }),
      episodeScript: {
        currentRevisionId: current?.id ?? null,
        currentRevisionNo: current?.revisionNo ?? null,
        approved: current !== null && episode.approvedScriptId === current.id && current.reviewStatus === "APPROVED" && current.freshnessStatus === "CURRENT",
      },
    };
  }

  async saveBreakdown(workspaceId: string, runId: string, executorId: string, _actorId: string, nowIso: string): Promise<ScriptBreakdownSave | "lost"> {
    const run = this.requireRun(runId);
    if (!this.owns(run, workspaceId, executorId, nowIso) || !isScriptBreakdownInput(run.input)) return "lost";
    if ((run.breakdownSave ?? "pending") !== "pending") return run.breakdownSave!;
    const input = run.input;
    const step = this.requireStep(runId, SCRIPT_BREAKDOWN_STEP_KEY);
    if (step.state !== "completed" || !step.output) return "lost";
    const output = step.output as ScriptBreakdownOutput;
    const settle = (save: ScriptBreakdownSave): ScriptBreakdownSave => {
      Object.assign(run, { breakdownSave: save, updatedAt: nowIso });
      return save;
    };
    const episode = this.requireBreakdownEpisode(input.episodeId);
    const script = episode.scripts.find((item) => item.id === episode.currentScriptId);
    if (!script || script.id !== input.scriptRevisionId || episode.approvedScriptId !== script.id || script.reviewStatus !== "APPROVED"
      || script.freshnessStatus !== "CURRENT") return settle("source_changed");
    const referenced = new Set(output.shots.flatMap((shot) => shot.characterKeys));
    for (const frozen of input.characters.filter((item) => referenced.has(item.key))) {
      const character = this.characters.find((item) => item.characterId === frozen.characterId);
      if (!character || character.archived || character.revisionId !== frozen.revisionId) return settle("source_changed");
    }
    const scenes = this.scenes.filter((item) => item.episodeId === episode.episodeId && !item.archived);
    const shots = this.shots.filter((item) => !item.archived && scenes.some((scene) => scene.sceneId === item.sceneId));
    const scenesSame = scenes.length === input.replace.scenes.length && scenes.every((item) =>
      input.replace.scenes.some((frozen) => frozen.sceneId === item.sceneId && frozen.rowVersion === item.rowVersion));
    const shotsSame = shots.length === input.replace.shots.length && shots.every((item) =>
      input.replace.shots.some((frozen) => frozen.shotId === item.shotId && frozen.rowVersion === item.rowVersion));
    if (!scenesSame || !shotsSame) return settle("conflict");
    for (const shot of shots) Object.assign(shot, { archived: true, rowVersion: shot.rowVersion + 1 });
    for (const scene of scenes) Object.assign(scene, { archived: true, rowVersion: scene.rowVersion + 1 });
    output.scenes.forEach((generated, index) => {
      const scene = this.createScene(episode, index + 1, generated.heading, generated.timeOfDay.trim() || null, generated.description);
      this.breakdownLinks.push({ runId, sceneKey: generated.key, ordinal: index + 1, sceneId: scene.sceneId,
        sceneRevisionId: scene.currentRevisionId!, shotSave: "pending", placedSceneRevisionId: null });
    });
    return settle("saved");
  }

  async placeBreakdownShots(workspaceId: string, projectId: string, episodeId: string, runId: string, options: { acceptSceneChanged: boolean }, _actorId: string, nowIso: string): Promise<ScriptBreakdownPlacement> {
    const run = this.runs.find((item) => item.id === runId && item.workspaceId === workspaceId && item.projectId === projectId);
    if (!run || !isScriptBreakdownInput(run.input) || run.input.episodeId !== episodeId) return { kind: "not_found" };
    if (run.breakdownSave !== "saved") return { kind: "not_ready" };
    const input = run.input;
    const output = this.requireStep(runId, SCRIPT_BREAKDOWN_STEP_KEY).output as ScriptBreakdownOutput;
    const outcome: ScriptBreakdownPlacementOutcome = { placed: [], awaitingApproval: [], sceneChanged: [], charactersChanged: [], unavailable: [] };
    const pending = this.breakdownLinks.filter((item) => item.runId === runId && item.shotSave !== "saved")
      .sort((left, right) => left.ordinal - right.ordinal);
    if (pending.length === 0) return { kind: "ok", bundle: this.bundle(run), outcome };
    const episode = this.requireBreakdownEpisode(episodeId);
    const script = episode.scripts.find((item) => item.id === input.scriptRevisionId);
    const sourceCurrent = episode.currentScriptId === input.scriptRevisionId && episode.approvedScriptId === input.scriptRevisionId
      && script?.reviewStatus === "APPROVED" && script.freshnessStatus === "CURRENT";
    if (!sourceCurrent) return { kind: "not_ready" };
    for (const link of pending) {
      const scene = this.requireScene(link.sceneId);
      const approved = scene.revisions.find((item) => item.id === scene.approvedRevisionId);
      if (scene.archived) { outcome.unavailable.push(link.sceneKey); continue; }
      if (!approved || scene.currentRevisionId !== approved.id || approved.reviewStatus !== "APPROVED") { outcome.awaitingApproval.push(link.sceneKey); continue; }
      if (approved.freshnessStatus !== "CURRENT" || approved.sourceScriptRevisionId !== input.scriptRevisionId) {
        outcome.unavailable.push(link.sceneKey); continue;
      }
      // Scene-change consent accepts an edited scene of this script, never a newer script or existing manual shots.
      if (approved.id !== link.sceneRevisionId && !options.acceptSceneChanged) { outcome.sceneChanged.push(link.sceneKey); continue; }
      if (this.shots.some((shot) => shot.sceneId === scene.sceneId && !shot.archived)) {
        outcome.unavailable.push(link.sceneKey); continue;
      }
      const generatedScene = output.scenes.find((item) => item.key === link.sceneKey)!;
      const planned = shotsOfScene(output, link.sceneKey);
      const characterRevisions = planned.map((shot) => shot.characterKeys.map((key) => input.characters.find((item) => item.key === key)!));
      if (characterRevisions.flat().some((frozen) => {
        const character = this.characters.find((item) => item.characterId === frozen.characterId);
        return !character || character.archived || character.revisionId !== frozen.revisionId;
      })) { outcome.charactersChanged.push(link.sceneKey); continue; }
      planned.forEach((shot, index) => {
        this.shots.push({ shotId: randomUUID(), sceneId: scene.sceneId, rowVersion: 1, archived: false, revisionId: randomUUID(),
          sourceSceneRevisionId: approved.id, ordinal: index + 1, shotType: shot.shotType, camera: shot.camera, action: shot.action,
          dialogue: breakdownDialogueText(shot), plannedDurationMs: shot.plannedSeconds * 1000,
          promptText: breakdownShotPromptText(generatedScene, shot), characterRevisionIds: characterRevisions[index]!.map((item) => item.revisionId),
          freshnessStatus: "CURRENT" });
        scene.rowVersion += 1;
      });
      Object.assign(link, { shotSave: "saved", placedSceneRevisionId: approved.id });
      outcome.placed.push(link.sceneKey);
    }
    run.updatedAt = nowIso;
    return { kind: "ok", bundle: this.bundle(run), outcome };
  }

  private requireBreakdownEpisode(id: string): MemoryBreakdownEpisode {
    const episode = this.breakdownEpisodes.get(id);
    if (!episode) throw new Error("episode missing");
    return episode;
  }

  private requireScene(id: string): MemoryScene {
    const scene = this.scenes.find((item) => item.sceneId === id);
    if (!scene) throw new Error("scene missing");
    return scene;
  }

  private requireRun(id: string): TitleRunRecord {
    const run = this.runs.find((item) => item.id === id);
    if (!run) throw new Error("title writing run missing");
    return run;
  }

  private requireStep(runId: string, stepKey: TitleWritingStepKey): TitleStepRecord {
    const step = this.steps.find((item) => item.runId === runId && item.stepKey === stepKey);
    if (!step) throw new Error("title writing step missing");
    return step;
  }

  private requireCall(id: string): TitleCallRecord {
    const call = this.calls.find((item) => item.id === id);
    if (!call) throw new Error("title writing call missing");
    return call;
  }

  private requireProject(id: string): MemoryProject {
    const project = this.projects.get(id);
    if (!project) throw new Error("project missing");
    return project;
  }
}
