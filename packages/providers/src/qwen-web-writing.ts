import { createHash, randomUUID } from "node:crypto";
import { WRITING_PROMPT_VERSION, parseQwenWritingInput, type QwenWritingInput } from "@ai-drama/contracts";
import { buildEpisodeDraftInstruction, buildStoryPlanInstruction } from "@ai-drama/domain";
import { QWEN_CHAT_MAX_TOKENS, QWEN_CHAT_MODEL_ENV, buildQwenChatBody, qwenFailureMessage, redactSecret, selectedQwenModel, sendQwenChat, type QwenTransport } from "./qwen-chat";
import { acceptPreparedCandidate } from "./qwen-writing";

/** Qwen web calls are not replay-safe and must not enter the M2 text job path. */
export const QWEN_WEB_REPLAY_POLICY = "NOT_REPLAY_SAFE" as const;
export const QWEN_WEB_RETENTION_DAYS_DEFAULT = 7;
export const QWEN_WEB_MAX_REQUESTS_DEFAULT = 8;
export const QWEN_WEB_MAX_CONCURRENCY_DEFAULT = 1;

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
  markSubmitted(id: string, updatedAt: string): Promise<boolean>;
  /** Only the still-submitted sender may finish. Recovery cannot be overwritten. */
  finish(id: string, patch: QwenWebFinish): Promise<QwenWebRecord>;
  /** Recovery caller must first establish that the owner stopped; replay is not recovery. */
  markOrphanUnknown(id: string, expected: Pick<QwenWebRecord, "state" | "updatedAt">, nowIso: string): Promise<boolean>;
  expireCandidates(nowIso: string): Promise<number>;
}

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

  async markSubmitted(id: string, updatedAt: string): Promise<boolean> {
    const record = this.require(id);
    if (record.state !== "reserved") return false;
    record.state = "submitted";
    record.updatedAt = updatedAt;
    return true;
  }

  async finish(id: string, patch: QwenWebFinish): Promise<QwenWebRecord> {
    const record = this.require(id);
    if (record.state === "submitted") Object.assign(record, patch);
    return structuredClone(record);
  }

  async markOrphanUnknown(id: string, expected: Pick<QwenWebRecord, "state" | "updatedAt">, nowIso: string): Promise<boolean> {
    const record = this.require(id);
    if (record.state !== expected.state || record.updatedAt !== expected.updatedAt || (record.state !== "reserved" && record.state !== "submitted")) return false;
    Object.assign(record, { state: "unknown", errorCode: "unknown", providerResult: "unknown", candidateJson: null, candidateExpiresAt: null, updatedAt: nowIso });
    return true;
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
  configuredToken: string | null;
  presentedToken: string | null;
}

export function qwenWebAccessDecision(input: QwenWebAccessInput): { status: number; code: string } {
  if (input.nodeEnv === "production" || !input.enabled) {
    return { status: 404, code: "QWEN_WEB_DISABLED" };
  }
  if (!input.configuredToken || input.presentedToken !== input.configuredToken) {
    return { status: 403, code: "QWEN_WEB_FORBIDDEN" };
  }
  if (!input.storageReady) {
    return { status: 503, code: "QWEN_WEB_STORAGE_UNAVAILABLE" };
  }
  return { status: 200, code: "QWEN_WEB_READY" };
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
  if (!await options.store.markSubmitted(record.id, createdAt)) {
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
  const finishedAt = (options.now ?? new Date()).toISOString();
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
    ? new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000).toISOString()
    : null;
  const finished = await options.store.finish(record.id, {
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
