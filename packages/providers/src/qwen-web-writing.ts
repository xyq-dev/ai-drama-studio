import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { WRITING_PROMPT_VERSION, parseQwenWritingInput, type QwenWritingInput } from "@ai-drama/contracts";
import { buildEpisodeDraftInstruction, buildStoryPlanInstruction } from "@ai-drama/domain";
import { QWEN_CHAT_MAX_TOKENS, QWEN_CHAT_MODEL_ENV, QWEN_CHAT_TIMEOUT_MS, buildQwenChatBody, qwenFailureMessage, readQwenApiKey, redactSecret, resolveQwenChatEndpoint, selectedQwenModel, sendQwenChat, type QwenTransport } from "./qwen-chat";
import { acceptPreparedCandidate } from "./qwen-writing";

/** Qwen web calls are not replay-safe and must not enter the M2 text job path. */
export const QWEN_WEB_REPLAY_POLICY = "NOT_REPLAY_SAFE" as const;
export const QWEN_WEB_RETENTION_DAYS_DEFAULT = 7;
export const QWEN_WEB_MAX_REQUESTS_DEFAULT = 8;
export const QWEN_WEB_MAX_CONCURRENCY_DEFAULT = 1;
/**
 * The executor lease covers the capped send time twice over. Recovery may act only after it expires: a live
 * executor has either finished by then or will be fenced out of its finish.
 */
export const QWEN_WEB_EXECUTOR_LEASE_MS = QWEN_CHAT_TIMEOUT_MS * 2;

export type QwenWebState = "reserved" | "submitted" | "completed" | "rejected" | "unknown";

export interface QwenWebRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  actorId: string;
  idempotencyKey: string;
  inputHash: string;
  frozenInput: QwenWritingInput;
  mode: "story" | "episode";
  episodeNo: 1 | 2 | 3 | null;
  requestedModel: string;
  state: QwenWebState;
  /** The process-local sender that owns reserved/submitted. Only it may finish the record. */
  executorId: string;
  leaseUntil: string;
  serverRequestId: string | null;
  errorCode: string | null;
  providerResult: "completed" | "unknown" | null;
  candidateJson: string | null;
  candidateExpiresAt: string | null;
  billingStatus: "unknown";
  createdAt: string;
  updatedAt: string;
}

export type QwenWebFinish = Pick<QwenWebRecord, "serverRequestId" | "errorCode" | "providerResult" | "candidateJson" | "candidateExpiresAt" | "updatedAt"> & {
  state: Exclude<QwenWebState, "reserved" | "submitted">;
};
export type QwenWebReservation =
  | { kind: "reserved" | "existing" | "conflict"; record: QwenWebRecord }
  | { kind: "blocked"; code: "QWEN_WEB_REQUEST_CAP" | "QWEN_WEB_CONCURRENCY_CAP" };

export interface QwenWebStore {
  /** Key lookup, identity comparison, both caps and insert must be one atomic operation. */
  reserve(record: QwenWebRecord, limits: { sinceIso: string; maxRequests: number; maxConcurrency: number }): Promise<QwenWebReservation>;
  findByKey(workspaceId: string, actorId: string, key: string): Promise<QwenWebRecord | null>;
  findById(workspaceId: string, projectId: string, id: string): Promise<QwenWebRecord | null>;
  /** reserved -> submitted, only for the owning executor whose lease is still live. */
  markSubmitted(id: string, executorId: string, updatedAt: string, leaseUntil: string): Promise<boolean>;
  /** Only the still-submitted owning executor may finish. Recovery cannot be overwritten. */
  finish(id: string, executorId: string, patch: QwenWebFinish): Promise<QwenWebRecord>;
  /**
   * Recovery: a record whose executor lease expired is fenced. reserved was never sent and becomes rejected;
   * submitted may have reached the provider and becomes unknown. A live lease is never touched, so a replay
   * or a concurrent recovery cannot turn a running request into unknown.
   */
  recoverExpired(nowIso: string): Promise<number>;
  expireCandidates(nowIso: string): Promise<number>;
}

export const QWEN_WEB_LOST_BEFORE_SEND = "executor_lost_before_send";
export const QWEN_WEB_LOST_AFTER_SEND = "executor_lost";

/** Test-only store. A future database implementation must serialize reserve per workspace. */
export class InMemoryQwenWebStore implements QwenWebStore {
  private readonly records: QwenWebRecord[] = [];

  async reserve(record: QwenWebRecord, limits: { sinceIso: string; maxRequests: number; maxConcurrency: number }): Promise<QwenWebReservation> {
    // No await between reading caps and inserting the reservation.
    const existing = this.records.find((item) => item.workspaceId === record.workspaceId && item.actorId === record.actorId && item.idempotencyKey === record.idempotencyKey);
    if (existing) {
      return { kind: existing.inputHash === record.inputHash ? "existing" : "conflict", record: structuredClone(existing) };
    }
    const workspace = this.records.filter((item) => item.workspaceId === record.workspaceId);
    if (workspace.filter((item) => item.createdAt >= limits.sinceIso).length >= limits.maxRequests) {
      return { kind: "blocked", code: "QWEN_WEB_REQUEST_CAP" };
    }
    if (workspace.filter((item) => item.state === "reserved" || item.state === "submitted").length >= limits.maxConcurrency) {
      return { kind: "blocked", code: "QWEN_WEB_CONCURRENCY_CAP" };
    }
    this.records.push(structuredClone(record));
    return { kind: "reserved", record: structuredClone(record) };
  }

  async findByKey(workspaceId: string, actorId: string, key: string): Promise<QwenWebRecord | null> {
    const record = this.records.find((item) => item.workspaceId === workspaceId && item.actorId === actorId && item.idempotencyKey === key);
    return record ? structuredClone(record) : null;
  }

  async findById(workspaceId: string, projectId: string, id: string): Promise<QwenWebRecord | null> {
    const record = this.records.find((item) => item.id === id && item.workspaceId === workspaceId && item.projectId === projectId);
    return record ? structuredClone(record) : null;
  }

  async markSubmitted(id: string, executorId: string, updatedAt: string, leaseUntil: string): Promise<boolean> {
    const record = this.require(id);
    if (record.state !== "reserved" || record.executorId !== executorId || record.leaseUntil <= updatedAt) return false;
    record.state = "submitted";
    record.updatedAt = updatedAt;
    record.leaseUntil = leaseUntil;
    return true;
  }

  async finish(id: string, executorId: string, patch: QwenWebFinish): Promise<QwenWebRecord> {
    const record = this.require(id);
    if (record.state === "submitted" && record.executorId === executorId) Object.assign(record, patch);
    return structuredClone(record);
  }

  async recoverExpired(nowIso: string): Promise<number> {
    let recovered = 0;
    for (const record of this.records) {
      if (record.leaseUntil > nowIso) continue;
      if (record.state === "reserved") {
        Object.assign(record, { state: "rejected", errorCode: QWEN_WEB_LOST_BEFORE_SEND, providerResult: null, updatedAt: nowIso });
        recovered += 1;
      } else if (record.state === "submitted") {
        Object.assign(record, { state: "unknown", errorCode: QWEN_WEB_LOST_AFTER_SEND, providerResult: "unknown",
          candidateJson: null, candidateExpiresAt: null, updatedAt: nowIso });
        recovered += 1;
      }
    }
    return recovered;
  }

  async expireCandidates(nowIso: string): Promise<number> {
    let cleared = 0;
    for (const record of this.records) {
      if (record.candidateJson && record.candidateExpiresAt && record.candidateExpiresAt <= nowIso) {
        record.candidateJson = null;
        record.updatedAt = nowIso;
        cleared += 1;
      }
    }
    return cleared;
  }

  private require(id: string): QwenWebRecord {
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new Error("qwen web record missing");
    return record;
  }
}

export interface QwenWebAccessInput {
  nodeEnv: "development" | "test" | "production";
  enabled: boolean;
  storageReady: boolean;
  /** Server-side key, official endpoint and model all resolved. Defaults to true for callers that check later. */
  providerReady?: boolean;
  configuredToken: string | null;
  presentedToken: string | null;
}

function sameToken(configured: string, presented: string | null): boolean {
  if (presented === null) return false;
  const left = Buffer.from(configured, "utf8");
  const right = Buffer.from(presented, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function qwenWebAccessDecision(input: QwenWebAccessInput): { status: number; code: string } {
  if (input.nodeEnv === "production" || !input.enabled) {
    return { status: 404, code: "QWEN_WEB_DISABLED" };
  }
  if (!input.configuredToken || !sameToken(input.configuredToken, input.presentedToken)) {
    return { status: 403, code: "QWEN_WEB_FORBIDDEN" };
  }
  if (input.providerReady === false) {
    return { status: 503, code: "QWEN_WEB_PROVIDER_UNCONFIGURED" };
  }
  if (!input.storageReady) {
    return { status: 503, code: "QWEN_WEB_STORAGE_UNAVAILABLE" };
  }
  return { status: 200, code: "QWEN_WEB_READY" };
}

export type QwenWebProviderConfig =
  | { ok: true; url: string; apiKey: string; model: string }
  | { ok: false; code: string };

/** Resolves the server-only key, official endpoint and model. The key never leaves the API process. */
export function qwenWebProviderConfig(env: {
  DASHSCOPE_API_KEY?: string;
  BAILIAN_BASE_URL?: string;
  QWEN_WEB_MODEL?: string;
}): QwenWebProviderConfig {
  const key = readQwenApiKey({ DASHSCOPE_API_KEY: env.DASHSCOPE_API_KEY });
  if (!key.ok) return { ok: false, code: key.code };
  if (!env.BAILIAN_BASE_URL) return { ok: false, code: "missing_base_url" };
  const endpoint = resolveQwenChatEndpoint(env.BAILIAN_BASE_URL);
  if (!endpoint.ok) return { ok: false, code: endpoint.code };
  const model = selectedQwenModel(env.QWEN_WEB_MODEL === undefined ? {} : { [QWEN_CHAT_MODEL_ENV]: env.QWEN_WEB_MODEL });
  if (!model.ok) return { ok: false, code: model.code };
  return { ok: true, url: endpoint.url, apiKey: key.apiKey, model: model.model };
}

export interface RunQwenWebWritingInput {
  workspaceId: string;
  projectId: string;
  actorId: string;
  idempotencyKey: string;
  input: unknown;
  requestedModel: string;
  apiKey: string;
  url: string;
  store: QwenWebStore;
  transport: QwenTransport;
  now?: Date;
  /** Clock for timestamps after the reservation (submit, lease renewal, finish). Defaults to the wall clock. */
  clock?: () => Date;
  executorId?: string;
  leaseMs?: number;
  retentionDays?: number;
  maxRequests?: number;
  maxConcurrency?: number;
  send?: typeof sendQwenChat;
}

export interface QwenWebWritingResult {
  status: number;
  code: string;
  requestCount: number;
  record: QwenWebRecord | null;
}

function hashInput(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function runQwenWebWriting(options: RunQwenWebWritingInput): Promise<QwenWebWritingResult> {
  const parsed = parseQwenWritingInput(options.input);
  if (!parsed.ok) return { status: 400, code: "invalid_input", requestCount: 0, record: null };
  const model = selectedQwenModel({ [QWEN_CHAT_MODEL_ENV]: options.requestedModel });
  if (!model.ok) return { status: 400, code: model.code, requestCount: 0, record: null };
  let body: string;
  try {
    body = buildQwenChatBody({
      model: model.model,
      system: "你是中文短剧编剧助手。只输出一个 JSON 对象，不要 Markdown，不要工具调用。候选必须经人工比较采纳后保存。",
      user: parsed.data.mode === "story" ? buildStoryPlanInstruction(parsed.data) : buildEpisodeDraftInstruction(parsed.data),
      tokenLimitField: "max_completion_tokens",
    });
  } catch {
    return { status: 400, code: "invalid_input", requestCount: 0, record: null };
  }
  // Bind the key to the exact generated request, its prompt version, and project scope.
  const inputHash = hashInput({ projectId: options.projectId, input: parsed.data, promptVersion: WRITING_PROMPT_VERSION, url: options.url, body });
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const maxRequests = options.maxRequests ?? QWEN_WEB_MAX_REQUESTS_DEFAULT;
  const maxConcurrency = options.maxConcurrency ?? QWEN_WEB_MAX_CONCURRENCY_DEFAULT;
  const retentionDays = options.retentionDays ?? QWEN_WEB_RETENTION_DAYS_DEFAULT;
  if (![maxRequests, maxConcurrency].every((value) => Number.isSafeInteger(value) && value >= 0)
      || !Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    return { status: 400, code: "invalid_limits", requestCount: 0, record: null };
  }
  const createdAt = now.toISOString();
  const executorId = options.executorId ?? `qwen-web:${randomUUID()}`;
  const leaseMs = options.leaseMs ?? QWEN_WEB_EXECUTOR_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < QWEN_CHAT_TIMEOUT_MS) {
    return { status: 400, code: "invalid_limits", requestCount: 0, record: null };
  }
  // Never freeze later timestamps at the reservation time: a pause before sending must not shorten the lease.
  const clock = options.clock ?? (() => new Date());
  const record: QwenWebRecord = {
    id: randomUUID(),
    workspaceId: options.workspaceId,
    projectId: options.projectId,
    actorId: options.actorId,
    idempotencyKey: options.idempotencyKey,
    inputHash,
    frozenInput: parsed.data,
    mode: parsed.data.mode,
    episodeNo: parsed.data.mode === "episode" ? parsed.data.episodeNo : null,
    requestedModel: options.requestedModel,
    state: "reserved",
    executorId,
    leaseUntil: new Date(now.getTime() + leaseMs).toISOString(),
    serverRequestId: null,
    errorCode: null,
    providerResult: null,
    candidateJson: null,
    candidateExpiresAt: null,
    billingStatus: "unknown",
    createdAt,
    updatedAt: createdAt,
  };
  const reservation = await options.store.reserve(record, { sinceIso: since, maxRequests, maxConcurrency });
  if (reservation.kind === "blocked") return { status: 429, code: reservation.code, requestCount: 0, record: null };
  if (reservation.kind === "conflict") return { status: 409, code: "IDEMPOTENCY_KEY_REUSED", requestCount: 0, record: reservation.record };
  if (reservation.kind === "existing") return { status: 200, code: reservation.record.state, requestCount: 0, record: reservation.record };
  const submittedAt = clock();
  const submitted = await options.store.markSubmitted(
    record.id, executorId, submittedAt.toISOString(), new Date(submittedAt.getTime() + leaseMs).toISOString(),
  );
  if (!submitted) {
    const current = await options.store.findByKey(options.workspaceId, options.actorId, options.idempotencyKey);
    return { status: 200, code: current?.state ?? "unknown", requestCount: 0, record: current };
  }

  const send = options.send ?? sendQwenChat;
  const exchange = await send({
    url: options.url,
    apiKey: options.apiKey,
    body,
    transport: options.transport,
  });
  const finishedAt = clock().toISOString();
  let state: QwenWebState = exchange.providerResult === "unknown" ? "unknown" : "rejected";
  let candidateJson: string | null = null;
  let errorCode = exchange.errorCode;
  if (exchange.content && exchange.errorCode === null && exchange.providerResult === "completed") {
    const checked = acceptPreparedCandidate(exchange.content, parsed.data, options.apiKey);
    if ("text" in checked) {
      state = "completed";
      candidateJson = checked.text;
      errorCode = null;
    } else {
      state = "rejected";
      errorCode = checked.errorCode;
    }
  }
  const candidateExpiresAt = candidateJson
    ? new Date(Date.parse(finishedAt) + retentionDays * 24 * 60 * 60 * 1000).toISOString()
    : null;
  const finished = await options.store.finish(record.id, executorId, {
    state,
    serverRequestId: exchange.serverRequestId,
    errorCode,
    providerResult: state === "completed" ? "completed" : exchange.providerResult,
    candidateJson,
    candidateExpiresAt,
    updatedAt: finishedAt,
  });
  const status = finished.state === "completed" ? 200 : finished.state === "unknown" ? 502 : 422;
  return { status, code: finished.state, requestCount: exchange.requestCount, record: finished };
}

export function qwenWebFailureText(code: string): string {
  return qwenFailureMessage(code);
}

export function qwenWebPromptVersion(): string {
  return WRITING_PROMPT_VERSION;
}

export function assertQwenWebTokenCap(body: string): void {
  const parsed = JSON.parse(body) as { max_completion_tokens?: number; max_tokens?: number };
  if (parsed.max_completion_tokens !== QWEN_CHAT_MAX_TOKENS || parsed.max_tokens !== undefined) {
    throw new Error("qwen web token cap drifted");
  }
}

export function redactQwenWebError(text: string, secret: string): string {
  return redactSecret(text, secret);
}
