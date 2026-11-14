import type { ScriptWorkbenchScript } from "./script-workbench";
import type { TitleWritingProviderKey, TitleWritingUsageView } from "./title-writing";
import type { WritingCandidateState } from "./writing-candidate";

export const SHORT_SEQUEL_AI_SCHEMA = "ads.short-sequel.ai.v1";

export interface ShortSequelAiSource {
  storyRevisionId: string | null;
  previousRevisionId: string | null;
  originalRunId: string | null;
  originalEpisodeHash: string | null;
  planConfirmation?: number;
  confirmedEpisodeCountAtCapture?: number | null;
  lockedPreviousRevisionId?: string | null;
  lockedOriginal?: { runId: string; episodeHash: string } | null;
}

/** A task keeps revision references and a digest of the exact source material sent to the model. */
export interface ShortSequelAiInput {
  schema: typeof SHORT_SEQUEL_AI_SCHEMA;
  taskId: string;
  episodeId: string;
  episodeNo: number;
  episodeCount: number;
  targetEpisodeSeconds: number;
  direction: string;
  source: ShortSequelAiSource;
  contextHash: string;
  providerKey: TitleWritingProviderKey;
  model: string;
}

export interface ShortSequelAiAttempt {
  id: string;
  workspaceId: string;
  projectId: string;
  actorId: string;
  idempotencyKey: string;
  requestHash: string;
  input: ShortSequelAiInput;
  state: WritingCandidateState;
  errorCode: string | null;
  executorId: string | null;
  leaseUntil: string | null;
  script: ScriptWorkbenchScript | null;
  usage: TitleWritingUsageView;
  createdAt: string;
  finishedAt: string | null;
}

export interface ShortSequelAiTaskView {
  taskId: string;
  attemptId: string;
  episodeNo: number;
  episodeCount: number;
  targetEpisodeSeconds: number;
  direction: string;
  source: ShortSequelAiSource;
  state: WritingCandidateState;
  script: ScriptWorkbenchScript | null;
  stale: boolean;
  canResume: boolean;
  providerKey: TitleWritingProviderKey;
  model: string;
  usage: TitleWritingUsageView;
  billing: "unknown";
  errorCode: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ShortSequelAiView {
  operatorTokenRequired: boolean;
  enabled: boolean;
  hasBody: boolean;
  task: ShortSequelAiTaskView | null;
  previousTasks: ShortSequelAiTaskView[];
  nextCursor: string | null;
}

type PackageReference = { runId: string; episodeHash: string };
type DraftSource = ShortSequelAiSource & { episodeCount?: number };
interface DraftContext {
  storyRevisionId: string | null;
  currentStoryRevisionId: string | null;
  lastConfirmedStoryRevisionId: string | null;
  lastConfirmedEpisodeCount: number | null;
  planConfirmation: number;
  episodeCount: number;
  previousRevisionId: string | null;
  originalRunId: string | null;
  originalEpisodeHash: string | null;
  previousFreshnessStatus: "CURRENT" | "STALE" | null;
  lockedPreviousRevisionId: string | null;
  lockedPreviousFreshnessStatus?: "CURRENT" | "STALE" | null;
  lockedOriginal: PackageReference | null;
  placedOriginal: PackageReference | null;
}

function firstConfirmationMatches(source: DraftSource, context: DraftContext): boolean {
  return source.episodeCount === context.lastConfirmedEpisodeCount && source.planConfirmation !== undefined
    && source.confirmedEpisodeCountAtCapture !== undefined && source.confirmedEpisodeCountAtCapture !== source.episodeCount
    && context.planConfirmation === source.planConfirmation + 1;
}

export function canBindShortSequelFirstPlan(source: DraftSource, context: DraftContext): boolean {
  return source.storyRevisionId === null && firstConfirmationMatches(source, context)
    && source.episodeCount === context.episodeCount && context.storyRevisionId !== null
    && context.storyRevisionId === context.lastConfirmedStoryRevisionId;
}

export function shortSequelDraftIsExpired(source: DraftSource, context: DraftContext): boolean {
  const previous = source.previousRevisionId;
  const packageMatches = (ref: PackageReference | null) => !!ref
    && source.originalRunId === ref.runId && source.originalEpisodeHash === ref.episodeHash;
  const current = previous !== null ? previous === context.previousRevisionId : packageMatches(context.placedOriginal)
    || (source.originalRunId !== null && source.originalRunId === context.originalRunId && source.originalEpisodeHash === context.originalEpisodeHash);
  const locked = previous !== null ? previous === context.lockedPreviousRevisionId : packageMatches(context.lockedOriginal);
  if ((current && context.previousFreshnessStatus === "STALE") || (locked && context.lockedPreviousFreshnessStatus === "STALE")) return true;
  if (!current && !locked && (source.lockedPreviousRevisionId === undefined || source.lockedPreviousRevisionId !== context.lockedPreviousRevisionId)) return true;
  if (source.planConfirmation === undefined) {
    return source.storyRevisionId !== context.currentStoryRevisionId && source.storyRevisionId !== context.lastConfirmedStoryRevisionId;
  }
  if (context.planConfirmation <= source.planConfirmation) return false;
  return source.storyRevisionId === null ? !firstConfirmationMatches(source, context)
    : source.storyRevisionId !== context.lastConfirmedStoryRevisionId || source.episodeCount !== context.lastConfirmedEpisodeCount;
}

export interface ShortSequelAiHistoryPage {
  items: ShortSequelAiTaskView[];
  nextCursor: string | null;
}
