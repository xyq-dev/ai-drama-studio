import { createHash, randomUUID } from "node:crypto";
import type {
  TitleCallFinish,
  TitleCallRecord,
  TitleCallReservation,
  TitleResumePreparation,
  TitleRunBundle,
  TitleRunCreation,
  TitleRunRecord,
  TitleScriptPlacement,
  TitleStepRecord,
  TitleWritingStore,
} from "@ai-drama/contracts";
import {
  TITLE_WRITING_INPUT_SCHEMA,
  TITLE_WRITING_JSON_SCHEMAS,
  TITLE_WRITING_PROMPT_VERSION,
  TITLE_WRITING_STEP_KEYS,
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
} from "@ai-drama/contracts";
import {
  buildTitleWritingPrompt,
  canonicalInputHash,
  episodeNoOf,
  formatTitleEpisode,
  formatTitleStory,
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

/** Five required steps plus three resends for rejected or confirmed-uncertain steps. Never more per run. */
export const TITLE_WRITING_CALL_CAP_PER_RUN = 8;
export const TITLE_WRITING_MAX_CALLS_PER_DAY_DEFAULT = 30;
export const TITLE_WRITING_MAX_ACTIVE_RUNS_DEFAULT = 1;
/** The executor lease covers the capped send time twice over, as in the Qwen web writing store. */
export const TITLE_WRITING_LEASE_MS = TEXT_WRITING_TIMEOUT_MS * 2;
export const TITLE_WRITING_LOST_BEFORE_SEND = "executor_lost_before_send";
export const TITLE_WRITING_LOST_AFTER_SEND = "executor_lost";

export type {
  TitleCallFinish,
  TitleCallRecord,
  TitleCallReservation,
  TitleResumePreparation,
  TitleRunBundle,
  TitleRunCreation,
  TitleRunRecord,
  TitleScriptPlacement,
  TitleStepRecord,
  TitleWritingStore,
};

export function hashTitleWritingInput(projectId: string, input: TitleWritingFrozenInput): string {
  return canonicalInputHash({ projectId, input });
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
}): TitleRunRecord {
  const input: TitleWritingFrozenInput = {
    schema: TITLE_WRITING_INPUT_SCHEMA,
    promptVersion: TITLE_WRITING_PROMPT_VERSION,
    title: options.title,
    settings: options.settings,
    providerKey: options.providerKey,
    model: options.model,
  };
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
    callCap: TITLE_WRITING_CALL_CAP_PER_RUN,
    callsUsed: 0,
    storySave: "pending",
    storyRevisionId: null,
    createdAt,
    updatedAt: createdAt,
  };
}

export function initialSteps(run: TitleRunRecord): TitleStepRecord[] {
  return TITLE_WRITING_STEP_KEYS.map((stepKey, ordinal) => ({
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
  for (const key of ["episode:1", "episode:2", "episode:3"] as const) {
    const step = byKey.get(key);
    if (step?.state !== "completed" || !step.output) break;
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
  const context = contextFromSteps(bundle.steps);
  if (!context.concept || !context.outline) return null;
  try {
    return formatTitleStory(bundle.run.input.title, context.concept, context.outline);
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
  return {
    runId: run.id,
    projectId: run.projectId,
    title: run.input.title,
    settings: run.input.settings,
    providerKey: run.input.providerKey,
    model: run.input.model,
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
      output: step.state === "completed" ? step.output : null,
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
    const adapter = (this.deps.adapters ?? WRITING_ADAPTERS)[run.input.providerKey];
    const prompt = buildTitleWritingPrompt(next.stepKey, run.input, contextForStep(next.stepKey, steps));
    const schema = TITLE_WRITING_JSON_SCHEMAS[prompt.schemaKind];
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
    if (!await this.deps.store.markCallSubmitted(this.deps.workspaceId, call.id, this.executorId, submittedAt.toISOString(), this.lease(submittedAt))) return false;

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
      const checked = validateTitleWritingOutput(next.stepKey, exchange.content);
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
}

interface MemoryProject {
  workspaceId: string;
  stories: Array<{ id: string; text: string; reviewStatus: "DRAFT" | "APPROVED" }>;
  currentStoryId: string | null;
  approvedStoryId: string | null;
  episodes: Map<number, { id: string; currentScriptId: string | null; scripts: Array<{ id: string; text: string; sourceStoryId: string }> }>;
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
  ready = true;

  addProject(workspaceId: string, projectId: string): MemoryProject {
    const project: MemoryProject = { workspaceId, stories: [], currentStoryId: null, approvedStoryId: null, episodes: new Map() };
    this.projects.set(projectId, project);
    return project;
  }

  /** Test helper standing in for the person's review: approval creates the three episodes like the real chain. */
  approveCurrentStory(projectId: string): void {
    const project = this.requireProject(projectId);
    const story = project.stories.find((item) => item.id === project.currentStoryId);
    if (!story) throw new Error("no current story");
    story.reviewStatus = "APPROVED";
    project.approvedStoryId = story.id;
    for (const episodeNo of [1, 2, 3]) {
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

  async createRun(run: TitleRunRecord, limits: { maxActiveRuns: number }): Promise<TitleRunCreation> {
    const existing = this.runs.find((item) => item.workspaceId === run.workspaceId && item.actorId === run.actorId
      && item.idempotencyKey === run.idempotencyKey);
    if (existing) return { kind: existing.inputHash === run.inputHash ? "existing" : "conflict", bundle: this.bundle(existing) };
    const sameProject = this.runs.find((item) => item.projectId === run.projectId && item.state === "running");
    if (sameProject) return { kind: "active", bundle: this.bundle(sameProject) };
    if (this.runs.filter((item) => item.workspaceId === run.workspaceId && item.state === "running").length >= limits.maxActiveRuns) {
      return { kind: "blocked", code: "TITLE_WRITING_ACTIVE_RUN_CAP" };
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
    const runs = this.runs.filter((item) => item.workspaceId === workspaceId && item.projectId === projectId);
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

  async markCallSubmitted(workspaceId: string, callId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<boolean> {
    const call = this.requireCall(callId);
    const run = this.requireRun(call.runId);
    if (call.state !== "reserved" || call.executorId !== executorId || !this.owns(run, workspaceId, executorId, nowIso)) return false;
    call.state = "submitted";
    Object.assign(this.requireStep(call.runId, call.stepKey), { state: "submitted", updatedAt: nowIso });
    Object.assign(run, { leaseUntil, updatedAt: nowIso });
    return true;
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

  async prepareResume(workspaceId: string, projectId: string, runId: string, options: { confirmUncertain: boolean; maxActiveRuns: number }, nowIso: string): Promise<TitleResumePreparation> {
    const run = this.runs.find((item) => item.id === runId && item.workspaceId === workspaceId && item.projectId === projectId);
    if (!run) return { kind: "not_found" };
    if (run.state === "running") return { kind: "active" };
    if (run.state === "completed") return { kind: "not_resumable" };
    if (this.runs.some((item) => item.projectId === projectId && item.state === "running")) return { kind: "active" };
    if (this.runs.filter((item) => item.workspaceId === workspaceId && item.state === "running").length >= options.maxActiveRuns) {
      return { kind: "active_cap" };
    }
    const steps = this.steps.filter((item) => item.runId === runId);
    if (steps.some((step) => step.state === "unknown") && !options.confirmUncertain) return { kind: "needs_confirmation" };
    const redo = steps.filter((step) => step.state === "unknown" || step.state === "rejected" || step.state === "canceled");
    if (redo.length === 0 && run.storySave !== "pending") return { kind: "not_resumable" };
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
    if (!run) return { kind: "not_found" };
    const steps = this.steps.filter((item) => item.runId === runId && item.scriptSave !== null);
    if (run.state === "running" || steps.every((step) => step.state !== "completed")) return { kind: "not_ready" };
    const project = this.requireProject(projectId);
    const approved = project.approvedStoryId;
    if (!approved || project.currentStoryId !== approved) return { kind: "story_not_approved" };
    if (approved !== run.storyRevisionId && !options.acceptStoryChanged) return { kind: "story_changed" };
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
