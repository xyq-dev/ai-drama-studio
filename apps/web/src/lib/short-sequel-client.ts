import type {
  AutoBible, AutoCreationConstraints, AutoDirectionsOutput, AutoEpisode, AutoOutline, ScriptWorkbenchPlan, ScriptWorkbenchRevision,
  ScriptWorkbenchSnapshot, ShortSequelAiSource,
} from "@ai-drama/contracts";
import { inheritShortSequelPlan } from "@ai-drama/domain";
import { emptyPlan } from "./script-workbench-model";
import { StudioClient } from "./studio-client";

export interface ShortSequelContinuation {
  episodeNo: number;
  episodeId: string;
}

export interface ShortSequelListView {
  episodeCount: number;
  targetEpisodeSeconds: number | null;
  nextEpisodeNo: number | null;
  continuations: ShortSequelContinuation[];
}

export interface ShortSequelSource extends ShortSequelAiSource {
  episodeCount?: number;
  aiAttemptId?: string;
}

export interface ShortSequelPredecessor {
  revisionId: string;
  revisionNo: number;
  content: Record<string, unknown>;
  handoff: string | null;
  freshnessStatus: string;
}

export interface ShortSequelView extends ShortSequelContinuation, ShortSequelSource {
  episodeCount: number;
  targetEpisodeSeconds: number | null;
  storyConfirmed: boolean;
  currentStoryRevisionId: string | null;
  currentStoryRevisionNo: number | null;
  confirmedStoryRevisionId: string | null;
  lastConfirmedStoryRevisionId: string | null;
  lastConfirmedStoryRevisionNo: number | null;
  lastConfirmedEpisodeCount: number | null;
  planConfirmation: number;
  previousEpisodeNo: number;
  previousLocked: boolean;
  previousFreshnessStatus: "CURRENT" | "STALE" | null;
  lockedPreviousFreshnessStatus?: "CURRENT" | "STALE" | null;
  previousHandoff: string | null;
  lockedPreviousRevisionId: string | null;
  placedOriginal: { runId: string; episodeHash: string } | null;
  lockedOriginal: { runId: string; episodeHash: string } | null;
  previousScript: Record<string, unknown> | null;
  original: {
    runId: string;
    research: unknown;
    topic: AutoDirectionsOutput | null;
    story: AutoBible | null;
    outline: AutoOutline | null;
    previousScript: AutoEpisode | null;
    previousScriptText: string | null;
    constraints: AutoCreationConstraints;
    previousStageHash: string | null;
  } | null;
}

const client = new StudioClient();

export function shortSequelPath(projectId: string, episodeNo?: number): string {
  const path = `/projects/${projectId}/short-sequels`;
  return episodeNo === undefined ? path : `${path}/${episodeNo}`;
}

export function shortSequelWorkbenchUrl(projectId: string, episodeNo: number): string {
  return `/projects/${projectId}/script?episode=${episodeNo}`;
}

export function readShortSequelPredecessor(projectId: string, episodeNo: number, revisionId: string, signal: AbortSignal) {
  return client.get<ShortSequelPredecessor>(`${shortSequelPath(projectId, episodeNo)}/previous/${revisionId}`, { signal });
}

export function readShortSequelList(projectId: string, signal: AbortSignal) {
  return client.get<ShortSequelListView>(shortSequelPath(projectId), { signal });
}

export function confirmShortSequel(projectId: string, episodeNo: number, idempotencyKey: string) {
  return client.write<ShortSequelContinuation & { episodeCount: number }>({
    path: `${shortSequelPath(projectId)}/confirm`, body: { episodeNo }, idempotencyKey,
  });
}

export function shortSequelSource(value: ShortSequelSource | ShortSequelView): ShortSequelSource {
  const { storyRevisionId, previousRevisionId, originalRunId, originalEpisodeHash, episodeCount, planConfirmation,
    lockedPreviousRevisionId, lockedOriginal } = value;
  const confirmedEpisodeCountAtCapture = "lastConfirmedEpisodeCount" in value
    ? value.lastConfirmedEpisodeCount : value.confirmedEpisodeCountAtCapture;
  return { storyRevisionId, previousRevisionId, originalRunId, originalEpisodeHash, episodeCount, planConfirmation,
    lockedPreviousRevisionId, lockedOriginal, confirmedEpisodeCountAtCapture,
    ...("aiAttemptId" in value ? { aiAttemptId: value.aiAttemptId } : {}) };
}

export function sameSequelPrevious(a: ShortSequelSource, b: ShortSequelSource): boolean {
  return a.previousRevisionId === b.previousRevisionId && a.originalRunId === b.originalRunId
    && a.originalEpisodeHash === b.originalEpisodeHash;
}

export function matchesSequelPrevious(source: ShortSequelSource, context: ShortSequelView): boolean {
  return sameSequelPrevious(source, context) || (!!context.placedOriginal
    && source.originalRunId === context.placedOriginal.runId
    && source.originalEpisodeHash === context.placedOriginal.episodeHash);
}

export function savedShortSequelOutlineEpisode(revision: ScriptWorkbenchRevision | null): number | null {
  const workbench = revision?.content.workbench;
  if (!workbench || typeof workbench !== "object" || !("continuationEpisodeNo" in workbench)) return null;
  const value = workbench.continuationEpisodeNo;
  return typeof value === "number" && Number.isInteger(value) && value >= 2 && value <= 6 ? value : null;
}

export function savedShortSequelSource(revision: ScriptWorkbenchRevision | null): ShortSequelSource | null {
  const workbench = revision?.content.workbench;
  if (!workbench || typeof workbench !== "object" || !("sourceStoryRevisionId" in workbench)
    || typeof workbench.sourceStoryRevisionId !== "string" || !("continuation" in workbench)
    || !workbench.continuation || typeof workbench.continuation !== "object") return null;
  const value = workbench.continuation as Omit<ShortSequelSource, "storyRevisionId">;
  return { ...value, storyRevisionId: workbench.sourceStoryRevisionId };
}

export function expandedShortSequelPlan(
  snapshot: ScriptWorkbenchSnapshot,
  current: ScriptWorkbenchPlan,
  reference: ShortSequelView,
  fromLegacy: boolean,
): ScriptWorkbenchPlan {
  const template = emptyPlan(snapshot);
  const inherited = fromLegacy && reference.original && reference.targetEpisodeSeconds !== null
    ? inheritShortSequelPlan(reference.original, reference.targetEpisodeSeconds, snapshot.project.episodeCount) ?? current
    : current;
  return {
    brief: { ...inherited.brief, targetEpisodeSeconds: reference.targetEpisodeSeconds ?? inherited.brief.targetEpisodeSeconds },
    bible: inherited.bible,
    outline: { episodes: template.outline.episodes.map((blank) =>
      inherited.outline.episodes.find((item) => item.episodeNo === blank.episodeNo) ?? blank) },
  };
}
