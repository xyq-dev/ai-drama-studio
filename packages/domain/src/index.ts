import { DomainError } from "./errors";

export { DomainError };

export const GENERATION_JOB_STATES = [
  "PENDING",
  "QUEUED",
  "RUNNING",
  "WAITING_EXTERNAL",
  "SUCCEEDED",
  "FAILED",
  "CANCELED",
] as const;
export type GenerationJobState = (typeof GENERATION_JOB_STATES)[number];

export const WORKFLOW_RUN_STATES = [
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "PARTIAL_FAILED",
  "FAILED",
  "CANCELED",
] as const;
export type WorkflowRunState = (typeof WORKFLOW_RUN_STATES)[number];

const transitions: Readonly<Record<GenerationJobState, readonly GenerationJobState[]>> = {
  PENDING: ["QUEUED", "CANCELED"],
  QUEUED: ["RUNNING", "CANCELED"],
  RUNNING: ["WAITING_EXTERNAL", "SUCCEEDED", "QUEUED", "FAILED", "CANCELED"],
  WAITING_EXTERNAL: ["RUNNING", "QUEUED", "SUCCEEDED", "FAILED", "CANCELED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELED: [],
};

export function canTransitionJob(from: GenerationJobState, to: GenerationJobState): boolean {
  return transitions[from].includes(to);
}

export function assertJobTransition(from: GenerationJobState, to: GenerationJobState): void {
  if (!canTransitionJob(from, to)) {
    throw new DomainError("JOB_INVALID_TRANSITION", `Generation job cannot transition from ${from} to ${to}`);
  }
}

export interface WorkflowJobSummary {
  state: GenerationJobState;
  isCritical: boolean;
}

export function deriveWorkflowRunState(jobs: readonly WorkflowJobSummary[]): WorkflowRunState {
  if (jobs.length === 0 || jobs.every(({ state }) => state === "PENDING")) {
    return "PENDING";
  }

  const terminal = new Set<GenerationJobState>(["SUCCEEDED", "FAILED", "CANCELED"]);
  if (jobs.some(({ state }) => !terminal.has(state))) {
    return "RUNNING";
  }

  const hasFailure = jobs.some(({ state }) => state === "FAILED");
  const hasCancellation = jobs.some(({ state }) => state === "CANCELED");
  if (hasCancellation && !hasFailure) {
    return "CANCELED";
  }
  if (jobs.some(({ state, isCritical }) => isCritical && state === "FAILED")) {
    return "FAILED";
  }
  if (hasFailure || hasCancellation) {
    return "PARTIAL_FAILED";
  }
  return "SUCCEEDED";
}

export {
  FRESHNESS_STATUSES,
  PRODUCTION_EPISODE_NUMBERS,
  REVIEW_STATUSES,
  assertProductionEpisodeSet,
  assertReviewTransition,
  canonicalInputHash,
  canonicalJson,
  type FreshnessStatus,
  type ReviewStatus,
} from "./text-chain";
