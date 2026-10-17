import { createHash, randomUUID } from "node:crypto";
import {
  AUTO_CREATION_CHECKS_VERSION,
  AUTO_CREATION_INPUT_SCHEMA,
  AUTO_CREATION_PROMPT_MAX_CHARS,
  AUTO_CREATION_PROMPT_VERSION,
  AUTO_CREATION_SELECTION_RULES,
  TITLE_WRITING_CANCELED_BEFORE_SEND,
  autoCreationHardCap,
  autoCreationJsonSchema,
  autoCreationNormalCalls,
  autoCreationRevisionsPerRound,
  autoCreationWorstCalls,
  autoStageEpisodeNo,
  autoStageKind,
  autoStageRound,
  currentUncertainCallIds,
  frozenProviderAdapter,
  isLegacyDeepseekRun,
  type AutoCallFinish,
  type AutoCallRecord,
  type AutoCallReservation,
  type AutoCreationAuthorization,
  type AutoCreationConstraints,
  type AutoCreationFrozenInput,
  type AutoCreationMaterial,
  type AutoCreationQuality,
  type AutoCreationRunView,
  type AutoCreationStore,
  type AutoResumePreparation,
  type AutoReviewOutput,
  type AutoRunBundle,
  type AutoRunCreation,
  type AutoRunRecord,
  type AutoScriptPlacement,
  type AutoSourcesOutput,
  type AutoStageOutput,
  type AutoStageRecord,
  type TitleWritingProviderKey,
  type TitleWritingRunState,
  type TitleWritingStoredProviderKey,
} from "@ai-drama/contracts";
import {
  autoContextFromStages,
  autoStageDependencies,
  buildAutoCreationPrompt,
  canonicalInputHash,
  collectSources,
  formatAutoEpisode,
  formatAutoStory,
  openIssues,
  revisionTargets,
  validateAutoStageOutput,
  type FetchedPage,
} from "@ai-drama/domain";
import {
  TEXT_WRITING_MAX_OUTPUT_TOKENS,
  TEXT_WRITING_TIMEOUT_MS,
  WRITING_ADAPTERS,
  providerConfigFor,
  sendWriting,
  type WritingAdapter,
  type WritingProviderConfig,
  type WritingTransport,
} from "./text-writing";
import { TITLE_WRITING_LOST_AFTER_SEND, TITLE_WRITING_LOST_BEFORE_SEND } from "./title-writing-engine";

export const AUTO_CREATION_LEASE_MS = TEXT_WRITING_TIMEOUT_MS * 2;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Identity of a start: the work and the frozen creative input. How the request was authorized (session or token) is
 * recorded with the run but is not part of the identity, so a lost receipt replayed under the other proof still finds it.
 */
export function hashAutoCreationInput(projectId: string, input: AutoCreationFrozenInput): string {
  const { authorization: _authorization, ...creative } = input;
  return canonicalInputHash({ projectId, input: creative });
}

export function hashAutoResume(runId: string, confirmed: readonly string[]): string {
  return canonicalInputHash({ runId, kind: "auto-creation-resume", confirmUncertainCallIds: [...confirmed].sort() });
}

export function newAutoRun(options: {
  workspaceId: string;
  projectId: string;
  actorId: string;
  idempotencyKey: string;
  idea: string;
  constraints: AutoCreationConstraints;
  materials: AutoCreationMaterial[];
  referenceUrls: string[];
  researchFetch: boolean;
  episodeCount: number;
  episodeSeconds: number;
  revisionRounds: number;
  callBudget: number;
  providerKey: TitleWritingStoredProviderKey;
  model: string;
  authorization: AutoCreationAuthorization;
  now: Date;
}): AutoRunRecord {
  const input: AutoCreationFrozenInput = {
    schema: AUTO_CREATION_INPUT_SCHEMA,
    promptVersion: AUTO_CREATION_PROMPT_VERSION,
    selectionRules: AUTO_CREATION_SELECTION_RULES,
    checksVersion: AUTO_CREATION_CHECKS_VERSION,
    idea: options.idea,
    constraints: options.constraints,
    materials: options.materials,
    referenceUrls: options.referenceUrls,
    researchFetch: options.researchFetch,
    episodeCount: options.episodeCount,
    episodeSeconds: options.episodeSeconds,
    revisionRounds: options.revisionRounds,
    callBudget: options.callBudget,
    maxOutputTokens: TEXT_WRITING_MAX_OUTPUT_TOKENS,
    providerKey: options.providerKey,
    model: options.model,
    ...frozenProviderAdapter(options.providerKey),
    authorization: options.authorization,
  };
  const createdAt = options.now.toISOString();
  return {
    id: randomUUID(),
    workspaceId: options.workspaceId,
    projectId: options.projectId,
    actorId: options.actorId,
    idempotencyKey: options.idempotencyKey,
    inputHash: hashAutoCreationInput(options.projectId, input),
    input,
    state: "running",
    errorCode: null,
    cancelRequestedAt: null,
    executorId: null,
    leaseUntil: null,
    callCap: options.callBudget,
    callsUsed: 0,
    revisionRoundsUsed: 0,
    quality: "pending",
    storySave: "pending",
    storyRevisionId: null,
    createdAt,
    updatedAt: createdAt,
  };
}

export function autoUncertainCallIds(stages: readonly AutoStageRecord[], calls: readonly AutoCallRecord[]): string[] {
  return currentUncertainCallIds(
    stages.map((stage) => ({ stepKey: stage.stageKey as never, state: stage.state, attemptNo: stage.attemptNo })),
    calls.map((call) => ({ callId: call.id, stepKey: call.stageKey as never, attemptNo: call.attemptNo, state: call.state })),
  );
}

/** The current version of every episode: its latest completed revision, else the episode stage. */
export function currentEpisodeVersions(stages: readonly AutoStageRecord[]): Record<string, string> {
  const context = autoContextFromStages(stages);
  const result: Record<string, string> = {};
  for (const [episodeNo, value] of context.episodes) result[`episode:${String(episodeNo)}`] = value.stageKey;
  return result;
}

/** Public view: no executor, key, hashes of requests, raw responses or credentials. */
export function autoRunView(bundle: AutoRunBundle): AutoCreationRunView {
  const { run } = bundle;
  const input = run.input;
  const stages = [...bundle.stages].sort((a, b) => a.ordinal - b.ordinal);
  const current = currentEpisodeVersions(stages);
  const currentKeys = new Set(Object.values(current));
  const hashes = new Map(stages.filter((stage) => stage.outputHash).map((stage) => [stage.stageKey, stage.outputHash!] as const));
  const sources = stages.find((stage) => stage.stageKey === "sources" && stage.state === "completed")?.output as AutoSourcesOutput | undefined;
  const reviews = stages.filter((stage) => autoStageKind(stage.stageKey) === "review" && stage.state === "completed");
  const lastReview = reviews.at(-1)?.output as AutoReviewOutput | undefined;
  const allDone = stages.every((stage) => stage.state === "completed");
  return {
    runId: run.id,
    projectId: run.projectId,
    inputVersion: input.schema,
    promptVersion: input.promptVersion,
    idea: input.idea,
    constraints: input.constraints,
    episodeCount: input.episodeCount,
    episodeSeconds: input.episodeSeconds,
    providerKey: input.providerKey,
    model: input.model,
    authorization: input.authorization,
    researchFetch: input.researchFetch,
    researchMode: sources?.researchMode ?? null,
    state: run.state,
    errorCode: run.errorCode,
    cancelRequested: run.cancelRequestedAt !== null,
    budget: {
      normalCalls: autoCreationNormalCalls(input.episodeCount),
      worstCalls: autoCreationWorstCalls(input.episodeCount, input.revisionRounds),
      hardCap: autoCreationHardCap(input.episodeCount, input.revisionRounds),
      callBudget: input.callBudget,
      revisionRounds: input.revisionRounds,
      revisionsPerRound: autoCreationRevisionsPerRound(input.episodeCount),
      maxOutputTokensPerCall: input.maxOutputTokens,
      maxPromptChars: AUTO_CREATION_PROMPT_MAX_CHARS,
      billing: "unknown",
    },
    callsUsed: run.callsUsed,
    callCap: run.callCap,
    revisionRoundsUsed: run.revisionRoundsUsed,
    quality: run.quality,
    openIssues: run.quality === "needs_work" && lastReview ? openIssues(lastReview) : [],
    storySave: run.storySave,
    storyRevisionId: run.storyRevisionId,
    packageStatus: allDone && run.state !== "running" ? "ready" : run.state === "running" ? "in_progress" : "incomplete",
    videoStatus: "not_started",
    currentEpisodes: current,
    stages: stages.map((stage) => {
      const kind = autoStageKind(stage.stageKey);
      const episodeNo = autoStageEpisodeNo(stage.stageKey);
      const isEpisodeVersion = (kind === "episode" || kind === "revise") && stage.state === "completed";
      const changed = Object.entries(stage.dependsOn ?? {}).some(([key, hash]) => {
        const depEpisode = autoStageEpisodeNo(key);
        // A revision is built from its own episode's earlier version: that version being replaced is the point of it.
        if (depEpisode !== null && kind === "revise" && depEpisode === episodeNo) return false;
        if (depEpisode !== null && current[`episode:${String(depEpisode)}`] !== key) return true;
        return hashes.get(key) !== hash;
      });
      return {
        stageKey: stage.stageKey,
        kind,
        state: stage.state,
        attemptNo: stage.attemptNo,
        errorCode: stage.errorCode,
        output: stage.state === "completed" ? stage.output : null,
        upstreamChanged: stage.state === "completed" && kind !== "review" && changed,
        supersededBy: isEpisodeVersion && !currentKeys.has(stage.stageKey) && episodeNo !== null ? current[`episode:${String(episodeNo)}`] ?? null : null,
        scriptSave: stage.scriptSave,
        scriptRevisionId: stage.scriptRevisionId,
      };
    }),
    calls: [...bundle.calls].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((call) => ({
      callId: call.id, stageKey: call.stageKey, attemptNo: call.attemptNo, providerKey: call.providerKey, model: call.model,
      responseModel: call.responseModel, providerRequestId: call.providerRequestId, state: call.state, errorCode: call.errorCode,
      usage: call.usage, billingStatus: "unknown", createdAt: call.createdAt, finishedAt: call.finishedAt,
    })),
    legacyProviderRun: isLegacyDeepseekRun(input),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

/** The scripts a placement writes: the current version of every episode, formatted for the script editor. */
export function autoScriptsOf(bundle: AutoRunBundle): Array<{ episodeNo: number; stageKey: string; text: string }> {
  const context = autoContextFromStages(bundle.stages);
  if (!context.bible) return [];
  return [...context.episodes.entries()].sort(([a], [b]) => a - b)
    .map(([episodeNo, value]) => ({ episodeNo, stageKey: value.stageKey, text: formatAutoEpisode(value.episode, context.bible!) }));
}

export interface AutoCreationEngineDeps {
  workspaceId: string;
  store: AutoCreationStore;
  providers: Record<TitleWritingProviderKey, WritingProviderConfig>;
  transport: WritingTransport;
  maxCallsPerDay: number;
  /** Reads public pages for a run that froze researchFetch = true. Absent: such pages are recorded as not read. */
  fetchPages?: (urls: readonly string[]) => Promise<FetchedPage[]>;
  /** The public URLs a run with researchFetch reads besides its own reference URLs (the official entries). */
  defaultResearchUrls?: readonly string[];
  adapters?: Readonly<Record<TitleWritingProviderKey, WritingAdapter>>;
  clock?: () => Date;
  executorId?: string;
  leaseMs?: number;
  timeoutMs?: number;
  send?: typeof sendWriting;
}

/**
 * Drives automatic creation runs inside the API process: one stage per pass, each pass re-reading the stored run.
 * A completed stage is never sent again; an uncertain call stops the run for a person; a revision round is a new,
 * budgeted stage appended only after a review asked for it and only when the run's own call budget still covers it.
 */
export class AutoCreationEngine {
  readonly executorId: string;
  readonly workspaceId: string;
  private readonly running = new Set<string>();

  constructor(private readonly deps: AutoCreationEngineDeps) {
    this.executorId = deps.executorId ?? `auto-creation:${randomUUID()}`;
    this.workspaceId = deps.workspaceId;
  }

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  private lease(from: Date): string {
    return new Date(from.getTime() + (this.deps.leaseMs ?? AUTO_CREATION_LEASE_MS)).toISOString();
  }

  async drive(runId: string): Promise<void> {
    if (this.running.has(runId)) return;
    this.running.add(runId);
    try {
      const claimedAt = this.now();
      if (!await this.deps.store.claimRun(this.workspaceId, runId, this.executorId, claimedAt.toISOString(), this.lease(claimedAt))) return;
      while (await this.advance(runId)) {
        // One stage per pass.
      }
    } finally {
      this.running.delete(runId);
    }
  }

  async maintain(limit = 5): Promise<void> {
    const nowIso = this.now().toISOString();
    await this.deps.store.recoverExpired(this.workspaceId, nowIso);
    for (const runId of await this.deps.store.listClaimable(this.workspaceId, nowIso, limit)) await this.drive(runId);
  }

  private async finish(runId: string, state: Exclude<TitleWritingRunState, "running">, errorCode: string | null): Promise<false> {
    await this.deps.store.finishRun(this.workspaceId, runId, this.executorId, state, errorCode, this.now().toISOString());
    return false;
  }

  private async advance(runId: string): Promise<boolean> {
    const bundle = await this.deps.store.getRunById(this.workspaceId, runId);
    if (!bundle || bundle.run.workspaceId !== this.workspaceId || bundle.run.state !== "running" || bundle.run.executorId !== this.executorId) return false;
    const { run } = bundle;
    if (run.cancelRequestedAt !== null) return this.finish(runId, "canceled", null);
    const stages = [...bundle.stages].sort((a, b) => a.ordinal - b.ordinal);
    const anyCompleted = stages.some((stage) => stage.state === "completed" && stage.stageKey !== "sources");
    const next = stages.find((stage) => stage.state !== "completed");
    if (!next) return this.afterStages(bundle, stages);
    if (next.state === "unknown") return this.finish(runId, "needs_attention", next.errorCode ?? "uncertain_call");
    if (next.state === "rejected") return this.finish(runId, anyCompleted ? "partial" : "failed", next.errorCode);
    if (next.state === "reserved" || next.state === "submitted") return false;
    if (next.state === "canceled") return this.finish(runId, "canceled", null);
    if (next.stageKey === "sources") {
      const urls = run.input.researchFetch ? [...new Set([...(this.deps.defaultResearchUrls ?? []), ...run.input.referenceUrls])] : [];
      const pages = urls.length > 0 && this.deps.fetchPages ? await this.deps.fetchPages(urls) : [];
      const output = collectSources(run.input, pages, this.now().toISOString());
      return this.deps.store.completeLocalStage(this.workspaceId, runId, this.executorId, "sources", output, canonicalInputHash(output), this.now().toISOString());
    }
    if (isLegacyDeepseekRun(run.input)) return this.finish(runId, "needs_attention", "legacy_provider_run");
    // Never another provider or model: the run's own, frozen ones, or nothing.
    const provider = providerConfigFor(this.deps.providers, run.input.providerKey);
    const adapter = provider ? (this.deps.adapters ?? WRITING_ADAPTERS)[provider.providerKey] : undefined;
    if (!provider || !adapter || !provider.ok || !provider.models.includes(run.input.model)) {
      return this.finish(runId, "needs_attention", "provider_unconfigured");
    }
    const context = autoContextFromStages(stages);
    const prompt = buildAutoCreationPrompt(next.stageKey, run.input, context);
    if (prompt.system.length + prompt.user.length > AUTO_CREATION_PROMPT_MAX_CHARS) {
      return this.finish(runId, "needs_attention", "prompt_too_large");
    }
    const schema = autoCreationJsonSchema(prompt.kind, run.input.episodeCount);
    const request = {
      model: run.input.model,
      system: prompt.system,
      user: prompt.user,
      schemaName: schema.name,
      jsonSchema: schema.schema,
      maxOutputTokens: run.input.maxOutputTokens,
    };
    const reservedAt = this.now();
    const call: AutoCallRecord = {
      id: randomUUID(),
      runId,
      workspaceId: this.workspaceId,
      stageKey: next.stageKey,
      attemptNo: next.attemptNo + 1,
      providerKey: run.input.providerKey,
      model: run.input.model,
      requestHash: sha256(`${provider.url}\n${adapter.buildBody(request)}`),
      state: "reserved",
      executorId: this.executorId,
      providerRequestId: null,
      responseModel: null,
      usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null },
      errorCode: null,
      createdAt: reservedAt.toISOString(),
      finishedAt: null,
    };
    const reservation: AutoCallReservation = await this.deps.store.reserveCall(call, {
      sinceIso: new Date(reservedAt.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      maxCallsPerDay: this.deps.maxCallsPerDay,
    }, reservedAt.toISOString(), this.lease(reservedAt));
    if (reservation.kind === "lost") return false;
    if (reservation.kind === "canceled") return this.finish(runId, "canceled", null);
    if (reservation.kind === "blocked") return this.finish(runId, anyCompleted ? "partial" : "failed", reservation.code);
    const submittedAt = this.now();
    const submission = await this.deps.store.markCallSubmitted(this.workspaceId, call.id, this.executorId, submittedAt.toISOString(), this.lease(submittedAt));
    if (submission === "canceled") return this.finish(runId, "canceled", null);
    if (submission !== "submitted") return false;
    const exchange = await (this.deps.send ?? sendWriting)({
      adapter,
      url: provider.url,
      apiKey: provider.apiKey,
      workspaceId: provider.workspaceId,
      request,
      transport: this.deps.transport,
      ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
    });
    let patch: AutoCallFinish;
    const common = { providerRequestId: exchange.providerRequestId, responseModel: exchange.responseModel, usage: exchange.usage };
    if (exchange.outcome === "answered" && exchange.content !== null) {
      const checked = validateAutoStageOutput(next.stageKey, exchange.content, run.input, context);
      patch = checked.ok
        ? { state: "completed", errorCode: null, output: checked.output, outputHash: canonicalInputHash(checked.output),
          dependsOn: autoStageDependencies(next.stageKey, stages), ...common }
        : { state: "rejected", errorCode: checked.code, output: null, outputHash: null, dependsOn: null, ...common };
    } else {
      patch = { state: exchange.outcome === "unknown" ? "unknown" : "rejected", errorCode: exchange.errorCode ?? "invalid_output",
        output: null, outputHash: null, dependsOn: null, ...common };
    }
    return this.deps.store.finishCall(this.workspaceId, call.id, this.executorId, patch, this.now().toISOString());
  }

  /**
   * Every stage completed; the last one is a review. Either a revision round is appended (blocking issues on
   * episodes, a round left, and the run's call budget covers the whole round), or the run is settled: the machine
   * draft is saved and the quality recorded. Exhausted rounds or budget leave quality at needs_work, never passed.
   */
  private async afterStages(bundle: AutoRunBundle, stages: readonly AutoStageRecord[]): Promise<boolean> {
    const { run } = bundle;
    const lastReviewStage = [...stages].reverse().find((stage) => autoStageKind(stage.stageKey) === "review");
    if (!lastReviewStage) return this.finish(run.id, "failed", "invalid_step");
    const review = lastReviewStage.output as AutoReviewOutput;
    const round = autoStageRound(lastReviewStage.stageKey)!;
    const quality: Exclude<AutoCreationQuality, "pending"> = review.passed ? "passed" : "needs_work";
    let errorCode: string | null = null;
    if (!review.passed) {
      const targets = revisionTargets(review, run.input.episodeCount);
      const roundsLeft = round <= run.input.revisionRounds && run.revisionRoundsUsed < round;
      if (targets.length > 0 && roundsLeft) {
        // The whole round must fit the run's own budget before any of it is planned.
        if (run.storySave === "pending" && run.callsUsed + targets.length + 1 <= run.callCap) {
          const keys = [...targets.map((episodeNo) => `revise:${String(round)}:episode:${String(episodeNo)}`), `review:${String(round + 1)}`];
          return this.deps.store.appendRound(this.workspaceId, run.id, this.executorId, keys, round, this.now().toISOString());
        }
        errorCode = "revision_budget_exhausted";
      } else {
        errorCode = targets.length > 0 ? "revision_rounds_exhausted" : "unrevisable_issues";
      }
    }
    if (run.storySave === "saved") return this.finish(run.id, "completed", errorCode);
    if (run.storySave === "conflict") return this.finish(run.id, "needs_attention", "story_conflict");
    const text = formatAutoStory(run.id, quality, autoContextFromStages(stages));
    if (text === null) return this.finish(run.id, "needs_attention", "story_too_large");
    const saved = await this.deps.store.saveStory(this.workspaceId, run.id, this.executorId, text, quality, this.now().toISOString());
    if (saved === "lost") return false;
    if (saved === "conflict") return this.finish(run.id, "needs_attention", "story_conflict");
    return this.finish(run.id, "completed", errorCode);
  }
}

// ---------------------------------------------------------------------------------------------------------------

interface MemoryAutoProject {
  workspaceId: string;
  episodeCount: number;
  stories: Array<{ id: string; text: string; reviewStatus: "DRAFT" | "APPROVED"; createdBy: string }>;
  currentStoryId: string | null;
  approvedStoryId: string | null;
  episodes: Map<number, { id: string; currentScriptId: string | null; scripts: Array<{ id: string; text: string; createdBy: string }> }>;
}

function expired(leaseUntil: string | null, nowIso: string): boolean {
  return leaseUntil === null || leaseUntil <= nowIso;
}

/** In-process store for tests: each method reads and writes without an await in between. */
export class InMemoryAutoCreationStore implements AutoCreationStore {
  readonly runs: AutoRunRecord[] = [];
  readonly stages: AutoStageRecord[] = [];
  readonly calls: AutoCallRecord[] = [];
  readonly resumes: Array<{ runId: string; key: string; requestHash: string }> = [];
  readonly projects = new Map<string, MemoryAutoProject>();
  /** Calls of title writing and online candidates in the same workspace (the shared daily cap). */
  readonly otherCalls: Array<{ workspaceId: string; createdAt: string }> = [];
  /** Projects with a running title writing run. */
  readonly titleRunning = new Map<string, string>();
  ready = true;

  addProject(workspaceId: string, projectId: string, episodeCount = 1): MemoryAutoProject {
    const project: MemoryAutoProject = { workspaceId, episodeCount, stories: [], currentStoryId: null, approvedStoryId: null, episodes: new Map() };
    this.projects.set(projectId, project);
    return project;
  }

  approveCurrentStory(projectId: string): void {
    const project = this.projects.get(projectId)!;
    const story = project.stories.find((item) => item.id === project.currentStoryId)!;
    story.reviewStatus = "APPROVED";
    project.approvedStoryId = story.id;
    for (let episodeNo = 1; episodeNo <= project.episodeCount; episodeNo += 1) {
      if (!project.episodes.has(episodeNo)) project.episodes.set(episodeNo, { id: randomUUID(), currentScriptId: null, scripts: [] });
    }
  }

  writeHumanStory(projectId: string, text: string): string {
    const project = this.projects.get(projectId)!;
    const id = randomUUID();
    project.stories.push({ id, text, reviewStatus: "DRAFT", createdBy: "person" });
    project.currentStoryId = id;
    return id;
  }

  writeHumanScript(projectId: string, episodeNo: number, text: string): void {
    const episode = this.projects.get(projectId)!.episodes.get(episodeNo)!;
    const id = randomUUID();
    episode.scripts.push({ id, text, createdBy: "person" });
    episode.currentScriptId = id;
  }

  private bundle(run: AutoRunRecord): AutoRunBundle {
    return structuredClone({ run, stages: this.stages.filter((stage) => stage.runId === run.id), calls: this.calls.filter((call) => call.runId === run.id) });
  }

  private run(runId: string): AutoRunRecord {
    const run = this.runs.find((item) => item.id === runId);
    if (!run) throw new Error("run not found");
    return run;
  }

  private stage(runId: string, stageKey: string): AutoStageRecord {
    const stage = this.stages.find((item) => item.runId === runId && item.stageKey === stageKey);
    if (!stage) throw new Error("stage not found");
    return stage;
  }

  private owns(run: AutoRunRecord, workspaceId: string, executorId: string, nowIso: string): boolean {
    return run.workspaceId === workspaceId && run.state === "running" && run.executorId === executorId && !expired(run.leaseUntil, nowIso);
  }

  private recent(workspaceId: string, sinceIso: string): number {
    return this.calls.filter((call) => call.workspaceId === workspaceId && call.createdAt >= sinceIso).length
      + this.otherCalls.filter((call) => call.workspaceId === workspaceId && call.createdAt >= sinceIso).length;
  }

  async storageReady(): Promise<boolean> {
    return this.ready;
  }

  async providerStorageReady(): Promise<boolean> {
    return this.ready;
  }

  async findRunByKey(workspaceId: string, actorId: string, idempotencyKey: string): Promise<AutoRunBundle | null> {
    const run = this.runs.find((item) => item.workspaceId === workspaceId && item.actorId === actorId && item.idempotencyKey === idempotencyKey);
    return run ? this.bundle(run) : null;
  }

  async createRun(run: AutoRunRecord, stageKeys: readonly string[], limits: { maxActiveRuns: number; sinceIso: string; maxCallsPerDay: number; requiredCalls: number }): Promise<AutoRunCreation> {
    const existing = this.runs.find((item) => item.workspaceId === run.workspaceId && item.actorId === run.actorId && item.idempotencyKey === run.idempotencyKey);
    if (existing) return { kind: existing.inputHash === run.inputHash && existing.projectId === run.projectId ? "existing" : "conflict", bundle: this.bundle(existing) };
    const sameProject = this.runs.find((item) => item.projectId === run.projectId && item.state === "running");
    if (sameProject) return { kind: "active", runKind: "auto", runId: sameProject.id };
    const title = this.titleRunning.get(run.projectId);
    if (title) return { kind: "active", runKind: "title", runId: title };
    const project = this.projects.get(run.projectId);
    if (!project || project.currentStoryId !== null || this.runs.some((item) => item.projectId === run.projectId)) return { kind: "project_not_empty" };
    const active = this.runs.filter((item) => item.workspaceId === run.workspaceId && item.state === "running").length + this.titleRunning.size;
    if (active >= limits.maxActiveRuns) return { kind: "blocked", code: "AUTO_CREATION_ACTIVE_RUN_CAP" };
    const remainingCalls = Math.max(0, limits.maxCallsPerDay - this.recent(run.workspaceId, limits.sinceIso));
    if (remainingCalls < limits.requiredCalls) return { kind: "blocked", code: "AUTO_CREATION_DAILY_QUOTA_LOW", requiredCalls: limits.requiredCalls, remainingCalls };
    this.runs.push(structuredClone(run));
    stageKeys.forEach((stageKey, ordinal) => this.stages.push({
      runId: run.id, stageKey, ordinal, state: "pending", attemptNo: 0, errorCode: null, output: null, outputHash: null, dependsOn: null,
      scriptSave: autoStageKind(stageKey) === "episode" ? "pending" : null, scriptRevisionId: null, updatedAt: run.createdAt,
    }));
    return { kind: "created", bundle: this.bundle(this.run(run.id)) };
  }

  async getRun(workspaceId: string, projectId: string, runId: string): Promise<AutoRunBundle | null> {
    const run = this.runs.find((item) => item.id === runId && item.workspaceId === workspaceId && item.projectId === projectId);
    return run ? this.bundle(run) : null;
  }

  async getRunById(workspaceId: string, runId: string): Promise<AutoRunBundle | null> {
    const run = this.runs.find((item) => item.id === runId && item.workspaceId === workspaceId);
    return run ? this.bundle(run) : null;
  }

  async latestRun(workspaceId: string, projectId: string): Promise<AutoRunBundle | null> {
    const run = this.runs.filter((item) => item.workspaceId === workspaceId && item.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
    return run ? this.bundle(run) : null;
  }

  async claimRun(workspaceId: string, runId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<boolean> {
    const run = this.runs.find((item) => item.id === runId && item.workspaceId === workspaceId);
    if (!run || run.state !== "running") return false;
    if (run.executorId !== null && run.executorId !== executorId && !expired(run.leaseUntil, nowIso)) return false;
    if (run.executorId !== executorId && this.calls.some((call) => call.runId === runId && (call.state === "reserved" || call.state === "submitted"))) return false;
    Object.assign(run, { executorId, leaseUntil, updatedAt: nowIso });
    return true;
  }

  async completeLocalStage(workspaceId: string, runId: string, executorId: string, stageKey: string, output: AutoStageOutput, outputHash: string, nowIso: string): Promise<boolean> {
    const run = this.run(runId);
    if (!this.owns(run, workspaceId, executorId, nowIso)) return false;
    const stage = this.stage(runId, stageKey);
    if (stage.state !== "pending") return false;
    Object.assign(stage, { state: "completed", output: structuredClone(output), outputHash, dependsOn: {}, updatedAt: nowIso });
    run.updatedAt = nowIso;
    return true;
  }

  async appendRound(workspaceId: string, runId: string, executorId: string, stageKeys: readonly string[], round: number, nowIso: string): Promise<boolean> {
    const run = this.run(runId);
    if (!this.owns(run, workspaceId, executorId, nowIso) || run.revisionRoundsUsed !== round - 1) return false;
    const mine = this.stages.filter((stage) => stage.runId === runId);
    if (mine.some((stage) => stage.state !== "completed")) return false;
    let ordinal = Math.max(...mine.map((stage) => stage.ordinal)) + 1;
    for (const stageKey of stageKeys) {
      this.stages.push({ runId, stageKey, ordinal, state: "pending", attemptNo: 0, errorCode: null, output: null, outputHash: null,
        dependsOn: null, scriptSave: null, scriptRevisionId: null, updatedAt: nowIso });
      ordinal += 1;
    }
    Object.assign(run, { revisionRoundsUsed: round, updatedAt: nowIso });
    return true;
  }

  async reserveCall(call: AutoCallRecord, limits: { sinceIso: string; maxCallsPerDay: number }, nowIso: string, leaseUntil: string): Promise<AutoCallReservation> {
    const run = this.run(call.runId);
    if (!this.owns(run, call.workspaceId, call.executorId, nowIso)) return { kind: "lost" };
    if (run.cancelRequestedAt !== null) return { kind: "canceled" };
    if (run.callsUsed >= run.callCap) return { kind: "blocked", code: "AUTO_CREATION_RUN_CAP" };
    if (this.recent(call.workspaceId, limits.sinceIso) >= limits.maxCallsPerDay) return { kind: "blocked", code: "AUTO_CREATION_DAILY_CAP" };
    const stage = this.stage(call.runId, call.stageKey);
    if (stage.state !== "pending") return { kind: "lost" };
    this.calls.push(structuredClone(call));
    Object.assign(stage, { state: "reserved", attemptNo: call.attemptNo, errorCode: null, updatedAt: nowIso });
    Object.assign(run, { callsUsed: run.callsUsed + 1, leaseUntil, updatedAt: nowIso });
    return { kind: "reserved" };
  }

  async markCallSubmitted(workspaceId: string, callId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<"submitted" | "canceled" | "lost"> {
    const call = this.calls.find((item) => item.id === callId);
    if (!call) return "lost";
    const run = this.run(call.runId);
    if (call.state !== "reserved" || call.executorId !== executorId || !this.owns(run, workspaceId, executorId, nowIso)) return "lost";
    const stage = this.stage(call.runId, call.stageKey);
    if (run.cancelRequestedAt !== null) {
      Object.assign(call, { state: "rejected", errorCode: TITLE_WRITING_CANCELED_BEFORE_SEND, finishedAt: nowIso });
      Object.assign(stage, { state: "canceled", updatedAt: nowIso });
      return "canceled";
    }
    call.state = "submitted";
    Object.assign(stage, { state: "submitted", updatedAt: nowIso });
    Object.assign(run, { leaseUntil, updatedAt: nowIso });
    return "submitted";
  }

  async finishCall(workspaceId: string, callId: string, executorId: string, patch: AutoCallFinish, nowIso: string): Promise<boolean> {
    const call = this.calls.find((item) => item.id === callId);
    if (!call) return false;
    const run = this.run(call.runId);
    if (run.workspaceId !== workspaceId || call.state !== "submitted" || call.executorId !== executorId || run.executorId !== executorId) return false;
    Object.assign(call, { state: patch.state, errorCode: patch.errorCode, providerRequestId: patch.providerRequestId, responseModel: patch.responseModel,
      usage: patch.usage, finishedAt: nowIso });
    Object.assign(this.stage(call.runId, call.stageKey), { state: patch.state, errorCode: patch.errorCode, output: structuredClone(patch.output),
      outputHash: patch.outputHash, dependsOn: patch.dependsOn, updatedAt: nowIso });
    run.updatedAt = nowIso;
    return true;
  }

  async saveStory(workspaceId: string, runId: string, executorId: string, storyText: string, quality: Exclude<AutoCreationQuality, "pending">, nowIso: string): Promise<"saved" | "conflict" | "lost"> {
    const run = this.run(runId);
    if (!this.owns(run, workspaceId, executorId, nowIso)) return "lost";
    if (run.storySave === "saved") return "saved";
    const project = this.projects.get(run.projectId)!;
    if (project.currentStoryId !== null) {
      Object.assign(run, { storySave: "conflict", quality, updatedAt: nowIso });
      return "conflict";
    }
    const id = randomUUID();
    project.stories.push({ id, text: storyText, reviewStatus: "DRAFT", createdBy: `auto-creation:${runId}` });
    project.currentStoryId = id;
    Object.assign(run, { storySave: "saved", storyRevisionId: id, quality, updatedAt: nowIso });
    return "saved";
  }

  async finishRun(workspaceId: string, runId: string, executorId: string, state: Exclude<TitleWritingRunState, "running">, errorCode: string | null, nowIso: string): Promise<boolean> {
    const run = this.run(runId);
    if (run.workspaceId !== workspaceId || run.state !== "running" || run.executorId !== executorId) return false;
    if (state === "canceled") {
      for (const stage of this.stages.filter((item) => item.runId === runId && item.state === "pending")) Object.assign(stage, { state: "canceled", updatedAt: nowIso });
    }
    Object.assign(run, { state, errorCode, executorId: null, leaseUntil: null, updatedAt: nowIso });
    return true;
  }

  async requestCancel(workspaceId: string, projectId: string, runId: string, nowIso: string): Promise<AutoRunBundle | null> {
    const run = this.runs.find((item) => item.id === runId && item.workspaceId === workspaceId && item.projectId === projectId);
    if (!run) return null;
    if (run.state === "running" && run.cancelRequestedAt === null) Object.assign(run, { cancelRequestedAt: nowIso, updatedAt: nowIso });
    return this.bundle(run);
  }

  async prepareResume(workspaceId: string, projectId: string, runId: string, request: { resumeKey: string; requestHash: string; confirmedCallIds: readonly string[]; maxActiveRuns: number; providerReady: boolean }, nowIso: string): Promise<AutoResumePreparation> {
    const run = this.runs.find((item) => item.id === runId && item.workspaceId === workspaceId && item.projectId === projectId);
    if (!run) return { kind: "not_found" };
    const previous = this.resumes.find((item) => item.runId === runId && item.key === request.resumeKey);
    if (previous) return previous.requestHash === request.requestHash ? { kind: "replayed", bundle: this.bundle(run) } : { kind: "key_conflict" };
    if (run.state === "running") return { kind: "active" };
    if (run.state === "completed") return { kind: "not_resumable" };
    if (this.runs.filter((item) => item.workspaceId === workspaceId && item.state === "running").length + this.titleRunning.size >= request.maxActiveRuns) return { kind: "active_cap" };
    const stages = this.stages.filter((item) => item.runId === runId);
    const uncertain = autoUncertainCallIds(stages, this.calls.filter((item) => item.runId === runId));
    const confirmed = [...request.confirmedCallIds].sort();
    if (uncertain.length > 0 && confirmed.length === 0) return { kind: "needs_confirmation" };
    if (uncertain.length !== confirmed.length || uncertain.some((id, index) => id !== confirmed[index])) return { kind: "stale_confirmation" };
    const redo = stages.filter((stage) => stage.state === "unknown" || stage.state === "rejected" || stage.state === "canceled");
    if (redo.length === 0 && run.storySave !== "pending") return { kind: "not_resumable" };
    const sends = redo.some((stage) => stage.stageKey !== "sources") || stages.some((stage) => stage.state === "pending" && stage.stageKey !== "sources");
    if (sends && !request.providerReady) return { kind: "provider_unconfigured" };
    this.resumes.push({ runId, key: request.resumeKey, requestHash: request.requestHash });
    for (const stage of redo) Object.assign(stage, { state: "pending", updatedAt: nowIso });
    Object.assign(run, { state: "running", errorCode: null, cancelRequestedAt: null, executorId: null, leaseUntil: null, updatedAt: nowIso });
    return { kind: "ok", bundle: this.bundle(run) };
  }

  async recoverExpired(workspaceId: string, nowIso: string): Promise<number> {
    let recovered = 0;
    for (const run of this.runs) {
      if (run.workspaceId !== workspaceId || run.state !== "running" || run.executorId === null || !expired(run.leaseUntil, nowIso)) continue;
      recovered += 1;
      let uncertain = false;
      for (const call of this.calls.filter((item) => item.runId === run.id)) {
        const stage = this.stage(run.id, call.stageKey);
        if (call.state === "reserved") {
          Object.assign(call, { state: "rejected", errorCode: TITLE_WRITING_LOST_BEFORE_SEND, finishedAt: nowIso });
          Object.assign(stage, { state: "pending", updatedAt: nowIso });
        } else if (call.state === "submitted") {
          Object.assign(call, { state: "unknown", errorCode: TITLE_WRITING_LOST_AFTER_SEND, finishedAt: nowIso });
          Object.assign(stage, { state: "unknown", errorCode: TITLE_WRITING_LOST_AFTER_SEND, updatedAt: nowIso });
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
    return this.runs.filter((run) => run.workspaceId === workspaceId && run.state === "running" && (run.executorId === null || expired(run.leaseUntil, nowIso)))
      .slice(0, limit).map((run) => run.id);
  }

  async placeScripts(workspaceId: string, projectId: string, runId: string, scripts: ReadonlyArray<{ episodeNo: number; stageKey: string; text: string }>, options: { acceptStoryChanged: boolean }, actorId: string, nowIso: string): Promise<AutoScriptPlacement> {
    const run = this.runs.find((item) => item.id === runId && item.workspaceId === workspaceId && item.projectId === projectId);
    if (!run) return { kind: "not_found" };
    if (run.state === "running" || scripts.length !== run.input.episodeCount) return { kind: "not_ready" };
    const project = this.projects.get(projectId)!;
    if (!project.approvedStoryId || project.currentStoryId !== project.approvedStoryId) return { kind: "story_not_approved" };
    if (project.approvedStoryId !== run.storyRevisionId && !options.acceptStoryChanged) return { kind: "story_changed" };
    if (project.episodeCount !== run.input.episodeCount || project.episodes.size !== run.input.episodeCount) return { kind: "plan_mismatch" };
    for (const script of scripts) {
      const episode = project.episodes.get(script.episodeNo)!;
      const stage = this.stage(runId, `episode:${String(script.episodeNo)}`);
      if (stage.scriptSave === "saved") continue;
      if (episode.currentScriptId !== null) {
        Object.assign(stage, { scriptSave: "conflict", updatedAt: nowIso });
        continue;
      }
      const id = randomUUID();
      episode.scripts.push({ id, text: script.text, createdBy: actorId });
      episode.currentScriptId = id;
      Object.assign(stage, { scriptSave: "saved", scriptRevisionId: id, updatedAt: nowIso });
    }
    run.updatedAt = nowIso;
    return { kind: "ok", bundle: this.bundle(run) };
  }
}
