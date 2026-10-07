import type { Aggregate, EpisodeRecord, StoryRevision, WorkflowRun } from "./project-base";

/**
 * The beginner flow's five steps, derived only from server facts: review and freshness of revisions, episode script
 * pointers, real approved single-shot composites, episode composites and running workflow jobs. Nothing here is a
 * local "done" flag or a fixed percentage; a fact that was not read completely is "unknown", never "done".
 */
export type StepKey = "story" | "script" | "cast" | "sample" | "final";

export type StepState =
  | "not_started"
  | "needs_input"
  | "needs_confirmation"
  | "in_progress"
  | "needs_attention"
  | "done"
  | "source_updated"
  | "unknown";

export const STEP_STATE_TEXT: Record<StepState, string> = {
  not_started: "未开始",
  needs_input: "待补充",
  needs_confirmation: "待确认",
  in_progress: "处理中",
  needs_attention: "需要处理",
  done: "已完成",
  source_updated: "来源已更新",
  unknown: "尚未确认",
};

/** A short symbol so a state is never told by colour alone. */
export const STEP_STATE_MARK: Record<StepState, string> = {
  not_started: "○",
  needs_input: "＋",
  needs_confirmation: "？",
  in_progress: "…",
  needs_attention: "！",
  done: "✓",
  source_updated: "↻",
  unknown: "—",
};

export const STEPS: ReadonlyArray<{ key: StepKey; no: number; title: string; doing: string; decide: string; result: string }> = [
  { key: "story", no: 1, title: "定故事", doing: "把你的想法整理成一个完整故事：主角、核心冲突和三集走向。",
    decide: "故事讲什么、保留哪些内容。", result: "一版经你确认的故事，三集剧本从它出发。" },
  { key: "script", no: 2, title: "看剧本", doing: "逐集阅读剧本：动作、对白和结尾。",
    decide: "每一集是否按这个版本拍。", result: "三集经你确认的剧本。" },
  { key: "cast", no: 3, title: "定人物", doing: "确认角色和场地的文字设定，需要时为角色准备参考图。",
    decide: "人物长什么样、是什么性格，故事发生在哪里。", result: "经你确认的角色与场地设定。" },
  { key: "sample", no: 4, title: "试一段", doing: "先试看一个代表性镜头，检查人物、声音、字幕和节奏。",
    decide: "这一段样片是否合格。", result: "一个经你确认的单镜成片。" },
  { key: "final", no: 5, title: "出成片", doing: "把合格的单镜按顺序编排成一集，检查后下载。",
    decide: "镜头顺序，以及成片是否合格。", result: "经你确认、可以下载的单集成片。" },
];

export interface RevisionFacts {
  reviewStatus: string | null;
  freshnessStatus: string | null;
}

/** One revision's state: absent, stale, rejected, awaiting review or approved and current. */
export function revisionState(revision: RevisionFacts | null, approved = true): StepState {
  if (!revision || !revision.reviewStatus) return "needs_input";
  if (revision.freshnessStatus === "STALE") return "source_updated";
  if (revision.reviewStatus === "REJECTED") return "needs_attention";
  if (revision.reviewStatus === "APPROVED" && approved) return "done";
  return "needs_confirmation";
}

/** Worst first: what the user must look at before anything else. A fact not read yet is never "done". */
const PRIORITY: StepState[] = ["source_updated", "needs_attention", "unknown", "in_progress", "needs_input",
  "needs_confirmation", "not_started", "done"];

export function combine(states: readonly StepState[]): StepState {
  if (states.length === 0) return "needs_input";
  for (const state of PRIORITY) if (states.includes(state)) return state;
  return "done";
}

/**
 * How a list was read. ok: every page that matters was read. unavailable: the server reports the feature off
 * (CONFIGURATION_ERROR). failed: the read failed. incomplete: the bounded scan ended with pages left.
 */
export type ReadState = "ok" | "unavailable" | "failed" | "incomplete";

export interface CompositeSummary {
  read: ReadState;
  approvedActive: boolean;
  draftActive: boolean;
  rejectedActive: boolean;
  staleApproved: boolean;
}

export interface EpisodeMediaFacts {
  /** Approved, current single-shot composites; the scan stops once enough are found, so count is a lower bound. */
  candidates: { read: ReadState; count: number };
  /** Episode composites seen, current (ACTIVE) and history (STALE), summarized by review. */
  composites: CompositeSummary;
}

export interface ListFacts<T> {
  items: T[];
  read: ReadState;
}

export interface BeginnerFacts {
  story: StoryRevision | null;
  episodes: EpisodeRecord[];
  characters: ListFacts<Aggregate>;
  locations: ListFacts<Aggregate>;
  /** Every workflow run of the project, unfiltered. */
  runs: WorkflowRun[];
  media: Record<number, EpisodeMediaFacts>;
}

export function scriptState(episode: EpisodeRecord | undefined): StepState {
  if (!episode || !episode.currentScriptRevisionId) return "needs_input";
  return revisionState({ reviewStatus: episode.currentScriptReviewStatus, freshnessStatus: episode.currentScriptFreshnessStatus },
    episode.approvedScriptRevisionId === episode.currentScriptRevisionId);
}

export function entityState(entity: Aggregate): StepState {
  return revisionState(entity.currentRevision
    ? { reviewStatus: entity.currentRevision.reviewStatus, freshnessStatus: entity.currentRevision.freshnessStatus }
    : null, entity.approvedRevisionId !== null && entity.approvedRevisionId === entity.currentRevisionId);
}

const RUNNING = new Set(["PENDING", "QUEUED", "RUNNING", "WAITING_EXTERNAL", "RETRY_WAIT"]);

/**
 * Shot media jobs still running. Finished history is not used: a job that succeeded or failed for an older shot
 * revision says nothing about the current sample.
 */
function shotJobRunning(runs: readonly WorkflowRun[]): boolean {
  return runs.some((run) => run.jobs.some((job) => job.kind.startsWith("MEDIA_") && Boolean(job.sourceShotRevisionId)
    && RUNNING.has(job.state)));
}

/** Episode compose running for exactly this episode, by the episode frozen in the job input. Never inferred. */
export function episodeComposeRunning(runs: readonly WorkflowRun[], episodeId: string | undefined): boolean {
  if (!episodeId) return false;
  return runs.some((run) => run.jobs.some((job) => job.kind === "MEDIA_COMPOSE" && !job.sourceShotRevisionId
    && job.composeEpisodeId === episodeId && RUNNING.has(job.state)));
}

/** Any compose job (single shot or episode) still running. */
export function composeRunning(runs: readonly WorkflowRun[]): boolean {
  return runs.some((run) => run.jobs.some((job) => job.kind === "MEDIA_COMPOSE" && RUNNING.has(job.state)));
}

export function episodeSampleState(facts: BeginnerFacts, episodeNo: number): StepState {
  if (scriptState(facts.episodes.find((item) => item.episodeNo === episodeNo)) !== "done") return "not_started";
  const candidates = facts.media[episodeNo]?.candidates;
  if (!candidates) return "unknown";
  if (candidates.count > 0) return "done";
  if (candidates.read !== "ok") return "unknown";
  return shotJobRunning(facts.runs) ? "in_progress" : "needs_input";
}

export function sampleState(facts: BeginnerFacts): StepState {
  const ready = [1, 2, 3].filter((no) => scriptState(facts.episodes.find((item) => item.episodeNo === no)) === "done");
  if (ready.length === 0) return "not_started";
  const perEpisode = ready.map((no) => episodeSampleState(facts, no));
  if (perEpisode.includes("done")) return "done";
  if (perEpisode.includes("unknown")) return "unknown";
  return shotJobRunning(facts.runs) ? "in_progress" : "needs_input";
}

export function episodeFinalState(facts: BeginnerFacts, episodeNo: number): StepState {
  const media = facts.media[episodeNo];
  const episode = facts.episodes.find((item) => item.episodeNo === episodeNo);
  if (!media || !episode) return "not_started";
  const composites = media.composites;
  // An approved current composite settles the episode even when later pages were not read.
  if (composites.approvedActive) return "done";
  if (composites.read === "unavailable" || composites.read === "failed") return "unknown";
  if (episodeComposeRunning(facts.runs, episode.id)) return "in_progress";
  if (composites.draftActive) return "needs_confirmation";
  if (composites.rejectedActive) return "needs_attention";
  // History survives a script change: an approved result made stale by an upstream edit is still a fact.
  if (composites.staleApproved) return "source_updated";
  if (composites.read === "incomplete") return "unknown";
  if (media.candidates.count >= 2) return "needs_input";
  return media.candidates.read === "ok" || scriptState(episode) !== "done" ? "not_started" : "unknown";
}

function listStates(list: ListFacts<Aggregate>): StepState[] {
  const states = list.items.map(entityState);
  if (list.read !== "ok") states.push("unknown");
  return states;
}

export function stepStates(facts: BeginnerFacts): Record<StepKey, StepState> {
  const story = facts.story ? revisionState(facts.story) : "not_started";
  const scriptStates = [1, 2, 3].map((no) => scriptState(facts.episodes.find((item) => item.episodeNo === no)));
  const script = facts.episodes.length === 0 ? "not_started" : combine(scriptStates);
  const anyScript = scriptStates.includes("done");
  // Location problems count even before the first character exists.
  const castStates = [...listStates(facts.characters), ...listStates(facts.locations)];
  if (facts.characters.read === "ok" && facts.characters.items.length === 0) castStates.push(anyScript ? "needs_input" : "not_started");
  const cast = combine(castStates);
  const sample = sampleState(facts);
  const finals = [1, 2, 3].map((no) => episodeFinalState(facts, no));
  const open = finals.filter((state) => state !== "not_started" && state !== "done");
  const final: StepState = finals.every((state) => state === "done") ? "done"
    : open.length > 0 ? combine(open)
      : finals.every((state) => state === "not_started") ? "not_started" : "needs_input";
  return { story, script, cast, sample, final };
}

/** The first step that still needs the user, in order; done everywhere means the last step. */
export function currentStep(states: Record<StepKey, StepState>): StepKey {
  return STEPS.find((step) => states[step.key] !== "done")?.key ?? "final";
}

/** Per-episode state of a step that has one. */
export function episodeStepState(step: StepKey, facts: BeginnerFacts, episodeNo: number): StepState {
  if (step === "script") return scriptState(facts.episodes.find((item) => item.episodeNo === episodeNo));
  if (step === "sample") return episodeSampleState(facts, episodeNo);
  if (step === "final") return episodeFinalState(facts, episodeNo);
  return "done";
}

/** The episode a step should open: the first one whose own state still needs the user, else episode 1. */
export function episodeForStep(step: StepKey, facts: BeginnerFacts): number {
  if (step !== "script" && step !== "sample" && step !== "final") return 1;
  const open = [1, 2, 3].find((no) => {
    const state = episodeStepState(step, facts, no);
    return state !== "done" && state !== "not_started";
  });
  return open ?? 1;
}

export type PrimaryTarget = "editor" | "review" | "next" | "tasks" | "candidates" | "compose" | "reload";

/** What the single primary action on a step does, from its state. Every target has a real destination. */
export function primaryAction(step: StepKey, state: StepState): { label: string; target: PrimaryTarget } {
  if (state === "unknown") return { label: "重新读取进度", target: "reload" };
  if (state === "done") return step === "final" ? { label: "查看并下载成片", target: "compose" } : { label: "继续下一步", target: "next" };
  if (state === "in_progress") return step === "final" ? { label: "查看合成进度", target: "compose" } : { label: "查看任务进度", target: "tasks" };
  if (state === "needs_confirmation") {
    if (step === "final") return { label: "播放并检查", target: "compose" };
    if (step === "sample") return { label: "播放并检查", target: "candidates" };
    return { label: "检查并确认当前版本", target: "review" };
  }
  // A stale revision cannot be approved again: the way out is a new version, or a new sample or episode cut.
  if (state === "source_updated") {
    if (step === "sample") return { label: "重新生成样片", target: "candidates" };
    if (step === "final") return { label: "重新编排合成", target: "compose" };
    return { label: "修改并保存新版本", target: "editor" };
  }
  if (state === "needs_attention") {
    if (step === "final") return { label: "查看退回原因并重新合成", target: "compose" };
    if (step === "sample") return { label: "选一个镜头重新试做", target: "candidates" };
    return { label: "查看原因并修改", target: "editor" };
  }
  switch (step) {
    case "story": return { label: "写下故事并保存", target: "editor" };
    case "script": return { label: "补齐剧本并保存", target: "editor" };
    case "cast": return { label: "添加角色", target: "editor" };
    case "sample": return { label: "选一个镜头试做", target: "candidates" };
    default: return { label: "编排并合成本集", target: "compose" };
  }
}
