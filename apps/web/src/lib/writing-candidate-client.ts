import type { WritingCandidateOptionsView, WritingCandidateStart, WritingCandidateView } from "@ai-drama/contracts";
import { withSession } from "./site-session";
import { TitleWritingError, TitleWritingUnconfirmedError, isEntityId, operatorHeader } from "./title-writing-client";

export type { WritingCandidateOptionsView, WritingCandidateView };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The request in a receipt, only when it names a request of exactly this work. */
export function candidateReceipt(body: unknown, projectId: string): WritingCandidateView | null {
  if (!body || typeof body !== "object") return null;
  const request = (body as { request?: unknown }).request;
  if (!request || typeof request !== "object") return null;
  const view = request as Partial<WritingCandidateView>;
  return isEntityId(view.requestId) && view.projectId === projectId ? request as WritingCandidateView : null;
}

/**
 * Browser side of the online candidates: it asks for one, reads it back and lists a target's recent requests. It never
 * adopts or saves anything; provider keys and the operator token never come from the server.
 */
export class WritingCandidateClient {
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
        ? (parsed as { error?: { code?: string; message?: string; details?: Record<string, unknown> } }).error
        : undefined;
      throw new TitleWritingError(response.status, error?.code ?? "REQUEST_FAILED", error?.message ?? `HTTP ${String(response.status)}`, error?.details ?? null);
    }
    return { status: response.status, body: parsed as T };
  }

  /** A malformed answer is an error, never a half-read configuration. */
  async options(): Promise<WritingCandidateOptionsView> {
    const result = await this.call<unknown>("/writing/candidates/options", { method: "GET", headers: { Accept: "application/json" } });
    const value = result.body as Partial<WritingCandidateOptionsView> | null;
    if (!value || typeof value !== "object" || typeof value.code !== "string" || typeof value.enabled !== "boolean"
      || !Array.isArray(value.providers)) throw new TitleWritingUnconfirmedError(result.status);
    return value as WritingCandidateOptionsView;
  }

  /** Resolves only with a receipt naming a request of this work; anything else throws TitleWritingUnconfirmedError. */
  async start(projectId: string, body: WritingCandidateStart, options: { token: string; idempotencyKey: string }): Promise<WritingCandidateView> {
    const result = await this.call<unknown>(`/projects/${projectId}/writing/candidates`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": options.idempotencyKey,
        ...operatorHeader(options.token) },
      body: JSON.stringify(body),
    });
    const view = candidateReceipt(result.body, projectId);
    if (!view) throw new TitleWritingUnconfirmedError(result.status);
    return view;
  }

  async get(projectId: string, requestId: string, signal?: AbortSignal): Promise<WritingCandidateView> {
    const result = await this.call<unknown>(`/projects/${projectId}/writing/candidates/${requestId}`,
      { method: "GET", headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) });
    const view = candidateReceipt(result.body, projectId);
    if (!view || view.requestId !== requestId) throw new TitleWritingUnconfirmedError(result.status);
    return view;
  }

  async list(projectId: string, target: { mode: "story" | "episode"; episodeId: string | null }): Promise<WritingCandidateView[]> {
    const query = new URLSearchParams({ mode: target.mode, ...(target.episodeId ? { episodeId: target.episodeId } : {}) });
    const result = await this.call<{ items?: unknown }>(`/projects/${projectId}/writing/candidates?${query.toString()}`,
      { method: "GET", headers: { Accept: "application/json" } });
    const items = Array.isArray(result.body.items) ? result.body.items : [];
    return items.filter((item): item is WritingCandidateView => candidateReceipt({ request: item }, projectId) !== null);
  }
}

/** The answer of a request as shown to a person. A possible charge is never written as none. */
export function candidateStateText(view: Pick<WritingCandidateView, "state" | "errorCode">): string {
  switch (view.state) {
    case "reserved":
    case "submitted":
      return "正在请求模型，请稍候。这一步只会发送一次。";
    case "completed":
      return "候选已生成并通过校验。还没有放入编辑草稿。";
    case "unknown":
      return "结果不确定：模型服务可能已经处理并产生费用，系统不会自动重发。可以重新读取这次请求，或确认后再发起新的生成。";
    default:
      return `没有得到可用的候选（${candidateErrorText(view.errorCode)}）。没有改动正文。`;
  }
}

export function candidateErrorText(code: string | null): string {
  const known: Record<string, string> = {
    auth: "模型服务认证失败，密钥无效、已停用或已过期",
    permission: "密钥没有该工作区或该模型的使用权限",
    workspace_required: "密钥未限定 Workspace，需要在后台填写 Workspace ID",
    workspace_invalid: "Workspace ID 无效或无权访问",
    quota: "模型服务账户余额或额度不足",
    rate_limited: "模型服务限流",
    bad_request: "模型服务认为请求无效",
    refusal: "模型拒绝了这次创作",
    truncated: "回答被截断",
    invalid_output: "回答不是有效的候选",
    unsafe_content: "回答含有 HTML、URL 或可执行标记",
    episode_mismatch: "回答的集数不对",
    too_large: "回答超过长度上限",
    provider_unconfigured: "模型服务没有配置",
    executor_lost_before_send: "服务重启，请求没有发出",
    provider_error: "模型服务返回错误",
  };
  return code ? known[code] ?? code : "未知原因";
}

export function candidateTerminal(view: Pick<WritingCandidateView, "state">): boolean {
  return view.state !== "reserved" && view.state !== "submitted";
}
