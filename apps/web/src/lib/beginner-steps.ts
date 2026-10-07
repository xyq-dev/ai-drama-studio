import type { Aggregate, EpisodeRecord, StoryRevision, WorkflowRun } from "./project-base";

/**
 * The beginner flow's five steps, derived only from server facts: review and freshness of revisions, episode script
 * pointers, real approved single-shot composites, episode composites and workflow runs. Nothing here is a local
 * "done" flag or a fixed percentage; an unloaded fact stays unknown instead of being guessed.
 */
export type StepKey = "story" | "script" | "cast" | "sample" | "final";

export type StepState =
  | "not_started"
  | "needs_input"
  | "needs_confirmation"
  | "in_progress"
  | "needs_attention"
  | "done"
  | "source_updated";

export const STEP_STATE_TEXT: Record<StepState, string> = {
  not_started: "未开始",
  needs_input: "待补充",
  needs_confirmation: "待确认",
  in_progress: "处理中",
  needs_attention: "需要处理",
  done: "已完成",
  source_updated: "来源已更新",
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

/** Worst first: what the user must look at before anything else. */
const PRIORITY: StepState[] = ["source_updated", "needs_attention", "in_progress", "needs_input", "needs_confirmation",
  "not_started", "done"];

export function combine(states: readonly StepState[]): StepState {
  if (states.length === 0) return "needs_input";
  for (const state of PRIORITY) if (states.includes(state)) return state;
  return "done";
}

export interface EpisodeMediaFacts {
  /** Approved, current single-shot composites the episode can compose from; null while unread. */
  candidates: number | null;
  /** Episode composites: current (ACTIVE) or history (STALE), with their review. null while unread. */
  composites: Array<{ status: string; reviewStatus: string }> | null;
}

export interface BeginnerFacts {
  story: StoryRevision | null;
  episodes: EpisodeRecord[];
  characters: Aggregate[];
  locations: Aggregate[];
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

function shotMediaRuns(runs: readonly WorkflowRun[]) {
  return runs.flatMap((run) => run.jobs.filter((job) => job.kind.startsWith("MEDIA_") && job.sourceShotRevisionId)
    .map((job) => ({ run, job })));
}

export function episodeSampleState(facts: BeginnerFacts, episodeNo: number): StepState {
  if (scriptState(facts.episodes.find((item) => item.episodeNo === episodeNo)) !== "done") return "not_started";
  const media = facts.media[episodeNo];
  if (media?.candidates && media.candidates > 0) return "done";
  return media?.candidates === null || media === undefined ? "not_started" : "needs_input";
}

export function sampleState(facts: BeginnerFacts): StepState {
  const scripts = [1, 2, 3].map((no) => scriptState(facts.episodes.find((item) => item.episodeNo === no)));
  if (!scripts.includes("done")) return "not_started";
  if ([1, 2, 3].some((no) => (facts.media[no]?.candidates ?? 0) > 0)) return "done";
  const shotJobs = shotMediaRuns(facts.runs);
  if (shotJobs.some(({ job }) => RUNNING.has(job.state))) return "in_progress";
  const latestCompose = shotJobs.filter(({ job }) => job.kind === "MEDIA_COMPOSE")
    .sort((left, right) => right.run.createdAt.localeCompare(left.run.createdAt))[0];
  // A finished single-shot compose without an approved candidate yet is waiting for the user's review.
  if (latestCompose?.job.state === "SUCCEEDED") return "needs_confirmation";
  if (latestCompose && (latestCompose.job.state === "FAILED" || latestCompose.job.state === "CANCELED")) return "needs_attention";
  return "needs_input";
}

export function episodeFinalState(facts: BeginnerFacts, episodeNo: number): StepState {
  const media = facts.media[episodeNo];
  if (!media || media.composites === null) return "not_started";
  const current = media.composites.filter((item) => item.status === "ACTIVE");
  if (current.some((item) => item.reviewStatus === "APPROVED")) return "done";
  if (current.some((item) => item.reviewStatus === "DRAFT")) return "needs_confirmation";
  if (media.composites.some((item) => item.status === "STALE" && item.reviewStatus === "APPROVED")) return "source_updated";
  // Episode compose jobs carry no shot revision; the job view does not say which episode, so a running one marks
  // every episode still without a current composite as in progress.
  const composing = facts.runs.some((run) => run.jobs.some((job) => job.kind === "MEDIA_COMPOSE" && !job.sourceShotRevisionId
    && RUNNING.has(job.state)));
  if (composing) return "in_progress";
  return (media.candidates ?? 0) >= 2 ? "needs_input" : "not_started";
}

export function stepStates(facts: BeginnerFacts): Record<StepKey, StepState> {
  const story = facts.story ? revisionState(facts.story) : "not_started";
  const scriptStates = [1, 2, 3].map((no) => scriptState(facts.episodes.find((item) => item.episodeNo === no)));
  const script = facts.episodes.length === 0 ? "not_started" : combine(scriptStates);
  const anyScript = scriptStates.includes("done");
  const cast = facts.characters.length === 0
    ? (anyScript ? "needs_input" : "not_started")
    : combine([...facts.characters, ...facts.locations].map(entityState));
  const sample = sampleState(facts);
  const finals = [1, 2, 3].map((no) => episodeFinalState(facts, no));
  const open = finals.filter((state) => state !== "not_started" && state !== "done");
  const final: StepState = finals.every((state) => state === "done") ? "done"
    : finals.every((state) => state === "not_started") ? "not_started"
      : open.length > 0 ? combine(open) : "needs_input";
  return { story, script, cast, sample, final };
}

/** The first step that still needs the user, in order; done everywhere means the last step. */
export function currentStep(states: Record<StepKey, StepState>): StepKey {
  return STEPS.find((step) => states[step.key] !== "done")?.key ?? "final";
}

/** What the single primary action on a step should do, in plain words, from its state. */
export function primaryAction(step: StepKey, state: StepState): { label: string; target: "editor" | "review" | "next" | "tasks" | "candidates" } {
  if (state === "done") return { label: "继续下一步", target: "next" };
  if (state === "in_progress") return { label: "查看任务进度", target: "tasks" };
  if (state === "needs_confirmation") {
    return step === "sample" || step === "final" ? { label: "播放并检查", target: "review" } : { label: "检查并确认当前版本", target: "review" };
  }
  if (state === "source_updated") return { label: "查看变化并重新确认", target: "review" };
  if (state === "needs_attention") return { label: "查看原因并修改", target: "editor" };
  switch (step) {
    case "story": return { label: "写下故事并保存", target: "editor" };
    case "script": return { label: "补齐剧本并保存", target: "editor" };
    case "cast": return { label: "添加角色", target: "editor" };
    case "sample": return { label: "选一个镜头试做", target: "candidates" };
    default: return { label: "编排并合成本集", target: "editor" };
  }
}
