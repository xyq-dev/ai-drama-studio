import { ApiError } from "./studio-client";
import { withSession } from "./site-session";

import type {
  SpeechBinding, SpeechBindingPut, SpeechCapabilities, SpeechMixPreflight, SpeechMixRequest,
  SpeechPlanPut, SpeechPlanView, SpeechQuote, SpeechSelection, SpeechTakesPage,
} from "@ai-drama/contracts";

export interface SpeechAcceptedJob { jobId: string; workflowRunId: string; reused: boolean }
export interface SpeechVoiceImpact { inputHash: string; affectedLines: number; affectedShots: number; affectedAssets: number }

export interface SpeechPendingSubmission {
  schema: "speech.browser-submission.v1";
  projectId: string;
  shotRevisionId: string;
  planRevisionId: string;
  lineId: string;
  quote: SpeechQuote;
  maximumAmount: string;
  key: string;
  authorizationId: string | null;
  jobId: string | null;
  confirmedUncertainJobIds: string[];
  unknown: boolean;
}

export class SpeechJournalError extends Error {
  constructor() { super("无法安全保存或核对本次配音请求，已停止新增费用请求。请恢复浏览器会话存储后继续确认原任务。"); }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type WriteOptions = { key: string; ifMatch?: number };
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AMOUNT = /^(0|[1-9]\d{0,7})(\.\d{1,8})?$/;
const journalKey = (projectId: string, shotRevisionId: string) => `ads.speech.pending.v1:${projectId}:${shotRevisionId}`;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === "string" && ID.test(id));

function serialized(value: unknown): string {
  return JSON.stringify(value, (_key, part: unknown) => object(part)
    ? Object.fromEntries(Object.keys(part).sort().map((key) => [key, part[key]])) : part);
}

function pendingRecord(value: unknown, projectId: string, shotRevisionId: string): SpeechPendingSubmission {
  if (!object(value) || value.schema !== "speech.browser-submission.v1" || value.projectId !== projectId || value.shotRevisionId !== shotRevisionId
    || !ID.test(projectId) || !ID.test(shotRevisionId) || typeof value.planRevisionId !== "string" || !ID.test(value.planRevisionId)
    || typeof value.lineId !== "string" || !ID.test(value.lineId) || typeof value.key !== "string" || !/^[-A-Za-z0-9_.:]{1,200}$/.test(value.key)
    || typeof value.maximumAmount !== "string" || !AMOUNT.test(value.maximumAmount) || typeof value.unknown !== "boolean"
    || value.authorizationId !== null && (typeof value.authorizationId !== "string" || !ID.test(value.authorizationId))
    || value.jobId !== null && (typeof value.jobId !== "string" || !ID.test(value.jobId)) || !ids(value.confirmedUncertainJobIds)) throw new SpeechJournalError();
  const quote = value.quote;
  if (!object(quote) || typeof quote.quoteId !== "string" || !quote.quoteId || quote.quoteId.length > 200
    || typeof quote.inputHash !== "string" || !/^[a-f0-9]{64}$/.test(quote.inputHash)
    || !["CNY", "USD"].includes(String(quote.currency)) || typeof quote.maximumAmount !== "string" || !AMOUNT.test(quote.maximumAmount)
    || quote.estimatedAmount !== null && (typeof quote.estimatedAmount !== "string" || !AMOUNT.test(quote.estimatedAmount))
    || typeof quote.expiresAt !== "string" || !Number.isFinite(Date.parse(quote.expiresAt))
    || quote.uncertainJobIds !== undefined && !ids(quote.uncertainJobIds)) throw new SpeechJournalError();
  const expected = [...new Set(quote.uncertainJobIds as string[] | undefined ?? [])].sort();
  if (serialized([...new Set(value.confirmedUncertainJobIds)].sort()) !== serialized(expected)) throw new SpeechJournalError();
  return value as unknown as SpeechPendingSubmission;
}

function frozenIdentity(value: SpeechPendingSubmission): string {
  const { authorizationId: _authorizationId, jobId: _jobId, unknown: _unknown, ...frozen } = value;
  return serialized(frozen);
}

/** The journal contains request identities and consent, never provider credentials or signed media URLs. */
export function readSpeechPending(projectId: string, shotRevisionId: string): SpeechPendingSubmission | null {
  try {
    const raw = globalThis.sessionStorage.getItem(journalKey(projectId, shotRevisionId));
    return raw === null ? null : pendingRecord(JSON.parse(raw), projectId, shotRevisionId);
  } catch { throw new SpeechJournalError(); }
}

/** Every paid request must pass a write plus exact read-back; another operation may never be overwritten. */
export function writeSpeechPending(value: SpeechPendingSubmission): void {
  try {
    pendingRecord(value, value.projectId, value.shotRevisionId);
    const existing = readSpeechPending(value.projectId, value.shotRevisionId);
    if (existing && frozenIdentity(existing) !== frozenIdentity(value)) throw new SpeechJournalError();
    if (existing?.authorizationId && existing.authorizationId !== value.authorizationId
      || existing?.jobId && existing.jobId !== value.jobId) throw new SpeechJournalError();
    const raw = serialized(value);
    const key = journalKey(value.projectId, value.shotRevisionId);
    globalThis.sessionStorage.setItem(key, raw);
    if (globalThis.sessionStorage.getItem(key) !== raw) throw new SpeechJournalError();
  } catch { throw new SpeechJournalError(); }
}

/** Compare the complete acknowledged record before deletion, so a late receipt cannot clear a newer identity. */
export function clearSpeechPending(value: SpeechPendingSubmission): boolean {
  try {
    const key = journalKey(value.projectId, value.shotRevisionId);
    if (globalThis.sessionStorage.getItem(key) !== serialized(value)) return false;
    globalThis.sessionStorage.removeItem(key);
    if (globalThis.sessionStorage.getItem(key) !== null) throw new SpeechJournalError();
    return true;
  } catch { throw new SpeechJournalError(); }
}

function acceptedJob(value: SpeechAcceptedJob): SpeechAcceptedJob {
  if (!value || !ID.test(value.jobId) || !ID.test(value.workflowRunId) || typeof value.reused !== "boolean") {
    throw new ApiError(502, "INVALID_RESPONSE", "配音任务回执无法核对，请继续确认原请求");
  }
  return value;
}

/** Same-origin speech requests use the site's existing session and CSRF boundary. */
export function createSpeechClient(fetchImpl?: FetchLike) {
  const send = withSession(fetchImpl ?? globalThis.fetch.bind(globalThis));
  async function request<T>(path: string, method: "GET" | "POST" | "PUT", body?: unknown, options?: WriteOptions & { signal?: AbortSignal }): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (options?.key) headers["Idempotency-Key"] = options.key;
    if (options?.ifMatch !== undefined) headers["If-Match"] = String(options.ifMatch);
    const response = await send(`/api/v1${path}`, {
      method, headers, credentials: "same-origin", cache: "no-store",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    let value: unknown;
    try { value = await response.json(); } catch { throw new ApiError(response.status, "INVALID_RESPONSE", "服务返回的配音数据无法读取"); }
    if (!response.ok) {
      const error = (value as { error?: { code?: string; message?: string; details?: { overflowMs?: unknown } } })?.error;
      const overflow = error?.details?.overflowMs;
      const detail = error?.code === "SPEECH_AUDIO_OVERFLOW" && typeof overflow === "number" && Number.isFinite(overflow) && overflow > 0
        ? `${error.message ?? "配音超过画面时长"}实际超出 ${(overflow / 1000).toFixed(2)} 秒。`
        : error?.message ?? "配音操作没有完成";
      throw new ApiError(response.status, error?.code ?? "REQUEST_FAILED", detail);
    }
    return value as T;
  }
  const segment = encodeURIComponent;
  return {
    capabilities: (projectId: string, signal?: AbortSignal) => request<SpeechCapabilities>(`/projects/${segment(projectId)}/speech-capabilities`, "GET", undefined, { key: "", signal }),
    bindings: (projectId: string, signal?: AbortSignal) => request<{ items: SpeechBinding[] }>(`/projects/${segment(projectId)}/voice-bindings`, "GET", undefined, { key: "", signal }),
    voiceImpact: (projectId: string, speakerId: string, signal?: AbortSignal) => request<SpeechVoiceImpact>(`/projects/${segment(projectId)}/voice-bindings/${segment(speakerId)}/impact`, "GET", undefined, { key: "", signal }),
    saveBinding: (projectId: string, speakerId: string, body: SpeechBindingPut, options: WriteOptions) =>
      request<SpeechBinding>(`/projects/${segment(projectId)}/voice-bindings/${segment(speakerId)}`, "PUT", body, options),
    plan: (shotRevisionId: string, signal?: AbortSignal) => request<SpeechPlanView>(`/shot-revisions/${segment(shotRevisionId)}/speech-plan`, "GET", undefined, { key: "", signal }),
    savePlan: (shotRevisionId: string, body: SpeechPlanPut, options: WriteOptions) =>
      request<SpeechPlanView>(`/shot-revisions/${segment(shotRevisionId)}/speech-plan`, "PUT", body, options),
    takes: (revisionId: string, signal?: AbortSignal, cursor?: string) => request<SpeechTakesPage>(`/speech-plans/${segment(revisionId)}/takes${cursor ? `?cursor=${segment(cursor)}` : ""}`, "GET", undefined, { key: "", signal }),
    quote: (revisionId: string, lineId: string) => request<SpeechQuote>(`/speech-plans/${segment(revisionId)}/lines/${segment(lineId)}/quote`, "POST", {}),
    authorize: (projectId: string, body: { quoteId: string; maximumAmount: string; confirmSinglePaidOperation: true; confirmedUncertainJobIds?: string[] }, options: WriteOptions) =>
      request<{ budgetAuthorizationId: string; quoteId: string }>(`/projects/${segment(projectId)}/real-media/authorize`, "POST", body, options),
    generate: (revisionId: string, lineId: string, body: { quoteId: string; budgetAuthorizationId: string }, options: WriteOptions) =>
      request<SpeechAcceptedJob>(`/speech-plans/${segment(revisionId)}/lines/${segment(lineId)}/generate`, "POST", body, options).then(acceptedJob),
    select: (revisionId: string, lineId: string, body: { takeAssetId: string; expectedTakeChecksumSha256: string }, options: WriteOptions) =>
      request<{ rowVersion: number; selection: SpeechSelection }>(`/speech-plans/${segment(revisionId)}/selections/${segment(lineId)}`, "PUT", body, options),
    mixPreflight: (revisionId: string, body: SpeechMixRequest) =>
      request<SpeechMixPreflight>(`/speech-plans/${segment(revisionId)}/mix-preflight`, "POST", body),
    job: (jobId: string, signal?: AbortSignal) => request<{ id: string; state: string; errorMessage?: string | null }>(`/generation-jobs/${segment(jobId)}`, "GET", undefined, { key: "", signal }),
  };
}

export type SpeechClient = ReturnType<typeof createSpeechClient>;
