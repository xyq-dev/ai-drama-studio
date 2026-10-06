import { z } from "zod";
import type { QwenWritingInput } from "@ai-drama/contracts";
import { PersistenceError, type PostgresQwenWebStore, type QwenWebStoredRecord, type RuntimeStore } from "@ai-drama/database";
import {
  QWEN_WEB_MAX_CONCURRENCY_DEFAULT,
  QWEN_WEB_MAX_REQUESTS_DEFAULT,
  QWEN_WEB_REPLAY_POLICY,
  QWEN_WEB_RETENTION_DAYS_DEFAULT,
  qwenWebAccessDecision,
  runQwenWebWriting,
  type QwenTransport,
  type QwenWebProviderConfig,
} from "@ai-drama/providers";
import type { StudioContext } from "./studio.service";

export interface QwenWebDependencies {
  workspaceId: string;
  nodeEnv: "development" | "test" | "production";
  enabled: boolean;
  operatorToken: string | null;
  provider: QwenWebProviderConfig;
  store: PostgresQwenWebStore<QwenWritingInput>;
  projects: Pick<RuntimeStore, "getProject">;
  transport: QwenTransport;
  clock?: () => Date;
}

const requestBodySchema = z.object({ input: z.unknown() }).strict();

/** Public view of one request. No executor, key, frozen input or provider credential leaves the server. */
export interface QwenWebRequestView {
  requestId: string;
  projectId: string;
  mode: "story" | "episode";
  episodeNo: 1 | 2 | 3 | null;
  state: QwenWebStoredRecord["state"];
  errorCode: string | null;
  providerResult: "completed" | "unknown" | null;
  candidateJson: string | null;
  candidateExpiresAt: string | null;
  candidateExpired: boolean;
  serverRequestId: string | null;
  requestedModel: string;
  billingStatus: "unknown";
  replayPolicy: typeof QWEN_WEB_REPLAY_POLICY;
  createdAt: string;
  updatedAt: string;
}

function view(record: QwenWebStoredRecord, now: Date): QwenWebRequestView {
  const expired = record.candidateExpiresAt !== null && Date.parse(record.candidateExpiresAt) <= now.getTime();
  return {
    requestId: record.id,
    projectId: record.projectId,
    mode: record.mode,
    episodeNo: record.episodeNo,
    state: record.state,
    errorCode: record.errorCode,
    providerResult: record.providerResult,
    candidateJson: expired ? null : record.candidateJson,
    candidateExpiresAt: record.candidateExpiresAt,
    candidateExpired: record.state === "completed" && (expired || record.candidateJson === null),
    serverRequestId: record.serverRequestId,
    requestedModel: record.requestedModel,
    billingStatus: "unknown",
    replayPolicy: QWEN_WEB_REPLAY_POLICY,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Web writing-assistant calls to Qwen. Default off, forced off in production, gated by the operator token, a
 * resolved server-side provider config and the persistent store. It never enters the replay-safe text job path.
 */
export class QwenWebService {
  constructor(private readonly deps: QwenWebDependencies) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  private async decide(presentedToken: string | undefined) {
    const storageReady = this.deps.enabled && this.deps.nodeEnv !== "production"
      ? await this.deps.store.storageReady()
      : false;
    return qwenWebAccessDecision({
      nodeEnv: this.deps.nodeEnv,
      enabled: this.deps.enabled,
      storageReady,
      providerReady: this.deps.provider.ok,
      configuredToken: this.deps.operatorToken,
      presentedToken: presentedToken ?? null,
    });
  }

  async status(presentedToken: string | undefined) {
    const decision = await this.decide(presentedToken);
    const ready = decision.status === 200;
    return {
      status: decision.status,
      body: {
        code: decision.code,
        ready,
        model: ready && this.deps.provider.ok ? this.deps.provider.model : null,
        maxRequestsPerDay: QWEN_WEB_MAX_REQUESTS_DEFAULT,
        maxConcurrency: QWEN_WEB_MAX_CONCURRENCY_DEFAULT,
        retentionDays: QWEN_WEB_RETENTION_DAYS_DEFAULT,
        billingStatus: "unknown" as const,
        replayPolicy: QWEN_WEB_REPLAY_POLICY,
      },
    };
  }

  /** Expired executor leases are fenced first, then expired candidate bodies are cleared. */
  async maintain(): Promise<{ recovered: number; expired: number }> {
    const nowIso = this.now().toISOString();
    const recovered = await this.deps.store.recoverExpired(nowIso);
    const expired = await this.deps.store.expireCandidates(nowIso);
    return { recovered, expired };
  }

  async request(projectId: string, body: unknown, presentedToken: string | undefined, context: StudioContext) {
    const decision = await this.decide(presentedToken);
    if (decision.status !== 200 || !this.deps.provider.ok) {
      return { status: decision.status, body: { code: decision.code } };
    }
    if (!context.idempotencyKey || context.idempotencyKey.length > 200) {
      throw new PersistenceError("VALIDATION_ERROR", "Idempotency-Key is required");
    }
    await this.deps.projects.getProject(this.deps.workspaceId, projectId);
    const parsed = requestBodySchema.safeParse(body);
    if (!parsed.success) throw new PersistenceError("VALIDATION_ERROR", "Request body must be { input }");
    await this.maintain();
    const provider = this.deps.provider;
    const result = await runQwenWebWriting({
      workspaceId: this.deps.workspaceId,
      projectId,
      actorId: context.actorId,
      idempotencyKey: context.idempotencyKey,
      input: parsed.data.input,
      requestedModel: provider.model,
      apiKey: provider.apiKey,
      url: provider.url,
      store: this.deps.store,
      transport: this.deps.transport,
      now: this.now(),
      ...(this.deps.clock ? { clock: this.deps.clock } : {}),
    });
    if (!result.record) {
      return { status: result.status, body: { code: result.code } };
    }
    return {
      status: result.status,
      body: { code: result.code, requestCount: result.requestCount, request: view(result.record, this.now()) },
    };
  }

  async get(projectId: string, requestId: string, presentedToken: string | undefined) {
    const decision = await this.decide(presentedToken);
    if (decision.status !== 200) return { status: decision.status, body: { code: decision.code } };
    await this.maintain();
    const record = await this.deps.store.findById(this.deps.workspaceId, projectId, requestId);
    if (!record) throw new PersistenceError("NOT_FOUND", "Qwen writing request not found");
    return { status: 200, body: { code: record.state, requestCount: 0, request: view(record, this.now()) } };
  }
}
