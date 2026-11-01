import { z } from "zod";
import { vimaxCandidateCreateSchema, vimaxCandidateTargetSchema } from "./vimax-candidate";
import { vimaxPlatformPreviewRequestSchema, vimaxPlatformSourceSnapshotSchema } from "./vimax-platform-preview";
import { TITLE_WRITING_PROVIDER_KEYS, type TitleWritingProviderKey, type TitleWritingUsageView } from "./title-writing";

export const VIMAX_PLANNING_START_SCHEMA = "ads.vimax-planning.start.v1" as const;
export const VIMAX_PLANNING_PROMPT_VERSION = "ads.vimax-planning.prompt.v1" as const;
export const VIMAX_PLANNING_BUDGET = { maxCalls: 1, maxOutputTokens: 4096, timeoutMs: 120000 } as const;
const p = vimaxPlatformPreviewRequestSchema.shape;
/** No credentials, model override, script text or client approval flags. All sends use server configuration. */
export const vimaxPlanningStartSchema = z.object({
  schema: z.literal(VIMAX_PLANNING_START_SCHEMA),
  target: vimaxCandidateCreateSchema.shape.target,
  source: p.source, sceneSpans: p.sceneSpans, selectedSceneKeys: p.selectedSceneKeys,
  sourceDialogue: p.sourceDialogue, requirements: p.requirements,
  confirmedTextSend: z.literal(true),
  confirmUncertainRequestId: z.string().uuid().optional(),
}).strict();
export type VimaxPlanningStart = z.infer<typeof vimaxPlanningStartSchema>;
export const vimaxPlanningFrozenSchema = z.object({
  schema: z.literal("ads.vimax-planning.frozen.v1"),
  promptVersion: z.literal(VIMAX_PLANNING_PROMPT_VERSION),
  source: vimaxPlatformSourceSnapshotSchema, target: vimaxCandidateTargetSchema,
  request: vimaxPlanningStartSchema,
  providerKey: z.enum(TITLE_WRITING_PROVIDER_KEYS), model: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  budget: z.object({ maxCalls: z.literal(1), maxOutputTokens: z.literal(4096), timeoutMs: z.literal(120000) }).strict(),
}).strict();
export type VimaxPlanningFrozen = z.infer<typeof vimaxPlanningFrozenSchema>;
export type VimaxPlanningState = "reserved" | "submitted" | "completed" | "rejected" | "unknown";
export interface VimaxPlanningRecord {
  id: string; workspaceId: string; projectId: string; episodeId: string; actorId: string;
  idempotencyKey: string; requestHash: string; frozenHash: string; input: VimaxPlanningFrozen;
  state: VimaxPlanningState; executorId: string | null; leaseUntil: string | null;
  submittedAt: string | null; errorCode: string | null;
  providerRequestId: string | null; responseModel: string | null; usage: TitleWritingUsageView;
  output: z.infer<typeof vimaxCandidateCreateSchema> | null; createdAt: string; finishedAt: string | null;
}
export interface VimaxPlanningReservation {
  id: string; workspaceId: string; projectId: string; episodeId: string; actorId: string; idempotencyKey: string;
  requestHash: string; request: VimaxPlanningStart; providerKey: TitleWritingProviderKey; model: string;
  executorId: string; leaseUntil: string; createdAt: string;
}
export type VimaxPlanningCreation =
  | { kind: "created" | "existing"; record: VimaxPlanningRecord }
  | { kind: "conflict" }
  | { kind: "active" | "needs_confirmation"; requestId: string }
  | { kind: "blocked"; code: string };
export interface VimaxPlanningFinish {
  state: "completed" | "rejected" | "unknown"; errorCode: string | null;
  providerRequestId: string | null; responseModel: string | null; usage: TitleWritingUsageView;
  output: z.infer<typeof vimaxCandidateCreateSchema> | null;
}
export interface VimaxPlanningStore {
  storageReady(): Promise<boolean>;
  findByKey(workspaceId: string, actorId: string, key: string): Promise<VimaxPlanningRecord | null>;
  create(input: VimaxPlanningReservation, limits: { sinceIso: string; maxCallsPerDay: number; maxActiveRuns: number }): Promise<VimaxPlanningCreation>;
  get(workspaceId: string, projectId: string, episodeId: string, actorId: string, requestId: string): Promise<VimaxPlanningRecord | null>;
  getById(workspaceId: string, requestId: string): Promise<VimaxPlanningRecord | null>;
  list(workspaceId: string, projectId: string, episodeId: string, actorId: string, limit: number): Promise<VimaxPlanningRecord[]>;
  /** Rechecks current source, target and shared concurrency gates, then CAS under ordered locks. */
  markSubmitted(workspaceId: string, requestId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<boolean>;
  closeUnsent(workspaceId: string, requestId: string, executorId: string, errorCode: string, nowIso: string): Promise<boolean>;
  finish(workspaceId: string, requestId: string, executorId: string, patch: VimaxPlanningFinish, nowIso: string): Promise<boolean>;
  recoverExpired(workspaceId: string, nowIso: string): Promise<number>;
  /** Only a reserved request can be canceled. A submitted request remains possibly charged and cannot be resent. */
  cancel(workspaceId: string, projectId: string, episodeId: string, actorId: string, requestId: string, nowIso: string): Promise<VimaxPlanningRecord | null>;
}
const nullableText = z.string().max(200).nullable();
const usage = z.object({ status: z.enum(["present", "unknown"]), inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(), totalTokens: z.number().int().nonnegative().nullable() }).strict();
export const vimaxPlanningViewSchema = z.object({
  schema: z.literal("ads.vimax-planning.view.v1"), requestId: z.string().uuid(),
  requestKey: z.string().min(1).max(200), requestHash: z.string().regex(/^[a-f0-9]{64}$/), projectId: z.string().uuid(), episodeId: z.string().uuid(),
  state: z.enum(["reserved", "submitted", "completed", "rejected", "unknown"]),
  input: vimaxPlanningFrozenSchema, errorCode: nullableText, providerRequestId: nullableText, responseModel: nullableText,
  usage, billing: z.literal("unknown"), output: vimaxCandidateCreateSchema.nullable(),
  submittedAt: z.string().datetime().nullable(), createdAt: z.string().datetime(), finishedAt: z.string().datetime().nullable(),
  quotaAccounting: z.literal("reservation"),
}).strict().superRefine((v, c) => {
  if ((v.state === "completed") !== (v.output !== null) || v.input.source.projectId !== v.projectId || v.input.source.episodeId !== v.episodeId
    || ((v.state === "reserved" || v.state === "submitted") !== (v.finishedAt === null))) {
    c.addIssue({ code: "custom", message: "planning_view_state_mismatch" });
  }
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const r = v.input.request;
  if (v.input.source.scriptRevisionId !== r.source.scriptRevisionId || v.input.source.scriptContentHash !== r.source.scriptContentHash
    || !same(v.input.source.characters, r.source.characters) || v.input.target.sceneId !== r.target.sceneId
    || v.input.target.sceneRevisionId !== r.target.sceneRevisionId || v.input.target.rowVersion !== r.target.rowVersion
    || (v.state === "reserved" && v.submittedAt !== null) || (["submitted", "completed", "unknown"].includes(v.state) && v.submittedAt === null)
    || (["reserved", "submitted", "completed"].includes(v.state) ? v.errorCode !== null : v.errorCode === null)) {
    c.addIssue({ code: "custom", message: "planning_view_frozen_identity_mismatch" });
  }
  if (v.output && (!same(v.output.target, r.target) || !same(v.output.request.source, r.source)
    || !same(v.output.request.sceneSpans, r.sceneSpans) || !same(v.output.request.selectedSceneKeys, r.selectedSceneKeys)
    || !same(v.output.request.sourceDialogue, r.sourceDialogue) || !same(v.output.request.requirements, r.requirements))) {
    c.addIssue({ code: "custom", message: "planning_view_output_input_mismatch" });
  }
});
export type VimaxPlanningView = z.infer<typeof vimaxPlanningViewSchema>;
export const vimaxPlanningResponseSchema = z.object({ schema: z.literal("ads.vimax-planning.response.v1"), replayed: z.boolean(), request: vimaxPlanningViewSchema }).strict();
export type VimaxPlanningResponse = z.infer<typeof vimaxPlanningResponseSchema>;
export const vimaxPlanningPageSchema = z.object({ schema: z.literal("ads.vimax-planning.page.v1"), items: z.array(vimaxPlanningViewSchema).max(20) }).strict();
export type VimaxPlanningPage = z.infer<typeof vimaxPlanningPageSchema>;
export const vimaxPlanningOptionsSchema = z.object({
  schema: z.literal("ads.vimax-planning.options.v1"), enabled: z.boolean(), code: z.string(), storageReady: z.boolean(),
  providerKey: z.enum(TITLE_WRITING_PROVIDER_KEYS).nullable(), model: z.string().nullable(), budget: vimaxPlanningFrozenSchema.shape.budget,
  maxCallsPerDay: z.number().int().nonnegative(), quotaAccounting: z.literal("reservation"), billing: z.literal("unknown"),
}).strict();
export type VimaxPlanningOptions = z.infer<typeof vimaxPlanningOptionsSchema>;

/** Both artifacts are explicit model JSON fields; free text is never parsed into missing supplement fields. */
export const vimaxPlanningOutputSchema = z.object({
  candidate: p.candidate, supplements: p.supplements,
}).strict();
export function vimaxPlanningJsonSchema(): { name: string; schema: Record<string, unknown> } {
  const schema = z.toJSONSchema(vimaxPlanningOutputSchema, { target: "draft-7", unrepresentable: "any" });
  delete schema.$schema;
  return { name: "single_scene_plan", schema };
}
