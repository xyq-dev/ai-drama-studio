import { randomUUID } from "node:crypto";
import {
  SERIES_BATCH_SIZE,
  SERIES_BUDGETS,
  SERIES_DEFAULT_SECONDS,
  SERIES_FINAL_CALLS,
  SERIES_JOB_MAX_CALLS,
  SERIES_MAX_EPISODES,
  SERIES_MAX_RESEND_ALLOWANCE,
  SERIES_MIN_EPISODES,
  SERIES_OUTLINE_CHUNK,
  SERIES_PROMPT_MAX_CHARS,
  SERIES_REVIEW_CONTENT_CHARS,
  SERIES_SECONDS_CHOICES,
  SERIES_WRITING_CHECKS_VERSION,
  SERIES_WRITING_PROMPT_VERSION,
  SERIES_RESEARCH_CONTRACT,
  TITLE_WRITING_PROVIDER_KEYS,
  TITLE_WRITING_PROVIDER_LABELS,
  TITLE_WRITING_PROVIDER_PREFERENCE,
  isActiveTitleWritingProvider,
  isLegacyDeepseekRun,
  seriesBatchCount,
  seriesBatchRange,
  seriesCreateSchema,
  seriesDecisionSchema,
  seriesGrantRequestSchema,
  seriesLedgerEditSchema,
  seriesPlaceSchema,
  seriesPlanEditSchema,
  seriesResumeSchema,
  type SeriesPlanStory,
  type SeriesSnapshot,
  type SeriesWritingStore,
  type TitleWritingProviderKey,
} from "@ai-drama/contracts";
import {
  builtInSources,
  canonicalInputHash,
  checkSeriesLedgerContent,
  checkSeriesPlanContent,
  formatSeriesEpisode,
  formatSeriesStory,
  nextSeriesJob,
  admitSeriesGrant,
  seriesBatchStates,
  seriesCurrentPlan,
  seriesDecisionBasis,
  seriesLedgerBasisNow,
  seriesLedgerEditBasis,
  seriesPackageJson,
  seriesPackageMarkdown,
  seriesView,
} from "@ai-drama/domain";
import {
  TEXT_WRITING_MAX_OUTPUT_TOKENS,
  WRITING_ADAPTERS,
  hashSeriesResume,
  newSeries,
  newSeriesGrant,
  providerConfigFor,
  urlProblem,
  type SeriesWritingEngine,
  type WritingProviderConfig,
} from "@ai-drama/providers";
import { asProof, operatorAllowed, operatorConfigured, type OperatorProof } from "./operator-access";
import type { StudioContext } from "./studio.service";
import type { RuntimeStore } from "@ai-drama/database";

export interface SeriesWritingDependencies {
  workspaceId: string;
  /** Title writing is active (its switch and production authorization) and SERIES_WRITING_ENABLED is true. */
  enabled: boolean;
  operatorToken: string | null;
  siteOperator?: boolean;
  defaultProvider: TitleWritingProviderKey | null;
  providers: Record<TitleWritingProviderKey, WritingProviderConfig>;
  store: SeriesWritingStore;
  engine: Pick<SeriesWritingEngine, "workspaceId" | "drive" | "maintain">;
  projects: Pick<RuntimeStore, "getProject" | "episodePlanReady">;
  maxCallsPerDay: number;
  maxActiveRuns: number;
  research: { fetchEnabled: boolean; allowedHosts: readonly string[] };
  configurationPending?: () => Promise<boolean>;
  clock?: () => Date;
  schedule?: (work: () => Promise<void>) => void;
}

export interface SeriesWritingResult {
  status: number;
  body: unknown;
  download?: { contentType: string; fileName: string; text: string };
}

const MESSAGES: Record<string, string> = {
  SERIES_WRITING_DISABLED: "系列编剧没有开启。原有的短剧创作不受影响。",
  SERIES_WRITING_FORBIDDEN: "没有调用权限（需要管理员登录，或在未启用站点登录时提供正确的操作者令牌），没有启动任何调用。",
  SERIES_WRITING_STORAGE_UNAVAILABLE: "系列编剧的数据库迁移（20261023000100_series_writing）还没有执行，没有创建作品或任务，也没有发出调用。",
  SERIES_EPISODE_PLAN_UNAVAILABLE: "集数设置的数据库迁移还没有执行，没有创建作品。",
  SERIES_NOT_FOUND: "这部作品不是系列编剧作品。",
  SERIES_PROVIDER_UNCONFIGURED: "所选模型服务现在不可用，没有发出调用，也不会自动改用其他模型服务。",
  SERIES_PROVIDER_RETIRED: "这个模型服务已经退役，不能再发起新的创作。",
  SERIES_MODEL_UNAVAILABLE: "所选模型不在服务端允许的列表中。",
  SERIES_SCOPE_INVALID: "授权范围无效，没有创建任务。",
  SERIES_CARD_STALE: "确认卡已过期（调用次数或规划版本与当前不一致），请刷新后重新确认。没有创建任务。",
  SERIES_BUDGET_MISMATCH: "调用预算必须等于正常调用次数加上你选择的重发次数，没有创建任务。",
  SERIES_GRANT_ACTIVE: "这部作品已有一次授权正在执行。",
  SERIES_PLAN_EXISTS: "这部作品已经有全剧规划；规划只能人工修改（形成新修订），不会重新生成。",
  SERIES_SCOPE_NOT_NEXT: "只能从下一批待写的集数开始，不能跳过前面的批次。",
  SERIES_BLOCKED: "还有需要先处理的事项（见 details.blockers），没有创建任务，也没有发出调用。",
  SERIES_DAILY_QUOTA_LOW: "最近 24 小时剩余的调用次数不够完成当前这一步（不是整个授权），没有创建任务，也没有发出调用。",
  SERIES_ACTIVE_RUN_CAP: "同时进行的 AI 创作已达管理员设置的上限，请等当前创作结束。没有创建任务。",
  SERIES_RUN_ACTIVE: "这部作品已有一次 AI 创作正在进行。",
  SERIES_RESEARCH_FETCH_DISABLED: "服务端没有开启公开页面读取，不能附带参考网址。",
  SERIES_REFERENCE_URL_REFUSED: "参考网址不在服务端允许读取的范围内，没有创建作品。",
  SERIES_NEEDS_CONFIRMATION: "有结果不确定的调用，可能已经计费。确认后才会重新发送。",
  SERIES_CONFIRMATION_STALE: "确认的不确定调用和现在的不一致，没有重新发送。请重新查看后再确认。",
  SERIES_NOT_RESUMABLE: "这次授权没有需要继续的部分。",
  SERIES_BUDGET_EXHAUSTED: "这次授权的调用预算不足以完成剩余范围，没有继续，也不会自动追加预算。如需继续，请重新确认新的授权。",
  SERIES_LEGACY_RUN: "这次授权冻结的是退役前的 DeepSeek 接入，不会再发出请求。",
  SERIES_RUN_MODEL_UNAVAILABLE: "这次授权冻结的模型已不在允许列表中，不会改用其他模型，没有发出调用。",
  SERIES_UPSTREAM_CHANGED: "授权开始后规划、故事、台账或前一集已经变化，不会在旧依赖上继续写作。",
  SERIES_EDIT_CONFLICT: "保存时发现已有更新的修订，没有覆盖。请刷新后基于最新修订修改。",
  SERIES_STORY_CONFLICT: "作品的故事在你打开页面后已被另存（或没有可采用的故事），没有保存规划，也没有覆盖故事。请刷新后重新核对。",
  SERIES_LEDGER_STALE: "打开台账编辑后，规划、故事、前一批台账、这一批台账或某集正文已经变化，没有保存台账，也没有解除任何阻断。请重新读取并核对后再确认。",
  SERIES_DECISION_STALE: "你复核的版本已不是当前版本（规划、故事、台账或正文在此期间有变化），没有记录复核，也没有解除任何阻断。请刷新后重新核对。",
  SERIES_STORY_NOT_SAVED: "规划还没有对应的作品故事，剧本不会写入分集。",
  SERIES_STORY_NOT_APPROVED: "故事还没有通过人工审核，剧本暂不能写入分集。机器检查不能代替人工审核。",
  SERIES_STORY_CHANGED: "人工审核通过的故事不是当前规划对应的故事。请先在系列页同步规划与故事（形成新规划修订并复核），再写入分集。",
  SERIES_PLAN_MISMATCH: "作品的集数或分集与系列不一致，没有写入。",
  SERIES_NOT_READY: "这一批还不能写入（见 details.reason）。",
  SERIES_LEDGER_BLOCKED: "这一批的台账现在不能确认（见 details.reason）。",
  SERIES_INVALID_EDIT: "修改内容没有通过检查（见 details），没有保存。",
  IDEMPOTENCY_KEY_REUSED: "同一个请求标识被用于不同的内容，已拒绝。",
  NOT_FOUND: "没有找到。",
  VALIDATION_ERROR: "请求内容无效。",
};

function failure(status: number, code: string, details?: Record<string, unknown>): SeriesWritingResult {
  return { status, body: { error: { code, message: MESSAGES[code] ?? "请求失败", ...(details ? { details } : {}) } } };
}

/** Two bases name exactly the same texts at the same versions. */
function sameRecord(a: Record<string, string> | null, b: Record<string, string>): boolean {
  return a !== null && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);
}

const UPSTREAM = new Set(["upstream_plan_changed", "upstream_story_changed", "upstream_ledger_changed", "upstream_episode_changed"]);

/**
 * Series writing for one work. Creating a work sends nothing; a grant (the confirmation card) may cost money, so the
 * switch, the operator, ready storage, the scope against the formula, the provider, the shared quota of the current
 * step and the concurrency cap are all checked before any write or send. Reads never call a provider.
 */
export class SeriesWritingService {
  constructor(private readonly deps: SeriesWritingDependencies) {
    if (deps.engine.workspaceId !== deps.workspaceId) throw new Error("series writing engine is bound to another workspace");
  }

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  private limits(at: Date) {
    return { sinceIso: new Date(at.getTime() - 24 * 60 * 60 * 1000).toISOString(), maxCallsPerDay: this.deps.maxCallsPerDay, maxActiveRuns: this.deps.maxActiveRuns };
  }

  private schedule(jobId: string): void {
    const work = () => this.deps.engine.drive(jobId);
    if (this.deps.schedule) {
      this.deps.schedule(work);
      return;
    }
    setImmediate(() => { void work().catch(() => undefined); });
  }

  async options(): Promise<SeriesWritingResult> {
    const storageReady = await this.deps.store.storageReady();
    const providers = TITLE_WRITING_PROVIDER_KEYS.map((providerKey) => {
      const config = this.deps.providers[providerKey];
      return { providerKey, label: WRITING_ADAPTERS[providerKey].label, ready: config.ok, models: config.models, defaultModel: config.models[0] ?? null,
        missing: config.ok ? [] : config.missing };
    });
    const firstReady = TITLE_WRITING_PROVIDER_PREFERENCE.find((key) => providers.find((item) => item.providerKey === key)?.ready) ?? null;
    const code = !this.deps.enabled ? "SERIES_WRITING_DISABLED" : !operatorConfigured(this.deps) ? "SERIES_WRITING_FORBIDDEN"
      : !storageReady ? "SERIES_WRITING_STORAGE_UNAVAILABLE" : firstReady === null ? "SERIES_PROVIDER_UNCONFIGURED" : "SERIES_WRITING_READY";
    let pending: boolean;
    try {
      pending = this.deps.configurationPending ? await this.deps.configurationPending() : false;
    } catch {
      pending = false;
    }
    const snapshot = builtInSources();
    const readableMarket = snapshot.filter((source) => source.topic === "market" && source.status === "read").length;
    return { status: 200, body: {
      enabled: this.deps.enabled, code, storageReady, operatorTokenRequired: this.deps.siteOperator !== true,
      defaultProvider: this.deps.defaultProvider ?? firstReady, providers, configurationPending: pending,
      maxCallsPerDay: this.deps.maxCallsPerDay, maxActiveRuns: this.deps.maxActiveRuns, billing: "unknown",
      episodes: { min: SERIES_MIN_EPISODES, max: SERIES_MAX_EPISODES, secondsChoices: [...SERIES_SECONDS_CHOICES], defaultSeconds: SERIES_DEFAULT_SECONDS,
        batchSize: SERIES_BATCH_SIZE, outlineChunk: SERIES_OUTLINE_CHUNK },
      formula: "6 + ceil(N/6) + N + ceil(N/3)",
      finalCalls: SERIES_FINAL_CALLS, maxCallsPerJob: SERIES_JOB_MAX_CALLS, maxResendAllowance: SERIES_MAX_RESEND_ALLOWANCE,
      maxOutputTokensPerCall: TEXT_WRITING_MAX_OUTPUT_TOKENS, maxPromptChars: SERIES_PROMPT_MAX_CHARS, reviewContentChars: SERIES_REVIEW_CONTENT_CHARS,
      budgets: SERIES_BUDGETS,
      versions: { prompt: SERIES_WRITING_PROMPT_VERSION, checks: SERIES_WRITING_CHECKS_VERSION, research: SERIES_RESEARCH_CONTRACT },
      research: { fetchEnabled: this.deps.research.fetchEnabled, expectedMode: readableMarket > 0 ? "sourced" : "limited", visualAnalysis: false },
      media: { enabled: false, note: "系列编剧只交付文本：不生成图片、语音或视频，60 集媒体生产未开放。" },
    } };
  }

  private async gate(token: OperatorProof | string | undefined): Promise<SeriesWritingResult | null> {
    if (!this.deps.enabled) return failure(404, "SERIES_WRITING_DISABLED");
    if (!operatorAllowed(this.deps, token)) return failure(403, "SERIES_WRITING_FORBIDDEN");
    if (!await this.deps.store.storageReady()) return failure(503, "SERIES_WRITING_STORAGE_UNAVAILABLE");
    return null;
  }

  private async snapshotOf(projectId: string): Promise<SeriesSnapshot | SeriesWritingResult> {
    await this.deps.projects.getProject(this.deps.workspaceId, projectId);
    if (!await this.deps.store.storageReady()) return failure(503, "SERIES_WRITING_STORAGE_UNAVAILABLE");
    const snapshot = await this.deps.store.snapshot(this.deps.workspaceId, projectId);
    return snapshot ?? failure(404, "SERIES_NOT_FOUND");
  }

  private viewOf(snapshot: SeriesSnapshot, status = 200): SeriesWritingResult {
    return { status, body: { series: seriesView(snapshot) } };
  }

  async create(body: unknown, token: OperatorProof | string | undefined, context: StudioContext): Promise<SeriesWritingResult> {
    const refused = await this.gate(token);
    if (refused) return refused;
    if (!context.idempotencyKey || context.idempotencyKey.length > 200) return failure(400, "VALIDATION_ERROR", { field: "Idempotency-Key" });
    const parsed = seriesCreateSchema.safeParse(body ?? {});
    if (!parsed.success) return failure(400, "VALIDATION_ERROR", { field: parsed.error.issues[0]?.path.join(".") ?? "body" });
    const request = parsed.data;
    const previous = await this.deps.store.findSeriesByKey(this.deps.workspaceId, context.actorId, context.idempotencyKey);
    const researchFetch = previous ? previous.input.researchFetch : this.deps.research.fetchEnabled;
    if (!previous) {
      if (!await this.deps.projects.episodePlanReady()) return failure(503, "SERIES_EPISODE_PLAN_UNAVAILABLE");
      if (request.referenceUrls.length > 0 && !researchFetch) return failure(400, "SERIES_RESEARCH_FETCH_DISABLED");
      const badUrl = request.referenceUrls.find((url) => urlProblem(url, this.deps.research.allowedHosts) !== null);
      if (badUrl) return failure(400, "SERIES_REFERENCE_URL_REFUSED", { reason: urlProblem(badUrl, this.deps.research.allowedHosts) });
    }
    const series = newSeries({
      workspaceId: this.deps.workspaceId, projectId: previous?.projectId ?? randomUUID(), actorId: context.actorId, idempotencyKey: context.idempotencyKey,
      title: request.title, idea: request.idea, constraints: request.constraints, materials: request.materials, referenceUrls: request.referenceUrls,
      researchFetch, episodeCount: request.episodeCount, episodeSeconds: request.episodeSeconds, now: this.now(),
    });
    const created = await this.deps.store.createSeries(series, { title: request.title, premise: request.idea });
    if (created.kind === "conflict") return failure(409, "IDEMPOTENCY_KEY_REUSED");
    if (created.kind === "plan_unavailable") return failure(503, "SERIES_EPISODE_PLAN_UNAVAILABLE");
    const snapshot = await this.deps.store.snapshot(this.deps.workspaceId, created.series.projectId);
    return this.viewOf(snapshot!, created.kind === "created" ? 201 : 200);
  }

  async get(projectId: string): Promise<SeriesWritingResult> {
    const snapshot = await this.snapshotOf(projectId);
    return "status" in snapshot ? snapshot : this.viewOf(snapshot);
  }

  async grant(projectId: string, body: unknown, token: OperatorProof | string | undefined, context: StudioContext): Promise<SeriesWritingResult> {
    const refused = await this.gate(token);
    if (refused) return refused;
    if (!context.idempotencyKey || context.idempotencyKey.length > 200) return failure(400, "VALIDATION_ERROR", { field: "Idempotency-Key" });
    const parsed = seriesGrantRequestSchema.safeParse(body ?? {});
    if (!parsed.success) return failure(400, "VALIDATION_ERROR", { field: parsed.error.issues[0]?.path.join(".") ?? "body" });
    const request = parsed.data;
    const snapshot = await this.snapshotOf(projectId);
    if ("status" in snapshot) return snapshot;
    // A key already used is answered from its grant, whatever the providers or switches are now.
    const previous = await this.deps.store.findGrantByKey(this.deps.workspaceId, context.actorId, context.idempotencyKey);
    if (!previous) {
      if (!isActiveTitleWritingProvider(request.providerKey)) {
        return failure(409, "SERIES_PROVIDER_RETIRED", { providerKey: request.providerKey, label: TITLE_WRITING_PROVIDER_LABELS[request.providerKey] });
      }
      const provider = this.deps.providers[request.providerKey];
      if (!provider.ok) return failure(503, "SERIES_PROVIDER_UNCONFIGURED", { providerKey: request.providerKey, missing: provider.missing });
      if (!provider.models.includes(request.model)) return failure(400, "SERIES_MODEL_UNAVAILABLE", { providerKey: request.providerKey });
      if (!await this.deps.store.providerStorageReady(request.providerKey)) return failure(503, "SERIES_WRITING_STORAGE_UNAVAILABLE");
    }
    const at = this.now();
    const proof = asProof(token);
    const grant = newSeriesGrant({
      series: snapshot.series, actorId: context.actorId, idempotencyKey: context.idempotencyKey, scope: request.scope, normalCalls: request.normalCalls,
      resendAllowance: request.resendAllowance, callBudget: request.callBudget, providerKey: request.providerKey, model: request.model,
      basePlanRevisionId: request.basePlanRevisionId,
      authorization: { mode: "series", proof: this.deps.siteOperator === true && proof.session ? "site_session" : "operator_token", initiatedBy: context.actorId,
        executor: "series-writing-engine" },
      now: at,
    });
    const created = await this.deps.store.createGrant(grant, this.limits(at), (state) => admitSeriesGrant(state, grant, { jobId: randomUUID(), nowIso: at.toISOString() }));
    if (created.kind === "conflict") return failure(409, "IDEMPOTENCY_KEY_REUSED");
    if (created.kind === "refused") {
      if (created.code === "NOT_FOUND") return failure(404, "SERIES_NOT_FOUND");
      return failure(409, created.code, created.details);
    }
    if (created.kind === "active") return failure(409, "SERIES_RUN_ACTIVE", { runKind: created.runKind });
    if (created.kind === "blocked") return failure(429, "SERIES_ACTIVE_RUN_CAP");
    if (created.kind === "daily_quota_low") return failure(429, "SERIES_DAILY_QUOTA_LOW", { requiredCalls: created.requiredCalls, remainingCalls: created.remainingCalls });
    if (created.kind === "created") this.schedule(created.jobId);
    const after = await this.deps.store.snapshot(this.deps.workspaceId, projectId);
    return { status: created.kind === "created" ? 201 : 200, body: { grantId: created.grant.id, series: seriesView(after!) } };
  }

  async cancel(projectId: string, grantId: string): Promise<SeriesWritingResult> {
    const snapshot = await this.snapshotOf(projectId);
    if ("status" in snapshot) return snapshot;
    const grant = await this.deps.store.requestCancel(this.deps.workspaceId, projectId, grantId, this.now().toISOString());
    if (!grant) return failure(404, "NOT_FOUND");
    return this.viewOf((await this.deps.store.snapshot(this.deps.workspaceId, projectId))!);
  }

  async resume(projectId: string, grantId: string, body: unknown, token: OperatorProof | string | undefined, context: StudioContext): Promise<SeriesWritingResult> {
    const refused = await this.gate(token);
    if (refused) return refused;
    if (!context.idempotencyKey || context.idempotencyKey.length > 200) return failure(400, "VALIDATION_ERROR", { field: "Idempotency-Key" });
    const parsed = seriesResumeSchema.safeParse(body ?? {});
    if (!parsed.success) return failure(400, "VALIDATION_ERROR", { field: parsed.error.issues[0]?.path.join(".") ?? "body" });
    const snapshot = await this.snapshotOf(projectId);
    if ("status" in snapshot) return snapshot;
    const grant = snapshot.grants.find((item) => item.id === grantId);
    if (!grant) return failure(404, "NOT_FOUND");
    const legacy = isLegacyDeepseekRun(grant.input);
    const provider = providerConfigFor(this.deps.providers, grant.input.providerKey);
    const confirmed = parsed.data.confirmUncertainCallIds;
    const at = this.now();
    const prepared = await this.deps.store.prepareResume(this.deps.workspaceId, projectId, grantId, {
      resumeKey: context.idempotencyKey, requestHash: hashSeriesResume(grantId, confirmed), confirmedCallIds: confirmed,
      providerReady: !legacy && provider !== null && provider.ok && provider.models.includes(grant.input.model), limits: this.limits(at),
    }, at.toISOString(), (state) => nextSeriesJob(state, state.grants.find((item) => item.id === grantId)!, { jobId: randomUUID(), nowIso: at.toISOString() }));
    if (prepared.kind === "ok") this.schedule(prepared.jobId);
    if (prepared.kind === "ok" || prepared.kind === "replayed") return this.viewOf((await this.deps.store.snapshot(this.deps.workspaceId, projectId))!);
    if (prepared.kind === "not_found") return failure(404, "NOT_FOUND");
    if (prepared.kind === "active") return failure(409, "SERIES_RUN_ACTIVE");
    if (prepared.kind === "active_cap") return failure(429, "SERIES_ACTIVE_RUN_CAP");
    if (prepared.kind === "needs_confirmation") return failure(409, "SERIES_NEEDS_CONFIRMATION");
    if (prepared.kind === "stale_confirmation") return failure(409, "SERIES_CONFIRMATION_STALE");
    if (prepared.kind === "key_conflict") return failure(409, "IDEMPOTENCY_KEY_REUSED");
    if (prepared.kind === "budget_exhausted") return failure(409, "SERIES_BUDGET_EXHAUSTED", { callsUsed: grant.callsUsed, callBudget: grant.callBudget });
    if (prepared.kind === "daily_quota_low") return failure(429, "SERIES_DAILY_QUOTA_LOW", { requiredCalls: prepared.requiredCalls, remainingCalls: prepared.remainingCalls });
    if (prepared.kind === "provider_unconfigured") {
      if (legacy) return failure(409, "SERIES_LEGACY_RUN");
      if (provider?.ok) return failure(409, "SERIES_RUN_MODEL_UNAVAILABLE", { providerKey: grant.input.providerKey, model: grant.input.model });
      return failure(503, "SERIES_PROVIDER_UNCONFIGURED", { providerKey: grant.input.providerKey, missing: provider && !provider.ok ? provider.missing : [] });
    }
    if (prepared.kind === "refused") {
      return UPSTREAM.has(prepared.code) ? failure(409, "SERIES_UPSTREAM_CHANGED", { reason: prepared.code })
        : failure(409, "SERIES_BLOCKED", { blockers: (prepared.details?.blockers as string[] | undefined) ?? [prepared.code] });
    }
    return failure(409, "SERIES_NOT_RESUMABLE");
  }

  /** After a person approved the story in the existing review: a batch's current model versions, written as DRAFT scripts. */
  async placeBatch(projectId: string, batchNo: number, body: unknown, context: StudioContext): Promise<SeriesWritingResult> {
    const parsed = seriesPlaceSchema.safeParse(body ?? {});
    if (!parsed.success) return failure(400, "VALIDATION_ERROR");
    const snapshot = await this.snapshotOf(projectId);
    if ("status" in snapshot) return snapshot;
    const n = snapshot.series.input.episodeCount;
    if (!Number.isInteger(batchNo) || batchNo < 1 || batchNo > seriesBatchCount(n)) return failure(400, "VALIDATION_ERROR", { field: "batchNo" });
    const state = seriesBatchStates(snapshot)[batchNo - 1]!;
    if (state.written < state.size) return failure(409, "SERIES_NOT_READY", { reason: "batch_incomplete" });
    if (state.review.status === "none") return failure(409, "SERIES_NOT_READY", { reason: "batch_review_missing" });
    const plan = seriesCurrentPlan(snapshot)!;
    const scripts = state.versions.flatMap((version) => version && version.ref.kind === "stage" && !version.placedScript
      ? [{ episodeNo: version.ref.episodeNo, runId: version.ref.runId, stageKey: version.ref.stageKey, text: formatSeriesEpisode(version.episode!, plan.content.setting) }] : []);
    const placed = await this.deps.store.placeBatch(this.deps.workspaceId, projectId, batchNo, scripts, context.actorId, this.now().toISOString());
    if (placed.kind !== "ok") {
      if (placed.kind === "not_found") return failure(404, "SERIES_NOT_FOUND");
      if (placed.kind === "not_ready") return failure(409, "SERIES_NOT_READY", { reason: placed.reason });
      if (placed.kind === "story_not_saved") return failure(409, "SERIES_STORY_NOT_SAVED");
      if (placed.kind === "story_not_approved") return failure(409, "SERIES_STORY_NOT_APPROVED");
      if (placed.kind === "story_changed") return failure(409, "SERIES_STORY_CHANGED");
      return failure(409, "SERIES_PLAN_MISMATCH");
    }
    return { status: 200, body: { placed: placed.placed, conflicts: placed.conflicts, series: seriesView((await this.deps.store.snapshot(this.deps.workspaceId, projectId))!) } };
  }

  /**
   * A person's plan revision: a new revision, bound in the same transaction to the work's story: a new story DRAFT written
   * from it (from_plan, the default; it needs a person's review, nothing inherits an approval) or the workbench's current
   * story adopted as it is (adopt_current). Both only while the plan and the story are the ones the page showed. The
   * earlier revisions and stories stay; every batch built on the old plan needs its ledger confirmed and a review.
   */
  async savePlan(projectId: string, body: unknown, context: StudioContext): Promise<SeriesWritingResult> {
    const snapshot = await this.snapshotOf(projectId);
    if ("status" in snapshot) return snapshot;
    const parsed = seriesPlanEditSchema(snapshot.series.input.episodeCount).safeParse(body ?? {});
    if (!parsed.success) return failure(400, "VALIDATION_ERROR", { field: parsed.error.issues[0]?.path.join(".") ?? "body" });
    const checked = checkSeriesPlanContent(snapshot.series.input, parsed.data.content);
    if (!checked.ok) return failure(400, "SERIES_INVALID_EDIT", { code: checked.code, field: checked.field ?? null });
    const content = parsed.data.content;
    const id = randomUUID();
    let story: SeriesPlanStory = { mode: "adopt_current" };
    if (parsed.data.story === "from_plan") {
      const text = formatSeriesStory(id, content, "manual");
      if (text === null) return failure(400, "SERIES_INVALID_EDIT", { code: "too_large", field: "story" });
      story = { mode: "from_plan", text };
    }
    const saved = await this.deps.store.savePlanRevision(this.deps.workspaceId, projectId, {
      id, seriesId: snapshot.series.id, revisionNo: 0, origin: "manual", sourceRunId: null, parentRevisionId: parsed.data.basePlanRevisionId,
      content, contentHash: canonicalInputHash(content), review: null, storyRevisionId: null, storyHash: null, storySave: "pending", createdBy: context.actorId,
      createdAt: this.now().toISOString(),
    }, { parentId: parsed.data.basePlanRevisionId, storyRevisionId: parsed.data.baseStoryRevisionId }, story);
    return this.afterEdit(projectId, saved);
  }

  /** A person's ledger for a batch, with one summary per episode, bound to the current versions; no model call. */
  async saveLedger(projectId: string, body: unknown, context: StudioContext): Promise<SeriesWritingResult> {
    const snapshot = await this.snapshotOf(projectId);
    if ("status" in snapshot) return snapshot;
    const n = snapshot.series.input.episodeCount;
    const parsed = seriesLedgerEditSchema(n).safeParse(body ?? {});
    if (!parsed.success) return failure(400, "VALIDATION_ERROR", { field: parsed.error.issues[0]?.path.join(".") ?? "body" });
    const { batchNo, content, summaries, baseLedgerRevisionId, expectedBasis } = parsed.data;
    if (batchNo > seriesBatchCount(n)) return failure(400, "VALIDATION_ERROR", { field: "batchNo" });
    const basis = seriesLedgerBasisNow(snapshot, batchNo);
    if ("blocked" in basis) return failure(409, "SERIES_LEDGER_BLOCKED", { reason: basis.blocked });
    // The summaries are bound to the versions the person's editor was opened on, never to newer ones that arrived since.
    const edit = (state: SeriesSnapshot) => seriesLedgerEditBasis(state, batchNo);
    if (!sameRecord(edit(snapshot), expectedBasis)) return failure(409, "SERIES_LEDGER_STALE");
    const { first, last } = seriesBatchRange(n, batchNo);
    const numbers = summaries.map((item) => item.episodeNo).sort((a, b) => a - b);
    if (numbers.length !== last - first + 1 || numbers.some((number, index) => number !== first + index)) return failure(400, "VALIDATION_ERROR", { field: "summaries" });
    const plan = seriesCurrentPlan(snapshot)!;
    const checked = checkSeriesLedgerContent(plan.content, content, last);
    if (!checked.ok) return failure(400, "SERIES_INVALID_EDIT", { code: checked.code, field: checked.field ?? null });
    const saved = await this.deps.store.saveLedgerRevision(this.deps.workspaceId, projectId, {
      id: randomUUID(), seriesId: snapshot.series.id, batchNo, revisionNo: 0, origin: "manual", content, contentHash: canonicalInputHash(content),
      summaries: summaries.map((item) => ({ ...item, versionHash: basis.versions.find((version) => version.ref.episodeNo === item.episodeNo)!.ref.hash })),
      basis: basis.basis, createdBy: context.actorId, createdAt: this.now().toISOString(),
    }, baseLedgerRevisionId, edit, expectedBasis);
    if (saved === "stale") return failure(409, "SERIES_LEDGER_STALE");
    if (saved === "blocked") return failure(409, "SERIES_LEDGER_BLOCKED", { reason: "not_confirmable" });
    return this.afterEdit(projectId, saved);
  }

  /**
   * A person's decision on a machine finding or a stale review. It is bound to the versions the person's page showed
   * (expectedBasis): the store compares them with the current ones in the same transaction under the series lock and
   * records nothing when they differ (409). The server never substitutes the newest versions for what the person saw.
   */
  async decide(projectId: string, body: unknown, context: StudioContext): Promise<SeriesWritingResult> {
    const snapshot = await this.snapshotOf(projectId);
    if ("status" in snapshot) return snapshot;
    const parsed = seriesDecisionSchema.safeParse(body ?? {});
    if (!parsed.success) return failure(400, "VALIDATION_ERROR", { field: parsed.error.issues[0]?.path.join(".") ?? "body" });
    const { target, note, expectedBasis } = parsed.data;
    if (target.startsWith("batch:") && Number(target.split(":")[1]) > seriesBatchCount(snapshot.series.input.episodeCount)) {
      return failure(400, "VALIDATION_ERROR", { field: "target" });
    }
    const saved = await this.deps.store.saveDecision(this.deps.workspaceId, projectId, { id: randomUUID(), seriesId: snapshot.series.id, target, basis: expectedBasis, note,
      createdBy: context.actorId, createdAt: this.now().toISOString() }, (current) => seriesDecisionBasis(current, target));
    if (saved === "conflict") return failure(409, "SERIES_DECISION_STALE");
    if (saved === "not_ready") return failure(409, "SERIES_NOT_READY", { reason: "nothing_to_decide" });
    return this.afterEdit(projectId, saved);
  }

  private async afterEdit(projectId: string, saved: "saved" | "conflict" | "story_conflict" | "not_found" | "active"): Promise<SeriesWritingResult> {
    if (saved === "not_found") return failure(404, "SERIES_NOT_FOUND");
    if (saved === "active") return failure(409, "SERIES_RUN_ACTIVE");
    if (saved === "conflict") return failure(409, "SERIES_EDIT_CONFLICT");
    if (saved === "story_conflict") return failure(409, "SERIES_STORY_CONFLICT");
    return this.viewOf((await this.deps.store.snapshot(this.deps.workspaceId, projectId))!, 201);
  }

  /** The current writing package: Markdown for people, JSON for machines. Reads only. */
  async package(projectId: string, format: string | undefined): Promise<SeriesWritingResult> {
    const snapshot = await this.snapshotOf(projectId);
    if ("status" in snapshot) return snapshot;
    const meta = { generatedAt: this.now().toISOString() };
    const stem = `series-writing-${snapshot.series.id.slice(0, 8)}`;
    if (format === "markdown") {
      return { status: 200, body: null, download: { contentType: "text/markdown; charset=utf-8", fileName: `${stem}.md`, text: seriesPackageMarkdown(snapshot, meta) } };
    }
    if (format === "json") {
      return { status: 200, body: null, download: { contentType: "application/json; charset=utf-8", fileName: `${stem}.json`,
        text: JSON.stringify(seriesPackageJson(snapshot, meta), null, 2) } };
    }
    return failure(400, "VALIDATION_ERROR", { field: "format" });
  }

  /** Fences expired executors always; continues jobs (which may send) only while the feature is on. */
  async maintain(): Promise<void> {
    if (!await this.deps.store.storageReady()) return;
    if (this.deps.enabled) {
      await this.deps.engine.maintain();
      return;
    }
    await this.deps.store.recoverExpired(this.deps.workspaceId, this.now().toISOString());
  }
}
