import {
  AUTO_CREATION_DEFAULT_EPISODES,
  AUTO_CREATION_DEFAULT_SECONDS,
  AUTO_CREATION_MAX_REVISION_ROUNDS,
  AUTO_CREATION_PROMPT_MAX_CHARS,
  TITLE_WRITING_EPISODE_SECONDS_CHOICES,
  TITLE_WRITING_MAX_EPISODES,
  TITLE_WRITING_MIN_EPISODES,
  TITLE_WRITING_PROVIDER_KEYS,
  TITLE_WRITING_PROVIDER_LABELS,
  TITLE_WRITING_PROVIDER_PREFERENCE,
  autoCreationHardCap,
  autoCreationInitialStageKeys,
  autoCreationNormalCalls,
  autoCreationPlaceSchema,
  autoCreationResumeSchema,
  autoCreationStartSchema,
  isActiveTitleWritingProvider,
  isLegacyDeepseekRun,
  type AutoCreationOptionsView,
  type AutoCreationStore,
  type AutoRunBundle,
  type TitleWritingProviderKey,
} from "@ai-drama/contracts";
import type { RuntimeStore } from "@ai-drama/database";
import { builtInSources, autoPackageJson, autoPackageMarkdown } from "@ai-drama/domain";
import {
  TEXT_WRITING_MAX_OUTPUT_TOKENS,
  WRITING_ADAPTERS,
  autoRunView,
  autoScriptsOf,
  hashAutoResume,
  newAutoRun,
  providerConfigFor,
  urlProblem,
  type AutoCreationEngine,
  type WritingProviderConfig,
} from "@ai-drama/providers";
import { asProof, operatorAllowed, operatorConfigured, type OperatorProof } from "./operator-access";
import type { StudioContext } from "./studio.service";
import { PROVIDER_MIGRATION_GAP } from "./title-writing.service";

export interface AutoCreationDependencies {
  workspaceId: string;
  /** Title writing is active (its switch and production authorization) and AUTO_CREATION_ENABLED is true. */
  enabled: boolean;
  operatorToken: string | null;
  siteOperator?: boolean;
  defaultProvider: TitleWritingProviderKey | null;
  providers: Record<TitleWritingProviderKey, WritingProviderConfig>;
  store: AutoCreationStore;
  engine: Pick<AutoCreationEngine, "workspaceId" | "drive" | "maintain">;
  projects: Pick<RuntimeStore, "getProject" | "getProjectEpisodePlan" | "episodePlanReady">;
  maxCallsPerDay: number;
  maxActiveRuns: number;
  research: { fetchEnabled: boolean; allowedHosts: readonly string[] };
  configurationPending?: () => Promise<boolean>;
  clock?: () => Date;
  schedule?: (work: () => Promise<void>) => void;
}

export interface AutoCreationResult {
  status: number;
  body: unknown;
  /** Set for a package download: the body is this text with this type and file name. */
  download?: { contentType: string; fileName: string; text: string };
}

const MESSAGES: Record<string, string> = {
  AUTO_CREATION_DISABLED: "AI 自动创作没有开启。原有的 AI 一键创作和手动创作不受影响。",
  AUTO_CREATION_FORBIDDEN: "没有调用权限（需要管理员登录，或在未启用站点登录时提供正确的操作者令牌），没有启动任何调用。",
  AUTO_CREATION_STORAGE_UNAVAILABLE: "AI 自动创作的数据库迁移（20261019000100_auto_creation）还没有执行，没有创建任务，也没有发出调用。",
  AUTO_CREATION_EPISODE_PLAN_UNAVAILABLE: "集数设置的数据库迁移还没有执行，没有启动任何调用。",
  AUTO_CREATION_PLAN_REQUIRED: "这部作品没有集数和时长设置，AI 自动创作只用于新建的、带集数设置的作品。",
  AUTO_CREATION_PLAN_MISMATCH: "请求的集数或时长和作品的设置不一致，没有发出任何调用。",
  AUTO_CREATION_PROJECT_NOT_EMPTY: "这部作品已经有故事或已经做过自动创作，不会覆盖。请新建作品再开始。",
  AUTO_CREATION_PROVIDER_UNCONFIGURED: "所选（或默认）模型服务现在不可用，没有发出调用，也不会自动改用其他模型服务。",
  AUTO_CREATION_PROVIDER_RETIRED: "这个模型服务已经退役，不能再发起新的创作。",
  AUTO_CREATION_MODEL_UNAVAILABLE: "所选模型不在服务端允许的列表中。",
  AUTO_CREATION_BUDGET_TOO_LOW: "调用预算少于正常完成所需的次数，没有创建任务，也没有发出任何调用。",
  AUTO_CREATION_BUDGET_TOO_HIGH: "调用预算超过了这次创作允许的最坏上限。",
  AUTO_CREATION_DAILY_QUOTA_LOW: "最近 24 小时剩余的调用次数不够完成这次创作的正常流程，没有创建任务，也没有发出任何调用。",
  AUTO_CREATION_ACTIVE_RUN_CAP: "同时进行的 AI 创作已达管理员设置的上限，请等当前创作结束。没有创建任务。",
  AUTO_CREATION_RUN_ACTIVE: "这部作品已有一次 AI 创作正在进行。",
  AUTO_CREATION_RESEARCH_FETCH_DISABLED: "服务端没有开启公开页面读取，不能附带参考网址。可以去掉网址，或把资料文字作为你的资料粘贴进来。",
  AUTO_CREATION_REFERENCE_URL_REFUSED: "参考网址不在服务端允许读取的范围内，没有创建任务。",
  AUTO_CREATION_LEGACY_RUN: "这次任务是 DeepSeek 退役前创建的旧任务，不会再发出请求。",
  AUTO_CREATION_RUN_MODEL_UNAVAILABLE: "这次任务冻结的模型已不在允许列表中，不会改用其他模型，没有发出调用。",
  AUTO_CREATION_NEEDS_CONFIRMATION: "有结果不确定的调用，可能已经计费。确认后才会重新发送。",
  AUTO_CREATION_CONFIRMATION_STALE: "确认的不确定调用和现在的不一致，没有重新发送。请重新查看后再确认。",
  AUTO_CREATION_NOT_RESUMABLE: "这次创作没有需要续跑的阶段。",
  AUTO_CREATION_BUDGET_EXHAUSTED: "这次创作冻结的调用预算已经用完，续跑也无法发送，没有重置任何阶段。已有成果仍可查看和下载；如需继续，请新建创作。",
  AUTO_CREATION_STORY_NOT_APPROVED: "故事还没有通过人工审核，剧本暂不能写入分集。机器质量检查不能代替人工审核。",
  AUTO_CREATION_STORY_CHANGED: "人工审核通过的故事和生成剧本时用的故事不同，请确认后再写入。",
  AUTO_CREATION_NOT_READY: "剧本包还没有完成。",
  IDEMPOTENCY_KEY_REUSED: "同一个请求标识被用于不同的内容，已拒绝。",
  NOT_FOUND: "没有找到这次创作。",
  VALIDATION_ERROR: "请求内容无效。",
};

function failure(status: number, code: string, details?: Record<string, unknown>): AutoCreationResult {
  return { status, body: { error: { code, message: MESSAGES[code] ?? "请求失败", ...(details ? { details } : {}) } } };
}

const MEDIA_MISSING = [
  "真实图片生成服务（当前只有演示素材）",
  "真实语音合成服务（当前只有演示素材）",
  "真实视频生成服务（当前只有演示素材）",
  "剧本拆解功能（服务端关闭，不会写入分镜生产数据）",
];

/**
 * Project-scoped AI automatic creation. Starting and resuming may cost money: the switch, the operator, ready storage,
 * the work's plan, the run's budget, the provider and the shared quota are all checked before any write or send.
 * Reads never call a provider. Machine quality checks, a person's review and publication stay separate facts.
 */
export class AutoCreationService {
  constructor(private readonly deps: AutoCreationDependencies) {
    if (deps.engine.workspaceId !== deps.workspaceId) throw new Error("auto creation engine is bound to another workspace");
  }

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  private schedule(runId: string): void {
    const work = () => this.deps.engine.drive(runId);
    if (this.deps.schedule) {
      this.deps.schedule(work);
      return;
    }
    setImmediate(() => { void work().catch(() => undefined); });
  }

  async options(): Promise<AutoCreationResult> {
    const storageReady = await this.deps.store.storageReady();
    const providers = TITLE_WRITING_PROVIDER_KEYS.map((providerKey) => {
      const config = this.deps.providers[providerKey];
      return {
        providerKey, label: WRITING_ADAPTERS[providerKey].label, ready: config.ok, models: config.models,
        defaultModel: config.models[0] ?? null, missing: config.ok ? [] : config.missing,
      };
    });
    const firstReady = TITLE_WRITING_PROVIDER_PREFERENCE.find((key) => providers.find((item) => item.providerKey === key)?.ready) ?? null;
    const code = !this.deps.enabled ? "AUTO_CREATION_DISABLED"
      : !operatorConfigured(this.deps) ? "AUTO_CREATION_FORBIDDEN"
        : !storageReady ? "AUTO_CREATION_STORAGE_UNAVAILABLE"
          : firstReady === null ? "AUTO_CREATION_PROVIDER_UNCONFIGURED" : "AUTO_CREATION_READY";
    const snapshot = builtInSources();
    const readableMarket = snapshot.filter((source) => source.topic === "market" && source.status === "read").length;
    let pending: boolean;
    try {
      pending = this.deps.configurationPending ? await this.deps.configurationPending() : false;
    } catch {
      pending = false;
    }
    const body: AutoCreationOptionsView = {
      enabled: this.deps.enabled,
      code,
      storageReady,
      operatorTokenRequired: this.deps.siteOperator !== true,
      defaultProvider: this.deps.defaultProvider ?? firstReady,
      providers,
      configurationPending: pending,
      maxCallsPerDay: this.deps.maxCallsPerDay,
      maxActiveRuns: this.deps.maxActiveRuns,
      billing: "unknown",
      episodePlan: {
        minEpisodes: TITLE_WRITING_MIN_EPISODES, maxEpisodes: TITLE_WRITING_MAX_EPISODES, defaultEpisodes: AUTO_CREATION_DEFAULT_EPISODES,
        secondsChoices: [...TITLE_WRITING_EPISODE_SECONDS_CHOICES], defaultSeconds: AUTO_CREATION_DEFAULT_SECONDS,
      },
      episodePlanReady: await this.deps.projects.episodePlanReady(),
      revisionRounds: { max: AUTO_CREATION_MAX_REVISION_ROUNDS, default: AUTO_CREATION_MAX_REVISION_ROUNDS },
      maxOutputTokensPerCall: TEXT_WRITING_MAX_OUTPUT_TOKENS,
      maxPromptChars: AUTO_CREATION_PROMPT_MAX_CHARS,
      research: {
        fetchEnabled: this.deps.research.fetchEnabled,
        allowedHosts: this.deps.research.fetchEnabled ? [...this.deps.research.allowedHosts] : [],
        builtInSources: snapshot.length,
        readableMarketSources: readableMarket,
        // Without a readable market source in the snapshot, only a successful read at run time could change this.
        expectedMode: readableMarket > 0 ? "sourced" : "limited",
        visualAnalysis: false,
      },
      media: { realProviders: [], mockOnly: true, missing: MEDIA_MISSING },
    };
    return { status: 200, body };
  }

  private async gate(token: OperatorProof | string | undefined): Promise<AutoCreationResult | null> {
    if (!this.deps.enabled) return failure(404, "AUTO_CREATION_DISABLED");
    if (!operatorAllowed(this.deps, token)) return failure(403, "AUTO_CREATION_FORBIDDEN");
    if (!await this.deps.store.storageReady()) return failure(503, "AUTO_CREATION_STORAGE_UNAVAILABLE");
    return null;
  }

  private async readable(projectId: string): Promise<AutoCreationResult | null> {
    await this.deps.projects.getProject(this.deps.workspaceId, projectId);
    if (!await this.deps.store.storageReady()) return failure(503, "AUTO_CREATION_STORAGE_UNAVAILABLE");
    return null;
  }

  private found(bundle: AutoRunBundle | null, status = 200): AutoCreationResult {
    return bundle ? { status, body: { run: autoRunView(bundle) } } : failure(404, "NOT_FOUND");
  }

  async start(projectId: string, body: unknown, token: OperatorProof | string | undefined, context: StudioContext): Promise<AutoCreationResult> {
    const refused = await this.gate(token);
    if (refused) return refused;
    if (!context.idempotencyKey || context.idempotencyKey.length > 200) return failure(400, "VALIDATION_ERROR", { field: "Idempotency-Key" });
    await this.deps.projects.getProject(this.deps.workspaceId, projectId);
    const parsed = autoCreationStartSchema.safeParse(body ?? {});
    if (!parsed.success) return failure(400, "VALIDATION_ERROR", { field: parsed.error.issues[0]?.path.join(".") ?? "body" });
    const request = parsed.data;
    // The work's plan, not the request, decides N and the seconds.
    const plan = await this.deps.projects.getProjectEpisodePlan(this.deps.workspaceId, projectId);
    if (plan.targetEpisodeSeconds === null) return failure(409, "AUTO_CREATION_PLAN_REQUIRED");
    if (!await this.deps.projects.episodePlanReady()) return failure(503, "AUTO_CREATION_EPISODE_PLAN_UNAVAILABLE");
    if ((request.episodeCount !== undefined && request.episodeCount !== plan.episodeCount)
      || (request.episodeSeconds !== undefined && request.episodeSeconds !== plan.targetEpisodeSeconds)) {
      return failure(409, "AUTO_CREATION_PLAN_MISMATCH", { episodeCount: plan.episodeCount, episodeSeconds: plan.targetEpisodeSeconds });
    }
    // A key already used is answered from its run, whatever the providers or switches are now.
    const previous = await this.deps.store.findRunByKey(this.deps.workspaceId, context.actorId, context.idempotencyKey);
    const replayed = previous && previous.run.projectId === projectId ? previous.run.input : null;
    const providerKey = request.providerKey ?? replayed?.providerKey ?? this.deps.defaultProvider
      ?? TITLE_WRITING_PROVIDER_PREFERENCE.find((key) => this.deps.providers[key].ok) ?? TITLE_WRITING_PROVIDER_PREFERENCE[0]!;
    let model = request.model ?? replayed?.model;
    const researchFetch = replayed ? replayed.researchFetch : this.deps.research.fetchEnabled;
    const hardCap = autoCreationHardCap(plan.episodeCount, request.revisionRounds);
    const normal = autoCreationNormalCalls(plan.episodeCount);
    const callBudget = request.callBudget ?? hardCap;
    if (!previous) {
      if (callBudget < normal) return failure(400, "AUTO_CREATION_BUDGET_TOO_LOW", { normalCalls: normal, callBudget });
      if (callBudget > hardCap) return failure(400, "AUTO_CREATION_BUDGET_TOO_HIGH", { hardCap, callBudget });
      if (request.referenceUrls.length > 0 && !researchFetch) return failure(400, "AUTO_CREATION_RESEARCH_FETCH_DISABLED");
      const badUrl = request.referenceUrls.find((url) => urlProblem(url, this.deps.research.allowedHosts) !== null);
      if (badUrl) return failure(400, "AUTO_CREATION_REFERENCE_URL_REFUSED", { reason: urlProblem(badUrl, this.deps.research.allowedHosts) });
      if (!isActiveTitleWritingProvider(providerKey)) {
        return failure(409, "AUTO_CREATION_PROVIDER_RETIRED", { providerKey, label: TITLE_WRITING_PROVIDER_LABELS[providerKey] });
      }
      // The configured default (or the chosen one) is used or nothing is: never another provider.
      const provider = this.deps.providers[providerKey];
      if (!provider.ok) return failure(503, "AUTO_CREATION_PROVIDER_UNCONFIGURED", { providerKey, missing: provider.missing });
      model ??= provider.models[0]!;
      if (!provider.models.includes(model)) return failure(400, "AUTO_CREATION_MODEL_UNAVAILABLE", { providerKey });
      if (!await this.deps.store.providerStorageReady(providerKey)) {
        return failure(503, "AUTO_CREATION_STORAGE_UNAVAILABLE", { providerKey, missing: [PROVIDER_MIGRATION_GAP] });
      }
    }
    model ??= providerConfigFor(this.deps.providers, providerKey)?.models[0];
    if (model === undefined) return failure(409, "IDEMPOTENCY_KEY_REUSED");
    const startedAt = this.now();
    const proof = asProof(token);
    const run = newAutoRun({
      workspaceId: this.deps.workspaceId,
      projectId,
      actorId: context.actorId,
      idempotencyKey: context.idempotencyKey,
      idea: request.idea,
      constraints: request.constraints,
      materials: request.materials,
      referenceUrls: request.referenceUrls,
      researchFetch,
      episodeCount: plan.episodeCount,
      episodeSeconds: plan.targetEpisodeSeconds,
      revisionRounds: request.revisionRounds,
      callBudget,
      providerKey,
      model,
      authorization: { mode: "auto", proof: this.deps.siteOperator === true && proof.session ? "site_session" : "operator_token",
        initiatedBy: context.actorId, executor: "auto-creation-engine" },
      now: startedAt,
    });
    const created = await this.deps.store.createRun(run, autoCreationInitialStageKeys(plan.episodeCount), {
      maxActiveRuns: this.deps.maxActiveRuns,
      sinceIso: new Date(startedAt.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      maxCallsPerDay: this.deps.maxCallsPerDay,
      requiredCalls: normal,
    });
    if (created.kind === "blocked") {
      return created.code === "AUTO_CREATION_DAILY_QUOTA_LOW"
        ? failure(429, created.code, { requiredCalls: created.requiredCalls, remainingCalls: created.remainingCalls })
        : failure(429, created.code);
    }
    if (created.kind === "project_not_empty") return failure(409, "AUTO_CREATION_PROJECT_NOT_EMPTY");
    if (created.kind === "active") return failure(409, "AUTO_CREATION_RUN_ACTIVE", created.runKind === "auto" ? { runId: created.runId } : { runKind: "title" });
    if (created.kind === "conflict") return failure(409, "IDEMPOTENCY_KEY_REUSED");
    if (created.kind === "created") this.schedule(created.bundle.run.id);
    return this.found(created.bundle, created.kind === "created" ? 201 : 200);
  }

  async latest(projectId: string): Promise<AutoCreationResult> {
    const refused = await this.readable(projectId);
    if (refused) return refused;
    const bundle = await this.deps.store.latestRun(this.deps.workspaceId, projectId);
    return { status: 200, body: { run: bundle ? autoRunView(bundle) : null } };
  }

  async get(projectId: string, runId: string): Promise<AutoCreationResult> {
    const refused = await this.readable(projectId);
    if (refused) return refused;
    return this.found(await this.deps.store.getRun(this.deps.workspaceId, projectId, runId));
  }

  async cancel(projectId: string, runId: string): Promise<AutoCreationResult> {
    const refused = await this.readable(projectId);
    if (refused) return refused;
    return this.found(await this.deps.store.requestCancel(this.deps.workspaceId, projectId, runId, this.now().toISOString()));
  }

  async resume(projectId: string, runId: string, body: unknown, token: OperatorProof | string | undefined, context: StudioContext): Promise<AutoCreationResult> {
    const refused = await this.gate(token);
    if (refused) return refused;
    if (!context.idempotencyKey || context.idempotencyKey.length > 200) return failure(400, "VALIDATION_ERROR", { field: "Idempotency-Key" });
    await this.deps.projects.getProject(this.deps.workspaceId, projectId);
    const parsed = autoCreationResumeSchema.safeParse(body ?? {});
    if (!parsed.success) return failure(400, "VALIDATION_ERROR", { field: parsed.error.issues[0]?.path.join(".") ?? "body" });
    const existing = await this.deps.store.getRun(this.deps.workspaceId, projectId, runId);
    if (!existing) return failure(404, "NOT_FOUND");
    const input = existing.run.input;
    const legacy = isLegacyDeepseekRun(input);
    const provider = providerConfigFor(this.deps.providers, input.providerKey);
    const confirmed = parsed.data.confirmUncertainCallIds;
    const prepared = await this.deps.store.prepareResume(this.deps.workspaceId, projectId, runId, {
      resumeKey: context.idempotencyKey,
      requestHash: hashAutoResume(runId, confirmed),
      confirmedCallIds: confirmed,
      maxActiveRuns: this.deps.maxActiveRuns,
      providerReady: !legacy && provider !== null && provider.ok && provider.models.includes(input.model),
    }, this.now().toISOString());
    if (prepared.kind === "replayed") return this.found(prepared.bundle);
    if (prepared.kind !== "ok") {
      if (prepared.kind === "not_found") return failure(404, "NOT_FOUND");
      if (prepared.kind === "active") return failure(409, "AUTO_CREATION_RUN_ACTIVE", { runId });
      if (prepared.kind === "active_cap") return failure(429, "AUTO_CREATION_ACTIVE_RUN_CAP");
      if (prepared.kind === "needs_confirmation") return failure(409, "AUTO_CREATION_NEEDS_CONFIRMATION");
      if (prepared.kind === "stale_confirmation") return failure(409, "AUTO_CREATION_CONFIRMATION_STALE");
      if (prepared.kind === "key_conflict") return failure(409, "IDEMPOTENCY_KEY_REUSED");
      if (prepared.kind === "budget_exhausted") return failure(409, "AUTO_CREATION_BUDGET_EXHAUSTED", { callsUsed: existing.run.callsUsed, callCap: existing.run.callCap });
      if (prepared.kind === "provider_unconfigured") {
        if (legacy) return failure(409, "AUTO_CREATION_LEGACY_RUN", { providerKey: input.providerKey, model: input.model });
        if (provider?.ok) return failure(409, "AUTO_CREATION_RUN_MODEL_UNAVAILABLE", { providerKey: input.providerKey, model: input.model });
        return failure(503, "AUTO_CREATION_PROVIDER_UNCONFIGURED", { providerKey: input.providerKey, missing: provider && !provider.ok ? provider.missing : [] });
      }
      return failure(409, "AUTO_CREATION_NOT_RESUMABLE");
    }
    this.schedule(runId);
    return this.found(prepared.bundle);
  }

  /** After a person approved the story in the existing review: the current version of every episode, in one action. */
  async placeScripts(projectId: string, runId: string, body: unknown, context: StudioContext): Promise<AutoCreationResult> {
    const refused = await this.readable(projectId);
    if (refused) return refused;
    const parsed = autoCreationPlaceSchema.safeParse(body ?? {});
    if (!parsed.success) return failure(400, "VALIDATION_ERROR");
    const existing = await this.deps.store.getRun(this.deps.workspaceId, projectId, runId);
    if (!existing) return failure(404, "NOT_FOUND");
    const placed = await this.deps.store.placeScripts(this.deps.workspaceId, projectId, runId, autoScriptsOf(existing),
      { acceptStoryChanged: parsed.data.acceptStoryChanged }, context.actorId, this.now().toISOString());
    if (placed.kind !== "ok") {
      if (placed.kind === "not_found") return failure(404, "NOT_FOUND");
      if (placed.kind === "not_ready") return failure(409, "AUTO_CREATION_NOT_READY");
      if (placed.kind === "story_not_saved") return failure(409, "AUTO_CREATION_STORY_NOT_SAVED");
      if (placed.kind === "story_not_approved") return failure(409, "AUTO_CREATION_STORY_NOT_APPROVED");
      if (placed.kind === "plan_mismatch") return failure(409, "AUTO_CREATION_PLAN_MISMATCH");
      return failure(409, "AUTO_CREATION_STORY_CHANGED");
    }
    return this.found(placed.bundle);
  }

  /** The script package: Markdown for people, JSON for machines. Reads only. */
  async package(projectId: string, runId: string, format: string | undefined): Promise<AutoCreationResult> {
    const refused = await this.readable(projectId);
    if (refused) return refused;
    const bundle = await this.deps.store.getRun(this.deps.workspaceId, projectId, runId);
    if (!bundle) return failure(404, "NOT_FOUND");
    const { run } = bundle;
    const meta = { runId: run.id, projectId, input: run.input, quality: run.quality, state: run.state, callsUsed: run.callsUsed,
      callCap: run.callCap, revisionRoundsUsed: run.revisionRoundsUsed, storySave: run.storySave, generatedAt: this.now().toISOString() };
    const stem = `ai-auto-creation-${run.id.slice(0, 8)}`;
    if (format === "markdown") {
      return { status: 200, body: null, download: { contentType: "text/markdown; charset=utf-8", fileName: `${stem}.md`, text: autoPackageMarkdown(meta, bundle.stages) } };
    }
    if (format === "json") {
      return { status: 200, body: null, download: { contentType: "application/json; charset=utf-8", fileName: `${stem}.json`,
        text: JSON.stringify(autoPackageJson(meta, bundle.stages), null, 2) } };
    }
    return failure(400, "VALIDATION_ERROR", { field: "format" });
  }

  /** Fences expired executors always; continues runs (which may send) only while the feature is on. */
  async maintain(): Promise<void> {
    if (!await this.deps.store.storageReady()) return;
    if (this.deps.enabled) {
      await this.deps.engine.maintain();
      return;
    }
    await this.deps.store.recoverExpired(this.deps.workspaceId, this.now().toISOString());
  }
}
