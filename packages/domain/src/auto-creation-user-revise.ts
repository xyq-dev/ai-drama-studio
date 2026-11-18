import {
  autoCreationRevisionsPerRound,
  autoEpisodeSchema,
  autoOutlineSchema,
  autoStageKind,
  type AutoBible,
  type AutoCheckFinding,
  type AutoCreationRunView,
  type AutoReviewIssue,
  type AutoReviewOutput,
  type AutoRevision,
  type AutoRunBundle,
  type AutoStageRecord,
} from "@ai-drama/contracts";
import { z } from "zod";
import { autoContextFromStages, formatAutoStory } from "./auto-creation";

/** Marker stored on pending user-revise stages (depends_on_json) so the engine can build the multi-artifact prompt. */
export const AUTO_USER_REVISE_DEPENDS_KEY = "__adsUserRevise" as const;
/** Path identity for the user-initiated multi-artifact revise (distinct from the frozen single-episode path). */
export const AUTO_USER_REVISE_PATH_VERSION = "ads.auto-creation.user-revise.v1" as const;

export interface AutoUserReviseBrief {
  pathVersion: typeof AUTO_USER_REVISE_PATH_VERSION;
  findingIds: string[];
  instruction: string;
  /** Episode numbers that get revise:r:episode:k stages this round. */
  episodeTargets: number[];
  /** When true, the first revise stage of the round also rewrites outline/story prose and pointed bible fields. */
  syncStory: boolean;
}

export interface AutoUserReviseQuote {
  callsNeeded: number;
  roundsUsed: number;
  roundsBudget: number;
  roundsRemainingAfter: number;
  callsUsed: number;
  callCap: number;
  callsRemainingAfter: number;
  episodeTargets: number[];
  syncStory: boolean;
}

export type AutoUserRevisePlanResult =
  | { ok: true; brief: AutoUserReviseBrief; quote: AutoUserReviseQuote }
  | { ok: false; code: "empty" | "not_eligible" | "rounds_exhausted" | "budget_exhausted" | "unknown_finding" | "too_many_episodes" };

const text = (min: number, max: number) => z.string().max(max)
  .refine((value) => value.trim().length >= min, "必填内容不能为空白");

/** Minimal bible fields a user-initiated revise may sync (never a wholesale rewrite). */
export const autoUserBibleSyncSchema = z.object({
  logline: text(1, 120).nullish(),
  synopsis: text(1, 600).nullish(),
  obstacles: z.array(text(1, 120)).min(1).max(6).nullish(),
  keyChoices: z.array(z.object({ choice: text(1, 120), consequence: text(1, 120) }).strict()).min(1).max(6).nullish(),
}).strict();
export type AutoUserBibleSync = z.infer<typeof autoUserBibleSyncSchema>;

export function autoUserRevisionSchema(episodeCount: number) {
  return autoEpisodeSchema(episodeCount).extend({
    changes: z.array(z.object({
      issueId: z.string().regex(/^(R[1-9]|R10|K[1-9][0-9]{0,3}|U[1-9])$/),
      change: text(1, 150),
    }).strict()).min(1).max(10),
    outline: autoOutlineSchema(episodeCount).required({ storyProse: true }),
    // OpenAI strict: property is required; omit sync with null.
    bibleSync: autoUserBibleSyncSchema.nullable(),
  }).strict();
}
export type AutoUserRevision = z.infer<ReturnType<typeof autoUserRevisionSchema>>;

/** Drop null / empty optional bibleSync so apply only sees real pointed fields. */
export function normalizeUserBibleSync(sync: AutoUserBibleSync | null | undefined): AutoUserBibleSync | undefined {
  if (sync == null) return undefined;
  const next: AutoUserBibleSync = {};
  if (typeof sync.logline === "string") next.logline = sync.logline;
  if (typeof sync.synopsis === "string") next.synopsis = sync.synopsis;
  if (Array.isArray(sync.obstacles)) next.obstacles = sync.obstacles;
  if (Array.isArray(sync.keyChoices)) next.keyChoices = sync.keyChoices;
  return Object.keys(next).length > 0 ? next : undefined;
}

/** Findings the result page may select for a user-initiated revise (including low-severity AI issues). */
export function autoSelectableFindings(review: AutoReviewOutput): Array<{ id: string; target: string; severity: string; detail: string }> {
  const fromChecks = review.deterministic.map((item: AutoCheckFinding) => ({
    id: item.id, target: item.target, severity: item.severity, detail: item.detail,
  }));
  const fromAi = review.issues.filter((item: AutoReviewIssue) => item.evidenceVerified).map((item) => ({
    id: item.id, target: item.target, severity: item.severity,
    detail: `${item.problem}（原文：${item.evidence}）`,
  }));
  return [...fromChecks, ...fromAi];
}

export function lastCompletedReview(stages: readonly AutoStageRecord[]): AutoReviewOutput | null {
  const reviews = stages.filter((stage) => autoStageKind(stage.stageKey) === "review" && stage.state === "completed" && stage.output)
    .sort((a, b) => a.ordinal - b.ordinal);
  return (reviews.at(-1)?.output as AutoReviewOutput | undefined) ?? null;
}

/**
 * A completed run, or one whose last review already passed, may start a user revise while rounds and call budget remain.
 * Automatic fail-then-revise is unchanged; this gate is only for the user-initiated path.
 */
export function autoCanUserRevise(run: Pick<AutoCreationRunView, "state" | "quality" | "revisionRoundsUsed" | "budget" | "callsUsed" | "callCap" | "packageStatus" | "resumeBlock">): boolean {
  if (run.resumeBlock === "story_too_large") return false;
  if (run.state === "running") return false;
  const roundsLeft = run.budget.revisionRounds - run.revisionRoundsUsed;
  if (roundsLeft <= 0) return false;
  // At least one revise + one review must fit.
  if (run.callsUsed + 2 > run.callCap) return false;
  if (run.state === "completed") return true;
  // Machine review passed (including low-only findings) but settlement left unused rounds — rare if state isn't completed,
  // yet quality=passed with leftover rounds is the product trigger.
  return run.quality === "passed" && run.packageStatus === "ready";
}

export function encodeUserReviseDepends(brief: AutoUserReviseBrief): Record<string, string> {
  return { [AUTO_USER_REVISE_DEPENDS_KEY]: JSON.stringify(brief) };
}

export function readUserReviseBrief(dependsOn: Record<string, string> | null | undefined): AutoUserReviseBrief | null {
  const raw = dependsOn?.[AUTO_USER_REVISE_DEPENDS_KEY];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AutoUserReviseBrief;
    if (parsed.pathVersion !== AUTO_USER_REVISE_PATH_VERSION) return null;
    if (!Array.isArray(parsed.findingIds) || typeof parsed.instruction !== "string") return null;
    if (!Array.isArray(parsed.episodeTargets) || typeof parsed.syncStory !== "boolean") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Whether this pending/active revise stage is the multi-artifact user path (not the frozen single-episode auto path). */
export function isUserReviseStage(stage: Pick<AutoStageRecord, "stageKey" | "dependsOn">): boolean {
  return autoStageKind(stage.stageKey) === "revise" && readUserReviseBrief(stage.dependsOn) !== null;
}

function findingById(review: AutoReviewOutput, id: string): { id: string; target: string; severity: string; detail: string } | null {
  return autoSelectableFindings(review).find((item) => item.id === id) ?? null;
}

/**
 * Plans a user-initiated revise round from selected findings and/or free-form instructions.
 * Findings-only, instructions-only, or both are accepted; neither is refused.
 */
export function planAutoUserRevise(
  bundle: AutoRunBundle,
  request: { findingIds: readonly string[]; instruction: string },
): AutoUserRevisePlanResult {
  const { run, stages } = bundle;
  const findingIds = [...new Set(request.findingIds.map((id) => id.trim()).filter(Boolean))];
  const instruction = request.instruction.trim();
  if (findingIds.length === 0 && instruction.length === 0) return { ok: false, code: "empty" };

  if (run.state === "running") return { ok: false, code: "not_eligible" };
  const packageReady = stages.length > 0 && stages.every((s) => s.state === "completed");
  const eligibleState = run.state === "completed" || (run.quality === "passed" && packageReady);
  if (!eligibleState) return { ok: false, code: "not_eligible" };

  const review = lastCompletedReview(stages);
  if (!review) return { ok: false, code: "not_eligible" };
  for (const id of findingIds) {
    if (!findingById(review, id)) return { ok: false, code: "unknown_finding" };
  }

  const episodeTargets = new Set<number>();
  for (const id of findingIds) {
    const found = findingById(review, id)!;
    const episodeNo = /^episode:([1-6])$/.exec(found.target)?.[1];
    if (episodeNo) episodeTargets.add(Number(episodeNo));
  }
  const cap = autoCreationRevisionsPerRound(run.input.episodeCount);
  // Motive / outline-style revises still need a named episode carrier stage (existing key space only).
  if (episodeTargets.size === 0) {
    for (let episodeNo = 1; episodeNo <= Math.min(run.input.episodeCount, cap); episodeNo += 1) episodeTargets.add(episodeNo);
  }
  const targets = [...episodeTargets].sort((a, b) => a - b);
  // Do not silently drop findings that point at more episodes than one round can revise.
  if (targets.length > cap) return { ok: false, code: "too_many_episodes" };
  // Always the multi-artifact path: keep script, outline/story body, and pointed bible fields consistent.
  const syncStory = true;

  const callsNeeded = targets.length + 1;
  const roundsLeft = run.input.revisionRounds - run.revisionRoundsUsed;
  if (roundsLeft <= 0) return { ok: false, code: "rounds_exhausted" };
  if (run.callsUsed + callsNeeded > run.callCap) return { ok: false, code: "budget_exhausted" };

  const brief: AutoUserReviseBrief = {
    pathVersion: AUTO_USER_REVISE_PATH_VERSION,
    findingIds,
    instruction,
    episodeTargets: targets,
    syncStory,
  };
  return {
    ok: true,
    brief,
    quote: {
      callsNeeded,
      roundsUsed: run.revisionRoundsUsed,
      roundsBudget: run.input.revisionRounds,
      roundsRemainingAfter: roundsLeft - 1,
      callsUsed: run.callsUsed,
      callCap: run.callCap,
      callsRemainingAfter: run.callCap - run.callsUsed - callsNeeded,
      episodeTargets: targets,
      syncStory,
    },
  };
}

/** Issue lines for the user-revise prompt: selected findings (any severity) plus the person's instruction. */
export function userReviseIssueBlock(
  review: AutoReviewOutput,
  brief: AutoUserReviseBrief,
  episodeNo: number,
): Array<{ ids: string[]; severity: string; detail: string; target: string }> {
  const selected = brief.findingIds.map((id) => findingById(review, id)).filter((item): item is NonNullable<typeof item> => item !== null);
  const forEpisodeOrStory = selected.filter((item) => item.target === `episode:${String(episodeNo)}` || item.target === "outline" || item.target === "bible");
  const lines = forEpisodeOrStory.map((item) => ({
    ids: [item.id],
    severity: item.severity,
    detail: item.detail,
    target: item.target,
  }));
  if (brief.instruction.trim()) {
    lines.push({ ids: ["U1"], severity: "medium", detail: brief.instruction.trim(), target: "user_instruction" });
  }
  return lines;
}

export function applyBibleSync(bible: AutoBible, sync: AutoUserBibleSync | null | undefined): AutoBible {
  const pointed = normalizeUserBibleSync(sync);
  if (!pointed) return bible;
  return {
    ...bible,
    ...(pointed.logline !== undefined && pointed.logline !== null ? { logline: pointed.logline } : {}),
    ...(pointed.synopsis !== undefined && pointed.synopsis !== null ? { synopsis: pointed.synopsis } : {}),
    story: {
      ...bible.story,
      ...(pointed.obstacles !== undefined && pointed.obstacles !== null ? { obstacles: pointed.obstacles } : {}),
      ...(pointed.keyChoices !== undefined && pointed.keyChoices !== null ? { keyChoices: pointed.keyChoices } : {}),
    },
  };
}

export function stripUserRevisionExtras(output: AutoUserRevision): AutoRevision {
  const { outline: _outline, bibleSync: _bibleSync, ...rest } = output;
  return rest;
}

/** Allowed change issue ids for a user-revise answer (selected findings + U1 when an instruction was given). */
export function userReviseAllowedIssueIds(review: AutoReviewOutput, brief: AutoUserReviseBrief, episodeNo: number): Set<string> {
  return new Set(userReviseIssueBlock(review, brief, episodeNo).flatMap((item) => item.ids));
}

/** Story text for refresh after a successful user revise, or null when context is incomplete / too large. */
export function userReviseStoryText(runId: string, quality: "passed" | "needs_work", stages: readonly AutoStageRecord[]): string | null {
  return formatAutoStory(runId, quality, autoContextFromStages(stages));
}
