import { createHash, randomUUID } from "node:crypto";
import {
  SERIES_PROMPT_MAX_CHARS,
  SERIES_WRITING_CHECKS_VERSION,
  SERIES_WRITING_INPUT_SCHEMA,
  SERIES_WRITING_PROMPT_VERSION,
  SERIES_RESEARCH_CONTRACT,
  SERIES_BATCH_SIZE,
  SERIES_OUTLINE_CHUNK,
  SERIES_WRITING_GRANT_SCHEMA,
  autoCreationJsonSchema,
  autoErrorCodeWith,
  autoErrorParts,
  frozenProviderAdapter,
  isLegacyDeepseekRun,
  seriesJsonSchema,
  seriesStageKind,
  type SeriesAuthorization,
  type SeriesCallFinish,
  type SeriesCallRecord,
  type SeriesConstraints,
  type SeriesFrozenInput,
  type SeriesGrantRecord,
  type SeriesJobArtifacts,
  type SeriesJobBundle,
  type SeriesRecord,
  type SeriesReviewOutput,
  type SeriesRunState,
  type SeriesScope,
  type SeriesSnapshot,
  type SeriesWritingStore,
  type AutoCreationMaterial,
  type TitleWritingProviderKey,
  type TitleWritingStoredProviderKey,
} from "@ai-drama/contracts";
import {
  autoResearchModeOf,
  buildSeriesPrompt,
  canonicalInputHash,
  collectSources,
  formatSeriesStory,
  nextSeriesJob,
  seriesAutoInput,
  seriesBatchLedger,
  seriesCurrentPlan,
  seriesJobContext,
  seriesJobUpstreamChange,
  seriesPlanFromContext,
  seriesStageDependencies,
  validateSeriesStageOutput,
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

export const SERIES_WRITING_LEASE_MS = TEXT_WRITING_TIMEOUT_MS * 2;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Identity of a series: the work's title and its frozen creative input. */
export function hashSeriesInput(title: string, input: SeriesFrozenInput): string {
  return canonicalInputHash({ title, input });
}

/** Identity of a grant: the series and what the card froze. How it was authorized is recorded but is not part of it. */
export function hashSeriesGrant(seriesId: string, input: SeriesGrantRecord["input"]): string {
  const { authorization: _authorization, ...rest } = input;
  return canonicalInputHash({ seriesId, grant: rest });
}

export function hashSeriesResume(grantId: string, confirmed: readonly string[]): string {
  return canonicalInputHash({ grantId, kind: "series-writing-resume", confirmUncertainCallIds: [...confirmed].sort() });
}

export function newSeries(options: {
  workspaceId: string; projectId: string; actorId: string; idempotencyKey: string; title: string; idea: string; constraints: SeriesConstraints;
  materials: AutoCreationMaterial[]; referenceUrls: string[]; researchFetch: boolean; episodeCount: number; episodeSeconds: number; now: Date;
}): SeriesRecord {
  const input: SeriesFrozenInput = {
    schema: SERIES_WRITING_INPUT_SCHEMA, promptVersion: SERIES_WRITING_PROMPT_VERSION, checksVersion: SERIES_WRITING_CHECKS_VERSION,
    researchContract: SERIES_RESEARCH_CONTRACT, idea: options.idea, constraints: options.constraints, materials: options.materials,
    referenceUrls: options.referenceUrls, researchFetch: options.researchFetch, episodeCount: options.episodeCount, episodeSeconds: options.episodeSeconds,
    batchSize: SERIES_BATCH_SIZE, outlineChunk: SERIES_OUTLINE_CHUNK,
  };
  const createdAt = options.now.toISOString();
  return { id: randomUUID(), workspaceId: options.workspaceId, projectId: options.projectId, actorId: options.actorId, idempotencyKey: options.idempotencyKey,
    inputHash: hashSeriesInput(options.title, input), input, title: options.title, createdAt, updatedAt: createdAt };
}

export function newSeriesGrant(options: {
  series: SeriesRecord; actorId: string; idempotencyKey: string; scope: SeriesScope; normalCalls: number; resendAllowance: number; callBudget: number;
  providerKey: TitleWritingStoredProviderKey; model: string; basePlanRevisionId: string | null; authorization: SeriesAuthorization; now: Date;
}): SeriesGrantRecord {
  const input: SeriesGrantRecord["input"] = {
    schema: SERIES_WRITING_GRANT_SCHEMA, seriesId: options.series.id, scope: options.scope, normalCalls: options.normalCalls,
    resendAllowance: options.resendAllowance, callBudget: options.callBudget, providerKey: options.providerKey, model: options.model,
    ...frozenProviderAdapter(options.providerKey), maxOutputTokens: TEXT_WRITING_MAX_OUTPUT_TOKENS, basePlanRevisionId: options.basePlanRevisionId,
    authorization: options.authorization,
  };
  const createdAt = options.now.toISOString();
  return { id: randomUUID(), seriesId: options.series.id, workspaceId: options.series.workspaceId, projectId: options.series.projectId, actorId: options.actorId,
    idempotencyKey: options.idempotencyKey, requestHash: hashSeriesGrant(options.series.id, input), input, callBudget: options.callBudget, callsUsed: 0,
    state: "running", stopReason: null, cancelRequestedAt: null, createdAt, updatedAt: createdAt };
}

export interface SeriesWritingEngineDeps {
  workspaceId: string;
  store: SeriesWritingStore;
  providers: Record<TitleWritingProviderKey, WritingProviderConfig>;
  transport: WritingTransport;
  maxCallsPerDay: number;
  maxActiveRuns: number;
  fetchPages?: (urls: readonly string[]) => Promise<FetchedPage[]>;
  defaultResearchUrls?: readonly string[];
  adapters?: Readonly<Record<TitleWritingProviderKey, WritingAdapter>>;
  clock?: () => Date;
  executorId?: string;
  leaseMs?: number;
  timeoutMs?: number;
  send?: typeof sendWriting;
}

type Step = { kind: "continue" } | { kind: "stop" } | { kind: "next"; jobId: string };
const CONTINUE: Step = { kind: "continue" };
const STOP: Step = { kind: "stop" };

/**
 * Drives series jobs inside the API process: one stage per pass, each pass re-reading the stored job and the series.
 * A completed stage is never sent again; an uncertain call stops the job and its grant for a person; a finished job
 * hands over to its grant's next job only when the series may go on (never past a blocking finding or a pending edit).
 */
export class SeriesWritingEngine {
  readonly executorId: string;
  readonly workspaceId: string;
  private readonly running = new Set<string>();

  constructor(private readonly deps: SeriesWritingEngineDeps) {
    this.executorId = deps.executorId ?? `series-writing:${randomUUID()}`;
    this.workspaceId = deps.workspaceId;
  }

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  private lease(from: Date): string {
    return new Date(from.getTime() + (this.deps.leaseMs ?? SERIES_WRITING_LEASE_MS)).toISOString();
  }

  private limits(at: Date) {
    return { sinceIso: new Date(at.getTime() - 24 * 60 * 60 * 1000).toISOString(), maxCallsPerDay: this.deps.maxCallsPerDay, maxActiveRuns: this.deps.maxActiveRuns };
  }

  async drive(jobId: string): Promise<void> {
    let current: string | null = jobId;
    while (current !== null) {
      if (this.running.has(current)) return;
      this.running.add(current);
      const id: string = current;
      current = null;
      try {
        const claimedAt = this.now();
        if (!await this.deps.store.claimJob(this.workspaceId, id, this.executorId, claimedAt.toISOString(), this.lease(claimedAt))) return;
        for (;;) {
          const step = await this.advance(id);
          if (step.kind === "continue") continue;
          if (step.kind === "next") current = step.jobId;
          break;
        }
      } finally {
        this.running.delete(id);
      }
    }
  }

  async maintain(limit = 5): Promise<void> {
    const nowIso = this.now().toISOString();
    await this.deps.store.recoverExpired(this.workspaceId, nowIso);
    for (const jobId of await this.deps.store.listClaimable(this.workspaceId, nowIso, limit)) await this.drive(jobId);
  }

  private async stop(jobId: string, state: Exclude<SeriesRunState, "running" | "completed">, errorCode: string | null): Promise<Step> {
    await this.deps.store.finishJob(this.workspaceId, jobId, this.executorId, state, errorCode, this.now().toISOString());
    return STOP;
  }

  private async advance(jobId: string): Promise<Step> {
    const bundle = await this.deps.store.getJob(this.workspaceId, jobId);
    if (!bundle || bundle.run.state !== "running" || bundle.run.executorId !== this.executorId) return STOP;
    const { run } = bundle;
    if (run.cancelRequestedAt !== null) return this.stop(jobId, "canceled", null);
    const stages = [...bundle.stages].sort((a, b) => a.ordinal - b.ordinal);
    const anyCompleted = stages.some((stage) => stage.state === "completed" && stage.stageKey !== "sources");
    const next = stages.find((stage) => stage.state !== "completed");
    const snapshot = await this.deps.store.snapshot(this.workspaceId, run.projectId);
    if (!snapshot) return STOP;
    if (!next) {
      // A planning job superseded while it waited (a plan saved since, or a later planning job) never saves a second plan.
      const superseded = run.kind === "plan" ? seriesJobUpstreamChange(snapshot, run) : null;
      return superseded ? this.stop(jobId, "needs_attention", superseded) : this.afterJob(bundle, snapshot);
    }
    if (next.state === "unknown") return this.stop(jobId, "needs_attention", next.errorCode ?? "uncertain_call");
    if (next.state === "rejected") return this.stop(jobId, anyCompleted ? "partial" : "failed", next.errorCode === null ? null : autoErrorParts(next.errorCode).code);
    if (next.state === "reserved" || next.state === "submitted") return STOP;
    if (next.state === "canceled") return this.stop(jobId, "canceled", null);
    const series = snapshot.series;
    const autoInput = seriesAutoInput(series.input, { providerKey: run.input.providerKey, model: run.input.model, maxOutputTokens: run.input.maxOutputTokens });
    if (next.stageKey === "sources") {
      if (series.input.researchFetch && !this.deps.fetchPages) return this.stop(jobId, "needs_attention", "research_fetch_unavailable");
      const urls = series.input.researchFetch ? [...new Set([...(this.deps.defaultResearchUrls ?? []), ...series.input.referenceUrls])] : [];
      const pages = urls.length > 0 && this.deps.fetchPages ? await this.deps.fetchPages(urls) : [];
      const output = collectSources(autoInput, pages, this.now().toISOString());
      const done = await this.deps.store.completeLocalStage(this.workspaceId, jobId, this.executorId, "sources", output as never, canonicalInputHash(output), this.now().toISOString());
      return done ? CONTINUE : STOP;
    }
    if (isLegacyDeepseekRun(run.input)) return this.stop(jobId, "needs_attention", "legacy_provider_run");
    // Never another provider or model: the grant's frozen ones, or nothing.
    const provider = providerConfigFor(this.deps.providers, run.input.providerKey);
    const adapter = provider ? (this.deps.adapters ?? WRITING_ADAPTERS)[provider.providerKey] : undefined;
    if (!provider || !adapter || !provider.ok || !provider.models.includes(run.input.model)) return this.stop(jobId, "needs_attention", "provider_unconfigured");
    // What the job was frozen on must still be the series' current state: never write on a changed plan, ledger or episode.
    const upstream = seriesJobUpstreamChange(snapshot, run);
    if (upstream) return this.stop(jobId, "needs_attention", upstream);
    const job = snapshot.jobs.find((item) => item.run.id === jobId) ?? bundle;
    const context = seriesJobContext(snapshot, job);
    const kind = seriesStageKind(next.stageKey);
    const researchMode = autoResearchModeOf(context.auto.sources);
    if (kind === "research" && (researchMode === null || !context.auto.referenceCatalog)) return this.stop(jobId, "needs_attention", "research_sources_missing");
    const prompt = buildSeriesPrompt(next.stageKey, series.input, context, autoInput, run.input.promptVersion);
    if (prompt.system.length + prompt.user.length > SERIES_PROMPT_MAX_CHARS) return this.stop(jobId, "needs_attention", "prompt_too_large");
    const schema = kind === "research" || kind === "directions"
      ? autoCreationJsonSchema(kind, series.input.episodeCount, kind === "research" ? researchMode : null, kind === "research" ? context.auto.referenceCatalog ?? null : null)
      : seriesJsonSchema(next.stageKey, series.input.episodeCount);
    const request = { model: run.input.model, system: prompt.system, user: prompt.user, schemaName: schema.name, jsonSchema: schema.schema,
      maxOutputTokens: run.input.maxOutputTokens };
    const reservedAt = this.now();
    const call: SeriesCallRecord = {
      id: randomUUID(), runId: jobId, grantId: run.grantId, seriesId: run.seriesId, workspaceId: this.workspaceId, stageKey: next.stageKey,
      attemptNo: next.attemptNo + 1, providerKey: run.input.providerKey as TitleWritingProviderKey, model: run.input.model,
      requestHash: sha256(`${provider.url}\n${adapter.buildBody(request)}`), state: "reserved", executorId: this.executorId, providerRequestId: null,
      responseModel: null, usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null }, errorCode: null,
      createdAt: reservedAt.toISOString(), finishedAt: null,
    };
    const reservation = await this.deps.store.reserveCall(call, this.limits(reservedAt), reservedAt.toISOString(), this.lease(reservedAt));
    if (reservation.kind === "lost") return STOP;
    if (reservation.kind === "canceled") return this.stop(jobId, "canceled", null);
    if (reservation.kind === "blocked") return this.stop(jobId, anyCompleted ? "partial" : "failed", reservation.code);
    // A dependency changed after the snapshot: nothing was reserved; the job stops for a person (never re-reserved).
    if (reservation.kind === "upstream") return this.stop(jobId, "needs_attention", reservation.code);
    const submittedAt = this.now();
    const submission = await this.deps.store.markCallSubmitted(this.workspaceId, call.id, this.executorId, submittedAt.toISOString(), this.lease(submittedAt));
    if (submission === "canceled") return this.stop(jobId, "canceled", null);
    // Changed after the reservation: closed as never sent and given back; the job stops, nothing is rebuilt or resent.
    if (typeof submission === "object") return this.stop(jobId, "needs_attention", submission.upstream);
    if (submission !== "submitted") return STOP;
    const exchange = await (this.deps.send ?? sendWriting)({
      adapter, url: provider.url, apiKey: provider.apiKey, workspaceId: provider.workspaceId, request, transport: this.deps.transport,
      ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
    });
    const common = { providerRequestId: exchange.providerRequestId, responseModel: exchange.responseModel, usage: exchange.usage };
    let patch: SeriesCallFinish;
    if (exchange.outcome === "answered" && exchange.content !== null) {
      const checked = validateSeriesStageOutput(next.stageKey, exchange.content, series.input, context, autoInput);
      patch = checked.ok
        ? { state: "completed", errorCode: null, output: checked.output, outputHash: canonicalInputHash(checked.output), dependsOn: seriesStageDependencies(next.stageKey, context), ...common }
        // A refused answer is never stored, only its rule and field path: no model text.
        : { state: "rejected", errorCode: autoErrorCodeWith(checked.code, checked.field, checked.category, checked.semantic, checked.rule, checked.reason), output: null, outputHash: null, dependsOn: null, ...common };
    } else {
      patch = { state: exchange.outcome === "unknown" ? "unknown" : "rejected", errorCode: exchange.errorCode ?? "invalid_output", output: null, outputHash: null, dependsOn: null, ...common };
    }
    return await this.deps.store.finishCall(this.workspaceId, call.id, this.executorId, patch, this.now().toISOString()) ? CONTINUE : STOP;
  }

  /** Every stage completed: record the job's artifacts and hand over to the grant's next job, or end the grant. */
  private async afterJob(bundle: SeriesJobBundle, snapshot: SeriesSnapshot): Promise<Step> {
    const { run } = bundle;
    const nowIso = this.now().toISOString();
    const job = snapshot.jobs.find((item) => item.run.id === run.id) ?? bundle;
    let artifacts: SeriesJobArtifacts;
    if (run.kind === "plan") {
      const context = seriesJobContext(snapshot, job);
      const content = seriesPlanFromContext(context);
      const review = job.stages.find((stage) => stage.stageKey === "plan_review")?.output as unknown as SeriesReviewOutput | undefined;
      if (!content || !review) return this.stop(run.id, "failed", "invalid_step");
      const revisionId = randomUUID();
      artifacts = { kind: "plan", plan: { id: revisionId, seriesId: run.seriesId, revisionNo: snapshot.plans.length + 1, origin: "model", sourceRunId: run.id,
        parentRevisionId: seriesCurrentPlan(snapshot)?.id ?? null, content, contentHash: canonicalInputHash(content), review,
        createdBy: `series-writing:${run.id}`, createdAt: nowIso }, storyText: formatSeriesStory(revisionId, content, review.passed ? "passed" : "revise") };
    } else if (run.kind === "batch") {
      artifacts = { kind: "batch", ledger: seriesBatchLedger(snapshot, job, { ledgerId: randomUUID(), nowIso }) };
    } else {
      artifacts = { kind: "final" };
    }
    const at = this.now();
    const step = await this.deps.store.completeJob(this.workspaceId, run.id, this.executorId, artifacts, this.limits(at), nowIso, this.lease(at),
      (after) => {
        const grant = after.grants.find((item) => item.id === run.grantId)!;
        return nextSeriesJob(after, grant, { jobId: randomUUID(), nowIso });
      });
    return step.kind === "job" ? { kind: "next", jobId: step.jobId } : STOP;
  }
}
