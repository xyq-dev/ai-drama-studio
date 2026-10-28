import { z } from "zod";
import {
  AUTO_CREATION_CHECKS_VERSION,
  AUTO_CREATION_PROMPT_MAX_CHARS,
  AUTO_CREATION_PROMPT_VERSION,
  AUTO_CREATION_RESEARCH_SCHEMA,
  AUTO_CREATION_SELECTION_RULES,
  autoCreationMaterialSchema,
  type AutoCreationChecksVersion,
  type AutoCreationMaterial,
  type AutoCreationPromptVersion,
} from "./auto-creation";
import {
  DEEPSEEK_PROVIDER_ADAPTER,
  TITLE_WRITING_EPISODE_SECONDS_CHOICES,
  TITLE_WRITING_STORED_PROVIDER_KEYS,
  type TitleWritingCallState,
  type TitleWritingProviderKey,
  type TitleWritingStoredProviderKey,
  type TitleWritingUsageView,
} from "./title-writing";

/**
 * Series writing (docs/SERIES_WRITING.md): one work of 1–60 episodes, planned once as a frozen plan revision (setting,
 * arc, outlines in chunks of six, one plan review), written three episodes at a time with a continuity ledger carried
 * from batch to batch, every batch read in full by its own review, and one structural review of the whole series.
 *
 * It is a mode of its own: the short-drama flows (title writing, automatic creation) keep their 1–6 episode contracts,
 * constants and stored runs unchanged, and nothing here opens media production for more than the six episodes it was
 * validated on. Series runs live in series_writing_* tables and share the provider adapters, the single-send rule, the
 * workspace call lock, the daily cap and the concurrency cap with every other paid text call.
 */
export const SERIES_WRITING_INPUT_SCHEMA = "ads.series-writing.input.v1" as const;
export const SERIES_WRITING_PROMPT_VERSION = "ads.series-writing.prompt.v2" as const;
/** A job keeps the series prompt it was frozen with; v2 clarifies arc dependencies without changing validation. */
export type SeriesPromptVersion = "ads.series-writing.prompt.v1" | typeof SERIES_WRITING_PROMPT_VERSION;
export const SERIES_WRITING_CHECKS_VERSION = "ads.series-writing.checks.v1" as const;
export const SERIES_WRITING_GRANT_SCHEMA = "ads.series-writing.grant.v1" as const;
export const SERIES_WRITING_JOB_SCHEMA = "ads.series-writing.job.v1" as const;
export const SERIES_SETTING_SCHEMA = "ads.series-writing.setting.v1" as const;
export const SERIES_ARC_SCHEMA = "ads.series-writing.arc.v1" as const;
export const SERIES_OUTLINE_SCHEMA = "ads.series-writing.outline.v1" as const;
export const SERIES_PLAN_SCHEMA = "ads.series-writing.plan.v1" as const;
export const SERIES_PLAN_REVIEW_SCHEMA = "ads.series-writing.plan-review.v1" as const;
export const SERIES_EPISODE_SCHEMA = "ads.series-writing.episode.v1" as const;
export const SERIES_LEDGER_SCHEMA = "ads.series-writing.ledger.v1" as const;
export const SERIES_BATCH_REVIEW_SCHEMA = "ads.series-writing.batch-review.v1" as const;
export const SERIES_FINAL_REVIEW_SCHEMA = "ads.series-writing.final-review.v1" as const;
export const SERIES_PACKAGE_SCHEMA = "ads.series-writing.package.v1" as const;

/**
 * The research and the directions of a series are the automatic creation stages as they stand: their prompt, answer
 * contract (research v4: limited is AI creative planning, sourced keeps cited findings), number checks and rule-based
 * choice. A series records which versions it borrowed; their meaning is unchanged, so no new version is minted for them.
 * A new series freezes the current shared versions (prompt v8 names every field of one hypothesis); a series created
 * earlier keeps the version it froze (prompt v7), and its research records the version it was actually sent with.
 * Checks v8 reads a verification plan's sample of the work as a sample within it; a series created earlier keeps the
 * checks version it froze (v7). Checks v9 reads that sample only when its own sample verb takes the count; a series
 * created under v8 keeps the v8 it froze. Prompt v9 / checks v10: a structure's method is a catalog id of the plan job's
 * own saved snapshot (research v4 stored as before); a series created earlier keeps the versions it froze. Prompt v10 /
 * checks v11: a verification plan may read part of the work (its sample within the series' own episodes; a scope the
 * code cannot place is a notice); a series created earlier keeps the versions it froze. Checks v12: every creative field
 * reads a part of the work or a position in it within the series' own episodes; a series created earlier keeps the
 * checks version it froze. Prompt v11 / checks v14: the same application line on timing and viewer effect, a statistic
 * after an unmarked viewing time reported first, and a viewer's own choice (决定是否…) no pending marker; a series
 * created earlier keeps the versions it froze, and its research records the versions it was actually sent with.
 */
export const SERIES_RESEARCH_CONTRACT = {
  promptVersion: AUTO_CREATION_PROMPT_VERSION,
  checksVersion: AUTO_CREATION_CHECKS_VERSION,
  researchSchema: AUTO_CREATION_RESEARCH_SCHEMA,
  selectionRules: AUTO_CREATION_SELECTION_RULES,
} as const;
/** The borrowed versions a stored series may carry: the current ones, or the prompt and checks versions it was created with. */
export type SeriesResearchContract = Omit<typeof SERIES_RESEARCH_CONTRACT, "promptVersion" | "checksVersion">
  & { promptVersion: AutoCreationPromptVersion; checksVersion: AutoCreationChecksVersion };

export const SERIES_MIN_EPISODES = 1;
export const SERIES_MAX_EPISODES = 60;
export const SERIES_SECONDS_CHOICES = TITLE_WRITING_EPISODE_SECONDS_CHOICES;
export const SERIES_DEFAULT_SECONDS = 60;
/** Episodes one batch writes before its review: 1–3, 4–6, …; the last batch may be shorter. */
export const SERIES_BATCH_SIZE = 3;
/** Episodes one outline call plans. */
export const SERIES_OUTLINE_CHUNK = 6;
/** The planning calls before the outlines: research, directions, setting, arc. */
export const SERIES_PLAN_FIXED_CALLS = 4;
/** The most calls one job (a sub-task: the plan, one batch, the final review) may reserve: the existing per-run cap. */
export const SERIES_JOB_MAX_CALLS = 60;
/** Resends a person may confirm on top of a grant's normal calls (rejected or uncertain stages). Never automatic. */
export const SERIES_MAX_RESEND_ALLOWANCE = 2;
/** The largest prompt sent, unchanged from automatic creation. */
export const SERIES_PROMPT_MAX_CHARS = AUTO_CREATION_PROMPT_MAX_CHARS;
/** The texts a review reads share this many characters, unchanged from automatic creation. */
export const SERIES_REVIEW_CONTENT_CHARS = 28_000;
/** Most characters of the code's findings in a review prompt (grouped when longer, every finding kept in the record). */
export const SERIES_FINDINGS_MAX_CHARS = 3_000;

/**
 * Error codes of a series call that was never sent: a reservation recovery gave back after its executor was lost, or one
 * closed by a cancel before its send. Such a call is kept for the record and counted nowhere: not in its job, its grant
 * or the shared daily cap.
 */
/**
 * Calls that were never sent: given back by recovery, closed by a cancel before the send, or closed at the last check
 * before the send because the job's frozen plan, story, ledger or previous episode changed (counted nowhere).
 */
export const SERIES_NEVER_SENT_ERROR_CODES = ["executor_lost_before_send", "canceled_before_send", "upstream_changed_before_send"] as const;
/** A reserved call closed at the last check before its send: what the job was frozen on is no longer current. */
export const SERIES_UPSTREAM_BEFORE_SEND = "upstream_changed_before_send";

/**
 * Field budgets (characters of the JSON as stored, or of the compact line an outline is shown as). Each accepted text
 * stays within its own budget, so every review prompt holds what it must read whole: an answer over its budget is
 * refused (too_large), never cut, and nothing is dropped from a prompt to make room.
 */
export const SERIES_BUDGETS = {
  setting: 6_000,
  /** The arc as a whole; its foreshadowing table alone (what a batch review reads of it) at most foreshadowing. */
  arc: 4_500,
  foreshadowing: 3_000,
  /** Every outline line of the series together: what the plan review reads besides the setting and the arc. */
  outlines: 17_500,
  /** One outline line at most, whatever the episode count. */
  outlineLineMax: 600,
  ledger: 7_000,
  episode: 3_300,
  /** One summary line of the final review (第N集：summary). */
  summaryLine: 90,
  /** One batch's digest in the final review. */
  batchDigest: 120,
  /** A handoff block of the previous episode in a writing prompt. */
  handoff: 900,
} as const;

/** The room every outline line has for a series of N episodes. */
export function seriesOutlineLineBudget(episodeCount: number): number {
  return Math.min(SERIES_BUDGETS.outlineLineMax, Math.floor(SERIES_BUDGETS.outlines / episodeCount));
}

/**
 * The shares of the review content budget, per review kind, for a series of N episodes. Every share is the most its text
 * may take; none is negative for 1 ≤ N ≤ 60 (tested), and the sum of each review's shares is within the budget.
 */
export function seriesReviewShares(episodeCount: number): {
  plan: { setting: number; arc: number; outlines: number; spare: number };
  batch: { setting: number; outlines: number; ledger: number; foreshadowing: number; episodes: number; spare: number };
  final: { setting: number; arc: number; ledger: number; summaries: number; batchDigests: number; spare: number };
} {
  const b = SERIES_BUDGETS;
  const line = seriesOutlineLineBudget(episodeCount);
  const plan = { setting: b.setting, arc: b.arc, outlines: line * episodeCount };
  const batch = { setting: b.setting, outlines: line * SERIES_BATCH_SIZE, ledger: b.ledger, foreshadowing: b.foreshadowing, episodes: b.episode * SERIES_BATCH_SIZE };
  const final = { setting: b.setting, arc: b.arc, ledger: b.ledger, summaries: b.summaryLine * episodeCount,
    batchDigests: b.batchDigest * seriesBatchCount(episodeCount) };
  const sum = (value: Record<string, number>) => Object.values(value).reduce((total, item) => total + item, 0);
  return {
    plan: { ...plan, spare: SERIES_REVIEW_CONTENT_CHARS - sum(plan) },
    batch: { ...batch, spare: SERIES_REVIEW_CONTENT_CHARS - sum(batch) },
    final: { ...final, spare: SERIES_REVIEW_CONTENT_CHARS - sum(final) },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Bounded stages and the call formula. The UI, the API and the engine all use these functions.

export function seriesOutlineChunks(episodeCount: number): number {
  return Math.ceil(episodeCount / SERIES_OUTLINE_CHUNK);
}

export function seriesBatchCount(episodeCount: number): number {
  return Math.ceil(episodeCount / SERIES_BATCH_SIZE);
}

/** Global episode numbers of one batch (1-based). */
export function seriesBatchRange(episodeCount: number, batchNo: number): { first: number; last: number } {
  const first = (batchNo - 1) * SERIES_BATCH_SIZE + 1;
  return { first, last: Math.min(batchNo * SERIES_BATCH_SIZE, episodeCount) };
}

export function seriesBatchOf(episodeNo: number): number {
  return Math.ceil(episodeNo / SERIES_BATCH_SIZE);
}

/** Global episode numbers of one outline chunk (1-based). */
export function seriesOutlineRange(episodeCount: number, chunkNo: number): { first: number; last: number } {
  const first = (chunkNo - 1) * SERIES_OUTLINE_CHUNK + 1;
  return { first, last: Math.min(chunkNo * SERIES_OUTLINE_CHUNK, episodeCount) };
}

/** The plan: research, directions, setting, arc, one outline per six episodes, one plan review. */
export function seriesPlanCalls(episodeCount: number): number {
  return SERIES_PLAN_FIXED_CALLS + seriesOutlineChunks(episodeCount) + 1;
}

/** One batch: its episodes and its full-text review. */
export function seriesBatchCalls(episodeCount: number, batchNo: number): number {
  const { first, last } = seriesBatchRange(episodeCount, batchNo);
  return last - first + 1 + 1;
}

export const SERIES_FINAL_CALLS = 1;

/** Every call of a series when each stage succeeds the first time: 6 + ceil(N/6) + N + ceil(N/3). */
export function seriesNormalCalls(episodeCount: number): number {
  return 6 + seriesOutlineChunks(episodeCount) + episodeCount + seriesBatchCount(episodeCount);
}

/** What one grant authorizes: the plan, a run of consecutive batches, the final structural review. */
export interface SeriesScope {
  plan: boolean;
  /** First and last batch of the range, both null for none. */
  batchFrom: number | null;
  batchTo: number | null;
  final: boolean;
}

export type SeriesJobKind = "plan" | "batch" | "final";

/** The jobs of a scope in order, each with its normal calls. A job is one sub-task held to SERIES_JOB_MAX_CALLS. */
export function seriesScopeJobs(episodeCount: number, scope: SeriesScope): Array<{ kind: SeriesJobKind; batchNo: number | null; calls: number }> {
  const jobs: Array<{ kind: SeriesJobKind; batchNo: number | null; calls: number }> = [];
  if (scope.plan) jobs.push({ kind: "plan", batchNo: null, calls: seriesPlanCalls(episodeCount) });
  if (scope.batchFrom !== null && scope.batchTo !== null) {
    for (let batchNo = scope.batchFrom; batchNo <= scope.batchTo; batchNo += 1) {
      jobs.push({ kind: "batch", batchNo, calls: seriesBatchCalls(episodeCount, batchNo) });
    }
  }
  if (scope.final) jobs.push({ kind: "final", batchNo: null, calls: SERIES_FINAL_CALLS });
  return jobs;
}

/** Normal calls of a scope (first success everywhere, no resend, no revision). */
export function seriesScopeCalls(episodeCount: number, scope: SeriesScope): number {
  return seriesScopeJobs(episodeCount, scope).reduce((total, job) => total + job.calls, 0);
}

/** Whether a scope is well formed for a series of N episodes (contents are checked against the series' state elsewhere). */
export function seriesScopeShapeValid(episodeCount: number, scope: SeriesScope): boolean {
  const batches = seriesBatchCount(episodeCount);
  if ((scope.batchFrom === null) !== (scope.batchTo === null)) return false;
  if (scope.batchFrom !== null && scope.batchTo !== null) {
    if (!Number.isInteger(scope.batchFrom) || !Number.isInteger(scope.batchTo)) return false;
    if (scope.batchFrom < 1 || scope.batchTo > batches || scope.batchFrom > scope.batchTo) return false;
  }
  if (scope.final && scope.batchTo !== null && scope.batchTo !== batches) return false;
  return scope.plan || scope.batchFrom !== null || scope.final;
}

// ---------------------------------------------------------------------------------------------------------------
// Stage keys. Multi-digit numbers are read as numbers; stages are ordered by their ordinal, never by key text.

export const SERIES_STAGE_KEY = /^(sources|research|directions|setting|arc|outline:([1-9]|10)|plan_review|episode:([1-9]|[1-5][0-9]|60)|batch_review:([1-9]|1[0-9]|20)|final_review)$/;
export type SeriesStageKind = "sources" | "research" | "directions" | "setting" | "arc" | "outline" | "plan_review" | "episode" | "batch_review" | "final_review";

export function seriesStageKind(stageKey: string): SeriesStageKind {
  if (stageKey.startsWith("outline:")) return "outline";
  if (stageKey.startsWith("episode:")) return "episode";
  if (stageKey.startsWith("batch_review:")) return "batch_review";
  return stageKey as SeriesStageKind;
}

function numberAfter(stageKey: string, prefix: string): number | null {
  if (!SERIES_STAGE_KEY.test(stageKey) || !stageKey.startsWith(prefix)) return null;
  return Number(stageKey.slice(prefix.length));
}

export function seriesStageEpisodeNo(stageKey: string): number | null {
  return numberAfter(stageKey, "episode:");
}

export function seriesStageChunkNo(stageKey: string): number | null {
  return numberAfter(stageKey, "outline:");
}

export function seriesStageBatchNo(stageKey: string): number | null {
  return numberAfter(stageKey, "batch_review:");
}

/** The stages a job starts with, in order. */
export function seriesJobStageKeys(episodeCount: number, kind: SeriesJobKind, batchNo: number | null): string[] {
  if (kind === "plan") {
    return ["sources", "research", "directions", "setting", "arc",
      ...Array.from({ length: seriesOutlineChunks(episodeCount) }, (_, index) => `outline:${String(index + 1)}`), "plan_review"];
  }
  if (kind === "batch") {
    const { first, last } = seriesBatchRange(episodeCount, batchNo!);
    return [...Array.from({ length: last - first + 1 }, (_, index) => `episode:${String(first + index)}`), `batch_review:${String(batchNo)}`];
  }
  return ["final_review"];
}

// ---------------------------------------------------------------------------------------------------------------
// Input.

function text(min: number, max: number) {
  return z.string().max(max)
    .refine((value) => value.trim().length >= min, "必填内容不能为空白")
    // eslint-disable-next-line no-control-regex
    .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), "文本含有控制字符");
}

function list(maxItems: number, maxChars: number, minItems = 0) {
  return z.array(text(1, maxChars)).min(minItems).max(maxItems);
}

/** The person's hard constraints for a series. Every one outranks an AI recommendation; empty fields are left to the AI. */
export const seriesConstraintsSchema = z.object({
  genre: z.string().trim().max(20).default(""),
  audience: z.string().trim().max(40).default(""),
  maxCharacters: z.number().int().min(1).max(12).nullable().default(null),
  maxLocations: z.number().int().min(1).max(10).nullable().default(null),
  forbiddenThemes: z.array(z.string().trim().min(1).max(20)).max(5).default([]),
  endingRequirement: z.string().trim().max(100).default(""),
}).strict();
export type SeriesConstraints = z.infer<typeof seriesConstraintsSchema>;

/**
 * Creates a series work: a new project in series mode with N episodes and the target seconds, and its frozen creative
 * input. Nothing is generated and nothing is sent; generation needs a grant (the confirmation card).
 */
export const seriesCreateSchema = z.object({
  title: z.string().trim().min(1).max(60),
  episodeCount: z.number().int().min(SERIES_MIN_EPISODES).max(SERIES_MAX_EPISODES),
  episodeSeconds: z.number().int().refine((value) => (SERIES_SECONDS_CHOICES as readonly number[]).includes(value), "每集时长只能是 60 或 90 秒"),
  idea: z.string().trim().max(300).default(""),
  constraints: seriesConstraintsSchema.default(seriesConstraintsSchema.parse({})),
  materials: z.array(autoCreationMaterialSchema).max(3).default([]),
  referenceUrls: z.array(z.string().url().max(500)).max(3).default([]),
}).strict();
export type SeriesCreate = z.infer<typeof seriesCreateSchema>;

/** The frozen, hashed creative input of a series (one per work). */
export interface SeriesFrozenInput {
  schema: typeof SERIES_WRITING_INPUT_SCHEMA;
  promptVersion: SeriesPromptVersion;
  checksVersion: typeof SERIES_WRITING_CHECKS_VERSION;
  researchContract: SeriesResearchContract;
  idea: string;
  constraints: SeriesConstraints;
  materials: AutoCreationMaterial[];
  referenceUrls: string[];
  /** Whether the server read public pages for this series (fixed when the series was created). */
  researchFetch: boolean;
  episodeCount: number;
  episodeSeconds: number;
  batchSize: typeof SERIES_BATCH_SIZE;
  outlineChunk: typeof SERIES_OUTLINE_CHUNK;
}

const MODEL_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export const seriesScopeSchema = z.object({
  plan: z.boolean(),
  batchFrom: z.number().int().min(1).max(20).nullable(),
  batchTo: z.number().int().min(1).max(20).nullable(),
  final: z.boolean(),
}).strict();

/**
 * A grant: what the confirmation card showed and the person accepted. The server recomputes the normal calls from the
 * scope and refuses any other number; it freezes the provider and model as sent, so a later configuration change can
 * never replace them. Idempotency-Key identifies the grant.
 */
export const seriesGrantRequestSchema = z.object({
  scope: seriesScopeSchema,
  normalCalls: z.number().int().min(1).max(200),
  resendAllowance: z.number().int().min(0).max(SERIES_MAX_RESEND_ALLOWANCE).default(0),
  callBudget: z.number().int().min(1).max(202),
  providerKey: z.enum(TITLE_WRITING_STORED_PROVIDER_KEYS),
  model: z.string().regex(MODEL_ID),
  /** The plan revision the card was built on (null before any plan): a newer plan makes the card stale. */
  basePlanRevisionId: z.string().uuid().nullable().default(null),
}).strict();
export type SeriesGrantRequest = z.infer<typeof seriesGrantRequestSchema>;

/** How a grant was authorized; written by the server only. */
export interface SeriesAuthorization {
  mode: "series";
  proof: "site_session" | "operator_token";
  initiatedBy: string;
  executor: "series-writing-engine";
}

export interface SeriesGrantInput {
  schema: typeof SERIES_WRITING_GRANT_SCHEMA;
  seriesId: string;
  scope: SeriesScope;
  normalCalls: number;
  resendAllowance: number;
  callBudget: number;
  providerKey: TitleWritingStoredProviderKey;
  model: string;
  providerAdapter?: typeof DEEPSEEK_PROVIDER_ADAPTER;
  maxOutputTokens: number;
  basePlanRevisionId: string | null;
  authorization: SeriesAuthorization;
}

/** What one job was built on, frozen when the job was created. */
export interface SeriesJobInput {
  schema: typeof SERIES_WRITING_JOB_SCHEMA;
  kind: SeriesJobKind;
  batchNo: number | null;
  firstEpisode: number | null;
  lastEpisode: number | null;
  providerKey: TitleWritingStoredProviderKey;
  model: string;
  providerAdapter?: typeof DEEPSEEK_PROVIDER_ADAPTER;
  maxOutputTokens: number;
  promptVersion: SeriesPromptVersion;
  checksVersion: typeof SERIES_WRITING_CHECKS_VERSION;
  /** The plan revision a batch or final job reads (null for the plan job). */
  planRevisionId: string | null;
  planHash: string | null;
  /** The ledger revision a batch starts from: the previous batch's (null for batch 1: the plan's initial ledger). */
  baseLedgerRevisionId: string | null;
  baseLedgerHash: string | null;
  /** The previous episode's current version when the job was created (null for episode 1). */
  previousEpisode: SeriesVersionRef | null;
  /**
   * The work's story revision the plan was saved as (or adopted) and its content hash, when a batch or final job was
   * created (null for the plan job, or a plan without a story): a story replaced in the workbench stops the job.
   */
  storyRevisionId: string | null;
  storyHash: string | null;
  /** Completed stages taken over from an earlier, stopped job of the same work (no call; their own records kept). */
  reused: Array<{ stageKey: string; fromRunId: string; outputHash: string }>;
}

/** A version of an episode: a model stage of a job, or the workbench's script revision. */
export type SeriesVersionRef =
  | { episodeNo: number; kind: "stage"; runId: string; stageKey: string; hash: string }
  | { episodeNo: number; kind: "script"; scriptRevisionId: string; hash: string };

// ---------------------------------------------------------------------------------------------------------------
// Stage outputs. The zod schemas are the authority; the JSON Schemas below steer providers that enforce one.

const ID_C = z.string().regex(/^C([1-9]|1[0-2])$/);
const ID_L = z.string().regex(/^L([1-9]|10)$/);
const ID_P = z.string().regex(/^P([1-9]|10)$/);
const ID_S = z.string().regex(/^S[1-8]$/);
const ID_F = z.string().regex(/^FS([1-9]|1[0-6])$/);
const ID_K = z.string().regex(/^K([1-9]|1[0-6])$/);

function episodeNumber(episodeCount: number) {
  return z.number().int().min(1).max(episodeCount);
}

export function seriesSettingSchema(episodeCount: number) {
  return z.object({
    schema: z.literal(SERIES_SETTING_SCHEMA),
    title: text(1, 30),
    logline: text(1, 120),
    synopsis: text(1, 500),
    core: z.object({
      protagonistId: ID_C,
      desire: text(1, 80),
      weakness: text(1, 80),
      goal: text(1, 80),
      coreConflict: text(1, 100),
      keyChoices: z.array(z.object({ choice: text(1, 60), consequence: text(1, 60) }).strict()).min(1).max(4),
      failureCost: text(1, 80),
      ending: text(1, 200),
      majorTurns: z.array(z.object({ episodeNo: episodeNumber(episodeCount), turn: text(1, 60) }).strict()).min(1).max(6),
    }).strict(),
    characters: z.array(z.object({
      id: ID_C, name: text(1, 12), identity: text(1, 40), goal: text(1, 50), weakness: text(1, 40), arc: text(1, 60),
      voice: text(1, 30), initialWhereabouts: text(1, 24),
    }).strict()).min(1).max(12),
    relationships: z.array(z.object({ from: ID_C, to: ID_C, relation: text(1, 20), arc: text(1, 50) }).strict()).max(16),
    secrets: z.array(z.object({
      id: ID_S, holderId: ID_C, content: text(1, 50), knownBy: z.array(ID_C).max(12), revealEpisode: episodeNumber(episodeCount).nullable(),
    }).strict()).max(8),
    locations: z.array(z.object({ id: ID_L, name: text(1, 16), intExt: z.enum(["INT", "EXT"]), description: text(1, 50) }).strict()).min(1).max(10),
    props: z.array(z.object({ id: ID_P, name: text(1, 12), initialHolderId: ID_C.nullable(), purpose: text(1, 40) }).strict()).max(10),
  }).strict();
}
export type SeriesSetting = z.infer<ReturnType<typeof seriesSettingSchema>>;

export function seriesArcSchema(episodeCount: number) {
  return z.object({
    schema: z.literal(SERIES_ARC_SCHEMA),
    phases: z.array(z.object({
      phaseNo: z.number().int().min(1).max(6), title: text(1, 16), episodeFrom: episodeNumber(episodeCount), episodeTo: episodeNumber(episodeCount),
      goal: text(1, 50), turningPoint: text(1, 50),
    }).strict()).min(1).max(6),
    foreshadowing: z.array(z.object({
      id: ID_F, content: text(1, 40), plantEpisode: episodeNumber(episodeCount), payoffEpisode: episodeNumber(episodeCount), dependsOn: z.array(ID_F).max(3),
    }).strict()).max(16),
    finale: z.object({ episodeNo: episodeNumber(episodeCount), resolution: text(1, 150) }).strict(),
  }).strict();
}
export type SeriesArc = z.infer<ReturnType<typeof seriesArcSchema>>;

const outlineEpisodeShape = {
  title: text(1, 16),
  goal: text(1, 40),
  obstacle: text(1, 40),
  choice: text(1, 50),
  turn: text(1, 50),
  result: text(1, 40),
  endState: text(1, 40),
  /** What the next episode takes over; for the last episode, the state after the ending. */
  nextHook: text(1, 40),
  characterIds: z.array(ID_C).min(1).max(8),
  locationIds: z.array(ID_L).min(1).max(4),
  plants: z.array(ID_F).max(3),
  payoffs: z.array(ID_F).max(3),
  isFinale: z.boolean(),
};

export function seriesOutlineEpisodeSchema(episodeCount: number) {
  return z.object({ episodeNo: episodeNumber(episodeCount), ...outlineEpisodeShape }).strict();
}
export type SeriesOutlineEpisode = z.infer<ReturnType<typeof seriesOutlineEpisodeSchema>>;

export function seriesOutlineSchema(episodeCount: number, chunkNo: number) {
  const { first, last } = seriesOutlineRange(episodeCount, chunkNo);
  return z.object({
    schema: z.literal(SERIES_OUTLINE_SCHEMA),
    chunkNo: z.literal(chunkNo),
    episodes: z.array(seriesOutlineEpisodeSchema(episodeCount)).length(last - first + 1),
  }).strict();
}
export type SeriesOutline = z.infer<ReturnType<typeof seriesOutlineSchema>>;

/** A frozen plan: one revision of setting, arc and every episode outline, hashed whole. */
export interface SeriesPlanContent {
  schema: typeof SERIES_PLAN_SCHEMA;
  episodeCount: number;
  setting: SeriesSetting;
  arc: SeriesArc;
  outlines: SeriesOutlineEpisode[];
}

export function seriesPlanContentSchema(episodeCount: number) {
  return z.object({
    schema: z.literal(SERIES_PLAN_SCHEMA),
    episodeCount: z.literal(episodeCount),
    setting: seriesSettingSchema(episodeCount),
    arc: seriesArcSchema(episodeCount),
    outlines: z.array(seriesOutlineEpisodeSchema(episodeCount)).length(episodeCount),
  }).strict();
}

const continuitySchema = z.object({
  characters: z.array(z.object({ id: ID_C, whereabouts: text(1, 24), knows: list(3, 36), unaware: list(3, 36) }).strict()).max(12),
  relationships: z.array(z.object({ from: ID_C, to: ID_C, state: text(1, 24) }).strict()).max(6),
  props: z.array(z.object({ id: ID_P, holderId: ID_C.nullable(), state: text(1, 24) }).strict()).max(6),
  conflicts: z.array(z.object({ id: ID_K, content: text(1, 36), status: z.enum(["open", "resolved"]) }).strict()).max(4),
  secrets: z.array(z.object({ id: ID_S, revealedTo: z.array(ID_C).min(1).max(12) }).strict()).max(4),
  foreshadowing: z.array(z.object({ id: ID_F, action: z.enum(["plant", "payoff"]) }).strict()).max(4),
}).strict();
export type SeriesContinuity = z.infer<typeof continuitySchema>;

const episodeSceneSchema = z.object({
  sceneNo: z.number().int().min(1).max(7),
  locationId: ID_L,
  timeOfDay: text(1, 10),
  characterIds: z.array(ID_C).min(1).max(8),
  action: text(1, 200),
  dialogue: z.array(z.object({ characterId: ID_C, line: text(1, 60), delivery: z.string().max(12) }).strict()).max(8),
  sound: z.string().max(40),
  keyVisual: text(1, 60),
  /** Planned seconds of the scene: a writing target, never a measured length. */
  seconds: z.number().int().min(3).max(60),
}).strict();

export function seriesEpisodeSchema(episodeCount: number) {
  return z.object({
    schema: z.literal(SERIES_EPISODE_SCHEMA),
    episodeNo: episodeNumber(episodeCount),
    title: text(1, 16),
    /** The planned length of the episode (the series' target seconds): not a timed read or a cut. */
    plannedSeconds: z.number().int().min(30).max(120),
    /** An independent short summary of this version, written with it: what the final review reads for this episode. */
    summary: text(1, 60),
    scenes: z.array(episodeSceneSchema).min(1).max(7),
    handoffFacts: list(4, 60, 1),
    continuity: continuitySchema,
    ending: z.enum(["continue", "finale"]),
  }).strict();
}
export type SeriesEpisode = z.infer<ReturnType<typeof seriesEpisodeSchema>>;

/** The continuity ledger after an episode: current state, kept by the program from each version's continuity facts. */
export function seriesLedgerSchema(episodeCount: number) {
  return z.object({
    schema: z.literal(SERIES_LEDGER_SCHEMA),
    throughEpisode: z.number().int().min(0).max(episodeCount),
    characters: z.array(z.object({ id: ID_C, whereabouts: text(1, 24), knows: list(3, 36), unaware: list(3, 36) }).strict()).max(12),
    relationships: z.array(z.object({ from: ID_C, to: ID_C, state: text(1, 24) }).strict()).max(16),
    props: z.array(z.object({ id: ID_P, holderId: ID_C.nullable(), state: text(1, 24) }).strict()).max(10),
    secrets: z.array(z.object({ id: ID_S, holderId: ID_C, knownBy: z.array(ID_C).max(12) }).strict()).max(8),
    conflicts: z.array(z.object({
      id: ID_K, content: text(1, 36), status: z.enum(["open", "resolved"]), openedIn: z.number().int().min(1).max(episodeCount),
      resolvedIn: z.number().int().min(1).max(episodeCount).nullable(),
    }).strict()).max(16),
    foreshadowing: z.array(z.object({
      id: ID_F, status: z.enum(["planned", "planted", "paid"]), plantedIn: z.number().int().min(1).max(episodeCount).nullable(),
      paidIn: z.number().int().min(1).max(episodeCount).nullable(),
    }).strict()).max(16),
  }).strict();
}
export type SeriesLedger = z.infer<ReturnType<typeof seriesLedgerSchema>>;

const RATING = z.number().int().min(1).max(5);

export const SERIES_PLAN_REVIEW_DIMENSIONS = ["premise", "conflict", "characters", "arc", "foreshadowing", "continuity", "pacing", "ending"] as const;
export const SERIES_BATCH_REVIEW_DIMENSIONS = ["outlineFit", "knowledge", "props", "foreshadowing", "conflicts", "causality", "characterVoice", "dialogue", "feasibility", "originality"] as const;
export const SERIES_FINAL_REVIEW_DIMENSIONS = ["arcCompletion", "foreshadowingPayoff", "characterArcs", "continuity", "pacing", "ending"] as const;

export const SERIES_DIMENSION_LABELS: Readonly<Record<string, string>> = {
  premise: "全剧故事与主角欲望、弱点是否成立",
  conflict: "核心冲突与失败代价是否清楚",
  characters: "人物、关系、秘密与知情边界是否一致",
  arc: "分幕推进与主要转折是否连贯",
  foreshadowing: "伏笔埋设、兑现与依赖是否合理",
  continuity: "前后状态、人物位置、道具与因果是否一致",
  pacing: "节奏是否注水或重复",
  ending: "结局只在最后一集完成且兑现主线",
  outlineFit: "正文是否按细纲完成本集目标、转折与结果",
  knowledge: "人物是否只知道他应当知道的信息",
  props: "道具归属与交接是否连贯",
  conflicts: "未解决冲突是否被延续或合理解决",
  causality: "时间先后与关键因果是否一致",
  characterVoice: "人物说话方式是否稳定",
  dialogue: "台词是否自然",
  feasibility: "场面在计划篇幅内是否可执行",
  originality: "是否重复、注水或照搬",
  arcCompletion: "全剧分幕是否走完",
  foreshadowingPayoff: "伏笔是否全部兑现",
  characterArcs: "人物弧线是否完成",
};

function reviewSchemaOf<const D extends readonly [string, ...string[]]>(schema: string, dimensions: D, target: RegExp) {
  return z.object({
    schema: z.literal(schema),
    verdict: z.enum(["pass", "revise"]),
    dimensions: z.array(z.object({ key: z.enum(dimensions), assessment: text(1, 120), internalScore: RATING }).strict()).length(dimensions.length),
    issues: z.array(z.object({
      id: z.string().regex(/^R([1-9]|10)$/),
      dimension: z.enum(dimensions),
      severity: z.enum(["high", "medium", "low"]),
      target: z.string().regex(target),
      /** A verbatim quote of the target's text. Issues whose quote is not found are kept but never block. */
      evidence: text(1, 120),
      problem: text(1, 150),
      suggestion: text(1, 150),
    }).strict()).max(10),
  }).strict();
}

export const SERIES_PLAN_REVIEW_TARGET = /^(setting|arc|outline:([1-9]|[1-5][0-9]|60))$/;
export const SERIES_BATCH_REVIEW_TARGET = /^(episode:([1-9]|[1-5][0-9]|60)|ledger)$/;
export const SERIES_FINAL_REVIEW_TARGET = /^(setting|arc|ledger|summary:([1-9]|[1-5][0-9]|60))$/;

export const seriesPlanReviewSchema = reviewSchemaOf(SERIES_PLAN_REVIEW_SCHEMA, SERIES_PLAN_REVIEW_DIMENSIONS, SERIES_PLAN_REVIEW_TARGET);
export const seriesBatchReviewSchema = reviewSchemaOf(SERIES_BATCH_REVIEW_SCHEMA, SERIES_BATCH_REVIEW_DIMENSIONS, SERIES_BATCH_REVIEW_TARGET);
export const seriesFinalReviewSchema = reviewSchemaOf(SERIES_FINAL_REVIEW_SCHEMA, SERIES_FINAL_REVIEW_DIMENSIONS, SERIES_FINAL_REVIEW_TARGET);
export type SeriesModelReview = z.infer<typeof seriesPlanReviewSchema> | z.infer<typeof seriesBatchReviewSchema> | z.infer<typeof seriesFinalReviewSchema>;

/** A finding of the code's own checks (not a model). */
export interface SeriesCheckFinding {
  id: string;
  check: string;
  target: string;
  severity: "high" | "medium";
  detail: string;
}

export interface SeriesReviewIssue {
  id: string;
  dimension: string;
  severity: "high" | "medium" | "low";
  target: string;
  evidence: string;
  problem: string;
  suggestion: string;
  /** The quote was found whole in one text field of the target. Unverified issues are shown but never block. */
  evidenceVerified: boolean;
}

/**
 * A review stage's stored output: the model's review with checked evidence and the code's findings. passed is the code's
 * decision (no high finding, no verified high issue) and is never a person's approval. reviewed names every text the
 * review read with its hash, so a later edit makes it a review of an earlier version: a batch review reads plan, story,
 * baseLedger (the ledger before its first episode) and each episode:N; the final review plan, story, ledger (after the
 * last episode), each summary:N version and each batch:N review.
 */
export interface SeriesReviewOutput {
  schema: typeof SERIES_PLAN_REVIEW_SCHEMA | typeof SERIES_BATCH_REVIEW_SCHEMA | typeof SERIES_FINAL_REVIEW_SCHEMA;
  checksVersion: typeof SERIES_WRITING_CHECKS_VERSION;
  scope: "plan" | "batch" | "final";
  /** "各批全文检查" for a batch review; "全剧结构与连续性总检" for the final review (it read no episode text). */
  readsFullText: boolean;
  verdict: "pass" | "revise";
  dimensions: Array<{ key: string; assessment: string; internalScore: number }>;
  issues: SeriesReviewIssue[];
  deterministic: SeriesCheckFinding[];
  reviewed: Record<string, string>;
  passed: boolean;
}

export type SeriesStageOutput = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------------------------
// Provider JSON Schemas (strict-mode keywords only), built from the same limits as the zod schemas.

function str(maxLength: number) {
  return { type: "string", maxLength } as const;
}
function obj(properties: Record<string, unknown>) {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties } as const;
}
function arr(items: unknown, minItems: number, maxItems: number) {
  return { type: "array", minItems, maxItems, items } as const;
}
const strs = (maxItems: number, maxChars: number, minItems = 0) => arr(str(maxChars), minItems, maxItems);
const int = (minimum: number, maximum: number) => ({ type: "integer", minimum, maximum }) as const;
const enumOf = (values: readonly (string | number | boolean)[]) =>
  ({ type: typeof values[0] === "number" ? "integer" : typeof values[0] === "boolean" ? "boolean" : "string", enum: [...values] }) as const;
const nullableStr = (maxLength: number) => ({ type: ["string", "null"], maxLength }) as const;
const nullableInt = (minimum: number, maximum: number) => ({ type: ["integer", "null"], minimum, maximum }) as const;

function reviewJsonSchema(schema: string, dimensions: readonly string[]) {
  return obj({
    schema: enumOf([schema]),
    verdict: enumOf(["pass", "revise"]),
    dimensions: arr(obj({ key: enumOf(dimensions), assessment: str(120), internalScore: int(1, 5) }), dimensions.length, dimensions.length),
    issues: arr(obj({ id: str(3), dimension: enumOf(dimensions), severity: enumOf(["high", "medium", "low"]), target: str(14),
      evidence: str(120), problem: str(150), suggestion: str(150) }), 0, 10),
  });
}

/** The JSON Schema sent with a series stage (research and directions use the automatic creation schemas). */
export function seriesJsonSchema(stageKey: string, episodeCount: number): { name: string; schema: Record<string, unknown> } {
  const kind = seriesStageKind(stageKey);
  const episodeNo = int(1, episodeCount);
  switch (kind) {
    case "setting":
      return { name: "series_setting", schema: obj({
        schema: enumOf([SERIES_SETTING_SCHEMA]), title: str(30), logline: str(120), synopsis: str(500),
        core: obj({
          protagonistId: str(3), desire: str(80), weakness: str(80), goal: str(80), coreConflict: str(100),
          keyChoices: arr(obj({ choice: str(60), consequence: str(60) }), 1, 4), failureCost: str(80), ending: str(200),
          majorTurns: arr(obj({ episodeNo, turn: str(60) }), 1, 6),
        }),
        characters: arr(obj({ id: str(3), name: str(12), identity: str(40), goal: str(50), weakness: str(40), arc: str(60), voice: str(30),
          initialWhereabouts: str(24) }), 1, 12),
        relationships: arr(obj({ from: str(3), to: str(3), relation: str(20), arc: str(50) }), 0, 16),
        secrets: arr(obj({ id: str(2), holderId: str(3), content: str(50), knownBy: strs(12, 3), revealEpisode: nullableInt(1, episodeCount) }), 0, 8),
        locations: arr(obj({ id: str(3), name: str(16), intExt: enumOf(["INT", "EXT"]), description: str(50) }), 1, 10),
        props: arr(obj({ id: str(3), name: str(12), initialHolderId: nullableStr(3), purpose: str(40) }), 0, 10),
      }) };
    case "arc":
      return { name: "series_arc", schema: obj({
        schema: enumOf([SERIES_ARC_SCHEMA]),
        phases: arr(obj({ phaseNo: int(1, 6), title: str(16), episodeFrom: episodeNo, episodeTo: episodeNo, goal: str(50), turningPoint: str(50) }), 1, 6),
        foreshadowing: arr(obj({ id: str(4), content: str(40), plantEpisode: episodeNo, payoffEpisode: episodeNo, dependsOn: strs(3, 4) }), 0, 16),
        finale: obj({ episodeNo, resolution: str(150) }),
      }) };
    case "outline": {
      const chunkNo = seriesStageChunkNo(stageKey)!;
      const { first, last } = seriesOutlineRange(episodeCount, chunkNo);
      const numbers = Array.from({ length: last - first + 1 }, (_, index) => first + index);
      return { name: "series_outline", schema: obj({
        schema: enumOf([SERIES_OUTLINE_SCHEMA]),
        chunkNo: enumOf([chunkNo]),
        episodes: arr(obj({
          episodeNo: enumOf(numbers), title: str(16), goal: str(40), obstacle: str(40), choice: str(50), turn: str(50), result: str(40),
          endState: str(40), nextHook: str(40), characterIds: strs(8, 3, 1), locationIds: strs(4, 3, 1), plants: strs(3, 4), payoffs: strs(3, 4),
          isFinale: { type: "boolean" },
        }), numbers.length, numbers.length),
      }) };
    }
    case "episode": {
      const number = seriesStageEpisodeNo(stageKey)!;
      return { name: "series_episode", schema: obj({
        schema: enumOf([SERIES_EPISODE_SCHEMA]), episodeNo: enumOf([number]), title: str(16), plannedSeconds: int(30, 120), summary: str(60),
        scenes: arr(obj({
          sceneNo: int(1, 7), locationId: str(3), timeOfDay: str(10), characterIds: strs(8, 3, 1), action: str(200),
          dialogue: arr(obj({ characterId: str(3), line: str(60), delivery: str(12) }), 0, 8), sound: str(40), keyVisual: str(60), seconds: int(3, 60),
        }), 1, 7),
        handoffFacts: strs(4, 60, 1),
        continuity: obj({
          characters: arr(obj({ id: str(3), whereabouts: str(24), knows: strs(3, 36), unaware: strs(3, 36) }), 0, 12),
          relationships: arr(obj({ from: str(3), to: str(3), state: str(24) }), 0, 6),
          props: arr(obj({ id: str(3), holderId: nullableStr(3), state: str(24) }), 0, 6),
          conflicts: arr(obj({ id: str(3), content: str(36), status: enumOf(["open", "resolved"]) }), 0, 4),
          secrets: arr(obj({ id: str(2), revealedTo: strs(12, 3, 1) }), 0, 4),
          foreshadowing: arr(obj({ id: str(4), action: enumOf(["plant", "payoff"]) }), 0, 4),
        }),
        ending: enumOf(["continue", "finale"]),
      }) };
    }
    case "plan_review":
      return { name: "series_plan_review", schema: reviewJsonSchema(SERIES_PLAN_REVIEW_SCHEMA, SERIES_PLAN_REVIEW_DIMENSIONS) };
    case "batch_review":
      return { name: "series_batch_review", schema: reviewJsonSchema(SERIES_BATCH_REVIEW_SCHEMA, SERIES_BATCH_REVIEW_DIMENSIONS) };
    case "final_review":
      return { name: "series_final_review", schema: reviewJsonSchema(SERIES_FINAL_REVIEW_SCHEMA, SERIES_FINAL_REVIEW_DIMENSIONS) };
    default:
      throw new Error(`no series schema for ${kind}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Storage records.

export type SeriesStageState = "pending" | "reserved" | "submitted" | "completed" | "rejected" | "unknown" | "canceled";
export type SeriesRunState = "running" | "completed" | "partial" | "needs_attention" | "canceled" | "failed";
export type SeriesGrantState = "running" | "completed" | "stopped" | "canceled";
export type SeriesScriptSave = "pending" | "saved" | "conflict";

export interface SeriesRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  actorId: string;
  idempotencyKey: string;
  inputHash: string;
  input: SeriesFrozenInput;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface SeriesGrantRecord {
  id: string;
  seriesId: string;
  workspaceId: string;
  projectId: string;
  actorId: string;
  idempotencyKey: string;
  requestHash: string;
  input: SeriesGrantInput;
  callBudget: number;
  callsUsed: number;
  state: SeriesGrantState;
  stopReason: string | null;
  cancelRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SeriesJobRecord {
  id: string;
  /** 1, 2, … in creation order within the series: the order jobs are read in (timestamps may tie). */
  seq: number;
  seriesId: string;
  grantId: string;
  workspaceId: string;
  projectId: string;
  kind: SeriesJobKind;
  batchNo: number | null;
  input: SeriesJobInput;
  inputHash: string;
  state: SeriesRunState;
  errorCode: string | null;
  cancelRequestedAt: string | null;
  executorId: string | null;
  leaseUntil: string | null;
  callCap: number;
  callsUsed: number;
  createdAt: string;
  updatedAt: string;
}

export interface SeriesStageRecord {
  runId: string;
  stageKey: string;
  ordinal: number;
  state: SeriesStageState;
  attemptNo: number;
  errorCode: string | null;
  output: SeriesStageOutput | null;
  outputHash: string | null;
  dependsOn: Record<string, string> | null;
  /** The job this completed stage was taken over from (no call made here), else null. */
  reusedFrom: string | null;
  scriptSave: SeriesScriptSave | null;
  scriptRevisionId: string | null;
  updatedAt: string;
}

export interface SeriesCallRecord {
  id: string;
  runId: string;
  grantId: string;
  seriesId: string;
  workspaceId: string;
  stageKey: string;
  attemptNo: number;
  providerKey: TitleWritingProviderKey;
  model: string;
  requestHash: string;
  state: TitleWritingCallState;
  executorId: string;
  providerRequestId: string | null;
  responseModel: string | null;
  usage: TitleWritingUsageView;
  errorCode: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface SeriesPlanRevisionRecord {
  id: string;
  seriesId: string;
  revisionNo: number;
  origin: "model" | "manual";
  sourceRunId: string | null;
  parentRevisionId: string | null;
  content: SeriesPlanContent;
  contentHash: string;
  /** The plan review the model wrote for this revision (model origin only), else null. */
  review: SeriesReviewOutput | null;
  /**
   * The work's story revision this plan revision is bound to: saved with it (a model plan, or a person's plan saved as a
   * new story DRAFT) or a person's adoption of the workbench's current story. Null when none was saved.
   */
  storyRevisionId: string | null;
  /** That story revision's content hash (read with it; the revision itself never changes). */
  storyHash: string | null;
  storySave: "pending" | "saved" | "conflict";
  createdBy: string;
  createdAt: string;
}

export interface SeriesLedgerBasis {
  planRevisionId: string;
  planHash: string;
  /** The ledger this one continues (the previous batch's), null for batch 1 (the plan's initial ledger). */
  baseLedgerRevisionId: string | null;
  baseLedgerHash: string | null;
  /** The story revision the plan was bound to (and its hash) when this ledger was made. */
  storyRevisionId: string | null;
  storyHash: string | null;
  episodes: SeriesVersionRef[];
}

export interface SeriesLedgerRevisionRecord {
  id: string;
  seriesId: string;
  batchNo: number;
  revisionNo: number;
  /** program: merged from the episodes' continuity facts; manual: written and confirmed by a person. */
  origin: "program" | "manual";
  content: SeriesLedger;
  contentHash: string;
  /** Each episode's short summary, bound to the version it describes (a person writes it again for an edited episode). */
  summaries: Array<{ episodeNo: number; summary: string; versionHash: string }>;
  basis: SeriesLedgerBasis;
  createdBy: string;
  createdAt: string;
}

/** A person's decision on a machine finding or an upstream change, bound to the exact versions it was made on. */
export interface SeriesDecisionRecord {
  id: string;
  seriesId: string;
  target: string;
  /**
   * Hashes of everything the decision covers, as the person's page showed them (the server refuses any other): plan:
   * plan and story; a batch: plan, story, the ledger before the batch (baseLedger), each episode version and the ledger
   * after it; final: plan, story, the last ledger and each episode version its summary describes.
   */
  basis: Record<string, string>;
  note: string;
  createdBy: string;
  createdAt: string;
}

export interface SeriesFormalEpisode {
  episodeNo: number;
  episodeId: string;
  rowVersion: number;
  currentScriptRevisionId: string | null;
  approvedScriptRevisionId: string | null;
}

/** A story revision of the work, as the workbench stores it. */
export interface SeriesStoryRevision {
  id: string;
  text: string;
  contentHash: string;
  reviewStatus: "DRAFT" | "IN_REVIEW" | "APPROVED" | "REJECTED";
  freshnessStatus: "CURRENT" | "STALE";
  createdBy: string;
  createdAt: string;
}

export interface SeriesScriptRevision {
  id: string;
  episodeNo: number;
  text: string;
  contentHash: string;
  reviewStatus: "DRAFT" | "IN_REVIEW" | "APPROVED" | "REJECTED";
  freshnessStatus: "CURRENT" | "STALE";
  sourceStoryRevisionId: string;
  createdBy: string;
  createdAt: string;
}

/** Everything the series state is computed from: read in one transaction (or one in-memory step). */
export interface SeriesSnapshot {
  series: SeriesRecord;
  project: {
    episodeCount: number;
    writingMode: "short" | "series";
    currentStoryRevisionId: string | null;
    approvedStoryRevisionId: string | null;
    approvedStoryCurrent: boolean;
    /** The work's current story and its approved one (the same revision when approved is current), with their text. */
    currentStory: SeriesStoryRevision | null;
    approvedStory: SeriesStoryRevision | null;
  };
  episodes: SeriesFormalEpisode[];
  scripts: SeriesScriptRevision[];
  plans: SeriesPlanRevisionRecord[];
  ledgers: SeriesLedgerRevisionRecord[];
  decisions: SeriesDecisionRecord[];
  grants: SeriesGrantRecord[];
  jobs: Array<{ run: SeriesJobRecord; stages: SeriesStageRecord[]; calls: SeriesCallRecord[] }>;
}

export interface SeriesJobBundle {
  run: SeriesJobRecord;
  stages: SeriesStageRecord[];
  calls: SeriesCallRecord[];
}

/** A job to create: its record and stages (some may be taken over, already completed). */
export interface SeriesJobPlan {
  run: SeriesJobRecord;
  stages: Array<{ stageKey: string; reused: { output: SeriesStageOutput; outputHash: string; dependsOn: Record<string, string>; fromRunId: string } | null }>;
}

export type SeriesAdmission =
  | { kind: "job"; job: SeriesJobPlan; requiredCalls: number }
  | { kind: "refused"; code: string; details?: Record<string, unknown> };

export type SeriesGrantCreation =
  | { kind: "created"; grant: SeriesGrantRecord; jobId: string }
  | { kind: "existing"; grant: SeriesGrantRecord }
  | { kind: "conflict" }
  | { kind: "refused"; code: string; details?: Record<string, unknown> }
  | { kind: "active"; runKind: "series" | "auto" | "title"; runId: string }
  | { kind: "blocked"; code: "SERIES_ACTIVE_RUN_CAP" }
  | { kind: "daily_quota_low"; requiredCalls: number; remainingCalls: number };

export type SeriesCallReservation = { kind: "reserved" } | { kind: "lost" } | { kind: "canceled" } | { kind: "blocked"; code: string }
  /** What the job was frozen on changed (seriesJobUpstreamChange, read under the lock): nothing reserved, nothing counted. */
  | { kind: "upstream"; code: string };

/**
 * The send admission: submitted (the commit of this transition is the point after which a person's save counts as a
 * change after the send), canceled, lost, or upstream (closed as never sent and given back: the job's frozen
 * dependencies changed before this point).
 */
export type SeriesCallSubmission = "submitted" | "canceled" | "lost" | { upstream: string };

export interface SeriesCallFinish {
  state: "completed" | "rejected" | "unknown";
  errorCode: string | null;
  output: SeriesStageOutput | null;
  outputHash: string | null;
  dependsOn: Record<string, string> | null;
  providerRequestId: string | null;
  responseModel: string | null;
  usage: TitleWritingUsageView;
}

/** What a finished job leaves: a plan revision (plan), a ledger revision (batch), nothing more (final). */
export type SeriesJobArtifacts =
  | { kind: "plan"; plan: Omit<SeriesPlanRevisionRecord, "storyRevisionId" | "storyHash" | "storySave">; storyText: string | null }
  | { kind: "batch"; ledger: SeriesLedgerRevisionRecord }
  | { kind: "final" };

export type SeriesNextStep =
  | { kind: "job"; jobId: string }
  | { kind: "grant_completed" }
  | { kind: "grant_stopped"; reason: string }
  | { kind: "lost" };

export type SeriesResumePreparation =
  | { kind: "ok"; jobId: string }
  | { kind: "replayed"; grant: SeriesGrantRecord }
  | { kind: "key_conflict" }
  | { kind: "not_found" }
  | { kind: "active" }
  | { kind: "active_cap" }
  | { kind: "needs_confirmation" }
  | { kind: "stale_confirmation" }
  | { kind: "not_resumable" }
  | { kind: "budget_exhausted" }
  | { kind: "provider_unconfigured" }
  | { kind: "refused"; code: string; details?: Record<string, unknown> }
  | { kind: "daily_quota_low"; requiredCalls: number; remainingCalls: number };

export type SeriesPlacement =
  | { kind: "ok"; placed: number; conflicts: number[] }
  | { kind: "not_found" }
  | { kind: "not_ready"; reason: string }
  | { kind: "story_not_saved" }
  | { kind: "story_not_approved" }
  | { kind: "story_changed" }
  | { kind: "plan_mismatch" };

/**
 * What a placement may write, read from the state under the store's lock: each episode stage of the batch's completed
 * job not handled yet (written or recorded as a conflict), formatted with the plan revision that job was frozen on; or
 * why nothing may be written now (the batch's plan, ledger or review dependencies are not current).
 */
export type SeriesPlacementCandidates =
  | { kind: "ok"; scripts: Array<{ episodeNo: number; runId: string; stageKey: string; text: string }> }
  | { kind: "blocked"; reason: string };

/** How a person's plan revision is bound to the work's story: a new story DRAFT written from it, or the current story adopted. */
export type SeriesPlanStory = { mode: "from_plan"; text: string } | { mode: "adopt_current" };

export interface SeriesLimits {
  sinceIso: string;
  maxCallsPerDay: number;
  maxActiveRuns: number;
}

export interface SeriesWritingStore {
  storageReady(): Promise<boolean>;
  providerStorageReady(providerKey: TitleWritingProviderKey): Promise<boolean>;
  /** Creates the project (series mode, N episodes) and its series in one transaction; a replayed key returns them. */
  createSeries(series: SeriesRecord, project: { title: string; premise: string }): Promise<{ kind: "created" | "existing"; series: SeriesRecord } | { kind: "conflict" } | { kind: "plan_unavailable" }>;
  findSeriesByKey(workspaceId: string, actorId: string, idempotencyKey: string): Promise<SeriesRecord | null>;
  snapshot(workspaceId: string, projectId: string): Promise<SeriesSnapshot | null>;
  findGrantByKey(workspaceId: string, actorId: string, idempotencyKey: string): Promise<SeriesGrantRecord | null>;
  /**
   * Creates a grant and its first job atomically: under the workspace run lock it reads the snapshot, asks admit() for
   * the first job (or a refusal), checks the concurrency cap and the daily admission of that one job, then inserts.
   */
  createGrant(grant: SeriesGrantRecord, limits: SeriesLimits, admit: (snapshot: SeriesSnapshot) => SeriesAdmission): Promise<SeriesGrantCreation>;
  getJob(workspaceId: string, jobId: string): Promise<SeriesJobBundle | null>;
  claimJob(workspaceId: string, jobId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<boolean>;
  completeLocalStage(workspaceId: string, jobId: string, executorId: string, stageKey: string, output: SeriesStageOutput, outputHash: string, nowIso: string): Promise<boolean>;
  /**
   * Reserves one send against the job's cap, the grant's budget and the shared daily cap, under the workspace call lock,
   * only while the job's frozen dependencies are still current (read again under the work's row lock).
   */
  reserveCall(call: SeriesCallRecord, limits: { sinceIso: string; maxCallsPerDay: number }, nowIso: string, leaseUntil: string): Promise<SeriesCallReservation>;
  /** The last check before the send, under the same locks: a changed dependency closes the reservation as never sent. */
  markCallSubmitted(workspaceId: string, callId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<SeriesCallSubmission>;
  finishCall(workspaceId: string, callId: string, executorId: string, patch: SeriesCallFinish, nowIso: string): Promise<boolean>;
  /** Stops a job (and its grant) without completing it. */
  finishJob(workspaceId: string, jobId: string, executorId: string, state: Exclude<SeriesRunState, "running" | "completed">, errorCode: string | null, nowIso: string): Promise<boolean>;
  /**
   * Completes a job with its artifacts and moves its grant on in the same transaction: next() reads the snapshot after
   * the artifacts and returns the next job, or the grant's end; the daily admission of the next job is checked here.
   */
  completeJob(workspaceId: string, jobId: string, executorId: string, artifacts: SeriesJobArtifacts, limits: SeriesLimits, nowIso: string, leaseUntil: string,
    next: (snapshot: SeriesSnapshot) => SeriesAdmission | { kind: "done" }): Promise<SeriesNextStep>;
  requestCancel(workspaceId: string, projectId: string, grantId: string, nowIso: string): Promise<SeriesGrantRecord | null>;
  prepareResume(workspaceId: string, projectId: string, grantId: string, request: { resumeKey: string; requestHash: string; confirmedCallIds: readonly string[];
    providerReady: boolean; limits: SeriesLimits }, nowIso: string, next: (snapshot: SeriesSnapshot) => SeriesAdmission | { kind: "done" }): Promise<SeriesResumePreparation>;
  recoverExpired(workspaceId: string, nowIso: string): Promise<number>;
  listClaimable(workspaceId: string, nowIso: string, limit: number): Promise<string[]>;
  /**
   * A person's plan edit: a new revision bound to the work's story in the same transaction (a new story DRAFT written
   * from it, or the current story adopted), only while the plan and the work's current story are still the ones the
   * person's page showed (else conflict / story_conflict, nothing written). Earlier revisions and stories stay.
   */
  savePlanRevision(workspaceId: string, projectId: string, revision: SeriesPlanRevisionRecord, expected: { parentId: string | null; storyRevisionId: string | null },
    story: SeriesPlanStory): Promise<"saved" | "conflict" | "story_conflict" | "not_found" | "active">;
  /**
   * A person's ledger confirmation: a new revision bound to the versions it was confirmed on. Saved only while the
   * latest ledger of the batch is expectedParentId (else conflict) and current(snapshot) - the edit basis read in the
   * same transaction under the series lock - is exactly expectedBasis, what the person's editor was opened on (else
   * stale; null: blocked). Nothing is written otherwise.
   */
  saveLedgerRevision(workspaceId: string, projectId: string, revision: SeriesLedgerRevisionRecord, expectedParentId: string | null,
    current: (snapshot: SeriesSnapshot) => Record<string, string> | null, expectedBasis: Record<string, string>):
    Promise<"saved" | "conflict" | "stale" | "blocked" | "not_found" | "active">;
  /**
   * A person's decision, recorded only when current(snapshot) - the basis read in the same transaction under the series
   * lock - is exactly the decision's basis (the versions the person's page showed): else conflict, nothing written.
   */
  saveDecision(workspaceId: string, projectId: string, decision: SeriesDecisionRecord, current: (snapshot: SeriesSnapshot) => Record<string, string> | null):
    Promise<"saved" | "conflict" | "not_ready" | "not_found" | "active">;
  /**
   * Places a batch's model stages into the work's episodes as DRAFT scripts, sourced from the plan's own story, which
   * must be the work's approved and current story. The candidates are computed from the state read under the lock (the
   * dependencies checked again there); an episode that already has a script is recorded as a conflict, never overwritten.
   */
  placeBatch(workspaceId: string, projectId: string, batchNo: number, candidates: (snapshot: SeriesSnapshot) => SeriesPlacementCandidates,
    actorId: string, nowIso: string): Promise<SeriesPlacement>;
}

// ---------------------------------------------------------------------------------------------------------------
// Views and bodies.

export const seriesResumeSchema = z.object({
  confirmUncertainCallIds: z.array(z.string().uuid()).max(20).default([]),
}).strict();

/** Placement takes nothing from the page: the story it writes from is the plan's own, which must be approved and current. */
export const seriesPlaceSchema = z.object({}).strict();

const BASIS_KEY = /^(plan|story|baseLedger|ledger|episode:([1-9]|[1-5][0-9]|60)|summary:([1-9]|[1-5][0-9]|60))$/;

export const seriesDecisionSchema = z.object({
  target: z.string().regex(/^(plan|batch:([1-9]|1[0-9]|20)|final)$/),
  note: z.string().trim().min(1).max(300),
  /** What the person's page showed (the view's decisionBasis): the server records the decision only on exactly these versions. */
  expectedBasis: z.record(z.string().regex(BASIS_KEY), z.string().regex(/^([0-9a-f]{64}|none)$/))
    .refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 64, "复核依据无效"),
}).strict();

export function seriesPlanEditSchema(episodeCount: number) {
  return z.object({
    basePlanRevisionId: z.string().uuid(),
    /** The work's current story the page showed (null: none): a story saved since is a conflict, never overwritten. */
    baseStoryRevisionId: z.string().uuid().nullable(),
    /** from_plan: save a new story DRAFT from this plan (it needs a person's review); adopt_current: bind the page's current story. */
    story: z.enum(["from_plan", "adopt_current"]).default("from_plan"),
    content: seriesPlanContentSchema(episodeCount),
  }).strict();
}

export function seriesLedgerEditSchema(episodeCount: number) {
  return z.object({
    batchNo: z.number().int().min(1).max(20),
    baseLedgerRevisionId: z.string().uuid().nullable(),
    content: seriesLedgerSchema(episodeCount),
    /** One summary per episode of the batch, for the version it is confirmed on. */
    summaries: z.array(z.object({ episodeNo: z.number().int().min(1).max(episodeCount), summary: text(1, 60) }).strict()).min(1).max(SERIES_BATCH_SIZE),
    /** The ledgerBasis the page froze when it opened the editor: plan, story, ledgers and each episode's version. */
    expectedBasis: z.record(z.string().regex(/^[A-Za-z]+(:([1-9]|[1-5][0-9]|60))?$/), z.string().regex(/^[A-Za-z0-9:_-]{1,200}$/))
      .refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 16, "台账依据无效"),
  }).strict();
}

/** Text completion levels of a series, apart from people's review and from any reading, timing or media. */
export type SeriesCompletion = "not_started" | "planned" | "partial" | "text_complete" | "approved_complete";
