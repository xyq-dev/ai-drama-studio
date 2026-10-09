import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  TITLE_WRITING_PROVIDER_KEYS,
  titleWritingResumeSchema,
  titleWritingSettingsSchema,
  titleWritingStartSchema,
  type TitleWritingOptionsView,
  type TitleWritingProviderKey,
  type TitleWritingStore,
} from "@ai-drama/contracts";
import type { RuntimeStore } from "@ai-drama/database";
import {
  TITLE_WRITING_CALL_CAP_PER_RUN,
  WRITING_ADAPTERS,
  hashTitleResume,
  newTitleRun,
  titleRunView,
  type TitleRunBundle,
  type TitleWritingEngine,
  type WritingProviderConfig,
} from "@ai-drama/providers";
import type { StudioContext } from "./studio.service";

export interface TitleWritingDependencies {
  workspaceId: string;
  nodeEnv: "development" | "test" | "production";
  enabled: boolean;
  operatorToken: string | null;
  defaultProvider: TitleWritingProviderKey | null;
  providers: Record<TitleWritingProviderKey, WritingProviderConfig>;
  store: TitleWritingStore;
  engine: Pick<TitleWritingEngine, "workspaceId" | "drive" | "maintain">;
  projects: Pick<RuntimeStore, "getProject">;
  maxCallsPerDay: number;
  maxActiveRuns: number;
  clock?: () => Date;
  /** Starts server-side work without holding the HTTP request. Tests may run it inline. */
  schedule?: (work: () => Promise<void>) => void;
}

export interface TitleWritingResult {
  status: number;
  body: unknown;
}

const MESSAGES: Record<string, string> = {
  TITLE_WRITING_DISABLED: "AI 一键创作没有开启。仍可手动创作。",
  TITLE_WRITING_FORBIDDEN: "操作者令牌不正确，没有启动任何调用。",
  TITLE_WRITING_STORAGE_UNAVAILABLE: "创作任务存储还没有就绪（数据库表未创建），没有启动任何调用。",
  TITLE_WRITING_PROVIDER_UNCONFIGURED: "所选模型服务还没有配置完整，没有启动任何调用。",
  TITLE_WRITING_MODEL_UNAVAILABLE: "所选模型不在服务端允许的列表中。",
  TITLE_WRITING_RUN_ACTIVE: "这部作品已有一次创作正在进行。",
  TITLE_WRITING_ACTIVE_RUN_CAP: "同时进行的创作已达上限，请等当前创作结束。",
  IDEMPOTENCY_KEY_REUSED: "同一个请求标识被用于不同的内容，已拒绝。",
  TITLE_WRITING_NEEDS_CONFIRMATION: "有结果不确定的调用，可能已经计费。确认后才会重新发送。",
  TITLE_WRITING_CONFIRMATION_STALE: "确认的不确定调用和现在的不一致（可能又出现了新的不确定调用），没有重新发送。请重新查看后再确认。",
  TITLE_WRITING_NOT_RESUMABLE: "这次创作没有需要续跑的步骤。",
  TITLE_WRITING_STORY_NOT_APPROVED: "故事还没有通过审核，剧本暂不能写入分集。",
  TITLE_WRITING_STORY_CHANGED: "审核通过的故事和生成剧本时用的故事不同，请确认后再写入。",
  TITLE_WRITING_NOT_READY: "剧本还没有生成完成。",
  NOT_FOUND: "没有找到这次创作。",
  VALIDATION_ERROR: "请求内容无效。",
};

function failure(status: number, code: string, details?: Record<string, unknown>): TitleWritingResult {
  return { status, body: { error: { code, message: MESSAGES[code] ?? "请求失败", ...(details ? { details } : {}) } } };
}

function sameToken(configured: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const left = Buffer.from(configured, "utf8");
  const right = Buffer.from(presented, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

const placeSchema = z.object({ acceptStoryChanged: z.boolean().default(false) }).strict();

/**
 * Project-scoped title-driven writing. Starting and resuming may cost money, so they need the switch, the operator
 * token, ready storage and a configured provider before anything is reserved. Reads never call a provider.
 */
export class TitleWritingService {
  constructor(private readonly deps: TitleWritingDependencies) {
    // Recovery and execution must never reach another workspace's runs.
    if (deps.engine.workspaceId !== deps.workspaceId) throw new Error("title writing engine is bound to another workspace");
  }

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  private active(): boolean {
    return this.deps.enabled && this.deps.nodeEnv !== "production";
  }

  private schedule(runId: string): void {
    const work = () => this.deps.engine.drive(runId);
    if (this.deps.schedule) {
      this.deps.schedule(work);
      return;
    }
    setImmediate(() => { void work().catch(() => undefined); });
  }

  async options(): Promise<TitleWritingResult> {
    const storageReady = await this.deps.store.storageReady();
    const providers = TITLE_WRITING_PROVIDER_KEYS.map((providerKey) => {
      const config = this.deps.providers[providerKey];
      return {
        providerKey,
        label: WRITING_ADAPTERS[providerKey].label,
        ready: config.ok,
        models: config.models,
        defaultModel: config.models[0] ?? null,
        missing: config.ok ? [] : config.missing,
      };
    });
    const firstReady = providers.find((item) => item.ready)?.providerKey ?? null;
    const configuredDefault = this.deps.defaultProvider && this.deps.providers[this.deps.defaultProvider].ok ? this.deps.defaultProvider : null;
    const code = !this.active() ? "TITLE_WRITING_DISABLED"
      : !this.deps.operatorToken ? "TITLE_WRITING_FORBIDDEN"
        : !storageReady ? "TITLE_WRITING_STORAGE_UNAVAILABLE"
          : firstReady === null ? "TITLE_WRITING_PROVIDER_UNCONFIGURED" : "TITLE_WRITING_READY";
    const body: TitleWritingOptionsView = {
      enabled: this.active(),
      code,
      storageReady,
      operatorTokenRequired: true,
      defaultProvider: configuredDefault ?? firstReady,
      providers,
      maxCallsPerDay: this.deps.maxCallsPerDay,
      maxActiveRuns: this.deps.maxActiveRuns,
      callCapPerRun: TITLE_WRITING_CALL_CAP_PER_RUN,
      billing: "unknown",
      defaults: titleWritingSettingsSchema.parse({}),
    };
    return { status: 200, body };
  }

  /** Switch, token, then storage: every refusal happens before any reservation or provider send. */
  private async gate(token: string | undefined): Promise<TitleWritingResult | null> {
    if (!this.active()) return failure(404, "TITLE_WRITING_DISABLED");
    if (!this.deps.operatorToken || !sameToken(this.deps.operatorToken, token)) return failure(403, "TITLE_WRITING_FORBIDDEN");
    if (!await this.deps.store.storageReady()) return failure(503, "TITLE_WRITING_STORAGE_UNAVAILABLE");
    return null;
  }

  private async readable(projectId: string): Promise<TitleWritingResult | null> {
    await this.deps.projects.getProject(this.deps.workspaceId, projectId);
    if (!await this.deps.store.storageReady()) return failure(503, "TITLE_WRITING_STORAGE_UNAVAILABLE");
    return null;
  }

  private found(bundle: TitleRunBundle | null, status = 200): TitleWritingResult {
    return bundle ? { status, body: { run: titleRunView(bundle) } } : failure(404, "NOT_FOUND");
  }

  async start(projectId: string, body: unknown, token: string | undefined, context: StudioContext): Promise<TitleWritingResult> {
    const refused = await this.gate(token);
    if (refused) return refused;
    if (!context.idempotencyKey || context.idempotencyKey.length > 200) return failure(400, "VALIDATION_ERROR", { field: "Idempotency-Key" });
    await this.deps.projects.getProject(this.deps.workspaceId, projectId);
    const parsed = titleWritingStartSchema.safeParse(body);
    if (!parsed.success) return failure(400, "VALIDATION_ERROR", { field: parsed.error.issues[0]?.path.join(".") ?? "body" });
    const providerKey = parsed.data.providerKey ?? this.deps.defaultProvider
      ?? TITLE_WRITING_PROVIDER_KEYS.find((key) => this.deps.providers[key].ok) ?? "qwen";
    const provider = this.deps.providers[providerKey];
    if (!provider.ok) return failure(503, "TITLE_WRITING_PROVIDER_UNCONFIGURED", { providerKey, missing: provider.missing });
    const model = parsed.data.model ?? provider.models[0]!;
    if (!provider.models.includes(model)) return failure(400, "TITLE_WRITING_MODEL_UNAVAILABLE", { providerKey });
    const settings = titleWritingSettingsSchema.parse(parsed.data.settings ?? {});
    const run = newTitleRun({
      workspaceId: this.deps.workspaceId,
      projectId,
      actorId: context.actorId,
      idempotencyKey: context.idempotencyKey,
      title: parsed.data.title,
      settings,
      providerKey,
      model,
      now: this.now(),
    });
    const created = await this.deps.store.createRun(run, { maxActiveRuns: this.deps.maxActiveRuns });
    if (created.kind === "blocked") return failure(429, created.code);
    if (created.kind === "conflict") return failure(409, "IDEMPOTENCY_KEY_REUSED");
    if (created.kind === "active") return failure(409, "TITLE_WRITING_RUN_ACTIVE", { runId: created.bundle.run.id });
    if (created.bundle.run.projectId !== projectId) return failure(409, "IDEMPOTENCY_KEY_REUSED");
    if (created.kind === "created") this.schedule(created.bundle.run.id);
    return this.found(created.bundle, created.kind === "created" ? 201 : 200);
  }

  async latest(projectId: string): Promise<TitleWritingResult> {
    const refused = await this.readable(projectId);
    if (refused) return refused;
    const bundle = await this.deps.store.latestRun(this.deps.workspaceId, projectId);
    return { status: 200, body: { run: bundle ? titleRunView(bundle) : null } };
  }

  async get(projectId: string, runId: string): Promise<TitleWritingResult> {
    const refused = await this.readable(projectId);
    if (refused) return refused;
    return this.found(await this.deps.store.getRun(this.deps.workspaceId, projectId, runId));
  }

  /** Stops later steps. A call already sent keeps its real outcome; billing stays unknown either way. */
  async cancel(projectId: string, runId: string): Promise<TitleWritingResult> {
    const refused = await this.readable(projectId);
    if (refused) return refused;
    return this.found(await this.deps.store.requestCancel(this.deps.workspaceId, projectId, runId, this.now().toISOString()));
  }

  /**
   * Resumes only what the person saw: the confirmation must name exactly the run's current uncertain calls, checked in
   * the store transaction. The Idempotency-Key identifies this one action; a replay after a lost receipt returns the
   * current run and never resets or sends anything again.
   */
  async resume(projectId: string, runId: string, body: unknown, token: string | undefined, context: StudioContext): Promise<TitleWritingResult> {
    const refused = await this.gate(token);
    if (refused) return refused;
    if (!context.idempotencyKey || context.idempotencyKey.length > 200) return failure(400, "VALIDATION_ERROR", { field: "Idempotency-Key" });
    await this.deps.projects.getProject(this.deps.workspaceId, projectId);
    const parsed = titleWritingResumeSchema.safeParse(body ?? {});
    if (!parsed.success) return failure(400, "VALIDATION_ERROR", { field: parsed.error.issues[0]?.path.join(".") ?? "body" });
    const existing = await this.deps.store.getRun(this.deps.workspaceId, projectId, runId);
    if (!existing) return failure(404, "NOT_FOUND");
    const provider = this.deps.providers[existing.run.input.providerKey];
    if (!provider.ok || !provider.models.includes(existing.run.input.model)) {
      return failure(503, "TITLE_WRITING_PROVIDER_UNCONFIGURED", { providerKey: existing.run.input.providerKey, missing: provider.ok ? [] : provider.missing });
    }
    const confirmed = parsed.data.confirmUncertainCallIds;
    const prepared = await this.deps.store.prepareResume(this.deps.workspaceId, projectId, runId, {
      resumeKey: context.idempotencyKey,
      requestHash: hashTitleResume(runId, confirmed),
      confirmedCallIds: confirmed,
      maxActiveRuns: this.deps.maxActiveRuns,
    }, this.now().toISOString());
    if (prepared.kind === "replayed") return this.found(prepared.bundle);
    if (prepared.kind !== "ok") {
      if (prepared.kind === "not_found") return failure(404, "NOT_FOUND");
      if (prepared.kind === "active") return failure(409, "TITLE_WRITING_RUN_ACTIVE", { runId });
      if (prepared.kind === "active_cap") return failure(429, "TITLE_WRITING_ACTIVE_RUN_CAP");
      if (prepared.kind === "needs_confirmation") return failure(409, "TITLE_WRITING_NEEDS_CONFIRMATION");
      if (prepared.kind === "stale_confirmation") return failure(409, "TITLE_WRITING_CONFIRMATION_STALE");
      if (prepared.kind === "key_conflict") return failure(409, "IDEMPOTENCY_KEY_REUSED");
      return failure(409, "TITLE_WRITING_NOT_RESUMABLE");
    }
    this.schedule(runId);
    return this.found(prepared.bundle);
  }

  async placeScripts(projectId: string, runId: string, body: unknown, context: StudioContext): Promise<TitleWritingResult> {
    const refused = await this.readable(projectId);
    if (refused) return refused;
    const parsed = placeSchema.safeParse(body ?? {});
    if (!parsed.success) return failure(400, "VALIDATION_ERROR");
    const placed = await this.deps.store.placeScripts(this.deps.workspaceId, projectId, runId,
      { acceptStoryChanged: parsed.data.acceptStoryChanged }, context.actorId, this.now().toISOString());
    if (placed.kind !== "ok") {
      if (placed.kind === "not_found") return failure(404, "NOT_FOUND");
      if (placed.kind === "not_ready") return failure(409, "TITLE_WRITING_NOT_READY");
      if (placed.kind === "story_not_approved") return failure(409, "TITLE_WRITING_STORY_NOT_APPROVED");
      return failure(409, "TITLE_WRITING_STORY_CHANGED");
    }
    return this.found(placed.bundle);
  }

  /**
   * Fences expired executors of this workspace always; continues its runs (which may send) only while the feature is
   * on. Runs of other workspaces are never read, fenced, finished or sent for.
   */
  async maintain(): Promise<void> {
    if (!await this.deps.store.storageReady()) return;
    if (this.active()) {
      await this.deps.engine.maintain();
      return;
    }
    await this.deps.store.recoverExpired(this.deps.workspaceId, this.now().toISOString());
  }
}
