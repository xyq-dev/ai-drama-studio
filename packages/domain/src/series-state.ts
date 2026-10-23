import {
  SERIES_JOB_MAX_CALLS,
  SERIES_PACKAGE_SCHEMA,
  SERIES_WRITING_CHECKS_VERSION,
  SERIES_WRITING_JOB_SCHEMA,
  SERIES_WRITING_PROMPT_VERSION,
  SERIES_RESEARCH_CONTRACT,
  currentUncertainCallIds,
  seriesBatchCalls,
  seriesBatchCount,
  seriesBatchOf,
  seriesBatchRange,
  seriesJobStageKeys,
  seriesNormalCalls,
  seriesPlanCalls,
  seriesScopeJobs,
  seriesScopeShapeValid,
  seriesStageEpisodeNo,
  seriesStageKind,
  type SeriesAdmission,
  type SeriesCallRecord,
  type SeriesCompletion,
  type SeriesEpisode,
  type SeriesGrantRecord,
  type SeriesJobInput,
  type SeriesJobKind,
  type SeriesJobPlan,
  type SeriesJobRecord,
  type SeriesLedger,
  type SeriesLedgerRevisionRecord,
  type SeriesPlacementCandidates,
  type SeriesPlanContent,
  type SeriesPlanRevisionRecord,
  type SeriesReviewOutput,
  type SeriesScope,
  type SeriesScriptRevision,
  type SeriesSnapshot,
  type SeriesStageRecord,
  type SeriesStoryRevision,
  type SeriesVersionRef,
  type TitleWritingStepKey,
} from "@ai-drama/contracts";
import {
  SERIES_NO_STORY,
  applySeriesContinuity,
  formatSeriesEpisode,
  seriesContextFromPlan,
  seriesInitialLedger,
  seriesOutlineLine,
  seriesPlanContext,
  seriesSummaryBasisHash,
  type SeriesContext,
} from "./series-writing";
import { canonicalInputHash } from "./text-chain";

/**
 * Series state, computed from one snapshot: which version of each episode is current, whether each batch's ledger and
 * review still describe those versions, what may be written next, and the delivery package. Pure; nothing is stored.
 */

type JobBundle = SeriesSnapshot["jobs"][number];

function jobsInOrder(snapshot: SeriesSnapshot): JobBundle[] {
  return [...snapshot.jobs].sort((a, b) => a.run.seq - b.run.seq);
}

export function seriesCurrentPlan(snapshot: SeriesSnapshot): SeriesPlanRevisionRecord | null {
  return [...snapshot.plans].sort((a, b) => b.revisionNo - a.revisionNo)[0] ?? null;
}

/** The content hash of the story a plan revision is bound to, or SERIES_NO_STORY. */
export function seriesPlanStoryHash(plan: SeriesPlanRevisionRecord | null): string {
  return plan?.storyHash ?? SERIES_NO_STORY;
}

export interface SeriesStoryBinding {
  /** ok: the work's current story is the one the current plan is bound to; changed: the workbench saved another one. */
  status: "none" | "ok" | "changed";
  planStoryRevisionId: string | null;
  planStoryHash: string | null;
  current: SeriesStoryRevision | null;
  approved: SeriesStoryRevision | null;
}

/**
 * Whether the series still writes from the work's current story: the current plan revision is bound to one story
 * revision (saved with it or adopted by a person), and a story saved since in the workbench stops every further send
 * until a person binds plan and story again (a new plan revision), confirms the ledgers and reviews again.
 */
export function seriesStoryBinding(snapshot: SeriesSnapshot): SeriesStoryBinding {
  const plan = seriesCurrentPlan(snapshot);
  const current = snapshot.project.currentStory;
  const approved = snapshot.project.approvedStory;
  if (!plan) return { status: "none", planStoryRevisionId: null, planStoryHash: null, current, approved };
  return { status: plan.storyRevisionId === (current?.id ?? null) ? "ok" : "changed", planStoryRevisionId: plan.storyRevisionId, planStoryHash: plan.storyHash,
    current, approved };
}

/** The latest completed model version of each episode across jobs (later jobs, then later ordinals, win). */
export function seriesModelVersions(snapshot: SeriesSnapshot): Map<number, { run: SeriesJobRecord; stage: SeriesStageRecord }> {
  const result = new Map<number, { run: SeriesJobRecord; stage: SeriesStageRecord }>();
  for (const job of jobsInOrder(snapshot)) {
    for (const stage of [...job.stages].sort((a, b) => a.ordinal - b.ordinal)) {
      const episodeNo = seriesStageEpisodeNo(stage.stageKey);
      if (episodeNo !== null && stage.state === "completed" && stage.output !== null) result.set(episodeNo, { run: job.run, stage });
    }
  }
  return result;
}

export interface SeriesCurrentVersion {
  ref: SeriesVersionRef;
  /** The structured model version (a stage, or the workbench script that is exactly a placed stage). */
  episode: SeriesEpisode | null;
  /** The workbench script when it is a person's edit. */
  script: SeriesScriptRevision | null;
  /** The workbench script revision holding this version, when placed. */
  placedScript: SeriesScriptRevision | null;
  /**
   * The workbench marked this version's script STALE (its story was replaced): the text is unchanged but its source is
   * not current, so it is never read as the valid version until a person saves the episode again from the current story.
   */
  sourceStale: boolean;
}

function stageRef(episodeNo: number, run: SeriesJobRecord, stage: SeriesStageRecord): SeriesVersionRef {
  return { episodeNo, kind: "stage", runId: run.id, stageKey: stage.stageKey, hash: stage.outputHash! };
}

/**
 * The current version of an episode: the work's own current script when there is one (a placed model version is still
 * read as that version; any other script is a person's edit), else the latest completed model version.
 */
export function seriesCurrentVersion(snapshot: SeriesSnapshot, episodeNo: number, models = seriesModelVersions(snapshot)): SeriesCurrentVersion | null {
  const formal = snapshot.episodes.find((item) => item.episodeNo === episodeNo);
  if (formal?.currentScriptRevisionId) {
    const script = snapshot.scripts.find((item) => item.id === formal.currentScriptRevisionId) ?? null;
    const sourceStale = script?.freshnessStatus === "STALE";
    for (const job of snapshot.jobs) {
      const stage = job.stages.find((item) => item.scriptRevisionId === formal.currentScriptRevisionId && item.output !== null);
      if (stage) return { ref: stageRef(episodeNo, job.run, stage), episode: stage.output as unknown as SeriesEpisode, script: null, placedScript: script, sourceStale };
    }
    if (script) return { ref: { episodeNo, kind: "script", scriptRevisionId: script.id, hash: script.contentHash }, episode: null, script, placedScript: script, sourceStale };
  }
  const model = models.get(episodeNo);
  return model ? { ref: stageRef(episodeNo, model.run, model.stage), episode: model.stage.output as unknown as SeriesEpisode, script: null, placedScript: null,
    sourceStale: false } : null;
}

export function sameVersion(a: SeriesVersionRef | null | undefined, b: SeriesVersionRef | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.kind !== b.kind || a.hash !== b.hash || a.episodeNo !== b.episodeNo) return false;
  return a.kind === "script" ? a.scriptRevisionId === (b as typeof a).scriptRevisionId : true;
}

export type SeriesPlanStatus = "none" | "passed" | "needs_revision" | "unreviewed" | "cleared";

export function seriesDecisionFor(snapshot: SeriesSnapshot, target: string, basis: Record<string, string>) {
  return [...snapshot.decisions].reverse().find((item) => item.target === target
    && Object.keys(basis).length === Object.keys(item.basis).length && Object.entries(basis).every(([key, value]) => item.basis[key] === value)) ?? null;
}

function planReviewBasis(plan: SeriesPlanRevisionRecord): Record<string, string> {
  return { plan: plan.contentHash, story: seriesPlanStoryHash(plan) };
}

/**
 * What a person's review of the plan covers: the plan revision's content and the story it is bound to. Null while the
 * work's story is not the plan's (a review never stands in for binding plan and story again).
 */
export function seriesPlanDecisionBasis(snapshot: SeriesSnapshot): Record<string, string> | null {
  const plan = seriesCurrentPlan(snapshot);
  return plan && seriesStoryBinding(snapshot).status !== "changed" ? planReviewBasis(plan) : null;
}

export function seriesPlanStatus(snapshot: SeriesSnapshot): SeriesPlanStatus {
  const plan = seriesCurrentPlan(snapshot);
  if (!plan) return "none";
  if (seriesDecisionFor(snapshot, "plan", planReviewBasis(plan))) return "cleared";
  if (plan.review) return plan.review.passed ? "passed" : "needs_revision";
  return "unreviewed";
}

export type SeriesLedgerStatus = "none" | "valid" | "confirmed" | "pending_confirmation" | "stale";
export type SeriesReviewStatus = "none" | "passed" | "needs_revision" | "stale" | "cleared";

export interface SeriesBatchState {
  batchNo: number;
  first: number;
  last: number;
  /** Episodes with a current version (a model stage or a person's script). */
  written: number;
  size: number;
  /**
   * A job of this batch completed: every model stage of the batch and its batch review ran. A person's scripts never
   * stand in for them, so a batch whose job stopped stays the next batch until a job of it completes.
   */
  generated: boolean;
  versions: Array<SeriesCurrentVersion | null>;
  ledger: { status: SeriesLedgerStatus; revision: SeriesLedgerRevisionRecord | null };
  review: { status: SeriesReviewStatus; output: SeriesReviewOutput | null; runId: string | null };
  /** Episodes of the batch whose current version differs from the ledger's basis (a person's edit or a newer model version). */
  changedEpisodes: number[];
  /** Episodes whose current workbench script is STALE (its story was replaced): the batch waits for them to be saved again. */
  sourceStaleEpisodes: number[];
  /** The ledger before the batch as it stands now: the plan's initial ledger (batch 1), else the previous batch's valid one (null when not valid). */
  baseLedgerHash: string | null;
  /** What a person's review of this batch covers now (null until every episode and a ledger exist on a valid previous ledger). */
  decisionBasis: Record<string, string> | null;
  jobState: SeriesJobRecord["state"] | null;
  /** Episodes of the batch's completed job written to the workbench, and those left because a script was already there. */
  placed: number;
  conflicts: number;
}

/** The latest completed job of batch b (its model stages and batch review all ran), else null. */
function completedBatchJob(snapshot: SeriesSnapshot, batchNo: number): JobBundle | null {
  return jobsInOrder(snapshot).filter((job) => job.run.kind === "batch" && job.run.batchNo === batchNo && job.run.state === "completed").at(-1) ?? null;
}

function latestReview(snapshot: SeriesSnapshot, batchNo: number): { output: SeriesReviewOutput; runId: string } | null {
  let found: { output: SeriesReviewOutput; runId: string } | null = null;
  for (const job of jobsInOrder(snapshot)) {
    const stage = job.stages.find((item) => item.stageKey === `batch_review:${String(batchNo)}` && item.state === "completed" && item.output !== null);
    if (stage) found = { output: stage.output as unknown as SeriesReviewOutput, runId: job.run.id };
  }
  return found;
}

/** Every batch's state in order: the ledger chain is valid only while each link still matches the versions under it. */
export function seriesBatchStates(snapshot: SeriesSnapshot): SeriesBatchState[] {
  const n = snapshot.series.input.episodeCount;
  const plan = seriesCurrentPlan(snapshot);
  const models = seriesModelVersions(snapshot);
  const states: SeriesBatchState[] = [];
  const initialLedgerHash = plan ? canonicalInputHash(seriesInitialLedger(plan.content)) : null;
  const storyChanged = seriesStoryBinding(snapshot).status === "changed";
  let previousValid: SeriesLedgerRevisionRecord | null = null;
  let chainOk = true;
  for (let batchNo = 1; batchNo <= seriesBatchCount(n); batchNo += 1) {
    const { first, last } = seriesBatchRange(n, batchNo);
    const versions = Array.from({ length: last - first + 1 }, (_, index) => seriesCurrentVersion(snapshot, first + index, models));
    const revision = [...snapshot.ledgers].filter((item) => item.batchNo === batchNo).sort((a, b) => b.revisionNo - a.revisionNo)[0] ?? null;
    const changed = revision ? versions.map((version, index) => sameVersion(version?.ref, revision.basis.episodes[index]) ? null : first + index).filter((item): item is number => item !== null) : [];
    const sourceStale = versions.flatMap((version, index) => version?.sourceStale ? [first + index] : []);
    // The ledger before this batch as it stands now: the plan's initial one, or the previous batch's while that one is valid.
    const baseLedgerHash = batchNo === 1 ? initialLedgerHash : chainOk && previousValid !== null ? previousValid.contentHash : null;
    let ledgerStatus: SeriesLedgerStatus = "none";
    if (revision && plan) {
      // A new plan revision (a person's edit, or plan and story bound again) makes every ledger built on another one stale.
      const planSame = revision.basis.planRevisionId === plan.id && revision.basis.planHash === plan.contentHash;
      const baseSame = batchNo === 1 ? revision.basis.baseLedgerHash === null : baseLedgerHash !== null && revision.basis.baseLedgerHash === baseLedgerHash;
      if (!planSame || !baseSame || sourceStale.length > 0) ledgerStatus = "stale";
      else if (changed.length > 0) ledgerStatus = "pending_confirmation";
      else ledgerStatus = revision.origin === "manual" ? "confirmed" : "valid";
    }
    const ok = ledgerStatus === "valid" || ledgerStatus === "confirmed";
    chainOk = chainOk && ok;
    previousValid = ok ? revision : null;
    const review = latestReview(snapshot, batchNo);
    // What the batch review read, as it stands now: plan, story, the ledger before the batch, every episode version.
    const read: Record<string, string> | null = plan && baseLedgerHash !== null && versions.every((item) => item !== null)
      ? { plan: plan.contentHash, story: seriesPlanStoryHash(plan), baseLedger: baseLedgerHash } : null;
    if (read) versions.forEach((version, index) => { read[`episode:${String(first + index)}`] = version!.ref.hash; });
    // A person's review covers the same, and the ledger after the batch as well.
    const reviewBasis = read && revision ? { ...read, ledger: revision.contentHash } : null;
    // No new review while the work's story is not the plan's: plan and story are bound again first.
    const decisionBasis = storyChanged ? null : reviewBasis;
    let reviewStatus: SeriesReviewStatus = "none";
    if (reviewBasis && seriesDecisionFor(snapshot, `batch:${String(batchNo)}`, reviewBasis)) reviewStatus = "cleared";
    else if (review) {
      // Every dependency the review read must still be the current one, the starting ledger included.
      const stale = read === null || Object.entries(read).some(([key, hash]) => review.output.reviewed[key] !== hash);
      reviewStatus = stale ? "stale" : review.output.passed ? "passed" : "needs_revision";
    }
    const jobs = snapshot.jobs.filter((item) => item.run.kind === "batch" && item.run.batchNo === batchNo);
    const lastJob = jobs.sort((a, b) => a.run.seq - b.run.seq).at(-1) ?? null;
    const completed = completedBatchJob(snapshot, batchNo);
    const episodeStages = (completed?.stages ?? []).filter((stage) => seriesStageEpisodeNo(stage.stageKey) !== null);
    states.push({
      batchNo, first, last, size: last - first + 1, written: versions.filter((item) => item !== null).length, generated: completed !== null, versions,
      ledger: { status: ledgerStatus, revision }, review: { status: reviewStatus, output: review?.output ?? null, runId: review?.runId ?? null },
      changedEpisodes: ledgerStatus === "pending_confirmation" ? changed : [],
      sourceStaleEpisodes: sourceStale, baseLedgerHash, decisionBasis,
      jobState: lastJob?.run.state ?? null,
      placed: episodeStages.filter((stage) => stage.scriptSave === "saved").length,
      conflicts: episodeStages.filter((stage) => stage.scriptSave === "conflict").length,
    });
  }
  return states;
}

function batchCleared(state: SeriesBatchState): boolean {
  return state.generated && state.written === state.size && (state.ledger.status === "valid" || state.ledger.status === "confirmed")
    && (state.review.status === "passed" || state.review.status === "cleared");
}

/**
 * The first batch whose job has not completed, else null. Current versions alone do not finish a batch: a person's
 * script of an episode whose model stage never ran leaves that stage and the batch review to a grant of the same batch
 * (which takes over the completed stages and never overwrites the script).
 */
export function seriesNextBatch(states: readonly SeriesBatchState[]): number | null {
  return states.find((item) => !item.generated)?.batchNo ?? null;
}

/** Why batch b cannot be written now (empty: it can). */
export function seriesBatchBlockers(snapshot: SeriesSnapshot, batchNo: number, states = seriesBatchStates(snapshot)): string[] {
  const blockers: string[] = [];
  const planStatus = seriesPlanStatus(snapshot);
  if (planStatus === "none") return ["plan_missing"];
  if (planStatus === "needs_revision") blockers.push("plan_review_blocking");
  if (planStatus === "unreviewed") blockers.push("plan_unreviewed");
  if (seriesStoryBinding(snapshot).status === "changed") blockers.push("story_changed");
  for (const state of states.filter((item) => item.batchNo < batchNo)) {
    if (!state.generated || state.written < state.size) { blockers.push(`batch_incomplete:${String(state.batchNo)}`); continue; }
    if (state.sourceStaleEpisodes.length > 0) blockers.push(`episode_source_stale:${String(state.batchNo)}`);
    else if (state.ledger.status === "pending_confirmation") blockers.push(`ledger_pending_confirmation:${String(state.batchNo)}`);
    else if (state.ledger.status === "stale" || state.ledger.status === "none") blockers.push(`ledger_stale:${String(state.batchNo)}`);
    if (state.review.status === "needs_revision") blockers.push(`batch_review_blocking:${String(state.batchNo)}`);
    else if (state.review.status === "stale") blockers.push(`batch_review_stale:${String(state.batchNo)}`);
    else if (state.review.status === "none") blockers.push(`batch_review_missing:${String(state.batchNo)}`);
  }
  return blockers;
}

export type SeriesFinalStatus = "none" | "passed" | "needs_revision" | "stale" | "cleared";

/** The final review and the inputs it must still match. */
export function seriesFinalState(snapshot: SeriesSnapshot, states = seriesBatchStates(snapshot)): { status: SeriesFinalStatus; output: SeriesReviewOutput | null; basis: Record<string, string> | null } {
  const plan = seriesCurrentPlan(snapshot);
  let output: SeriesReviewOutput | null = null;
  for (const job of jobsInOrder(snapshot)) {
    const stage = job.stages.find((item) => item.stageKey === "final_review" && item.state === "completed" && item.output !== null);
    if (stage) output = stage.output as unknown as SeriesReviewOutput;
  }
  const basis = seriesFinalBasis(snapshot, states);
  // The work's story is no longer the plan's: no earlier pass or review stands for the current work (the output is kept).
  if (seriesStoryBinding(snapshot).status === "changed") return { status: output ? "stale" : "none", output, basis };
  // A person's review revalidates or overrides a final review that ran; it never stands in for the first one.
  if (!output) return { status: "none", output, basis };
  if (basis && seriesDecisionFor(snapshot, "final", basis)) return { status: "cleared", output, basis };
  // Every dependency the final review read must still be the current one (its summaries' versions, ledger, plan, story).
  const stale = !basis || !plan || Object.entries(basis).some(([key, hash]) => output!.reviewed[key] !== hash);
  return { status: stale ? "stale" : output.passed ? "passed" : "needs_revision", output, basis };
}

/** What the final review reads, by hash: the plan, its story, the last ledger and every episode's summary with its version (null until all exist). */
export function seriesFinalBasis(snapshot: SeriesSnapshot, states = seriesBatchStates(snapshot)): Record<string, string> | null {
  const plan = seriesCurrentPlan(snapshot);
  const last = states.at(-1);
  if (!plan || !last?.ledger.revision || states.some((item) => item.written < item.size)) return null;
  const basis: Record<string, string> = { plan: plan.contentHash, story: seriesPlanStoryHash(plan), ledger: last.ledger.revision.contentHash };
  // Each summary the review reads, with the version it belongs to: a summary changed on the same version is a new basis.
  for (const state of states) {
    state.versions.forEach((version, index) => {
      basis[`summary:${String(state.first + index)}`] = seriesSummaryBasisHash(version!.ref, seriesSummaryOf(snapshot, version!) ?? "");
    });
  }
  return basis;
}

/**
 * What a person's final review covers now: the final basis, offered only once a model final review completed (a person
 * reviews its result again; it never replaces the first final review) and while the work's story is the plan's. The
 * basis itself (seriesFinalBasis) stays available to the first final review job.
 */
export function seriesFinalDecisionBasis(snapshot: SeriesSnapshot, states = seriesBatchStates(snapshot)): Record<string, string> | null {
  if (seriesStoryBinding(snapshot).status === "changed") return null;
  return seriesFinalState(snapshot, states).output ? seriesFinalBasis(snapshot, states) : null;
}

export function seriesFinalBlockers(snapshot: SeriesSnapshot, states = seriesBatchStates(snapshot)): string[] {
  const n = snapshot.series.input.episodeCount;
  const blockers = seriesBatchBlockers(snapshot, seriesBatchCount(n) + 1, states);
  return blockers;
}

/**
 * What placing batch b may write now: each episode stage of the batch's completed job not handled yet (a person's script
 * of that episode does not make the stage disappear: the store records it as a conflict), formatted with the plan
 * revision the job was frozen on (never a newer setting). Only while the batch's dependencies are current: its ledger
 * valid or confirmed on the current plan, its review read on the current versions, no source stale, the story the plan's.
 */
export function seriesPlacementCandidates(snapshot: SeriesSnapshot, batchNo: number, states = seriesBatchStates(snapshot)): SeriesPlacementCandidates {
  const state = states[batchNo - 1];
  const job = completedBatchJob(snapshot, batchNo);
  if (!state || !job || state.written < state.size) return { kind: "blocked", reason: "batch_incomplete" };
  if (seriesStoryBinding(snapshot).status === "changed") return { kind: "blocked", reason: "story_changed" };
  if (state.sourceStaleEpisodes.length > 0) return { kind: "blocked", reason: "episode_source_stale" };
  if (state.ledger.status === "pending_confirmation") return { kind: "blocked", reason: "ledger_pending_confirmation" };
  if (state.ledger.status !== "valid" && state.ledger.status !== "confirmed") return { kind: "blocked", reason: "ledger_stale" };
  if (state.review.status === "none") return { kind: "blocked", reason: "batch_review_missing" };
  if (state.review.status === "stale") return { kind: "blocked", reason: "batch_review_stale" };
  const plan = snapshot.plans.find((item) => item.id === job.run.input.planRevisionId);
  if (!plan) return { kind: "blocked", reason: "plan_missing" };
  const scripts = [...job.stages].sort((a, b) => a.ordinal - b.ordinal).flatMap((stage) => {
    const episodeNo = seriesStageEpisodeNo(stage.stageKey);
    return episodeNo !== null && stage.state === "completed" && stage.output !== null && stage.scriptSave === "pending"
      ? [{ episodeNo, runId: job.run.id, stageKey: stage.stageKey, text: formatSeriesEpisode(stage.output as unknown as SeriesEpisode, plan.content.setting) }] : [];
  });
  return { kind: "ok", scripts };
}

/** The placement state the page shows: ready (something to write), nothing_to_place, or why it cannot be placed now. */
export function seriesPlacementState(snapshot: SeriesSnapshot, batchNo: number, states = seriesBatchStates(snapshot)): string {
  const candidates = seriesPlacementCandidates(snapshot, batchNo, states);
  if (candidates.kind === "blocked") return candidates.reason;
  return candidates.scripts.length > 0 ? "ready" : "nothing_to_place";
}

/**
 * What a person's review of a target covers now, read from the snapshot (null when there is nothing to review yet). The
 * page shows it and sends it back; the server records the review only when it is still exactly this.
 */
export function seriesDecisionBasis(snapshot: SeriesSnapshot, target: string): Record<string, string> | null {
  if (target === "plan") return seriesPlanDecisionBasis(snapshot);
  if (target === "final") return seriesFinalDecisionBasis(snapshot);
  const batchNo = /^batch:(\d+)$/.exec(target)?.[1];
  return batchNo ? seriesBatchStates(snapshot)[Number(batchNo) - 1]?.decisionBasis ?? null : null;
}

/** The summary each episode version carries: its own field, or the one a person confirmed with the ledger. */
export function seriesSummaryOf(snapshot: SeriesSnapshot, version: SeriesCurrentVersion): string | null {
  if (version.episode) return version.episode.summary;
  const batchNo = seriesBatchOf(version.ref.episodeNo);
  const ledger = [...snapshot.ledgers].filter((item) => item.batchNo === batchNo).sort((a, b) => b.revisionNo - a.revisionNo)
    .find((item) => item.summaries.some((entry) => entry.episodeNo === version.ref.episodeNo && entry.versionHash === version.ref.hash));
  return ledger?.summaries.find((entry) => entry.episodeNo === version.ref.episodeNo)?.summary ?? null;
}

export function seriesCompletion(snapshot: SeriesSnapshot, states = seriesBatchStates(snapshot)): SeriesCompletion {
  const planStatus = seriesPlanStatus(snapshot);
  if (planStatus === "none") return "not_started";
  const written = states.reduce((total, item) => total + item.written, 0);
  if (written === 0) return "planned";
  const final = seriesFinalState(snapshot, states);
  // Never complete while the work's story is not the plan's: every check was made on the plan's story.
  const textComplete = seriesStoryBinding(snapshot).status !== "changed" && (planStatus === "passed" || planStatus === "cleared") && states.every(batchCleared)
    && (final.status === "passed" || final.status === "cleared");
  if (!textComplete) return "partial";
  const approved = snapshot.project.approvedStoryCurrent && snapshot.project.approvedStoryRevisionId !== null
    && states.every((state) => state.versions.every((version) => {
      const script = version?.placedScript;
      const formal = snapshot.episodes.find((item) => item.episodeNo === version?.ref.episodeNo);
      return script !== null && script !== undefined && script.reviewStatus === "APPROVED" && script.freshnessStatus === "CURRENT"
        && formal?.approvedScriptRevisionId === script.id;
    }));
  return approved ? "approved_complete" : "text_complete";
}

// ---------------------------------------------------------------------------------------------------------------
// Jobs: admission, building and context.

function latestStoppedJob(snapshot: SeriesSnapshot, kind: SeriesJobKind, batchNo: number | null): JobBundle | null {
  return jobsInOrder(snapshot).filter((job) => job.run.kind === kind && job.run.batchNo === batchNo && job.run.state !== "completed" && job.run.state !== "running").at(-1) ?? null;
}

/** The completed stages at the head of an earlier, stopped job that a new job may take over without sending. */
function reusablePrefix(job: JobBundle | null, stageKeys: readonly string[]): Map<string, SeriesStageRecord> {
  const result = new Map<string, SeriesStageRecord>();
  if (!job) return result;
  for (const key of stageKeys) {
    const stage = job.stages.find((item) => item.stageKey === key);
    if (!stage || stage.state !== "completed" || stage.output === null || seriesStageKind(key).endsWith("review")) break;
    result.set(key, stage);
  }
  return result;
}

function ledgerContent(snapshot: SeriesSnapshot, plan: SeriesPlanRevisionRecord, revisionId: string | null): SeriesLedger {
  if (revisionId === null) return seriesInitialLedger(plan.content);
  return snapshot.ledgers.find((item) => item.id === revisionId)!.content;
}

/** Builds a job of a grant from the current state (its stages, what it reuses, and what it is frozen on). */
export function buildSeriesJob(snapshot: SeriesSnapshot, grant: SeriesGrantRecord, kind: SeriesJobKind, batchNo: number | null, ids: { jobId: string; nowIso: string }): SeriesJobPlan {
  const n = snapshot.series.input.episodeCount;
  const stageKeys = seriesJobStageKeys(n, kind, batchNo);
  const plan = seriesCurrentPlan(snapshot);
  const states = seriesBatchStates(snapshot);
  let base: SeriesLedgerRevisionRecord | null = null;
  let previous: SeriesVersionRef | null = null;
  let firstEpisode: number | null = null;
  let lastEpisode: number | null = null;
  let reusable = new Map<string, SeriesStageRecord>();
  if (kind === "batch") {
    const range = seriesBatchRange(n, batchNo!);
    firstEpisode = range.first;
    lastEpisode = range.last;
    base = batchNo! > 1 ? states[batchNo! - 2]!.ledger.revision : null;
    previous = range.first > 1 ? seriesCurrentVersion(snapshot, range.first - 1)?.ref ?? null : null;
    const stopped = latestStoppedJob(snapshot, "batch", batchNo);
    if (stopped && plan && stopped.run.input.planHash === plan.contentHash && stopped.run.input.baseLedgerHash === (base?.contentHash ?? null)
      && stopped.run.input.storyHash === plan.storyHash && sameVersion(stopped.run.input.previousEpisode, previous)) reusable = reusablePrefix(stopped, stageKeys);
  } else if (kind === "plan") {
    reusable = reusablePrefix(latestStoppedJob(snapshot, "plan", null), stageKeys);
  } else {
    base = states.at(-1)!.ledger.revision;
  }
  const stopped = kind === "plan" ? latestStoppedJob(snapshot, "plan", null) : latestStoppedJob(snapshot, kind, batchNo);
  const input: SeriesJobInput = {
    schema: SERIES_WRITING_JOB_SCHEMA,
    kind, batchNo, firstEpisode, lastEpisode,
    providerKey: grant.input.providerKey, model: grant.input.model,
    ...(grant.input.providerAdapter ? { providerAdapter: grant.input.providerAdapter } : {}),
    maxOutputTokens: grant.input.maxOutputTokens,
    promptVersion: SERIES_WRITING_PROMPT_VERSION, checksVersion: SERIES_WRITING_CHECKS_VERSION,
    planRevisionId: kind === "plan" ? null : plan!.id,
    planHash: kind === "plan" ? null : plan!.contentHash,
    baseLedgerRevisionId: base?.id ?? null,
    baseLedgerHash: base?.contentHash ?? null,
    previousEpisode: previous,
    storyRevisionId: kind === "plan" ? null : plan!.storyRevisionId,
    storyHash: kind === "plan" ? null : plan!.storyHash,
    reused: [...reusable.entries()].map(([stageKey, stage]) => ({ stageKey, fromRunId: stopped!.run.id, outputHash: stage.outputHash! })),
  };
  // What this job will send: every stage but the local sources snapshot and the ones it takes over (sources may be one of them).
  const sends = stageKeys.filter((key) => key !== "sources" && !reusable.has(key)).length;
  const remaining = grant.callBudget - grant.callsUsed;
  const run: SeriesJobRecord = {
    id: ids.jobId, seq: snapshot.jobs.reduce((last, job) => Math.max(last, job.run.seq), 0) + 1, seriesId: snapshot.series.id, grantId: grant.id, workspaceId: snapshot.series.workspaceId, projectId: snapshot.series.projectId,
    kind, batchNo, input, inputHash: canonicalInputHash(input), state: "running", errorCode: null, cancelRequestedAt: null, executorId: null, leaseUntil: null,
    callCap: Math.max(1, Math.min(SERIES_JOB_MAX_CALLS, sends + grant.input.resendAllowance, remaining)),
    callsUsed: 0, createdAt: ids.nowIso, updatedAt: ids.nowIso,
  };
  return {
    run,
    stages: stageKeys.map((stageKey) => {
      const stage = reusable.get(stageKey);
      return { stageKey, reused: stage ? { output: stage.output!, outputHash: stage.outputHash!, dependsOn: stage.dependsOn ?? {}, fromRunId: stopped!.run.id } : null };
    }),
  };
}

/** Calls a job would send with nothing reused: its normal calls. */
export function seriesJobNormalSends(job: SeriesJobPlan): number {
  return job.stages.filter((stage) => stage.stageKey !== "sources").length;
}

/** Calls a job will send when every stage succeeds (its stages minus the local snapshot and the reused ones). */
export function seriesJobSends(job: SeriesJobPlan): number {
  return job.stages.filter((stage) => stage.reused === null && stage.stageKey !== "sources").length;
}

function refusal(code: string, details?: Record<string, unknown>): SeriesAdmission {
  return { kind: "refused", code, ...(details ? { details } : {}) };
}

/** Whether a grant may start now, and its first job. The normal calls must be the formula's for the scope. */
export function admitSeriesGrant(snapshot: SeriesSnapshot, grant: SeriesGrantRecord, ids: { jobId: string; nowIso: string }): SeriesAdmission {
  const n = snapshot.series.input.episodeCount;
  const scope = grant.input.scope;
  if (!seriesScopeShapeValid(n, scope)) return refusal("SERIES_SCOPE_INVALID");
  const normal = seriesScopeJobs(n, scope).reduce((total, job) => total + job.calls, 0);
  if (grant.input.normalCalls !== normal) return refusal("SERIES_CARD_STALE", { normalCalls: normal });
  if (grant.input.callBudget !== normal + grant.input.resendAllowance) return refusal("SERIES_BUDGET_MISMATCH", { callBudget: normal + grant.input.resendAllowance });
  if (snapshot.grants.some((item) => item.state === "running")) return refusal("SERIES_GRANT_ACTIVE");
  const plan = seriesCurrentPlan(snapshot);
  if ((plan?.id ?? null) !== grant.input.basePlanRevisionId) return refusal("SERIES_CARD_STALE", { planRevisionId: plan?.id ?? null });
  const states = seriesBatchStates(snapshot);
  if (scope.plan) {
    if (plan) return refusal("SERIES_PLAN_EXISTS");
    if (scope.batchFrom !== null && scope.batchFrom !== 1) return refusal("SERIES_SCOPE_NOT_NEXT", { nextBatch: 1 });
    if (scope.final && scope.batchFrom === null) return refusal("SERIES_SCOPE_INVALID");
    return { kind: "job", job: buildSeriesJob(snapshot, grant, "plan", null, ids), requiredCalls: 0 };
  }
  if (scope.batchFrom !== null) {
    const next = seriesNextBatch(states);
    if (next === null || scope.batchFrom !== next) return refusal("SERIES_SCOPE_NOT_NEXT", { nextBatch: next });
    const blockers = seriesBatchBlockers(snapshot, scope.batchFrom, states);
    if (blockers.length > 0) return refusal("SERIES_BLOCKED", { blockers });
    return { kind: "job", job: buildSeriesJob(snapshot, grant, "batch", scope.batchFrom, ids), requiredCalls: 0 };
  }
  const blockers = seriesFinalBlockers(snapshot, states);
  if (blockers.length > 0) return refusal("SERIES_BLOCKED", { blockers });
  return { kind: "job", job: buildSeriesJob(snapshot, grant, "final", null, ids), requiredCalls: 0 };
}

/**
 * After a job completed: the grant's next job when its scope has one and the series may go on, else the grant's end.
 * A blocking machine finding, a stale ledger or a person's pending confirmation stops the grant (never a silent continue).
 */
export function nextSeriesJob(snapshot: SeriesSnapshot, grant: SeriesGrantRecord, ids: { jobId: string; nowIso: string }): SeriesAdmission | { kind: "done" } {
  const n = snapshot.series.input.episodeCount;
  const scope = grant.input.scope;
  const done = snapshot.jobs.filter((job) => job.run.grantId === grant.id && job.run.state === "completed");
  const planned = seriesScopeJobs(n, scope);
  const remaining = planned.filter((item) => !done.some((job) => job.run.kind === item.kind && job.run.batchNo === item.batchNo));
  const next = remaining[0];
  if (!next) return { kind: "done" };
  if (grant.cancelRequestedAt !== null) return refusal("canceled");
  const states = seriesBatchStates(snapshot);
  const blockers = next.kind === "batch" ? seriesBatchBlockers(snapshot, next.batchNo!, states) : seriesFinalBlockers(snapshot, states);
  if (blockers.length > 0) return refusal(blockers[0]!.split(":")[0]!, { blockers });
  return { kind: "job", job: buildSeriesJob(snapshot, grant, next.kind, next.batchNo, ids), requiredCalls: 0 };
}

/**
 * Sends a grant still needs to finish its scope with every remaining stage succeeding once: the open stages of its
 * current job (a redo included) and the normal calls of the jobs not created yet. A resume or a hand-over goes on only
 * when the calls used plus these fit the grant's budget, so a grant never starts work it cannot finish.
 */
export function seriesGrantRemainingSends(snapshot: SeriesSnapshot, grant: SeriesGrantRecord): number {
  const n = snapshot.series.input.episodeCount;
  const jobs = snapshot.jobs.filter((job) => job.run.grantId === grant.id);
  let total = 0;
  for (const planned of seriesScopeJobs(n, grant.input.scope)) {
    const existing = jobs.filter((job) => job.run.kind === planned.kind && job.run.batchNo === planned.batchNo)
      .sort((a, b) => a.run.seq - b.run.seq).at(-1);
    if (!existing) { total += planned.calls; continue; }
    if (existing.run.state === "completed") continue;
    total += existing.stages.filter((stage) => stage.state !== "completed" && stage.stageKey !== "sources").length;
  }
  return total;
}

/** Why a running job may no longer send: what it was frozen on is not the current state any more. */
export function seriesJobUpstreamChange(snapshot: SeriesSnapshot, run: SeriesJobRecord): string | null {
  if (run.kind === "plan") {
    // A plan saved since (by a later job or a person) or a later planning job supersedes this one: it never plans again,
    // so it never sends a duplicate plan nor saves one that would unbind the current plan from its story.
    const superseded = snapshot.plans.length > 0 || snapshot.jobs.some((job) => job.run.kind === "plan" && job.run.seq > run.seq);
    return superseded ? "upstream_plan_superseded" : null;
  }
  const plan = seriesCurrentPlan(snapshot);
  if (!plan || plan.id !== run.input.planRevisionId || plan.contentHash !== run.input.planHash) return "upstream_plan_changed";
  // The story the job was frozen on must still be the work's current story (never write on a replaced one).
  if (run.input.storyRevisionId !== plan.storyRevisionId || run.input.storyHash !== plan.storyHash || seriesStoryBinding(snapshot).status !== "ok") {
    return "upstream_story_changed";
  }
  const states = seriesBatchStates(snapshot);
  if (run.kind === "batch") {
    const batchNo = run.batchNo!;
    if (batchNo > 1) {
      const base = states[batchNo - 2]!;
      if (!(base.ledger.status === "valid" || base.ledger.status === "confirmed") || base.ledger.revision?.id !== run.input.baseLedgerRevisionId) return "upstream_ledger_changed";
    }
    const previousVersion = run.input.firstEpisode! > 1 ? seriesCurrentVersion(snapshot, run.input.firstEpisode! - 1) : null;
    if (!sameVersion(previousVersion?.ref ?? null, run.input.previousEpisode) || previousVersion?.sourceStale === true) return "upstream_episode_changed";
    return null;
  }
  const last = states.at(-1)!;
  if (last.ledger.revision?.id !== run.input.baseLedgerRevisionId || seriesFinalBlockers(snapshot, states).length > 0) return "upstream_ledger_changed";
  return null;
}

/** The context a job's prompts and checks read: its own completed stages and exactly the revisions it was frozen on. */
export function seriesJobContext(snapshot: SeriesSnapshot, job: JobBundle): SeriesContext {
  const input = snapshot.series.input;
  if (job.run.kind === "plan") return seriesPlanContext(input, job.stages);
  const plan = snapshot.plans.find((item) => item.id === job.run.input.planRevisionId)!;
  const context = seriesContextFromPlan(input, plan.content, plan.contentHash);
  context.storyHash = job.run.input.storyHash ?? SERIES_NO_STORY;
  for (const stage of [...job.stages].sort((a, b) => a.ordinal - b.ordinal)) {
    if (stage.state === "completed" && stage.output !== null) context.stageHashes.set(stage.stageKey, stage.outputHash!);
  }
  if (job.run.kind === "batch") {
    context.baseLedger = ledgerContent(snapshot, plan, job.run.input.baseLedgerRevisionId);
    context.baseLedgerHash = job.run.input.baseLedgerHash;
    const previous = job.run.input.previousEpisode;
    if (previous === null) context.previous = null;
    else if (previous.kind === "script") context.previous = { kind: "script", hash: previous.hash };
    else {
      const owner = snapshot.jobs.find((item) => item.run.id === previous.runId);
      const stage = owner?.stages.find((item) => item.stageKey === previous.stageKey);
      context.previous = stage?.output ? { kind: "stage", episode: stage.output as unknown as SeriesEpisode, hash: previous.hash } : null;
    }
    for (const stage of job.stages) {
      const episodeNo = seriesStageEpisodeNo(stage.stageKey);
      if (episodeNo !== null && stage.state === "completed" && stage.output !== null) {
        context.episodes.set(episodeNo, { stageKey: stage.stageKey, episode: stage.output as unknown as SeriesEpisode, hash: stage.outputHash! });
      }
    }
    return context;
  }
  const states = seriesBatchStates(snapshot);
  const last = states.at(-1)!.ledger.revision!;
  context.final = {
    ledger: last.content,
    ledgerHash: last.contentHash,
    summaries: states.flatMap((state) => state.versions.map((version) => {
      const summary = seriesSummaryOf(snapshot, version!) ?? "";
      return { episodeNo: version!.ref.episodeNo, summary, versionHash: version!.ref.hash, basisHash: seriesSummaryBasisHash(version!.ref, summary) };
    })),
    batches: states.map((state) => ({
      batchNo: state.batchNo, status: state.review.status,
      reviewHash: state.review.output ? canonicalInputHash(state.review.output) : null,
      blocking: state.review.output ? state.review.output.deterministic.filter((item) => item.severity === "high").length
        + state.review.output.issues.filter((item) => item.evidenceVerified && item.severity === "high").length : 0,
      issues: (state.review.output?.issues ?? []).filter((item) => item.evidenceVerified).slice(0, 3).map((item) => `${item.id}@${item.target}`),
    })),
  };
  return context;
}

/** A batch's program ledger: the base ledger with its episodes' continuity applied, bound to those versions. */
export function seriesBatchLedger(snapshot: SeriesSnapshot, job: JobBundle, ids: { ledgerId: string; nowIso: string }): SeriesLedgerRevisionRecord {
  const context = seriesJobContext(snapshot, job);
  const { first, last } = seriesBatchRange(snapshot.series.input.episodeCount, job.run.batchNo!);
  let ledger = context.baseLedger!;
  const episodes: SeriesVersionRef[] = [];
  const summaries: SeriesLedgerRevisionRecord["summaries"] = [];
  for (let number = first; number <= last; number += 1) {
    const value = context.episodes.get(number)!;
    ledger = applySeriesContinuity(ledger, number, value.episode.continuity);
    episodes.push({ episodeNo: number, kind: "stage", runId: job.run.id, stageKey: value.stageKey, hash: value.hash });
    summaries.push({ episodeNo: number, summary: value.episode.summary, versionHash: value.hash });
  }
  const revisionNo = snapshot.ledgers.filter((item) => item.batchNo === job.run.batchNo).length + 1;
  return {
    id: ids.ledgerId, seriesId: snapshot.series.id, batchNo: job.run.batchNo!, revisionNo, origin: "program", content: ledger,
    contentHash: canonicalInputHash(ledger), summaries,
    basis: { planRevisionId: job.run.input.planRevisionId!, planHash: job.run.input.planHash!, baseLedgerRevisionId: job.run.input.baseLedgerRevisionId,
      baseLedgerHash: job.run.input.baseLedgerHash, storyRevisionId: job.run.input.storyRevisionId, storyHash: job.run.input.storyHash, episodes },
    createdBy: `series-writing:${job.run.id}`, createdAt: ids.nowIso,
  };
}

/** The basis a person's ledger confirmation of batch b is bound to: the current plan, the previous valid ledger, the current versions. */
export function seriesLedgerBasisNow(snapshot: SeriesSnapshot, batchNo: number, computed?: SeriesBatchState[]): { basis: SeriesLedgerRevisionRecord["basis"]; versions: SeriesCurrentVersion[] } | { blocked: string } {
  const plan = seriesCurrentPlan(snapshot);
  if (!plan) return { blocked: "plan_missing" };
  // A ledger is confirmed against the work's current story only, and never on a version whose source went stale.
  if (seriesStoryBinding(snapshot).status === "changed") return { blocked: "story_changed" };
  const states = computed ?? seriesBatchStates(snapshot);
  const state = states[batchNo - 1];
  if (!state || state.written < state.size) return { blocked: "batch_incomplete" };
  if (state.sourceStaleEpisodes.length > 0) return { blocked: "episode_source_stale" };
  const base = batchNo > 1 ? states[batchNo - 2]! : null;
  if (base && !(base.ledger.status === "valid" || base.ledger.status === "confirmed")) return { blocked: "previous_ledger_not_valid" };
  const versions = state.versions as SeriesCurrentVersion[];
  return {
    basis: { planRevisionId: plan.id, planHash: plan.contentHash, baseLedgerRevisionId: base?.ledger.revision?.id ?? null,
      baseLedgerHash: base?.ledger.revision?.contentHash ?? null, storyRevisionId: plan.storyRevisionId, storyHash: plan.storyHash,
      episodes: versions.map((item) => item.ref) },
    versions,
  };
}

/**
 * Everything a person's ledger confirmation of batch b is bound to, as a page opens the editor: the plan revision and its
 * hash, the plan's story and the work's current story, the ledger before the batch (revision and hash; the plan's
 * initial ledger for batch 1), the ledger revision being replaced, and each episode's version identity and hash. The
 * page sends it back unchanged; the store saves only while it is still exactly this (never binding the person's
 * summaries to a version they did not see). Null when the ledger cannot be confirmed now.
 */
export function seriesLedgerEditBasis(snapshot: SeriesSnapshot, batchNo: number, computed?: SeriesBatchState[]): Record<string, string> | null {
  const states = computed ?? seriesBatchStates(snapshot);
  const now = seriesLedgerBasisNow(snapshot, batchNo, states);
  if ("blocked" in now) return null;
  const plan = seriesCurrentPlan(snapshot)!;
  const target = states[batchNo - 1]!.ledger.revision;
  const basis: Record<string, string> = {
    planRevision: plan.id, plan: plan.contentHash,
    storyRevision: plan.storyRevisionId ?? SERIES_NO_STORY, story: seriesPlanStoryHash(plan), currentStory: snapshot.project.currentStory?.id ?? SERIES_NO_STORY,
    baseLedgerRevision: now.basis.baseLedgerRevisionId ?? "initial",
    baseLedger: now.basis.baseLedgerHash ?? canonicalInputHash(seriesInitialLedger(plan.content)),
    ledgerRevision: target?.id ?? SERIES_NO_STORY,
  };
  for (const version of now.versions) {
    const ref = version.ref;
    basis[`episode:${String(ref.episodeNo)}`] = ref.hash;
    basis[`episodeRef:${String(ref.episodeNo)}`] = ref.kind === "script" ? `script:${ref.scriptRevisionId}` : `stage:${ref.runId}:${ref.stageKey}`;
  }
  return basis;
}

// ---------------------------------------------------------------------------------------------------------------
// The view and the current delivery package.

const COMPLETION_LABELS: Readonly<Record<SeriesCompletion, string>> = {
  not_started: "尚未规划",
  planned: "已完成全剧规划，正文未开始",
  partial: "局部完成",
  text_complete: "全剧文本完成（所有集数、规定检查及依赖有效；尚未全部人工审定）",
  approved_complete: "审定完成（当前规定稿件人工审核全部通过，可冻结交付）",
};

export function seriesCompletionLabel(completion: SeriesCompletion, written: number, total: number): string {
  if (completion !== "partial") return COMPLETION_LABELS[completion];
  return written === total ? `局部完成：已完成 ${String(written)}/${String(total)} 集，但还有待同步、待确认或待复核的事项（见待办）`
    : `局部完成：已完成 ${String(written)}/${String(total)} 集，其余待写或待复核`;
}

/**
 * What keeps a written series from being complete now, in the order a person handles it: the story replaced in the
 * workbench, then each batch's stale sources, unconfirmed ledgers and reviews, then the final review.
 */
export function seriesAttention(snapshot: SeriesSnapshot, states = seriesBatchStates(snapshot)): string[] {
  const items: string[] = [];
  if (seriesStoryBinding(snapshot).status === "changed") items.push("story_changed");
  const plan = seriesPlanStatus(snapshot);
  if (plan === "needs_revision") items.push("plan_review_blocking");
  if (plan === "unreviewed") items.push("plan_unreviewed");
  for (const state of states) {
    if (state.written < state.size) continue;
    const batch = String(state.batchNo);
    if (state.sourceStaleEpisodes.length > 0) items.push(`episode_source_stale:${batch}`);
    else if (state.ledger.status === "pending_confirmation") items.push(`ledger_pending_confirmation:${batch}`);
    else if (state.ledger.status === "stale" || state.ledger.status === "none") items.push(`ledger_stale:${batch}`);
    if (state.review.status === "needs_revision") items.push(`batch_review_blocking:${batch}`);
    else if (state.review.status === "stale") items.push(`batch_review_stale:${batch}`);
    else if (state.review.status === "none") items.push(`batch_review_missing:${batch}`);
  }
  if (states.every((item) => item.written === item.size)) {
    const final = seriesFinalState(snapshot, states).status;
    if (final === "none") items.push("final_review_missing");
    else if (final === "stale") items.push("final_review_stale");
    else if (final === "needs_revision") items.push("final_review_blocking");
  }
  return items;
}

export interface SeriesGrantView {
  grantId: string;
  scope: SeriesScope;
  scopeLabel: string;
  state: SeriesGrantRecord["state"];
  stopReason: string | null;
  callBudget: number;
  normalCalls: number;
  resendAllowance: number;
  callsUsed: number;
  providerKey: string;
  model: string;
  createdAt: string;
  uncertainCallIds: string[];
  cancelRequested: boolean;
}

export function seriesScopeLabel(episodeCount: number, scope: SeriesScope): string {
  const parts: string[] = [];
  if (scope.plan) parts.push("全剧规划");
  if (scope.batchFrom !== null && scope.batchTo !== null) {
    parts.push(`第 ${String(seriesBatchRange(episodeCount, scope.batchFrom).first)}–${String(seriesBatchRange(episodeCount, scope.batchTo).last)} 集正文及逐批审阅`);
  }
  if (scope.final) parts.push("全剧结构与连续性总检");
  return parts.join(" + ");
}

function uncertainOf(snapshot: SeriesSnapshot, grantId: string): string[] {
  const jobs = snapshot.jobs.filter((job) => job.run.grantId === grantId);
  return jobs.flatMap((job) => currentUncertainCallIds(
    job.stages.map((stage) => ({ stepKey: stage.stageKey as TitleWritingStepKey, state: stage.state, attemptNo: stage.attemptNo })),
    job.calls.map((call) => ({ callId: call.id, stepKey: call.stageKey as TitleWritingStepKey, attemptNo: call.attemptNo, state: call.state })),
  )).sort();
}

export function seriesGrantViews(snapshot: SeriesSnapshot): SeriesGrantView[] {
  const n = snapshot.series.input.episodeCount;
  return [...snapshot.grants].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((grant) => ({
    grantId: grant.id, scope: grant.input.scope, scopeLabel: seriesScopeLabel(n, grant.input.scope), state: grant.state, stopReason: grant.stopReason,
    callBudget: grant.callBudget, normalCalls: grant.input.normalCalls, resendAllowance: grant.input.resendAllowance, callsUsed: grant.callsUsed,
    providerKey: grant.input.providerKey, model: grant.input.model, createdAt: grant.createdAt, uncertainCallIds: uncertainOf(snapshot, grant.id),
    cancelRequested: grant.cancelRequestedAt !== null,
  }));
}

export interface SeriesEpisodeView {
  episodeNo: number;
  batchNo: number;
  title: string;
  outlineLine: string | null;
  version: { kind: "stage" | "script"; hash: string; source: string } | null;
  summary: string | null;
  placed: "none" | "saved" | "conflict";
  formalReview: SeriesScriptRevision["reviewStatus"] | null;
  formalFreshness: SeriesScriptRevision["freshnessStatus"] | null;
  /** A newer model version that is not the workbench's current script (never presented as the current one). */
  unadoptedModelDraft: boolean;
  state: "pending" | "written" | "needs_revision" | "pending_confirmation" | "stale" | "source_stale";
}

/** A story revision as the page and the package show it (its text is in the package, not in the view). */
export interface SeriesStoryView {
  revisionId: string;
  contentHash: string;
  reviewStatus: SeriesStoryRevision["reviewStatus"];
  freshnessStatus: SeriesStoryRevision["freshnessStatus"];
  createdBy: string;
  createdAt: string;
}

function storyView(story: SeriesStoryRevision | null): SeriesStoryView | null {
  return story ? { revisionId: story.id, contentHash: story.contentHash, reviewStatus: story.reviewStatus, freshnessStatus: story.freshnessStatus,
    createdBy: story.createdBy, createdAt: story.createdAt } : null;
}

export interface SeriesView {
  seriesId: string;
  projectId: string;
  title: string;
  episodeCount: number;
  episodeSeconds: number;
  idea: string;
  constraints: SeriesSnapshot["series"]["input"]["constraints"];
  researchFetch: boolean;
  versions: { prompt: string; checks: string; research: typeof SERIES_RESEARCH_CONTRACT };
  completion: SeriesCompletion;
  completionLabel: string;
  written: number;
  plan: null | {
    status: SeriesPlanStatus;
    revisionId: string;
    revisionNo: number;
    origin: "model" | "manual";
    contentHash: string;
    storySave: SeriesPlanRevisionRecord["storySave"];
    storyRevisionId: string | null;
    storyHash: string | null;
    content: SeriesPlanContent;
    review: SeriesReviewOutput | null;
    /** What a person's review of the plan covers now (sent back with the review); null while plan and story wait to be bound again. */
    decisionBasis: Record<string, string> | null;
  };
  /** The work's story against the plan: changed means the workbench saved another story and the series waits for a person. */
  story: { status: SeriesStoryBinding["status"]; planStoryRevisionId: string | null; current: SeriesStoryView | null; approved: SeriesStoryView | null;
    approvedIsCurrent: boolean };
  episodes: SeriesEpisodeView[];
  /** ledgerBasis: what a ledger confirmation opened now is bound to (the page freezes it with the editor); null when it cannot be confirmed. */
  /** placement: "ready" (a model stage to write), "nothing_to_place" (every one written or recorded as a conflict), or why not now. */
  batches: Array<Omit<SeriesBatchState, "versions"> & { blockers: string[]; ledgerBasis: Record<string, string> | null; placement: string }>;
  ranges: { toWrite: string; toRevise: number[]; toConfirm: number[]; toReview: number[] };
  /** What keeps the series from being complete now (seriesAttention), in order. */
  attention: string[];
  /**
   * decisionBasis: what a person's final review covers now (null until a model final review has run, every episode and
   * the last ledger exist, and while plan and story wait to be bound again). previousPassed: an earlier final review passed, but it no longer
   * stands for the current dependencies (status stale).
   */
  final: { status: SeriesFinalStatus; output: SeriesReviewOutput | null; blockers: string[]; decisionBasis: Record<string, string> | null; previousPassed: boolean };
  next: { batchNo: number | null; blockers: string[] };
  budget: { normalCalls: number; planCalls: number; planAndFirstBatchCalls: number; callsUsed: number; billing: "unknown" };
  grants: SeriesGrantView[];
  activeGrantId: string | null;
  calls: Array<Pick<SeriesCallRecord, "id" | "grantId" | "runId" | "stageKey" | "attemptNo" | "providerKey" | "model" | "state" | "errorCode" | "usage" | "createdAt" | "finishedAt">>;
  human: { scriptReview: "not_started" | "partial" | "complete"; tableRead: "not_recorded"; liveTiming: "not_recorded"; media: "not_started" };
}

function rangesLabel(numbers: readonly number[]): string {
  if (numbers.length === 0) return "无";
  const parts: string[] = [];
  let start = numbers[0]!;
  let previous = start;
  for (const number of [...numbers.slice(1), Number.NaN]) {
    if (number === previous + 1) { previous = number; continue; }
    parts.push(start === previous ? `第 ${String(start)} 集` : `第 ${String(start)}–${String(previous)} 集`);
    start = number;
    previous = number;
  }
  return parts.join("、");
}

export function seriesView(snapshot: SeriesSnapshot): SeriesView {
  const input = snapshot.series.input;
  const n = input.episodeCount;
  const states = seriesBatchStates(snapshot);
  const plan = seriesCurrentPlan(snapshot);
  const planStatus = seriesPlanStatus(snapshot);
  const models = seriesModelVersions(snapshot);
  const written = states.reduce((total, item) => total + item.written, 0);
  const completion = seriesCompletion(snapshot, states);
  const final = seriesFinalState(snapshot, states);
  const nextBatch = seriesNextBatch(states);
  const episodes: SeriesEpisodeView[] = states.flatMap((state) => state.versions.map((version, index): SeriesEpisodeView => {
    const episodeNo = state.first + index;
    const outline = plan?.content.outlines.find((item) => item.episodeNo === episodeNo) ?? null;
    const model = models.get(episodeNo);
    const placedStage = snapshot.jobs.flatMap((job) => job.stages).filter((stage) => stage.stageKey === `episode:${String(episodeNo)}` && stage.scriptSave !== null && stage.scriptSave !== "pending");
    const formal = version?.placedScript ?? null;
    const changed = state.changedEpisodes.includes(episodeNo);
    const reviewBlocking = state.review.status === "needs_revision" && (state.review.output?.issues.some((item) => item.evidenceVerified && item.severity === "high" && item.target === `episode:${String(episodeNo)}`)
      || state.review.output?.deterministic.some((item) => item.severity === "high" && item.target === `episode:${String(episodeNo)}`));
    return {
      episodeNo, batchNo: state.batchNo,
      title: version?.episode?.title ?? outline?.title ?? `第 ${String(episodeNo)} 集`,
      outlineLine: outline ? seriesOutlineLine(outline) : null,
      version: version ? { kind: version.ref.kind, hash: version.ref.hash, source: version.ref.kind === "script" ? "工作台人工修改稿" : version.placedScript ? "模型稿（已写入工作台）" : "模型稿（未写入工作台）" } : null,
      summary: version ? seriesSummaryOf(snapshot, version) : null,
      placed: placedStage.some((stage) => stage.scriptSave === "saved") ? "saved" : placedStage.some((stage) => stage.scriptSave === "conflict") ? "conflict" : "none",
      formalReview: formal?.reviewStatus ?? null,
      formalFreshness: formal?.freshnessStatus ?? null,
      unadoptedModelDraft: Boolean(model && version && version.ref.kind === "script" ? true : model && version && version.ref.kind === "stage" && model.stage.outputHash !== version.ref.hash),
      state: !version ? "pending" : version.sourceStale ? "source_stale" : state.ledger.status === "stale" ? "stale" : changed ? "pending_confirmation"
        : reviewBlocking ? "needs_revision" : "written",
    };
  }));
  const allGrants = seriesGrantViews(snapshot);
  const scripts = episodes.map((item) => item.formalReview);
  const binding = seriesStoryBinding(snapshot);
  return {
    seriesId: snapshot.series.id, projectId: snapshot.series.projectId, title: snapshot.series.title, episodeCount: n, episodeSeconds: input.episodeSeconds,
    idea: input.idea, constraints: input.constraints, researchFetch: input.researchFetch,
    versions: { prompt: input.promptVersion, checks: input.checksVersion, research: input.researchContract },
    completion, completionLabel: seriesCompletionLabel(completion, written, n), written,
    plan: plan ? { status: planStatus, revisionId: plan.id, revisionNo: plan.revisionNo, origin: plan.origin, contentHash: plan.contentHash, storySave: plan.storySave,
      storyRevisionId: plan.storyRevisionId, storyHash: plan.storyHash, content: plan.content, review: plan.review, decisionBasis: seriesPlanDecisionBasis(snapshot) } : null,
    story: { status: binding.status, planStoryRevisionId: binding.planStoryRevisionId, current: storyView(binding.current), approved: storyView(binding.approved),
      approvedIsCurrent: snapshot.project.approvedStoryCurrent },
    episodes,
    batches: states.map(({ versions: _versions, ...rest }) => ({ ...rest, blockers: rest.written < rest.size ? seriesBatchBlockers(snapshot, rest.batchNo, states) : [],
      ledgerBasis: rest.written === rest.size ? seriesLedgerEditBasis(snapshot, rest.batchNo, states) : null,
      placement: seriesPlacementState(snapshot, rest.batchNo, states) })),
    ranges: {
      toWrite: rangesLabel(episodes.filter((item) => item.state === "pending").map((item) => item.episodeNo)),
      toRevise: states.filter((item) => item.review.status === "needs_revision").map((item) => item.batchNo),
      toConfirm: states.filter((item) => item.ledger.status === "pending_confirmation" || item.ledger.status === "stale").map((item) => item.batchNo),
      toReview: states.filter((item) => item.review.status === "stale").map((item) => item.batchNo),
    },
    attention: written > 0 ? seriesAttention(snapshot, states) : [],
    final: { status: final.status, output: final.output, blockers: states.every((item) => item.written === item.size) ? seriesFinalBlockers(snapshot, states) : ["episodes_incomplete"],
      decisionBasis: binding.status === "changed" || final.output === null ? null : final.basis, previousPassed: final.status === "stale" && final.output?.passed === true },
    next: { batchNo: nextBatch, blockers: nextBatch === null ? [] : seriesBatchBlockers(snapshot, nextBatch, states) },
    budget: { normalCalls: seriesNormalCalls(n), planCalls: seriesPlanCalls(n), planAndFirstBatchCalls: seriesPlanCalls(n) + seriesBatchCalls(n, 1),
      callsUsed: snapshot.grants.reduce((total, item) => total + item.callsUsed, 0), billing: "unknown" },
    grants: allGrants,
    activeGrantId: allGrants.find((item) => item.state === "running")?.grantId ?? null,
    calls: snapshot.jobs.flatMap((job) => job.calls).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((call) => ({
      id: call.id, grantId: call.grantId, runId: call.runId, stageKey: call.stageKey, attemptNo: call.attemptNo, providerKey: call.providerKey, model: call.model,
      state: call.state, errorCode: call.errorCode, usage: call.usage, createdAt: call.createdAt, finishedAt: call.finishedAt })),
    human: {
      scriptReview: scripts.every((item) => item === "APPROVED") ? "complete" : scripts.some((item) => item === "APPROVED" || item === "IN_REVIEW") ? "partial" : "not_started",
      tableRead: "not_recorded", liveTiming: "not_recorded", media: "not_started",
    },
  };
}

/** A model version's text as a script: formatted with the setting of the plan revision its job was frozen on. */
function seriesStageText(snapshot: SeriesSnapshot, ref: SeriesVersionRef, episode: SeriesEpisode): string {
  const run = ref.kind === "stage" ? snapshot.jobs.find((job) => job.run.id === ref.runId)?.run : undefined;
  const plan = snapshot.plans.find((item) => item.id === run?.input.planRevisionId) ?? seriesCurrentPlan(snapshot)!;
  return formatSeriesEpisode(episode, plan.content.setting);
}

export interface SeriesPackageMeta {
  generatedAt: string;
}

type PackageStory = SeriesStoryView & { text: string; relationToPlan: "plan_story" | "not_plan_story" };

/**
 * The work's actual current story (the workbench's, people's edits included) and, when it differs, the approved one,
 * each with its text and how it relates to the plan: a story the plan is not bound to is never presented as the plan's.
 */
export function seriesPackageStory(snapshot: SeriesSnapshot): {
  binding: SeriesStoryBinding["status"]; note: string; planStory: { revisionId: string; contentHash: string | null } | null;
  current: PackageStory | null; approved: (PackageStory & { note: string }) | null; approvedIsCurrent: boolean;
} {
  const binding = seriesStoryBinding(snapshot);
  const entry = (story: SeriesStoryRevision): PackageStory => ({ ...storyView(story)!, text: story.text,
    relationToPlan: story.id === binding.planStoryRevisionId ? "plan_story" : "not_plan_story" });
  const approvedIsCurrent = snapshot.project.approvedStoryCurrent;
  return {
    binding: binding.status,
    note: binding.status === "changed"
      ? "工作台当前故事不是规划绑定的故事：系列已停止续写，待人工同步规划与故事；下面的当前故事不是规划定稿。"
      : "当前故事是规划绑定的故事（读取工作台实际当前稿）。审核状态以工作台为准。",
    planStory: binding.planStoryRevisionId ? { revisionId: binding.planStoryRevisionId, contentHash: binding.planStoryHash } : null,
    current: binding.current ? entry(binding.current) : null,
    approved: binding.approved && binding.approved.id !== binding.current?.id
      ? { ...entry(binding.approved), note: "已批准的故事与当前故事不同，分别标明。" } : null,
    approvedIsCurrent,
  };
}

/** The current writing package: the actual current plan, story and episode versions, people's edits included. */
export function seriesPackageJson(snapshot: SeriesSnapshot, meta: SeriesPackageMeta): Record<string, unknown> {
  const view = seriesView(snapshot);
  const plan = seriesCurrentPlan(snapshot);
  const states = seriesBatchStates(snapshot);
  const models = seriesModelVersions(snapshot);
  return {
    schema: SERIES_PACKAGE_SCHEMA,
    kind: "current_writing_package",
    note: "当前编剧交付包：读取实际当前的规划修订、故事和各集修订（包含工作台人工修改）。原自动任务包是历史快照，不代表当前稿。",
    generatedAt: meta.generatedAt,
    seriesId: view.seriesId,
    projectId: view.projectId,
    title: view.title,
    episodeCount: view.episodeCount,
    plannedSecondsPerEpisode: view.episodeSeconds,
    plannedSecondsNote: "每集秒数是写作计划篇幅；没有真人读演或实拍计时，不是实测时长。",
    versions: view.versions,
    completion: { level: view.completion, label: view.completionLabel, written: view.written, total: view.episodeCount, attention: view.attention },
    status: {
      machineChecks: "机器检查仅供内部参考，不代表人工审核或平台审核。",
      humanScriptReview: view.human.scriptReview,
      tableRead: "未记录（没有真人读演）",
      liveTiming: "未记录（没有实拍计时）",
      media: "未开始（本功能不生成图片、语音或视频）",
    },
    plan: plan ? { revisionId: plan.id, revisionNo: plan.revisionNo, origin: plan.origin, contentHash: plan.contentHash, reviewStatus: view.plan!.status,
      storyRevisionId: plan.storyRevisionId, storySave: plan.storySave, setting: plan.content.setting, arc: plan.content.arc, outlines: plan.content.outlines } : null,
    story: seriesPackageStory(snapshot),
    episodes: states.flatMap((state) => state.versions.map((version, index) => {
      const episodeNo = state.first + index;
      const model = models.get(episodeNo);
      const formal = snapshot.episodes.find((item) => item.episodeNo === episodeNo);
      const approved = formal?.approvedScriptRevisionId ? snapshot.scripts.find((item) => item.id === formal.approvedScriptRevisionId) ?? null : null;
      const current = version === null ? null : {
        source: version.ref.kind === "script" ? "workbench_manual_revision" : version.placedScript ? "model_version_in_workbench" : "model_version_not_in_workbench",
        ref: version.ref,
        title: version.episode?.title ?? null,
        summary: seriesSummaryOf(snapshot, version),
        // The workbench's saved text whenever there is one (a person's edit or a placed model version); else the model version
        // formatted with the plan revision its job was written on, never with a newer plan.
        text: version.placedScript ? version.placedScript.text : seriesStageText(snapshot, version.ref, version.episode!),
        structured: version.episode,
        workbench: version.placedScript ? { scriptRevisionId: version.placedScript.id, reviewStatus: version.placedScript.reviewStatus,
          freshnessStatus: version.placedScript.freshnessStatus, contentHash: version.placedScript.contentHash } : null,
      };
      return {
        episodeNo, batchNo: state.batchNo,
        outline: plan?.content.outlines.find((item) => item.episodeNo === episodeNo) ?? null,
        current,
        approved: approved && approved.id !== version?.placedScript?.id
          ? { note: "已批准稿与当前稿不同，分别标明。", scriptRevisionId: approved.id, contentHash: approved.contentHash, text: approved.text } : null,
        unadoptedModelDraft: model && version && model.stage.outputHash !== version.ref.hash
          ? { note: "未采纳的模型稿：来源为系列任务，不是工作台当前稿。", runId: model.run.id, stageKey: model.stage.stageKey, outputHash: model.stage.outputHash,
            text: seriesStageText(snapshot, stageRef(episodeNo, model.run, model.stage), model.stage.output as unknown as SeriesEpisode) } : null,
      };
    })),
    continuity: states.map((state) => ({
      batchNo: state.batchNo, episodes: `${String(state.first)}–${String(state.last)}`, ledgerStatus: state.ledger.status,
      ledger: state.ledger.revision ? { revisionId: state.ledger.revision.id, revisionNo: state.ledger.revision.revisionNo, origin: state.ledger.revision.origin,
        contentHash: state.ledger.revision.contentHash, basis: state.ledger.revision.basis, content: state.ledger.revision.content } : null,
      review: { status: state.review.status, readsFullText: true, passed: state.review.output?.passed ?? null,
        deterministic: state.review.output?.deterministic ?? [], issues: state.review.output?.issues ?? [] },
      changedEpisodes: state.changedEpisodes,
    })),
    finalReview: { status: view.final.status, scope: "全剧结构与连续性总检（不逐字读取各集正文；各集正文由各批全文审阅检查）",
      passed: view.final.output?.passed ?? null, deterministic: view.final.output?.deterministic ?? [], issues: view.final.output?.issues ?? [],
      ...(view.final.previousPassed ? { note: "旧版本曾通过总检；它读取的规划、故事、台账或正文已经变化，不代表当前依赖有效。" } : {}) },
    missing: {
      toWrite: view.ranges.toWrite,
      batchesNeedingRevision: view.ranges.toRevise,
      ledgersToConfirm: view.ranges.toConfirm,
      reviewsToRedo: view.ranges.toReview,
      finalReview: view.final.status === "none" ? "未执行" : view.final.status,
    },
    productionNotes: [
      "竖屏 9:16；每集计划篇幅约 " + String(view.episodeSeconds) + " 秒，正式制作前需真人读演或实拍计时核实。",
      "本包只交付文本：不包含图片、语音或视频；60 集媒体生产未开放。",
      "模型稿始终为草稿；写入工作台的剧本为 DRAFT，须经人工审核。",
    ],
    callsUsed: view.budget.callsUsed,
    billing: "unknown",
  };
}

function mdEscape(value: string): string {
  return value.replace(/\r?\n/g, " ");
}

export function seriesPackageMarkdown(snapshot: SeriesSnapshot, meta: SeriesPackageMeta): string {
  const pack = seriesPackageJson(snapshot, meta) as {
    title: string; completion: { label: string; attention: string[] }; plan: { revisionId: string; revisionNo: number; contentHash: string; reviewStatus: string; setting: SeriesPlanContent["setting"]; arc: SeriesPlanContent["arc"]; outlines: SeriesPlanContent["outlines"] } | null;
    story: ReturnType<typeof seriesPackageStory>;
    episodes: Array<{ episodeNo: number; current: { source: string; ref: SeriesVersionRef; text: string; summary: string | null; workbench: { reviewStatus: string } | null } | null;
      approved: { scriptRevisionId: string; text: string } | null; unadoptedModelDraft: { runId: string; text: string } | null }>;
    continuity: Array<{ batchNo: number; episodes: string; ledgerStatus: string; ledger: { revisionId: string; contentHash: string; content: SeriesLedger } | null; review: { status: string; issues: unknown[]; deterministic: unknown[] } }>;
    finalReview: { status: string; scope: string; note?: string };
    missing: { toWrite: string; batchesNeedingRevision: number[]; ledgersToConfirm: number[]; reviewsToRedo: number[]; finalReview: string };
    productionNotes: string[];
    plannedSecondsNote: string;
  };
  const lines = [
    `# ${pack.title}｜当前编剧交付包`,
    "",
    `> ${SERIES_PACKAGE_SCHEMA}；生成于 ${meta.generatedAt}。读取实际当前的规划、故事和各集修订（包含工作台人工修改）；原自动任务包是历史快照。`,
    `> 完成状态：${pack.completion.label}`,
    ...(pack.completion.attention.length > 0 ? [`> 待办：${pack.completion.attention.join("、")}`] : []),
    `> ${pack.plannedSecondsNote}`,
    "> 状态分开记录：人工审核、真人读演（未记录）、实拍计时（未记录）、媒体生产（未开始）。机器检查不等于人工审核。",
    "",
  ];
  if (pack.plan) {
    const { setting, arc } = pack.plan;
    lines.push("## 全剧规划", "", `修订 ${String(pack.plan.revisionNo)}（${pack.plan.revisionId}），内容哈希 ${pack.plan.contentHash}，规划审阅：${pack.plan.reviewStatus}`, "",
      `**剧名**：${setting.title}`, "", `**一句话故事**：${setting.logline}`, "", `**规划修订中的梗概**（规划修订 ${String(pack.plan.revisionNo)}，不是工作台故事正文）：${setting.synopsis}`, "",
      `**核心冲突**：${setting.core.coreConflict}；**失败代价**：${setting.core.failureCost}`, "", `**结局（第 ${String(arc.finale.episodeNo)} 集）**：${arc.finale.resolution}`, "",
      "### 人物与关系", "", ...setting.characters.map((item) => `- ${item.id} ${item.name}：${item.identity}；弧线：${item.arc}`),
      ...setting.relationships.map((item) => `- 关系 ${item.from}—${item.to}：${item.relation}（${item.arc}）`), "",
      "### 分幕", "", ...arc.phases.map((item) => `- 第${String(item.phaseNo)}幕 ${item.title}（第${String(item.episodeFrom)}–${String(item.episodeTo)}集）：${item.goal}`), "",
      "### 伏笔", "", ...(arc.foreshadowing.length > 0 ? arc.foreshadowing.map((item) => `- ${item.id} ${item.content}：第${String(item.plantEpisode)}集埋 → 第${String(item.payoffEpisode)}集兑现`) : ["- 无"]), "",
      "### 分集细纲", "", ...pack.plan.outlines.map((item) => `- ${mdEscape(seriesOutlineLine(item))}`), "");
  }
  const story = pack.story;
  const storyLine = (item: PackageStory) => `修订 ${item.revisionId}，内容哈希 ${item.contentHash}，审核 ${item.reviewStatus}，新鲜度 ${item.freshnessStatus}，`
    + (item.relationToPlan === "plan_story" ? "是规划绑定的故事" : "不是规划绑定的故事");
  lines.push("## 故事（工作台实际当前稿）", "", `> ${story.note}`, "");
  if (!story.current) lines.push("（作品还没有故事）", "");
  else lines.push(`当前故事：${storyLine(story.current)}`, "", "```text", story.current.text, "```", "");
  if (story.approved) lines.push(`已批准故事（${story.approved.note}）：${storyLine(story.approved)}`, "", "```text", story.approved.text, "```", "");
  lines.push("## 各集剧本", "");
  for (const episode of pack.episodes) {
    lines.push(`### 第 ${String(episode.episodeNo)} 集`, "");
    if (!episode.current) { lines.push("（待写）", ""); continue; }
    lines.push(`来源：${episode.current.source}；版本哈希 ${episode.current.ref.hash}${episode.current.workbench ? `；工作台审核：${episode.current.workbench.reviewStatus}` : ""}`, "",
      `概要：${episode.current.summary ?? "（缺少与此版本绑定的概要）"}`, "", "```text", episode.current.text, "```", "");
    if (episode.approved) lines.push(`已批准稿（与当前稿不同，${episode.approved.scriptRevisionId}）：`, "", "```text", episode.approved.text, "```", "");
    if (episode.unadoptedModelDraft) lines.push(`未采纳的模型稿（来源：系列任务 ${episode.unadoptedModelDraft.runId}，不是工作台当前稿）：`, "", "```text", episode.unadoptedModelDraft.text, "```", "");
  }
  lines.push("## 连续性与伏笔台账", "");
  for (const batch of pack.continuity) {
    lines.push(`### 第 ${String(batch.batchNo)} 批（第 ${batch.episodes} 集）：台账 ${batch.ledgerStatus}；全文审阅 ${batch.review.status}`, "");
    if (batch.ledger) lines.push(`台账修订 ${batch.ledger.revisionId}，哈希 ${batch.ledger.contentHash}`, "", "```json", JSON.stringify(batch.ledger.content, null, 2), "```", "");
  }
  lines.push("## 全剧总检", "", `${pack.finalReview.scope}：${pack.finalReview.status}`, "", ...(pack.finalReview.note ? [pack.finalReview.note, ""] : []), "## 缺项", "",
    `- 待写：${pack.missing.toWrite}`, `- 待修改批次：${pack.missing.batchesNeedingRevision.join("、") || "无"}`,
    `- 待确认台账：${pack.missing.ledgersToConfirm.join("、") || "无"}`, `- 待复核审阅：${pack.missing.reviewsToRedo.join("、") || "无"}`,
    `- 全剧总检：${pack.missing.finalReview}`, "", "## 制作注意事项", "", ...pack.productionNotes.map((item) => `- ${item}`), "");
  return lines.join("\n");
}
