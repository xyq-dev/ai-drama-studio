import { z } from "zod";
import {
  TITLE_WRITING_DEFAULT_EPISODE_COUNT,
  TITLE_WRITING_DEFAULT_EPISODE_SECONDS,
  TITLE_WRITING_EPISODE_SECONDS_CHOICES,
  TITLE_WRITING_MAX_EPISODES,
  TITLE_WRITING_MIN_EPISODES,
  TITLE_WRITING_PROVIDER_KEYS,
  TITLE_WRITING_PROVIDER_LABELS,
  TITLE_WRITING_PROVIDER_PREFERENCE,
  isActiveTitleWritingProvider,
  isLegacyDeepseekRun,
  titleWritingRequiredCalls,
  titleWritingResumeSchema,
  titleWritingSettingsSchema,
  titleWritingStartSchema,
  type TitleWritingOptionsView,
  type TitleWritingProviderKey,
  type TitleWritingSettings,
  type TitleWritingStart,
  type TitleWritingStore,
} from "@ai-drama/contracts";
import type { RuntimeStore } from "@ai-drama/database";
import {
  TITLE_WRITING_CALL_CAP_PER_RUN,
  WRITING_ADAPTERS,
  hashTitleResume,
  isScriptBreakdownRun,
  newTitleRun,
  providerConfigFor,
  sameStartBeforeGuidance,
  titleRunView,
  type TitleRunBundle,
  type TitleWritingEngine,
  type WritingProviderConfig,
} from "@ai-drama/providers";
import type { StudioContext } from "./studio.service";
import { operatorAllowed, operatorConfigured, type OperatorProof } from "./operator-access";

export interface TitleWritingDependencies {
  workspaceId: string;
  nodeEnv: "development" | "test" | "production";
  enabled: boolean;
  /** Explicit production authorization, pre-gated by the runtime on TITLE_WRITING_ALLOW_PRODUCTION and a valid site login. */
  allowProduction?: boolean;
  operatorToken: string | null;
  /** The site login is on: its signed-in administrator is the operator (see operator-access.ts). */
  siteOperator?: boolean;
  defaultProvider: TitleWritingProviderKey | null;
  providers: Record<TitleWritingProviderKey, WritingProviderConfig>;
  store: TitleWritingStore;
  engine: Pick<TitleWritingEngine, "workspaceId" | "drive" | "maintain">;
  /** The project and its episode plan: the plan, not the request, decides N, the target seconds and the version. */
  projects: Pick<RuntimeStore, "getProject" | "getProjectEpisodePlan" | "episodePlanReady">;
  maxCallsPerDay: number;
  maxActiveRuns: number;
  /** Whether the model console holds saved settings waiting for the API restart (options only; never gates a send). */
  configurationPending?: () => Promise<boolean>;
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
  TITLE_WRITING_FORBIDDEN: "没有调用权限（需要管理员登录，或在未启用站点登录时提供正确的操作者令牌），没有启动任何调用。",
  TITLE_WRITING_STORAGE_UNAVAILABLE: "创作任务存储还没有就绪（数据库表未创建），没有启动任何调用。",
  TITLE_WRITING_PROVIDER_UNCONFIGURED: "所选模型服务还没有配置完整，没有启动任何调用。",
  TITLE_WRITING_PROVIDER_RETIRED: "这个模型服务已经退役，不能再发起新的创作或重新发送调用。历史记录仍然保留，可以查看。",
  TITLE_WRITING_PROVIDER_STORAGE_UNAVAILABLE: "所选模型服务的数据库迁移还没有执行，没有创建任务，也没有发出调用。",
  TITLE_WRITING_MODEL_UNAVAILABLE: "所选模型不在服务端允许的列表中。",
  TITLE_WRITING_LEGACY_RUN: "这次任务是 DeepSeek 退役前创建的旧任务，不会再发出请求，也不会改用新的 DeepSeek 模型或其他供应商；已有结果、调用记录和未知费用都保留。如需继续，请新建任务。",
  TITLE_WRITING_RUN_MODEL_UNAVAILABLE: "这次任务冻结的模型已不在服务端允许的列表中，不会改用其他模型，没有发出调用。",
  TITLE_WRITING_RUN_ACTIVE: "这部作品已有一次创作正在进行。",
  TITLE_WRITING_OTHER_TASK_ACTIVE: "这部作品正在进行剧本拆解，标题创作暂时不能开始。没有创建任务，也没有发出调用。",
  TITLE_WRITING_ACTIVE_RUN_CAP: "同时进行的创作已达上限，请等当前创作结束。",
  IDEMPOTENCY_KEY_REUSED: "同一个请求标识被用于不同的内容，已拒绝。",
  TITLE_WRITING_NEEDS_CONFIRMATION: "有结果不确定的调用，可能已经计费。确认后才会重新发送。",
  TITLE_WRITING_CONFIRMATION_STALE: "确认的不确定调用和现在的不一致（可能又出现了新的不确定调用），没有重新发送。请重新查看后再确认。",
  TITLE_WRITING_NOT_RESUMABLE: "这次创作没有需要续跑的步骤。",
  TITLE_WRITING_STORY_NOT_APPROVED: "故事还没有通过审核，剧本暂不能写入分集。",
  TITLE_WRITING_PLAN_MISMATCH: "作品的集数设置和这次创作不一致，没有发出任何调用，也没有写入剧本。",
  TITLE_WRITING_EPISODE_PLAN_UNAVAILABLE: "集数设置的数据库迁移还没有执行，没有启动任何调用。",
  TITLE_WRITING_DAILY_QUOTA_LOW: "最近 24 小时剩余的调用次数不够完成这次创作，没有创建任务，也没有发出任何调用。",
  TITLE_WRITING_STORY_CHANGED: "审核通过的故事和生成剧本时用的故事不同，请确认后再写入。",
  TITLE_WRITING_NOT_READY: "剧本还没有生成完成。",
  NOT_FOUND: "没有找到这次创作。",
  VALIDATION_ERROR: "请求内容无效。",
};

function failure(status: number, code: string, details?: Record<string, unknown>): TitleWritingResult {
  return { status, body: { error: { code, message: MESSAGES[code] ?? "请求失败", ...(details ? { details } : {}) } } };
}


/** Named in an option's missing list while the database cannot store runs of that provider. Never a value. */
export const PROVIDER_MIGRATION_GAP = "WRITING_PROVIDER_MIGRATION";

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
    return this.deps.enabled && (this.deps.nodeEnv !== "production" || this.deps.allowProduction === true);
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
    const providers = await Promise.all(TITLE_WRITING_PROVIDER_KEYS.map(async (providerKey) => {
      const config = this.deps.providers[providerKey];
      // A provider whose runs the database cannot store yet (Claude before its migration) is not offered as ready.
      const stored = storageReady && await this.deps.store.providerStorageReady(providerKey);
      const missing = [...(config.ok ? [] : config.missing), ...(storageReady && !stored ? [PROVIDER_MIGRATION_GAP] : [])];
      return {
        providerKey,
        label: WRITING_ADAPTERS[providerKey].label,
        ready: config.ok && (!storageReady || stored),
        models: config.models,
        defaultModel: config.models[0] ?? null,
        missing,
      };
    }));
    // Without a ready configured default, Claude is offered first (TITLE_WRITING_PROVIDER_PREFERENCE).
    const firstReady = TITLE_WRITING_PROVIDER_PREFERENCE.find((key) => providers.find((item) => item.providerKey === key)?.ready) ?? null;
    // A configured default is reported even when it is not ready: the page shows why and never substitutes another one.
    const configuredDefault = this.deps.defaultProvider ?? null;
    const code = !this.active() ? "TITLE_WRITING_DISABLED"
      : !operatorConfigured(this.deps) ? "TITLE_WRITING_FORBIDDEN"
        : !storageReady ? "TITLE_WRITING_STORAGE_UNAVAILABLE"
          : firstReady === null ? "TITLE_WRITING_PROVIDER_UNCONFIGURED" : "TITLE_WRITING_READY";
    const body: TitleWritingOptionsView = {
      enabled: this.active(),
      code,
      storageReady,
      operatorTokenRequired: this.deps.siteOperator !== true,
      defaultProvider: configuredDefault ?? firstReady,
      providers,
      configurationPending: await this.configurationPending(),
      maxCallsPerDay: this.deps.maxCallsPerDay,
      maxActiveRuns: this.deps.maxActiveRuns,
      callCapPerRun: TITLE_WRITING_CALL_CAP_PER_RUN,
      billing: "unknown",
      defaults: titleWritingSettingsSchema.parse({}),
      episodePlan: {
        minEpisodes: TITLE_WRITING_MIN_EPISODES,
        maxEpisodes: TITLE_WRITING_MAX_EPISODES,
        defaultEpisodes: TITLE_WRITING_DEFAULT_EPISODE_COUNT,
        secondsChoices: [...TITLE_WRITING_EPISODE_SECONDS_CHOICES],
        defaultSeconds: TITLE_WRITING_DEFAULT_EPISODE_SECONDS,
      },
      episodePlanReady: await this.deps.projects.episodePlanReady(),
    };
    return { status: 200, body };
  }

  /** Whether the console holds saved settings the API has not applied yet. Unknown counts as not pending. */
  private async configurationPending(): Promise<boolean> {
    try {
      return this.deps.configurationPending ? await this.deps.configurationPending() : false;
    } catch {
      return false;
    }
  }

  /** Switch, token, then storage: every refusal happens before any reservation or provider send. */
  private async gate(token: OperatorProof | string | undefined): Promise<TitleWritingResult | null> {
    if (!this.active()) return failure(404, "TITLE_WRITING_DISABLED");
    if (!operatorAllowed(this.deps, token)) return failure(403, "TITLE_WRITING_FORBIDDEN");
    if (!await this.deps.store.storageReady()) return failure(503, "TITLE_WRITING_STORAGE_UNAVAILABLE");
    return null;
  }

  private async readable(projectId: string): Promise<TitleWritingResult | null> {
    await this.deps.projects.getProject(this.deps.workspaceId, projectId);
    if (!await this.deps.store.storageReady()) return failure(503, "TITLE_WRITING_STORAGE_UNAVAILABLE");
    return null;
  }

  /** A script breakdown run is not a title run: these routes never show, cancel, resume or place one. */
  private found(bundle: TitleRunBundle | null, status = 200): TitleWritingResult {
    return bundle && !isScriptBreakdownRun(bundle.run) ? { status, body: { run: titleRunView(bundle) } } : failure(404, "NOT_FOUND");
  }

  async start(projectId: string, body: unknown, token: OperatorProof | string | undefined, context: StudioContext): Promise<TitleWritingResult> {
    const refused = await this.gate(token);
    if (refused) return refused;
    if (!context.idempotencyKey || context.idempotencyKey.length > 200) return failure(400, "VALIDATION_ERROR", { field: "Idempotency-Key" });
    await this.deps.projects.getProject(this.deps.workspaceId, projectId);
    const parsed = titleWritingStartSchema.safeParse(body);
    if (!parsed.success) return failure(400, "VALIDATION_ERROR", { field: parsed.error.issues[0]?.path.join(".") ?? "body" });
    const frozen = await this.frozenSettings(projectId, parsed.data.settings);
    if ("refusal" in frozen) return frozen.refusal;
    // A request identity already used is answered from its stored run (createRun below returns it, or refuses a different
    // input), whatever the providers are now: a lost receipt of a start made with a provider that was retired or
    // switched off since must stay recoverable and must never create a second run. Where the replayed body left the
    // provider or model to the server, the stored run's own choice is used. No gate below writes or sends for a replay.
    const previous = await this.deps.store.findRunByKey(this.deps.workspaceId, context.actorId, context.idempotencyKey);
    const replayed = previous && previous.run.projectId === projectId && !isScriptBreakdownRun(previous.run) ? previous.run.input : null;
    const providerKey = parsed.data.providerKey ?? replayed?.providerKey ?? this.deps.defaultProvider
      ?? TITLE_WRITING_PROVIDER_PREFERENCE.find((key) => this.deps.providers[key].ok) ?? TITLE_WRITING_PROVIDER_PREFERENCE[0]!;
    let model = parsed.data.model ?? replayed?.model;
    if (!previous) {
      // New requests only: a retired provider is refused here, never moved to another provider.
      if (!isActiveTitleWritingProvider(providerKey)) {
        return failure(409, "TITLE_WRITING_PROVIDER_RETIRED", { providerKey, label: TITLE_WRITING_PROVIDER_LABELS[providerKey] });
      }
      const provider = this.deps.providers[providerKey];
      if (!provider.ok) return failure(503, "TITLE_WRITING_PROVIDER_UNCONFIGURED", { providerKey, missing: provider.missing });
      model ??= provider.models[0]!;
      if (!provider.models.includes(model)) return failure(400, "TITLE_WRITING_MODEL_UNAVAILABLE", { providerKey });
      if (!await this.deps.store.providerStorageReady(providerKey)) {
        return failure(503, "TITLE_WRITING_PROVIDER_STORAGE_UNAVAILABLE", { providerKey, missing: [PROVIDER_MIGRATION_GAP] });
      }
    }
    if (model === undefined) {
      const config = providerConfigFor(this.deps.providers, providerKey);
      model = config?.models[0];
    }
    // A replayed key whose body names no model and whose provider has no models left can only be compared, never sent.
    if (model === undefined) return failure(409, "IDEMPOTENCY_KEY_REUSED");
    const startedAt = this.now();
    const run = newTitleRun({
      workspaceId: this.deps.workspaceId,
      projectId,
      actorId: context.actorId,
      idempotencyKey: context.idempotencyKey,
      title: parsed.data.title,
      settings: frozen.settings,
      providerKey,
      model,
      now: startedAt,
      version: frozen.version,
      // A start stored before the DeepSeek adapter mark existed is compared with the input it was stored with, so its
      // replay is still answered from that run instead of being refused as a different request.
      withoutAdapterMark: replayed !== null && replayed.providerAdapter === undefined,
    });
    // The store looks the key up first: a replay of an existing run is returned whatever the quota is now. A new v2
    // run needs N+2 calls left in the rolling 24 hours; this reserves nothing. v1 keeps its existing per-call checks.
    const created = await this.deps.store.createRun(run, {
      maxActiveRuns: this.deps.maxActiveRuns,
      ...(frozen.version === 2 ? {
        quota: {
          sinceIso: new Date(startedAt.getTime() - 24 * 60 * 60 * 1000).toISOString(),
          maxCallsPerDay: this.deps.maxCallsPerDay,
          requiredCalls: titleWritingRequiredCalls(frozen.settings.episodeCount),
        },
      } : {}),
    });
    if (created.kind === "blocked") {
      return created.code === "TITLE_WRITING_DAILY_QUOTA_LOW"
        ? failure(429, created.code, { requiredCalls: created.requiredCalls, remainingCalls: created.remainingCalls })
        : failure(429, created.code);
    }
    // A start stored with prompt v2 or v3 and replayed after an upgrade is the same request, not a reused key.
    if (created.kind === "conflict" && !sameStartBeforeGuidance(created.bundle.run, run)) return failure(409, "IDEMPOTENCY_KEY_REUSED");
    // One AI task per work. Only a running title run is offered to be opened; a running script breakdown is named as the
    // other task and its run id is not exposed as a title run (the writing page could not show it).
    if (created.kind === "active") {
      return isScriptBreakdownRun(created.bundle.run)
        ? failure(409, "TITLE_WRITING_OTHER_TASK_ACTIVE", { taskKind: "script_breakdown" })
        : failure(409, "TITLE_WRITING_RUN_ACTIVE", { runId: created.bundle.run.id });
    }
    if (created.bundle.run.projectId !== projectId || isScriptBreakdownRun(created.bundle.run)) return failure(409, "IDEMPOTENCY_KEY_REUSED");
    if (created.kind === "created") this.schedule(created.bundle.run.id);
    return this.found(created.bundle, created.kind === "created" ? 201 : 200);
  }

  /**
   * The settings a new run freezes, from the project's episode plan. A project with a plan gets a v2 run of exactly its
   * N and target seconds; sent values must equal them. A project without a plan keeps the v1 rules unchanged (three
   * episodes, 30–180 seconds), so requests saved by an older page replay to the same input and hash.
   */
  private async frozenSettings(projectId: string, sent: TitleWritingStart["settings"]):
    Promise<{ version: 1 | 2; settings: TitleWritingSettings } | { refusal: TitleWritingResult }> {
    const plan = await this.deps.projects.getProjectEpisodePlan(this.deps.workspaceId, projectId);
    if (plan.targetEpisodeSeconds === null) {
      const v1 = titleWritingSettingsSchema.safeParse(sent ?? {});
      if (!v1.success) return { refusal: failure(400, "VALIDATION_ERROR", { field: `settings.${v1.error.issues[0]?.path.join(".") ?? ""}` }) };
      return { version: 1, settings: v1.data };
    }
    if (!await this.deps.projects.episodePlanReady()) return { refusal: failure(503, "TITLE_WRITING_EPISODE_PLAN_UNAVAILABLE") };
    const planned = { episodeCount: plan.episodeCount, targetEpisodeSeconds: plan.targetEpisodeSeconds };
    if ((sent?.episodeCount !== undefined && sent.episodeCount !== plan.episodeCount)
      || (sent?.episodeSeconds !== undefined && sent.episodeSeconds !== plan.targetEpisodeSeconds)) {
      return { refusal: failure(409, "TITLE_WRITING_PLAN_MISMATCH", planned) };
    }
    return { version: 2, settings: { episodeCount: plan.episodeCount, episodeSeconds: plan.targetEpisodeSeconds, style: (sent?.style ?? "").trim() } };
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
    const existing = await this.deps.store.getRun(this.deps.workspaceId, projectId, runId);
    if (!existing || isScriptBreakdownRun(existing.run)) return failure(404, "NOT_FOUND");
    return this.found(await this.deps.store.requestCancel(this.deps.workspaceId, projectId, runId, this.now().toISOString()));
  }

  /**
   * Resumes only what the person saw: the confirmation must name exactly the run's current uncertain calls, checked in
   * the store transaction. The Idempotency-Key identifies this one action; a replay after a lost receipt returns the
   * current run and never resets or sends anything again.
   */
  async resume(projectId: string, runId: string, body: unknown, token: OperatorProof | string | undefined, context: StudioContext): Promise<TitleWritingResult> {
    const refused = await this.gate(token);
    if (refused) return refused;
    if (!context.idempotencyKey || context.idempotencyKey.length > 200) return failure(400, "VALIDATION_ERROR", { field: "Idempotency-Key" });
    await this.deps.projects.getProject(this.deps.workspaceId, projectId);
    const parsed = titleWritingResumeSchema.safeParse(body ?? {});
    if (!parsed.success) return failure(400, "VALIDATION_ERROR", { field: parsed.error.issues[0]?.path.join(".") ?? "body" });
    const existing = await this.deps.store.getRun(this.deps.workspaceId, projectId, runId);
    if (!existing || isScriptBreakdownRun(existing.run)) return failure(404, "NOT_FOUND");
    // The store decides under the run lock, after its replay check, whether this resume would send a call: only then
    // must the run's own provider and model be ready. A replayed resume and a resume that only saves an answer already
    // stored need no provider. A retired provider is never ready, so its run is never sent for again.
    const runProvider = existing.run.input.providerKey;
    const legacy = isLegacyDeepseekRun(existing.run.input);
    const provider = providerConfigFor(this.deps.providers, runProvider);
    const confirmed = parsed.data.confirmUncertainCallIds;
    const prepared = await this.deps.store.prepareResume(this.deps.workspaceId, projectId, runId, {
      resumeKey: context.idempotencyKey,
      requestHash: hashTitleResume(runId, confirmed),
      confirmedCallIds: confirmed,
      maxActiveRuns: this.deps.maxActiveRuns,
      // A DeepSeek run from before the retirement is never sent for again (only an answer already stored may be saved).
      providerReady: !legacy && provider !== null && provider.ok && provider.models.includes(existing.run.input.model),
    }, this.now().toISOString());
    if (prepared.kind === "replayed") return this.found(prepared.bundle);
    if (prepared.kind !== "ok") {
      if (prepared.kind === "not_found") return failure(404, "NOT_FOUND");
      if (prepared.kind === "active") return failure(409, "TITLE_WRITING_RUN_ACTIVE", { runId });
      if (prepared.kind === "active_cap") return failure(429, "TITLE_WRITING_ACTIVE_RUN_CAP");
      if (prepared.kind === "needs_confirmation") return failure(409, "TITLE_WRITING_NEEDS_CONFIRMATION");
      if (prepared.kind === "stale_confirmation") return failure(409, "TITLE_WRITING_CONFIRMATION_STALE");
      if (prepared.kind === "key_conflict") return failure(409, "IDEMPOTENCY_KEY_REUSED");
      if (prepared.kind === "provider_unconfigured") {
        if (legacy) return failure(409, "TITLE_WRITING_LEGACY_RUN", { providerKey: runProvider, model: existing.run.input.model });
        if (provider?.ok && !provider.models.includes(existing.run.input.model)) {
          return failure(409, "TITLE_WRITING_RUN_MODEL_UNAVAILABLE", { providerKey: runProvider, model: existing.run.input.model });
        }
        return isActiveTitleWritingProvider(runProvider)
          ? failure(503, "TITLE_WRITING_PROVIDER_UNCONFIGURED", { providerKey: runProvider, missing: provider && !provider.ok ? provider.missing : [] })
          : failure(409, "TITLE_WRITING_PROVIDER_RETIRED", { providerKey: runProvider, label: TITLE_WRITING_PROVIDER_LABELS[runProvider] });
      }
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
      if (placed.kind === "plan_mismatch") return failure(409, "TITLE_WRITING_PLAN_MISMATCH");
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
