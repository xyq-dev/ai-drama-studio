import { z } from "zod";
import {
  VIMAX_PLATFORM_PREVIEW_MAX_BYTES,
  vimaxCandidateCreateSchema,
  vimaxCandidatePlaceShotsSchema,
  vimaxCandidateSaveSceneSchema,
  type VimaxCandidateCreate,
  type VimaxCandidateCreateResponse,
  type VimaxCandidatePage,
  type VimaxCandidatePlaceShots,
  type VimaxCandidateSaveScene,
  type VimaxCandidateTargets,
  type VimaxCandidateView,
  type VimaxCandidateWriteResponse,
} from "@ai-drama/contracts";
import { PersistenceError } from "@ai-drama/database";
import type { StudioContext } from "./studio.service";

/** A separate store, never a model executor or the whole-episode replacement writer. */
export interface VimaxCandidatePersistence {
  storageReady(): Promise<boolean>;
  targets(workspaceId: string, projectId: string, episodeId: string): Promise<VimaxCandidateTargets>;
  list(workspaceId: string, projectId: string, episodeId: string, actorId: string,
    options: { limit?: number; cursor?: string }): Promise<VimaxCandidatePage>;
  get(workspaceId: string, projectId: string, episodeId: string, actorId: string, candidateId: string): Promise<VimaxCandidateView>;
  create(workspaceId: string, projectId: string, episodeId: string, actorId: string, key: string,
    body: VimaxCandidateCreate, traceId: string): Promise<VimaxCandidateCreateResponse>;
  saveScene(workspaceId: string, projectId: string, episodeId: string, actorId: string, candidateId: string, key: string,
    body: VimaxCandidateSaveScene, traceId: string): Promise<VimaxCandidateWriteResponse>;
  placeShots(workspaceId: string, projectId: string, episodeId: string, actorId: string, candidateId: string, key: string,
    body: VimaxCandidatePlaceShots, traceId: string): Promise<VimaxCandidateWriteResponse>;
}
export interface VimaxCandidateDependencies {
  workspaceId: string;
  nodeEnv: "development" | "test" | "production";
  store: VimaxCandidatePersistence;
}
export interface VimaxCandidateResult { status: number; body: unknown }

const ERRORS: Record<string, { status: number; message: string }> = {
  VIMAX_CANDIDATE_DISABLED: { status: 404, message: "当前环境未开放分镜候选保存。" },
  VIMAX_CANDIDATE_STORAGE_UNAVAILABLE: { status: 503, message: "分镜候选存储尚未启用，未保存或改写任何内容。" },
  VIMAX_CANDIDATE_CORRUPT: { status: 503, message: "分镜候选记录未通过完整性检查，请先处理存储问题。" },
  VIMAX_CANDIDATE_SOURCE_CHANGED: { status: 409, message: "来源剧本或角色已变化，请重新核对当前版本。" },
  VIMAX_CANDIDATE_TARGET_CHANGED: { status: 409, message: "目标场景已被修改，请重新读取并核对场景。" },
  VIMAX_CANDIDATE_HAS_SHOTS: { status: 409, message: "目标场景已有镜头，已保留现有内容。" },
  VIMAX_CANDIDATE_REVIEW_REQUIRED: { status: 409, message: "请先批准候选创建的精确场景版本，再写入镜头草稿。" },
  VIMAX_CANDIDATE_ACTIVE_BREAKDOWN: { status: 409, message: "本集整集拆解正在进行，请等它结束后再操作。" },
  VIMAX_CANDIDATE_BLOCKED: { status: 422, message: "分镜方案未通过完整性或对白保真检查，未保存。" },
  VIMAX_CANDIDATE_ALREADY_SAVED: { status: 409, message: "这一步已经保存。请读取原结果，或用原请求标识确认回执。" },
  VIMAX_CANDIDATE_INPUT_TOO_LARGE: { status: 413, message: "分镜候选请求超过 300 KB。" },
  VIMAX_CANDIDATE_FROZEN_TOO_LARGE: { status: 413, message: "冻结后的完整候选超出保存范围，未保存或改写内容。" },
  VIMAX_CANDIDATE_INVALID_REQUEST: { status: 400, message: "分镜候选请求无效。" },
  SERIES_MEDIA_NOT_ENABLED: { status: 409, message: "系列作品尚未开放分镜候选保存。" },
  VIMAX_PREVIEW_SCRIPT_REVIEW_REQUIRED: { status: 409, message: "请先批准这一集的当前剧本。" },
  VIMAX_PREVIEW_SCRIPT_UNSUPPORTED: { status: 409, message: "当前剧本正文不在支持范围内。" },
  VIMAX_PREVIEW_TOO_MANY_CHARACTERS: { status: 409, message: "当前角色数量超过分镜候选范围。" },
  VIMAX_PREVIEW_CHARACTERS_UNSUPPORTED: { status: 409, message: "当前角色版本不可用，请检查角色资料。" },
  SCRIPT_REVIEW_REQUIRED: { status: 409, message: "请先批准这一集的当前剧本。" },
  REVIEW_REQUIRED: { status: 409, message: "场景或地点引用尚未批准，或已变化，请核对当前版本。" },
  SOURCE_STALE: { status: 409, message: "来源依赖正在更新或已经过期，请重新读取后再试。" },
  REVISION_CONFLICT: { status: 409, message: "版本已变化，请重新读取后再操作。" },
  IDEMPOTENCY_KEY_REUSED: { status: 409, message: "同一请求标识被用于不同内容，已拒绝。" },
  IDEMPOTENCY_IN_PROGRESS: { status: 409, message: "原请求仍在处理，请稍后用原请求标识确认。" },
  NOT_FOUND: { status: 404, message: "没有找到这部作品、剧集或分镜候选。" },
  VALIDATION_ERROR: { status: 400, message: "分镜候选请求无效。" },
};
function failure(code: string, details?: { field: string }): VimaxCandidateResult {
  const definition = ERRORS[code]!;
  return { status: definition.status, body: { error: { code, message: definition.message, ...(details ? { details } : {}) } } };
}
const listQuerySchema = z.object({
  limit: z.string().regex(/^[1-9][0-9]?$/).transform(Number).refine((value) => value <= 20).optional(),
  cursor: z.string().min(1).max(1000).optional(),
}).strict();
const validKey = (value: string | undefined): value is string => typeof value === "string" && /^[\x21-\x7e]{1,200}$/.test(value);

/** Persistent candidates and two explicit writes. Live-source/review/version checks belong inside the store transaction. */
export class VimaxCandidateService {
  constructor(private readonly deps: VimaxCandidateDependencies) {}

  private disabled(): VimaxCandidateResult | null {
    return this.deps.nodeEnv === "production" ? failure("VIMAX_CANDIDATE_DISABLED") : null;
  }

  private async access(work: () => Promise<VimaxCandidateResult>): Promise<VimaxCandidateResult> {
    try {
      if (!await this.deps.store.storageReady()) return failure("VIMAX_CANDIDATE_STORAGE_UNAVAILABLE");
      return await work();
    } catch (error) {
      // Only known business refusals are translated. Probe timeouts/disconnections must not masquerade as missing SQL.
      if (error instanceof PersistenceError && ERRORS[error.code]) return failure(error.code);
      throw error;
    }
  }

  async targets(projectId: string, episodeId: string): Promise<VimaxCandidateResult> {
    return this.disabled() ?? this.access(async () => ({ status: 200,
      body: await this.deps.store.targets(this.deps.workspaceId, projectId, episodeId) }));
  }

  async list(projectId: string, episodeId: string, actorId: string, query: unknown): Promise<VimaxCandidateResult> {
    const disabled = this.disabled();
    if (disabled) return disabled;
    const parsed = listQuerySchema.safeParse(query);
    if (!parsed.success) return failure("VIMAX_CANDIDATE_INVALID_REQUEST", { field: "query" });
    return this.access(async () => ({ status: 200, body: await this.deps.store.list(this.deps.workspaceId, projectId, episodeId, actorId,
      { limit: parsed.data.limit ?? 10, ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}) }) }));
  }

  async get(projectId: string, episodeId: string, candidateId: string, actorId: string): Promise<VimaxCandidateResult> {
    return this.disabled() ?? this.access(async () => ({ status: 200,
      body: await this.deps.store.get(this.deps.workspaceId, projectId, episodeId, actorId, candidateId) }));
  }

  private body<T>(schema: z.ZodType<T>, body: unknown): { ok: true; value: T } | { ok: false; result: VimaxCandidateResult } {
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(body) ?? "", "utf8"); }
    catch { return { ok: false, result: failure("VIMAX_CANDIDATE_INVALID_REQUEST") }; }
    if (bytes > VIMAX_PLATFORM_PREVIEW_MAX_BYTES) return { ok: false, result: failure("VIMAX_CANDIDATE_INPUT_TOO_LARGE") };
    const parsed = schema.safeParse(body);
    return parsed.success ? { ok: true, value: parsed.data }
      : { ok: false, result: failure("VIMAX_CANDIDATE_INVALID_REQUEST", { field: parsed.error.issues[0]?.path.join(".") ?? "body" }) };
  }

  async create(projectId: string, episodeId: string, body: unknown, context: StudioContext): Promise<VimaxCandidateResult> {
    const disabled = this.disabled();
    if (disabled) return disabled;
    if (!validKey(context.idempotencyKey)) return failure("VIMAX_CANDIDATE_INVALID_REQUEST", { field: "Idempotency-Key" });
    const parsed = this.body(vimaxCandidateCreateSchema, body);
    if (!parsed.ok) return parsed.result;
    return this.access(async () => {
      const response = await this.deps.store.create(this.deps.workspaceId, projectId, episodeId,
        context.actorId, context.idempotencyKey!, parsed.value, context.traceId);
      return { status: response.replayed ? 200 : 201, body: response };
    });
  }

  async saveScene(projectId: string, episodeId: string, candidateId: string, body: unknown, context: StudioContext): Promise<VimaxCandidateResult> {
    return this.write("saveScene", projectId, episodeId, candidateId, body, context);
  }

  async placeShots(projectId: string, episodeId: string, candidateId: string, body: unknown, context: StudioContext): Promise<VimaxCandidateResult> {
    return this.write("placeShots", projectId, episodeId, candidateId, body, context);
  }

  private async write(operation: "saveScene" | "placeShots", projectId: string, episodeId: string, candidateId: string,
    body: unknown, context: StudioContext): Promise<VimaxCandidateResult> {
    const disabled = this.disabled();
    if (disabled) return disabled;
    if (!validKey(context.idempotencyKey)) return failure("VIMAX_CANDIDATE_INVALID_REQUEST", { field: "Idempotency-Key" });
    const parsed = this.body<VimaxCandidateSaveScene | VimaxCandidatePlaceShots>(operation === "saveScene" ? vimaxCandidateSaveSceneSchema : vimaxCandidatePlaceShotsSchema, body);
    if (!parsed.ok) return parsed.result;
    // No pre-read here: an original permanent receipt takes precedence over changed live sources and review state.
    return this.access(async () => ({ status: 200,
      body: operation === "saveScene"
        ? await this.deps.store.saveScene(this.deps.workspaceId, projectId, episodeId, context.actorId,
          candidateId, context.idempotencyKey!, parsed.value as VimaxCandidateSaveScene, context.traceId)
        : await this.deps.store.placeShots(this.deps.workspaceId, projectId, episodeId, context.actorId,
          candidateId, context.idempotencyKey!, parsed.value as VimaxCandidatePlaceShots, context.traceId),
    }));
  }
}
