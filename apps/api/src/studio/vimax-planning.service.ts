import { randomUUID } from "node:crypto";
import {
  TITLE_WRITING_PROVIDER_PREFERENCE, VIMAX_PLANNING_BUDGET, vimaxPlanningStartSchema,
  type TitleWritingProviderKey, type VimaxPlanningOptions, type VimaxPlanningRecord, type VimaxPlanningStore,
} from "@ai-drama/contracts";
import { PersistenceError } from "@ai-drama/database";
import { hashVimaxPlanningRequest } from "@ai-drama/domain";
import { vimaxPlanningView, type WritingProviderConfig } from "@ai-drama/providers";
import { operatorAllowed, type OperatorPolicy, type OperatorProof } from "./operator-access";
import type { StudioContext } from "./studio.service";

export interface VimaxPlanningDependencies extends OperatorPolicy {
  workspaceId: string; nodeEnv: "development" | "test" | "production"; enabled: boolean;
  allowProduction?: boolean;
  /** True only while site login is enabled. This capability never runs on an anonymous site. */
  siteAuthRequired: boolean;
  defaultProvider: TitleWritingProviderKey | null;
  providers: Record<TitleWritingProviderKey, WritingProviderConfig>;
  store: VimaxPlanningStore;
  executor: { workspaceId: string; executorId: string; execute(requestId: string): Promise<void>; maintain(): Promise<void> };
  maxCallsPerDay: number; maxActiveRuns: number; clock?: () => Date; schedule?: (work: () => Promise<void>) => void;
}
export interface VimaxPlanningResult { status: number; body: unknown }
const failures: Record<string, [number, string]> = {
  VIMAX_PLANNING_DISABLED: [404, "当前环境未开放在线单场景规划。"],
  VIMAX_PLANNING_FORBIDDEN: [403, "需要已登录管理员的操作权限，未发出新调用。"],
  VIMAX_PLANNING_STORAGE_UNAVAILABLE: [503, "单场景规划存储尚未启用，未预约或发送。"],
  VIMAX_PLANNING_CORRUPT: [503, "规划记录未通过完整性检查，请处理存储问题。"],
  VIMAX_PLANNING_INVALID_REQUEST: [400, "规划请求无效。"],
  VIMAX_PLANNING_INPUT_BLOCKED: [422, "规划输入未通过原文与场景检查。"],
  VIMAX_PLANNING_INPUT_TOO_LARGE: [413, "规划请求超过保存范围。"],
  VIMAX_PLANNING_PROVIDER_UNCONFIGURED: [503, "服务端默认文本模型未配置完整，未发出调用。"],
  VIMAX_PLANNING_ACTIVE: [409, "目标场景已有规划请求进行中，未发出新调用。"],
  VIMAX_PLANNING_NEEDS_CONFIRMATION: [409, "上次规划结果未知，可能已经收费。请核对并明确确认后再发起新请求。"],
  VIMAX_PLANNING_ALREADY_SUBMITTED: [409, "请求已提交，可能已经收费，无法按未发送取消。"],
  VIMAX_PLANNING_ACTIVE_CAP: [429, "工作区正在进行的写作任务与规划预约已达并发上限，未发出新调用。"],
  VIMAX_PLANNING_PROJECT_ACTIVE: [409, "本作品正在执行其他写作任务，请等它结束后再预约规划。"],
  VIMAX_PLANNING_DAILY_CAP: [429, "最近 24 小时的文本预约额度不足，未发出新调用。"],
  VIMAX_PLANNING_SOURCE_CHANGED: [409, "剧本或角色来源已变化，请重新核对。"],
  VIMAX_PLANNING_TARGET_CHANGED: [409, "目标场景已变化，请重新核对。"],
  VIMAX_PLANNING_HAS_SHOTS: [409, "目标场景已有镜头，已保留现有内容。"],
  VIMAX_PLANNING_ACTIVE_BREAKDOWN: [409, "本集正在整集拆解，请稍后再试。"],
  VIMAX_PLANNING_BLOCKED: [422, "规划输入未通过完整性检查。"],
  SOURCE_STALE: [409, "来源已过期或正在传播更新，请稍后重新读取。"],
  SERIES_MEDIA_NOT_ENABLED: [409, "系列作品尚未开放单场景规划。"],
  IDEMPOTENCY_KEY_REUSED: [409, "原请求标识不能用于不同内容。"],
  VALIDATION_ERROR: [400, "规划请求无效。"], NOT_FOUND: [404, "没有找到这次规划。"],
};
function failure(code: string, details?: Record<string, unknown>): VimaxPlanningResult {
  const [status, message] = failures[code] ?? [409, "规划请求被阻断，未发出新调用。"];
  return { status, body: { error: { code, message, ...(details ? { details } : {}) } } };
}
const keyValid = (value: string | undefined): value is string => typeof value === "string" && /^[\x21-\x7e]{1,200}$/.test(value);
export class VimaxPlanningService {
  constructor(private readonly deps: VimaxPlanningDependencies) {
    if (deps.workspaceId !== deps.executor.workspaceId) throw new Error("ViMax executor belongs to another workspace");
  }
  private now() { return this.deps.clock?.() ?? new Date(); }
  private active() { return this.deps.enabled && this.deps.siteAuthRequired && (this.deps.nodeEnv !== "production" || this.deps.allowProduction === true); }
  private async access(work: () => Promise<VimaxPlanningResult>): Promise<VimaxPlanningResult> {
    if (!this.active()) return failure("VIMAX_PLANNING_DISABLED");
    if (!await this.deps.store.storageReady()) return failure("VIMAX_PLANNING_STORAGE_UNAVAILABLE");
    try { return await work(); } catch (error) {
      if (error instanceof PersistenceError && failures[error.code]) return failure(error.code);
      throw error;
    }
  }
  private choice(): TitleWritingProviderKey | null {
    return this.deps.defaultProvider ?? TITLE_WRITING_PROVIDER_PREFERENCE.find((key) => this.deps.providers[key].ok) ?? null;
  }
  async options(_projectId: string, _episodeId: string): Promise<VimaxPlanningResult> {
    const storageReady = await this.deps.store.storageReady();
    const providerKey = this.choice(), provider = providerKey ? this.deps.providers[providerKey] : null;
    const ready = provider?.ok === true && provider.models.length > 0;
    const body: VimaxPlanningOptions = { schema: "ads.vimax-planning.options.v1", enabled: this.active(), storageReady,
      code: !this.active() ? "VIMAX_PLANNING_DISABLED" : !storageReady ? "VIMAX_PLANNING_STORAGE_UNAVAILABLE"
        : !ready ? "VIMAX_PLANNING_PROVIDER_UNCONFIGURED" : "VIMAX_PLANNING_READY",
      providerKey, model: provider?.models[0] ?? null, budget: { ...VIMAX_PLANNING_BUDGET },
      maxCallsPerDay: this.deps.maxCallsPerDay, quotaAccounting: "reservation", billing: "unknown" };
    return { status: 200, body };
  }
  private found(record: VimaxPlanningRecord | null, projectId: string, episodeId: string, status = 200, replayed = false): VimaxPlanningResult {
    return record && record.projectId === projectId && record.episodeId === episodeId
      ? { status, body: { schema: "ads.vimax-planning.response.v1", replayed, request: vimaxPlanningView(record) } } : failure("NOT_FOUND");
  }
  async start(projectId: string, episodeId: string, body: unknown, proof: OperatorProof | string | undefined, context: StudioContext): Promise<VimaxPlanningResult> {
    if (!this.active()) return failure("VIMAX_PLANNING_DISABLED");
    if (!operatorAllowed(this.deps, proof)) return failure("VIMAX_PLANNING_FORBIDDEN");
    if (!keyValid(context.idempotencyKey)) return failure("VALIDATION_ERROR", { field: "Idempotency-Key" });
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(body) ?? ""); } catch { return failure("VALIDATION_ERROR"); }
    if (bytes > 300 * 1024) return { status: 413, body: { error: { code: "VIMAX_PLANNING_INPUT_TOO_LARGE", message: "规划请求不能超过 300 KB。" } } };
    const parsed = vimaxPlanningStartSchema.safeParse(body);
    if (!parsed.success) return failure("VALIDATION_ERROR", { field: parsed.error.issues[0]?.path.join(".") ?? "body" });
    return this.access(async () => {
      let requestHash: string;
      try { requestHash = hashVimaxPlanningRequest(projectId, episodeId, parsed.data); }
      catch { return failure("VALIDATION_ERROR"); }
      const previous = await this.deps.store.findByKey(this.deps.workspaceId, context.actorId, context.idempotencyKey!);
      if (previous) return previous.requestHash === requestHash && previous.projectId === projectId && previous.episodeId === episodeId
        ? this.found(previous, projectId, episodeId, 200, true) : failure("IDEMPOTENCY_KEY_REUSED");
      const providerKey = this.choice(), provider = providerKey ? this.deps.providers[providerKey] : null;
      if (!providerKey || !provider?.ok || !provider.models[0]) return failure("VIMAX_PLANNING_PROVIDER_UNCONFIGURED");
      const now = this.now();
      const created = await this.deps.store.create({ id: randomUUID(), workspaceId: this.deps.workspaceId, projectId, episodeId,
        actorId: context.actorId, idempotencyKey: context.idempotencyKey!, requestHash, request: parsed.data,
        providerKey, model: provider.models[0], executorId: this.deps.executor.executorId,
        leaseUntil: new Date(now.getTime() + 240000).toISOString(), createdAt: now.toISOString() },
      { sinceIso: new Date(now.getTime() - 86400000).toISOString(), maxCallsPerDay: this.deps.maxCallsPerDay, maxActiveRuns: this.deps.maxActiveRuns });
      if (created.kind === "created") {
        const work = () => this.deps.executor.execute(created.record.id);
        if (this.deps.schedule) this.deps.schedule(work); else setImmediate(() => { void work().catch(() => undefined); });
        return this.found(created.record, projectId, episodeId, 202);
      }
      if (created.kind === "existing") return this.found(created.record, projectId, episodeId, 200, true);
      if (created.kind === "conflict") return failure("IDEMPOTENCY_KEY_REUSED");
      if (created.kind === "active") return failure("VIMAX_PLANNING_ACTIVE", { requestId: created.requestId });
      if (created.kind === "needs_confirmation") return failure("VIMAX_PLANNING_NEEDS_CONFIRMATION", { requestId: created.requestId });
      return failure("code" in created ? created.code : "VIMAX_PLANNING_BLOCKED");
    });
  }
  async get(projectId: string, episodeId: string, actorId: string, requestId: string): Promise<VimaxPlanningResult> {
    return this.access(async () => this.found(await this.deps.store.get(this.deps.workspaceId, projectId, episodeId, actorId, requestId), projectId, episodeId));
  }
  async list(projectId: string, episodeId: string, actorId: string): Promise<VimaxPlanningResult> {
    return this.access(async () => ({ status: 200, body: { schema: "ads.vimax-planning.page.v1",
      items: (await this.deps.store.list(this.deps.workspaceId, projectId, episodeId, actorId, 20)).map(vimaxPlanningView) } }));
  }
  async cancel(projectId: string, episodeId: string, actorId: string, requestId: string, proof: OperatorProof | string | undefined): Promise<VimaxPlanningResult> {
    if (!operatorAllowed(this.deps, proof)) return failure("VIMAX_PLANNING_FORBIDDEN");
    return this.access(async () => {
      const record = await this.deps.store.cancel(this.deps.workspaceId, projectId, episodeId, actorId, requestId, this.now().toISOString());
      if (record?.state === "submitted") return failure("VIMAX_PLANNING_ALREADY_SUBMITTED", { requestId: record.id });
      return this.found(record, projectId, episodeId);
    });
  }
  /** Lease maintenance only; it never starts or resends a provider request. */
  async maintain(): Promise<void> { if (await this.deps.store.storageReady()) await this.deps.executor.maintain(); }
}
