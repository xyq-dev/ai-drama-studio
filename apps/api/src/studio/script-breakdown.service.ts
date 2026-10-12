import { timingSafeEqual } from "node:crypto";
import {
  SCRIPT_BREAKDOWN_CALL_CAP,
  SCRIPT_BREAKDOWN_LIMITS,
  SCRIPT_BREAKDOWN_REQUIRED_CALLS,
  TITLE_WRITING_PROVIDER_KEYS,
  scriptBreakdownPlaceSchema,
  scriptBreakdownStartSchema,
  titleWritingResumeSchema,
  type ScriptBreakdownOptionsView,
  type TitleWritingProviderKey,
  type TitleWritingStore,
} from "@ai-drama/contracts";
import { scriptTextOf } from "@ai-drama/domain";
import type { RuntimeStore } from "@ai-drama/database";
import {
  WRITING_ADAPTERS,
  hashScriptBreakdownRequest,
  hashTitleResume,
  isScriptBreakdownRun,
  newScriptBreakdownRun,
  scriptBreakdownRunView,
  type TitleRunBundle,
  type TitleWritingEngine,
  type WritingProviderConfig,
} from "@ai-drama/providers";
import type { StudioContext } from "./studio.service";

export interface ScriptBreakdownDependencies {
  workspaceId: string;
  nodeEnv: "development" | "test" | "production";
  /** The title writing switch: a breakdown is the same kind of paid text call and is never enabled on its own. */
  enabled: boolean;
  operatorToken: string | null;
  defaultProvider: TitleWritingProviderKey | null;
  providers: Record<TitleWritingProviderKey, WritingProviderConfig>;
  store: TitleWritingStore;
  /** The title writing engine of this workspace: it drives runs of both kinds. */
  engine: Pick<TitleWritingEngine, "workspaceId" | "drive">;
  projects: Pick<RuntimeStore, "getProject">;
  maxCallsPerDay: number;
  maxActiveRuns: number;
  clock?: () => Date;
  schedule?: (work: () => Promise<void>) => void;
}

export interface ScriptBreakdownResult {
  status: number;
  body: unknown;
}

const MESSAGES: Record<string, string> = {
  TITLE_WRITING_DISABLED: "AI 写作没有开启，不能拆解。仍可手动编写场景和镜头。",
  TITLE_WRITING_FORBIDDEN: "操作者令牌不正确，没有启动任何调用。",
  TITLE_WRITING_STORAGE_UNAVAILABLE: "写作任务存储还没有就绪（数据库表未创建），没有启动任何调用。",
  SCRIPT_BREAKDOWN_STORAGE_UNAVAILABLE: "剧本拆解的数据库迁移还没有执行，没有启动任何调用。",
  TITLE_WRITING_PROVIDER_UNCONFIGURED: "所选模型服务还没有配置完整，没有启动任何调用。",
  TITLE_WRITING_MODEL_UNAVAILABLE: "所选模型不在服务端允许的列表中。",
  TITLE_WRITING_RUN_ACTIVE: "这部作品已有一个 AI 任务正在进行，请等它结束。",
  TITLE_WRITING_ACTIVE_RUN_CAP: "同时进行的 AI 任务已达上限，请等当前任务结束。",
  TITLE_WRITING_DAILY_QUOTA_LOW: "最近 24 小时的调用次数已用完，没有创建任务，也没有发出任何调用。",
  IDEMPOTENCY_KEY_REUSED: "同一个请求标识被用于不同的内容，已拒绝。",
  TITLE_WRITING_NEEDS_CONFIRMATION: "有结果不确定的调用，可能已经计费。确认后才会重新发送。",
  TITLE_WRITING_CONFIRMATION_STALE: "确认的不确定调用和现在的不一致，没有重新发送。请重新查看后再确认。",
  TITLE_WRITING_NOT_RESUMABLE: "这次拆解没有需要续跑的步骤。",
  SCRIPT_BREAKDOWN_SOURCE_CHANGED: "这次拆解的来源剧本已被新版本取代、未批准或已过期，没有续跑，也没有发出调用。原结果保留；请对当前已批准的剧本重新拆解。",
  SCRIPT_BREAKDOWN_NO_SCRIPT: "这一集还没有剧本。",
  SCRIPT_REVIEW_REQUIRED: "这一集的当前剧本还没有通过审核（或已过期）。剧本批准后才能拆解。",
  SCRIPT_BREAKDOWN_SCRIPT_UNSUPPORTED: "这一集的剧本不是纯文本正文，无法拆解。",
  SCRIPT_BREAKDOWN_SCRIPT_TOO_LARGE: `剧本正文超过 ${String(SCRIPT_BREAKDOWN_LIMITS.scriptMaxChars)} 字，没有启动任何调用。`,
  SCRIPT_BREAKDOWN_TOO_MANY_CHARACTERS: `作品角色超过 ${String(SCRIPT_BREAKDOWN_LIMITS.maxCharacters)} 个，没有启动任何调用。`,
  SCRIPT_BREAKDOWN_EXISTING_SCENES: "这一集已经有场景。确认用新结果取代后才能拆解（旧版本会保留）。",
  SCRIPT_BREAKDOWN_NOT_SAVED: "拆解结果尚未就绪，或来源剧本已更新、未批准、已过期，不能写入镜头。请刷新查看当前来源。",
  NOT_FOUND: "没有找到这次拆解。",
  EPISODE_NOT_FOUND: "没有找到这一集。",
  VALIDATION_ERROR: "请求内容无效。",
};

function failure(status: number, code: string, details?: Record<string, unknown>): ScriptBreakdownResult {
  return { status, body: { error: { code, message: MESSAGES[code] ?? "请求失败", ...(details ? { details } : {}) } } };
}

function sameToken(configured: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const left = Buffer.from(configured, "utf8");
  const right = Buffer.from(presented, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Episode-scoped script breakdown. Starting and resuming may cost money: they need the title writing switch, the
 * operator token, ready storage (title writing tables and the breakdown migration), an approved current script and a
 * configured provider before anything is reserved. Reads never call a provider.
 */
export class ScriptBreakdownService {
  constructor(private readonly deps: ScriptBreakdownDependencies) {
    if (deps.engine.workspaceId !== deps.workspaceId) throw new Error("script breakdown engine is bound to another workspace");
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

  private async storageReady(): Promise<boolean> {
    return await this.deps.store.storageReady() && await this.deps.store.breakdownStorageReady();
  }

  /**
   * The provider a new start uses when the request names none, and the default that options() reports: the configured
   * default when it is ready, otherwise the first ready provider in the fixed order; null when none is ready. A provider
   * the request names is used as named, never replaced by this.
   */
  private readyDefault(): TitleWritingProviderKey | null {
    const configured = this.deps.defaultProvider;
    if (configured && this.deps.providers[configured].ok) return configured;
    return TITLE_WRITING_PROVIDER_KEYS.find((key) => this.deps.providers[key].ok) ?? null;
  }

  async options(): Promise<ScriptBreakdownResult> {
    const storageReady = await this.storageReady();
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
    const code = !this.active() ? "TITLE_WRITING_DISABLED"
      : !this.deps.operatorToken ? "TITLE_WRITING_FORBIDDEN"
        : !storageReady ? "SCRIPT_BREAKDOWN_STORAGE_UNAVAILABLE"
          : firstReady === null ? "TITLE_WRITING_PROVIDER_UNCONFIGURED" : "SCRIPT_BREAKDOWN_READY";
    const body: ScriptBreakdownOptionsView = {
      enabled: this.active(),
      code,
      storageReady,
      operatorTokenRequired: true,
      defaultProvider: this.readyDefault(),
      providers,
      maxCallsPerDay: this.deps.maxCallsPerDay,
      callCapPerRun: SCRIPT_BREAKDOWN_CALL_CAP,
      billing: "unknown",
      limits: SCRIPT_BREAKDOWN_LIMITS,
    };
    return { status: 200, body };
  }

  /** Switch, token, then storage: every refusal happens before any reservation or provider send. */
  private async gate(token: string | undefined): Promise<ScriptBreakdownResult | null> {
    if (!this.active()) return failure(404, "TITLE_WRITING_DISABLED");
    if (!this.deps.operatorToken || !sameToken(this.deps.operatorToken, token)) return failure(403, "TITLE_WRITING_FORBIDDEN");
    if (!await this.deps.store.storageReady()) return failure(503, "TITLE_WRITING_STORAGE_UNAVAILABLE");
    if (!await this.deps.store.breakdownStorageReady()) return failure(503, "SCRIPT_BREAKDOWN_STORAGE_UNAVAILABLE");
    return null;
  }

  private async readable(projectId: string): Promise<ScriptBreakdownResult | null> {
    await this.deps.projects.getProject(this.deps.workspaceId, projectId);
    if (!await this.storageReady()) return failure(503, "SCRIPT_BREAKDOWN_STORAGE_UNAVAILABLE");
    return null;
  }

  /** A breakdown run of exactly this work and episode, or null (a title run or another episode's run is not found). */
  private ofEpisode(bundle: TitleRunBundle | null, projectId: string, episodeId: string): TitleRunBundle | null {
    if (!bundle || !isScriptBreakdownRun(bundle.run) || bundle.run.projectId !== projectId || bundle.run.input.episodeId !== episodeId) return null;
    return bundle;
  }

  private async view(bundle: TitleRunBundle, status = 200): Promise<ScriptBreakdownResult> {
    const details = await this.deps.store.breakdownDetails(this.deps.workspaceId, bundle.run);
    return { status, body: { run: scriptBreakdownRunView(bundle, details) } };
  }

  async start(projectId: string, episodeId: string, body: unknown, token: string | undefined, context: StudioContext): Promise<ScriptBreakdownResult> {
    const refused = await this.gate(token);
    if (refused) return refused;
    if (!context.idempotencyKey || context.idempotencyKey.length > 200) return failure(400, "VALIDATION_ERROR", { field: "Idempotency-Key" });
    await this.deps.projects.getProject(this.deps.workspaceId, projectId);
    const parsed = scriptBreakdownStartSchema.safeParse(body ?? {});
    if (!parsed.success) return failure(400, "VALIDATION_ERROR", { field: parsed.error.issues[0]?.path.join(".") ?? "body" });
    const requestHash = hashScriptBreakdownRequest(projectId, { episodeId, providerKey: parsed.data.providerKey ?? null,
      model: parsed.data.model ?? null, replaceExisting: parsed.data.replaceExisting });

    // A replay is answered from the run this key created, before anything is read again or resolved from the current
    // settings: the script, the scenes (the run itself replaces scenes), the default provider and model or a provider's
    // configuration may have changed since, and a replay must never create or freeze a second run. The run must belong
    // to this work and episode, which the caller reached above.
    const previous = await this.deps.store.findRunByKey(this.deps.workspaceId, context.actorId, context.idempotencyKey);
    if (previous) {
      const same = this.ofEpisode(previous, projectId, episodeId);
      return same && same.run.inputHash === requestHash ? this.view(same) : failure(409, "IDEMPOTENCY_KEY_REUSED");
    }

    // A new request takes the current settings: the provider it names, else the ready default options() reports. Both are
    // frozen into the run; replays (above), resumes and recovery keep them.
    const providerKey = parsed.data.providerKey ?? this.readyDefault() ?? this.deps.defaultProvider ?? TITLE_WRITING_PROVIDER_KEYS[0];
    const provider = this.deps.providers[providerKey];
    if (!provider.ok) return failure(503, "TITLE_WRITING_PROVIDER_UNCONFIGURED", { providerKey, missing: provider.missing });
    const model = parsed.data.model ?? provider.models[0]!;
    if (!provider.models.includes(model)) return failure(400, "TITLE_WRITING_MODEL_UNAVAILABLE", { providerKey });

    const source = await this.deps.store.breakdownSource(this.deps.workspaceId, projectId, episodeId);
    if (source.kind === "not_found") return failure(404, "EPISODE_NOT_FOUND");
    if (source.kind === "script_missing") return failure(409, "SCRIPT_BREAKDOWN_NO_SCRIPT");
    if (source.kind !== "ok") return failure(409, "SCRIPT_REVIEW_REQUIRED");
    const scriptText = scriptTextOf(source.scriptContent);
    if (scriptText === null || scriptText.trim().length === 0) return failure(422, "SCRIPT_BREAKDOWN_SCRIPT_UNSUPPORTED");
    if (scriptText.length > SCRIPT_BREAKDOWN_LIMITS.scriptMaxChars) {
      return failure(422, "SCRIPT_BREAKDOWN_SCRIPT_TOO_LARGE", { chars: scriptText.length, maxChars: SCRIPT_BREAKDOWN_LIMITS.scriptMaxChars });
    }
    if (source.characters.length > SCRIPT_BREAKDOWN_LIMITS.maxCharacters) {
      return failure(422, "SCRIPT_BREAKDOWN_TOO_MANY_CHARACTERS", { characters: source.characters.length });
    }
    if (source.scenes.length > 0 && !parsed.data.replaceExisting) {
      return failure(409, "SCRIPT_BREAKDOWN_EXISTING_SCENES", { sceneCount: source.scenes.length, shotCount: source.shots.length });
    }
    const startedAt = this.now();
    const run = newScriptBreakdownRun({
      workspaceId: this.deps.workspaceId,
      projectId,
      actorId: context.actorId,
      idempotencyKey: context.idempotencyKey,
      requestHash,
      now: startedAt,
      input: {
        episodeId,
        episodeNo: source.episodeNo,
        scriptRevisionId: source.scriptRevisionId,
        scriptRevisionNo: source.scriptRevisionNo,
        scriptContentHash: source.scriptContentHash,
        scriptText,
        targetEpisodeSeconds: source.targetEpisodeSeconds,
        characters: source.characters.map((item, index) => ({ key: `C${String(index + 1)}`, ...item })),
        replace: { scenes: source.scenes, shots: source.shots },
        providerKey,
        model,
      },
    });
    const created = await this.deps.store.createRun(run, {
      maxActiveRuns: this.deps.maxActiveRuns,
      quota: {
        sinceIso: new Date(startedAt.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        maxCallsPerDay: this.deps.maxCallsPerDay,
        requiredCalls: SCRIPT_BREAKDOWN_REQUIRED_CALLS,
      },
    });
    if (created.kind === "blocked") {
      return created.code === "TITLE_WRITING_DAILY_QUOTA_LOW"
        ? failure(429, created.code, { requiredCalls: created.requiredCalls, remainingCalls: created.remainingCalls })
        : failure(429, created.code);
    }
    // One AI task per work: name the kind of the running task, never offer its run here.
    if (created.kind === "active") return failure(409, "TITLE_WRITING_RUN_ACTIVE", { taskKind: isScriptBreakdownRun(created.bundle.run) ? "script_breakdown" : "title" });
    const mine = this.ofEpisode(created.bundle, projectId, episodeId);
    if (created.kind === "conflict" || !mine || mine.run.inputHash !== requestHash) return failure(409, "IDEMPOTENCY_KEY_REUSED");
    if (created.kind === "created") this.schedule(mine.run.id);
    return this.view(mine, created.kind === "created" ? 201 : 200);
  }

  async latest(projectId: string, episodeId: string): Promise<ScriptBreakdownResult> {
    const refused = await this.readable(projectId);
    if (refused) return refused;
    const bundle = this.ofEpisode(await this.deps.store.latestBreakdown(this.deps.workspaceId, projectId, episodeId), projectId, episodeId);
    return bundle ? this.view(bundle) : { status: 200, body: { run: null } };
  }

  /**
   * The newest run of this episode whose result was saved: its scenes may still be current and take their shots after a
   * newer run failed, was canceled or is still running. { run: null } when none was saved. Read only.
   */
  async latestSaved(projectId: string, episodeId: string): Promise<ScriptBreakdownResult> {
    const refused = await this.readable(projectId);
    if (refused) return refused;
    const bundle = this.ofEpisode(await this.deps.store.latestSavedBreakdown(this.deps.workspaceId, projectId, episodeId), projectId, episodeId);
    return bundle && bundle.run.breakdownSave === "saved" ? this.view(bundle) : { status: 200, body: { run: null } };
  }

  async get(projectId: string, episodeId: string, runId: string): Promise<ScriptBreakdownResult> {
    const refused = await this.readable(projectId);
    if (refused) return refused;
    const bundle = this.ofEpisode(await this.deps.store.getRun(this.deps.workspaceId, projectId, runId), projectId, episodeId);
    return bundle ? this.view(bundle) : failure(404, "NOT_FOUND");
  }

  /** Stops the call if it was not sent yet. A call already sent keeps its real outcome; billing stays unknown. */
  async cancel(projectId: string, episodeId: string, runId: string): Promise<ScriptBreakdownResult> {
    const refused = await this.readable(projectId);
    if (refused) return refused;
    if (!this.ofEpisode(await this.deps.store.getRun(this.deps.workspaceId, projectId, runId), projectId, episodeId)) return failure(404, "NOT_FOUND");
    const bundle = await this.deps.store.requestCancel(this.deps.workspaceId, projectId, runId, this.now().toISOString());
    return bundle ? this.view(bundle) : failure(404, "NOT_FOUND");
  }

  /** Same rules as title writing: an uncertain call is resent only after the person confirmed exactly that call. */
  async resume(projectId: string, episodeId: string, runId: string, body: unknown, token: string | undefined, context: StudioContext): Promise<ScriptBreakdownResult> {
    const refused = await this.gate(token);
    if (refused) return refused;
    if (!context.idempotencyKey || context.idempotencyKey.length > 200) return failure(400, "VALIDATION_ERROR", { field: "Idempotency-Key" });
    await this.deps.projects.getProject(this.deps.workspaceId, projectId);
    const parsed = titleWritingResumeSchema.safeParse(body ?? {});
    if (!parsed.success) return failure(400, "VALIDATION_ERROR", { field: parsed.error.issues[0]?.path.join(".") ?? "body" });
    const existing = this.ofEpisode(await this.deps.store.getRun(this.deps.workspaceId, projectId, runId), projectId, episodeId);
    if (!existing) return failure(404, "NOT_FOUND");
    const confirmed = parsed.data.confirmUncertainCallIds;
    const requestHash = hashTitleResume(runId, confirmed);
    // An accepted resume is answered from its receipt (read only, nothing prepared or sent) before the current gates: the
    // provider may have been disabled, the source changed or the run moved on since, and a lost response must stay
    // recoverable. Only a new resume is held to the provider, source and state checks below.
    const receipt = await this.deps.store.findResume(this.deps.workspaceId, projectId, runId, context.idempotencyKey);
    if (receipt) {
      if (receipt.requestHash !== requestHash) return failure(409, "IDEMPOTENCY_KEY_REUSED");
      // Read the run again: an identical request may have committed this receipt after `existing` was read, so the run
      // has moved on (running, or already finished). Same work and episode scope; never the earlier read.
      const current = this.ofEpisode(await this.deps.store.getRun(this.deps.workspaceId, projectId, runId), projectId, episodeId);
      return current ? this.view(current) : failure(404, "NOT_FOUND");
    }
    // The store decides from the run's persisted steps, under its lock, whether this resume sends again: only then must the
    // provider be ready. A run that stopped after its answer was stored only saves it (no call, no reservation).
    const provider = this.deps.providers[existing.run.input.providerKey];
    const prepared = await this.deps.store.prepareResume(this.deps.workspaceId, projectId, runId, {
      resumeKey: context.idempotencyKey,
      requestHash,
      confirmedCallIds: confirmed,
      maxActiveRuns: this.deps.maxActiveRuns,
      providerReady: provider.ok && provider.models.includes(existing.run.input.model),
    }, this.now().toISOString());
    if (prepared.kind === "replayed") return this.view(prepared.bundle);
    if (prepared.kind !== "ok") {
      if (prepared.kind === "not_found") return failure(404, "NOT_FOUND");
      if (prepared.kind === "active") return failure(409, "TITLE_WRITING_RUN_ACTIVE");
      if (prepared.kind === "active_cap") return failure(429, "TITLE_WRITING_ACTIVE_RUN_CAP");
      if (prepared.kind === "needs_confirmation") return failure(409, "TITLE_WRITING_NEEDS_CONFIRMATION");
      if (prepared.kind === "stale_confirmation") return failure(409, "TITLE_WRITING_CONFIRMATION_STALE");
      if (prepared.kind === "key_conflict") return failure(409, "IDEMPOTENCY_KEY_REUSED");
      if (prepared.kind === "source_changed") return failure(409, "SCRIPT_BREAKDOWN_SOURCE_CHANGED");
      if (prepared.kind === "provider_unconfigured") {
        return failure(503, "TITLE_WRITING_PROVIDER_UNCONFIGURED", { providerKey: existing.run.input.providerKey, missing: provider.ok ? [] : provider.missing });
      }
      return failure(409, "TITLE_WRITING_NOT_RESUMABLE");
    }
    this.schedule(runId);
    return this.view(prepared.bundle);
  }

  /**
   * Writes the proposed shots of every scene a person approved. No provider call. Repeating it writes nothing twice:
   * a scene whose shots were written is skipped.
   */
  async placeShots(projectId: string, episodeId: string, runId: string, body: unknown, context: StudioContext): Promise<ScriptBreakdownResult> {
    const refused = await this.readable(projectId);
    if (refused) return refused;
    const parsed = scriptBreakdownPlaceSchema.safeParse(body ?? {});
    if (!parsed.success) return failure(400, "VALIDATION_ERROR");
    const placed = await this.deps.store.placeBreakdownShots(this.deps.workspaceId, projectId, episodeId, runId,
      { acceptSceneChanged: parsed.data.acceptSceneChanged }, context.actorId, this.now().toISOString());
    if (placed.kind === "not_found") return failure(404, "NOT_FOUND");
    if (placed.kind !== "ok") return failure(409, "SCRIPT_BREAKDOWN_NOT_SAVED");
    const result = await this.view(placed.bundle);
    return { status: 200, body: { ...(result.body as Record<string, unknown>), placement: placed.outcome } };
  }
}
