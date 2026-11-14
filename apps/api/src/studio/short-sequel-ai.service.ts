import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SHORT_SEQUEL_AI_SCHEMA, TITLE_WRITING_PROVIDER_PREFERENCE, type ShortSequelAiAttempt, type ShortSequelAiInput,
  type ShortSequelAiHistoryPage, type ShortSequelAiTaskView, type ShortSequelAiView, type TitleWritingProviderKey, type WritingCandidateFinish } from "@ai-drama/contracts";
import { PersistenceError, shortSequelAiDraftExpired, shortSequelAiMaterials, shortSequelAiStale,
  type PostgresWritingCandidateStore, type ShortSequelStore } from "@ai-drama/database";
import { canonicalInputHash } from "@ai-drama/domain";
import { TEXT_WRITING_MAX_OUTPUT_TOKENS, WRITING_ADAPTERS, WRITING_CANDIDATE_LEASE_MS, providerConfigFor, sendWriting,
  type WritingProviderConfig, type WritingTransport } from "@ai-drama/providers";
import { operatorAllowed, operatorConfigured, type OperatorProof } from "./operator-access";
import { prepareShortSequelPrompt } from "./short-sequel-ai.prompt";
import type { StudioContext } from "./studio.service";

const unknownUsage = { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null } as const;
const attemptIdSchema = z.string().uuid().transform(value => value.toLowerCase());
const startSchema = z.object({ direction: z.string().trim().max(1000).refine(value => !value.includes("\u0000")).default(""),
  confirmUncertainAttemptId: attemptIdSchema.optional() }).strict();
const resumeSchema = z.object({ attemptId: attemptIdSchema, confirmUncertain: z.boolean().default(false) }).strict();
const historyCursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/u);

type Context = Awaited<ReturnType<ShortSequelStore["context"]>>;
type Repository = Pick<PostgresWritingCandidateStore, "storageReady" | "providerStorageReady" | "createShortSequel"
  | "findShortSequelByKey" | "getShortSequelAttempt" | "listShortSequels" | "markShortSequelSubmitted" | "closeUnsent" | "finishShortSequel">;

export interface ShortSequelAiDependencies {
  workspaceId: string;
  enabled: boolean;
  operatorToken: string | null;
  siteOperator: boolean;
  defaultProvider: TitleWritingProviderKey | null;
  providers: Record<TitleWritingProviderKey, WritingProviderConfig>;
  source: Pick<ShortSequelStore, "context">;
  store: Repository;
  transport: WritingTransport;
  maxCallsPerDay: number;
  maxActiveRuns: number;
  clock?: () => Date;
  schedule?: (work: () => Promise<void>) => void;
}

interface Result { status: number; body: unknown }

const errors: Record<string, [number, string]> = {
  disabled: [404, "AI 续写未开启。"],
  forbidden: [403, "请登录管理员账号或提供正确的操作者令牌。"],
  storage: [503, "AI 续写使用的在线候选存储暂不可用。"],
  provider: [503, "AI 续写的模型尚未配置或冻结的模型已不可用。"],
  not_found: [404, "找不到这次 AI 续写。"],
  validation: [400, "请求内容无效，或缺少请求标识。"],
  conflict: [409, "请求标识已用于其他内容。"],
  active: [409, "这部作品已有编剧任务正在运行。"],
  source_changed: [409, "前情、集数或设定版本已更新，请按当前版本生成新草稿。"],
  source_unavailable: [409, "尚未找到可用的原作人物、地点与前集正文，或前情超出模型输入上限。"],
  body_exists: [409, "本集已有正文。已有正文已保留。"],
  needs_confirmation: [409, "上一次请求结果不确定，可能已经计费。请确认后再发送。"],
  not_resumable: [409, "这次续写没有可以恢复的阶段。"],
  daily_cap: [429, "最近 24 小时的模型调用次数已达上限。"],
  active_cap: [429, "同时运行的 AI 编剧任务已达上限。"],
};

function failure(code: string): Result {
  const [status, message] = errors[code] ?? errors.validation!;
  return { status, body: { error: { code: `SHORT_SEQUEL_AI_${code.toUpperCase()}`, message } } };
}

function sourceOf(context: Context) {
  return { storyRevisionId: context.storyRevisionId, previousRevisionId: context.previousRevisionId,
    originalRunId: context.originalRunId, originalEpisodeHash: context.originalEpisodeHash,
    planConfirmation: context.planConfirmation, confirmedEpisodeCountAtCapture: context.lastConfirmedEpisodeCount,
    lockedPreviousRevisionId: context.lockedPreviousRevisionId,
    lockedOriginal: context.lockedOriginal };
}

function taskView(attempt: ShortSequelAiAttempt, context: Context): ShortSequelAiTaskView {
  const { id, input, state, script, errorCode, usage, createdAt, finishedAt } = attempt;
  const isStale = state === "completed" ? shortSequelAiDraftExpired(input, context) : shortSequelAiStale(input, context);
  return { taskId: input.taskId, attemptId: id, episodeNo: input.episodeNo, episodeCount: input.episodeCount,
    targetEpisodeSeconds: input.targetEpisodeSeconds, direction: input.direction, source: input.source, providerKey: input.providerKey,
    model: input.model, state, script, stale: isStale, canResume: !isStale && !context.hasBody && (state === "rejected" || state === "unknown"),
    billing: "unknown", usage, errorCode, createdAt, finishedAt };
}

export class ShortSequelAiService {
  private readonly executorId = `short-sequel:${randomUUID()}`;

  constructor(private readonly deps: ShortSequelAiDependencies) {}

  private now() { return this.deps.clock?.() ?? new Date(); }

  private view(context: Context, attempts: ShortSequelAiAttempt[], enabled: boolean, nextCursor: string | null = null): ShortSequelAiView {
    const [latest, ...previous] = attempts;
    return { operatorTokenRequired: !this.deps.siteOperator, enabled, hasBody: context.hasBody,
      task: latest ? taskView(latest, context) : null, previousTasks: previous.map(attempt => taskView(attempt, context)), nextCursor };
  }

  async latest(projectId: string, episodeNo: number): Promise<Result> {
    const context = await this.deps.source.context(this.deps.workspaceId, projectId, episodeNo);
    const available = await this.deps.store.storageReady();
    const page = available ? await this.deps.store.listShortSequels(this.deps.workspaceId, projectId, context.episodeId)
      : { attempts: [], nextCursor: null };
    return { status: 200, body: this.view(context, page.attempts, available && this.deps.enabled && operatorConfigured(this.deps), page.nextCursor) };
  }

  async history(projectId: string, episodeNo: number, rawCursor: unknown): Promise<Result> {
    const cursor = historyCursorSchema.safeParse(rawCursor);
    if (!cursor.success) return failure("validation");
    const context = await this.deps.source.context(this.deps.workspaceId, projectId, episodeNo);
    if (!await this.deps.store.storageReady()) return failure("storage");
    const page = await this.deps.store.listShortSequels(this.deps.workspaceId, projectId, context.episodeId, cursor.data);
    const body: ShortSequelAiHistoryPage = { items: page.attempts.map(attempt => taskView(attempt, context)), nextCursor: page.nextCursor };
    return { status: 200, body };
  }

  private async gate(proof: OperatorProof, key: string | undefined) {
    if (!this.deps.enabled) return failure("disabled");
    if (!operatorAllowed(this.deps, proof)) return failure("forbidden");
    if (!key || key.length > 200) return failure("validation");
    return await this.deps.store.storageReady() ? null : failure("storage");
  }

  private async provider(providerKey: TitleWritingProviderKey | null, model?: string) {
    const keys = providerKey ? [providerKey] : TITLE_WRITING_PROVIDER_PREFERENCE;
    for (const key of keys) {
      const config = providerConfigFor(this.deps.providers, key);
      const selected = model ?? config?.models[0];
      if (selected && config?.ok && config.models.includes(selected) && await this.deps.store.providerStorageReady(key)) {
        return { config, model: selected };
      }
    }
    return null;
  }

  async start(projectId: string, episodeNo: number, body: unknown, proof: OperatorProof, actor: StudioContext): Promise<Result> {
    const blocked = await this.gate(proof, actor.idempotencyKey);
    if (blocked) return blocked;
    const request = startSchema.safeParse(body ?? {});
    if (!request.success) return failure("validation");
    const { direction, confirmUncertainAttemptId } = request.data;
    const context = await this.deps.source.context(this.deps.workspaceId, projectId, episodeNo);
    const requestHash = canonicalInputHash({ operation: "start", projectId, episodeNo, direction, confirmUncertainAttemptId: confirmUncertainAttemptId ?? null });
    const replay = await this.replay(actor, requestHash, context);
    if (replay) return replay;
    if (context.hasBody) return failure("body_exists");
    if (context.targetEpisodeSeconds === null) return failure("source_unavailable");
    const provider = await this.provider(this.deps.defaultProvider);
    if (!provider) return failure("provider");
    const source = sourceOf(context);
    const materials = shortSequelAiMaterials(context, source);
    const input: ShortSequelAiInput = { schema: SHORT_SEQUEL_AI_SCHEMA, taskId: randomUUID(), episodeNo,
      episodeId: context.episodeId, episodeCount: context.episodeCount, targetEpisodeSeconds: context.targetEpisodeSeconds,
      direction, source, contextHash: canonicalInputHash(materials),
      providerKey: provider.config.providerKey, model: provider.model };
    if (shortSequelAiStale(input, context) || !prepareShortSequelPrompt(input, materials)) return failure("source_unavailable");
    return this.reserve(projectId, input, context, actor, requestHash, null, confirmUncertainAttemptId ?? null);
  }

  async resume(projectId: string, episodeNo: number, taskId: string, body: unknown, proof: OperatorProof, actor: StudioContext): Promise<Result> {
    const blocked = await this.gate(proof, actor.idempotencyKey);
    if (blocked) return blocked;
    const request = resumeSchema.safeParse(body);
    if (!request.success) return failure("validation");
    const { attemptId, confirmUncertain } = request.data;
    const requestHash = canonicalInputHash({ operation: "resume", projectId, episodeNo, taskId, attemptId, confirmUncertain });
    const context = await this.deps.source.context(this.deps.workspaceId, projectId, episodeNo);
    const replay = await this.replay(actor, requestHash, context);
    if (replay) return replay;
    const attempt = await this.deps.store.getShortSequelAttempt(this.deps.workspaceId, attemptId);
    if (!attempt || attempt.projectId !== projectId || attempt.input.episodeId !== context.episodeId || attempt.input.taskId !== taskId) return failure("not_found");
    if (attempt.state === "unknown" && !confirmUncertain) return failure("needs_confirmation");
    if (attempt.state !== "rejected" && attempt.state !== "unknown") return failure("not_resumable");
    if (context.hasBody) return failure("body_exists");
    if (shortSequelAiStale(attempt.input, context)) return failure("source_changed");
    if (!await this.provider(attempt.input.providerKey, attempt.input.model)) return failure("provider");
    return this.reserve(projectId, attempt.input, context, actor, requestHash, attemptId, attempt.state === "unknown" ? attemptId : null);
  }

  private async replay(actor: StudioContext, requestHash: string, context: Context): Promise<Result | null> {
    const previous = await this.deps.store.findShortSequelByKey(this.deps.workspaceId, actor.actorId, actor.idempotencyKey!);
    return !previous ? null : previous.requestHash === requestHash
      ? { status: 200, body: this.view(context, [previous], true) } : failure("conflict");
  }

  private async reserve(projectId: string, input: ShortSequelAiInput, context: Context, actor: StudioContext,
    requestHash: string, expectedAttemptId: string | null, confirmUncertainAttemptId: string | null): Promise<Result> {
    const now = this.now();
    const created = await this.deps.store.createShortSequel({ id: randomUUID(), workspaceId: this.deps.workspaceId, projectId,
      actorId: actor.actorId, idempotencyKey: actor.idempotencyKey!, requestHash, input, state: "reserved", errorCode: null,
      executorId: this.executorId, leaseUntil: new Date(now.getTime() + WRITING_CANDIDATE_LEASE_MS).toISOString(),
      script: null, usage: unknownUsage, createdAt: now.toISOString(), finishedAt: null },
    { nowIso: now.toISOString(), sinceIso: new Date(now.getTime() - 86_400_000).toISOString(), maxCallsPerDay: this.deps.maxCallsPerDay,
    maxActiveRuns: this.deps.maxActiveRuns, expectedAttemptId, confirmUncertainAttemptId });
    if (!("attempt" in created)) return failure(created.kind);
    if (created.kind === "created") {
      const run = () => this.execute(created.attempt);
      if (this.deps.schedule) this.deps.schedule(run);
      else setImmediate(() => { void run().catch(() => undefined); });
    }
    return { status: created.kind === "created" ? 202 : 200, body: this.view(context, [created.attempt], true) };
  }

  private async execute(attempt: ShortSequelAiAttempt) {
    const { workspaceId, projectId, id, input } = attempt;
    const { store } = this.deps;
    const close = (reason: string) => store.closeUnsent(workspaceId, id, this.executorId, reason, this.now().toISOString());
    const context = await this.deps.source.context(workspaceId, projectId, input.episodeNo).catch((error: unknown) => {
      if (error instanceof PersistenceError && (error.code === "NOT_FOUND" || error.code === "SOURCE_STALE")) return null;
      throw error;
    });
    if (!context || shortSequelAiStale(input, context)) { await close("source_changed"); return; }
    if (context.hasBody) { await close("body_exists"); return; }
    const provider = await this.provider(input.providerKey, input.model);
    if (!provider) { await close("provider_unconfigured"); return; }
    const prompt = prepareShortSequelPrompt(input, shortSequelAiMaterials(context, input.source));
    if (!prompt) { await close("invalid_input"); return; }
    const now = this.now();
    const submitted = await store.markShortSequelSubmitted(attempt, this.executorId, now.toISOString(),
      new Date(now.getTime() + WRITING_CANDIDATE_LEASE_MS).toISOString());
    if (!submitted) return;
    const { config } = provider;
    const exchange = await sendWriting({ adapter: WRITING_ADAPTERS[config.providerKey], url: config.url, apiKey: config.apiKey,
      workspaceId: config.workspaceId, transport: this.deps.transport, request: { model: input.model,
        system: prompt.system, user: prompt.user, schemaName: "short_sequel_episode", jsonSchema: prompt.jsonSchema,
        maxOutputTokens: TEXT_WRITING_MAX_OUTPUT_TOKENS } });
    let candidate: ReturnType<typeof prompt.parse> = null;
    if (exchange.outcome === "answered" && exchange.content !== null) {
      try { candidate = prompt.parse(exchange.content); } catch { /* Invalid provider JSON is a rejected attempt. */ }
    }
    const state: WritingCandidateFinish["state"] = candidate ? "completed" : exchange.outcome === "unknown" ? "unknown" : "rejected";
    await store.finishShortSequel(workspaceId, id, this.executorId, { state, candidate,
      providerRequestId: exchange.providerRequestId, responseModel: exchange.responseModel, usage: exchange.usage,
      errorCode: candidate ? null : exchange.errorCode ?? "invalid_output" }, this.now().toISOString());
  }
}
