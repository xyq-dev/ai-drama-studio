import {
  SERIES_MAX_RESEND_ALLOWANCE,
  seriesBatchCount,
  seriesBatchRange,
  seriesScopeCalls,
  seriesScopeJobs,
  type SeriesScope,
} from "@ai-drama/contracts";
import type { SeriesView } from "@ai-drama/domain";
import { withSession } from "./site-session";
import { TitleWritingError, TitleWritingUnconfirmedError, isEntityId, operatorHeader } from "./title-writing-client";

export type { SeriesView };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SeriesOptionsView {
  enabled: boolean;
  code: string;
  storageReady: boolean;
  operatorTokenRequired: boolean;
  defaultProvider: string | null;
  providers: Array<{ providerKey: string; label: string; ready: boolean; models: string[]; defaultModel: string | null; missing: string[] }>;
  configurationPending: boolean;
  maxCallsPerDay: number;
  maxActiveRuns: number;
  billing: "unknown";
  episodes: { min: number; max: number; secondsChoices: number[]; defaultSeconds: number; batchSize: number; outlineChunk: number };
  formula: string;
  maxCallsPerJob: number;
  maxResendAllowance: number;
  maxOutputTokensPerCall: number;
  maxPromptChars: number;
  reviewContentChars: number;
  research: { fetchEnabled: boolean; expectedMode: "sourced" | "limited"; visualAnalysis: false };
  media: { enabled: false; note: string };
}

export interface SeriesCreateBody {
  title: string;
  episodeCount: number;
  episodeSeconds: number;
  idea: string;
  constraints: { genre: string; audience: string; maxCharacters: number | null; maxLocations: number | null; forbiddenThemes: string[]; endingRequirement: string };
}

export interface SeriesGrantBody {
  scope: SeriesScope;
  normalCalls: number;
  resendAllowance: number;
  callBudget: number;
  providerKey: string;
  model: string;
  basePlanRevisionId: string | null;
}

/** The series in a receipt, only when it names exactly this work. */
export function seriesReceipt(body: unknown, projectId: string | null): SeriesView | null {
  const series = body && typeof body === "object" ? (body as { series?: unknown }).series : null;
  if (!series || typeof series !== "object") return null;
  const view = series as Partial<SeriesView>;
  if (!isEntityId(view.seriesId) || !isEntityId(view.projectId)) return null;
  return projectId === null || view.projectId === projectId ? series as SeriesView : null;
}

/** Browser side of series writing. Keys never reach the page; every paid action carries an idempotency key. */
export class SeriesWritingClient {
  constructor(private readonly fetchImpl?: FetchLike, private readonly prefix = "/api/v1") {}

  private async call<T>(path: string, init: RequestInit): Promise<{ status: number; body: T }> {
    const response = await withSession(this.fetchImpl ?? globalThis.fetch.bind(globalThis))(`${this.prefix}${path}`, init);
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length === 0 ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const error = parsed && typeof parsed === "object" && "error" in parsed
        ? (parsed as { error?: { code?: string; message?: string; details?: Record<string, unknown> } }).error : undefined;
      throw new TitleWritingError(response.status, error?.code ?? "REQUEST_FAILED", error?.message ?? `HTTP ${String(response.status)}`, error?.details ?? null);
    }
    return { status: response.status, body: parsed as T };
  }

  private json(method: string, body: unknown, extra: Record<string, string> = {}): RequestInit {
    return { method, headers: { Accept: "application/json", "Content-Type": "application/json", ...extra }, body: JSON.stringify(body) };
  }

  async options(): Promise<SeriesOptionsView> {
    return (await this.call<SeriesOptionsView>("/writing/series/options", { method: "GET", headers: { Accept: "application/json" } })).body;
  }

  async create(body: SeriesCreateBody, options: { token: string; idempotencyKey: string }): Promise<SeriesView> {
    const result = await this.call<unknown>("/writing/series", this.json("POST", body, { "Idempotency-Key": options.idempotencyKey, ...operatorHeader(options.token) }));
    const series = seriesReceipt(result.body, null);
    if (!series) throw new TitleWritingUnconfirmedError(result.status);
    return series;
  }

  async get(projectId: string, signal?: AbortSignal): Promise<SeriesView> {
    const result = await this.call<unknown>(`/projects/${projectId}/series`, { method: "GET", headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) });
    const series = seriesReceipt(result.body, projectId);
    if (!series) throw new TitleWritingUnconfirmedError(result.status);
    return series;
  }

  async grant(projectId: string, body: SeriesGrantBody, options: { token: string; idempotencyKey: string }): Promise<SeriesView> {
    const result = await this.call<unknown>(`/projects/${projectId}/series/grants`,
      this.json("POST", body, { "Idempotency-Key": options.idempotencyKey, ...operatorHeader(options.token) }));
    const series = seriesReceipt(result.body, projectId);
    if (!series) throw new TitleWritingUnconfirmedError(result.status);
    return series;
  }

  async cancel(projectId: string, grantId: string): Promise<SeriesView> {
    const result = await this.call<unknown>(`/projects/${projectId}/series/grants/${grantId}/cancel`, { method: "POST", headers: { Accept: "application/json" } });
    return seriesReceipt(result.body, projectId)!;
  }

  async resume(projectId: string, grantId: string, options: { confirmUncertainCallIds: readonly string[]; token: string; idempotencyKey: string }): Promise<SeriesView> {
    const result = await this.call<unknown>(`/projects/${projectId}/series/grants/${grantId}/resume`,
      this.json("POST", { confirmUncertainCallIds: options.confirmUncertainCallIds }, { "Idempotency-Key": options.idempotencyKey, ...operatorHeader(options.token) }));
    const series = seriesReceipt(result.body, projectId);
    if (!series) throw new TitleWritingUnconfirmedError(result.status);
    return series;
  }

  async place(projectId: string, batchNo: number): Promise<{ placed: number; conflicts: number[]; series: SeriesView }> {
    return (await this.call<{ placed: number; conflicts: number[]; series: SeriesView }>(`/projects/${projectId}/series/batches/${String(batchNo)}/scripts`,
      this.json("POST", {}))).body;
  }

  /** baseStoryRevisionId: the work's current story the page showed; story: a new DRAFT from the plan, or that story adopted. */
  async savePlan(projectId: string, body: { basePlanRevisionId: string; baseStoryRevisionId: string | null; story: "from_plan" | "adopt_current"; content: unknown }): Promise<SeriesView> {
    return seriesReceipt((await this.call<unknown>(`/projects/${projectId}/series/plan-revisions`, this.json("POST", body))).body, projectId)!;
  }

  /** expectedBasis: the ledgerBasis frozen when the editor was opened; anything changed since makes the server refuse (409). */
  async saveLedger(projectId: string, body: { batchNo: number; baseLedgerRevisionId: string | null; content: unknown; summaries: Array<{ episodeNo: number; summary: string }>;
    expectedBasis: Record<string, string> }): Promise<SeriesView> {
    return seriesReceipt((await this.call<unknown>(`/projects/${projectId}/series/ledger-revisions`, this.json("POST", body))).body, projectId)!;
  }

  /** expectedBasis: the decisionBasis the page showed; a newer version makes the server refuse (409) and record nothing. */
  async decide(projectId: string, body: { target: string; note: string; expectedBasis: Record<string, string> }): Promise<SeriesView> {
    return seriesReceipt((await this.call<unknown>(`/projects/${projectId}/series/decisions`, this.json("POST", body))).body, projectId)!;
  }

  packageUrl(projectId: string, format: "markdown" | "json"): string {
    return `${this.prefix}/projects/${projectId}/series/package?format=${format}`;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Requests whose answer did not arrive are kept in session storage and replayed unchanged (same key, same body).

export interface PendingSeriesRequest<T> {
  version: 1;
  scope: string;
  key: string;
  body: T;
}

function storageKey(scope: string): string {
  return `series-writing:${scope}`;
}

export function readPendingSeries<T>(scope: string): PendingSeriesRequest<T> | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(scope));
    const parsed = raw ? JSON.parse(raw) as Partial<PendingSeriesRequest<T>> : null;
    return parsed && parsed.version === 1 && parsed.scope === scope && typeof parsed.key === "string" && parsed.body !== undefined ? parsed as PendingSeriesRequest<T> : null;
  } catch {
    return null;
  }
}

/** Saved and read back before the write that uses it; false means no request may be sent. */
export function savePendingSeries<T>(pending: PendingSeriesRequest<T>): boolean {
  try {
    const text = JSON.stringify(pending);
    window.sessionStorage.setItem(storageKey(pending.scope), text);
    return window.sessionStorage.getItem(storageKey(pending.scope)) === text;
  } catch {
    return false;
  }
}

export function clearPendingSeries(scope: string, key: string): void {
  try {
    const stored = readPendingSeries(scope);
    if (stored && stored.key === key) window.sessionStorage.removeItem(storageKey(scope));
  } catch {
    // Nothing to keep.
  }
}

/** A refusal the server answered (the request was not accepted): a new identity may be made for the next attempt. */
export function seriesRefused(caught: unknown): boolean {
  return caught instanceof TitleWritingError && caught.status >= 400 && caught.status < 500;
}

// ---------------------------------------------------------------------------------------------------------------
// Scopes and labels.

export type SeriesPreset = "plan" | "plan_first" | "continue" | "final";

/** The scope a preset authorizes for this series now (continue: from the next batch to the chosen last one). */
export function presetScope(view: SeriesView, preset: SeriesPreset, lastBatch: number, includeFinal: boolean): SeriesScope {
  const batches = seriesBatchCount(view.episodeCount);
  if (preset === "plan") return { plan: true, batchFrom: null, batchTo: null, final: false };
  if (preset === "plan_first") return { plan: true, batchFrom: 1, batchTo: 1, final: false };
  if (preset === "final") return { plan: false, batchFrom: null, batchTo: null, final: true };
  const from = view.next.batchNo ?? batches;
  const to = Math.max(from, Math.min(batches, lastBatch));
  return { plan: false, batchFrom: from, batchTo: to, final: includeFinal && to === batches };
}

export function scopeSummary(episodeCount: number, scope: SeriesScope): { normal: number; jobs: string[] } {
  return {
    normal: seriesScopeCalls(episodeCount, scope),
    jobs: seriesScopeJobs(episodeCount, scope).map((job) => job.kind === "plan" ? `全剧规划 ${String(job.calls)} 次`
      : job.kind === "final" ? `全剧总检 ${String(job.calls)} 次`
        : `第 ${String(seriesBatchRange(episodeCount, job.batchNo!).first)}–${String(seriesBatchRange(episodeCount, job.batchNo!).last)} 集 ${String(job.calls)} 次`),
  };
}

/** What a scope authorizes, in words (the same wording as the server's grant list). */
export function seriesScopeText(episodeCount: number, scope: SeriesScope): string {
  const parts: string[] = [];
  if (scope.plan) parts.push("全剧规划");
  if (scope.batchFrom !== null && scope.batchTo !== null) {
    parts.push(`第 ${String(seriesBatchRange(episodeCount, scope.batchFrom).first)}–${String(seriesBatchRange(episodeCount, scope.batchTo).last)} 集正文及逐批审阅`);
  }
  if (scope.final) parts.push("全剧结构与连续性总检");
  return parts.join(" + ");
}

export const MAX_RESEND = SERIES_MAX_RESEND_ALLOWANCE;

const BLOCKERS: Record<string, string> = {
  plan_missing: "还没有全剧规划",
  plan_review_blocking: "规划审阅发现必须修改的问题（修改规划或人工复核后才能继续）",
  plan_unreviewed: "规划经人工修改，需要人工复核",
  story_changed: "工作台的故事已另存，和规划绑定的故事不同：请先同步规划与故事",
  episode_source_stale: "这一批有分集的工作台剧本因故事更换而过期：请在工作台按当前故事重新保存这些分集",
  batch_incomplete: "前一批还没有写完（有分集的模型阶段或这一批的全文审阅还没完成；人工稿不代替它们）",
  ledger_pending_confirmation: "前一批有人工改稿，连续性台账待确认",
  ledger_stale: "上游已变化，连续性台账需要重新确认",
  batch_review_blocking: "前一批的全文审阅发现必须修改的问题",
  batch_review_stale: "前一批的正文在审阅后被修改，需要人工复核",
  batch_review_missing: "前一批还没有全文审阅",
  episodes_incomplete: "还有未写的集数",
  final_review_missing: "全剧总检还没有执行",
  final_review_stale: "全剧总检读取的依赖已变化，需要重新总检或人工复核",
  final_review_blocking: "全剧总检发现必须修改的问题",
};

export function blockerText(code: string): string {
  const [kind, batch] = code.split(":");
  const text = BLOCKERS[kind!] ?? kind!;
  return batch ? `第 ${batch} 批：${text}` : text;
}

/** Why a written batch cannot be placed into the workbench now (the view's batch placement state). */
const PLACEMENT: Record<string, string> = {
  batch_incomplete: "这一批的模型阶段或全文审阅还没完成",
  story_changed: "工作台的故事不是规划绑定的故事，请先同步规划与故事",
  episode_source_stale: "有分集的工作台剧本因故事更换而过期",
  ledger_pending_confirmation: "有人工改稿，请先确认台账",
  ledger_stale: "规划或上游台账已变化，请先重新确认台账",
  batch_review_missing: "还没有全文审阅",
  batch_review_stale: "全文审阅读取的依赖已变化，请先人工复核",
  plan_missing: "这一批所依据的规划修订不存在",
};

export function placementText(placement: string): string {
  return `暂不能写入：${PLACEMENT[placement] ?? placement}`;
}

const STOPS: Record<string, string> = {
  daily_quota_low: "最近 24 小时剩余调用不够下一步，已停在两步之间；额度恢复后可以继续，不会重发已完成的部分。",
  grant_budget_exhausted: "这次授权的预算不足以完成剩余范围，已停止；不会自动追加预算。",
  batch_review_blocking: "批次全文审阅发现必须修改的问题，已停止调度后续批次。",
  plan_review_blocking: "规划审阅发现必须修改的问题，已停止调度正文。",
  ledger_pending_confirmation: "有人工改稿，连续性台账待确认，已停止调度后续批次。",
  upstream_plan_changed: "规划在授权执行期间被修改，已停止，不会在旧规划上继续写。",
  upstream_ledger_changed: "台账在授权执行期间变化，已停止。",
  upstream_episode_changed: "前一集在授权执行期间被修改，已停止。",
  upstream_story_changed: "作品的故事在授权执行期间被另存，已停止，不会在旧故事上继续写。",
  upstream_plan_superseded: "这次规划已被后来的规划取代，不会再续跑，也不会再生成一份规划。",
  provider_unconfigured: "冻结的模型服务现在不可用，已停止，不会改用其他服务。",
  executor_lost: "服务重启或执行者丢失时有一次调用结果未知，已停止；确认后才会重新发送。",
  server_error: "模型服务返回错误，结果未知，已停止；确认后才会重新发送。",
  timeout: "调用超时，结果未知，已停止；确认后才会重新发送。",
  canceled: "已取消。",
  finale_misplaced: "模型把非最后一集写成了全剧结局，已拒收并停止（不会自动重试）。",
  too_large: "输出超过长度预算，已整份拒收（不会截断），已停止。",
  prompt_too_large: "下一步的输入超过长度上限，已停止，没有发出调用。",
};

export function stopText(reason: string | null): string | null {
  if (!reason) return null;
  const code = reason.split("@")[0]!;
  return STOPS[code] ?? `已停止（${code}）。`;
}

export const LEDGER_LABELS: Record<string, string> = {
  none: "未生成", valid: "有效（程序台账）", confirmed: "有效（人工确认）", pending_confirmation: "待确认（有人工改稿）", stale: "需重新确认（上游变化）",
};

export const REVIEW_LABELS: Record<string, string> = {
  none: "未审阅", passed: "机器检查通过（内部参考）", needs_revision: "待修改", stale: "待复核（审阅读取的依赖已变化）", cleared: "已人工复核",
};

export const EPISODE_STATES: Record<string, string> = {
  pending: "待写", written: "已写", needs_revision: "待修改", pending_confirmation: "待确认台账", stale: "待复核", source_stale: "来源过期（故事已更换）",
};

export const PLAN_LABELS: Record<string, string> = {
  none: "未生成", passed: "规划审阅通过（机器，内部参考）", needs_revision: "规划待修改", unreviewed: "人工修改，待复核", cleared: "已人工复核",
};
