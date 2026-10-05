import { createHash, randomUUID } from "node:crypto";
import { WRITING_PROMPT_VERSION, parseQwenWritingInput, type QwenWritingInput } from "@ai-drama/contracts";
import { QWEN_CHAT_MAX_TOKENS, qwenFailureMessage, redactSecret, sendQwenChat, type QwenTransport } from "./qwen-chat";
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

export interface QwenWebStore {
  countOpen(workspaceId: string): Promise<number>;
  countSince(workspaceId: string, sinceIso: string): Promise<number>;
  findByKey(workspaceId: string, actorId: string, key: string): Promise<QwenWebRecord | null>;
  insertReserved(record: QwenWebRecord): Promise<void>;
  markSubmitted(id: string, updatedAt: string): Promise<void>;
  finish(id: string, patch: Pick<QwenWebRecord, "state" | "serverRequestId" | "errorCode" | "providerResult" | "candidateJson" | "candidateExpiresAt" | "updatedAt">): Promise<void>;
  expireCandidates(nowIso: string): Promise<number>;
}

export class InMemoryQwenWebStore implements QwenWebStore {
  readonly records: QwenWebRecord[] = [];

  async countOpen(workspaceId: string): Promise<number> {
    return this.records.filter((record) => record.workspaceId === workspaceId && (record.state === "reserved" || record.state === "submitted")).length;
  }

  async countSince(workspaceId: string, sinceIso: string): Promise<number> {
    return this.records.filter((record) => record.workspaceId === workspaceId && record.createdAt >= sinceIso).length;
  }

  async findByKey(workspaceId: string, actorId: string, key: string): Promise<QwenWebRecord | null> {
    return this.records.find((record) => record.workspaceId === workspaceId && record.actorId === actorId && record.idempotencyKey === key) ?? null;
  }

  async insertReserved(record: QwenWebRecord): Promise<void> {
    this.records.push(record);
  }

  async markSubmitted(id: string, updatedAt: string): Promise<void> {
    const record = this.require(id);
    record.state = "submitted";
    record.updatedAt = updatedAt;
  }

  async finish(id: string, patch: Pick<QwenWebRecord, "state" | "serverRequestId" | "errorCode" | "providerResult" | "candidateJson" | "candidateExpiresAt" | "updatedAt">): Promise<void> {
    Object.assign(this.require(id), patch);
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
  body: string;
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

function ambiguous(record: QwenWebRecord): boolean {
  return record.state === "reserved" || record.state === "submitted";
}

export async function runQwenWebWriting(options: RunQwenWebWritingInput): Promise<QwenWebWritingResult> {
  const parsed = parseQwenWritingInput(options.input);
  if (!parsed.ok) return { status: 400, code: "invalid_input", requestCount: 0, record: null };
  const inputHash = hashInput(parsed.data);
  const existing = await options.store.findByKey(options.workspaceId, options.actorId, options.idempotencyKey);
  if (existing && existing.inputHash !== inputHash) {
    return { status: 409, code: "IDEMPOTENCY_KEY_REUSED", requestCount: 0, record: existing };
  }
  if (existing) {
    if (ambiguous(existing)) {
      const now = (options.now ?? new Date()).toISOString();
      await options.store.finish(existing.id, {
        state: "unknown",
        serverRequestId: existing.serverRequestId,
        errorCode: existing.errorCode ?? "unknown",
        providerResult: "unknown",
        candidateJson: null,
        candidateExpiresAt: null,
        updatedAt: now,
      });
      existing.state = "unknown";
      existing.providerResult = "unknown";
      existing.candidateJson = null;
    }
    return { status: 200, code: existing.state, requestCount: 0, record: existing };
  }

  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const maxRequests = options.maxRequests ?? QWEN_WEB_MAX_REQUESTS_DEFAULT;
  const maxConcurrency = options.maxConcurrency ?? QWEN_WEB_MAX_CONCURRENCY_DEFAULT;
  if (await options.store.countSince(options.workspaceId, since) >= maxRequests) {
    return { status: 429, code: "QWEN_WEB_REQUEST_CAP", requestCount: 0, record: null };
  }
  if (await options.store.countOpen(options.workspaceId) >= maxConcurrency) {
    return { status: 429, code: "QWEN_WEB_CONCURRENCY_CAP", requestCount: 0, record: null };
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
  await options.store.insertReserved(record);
  await options.store.markSubmitted(record.id, createdAt);
  record.state = "submitted";

  const send = options.send ?? sendQwenChat;
  const exchange = await send({
    url: options.url,
    apiKey: options.apiKey,
    body: options.body,
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
  const retentionDays = options.retentionDays ?? QWEN_WEB_RETENTION_DAYS_DEFAULT;
  const candidateExpiresAt = candidateJson
    ? new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000).toISOString()
    : null;
  await options.store.finish(record.id, {
    state,
    serverRequestId: exchange.serverRequestId,
    errorCode,
    providerResult: state === "completed" ? "completed" : exchange.providerResult,
    candidateJson,
    candidateExpiresAt,
    updatedAt: finishedAt,
  });
  record.state = state;
  record.serverRequestId = exchange.serverRequestId;
  record.errorCode = errorCode;
  record.providerResult = state === "completed" ? "completed" : exchange.providerResult;
  record.candidateJson = candidateJson;
  record.candidateExpiresAt = candidateExpiresAt;
  record.updatedAt = finishedAt;
  const status = state === "completed" ? 200 : state === "unknown" ? 502 : 422;
  return { status, code: state, requestCount: exchange.requestCount, record };
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
