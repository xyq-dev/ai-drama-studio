import { createHash, randomUUID } from "node:crypto";
import {
  SERIES_NEVER_SENT_ERROR_CODES,
  SERIES_UPSTREAM_BEFORE_SEND,
  TITLE_WRITING_CANCELED_BEFORE_SEND,
  currentUncertainCallIds,
  seriesBatchRange,
  seriesStageEpisodeNo,
  type SeriesAdmission,
  type SeriesCallFinish,
  type SeriesCallRecord,
  type SeriesCallReservation,
  type SeriesCallSubmission,
  type SeriesDecisionRecord,
  type SeriesGrantCreation,
  type SeriesGrantRecord,
  type SeriesJobArtifacts,
  type SeriesJobBundle,
  type SeriesJobPlan,
  type SeriesJobRecord,
  type SeriesLedgerRevisionRecord,
  type SeriesLimits,
  type SeriesNextStep,
  type SeriesPlacement,
  type SeriesPlacementCandidates,
  type SeriesPlanRevisionRecord,
  type SeriesPlanStory,
  type SeriesRecord,
  type SeriesResumePreparation,
  type SeriesRunState,
  type SeriesScriptRevision,
  type SeriesSnapshot,
  type SeriesStageOutput,
  type SeriesStageRecord,
  type SeriesStoryRevision,
  type SeriesWritingStore,
  type TitleWritingProviderKey,
  type TitleWritingStepKey,
} from "@ai-drama/contracts";
import { seriesCurrentPlan, seriesGrantRemainingSends, seriesJobNormalSends, seriesJobSends, seriesJobUpstreamChange } from "@ai-drama/domain";
import { TITLE_WRITING_LOST_AFTER_SEND, TITLE_WRITING_LOST_BEFORE_SEND } from "./title-writing-engine";

interface MemoryScript { id: string; text: string; contentHash: string; reviewStatus: SeriesScriptRevision["reviewStatus"]; freshness: "CURRENT" | "STALE"; sourceStoryRevisionId: string; createdBy: string; createdAt: string }
interface MemoryEpisode { id: string; rowVersion: number; currentScriptId: string | null; approvedScriptId: string | null; scripts: MemoryScript[] }
interface MemoryStory { id: string; text: string; contentHash: string; reviewStatus: "DRAFT" | "APPROVED"; createdBy: string; createdAt: string }
export interface MemorySeriesProject {
  workspaceId: string;
  writingMode: "short" | "series";
  episodeCount: number;
  title: string;
  stories: MemoryStory[];
  currentStoryId: string | null;
  approvedStoryId: string | null;
  episodes: Map<number, MemoryEpisode>;
}

function expired(leaseUntil: string | null, nowIso: string): boolean {
  return leaseUntil === null || leaseUntil <= nowIso;
}

function textHash(text: string): string {
  return createHash("sha256").update(JSON.stringify({ text })).digest("hex");
}

/** Never sent: a reservation released by recovery, or closed by a cancel before its send (out of every count). */
const NEVER_SENT = new Set<string>(SERIES_NEVER_SENT_ERROR_CODES);

function counted(call: SeriesCallRecord): boolean {
  return !(call.state === "rejected" && call.errorCode !== null && NEVER_SENT.has(call.errorCode));
}

/** A new current story, as the text chain saves it: scripts written from the story it replaces become STALE. */
function replaceStory(project: MemorySeriesProject, story: MemoryStory): void {
  const previous = project.currentStoryId;
  project.stories.push(story);
  project.currentStoryId = story.id;
  if (previous === null || previous === story.id) return;
  for (const episode of project.episodes.values()) {
    for (const script of episode.scripts) if (script.sourceStoryRevisionId === previous) script.freshness = "STALE";
  }
}

function storyRecord(story: MemoryStory | undefined): SeriesStoryRevision | null {
  return story ? { id: story.id, text: story.text, contentHash: story.contentHash, reviewStatus: story.reviewStatus, freshnessStatus: "CURRENT",
    createdBy: story.createdBy, createdAt: story.createdAt } : null;
}

/** Two bases name exactly the same texts at the same hashes. */
function sameBasis(a: Record<string, string>, b: Record<string, string>): boolean {
  return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);
}

/** In-process store for tests: each method reads and writes without an await in between (one atomic step). */
export class InMemorySeriesWritingStore implements SeriesWritingStore {
  readonly series: SeriesRecord[] = [];
  readonly grants: SeriesGrantRecord[] = [];
  readonly jobs: SeriesJobRecord[] = [];
  readonly stages: SeriesStageRecord[] = [];
  readonly calls: SeriesCallRecord[] = [];
  readonly plans: SeriesPlanRevisionRecord[] = [];
  readonly ledgers: SeriesLedgerRevisionRecord[] = [];
  readonly decisions: SeriesDecisionRecord[] = [];
  readonly resumes: Array<{ grantId: string; key: string; requestHash: string }> = [];
  readonly projects = new Map<string, MemorySeriesProject>();
  /** Paid text calls of title writing, candidates and automatic creation in the same workspace (the shared daily cap). */
  readonly otherCalls: Array<{ workspaceId: string; createdAt: string }> = [];
  /** Running title writing or automatic creation runs, by project (the shared concurrency cap and the one-run-per-work rule). */
  readonly otherRunning = new Map<string, "auto" | "title">();
  ready = true;
  planReady = true;

  // ---- test helpers (people's actions in the workbench) ----

  approveCurrentStory(projectId: string): void {
    const project = this.projects.get(projectId)!;
    const story = project.stories.find((item) => item.id === project.currentStoryId)!;
    story.reviewStatus = "APPROVED";
    project.approvedStoryId = story.id;
    for (let episodeNo = 1; episodeNo <= project.episodeCount; episodeNo += 1) {
      if (!project.episodes.has(episodeNo)) project.episodes.set(episodeNo, { id: randomUUID(), rowVersion: 1, currentScriptId: null, approvedScriptId: null, scripts: [] });
    }
  }

  writeHumanStory(projectId: string, text: string): string {
    const project = this.projects.get(projectId)!;
    const id = randomUUID();
    replaceStory(project, { id, text, contentHash: textHash(text), reviewStatus: "DRAFT", createdBy: "person", createdAt: new Date().toISOString() });
    return id;
  }

  /** A person's edit in the script editor: a new DRAFT revision; the earlier ones stay readable. */
  writeHumanScript(projectId: string, episodeNo: number, text: string): string {
    const project = this.projects.get(projectId)!;
    const episode = project.episodes.get(episodeNo)!;
    const id = randomUUID();
    episode.scripts.push({ id, text, contentHash: textHash(text), reviewStatus: "DRAFT", freshness: "CURRENT", sourceStoryRevisionId: project.approvedStoryId!,
      createdBy: "person", createdAt: new Date().toISOString() });
    episode.currentScriptId = id;
    episode.rowVersion += 1;
    return id;
  }

  approveScript(projectId: string, episodeNo: number): void {
    const episode = this.projects.get(projectId)!.episodes.get(episodeNo)!;
    const script = episode.scripts.find((item) => item.id === episode.currentScriptId)!;
    script.reviewStatus = "APPROVED";
    episode.approvedScriptId = script.id;
  }

  // ---- store ----

  async storageReady(): Promise<boolean> {
    return this.ready;
  }

  async providerStorageReady(_providerKey: TitleWritingProviderKey): Promise<boolean> {
    return this.ready;
  }

  async createSeries(series: SeriesRecord, project: { title: string; premise: string }): Promise<{ kind: "created" | "existing"; series: SeriesRecord } | { kind: "conflict" } | { kind: "plan_unavailable" }> {
    const existing = this.series.find((item) => item.workspaceId === series.workspaceId && item.actorId === series.actorId && item.idempotencyKey === series.idempotencyKey);
    if (existing) return existing.inputHash === series.inputHash ? { kind: "existing", series: structuredClone(existing) } : { kind: "conflict" };
    if (!this.planReady) return { kind: "plan_unavailable" };
    this.projects.set(series.projectId, { workspaceId: series.workspaceId, writingMode: "series", episodeCount: series.input.episodeCount, title: project.title,
      stories: [], currentStoryId: null, approvedStoryId: null, episodes: new Map() });
    this.series.push(structuredClone(series));
    return { kind: "created", series: structuredClone(series) };
  }

  async findSeriesByKey(workspaceId: string, actorId: string, idempotencyKey: string): Promise<SeriesRecord | null> {
    const found = this.series.find((item) => item.workspaceId === workspaceId && item.actorId === actorId && item.idempotencyKey === idempotencyKey);
    return found ? structuredClone(found) : null;
  }

  private snapshotOf(series: SeriesRecord): SeriesSnapshot {
    const project = this.projects.get(series.projectId)!;
    const approved = project.approvedStoryId ? project.stories.find((item) => item.id === project.approvedStoryId) : undefined;
    const current = project.currentStoryId ? project.stories.find((item) => item.id === project.currentStoryId) : undefined;
    const episodes = [...project.episodes.entries()].sort(([a], [b]) => a - b);
    const jobs = this.jobs.filter((job) => job.seriesId === series.id);
    return structuredClone({
      series,
      project: { episodeCount: project.episodeCount, writingMode: project.writingMode, currentStoryRevisionId: project.currentStoryId,
        approvedStoryRevisionId: project.approvedStoryId, approvedStoryCurrent: approved !== undefined && approved.reviewStatus === "APPROVED" && project.currentStoryId === project.approvedStoryId,
        currentStory: storyRecord(current), approvedStory: storyRecord(approved) },
      episodes: episodes.map(([episodeNo, item]) => ({ episodeNo, episodeId: item.id, rowVersion: item.rowVersion, currentScriptRevisionId: item.currentScriptId,
        approvedScriptRevisionId: item.approvedScriptId })),
      scripts: episodes.flatMap(([episodeNo, item]) => item.scripts.filter((script) => script.id === item.currentScriptId || script.id === item.approvedScriptId)
        .map((script): SeriesScriptRevision => ({ id: script.id, episodeNo, text: script.text, contentHash: script.contentHash, reviewStatus: script.reviewStatus,
          freshnessStatus: script.freshness, sourceStoryRevisionId: script.sourceStoryRevisionId, createdBy: script.createdBy, createdAt: script.createdAt }))),
      plans: this.plans.filter((item) => item.seriesId === series.id),
      ledgers: this.ledgers.filter((item) => item.seriesId === series.id),
      decisions: this.decisions.filter((item) => item.seriesId === series.id),
      grants: this.grants.filter((item) => item.seriesId === series.id),
      jobs: jobs.map((run) => ({ run, stages: this.stages.filter((stage) => stage.runId === run.id), calls: this.calls.filter((call) => call.runId === run.id) })),
    });
  }

  async snapshot(workspaceId: string, projectId: string): Promise<SeriesSnapshot | null> {
    const series = this.series.find((item) => item.workspaceId === workspaceId && item.projectId === projectId);
    return series ? this.snapshotOf(series) : null;
  }

  async findGrantByKey(workspaceId: string, actorId: string, idempotencyKey: string): Promise<SeriesGrantRecord | null> {
    const found = this.grants.find((item) => item.workspaceId === workspaceId && item.actorId === actorId && item.idempotencyKey === idempotencyKey);
    return found ? structuredClone(found) : null;
  }

  private recent(workspaceId: string, sinceIso: string): number {
    return this.calls.filter((call) => call.workspaceId === workspaceId && call.createdAt >= sinceIso && counted(call)).length
      + this.otherCalls.filter((call) => call.workspaceId === workspaceId && call.createdAt >= sinceIso).length;
  }

  private activeRuns(workspaceId: string): number {
    return this.jobs.filter((job) => job.workspaceId === workspaceId && job.state === "running").length + this.otherRunning.size;
  }

  private insertJob(plan: SeriesJobPlan, executor: { executorId: string; leaseUntil: string } | null): void {
    if (this.jobs.some((job) => job.seriesId === plan.run.seriesId && job.seq === plan.run.seq)) throw new Error("job sequence taken");
    this.jobs.push(structuredClone({ ...plan.run, ...(executor ? executor : {}) }));
    plan.stages.forEach((stage, ordinal) => this.stages.push({
      runId: plan.run.id, stageKey: stage.stageKey, ordinal,
      state: stage.reused ? "completed" : "pending", attemptNo: 0, errorCode: null,
      output: stage.reused ? structuredClone(stage.reused.output) : null, outputHash: stage.reused?.outputHash ?? null,
      dependsOn: stage.reused ? structuredClone(stage.reused.dependsOn) : null, reusedFrom: stage.reused?.fromRunId ?? null,
      scriptSave: seriesStageEpisodeNo(stage.stageKey) !== null ? "pending" : null, scriptRevisionId: null, updatedAt: plan.run.createdAt,
    }));
  }

  async createGrant(grant: SeriesGrantRecord, limits: SeriesLimits, admit: (snapshot: SeriesSnapshot) => SeriesAdmission): Promise<SeriesGrantCreation> {
    const existing = this.grants.find((item) => item.workspaceId === grant.workspaceId && item.actorId === grant.actorId && item.idempotencyKey === grant.idempotencyKey);
    if (existing) return existing.requestHash === grant.requestHash && existing.projectId === grant.projectId ? { kind: "existing", grant: structuredClone(existing) } : { kind: "conflict" };
    const series = this.series.find((item) => item.id === grant.seriesId && item.workspaceId === grant.workspaceId)!;
    const running = this.jobs.find((job) => job.projectId === grant.projectId && job.state === "running");
    if (running) return { kind: "active", runKind: "series", runId: running.id };
    const other = this.otherRunning.get(grant.projectId);
    if (other) return { kind: "active", runKind: other, runId: "" };
    const admission = admit(this.snapshotOf(series));
    if (admission.kind === "refused") return admission;
    if (this.activeRuns(grant.workspaceId) >= limits.maxActiveRuns) return { kind: "blocked", code: "SERIES_ACTIVE_RUN_CAP" };
    // Daily admission of the current bounded stage only (its job), never of the whole grant; each send still reserves.
    const required = seriesJobSends(admission.job);
    const remaining = Math.max(0, limits.maxCallsPerDay - this.recent(grant.workspaceId, limits.sinceIso));
    if (remaining < required) return { kind: "daily_quota_low", requiredCalls: required, remainingCalls: remaining };
    this.grants.push(structuredClone(grant));
    this.insertJob(admission.job, null);
    return { kind: "created", grant: structuredClone(grant), jobId: admission.job.run.id };
  }

  async getJob(workspaceId: string, jobId: string): Promise<SeriesJobBundle | null> {
    const run = this.jobs.find((item) => item.id === jobId && item.workspaceId === workspaceId);
    return run ? structuredClone({ run, stages: this.stages.filter((stage) => stage.runId === run.id), calls: this.calls.filter((call) => call.runId === run.id) }) : null;
  }

  private job(jobId: string): SeriesJobRecord {
    const run = this.jobs.find((item) => item.id === jobId);
    if (!run) throw new Error("job not found");
    return run;
  }

  private grant(grantId: string): SeriesGrantRecord {
    const found = this.grants.find((item) => item.id === grantId);
    if (!found) throw new Error("grant not found");
    return found;
  }

  private stage(jobId: string, stageKey: string): SeriesStageRecord {
    const found = this.stages.find((item) => item.runId === jobId && item.stageKey === stageKey);
    if (!found) throw new Error("stage not found");
    return found;
  }

  private seriesOf(run: SeriesJobRecord): SeriesRecord {
    return this.series.find((item) => item.id === run.seriesId)!;
  }

  /** A later job (by sequence) of the same kind and batch exists in the series. */
  private superseded(run: SeriesJobRecord): boolean {
    return this.jobs.some((job) => job.seriesId === run.seriesId && job.kind === run.kind && job.batchNo === run.batchNo && job.seq > run.seq);
  }

  private owns(run: SeriesJobRecord, workspaceId: string, executorId: string, nowIso: string): boolean {
    return run.workspaceId === workspaceId && run.state === "running" && run.executorId === executorId && !expired(run.leaseUntil, nowIso);
  }

  async claimJob(workspaceId: string, jobId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<boolean> {
    const run = this.jobs.find((item) => item.id === jobId && item.workspaceId === workspaceId);
    if (!run || run.state !== "running") return false;
    if (run.executorId !== null && run.executorId !== executorId && !expired(run.leaseUntil, nowIso)) return false;
    if (run.executorId !== executorId && this.calls.some((call) => call.runId === jobId && (call.state === "reserved" || call.state === "submitted"))) return false;
    Object.assign(run, { executorId, leaseUntil, updatedAt: nowIso });
    return true;
  }

  async completeLocalStage(workspaceId: string, jobId: string, executorId: string, stageKey: string, output: SeriesStageOutput, outputHash: string, nowIso: string): Promise<boolean> {
    const run = this.job(jobId);
    if (!this.owns(run, workspaceId, executorId, nowIso)) return false;
    const stage = this.stage(jobId, stageKey);
    if (stage.state !== "pending") return false;
    Object.assign(stage, { state: "completed", output: structuredClone(output), outputHash, dependsOn: {}, updatedAt: nowIso });
    run.updatedAt = nowIso;
    return true;
  }

  async reserveCall(call: SeriesCallRecord, limits: { sinceIso: string; maxCallsPerDay: number }, nowIso: string, leaseUntil: string): Promise<SeriesCallReservation> {
    const run = this.job(call.runId);
    if (!this.owns(run, call.workspaceId, call.executorId, nowIso)) return { kind: "lost" };
    const grant = this.grant(run.grantId);
    if (run.cancelRequestedAt !== null || grant.cancelRequestedAt !== null) return { kind: "canceled" };
    // Taken over by a later job of the same batch or final review: never another send.
    if (this.superseded(run)) return { kind: "blocked", code: "upstream_job_superseded" };
    // What the job was frozen on, read again in this same step: a story or previous episode saved since stops the send.
    const upstream = seriesJobUpstreamChange(this.snapshotOf(this.seriesOf(run)), run);
    if (upstream) return { kind: "upstream", code: upstream };
    if (run.callsUsed >= run.callCap) return { kind: "blocked", code: "SERIES_JOB_CAP" };
    if (grant.callsUsed >= grant.callBudget) return { kind: "blocked", code: "SERIES_GRANT_BUDGET" };
    if (this.recent(call.workspaceId, limits.sinceIso) >= limits.maxCallsPerDay) return { kind: "blocked", code: "SERIES_DAILY_CAP" };
    const stage = this.stage(call.runId, call.stageKey);
    if (stage.state !== "pending") return { kind: "lost" };
    this.calls.push(structuredClone(call));
    Object.assign(stage, { state: "reserved", attemptNo: call.attemptNo, errorCode: null, updatedAt: nowIso });
    Object.assign(run, { callsUsed: run.callsUsed + 1, leaseUntil, updatedAt: nowIso });
    Object.assign(grant, { callsUsed: grant.callsUsed + 1, updatedAt: nowIso });
    return { kind: "reserved" };
  }

  async markCallSubmitted(workspaceId: string, callId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<SeriesCallSubmission> {
    const call = this.calls.find((item) => item.id === callId);
    if (!call) return "lost";
    const run = this.job(call.runId);
    if (call.state !== "reserved" || call.executorId !== executorId || !this.owns(run, workspaceId, executorId, nowIso)) return "lost";
    const stage = this.stage(call.runId, call.stageKey);
    if (run.cancelRequestedAt !== null || this.grant(run.grantId).cancelRequestedAt !== null) {
      Object.assign(call, { state: "rejected", errorCode: TITLE_WRITING_CANCELED_BEFORE_SEND, finishedAt: nowIso });
      Object.assign(stage, { state: "canceled", updatedAt: nowIso });
      this.release(run);
      return "canceled";
    }
    // The last check before the send (this step is the admission point): a dependency changed since the reservation
    // closes the call as never sent and gives its reservation back once (the call record stays).
    const upstream = seriesJobUpstreamChange(this.snapshotOf(this.seriesOf(run)), run);
    if (upstream) {
      Object.assign(call, { state: "rejected", errorCode: SERIES_UPSTREAM_BEFORE_SEND, finishedAt: nowIso });
      Object.assign(stage, { state: "pending", updatedAt: nowIso });
      this.release(run);
      return { upstream };
    }
    call.state = "submitted";
    Object.assign(stage, { state: "submitted", updatedAt: nowIso });
    Object.assign(run, { leaseUntil, updatedAt: nowIso });
    return "submitted";
  }

  async finishCall(workspaceId: string, callId: string, executorId: string, patch: SeriesCallFinish, nowIso: string): Promise<boolean> {
    const call = this.calls.find((item) => item.id === callId);
    if (!call) return false;
    const run = this.job(call.runId);
    if (run.workspaceId !== workspaceId || call.state !== "submitted" || call.executorId !== executorId || run.executorId !== executorId) return false;
    Object.assign(call, { state: patch.state, errorCode: patch.errorCode, providerRequestId: patch.providerRequestId, responseModel: patch.responseModel, usage: patch.usage, finishedAt: nowIso });
    Object.assign(this.stage(call.runId, call.stageKey), { state: patch.state, errorCode: patch.errorCode, output: structuredClone(patch.output),
      outputHash: patch.outputHash, dependsOn: patch.dependsOn, updatedAt: nowIso });
    run.updatedAt = nowIso;
    return true;
  }

  private stopGrant(grant: SeriesGrantRecord, state: SeriesGrantRecord["state"], reason: string | null, nowIso: string): void {
    Object.assign(grant, { state, stopReason: reason, updatedAt: nowIso });
  }

  async finishJob(workspaceId: string, jobId: string, executorId: string, state: Exclude<SeriesRunState, "running" | "completed">, errorCode: string | null, nowIso: string): Promise<boolean> {
    const run = this.job(jobId);
    if (run.workspaceId !== workspaceId || run.state !== "running" || run.executorId !== executorId) return false;
    if (state === "canceled") for (const stage of this.stages.filter((item) => item.runId === jobId && item.state === "pending")) Object.assign(stage, { state: "canceled", updatedAt: nowIso });
    Object.assign(run, { state, errorCode, executorId: null, leaseUntil: null, updatedAt: nowIso });
    this.stopGrant(this.grant(run.grantId), state === "canceled" ? "canceled" : "stopped", errorCode ?? state, nowIso);
    return true;
  }

  private savePlanArtifact(series: SeriesRecord, plan: Omit<SeriesPlanRevisionRecord, "storyRevisionId" | "storyHash" | "storySave">, storyText: string | null,
    executor: string, nowIso: string): void {
    const project = this.projects.get(series.projectId)!;
    let storySave: SeriesPlanRevisionRecord["storySave"] = "conflict";
    let storyRevisionId: string | null = null;
    let storyHash: string | null = null;
    if (project.currentStoryId === null && storyText !== null) {
      storyRevisionId = randomUUID();
      storyHash = textHash(storyText);
      replaceStory(project, { id: storyRevisionId, text: storyText, contentHash: storyHash, reviewStatus: "DRAFT", createdBy: executor, createdAt: nowIso });
      storySave = "saved";
    }
    this.plans.push(structuredClone({ ...plan, storyRevisionId, storyHash, storySave }));
  }

  /** Gives a never-sent reservation back to its job and grant (the call record stays, as rejected before its send). */
  private release(run: SeriesJobRecord): void {
    const grant = this.grant(run.grantId);
    run.callsUsed = Math.max(0, run.callsUsed - 1);
    grant.callsUsed = Math.max(0, grant.callsUsed - 1);
  }

  async completeJob(workspaceId: string, jobId: string, executorId: string, artifacts: SeriesJobArtifacts, limits: SeriesLimits, nowIso: string, leaseUntil: string,
    next: (snapshot: SeriesSnapshot) => SeriesAdmission | { kind: "done" }): Promise<SeriesNextStep> {
    const run = this.job(jobId);
    if (!this.owns(run, workspaceId, executorId, nowIso)) return { kind: "lost" };
    if (this.stages.some((stage) => stage.runId === jobId && stage.state !== "completed")) return { kind: "lost" };
    // A later job of the same batch or final review took this one over: its result is never saved over the later one's.
    if (this.superseded(run)) {
      Object.assign(run, { state: "needs_attention", errorCode: "upstream_job_superseded", executorId: null, leaseUntil: null, updatedAt: nowIso });
      this.stopGrant(this.grant(run.grantId), "stopped", "upstream_job_superseded", nowIso);
      return { kind: "grant_stopped", reason: "upstream_job_superseded" };
    }
    const series = this.series.find((item) => item.id === run.seriesId)!;
    if (artifacts.kind === "plan") this.savePlanArtifact(series, artifacts.plan, artifacts.storyText, `series-writing:${jobId}`, nowIso);
    if (artifacts.kind === "batch") this.ledgers.push(structuredClone(artifacts.ledger));
    Object.assign(run, { state: "completed", errorCode: null, executorId: null, leaseUntil: null, updatedAt: nowIso });
    const grant = this.grant(run.grantId);
    return this.handOver(series, grant, limits, nowIso, { executorId, leaseUntil }, next);
  }

  private handOver(series: SeriesRecord, grant: SeriesGrantRecord, limits: SeriesLimits, nowIso: string, executor: { executorId: string; leaseUntil: string } | null,
    next: (snapshot: SeriesSnapshot) => SeriesAdmission | { kind: "done" }): SeriesNextStep {
    if (grant.cancelRequestedAt !== null) {
      this.stopGrant(grant, "canceled", "canceled", nowIso);
      return { kind: "grant_stopped", reason: "canceled" };
    }
    const decision = next(this.snapshotOf(series));
    if (decision.kind === "done") {
      this.stopGrant(grant, "completed", null, nowIso);
      return { kind: "grant_completed" };
    }
    if (decision.kind === "refused") {
      this.stopGrant(grant, "stopped", decision.code, nowIso);
      return { kind: "grant_stopped", reason: decision.code };
    }
    if (this.activeRuns(grant.workspaceId) >= limits.maxActiveRuns) {
      this.stopGrant(grant, "stopped", "active_run_cap", nowIso);
      return { kind: "grant_stopped", reason: "active_run_cap" };
    }
    const required = seriesJobSends(decision.job);
    if (Math.max(0, limits.maxCallsPerDay - this.recent(grant.workspaceId, limits.sinceIso)) < required) {
      this.stopGrant(grant, "stopped", "daily_quota_low", nowIso);
      return { kind: "grant_stopped", reason: "daily_quota_low" };
    }
    // The rest of the scope must still fit the grant: a resend spent earlier is never covered by adding budget.
    if (grant.callsUsed + seriesGrantRemainingSends(this.snapshotOf(series), grant) - seriesJobNormalSends(decision.job) + required > grant.callBudget) {
      this.stopGrant(grant, "stopped", "grant_budget_exhausted", nowIso);
      return { kind: "grant_stopped", reason: "grant_budget_exhausted" };
    }
    this.insertJob(decision.job, executor);
    Object.assign(grant, { state: "running", stopReason: null, updatedAt: nowIso });
    return { kind: "job", jobId: decision.job.run.id };
  }

  async requestCancel(workspaceId: string, projectId: string, grantId: string, nowIso: string): Promise<SeriesGrantRecord | null> {
    const grant = this.grants.find((item) => item.id === grantId && item.workspaceId === workspaceId && item.projectId === projectId);
    if (!grant) return null;
    if (grant.state === "running" && grant.cancelRequestedAt === null) {
      Object.assign(grant, { cancelRequestedAt: nowIso, updatedAt: nowIso });
      const running = this.jobs.find((job) => job.grantId === grantId && job.state === "running");
      if (running) Object.assign(running, { cancelRequestedAt: nowIso, updatedAt: nowIso });
      else this.stopGrant(grant, "canceled", "canceled", nowIso);
    } else if (grant.state === "stopped") {
      Object.assign(grant, { cancelRequestedAt: nowIso });
      this.stopGrant(grant, "canceled", "canceled", nowIso);
    }
    return structuredClone(grant);
  }

  async prepareResume(workspaceId: string, projectId: string, grantId: string, request: { resumeKey: string; requestHash: string; confirmedCallIds: readonly string[];
    providerReady: boolean; limits: SeriesLimits }, nowIso: string, next: (snapshot: SeriesSnapshot) => SeriesAdmission | { kind: "done" }): Promise<SeriesResumePreparation> {
    const grant = this.grants.find((item) => item.id === grantId && item.workspaceId === workspaceId && item.projectId === projectId);
    if (!grant) return { kind: "not_found" };
    const previous = this.resumes.find((item) => item.grantId === grantId && item.key === request.resumeKey);
    if (previous) return previous.requestHash === request.requestHash ? { kind: "replayed", grant: structuredClone(grant) } : { kind: "key_conflict" };
    if (grant.state === "running") return { kind: "active" };
    // A canceled grant is final: going on is a new grant the person confirms again.
    if (grant.state === "completed" || grant.state === "canceled") return { kind: "not_resumable" };
    if (this.otherRunning.has(projectId) || this.jobs.some((job) => job.projectId === projectId && job.state === "running")) return { kind: "active" };
    if (this.activeRuns(workspaceId) >= request.limits.maxActiveRuns) return { kind: "active_cap" };
    const series = this.series.find((item) => item.id === grant.seriesId)!;
    const jobs = this.jobs.filter((job) => job.grantId === grantId).sort((a, b) => a.seq - b.seq);
    const last = jobs.at(-1)!;
    if (last.state !== "completed") {
      const stages = this.stages.filter((item) => item.runId === last.id);
      const uncertain = currentUncertainCallIds(stages.map((stage) => ({ stepKey: stage.stageKey as TitleWritingStepKey, state: stage.state, attemptNo: stage.attemptNo })),
        this.calls.filter((call) => call.runId === last.id).map((call) => ({ callId: call.id, stepKey: call.stageKey as TitleWritingStepKey, attemptNo: call.attemptNo, state: call.state })));
      const confirmed = [...request.confirmedCallIds].sort();
      if (uncertain.length > 0 && confirmed.length === 0) return { kind: "needs_confirmation" };
      if (uncertain.length !== confirmed.length || uncertain.some((id, index) => id !== confirmed[index])) return { kind: "stale_confirmation" };
      const redo = stages.filter((stage) => stage.state === "unknown" || stage.state === "rejected" || stage.state === "canceled");
      const sends = redo.some((stage) => stage.stageKey !== "sources") || stages.some((stage) => stage.state === "pending" && stage.stageKey !== "sources");
      if (sends && !request.providerReady) return { kind: "provider_unconfigured" };
      if (sends && (grant.callsUsed + seriesGrantRemainingSends(this.snapshotOf(series), grant) > grant.callBudget || last.callsUsed >= last.callCap)) return { kind: "budget_exhausted" };
      const upstream = seriesJobUpstreamChange(this.snapshotOf(series), last);
      if (upstream) return { kind: "refused", code: upstream };
      this.resumes.push({ grantId, key: request.resumeKey, requestHash: request.requestHash });
      for (const stage of redo) Object.assign(stage, { state: "pending", updatedAt: nowIso });
      Object.assign(last, { state: "running", errorCode: null, cancelRequestedAt: null, executorId: null, leaseUntil: null, updatedAt: nowIso });
      Object.assign(grant, { state: "running", stopReason: null, cancelRequestedAt: null, updatedAt: nowIso });
      return { kind: "ok", jobId: last.id };
    }
    // The last job completed and the grant stopped between jobs (a blocker, the daily cap): the next job, if the series may go on.
    const decision = next(this.snapshotOf(series));
    if (decision.kind === "done") return { kind: "not_resumable" };
    if (decision.kind === "refused") return { kind: "refused", code: decision.code, ...(decision.details ? { details: decision.details } : {}) };
    if (!request.providerReady) return { kind: "provider_unconfigured" };
    if (grant.callsUsed + seriesGrantRemainingSends(this.snapshotOf(series), grant) > grant.callBudget) return { kind: "budget_exhausted" };
    const required = seriesJobSends(decision.job);
    const remaining = Math.max(0, request.limits.maxCallsPerDay - this.recent(workspaceId, request.limits.sinceIso));
    if (remaining < required) return { kind: "daily_quota_low", requiredCalls: required, remainingCalls: remaining };
    this.resumes.push({ grantId, key: request.resumeKey, requestHash: request.requestHash });
    Object.assign(grant, { state: "running", stopReason: null, cancelRequestedAt: null, updatedAt: nowIso });
    this.insertJob(decision.job, null);
    return { kind: "ok", jobId: decision.job.run.id };
  }

  async recoverExpired(workspaceId: string, nowIso: string): Promise<number> {
    let recovered = 0;
    for (const run of this.jobs) {
      if (run.workspaceId !== workspaceId || run.state !== "running" || run.executorId === null || !expired(run.leaseUntil, nowIso)) continue;
      recovered += 1;
      let uncertain = false;
      for (const call of this.calls.filter((item) => item.runId === run.id)) {
        const stage = this.stage(run.id, call.stageKey);
        if (call.state === "reserved") {
          // Never sent: its reservation is given back (the call stays, rejected before its send), so the stage is sent once
          // within the job's own budget; it never needs a person's resend.
          Object.assign(call, { state: "rejected", errorCode: TITLE_WRITING_LOST_BEFORE_SEND, finishedAt: nowIso });
          Object.assign(stage, { state: "pending", updatedAt: nowIso });
          this.release(run);
        } else if (call.state === "submitted") {
          Object.assign(call, { state: "unknown", errorCode: TITLE_WRITING_LOST_AFTER_SEND, finishedAt: nowIso });
          Object.assign(stage, { state: "unknown", errorCode: TITLE_WRITING_LOST_AFTER_SEND, updatedAt: nowIso });
          uncertain = true;
        }
      }
      if (uncertain) {
        Object.assign(run, { state: "needs_attention", errorCode: TITLE_WRITING_LOST_AFTER_SEND, executorId: null, leaseUntil: null, updatedAt: nowIso });
        this.stopGrant(this.grant(run.grantId), "stopped", TITLE_WRITING_LOST_AFTER_SEND, nowIso);
      } else {
        Object.assign(run, { executorId: null, leaseUntil: null, updatedAt: nowIso });
      }
    }
    return recovered;
  }

  async listClaimable(workspaceId: string, nowIso: string, limit: number): Promise<string[]> {
    return this.jobs.filter((run) => run.workspaceId === workspaceId && run.state === "running" && (run.executorId === null || expired(run.leaseUntil, nowIso)))
      .slice(0, limit).map((run) => run.id);
  }

  private busy(projectId: string): boolean {
    return this.jobs.some((job) => job.projectId === projectId && job.state === "running");
  }

  async savePlanRevision(workspaceId: string, projectId: string, revision: SeriesPlanRevisionRecord, expected: { parentId: string | null; storyRevisionId: string | null },
    story: SeriesPlanStory): Promise<"saved" | "conflict" | "story_conflict" | "not_found" | "active"> {
    const series = this.series.find((item) => item.workspaceId === workspaceId && item.projectId === projectId);
    if (!series) return "not_found";
    if (this.busy(projectId)) return "active";
    const current = seriesCurrentPlan(this.snapshotOf(series));
    if ((current?.id ?? null) !== expected.parentId) return "conflict";
    const project = this.projects.get(projectId)!;
    if (project.currentStoryId !== expected.storyRevisionId) return "story_conflict";
    let storyRevisionId: string;
    let storyHash: string;
    if (story.mode === "from_plan") {
      storyRevisionId = randomUUID();
      storyHash = textHash(story.text);
      replaceStory(project, { id: storyRevisionId, text: story.text, contentHash: storyHash, reviewStatus: "DRAFT", createdBy: revision.createdBy, createdAt: revision.createdAt });
    } else {
      const adopted = project.stories.find((item) => item.id === project.currentStoryId);
      if (!adopted) return "story_conflict";
      storyRevisionId = adopted.id;
      storyHash = adopted.contentHash;
    }
    this.plans.push(structuredClone({ ...revision, revisionNo: (current?.revisionNo ?? 0) + 1, storyRevisionId, storyHash, storySave: "saved" as const }));
    return "saved";
  }

  async saveLedgerRevision(workspaceId: string, projectId: string, revision: SeriesLedgerRevisionRecord, expectedParentId: string | null,
    basisNow: (snapshot: SeriesSnapshot) => Record<string, string> | null, expectedBasis: Record<string, string>):
    Promise<"saved" | "conflict" | "stale" | "blocked" | "not_found" | "active"> {
    const series = this.series.find((item) => item.workspaceId === workspaceId && item.projectId === projectId);
    if (!series) return "not_found";
    if (this.busy(projectId)) return "active";
    const current = this.ledgers.filter((item) => item.seriesId === series.id && item.batchNo === revision.batchNo).sort((a, b) => b.revisionNo - a.revisionNo)[0];
    if ((current?.id ?? null) !== expectedParentId) return "conflict";
    const now = basisNow(this.snapshotOf(series));
    if (!now) return "blocked";
    if (!sameBasis(now, expectedBasis)) return "stale";
    this.ledgers.push(structuredClone({ ...revision, revisionNo: (current?.revisionNo ?? 0) + 1 }));
    return "saved";
  }

  async saveDecision(workspaceId: string, projectId: string, decision: SeriesDecisionRecord, current: (snapshot: SeriesSnapshot) => Record<string, string> | null):
    Promise<"saved" | "conflict" | "not_ready" | "not_found" | "active"> {
    const series = this.series.find((item) => item.workspaceId === workspaceId && item.projectId === projectId);
    if (!series) return "not_found";
    if (this.busy(projectId)) return "active";
    const now = current(this.snapshotOf(series));
    if (!now) return "not_ready";
    if (!sameBasis(now, decision.basis)) return "conflict";
    this.decisions.push(structuredClone(decision));
    return "saved";
  }

  async placeBatch(workspaceId: string, projectId: string, batchNo: number, candidates: (snapshot: SeriesSnapshot) => SeriesPlacementCandidates,
    actorId: string, nowIso: string): Promise<SeriesPlacement> {
    const series = this.series.find((item) => item.workspaceId === workspaceId && item.projectId === projectId);
    if (!series) return { kind: "not_found" };
    if (this.busy(projectId)) return { kind: "not_ready", reason: "job_running" };
    const project = this.projects.get(projectId)!;
    const snapshot = this.snapshotOf(series);
    const plan = seriesCurrentPlan(snapshot);
    if (!plan || plan.storySave !== "saved" || !plan.storyRevisionId || !project.stories.some((item) => item.id === plan.storyRevisionId)) return { kind: "story_not_saved" };
    if (!project.approvedStoryId || project.currentStoryId !== project.approvedStoryId) return { kind: "story_not_approved" };
    if (project.approvedStoryId !== plan.storyRevisionId) return { kind: "story_changed" };
    const { first, last } = seriesBatchRange(series.input.episodeCount, batchNo);
    if (project.writingMode !== "series" || project.episodeCount !== series.input.episodeCount || project.episodes.size !== series.input.episodeCount) return { kind: "plan_mismatch" };
    // The dependencies checked again on the state of this same step: nothing written from a plan, ledger or review no longer current.
    const chosen = candidates(snapshot);
    if (chosen.kind === "blocked") return { kind: "not_ready", reason: chosen.reason };
    let placed = 0;
    const conflicts: number[] = [];
    for (const script of chosen.scripts) {
      if (script.episodeNo < first || script.episodeNo > last) return { kind: "plan_mismatch" };
      const stage = this.stage(script.runId, script.stageKey);
      if (stage.scriptSave !== "pending") continue;
      const episode = project.episodes.get(script.episodeNo)!;
      if (episode.currentScriptId !== null) {
        Object.assign(stage, { scriptSave: "conflict", updatedAt: nowIso });
        conflicts.push(script.episodeNo);
        continue;
      }
      const id = randomUUID();
      episode.scripts.push({ id, text: script.text, contentHash: textHash(script.text), reviewStatus: "DRAFT", freshness: "CURRENT", sourceStoryRevisionId: project.approvedStoryId,
        createdBy: actorId, createdAt: nowIso });
      episode.currentScriptId = id;
      episode.rowVersion += 1;
      Object.assign(stage, { scriptSave: "saved", scriptRevisionId: id, updatedAt: nowIso });
      placed += 1;
    }
    return { kind: "ok", placed, conflicts };
  }
}
