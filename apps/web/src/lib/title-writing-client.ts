import {
  currentUncertainCallIds,
  type TitleWritingOptionsView,
  type TitleWritingProviderKey,
  type TitleWritingRunView,
  type TitleWritingStepKey,
  type TitleWritingStepState,
} from "@ai-drama/contracts";
import { ApiError } from "./studio-client";

export type { TitleWritingOptionsView, TitleWritingRunView };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** An API refusal with its server details (for example the names of missing configuration variables). */
export class TitleWritingError extends ApiError {
  constructor(status: number, code: string, detail: string, readonly details: Record<string, unknown> | null) {
    super(status, code, detail);
  }
}

/**
 * A success status whose body does not prove what was done (no run id, a run of another work, an unreadable body).
 * The result stays unknown: whoever sent the request keeps its keys and may only replay it.
 */
export class TitleWritingUnconfirmedError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${String(status)} without a usable receipt`);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isEntityId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** The run in a start receipt, only when it names a run of exactly this work. */
export function startReceiptRun(body: unknown, projectId: string): TitleWritingRunView | null {
  if (!body || typeof body !== "object") return null;
  const run = (body as { run?: unknown }).run;
  if (!run || typeof run !== "object") return null;
  const view = run as Partial<TitleWritingRunView>;
  return isEntityId(view.runId) && view.projectId === projectId ? run as TitleWritingRunView : null;
}

export interface StartBody {
  title: string;
  providerKey?: TitleWritingProviderKey;
  model?: string;
  settings?: { episodeSeconds?: number; style?: string };
}

/**
 * Browser side of title-driven writing: it only starts, reads and asks to stop or resume. The operator token lives in
 * page memory and goes only in the X-Operator-Token header of start and resume; provider keys never reach the page.
 */
export class TitleWritingClient {
  constructor(private readonly fetchImpl?: FetchLike, private readonly prefix = "/api/v1") {}

  private async call<T>(path: string, init: RequestInit): Promise<{ status: number; body: T }> {
    const fetchImpl = this.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const response = await fetchImpl(`${this.prefix}${path}`, init);
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length === 0 ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const error = parsed && typeof parsed === "object" && "error" in parsed
        ? (parsed as { error?: { code?: string; message?: string; details?: Record<string, unknown> } }).error
        : undefined;
      throw new TitleWritingError(response.status, error?.code ?? "REQUEST_FAILED", error?.message ?? `HTTP ${response.status}`, error?.details ?? null);
    }
    return { status: response.status, body: parsed as T };
  }

  async options(): Promise<TitleWritingOptionsView> {
    return (await this.call<TitleWritingOptionsView>("/writing/title-runs/options", { method: "GET", headers: { Accept: "application/json" } })).body;
  }

  /** Resolves only with a receipt naming a run of this work; any other success body throws TitleWritingUnconfirmedError. */
  async start(projectId: string, body: StartBody, options: { token: string; idempotencyKey: string }): Promise<TitleWritingRunView> {
    const result = await this.call<unknown>(`/projects/${projectId}/title-runs`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": options.idempotencyKey,
        "X-Operator-Token": options.token },
      body: JSON.stringify(body),
    });
    const run = startReceiptRun(result.body, projectId);
    if (!run) throw new TitleWritingUnconfirmedError(result.status);
    return run;
  }

  async latest(projectId: string, signal?: AbortSignal): Promise<TitleWritingRunView | null> {
    return (await this.call<{ run: TitleWritingRunView | null }>(`/projects/${projectId}/title-runs/latest`,
      { method: "GET", headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) })).body.run;
  }

  async cancel(projectId: string, runId: string): Promise<TitleWritingRunView> {
    return (await this.call<{ run: TitleWritingRunView }>(`/projects/${projectId}/title-runs/${runId}/cancel`,
      { method: "POST", headers: { Accept: "application/json" } })).body.run;
  }

  /**
   * confirmUncertainCallIds are the uncertain calls the person saw and accepted may be billed again. The idempotency
   * key identifies this one resume action: a retry after an unanswered request reuses it, so it is applied once.
   */
  async resume(projectId: string, runId: string, options: { confirmUncertainCallIds: readonly string[]; token: string; idempotencyKey: string }): Promise<TitleWritingRunView> {
    return (await this.call<{ run: TitleWritingRunView }>(`/projects/${projectId}/title-runs/${runId}/resume`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Operator-Token": options.token,
        "Idempotency-Key": options.idempotencyKey },
      body: JSON.stringify({ confirmUncertainCallIds: options.confirmUncertainCallIds }),
    })).body.run;
  }

  async placeScripts(projectId: string, runId: string, acceptStoryChanged: boolean): Promise<TitleWritingRunView> {
    return (await this.call<{ run: TitleWritingRunView }>(`/projects/${projectId}/title-runs/${runId}/scripts`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ acceptStoryChanged }),
    })).body.run;
  }
}

/** Reads a possibly malformed options body: anything unexpected counts as "not ready". */
export function normalizeOptions(value: unknown): TitleWritingOptionsView | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<TitleWritingOptionsView>;
  if (typeof record.code !== "string" || !Array.isArray(record.providers) || typeof record.enabled !== "boolean") return null;
  return record as TitleWritingOptionsView;
}

export function optionsUnavailableReason(options: TitleWritingOptionsView | null): string | null {
  if (!options) return "没能读取 AI 创作的服务端配置。可以稍后重试，或先手动创作。";
  if (options.code === "TITLE_WRITING_READY") return null;
  if (options.code === "TITLE_WRITING_DISABLED") return "AI 一键创作没有在服务端开启（TITLE_WRITING_ENABLED）。可以先手动创作。";
  if (options.code === "TITLE_WRITING_FORBIDDEN") return "服务端还没有设置操作者令牌（TITLE_WRITING_OPERATOR_TOKEN）。可以先手动创作。";
  if (options.code === "TITLE_WRITING_STORAGE_UNAVAILABLE") return "创作任务的数据库表还没有创建（服务器尚未执行数据库迁移）。可以先手动创作。";
  if (options.code === "TITLE_WRITING_PROVIDER_UNCONFIGURED") {
    const missing = options.providers.map((item) => `${item.label}：${item.missing.join("、")}`).join("；");
    return `还没有可用的模型服务。缺少的服务端配置：${missing}。可以先手动创作。`;
  }
  return "AI 一键创作暂不可用。可以先手动创作。";
}

const STEP_LABELS: Record<TitleWritingStepKey, string> = {
  concept: "故事策划",
  outline: "分集大纲",
  "episode:1": "第 1 集剧本",
  "episode:2": "第 2 集剧本",
  "episode:3": "第 3 集剧本",
};

export function stepLabel(stepKey: TitleWritingStepKey): string {
  return STEP_LABELS[stepKey];
}

const STEP_STATES: Record<TitleWritingStepState, string> = {
  pending: "等待中",
  reserved: "正在进行",
  submitted: "正在进行",
  completed: "已完成",
  rejected: "没有通过",
  unknown: "结果不确定",
  canceled: "已取消",
};

export function stepStateText(state: TitleWritingStepState): string {
  return STEP_STATES[state];
}

/** The headline is derived from server state only: no percentage, no timer. */
export function runHeadline(run: TitleWritingRunView): string {
  if (run.state === "completed") return "创作完成";
  if (run.state === "partial") return "部分完成";
  if (run.state === "needs_attention") return "需要处理";
  if (run.state === "canceled") return "已取消";
  if (run.state === "failed") return "没有完成";
  if (run.cancelRequested) return "正在停止";
  const next = run.steps.find((step) => step.state !== "completed");
  if (!next) return "正在保存结果";
  if (next.stepKey === "concept") return "正在构思故事";
  if (next.stepKey === "outline") return "正在规划分集";
  return `正在编写第 ${next.stepKey.slice(-1)} 集`;
}

const ERRORS: Record<string, string> = {
  auth: "模型服务拒绝了服务端密钥（鉴权失败）。请检查服务端配置。",
  quota: "模型账户的余额或额度不足。",
  rate_limited: "请求太频繁，被模型服务限流了。",
  bad_request: "模型服务认为请求参数无效。",
  refusal: "模型拒绝了这次创作。",
  truncated: "模型的回答超出长度被截断，没有保存。",
  invalid_output: "模型返回的内容格式不符合要求，没有保存。",
  episode_mismatch: "模型返回的集号不对，没有保存。",
  unsafe_content: "模型返回的内容含有网址或网页代码，没有保存。",
  too_large: "模型返回的内容超过长度上限，没有保存。",
  timeout: "等待模型超时。模型可能已经处理并产生费用，不会自动重发。",
  disconnected: "连接中断。模型可能已经处理并产生费用，不会自动重发。",
  server_error: "模型服务出错。模型可能已经处理并产生费用，不会自动重发。",
  redirect_rejected: "模型服务返回了重定向，已停止。结果和费用不确定。",
  response_too_large: "模型回答过大，已停止读取。结果和费用不确定。",
  provider_error: "模型服务返回了意外的状态。",
  executor_lost: "服务重启时这一步已经发出，结果和费用不确定，不会自动重发。",
  executor_lost_before_send: "服务重启时这一步还没有发出。",
  canceled_before_send: "停止请求先到达，这一步没有发出。",
  provider_unconfigured: "这次创作使用的模型服务现在没有配置完整，没有发出请求。",
  story_conflict: "作品里已经有故事，没有覆盖。生成的故事保留在下方。",
  story_too_large: "整理后的故事超过长度上限，没有保存。",
  TITLE_WRITING_DAILY_CAP: "今天的调用次数已达服务端上限。",
  TITLE_WRITING_RUN_CAP: "这次创作的调用次数已达上限。",
};

export function errorText(code: string | null): string | null {
  if (code === null) return null;
  return ERRORS[code] ?? "出现了未识别的问题。";
}

export function hasUncertain(run: TitleWritingRunView): boolean {
  return run.steps.some((step) => step.state === "unknown");
}

/** The uncertain calls a resume would resend now, by the same rule the server applies. */
export function uncertainCallIds(run: TitleWritingRunView): string[] {
  return currentUncertainCallIds(run.steps, run.calls);
}

export function canResume(run: TitleWritingRunView): boolean {
  if (run.state === "running" || run.state === "completed") return false;
  if (run.storySave === "conflict" && run.steps.every((step) => step.state === "completed")) return false;
  return true;
}

export function scriptsAwaitApproval(run: TitleWritingRunView): boolean {
  return run.steps.some((step) => step.scriptSave === "awaiting_story_approval" && step.state === "completed");
}
