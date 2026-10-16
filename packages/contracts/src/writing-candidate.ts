import { z } from "zod";
import {
  EPISODE_DRAFT_SCHEMA,
  STORY_PLAN_SCHEMA,
  WRITING_BODY_MAX_CHARS,
  WRITING_NOTE_MAX_CHARS,
  type EpisodeDraftCandidate,
  type StoryPlanCandidate,
} from "./writing-assistant";
import {
  TITLE_WRITING_PROVIDER_KEYS,
  type TitleWritingProviderKey,
  type TitleWritingProviderOption,
  type TitleWritingUsageView,
} from "./title-writing";

/**
 * Online candidates of the workbench writing assistant (docs/OPENAI_CLAUDE_WRITING.md, "工作台在线候选"). One request is
 * one provider call for one target: the story of a three-episode work, or the script of one of its episodes 1–3. The
 * answer is only a candidate: it is shown, compared and adopted into the editor draft by the person, and saved only by
 * the editor's own "保存新版本". Nothing here writes a story or script revision.
 */
export const WRITING_CANDIDATE_INPUT_SCHEMA = "ads.writing-candidate.input.v1" as const;

function note() {
  return z.string().max(WRITING_NOTE_MAX_CHARS).refine((value) => !value.includes("\u0000"), "文本含有空字符");
}
function body() {
  return z.string().max(WRITING_BODY_MAX_CHARS).refine((value) => !value.includes("\u0000"), "文本含有空字符");
}

/** The story request of the assistant (domain StoryPlanRequest), plus an optional revision request. */
export const writingCandidateStoryRequestSchema = z.object({
  premise: note(),
  genre: note(),
  audience: note(),
  characters: note(),
  mustKeep: note(),
  mustNotChange: note(),
  revisionRequest: note().optional(),
  currentText: body(),
}).strict();

/** The episode request of the assistant (domain EpisodeDraftRequest). */
export const writingCandidateEpisodeRequestSchema = z.object({
  episodeNo: z.number().int().min(1).max(3),
  premise: note(),
  genre: note(),
  audience: note(),
  characters: note(),
  confirmedStory: body(),
  currentText: body(),
  revisionRequest: note(),
  mustKeep: note(),
  mustKeepDialogue: note(),
  mustKeepEnding: note(),
}).strict();

/** What the editor was based on when the person asked: the revision shown and the If-Match baseline of the draft. */
const baseSchema = z.object({
  sourceRevisionId: z.string().uuid().nullable(),
  ifMatch: z.number().int().min(1).max(2_147_483_647),
}).strict();

const common = {
  providerKey: z.enum(TITLE_WRITING_PROVIDER_KEYS).optional(),
  model: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
  base: baseSchema,
  /**
   * The id of the latest request for this target whose result is unknown, when there is one. A new request is only
   * accepted after the person saw that the earlier one may have been charged; it is never sent on its own.
   */
  confirmUncertainRequestId: z.string().uuid().optional(),
};

export const writingCandidateStartSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("story"), ...common, request: writingCandidateStoryRequestSchema }).strict(),
  z.object({ mode: z.literal("episode"), episodeId: z.string().uuid(), ...common, request: writingCandidateEpisodeRequestSchema }).strict(),
]);
export type WritingCandidateStart = z.infer<typeof writingCandidateStartSchema>;
export type WritingCandidateStoryRequest = z.infer<typeof writingCandidateStoryRequestSchema>;
export type WritingCandidateEpisodeRequest = z.infer<typeof writingCandidateEpisodeRequestSchema>;
export type WritingCandidateMode = "story" | "episode";

/** Frozen with the request; the request hash covers every field, so a reused key with another input is refused. */
export interface WritingCandidateFrozenInput {
  schema: typeof WRITING_CANDIDATE_INPUT_SCHEMA;
  promptVersion: string;
  projectId: string;
  mode: WritingCandidateMode;
  episodeId: string | null;
  episodeNo: number | null;
  providerKey: TitleWritingProviderKey;
  model: string;
  base: { sourceRevisionId: string | null; ifMatch: number };
  request: WritingCandidateStoryRequest | WritingCandidateEpisodeRequest;
}

/**
 * reserved: written, not sent. submitted: being sent. completed: answered and validated. rejected: no usable answer
 * (the provider refused, cut it off or answered something invalid, or it was never sent). unknown: the provider may
 * have processed and charged it; it is never resent.
 */
export type WritingCandidateState = "reserved" | "submitted" | "completed" | "rejected" | "unknown";

export type WritingCandidateOutput =
  | { mode: "story"; plan: StoryPlanCandidate }
  | { mode: "episode"; draft: EpisodeDraftCandidate };

export interface WritingCandidateRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  actorId: string;
  idempotencyKey: string;
  requestHash: string;
  input: WritingCandidateFrozenInput;
  state: WritingCandidateState;
  executorId: string | null;
  leaseUntil: string | null;
  errorCode: string | null;
  providerRequestId: string | null;
  responseModel: string | null;
  usage: TitleWritingUsageView;
  candidate: WritingCandidateOutput | null;
  confirmedRequestId: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export type WritingCandidateCreation =
  | { kind: "created"; record: WritingCandidateRecord }
  /** The same key and the same input: the stored request, whatever its state; nothing new is written or sent. */
  | { kind: "existing"; record: WritingCandidateRecord }
  /** The same key with another input. */
  | { kind: "conflict" }
  /** Another request for this target is still being written or sent. */
  | { kind: "active"; requestId: string }
  /** The target's latest request has an unknown result that this request did not name. */
  | { kind: "needs_confirmation"; requestId: string }
  /** The target does not exist, belongs to another work, or the base revision is not the target's. */
  | { kind: "target_invalid"; reason: "episode" | "base_revision" | "episode_plan" }
  | { kind: "blocked"; code: "WRITING_CANDIDATE_DAILY_CAP" };

export interface WritingCandidateFinish {
  state: "completed" | "rejected" | "unknown";
  errorCode: string | null;
  providerRequestId: string | null;
  responseModel: string | null;
  usage: TitleWritingUsageView;
  candidate: WritingCandidateOutput | null;
}

/** Storage of online candidates, shared by the executor (providers) and the PostgreSQL store (database). */
export interface WritingCandidateStore {
  storageReady(): Promise<boolean>;
  /**
   * Looks the key up first (a replay returns the stored request whatever the limits are now). A new request checks
   * the target, the open request of the target, an unknown result to be confirmed and the shared rolling 24 h call cap,
   * and is written as reserved under the given executor and lease, all in one transaction.
   */
  create(record: WritingCandidateRecord, limits: { sinceIso: string; maxCallsPerDay: number }): Promise<WritingCandidateCreation>;
  /** The request a key already names, for answering a replay before anything about providers is checked. */
  findByKey(workspaceId: string, actorId: string, idempotencyKey: string): Promise<WritingCandidateRecord | null>;
  get(workspaceId: string, projectId: string, requestId: string): Promise<WritingCandidateRecord | null>;
  getById(workspaceId: string, requestId: string): Promise<WritingCandidateRecord | null>;
  /** Recent requests of one target, newest first. */
  listForTarget(workspaceId: string, projectId: string, target: { mode: WritingCandidateMode; episodeId: string | null }, limit: number): Promise<WritingCandidateRecord[]>;
  /** reserved → submitted, only by the owning executor with a live lease. */
  markSubmitted(workspaceId: string, requestId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<boolean>;
  /** reserved → rejected, only by the owning executor, for a request that will not be sent (nothing left the process). */
  closeUnsent(workspaceId: string, requestId: string, executorId: string, errorCode: string, nowIso: string): Promise<boolean>;
  /** submitted → completed / rejected / unknown, only by the owning executor. */
  finish(workspaceId: string, requestId: string, executorId: string, patch: WritingCandidateFinish, nowIso: string): Promise<boolean>;
  /** Expired leases: never sent → rejected (executor_lost_before_send); maybe sent → unknown (executor_lost). */
  recoverExpired(workspaceId: string, nowIso: string): Promise<number>;
}

export interface WritingCandidateView {
  requestId: string;
  projectId: string;
  mode: WritingCandidateMode;
  episodeId: string | null;
  episodeNo: number | null;
  providerKey: TitleWritingProviderKey;
  providerLabel: string;
  model: string;
  state: WritingCandidateState;
  errorCode: string | null;
  providerRequestId: string | null;
  responseModel: string | null;
  usage: TitleWritingUsageView;
  /** Cost is never estimated, and never written as zero. */
  billing: "unknown";
  base: { sourceRevisionId: string | null; ifMatch: number };
  request: WritingCandidateStoryRequest | WritingCandidateEpisodeRequest;
  candidate: WritingCandidateOutput | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface WritingCandidateOptionsView {
  enabled: boolean;
  code: string;
  storageReady: boolean;
  operatorTokenRequired: boolean;
  defaultProvider: TitleWritingProviderKey | null;
  providers: TitleWritingProviderOption[];
  maxCallsPerDay: number;
  billing: "unknown";
}

function text(maxLength: number) {
  return { type: "string", maxLength } as const;
}
function objectOf(properties: Record<string, unknown>) {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties } as const;
}

/**
 * The provider JSON Schema of a candidate: the story plan (ads.writing.story-plan.v1, exactly three episodes) or the
 * draft of exactly this episode (ads.writing.episode-draft.v1). The zod schemas and the domain import checks stay the
 * authority on every answer; this only shapes what the provider returns.
 */
export function writingCandidateJsonSchema(mode: WritingCandidateMode, episodeNo: number | null): { name: string; schema: Record<string, unknown> } {
  if (mode === "story") {
    return {
      name: "story_plan",
      schema: objectOf({
        schema: { type: "string", enum: [STORY_PLAN_SCHEMA] },
        logline: text(300),
        protagonistGoal: text(300),
        opposition: text(300),
        coreConflict: text(400),
        relationships: { type: "array", minItems: 1, maxItems: 6, items: objectOf({ name: text(40), pressure: text(200) }) },
        episodes: { type: "array", minItems: 3, maxItems: 3, items: objectOf({
          episodeNo: { type: "integer", enum: [1, 2, 3] }, entryState: text(400), goal: text(400), action: text(400),
          turn: text(400), result: text(400), handoff: text(400),
        }) },
      }),
    };
  }
  return {
    name: "episode_draft",
    schema: objectOf({
      schema: { type: "string", enum: [EPISODE_DRAFT_SCHEMA] },
      episodeNo: { type: "integer", enum: [episodeNo ?? 1] },
      title: text(80),
      screenplay: text(12_000),
      scenes: { type: "array", minItems: 1, maxItems: 12,
        items: objectOf({ heading: text(80), action: text(400), dialogue: text(400), sound: text(120) }) },
      handoffFacts: { type: "array", minItems: 1, maxItems: 8, items: text(200) },
    }),
  };
}
