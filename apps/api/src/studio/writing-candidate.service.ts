import { z } from "zod";
import {
  TITLE_WRITING_PROVIDER_KEYS,
  TITLE_WRITING_PROVIDER_PREFERENCE,
  writingCandidateStartSchema,
  type TitleWritingProviderKey,
  type WritingCandidateOptionsView,
  type WritingCandidateRecord,
  type WritingCandidateStore,
} from "@ai-drama/contracts";
import type { RuntimeStore } from "@ai-drama/database";
import {
  WRITING_ADAPTERS,
  hashWritingCandidate,
  newWritingCandidate,
  writingCandidateView,
  type WritingCandidateExecutor,
  type WritingProviderConfig,
} from "@ai-drama/providers";
import { operatorAllowed, operatorConfigured, type OperatorProof } from "./operator-access";
import type { StudioContext } from "./studio.service";

export interface WritingCandidateDependencies {
  workspaceId: string;
  nodeEnv: "development" | "test" | "production";
  /** The same switch and production authorization as title writing (TITLE_WRITING_ENABLED). */
  enabled: boolean;
  allowProduction?: boolean;
  operatorToken: string | null;
  siteOperator?: boolean;
  defaultProvider: TitleWritingProviderKey | null;
  providers: Record<TitleWritingProviderKey, WritingProviderConfig>;
  store: WritingCandidateStore;
  executor: Pick<WritingCandidateExecutor, "workspaceId" | "executorId" | "execute" | "maintain">;
  projects: Pick<RuntimeStore, "getProject">;
  /** The shared rolling 24 h cap of every paid text call of the workspace. */
  maxCallsPerDay: number;
  clock?: () => Date;
  /** Starts the send without holding the HTTP request. Tests may run it inline. */
  schedule?: (work: () => Promise<void>) => void;
}

export interface WritingCandidateResult {
  status: number;
  body: unknown;
}

const MESSAGES: Record<string, string> = {
  WRITING_CANDIDATE_DISABLED: "在线创作没有开启。仍可复制指令到外部 AI，再粘贴或导入候选。",
  WRITING_CANDIDATE_FORBIDDEN: "没有调用权限（需要管理员登录，或在未启用站点登录时提供正确的操作者令牌），没有发出调用。",
  WRITING_CANDIDATE_STORAGE_UNAVAILABLE: "在线候选的数据库迁移还没有执行，没有保存请求，也没有发出调用。",
  WRITING_CANDIDATE_PROVIDER_UNCONFIGURED: "所选模型服务还没有配置完整，没有发出调用。",
  WRITING_CANDIDATE_MODEL_UNAVAILABLE: "所选模型不在服务端允许的列表中。",
  WRITING_CANDIDATE_ACTIVE: "这个编辑对象已有一次在线生成正在进行，请等它结束。没有发出新的调用。",
  WRITING_CANDIDATE_NEEDS_CONFIRMATION: "上一次在线生成的结果不确定，可能已经产生费用。请先确认后再发起新的生成。",
  WRITING_CANDIDATE_TARGET_INVALID: "编辑对象或它的版本与这部作品不一致，没有发出调用。",
  WRITING_CANDIDATE_DAILY_CAP: "最近 24 小时的调用次数已达上限，没有发出调用。",
  IDEMPOTENCY_KEY_REUSED: "同一个请求标识被用于不同的内容，已拒绝。",
  NOT_FOUND: "没有找到这次在线生成。",
  VALIDATION_ERROR: "请求内容无效。",
};

function failure(status: number, code: string, details?: Record<string, unknown>): WritingCandidateResult {
  return { status, body: { error: { code, message: MESSAGES[code] ?? "请求失败", ...(details ? { details } : {}) } } };
}

const listQuerySchema = z.object({
  mode: z.enum(["story", "episode"]),
  episodeId: z.string().uuid().optional(),
}).strict().refine((value) => (value.mode === "episode") === (value.episodeId !== undefined));

/**
 * Online candidates of the workbench writing assistant. A start may cost money, so it needs the switch, an operator,
 * ready storage and a configured provider before anything is written; the request is then reserved, sent once in the
 * background and read back by the page. Reads never call a provider. Nothing here writes a story or script revision.
 */
export class WritingCandidateService {
  constructor(private readonly deps: WritingCandidateDependencies) {
    if (deps.executor.workspaceId !== deps.workspaceId) throw new Error("writing candidate executor is bound to another workspace");
  }

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  private active(): boolean {
    return this.deps.enabled && (this.deps.nodeEnv !== "production" || this.deps.allowProduction === true);
  }

  private schedule(requestId: string): void {
    const work = () => this.deps.executor.execute(requestId);
    if (this.deps.schedule) {
      this.deps.schedule(work);
      return;
    }
    setImmediate(() => { void work().catch(() => undefined); });
  }

  private readyDefault(): TitleWritingProviderKey | null {
    const configured = this.deps.defaultProvider;
    if (configured && this.deps.providers[configured].ok) return configured;
    return TITLE_WRITING_PROVIDER_PREFERENCE.find((key) => this.deps.providers[key].ok) ?? null;
  }

  async options(): Promise<WritingCandidateResult> {
    const storageReady = await this.deps.store.storageReady();
    const providers = TITLE_WRITING_PROVIDER_KEYS.map((providerKey) => {
      const config = this.deps.providers[providerKey];
      return { providerKey, label: WRITING_ADAPTERS[providerKey].label, ready: config.ok, models: config.models,
        defaultModel: config.models[0] ?? null, missing: config.ok ? [] : config.missing };
    });
    const defaultProvider = this.readyDefault();
    const code = !this.active() ? "WRITING_CANDIDATE_DISABLED"
      : !operatorConfigured(this.deps) ? "WRITING_CANDIDATE_FORBIDDEN"
        : !storageReady ? "WRITING_CANDIDATE_STORAGE_UNAVAILABLE"
          : defaultProvider === null ? "WRITING_CANDIDATE_PROVIDER_UNCONFIGURED" : "WRITING_CANDIDATE_READY";
    const body: WritingCandidateOptionsView = {
      enabled: this.active(),
      code,
      storageReady,
      operatorTokenRequired: this.deps.siteOperator !== true,
      defaultProvider,
      providers,
      maxCallsPerDay: this.deps.maxCallsPerDay,
      billing: "unknown",
    };
    return { status: 200, body };
  }

  /** Switch, operator, then storage: every refusal happens before anything is written, reserved or sent. */
  private async gate(proof: OperatorProof | string | undefined): Promise<WritingCandidateResult | null> {
    if (!this.active()) return failure(404, "WRITING_CANDIDATE_DISABLED");
    if (!operatorAllowed(this.deps, proof)) return failure(403, "WRITING_CANDIDATE_FORBIDDEN");
    if (!await this.deps.store.storageReady()) return failure(503, "WRITING_CANDIDATE_STORAGE_UNAVAILABLE");
    return null;
  }

  private async readable(projectId: string): Promise<WritingCandidateResult | null> {
    await this.deps.projects.getProject(this.deps.workspaceId, projectId);
    if (!await this.deps.store.storageReady()) return failure(503, "WRITING_CANDIDATE_STORAGE_UNAVAILABLE");
    return null;
  }

  private found(record: WritingCandidateRecord | null, projectId: string, status = 200): WritingCandidateResult {
    return record && record.projectId === projectId ? { status, body: { request: writingCandidateView(record) } } : failure(404, "NOT_FOUND");
  }

  async start(projectId: string, body: unknown, proof: OperatorProof | string | undefined, context: StudioContext): Promise<WritingCandidateResult> {
    const refused = await this.gate(proof);
    if (refused) return refused;
    const key = context.idempotencyKey;
    if (!key || key.length > 200) return failure(400, "VALIDATION_ERROR", { field: "Idempotency-Key" });
    await this.deps.projects.getProject(this.deps.workspaceId, projectId);
    const parsed = writingCandidateStartSchema.safeParse(body);
    if (!parsed.success) return failure(400, "VALIDATION_ERROR", { field: parsed.error.issues[0]?.path.join(".") ?? "body" });
    const start = parsed.data;
    const episodeId = start.mode === "episode" ? start.episodeId : null;
    // A key already used is answered from its stored request, whatever the providers are now: a lost receipt must stay
    // recoverable and must never create or send a second request. Same key with another input is refused.
    const previous = await this.deps.store.findByKey(this.deps.workspaceId, context.actorId, key);
    const now = this.now();
    const build = (providerKey: TitleWritingProviderKey, model: string) => newWritingCandidate({
      workspaceId: this.deps.workspaceId, projectId, actorId: context.actorId, idempotencyKey: key, mode: start.mode, episodeId,
      providerKey, model, base: start.base, request: start.request, confirmedRequestId: start.confirmUncertainRequestId ?? null,
      executorId: this.deps.executor.executorId, now,
    });
    if (previous) {
      const replay = build(start.providerKey ?? previous.input.providerKey, start.model ?? previous.input.model);
      return previous.projectId === projectId && hashWritingCandidate(replay.input) === previous.requestHash
        ? this.found(previous, projectId) : failure(409, "IDEMPOTENCY_KEY_REUSED");
    }
    const providerKey = start.providerKey ?? this.readyDefault();
    if (providerKey === null) return failure(503, "WRITING_CANDIDATE_PROVIDER_UNCONFIGURED", { missing: [] });
    const provider = this.deps.providers[providerKey];
    if (!provider.ok) return failure(503, "WRITING_CANDIDATE_PROVIDER_UNCONFIGURED", { providerKey, missing: provider.missing });
    const model = start.model ?? provider.models[0]!;
    if (!provider.models.includes(model)) return failure(400, "WRITING_CANDIDATE_MODEL_UNAVAILABLE", { providerKey });
    const created = await this.deps.store.create(build(providerKey, model), {
      sinceIso: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      maxCallsPerDay: this.deps.maxCallsPerDay,
    });
    switch (created.kind) {
      case "created":
        this.schedule(created.record.id);
        return this.found(created.record, projectId, 202);
      case "existing":
        return this.found(created.record, projectId);
      case "conflict":
        return failure(409, "IDEMPOTENCY_KEY_REUSED");
      case "active":
        return failure(409, "WRITING_CANDIDATE_ACTIVE", { requestId: created.requestId });
      case "needs_confirmation":
        return failure(409, "WRITING_CANDIDATE_NEEDS_CONFIRMATION", { requestId: created.requestId });
      case "target_invalid":
        return failure(409, "WRITING_CANDIDATE_TARGET_INVALID", { reason: created.reason });
      default:
        return failure(429, "WRITING_CANDIDATE_DAILY_CAP");
    }
  }

  async get(projectId: string, requestId: string): Promise<WritingCandidateResult> {
    const refused = await this.readable(projectId);
    if (refused) return refused;
    return this.found(await this.deps.store.get(this.deps.workspaceId, projectId, requestId), projectId);
  }

  async list(projectId: string, query: unknown): Promise<WritingCandidateResult> {
    const parsed = listQuerySchema.safeParse(query);
    if (!parsed.success) return failure(400, "VALIDATION_ERROR", { field: "query" });
    const refused = await this.readable(projectId);
    if (refused) return refused;
    const records = await this.deps.store.listForTarget(this.deps.workspaceId, projectId,
      { mode: parsed.data.mode, episodeId: parsed.data.episodeId ?? null }, 10);
    return { status: 200, body: { items: records.map(writingCandidateView) } };
  }

  /** Recovery of expired leases of this workspace, whether or not the feature is on. Never sends. */
  async maintain(): Promise<void> {
    if (!await this.deps.store.storageReady()) return;
    await this.deps.executor.maintain();
  }
}
