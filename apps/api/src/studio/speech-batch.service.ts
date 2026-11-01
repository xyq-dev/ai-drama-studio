import { randomUUID } from "node:crypto";
import { SPEECH_BATCH_MAX_SNAPSHOT_BYTES, SPEECH_BATCH_SCHEMA, speechBatchConfirmSchema, speechBatchPreflightSchema,
  type SpeechBatchFrozen, type SpeechBatchView, type SpeechGenerationPort } from "@ai-drama/contracts";
import { DomainError, speechBatchBudgets, speechExactHash } from "@ai-drama/domain";
import { PersistenceError, type SpeechBatchPersistence, type SpeechPersistence } from "@ai-drama/database";
import type { StudioContext } from "./studio.service";

type Context = StudioContext & { idempotencyKey: string };
export interface SpeechBatchDependencies { workspaceId: string; store: SpeechBatchPersistence; speech: SpeechPersistence; generation: SpeechGenerationPort | null }
/** A durable bounded command receipt. Each operation still uses the existing paid Job chain. */
export class SpeechBatchService {
  constructor(private readonly deps: SpeechBatchDependencies) {}
  private context(ctx: StudioContext): Context {
    if (!ctx.idempotencyKey || !/^[\x21-\x7e]{1,200}$/.test(ctx.idempotencyKey)) throw new PersistenceError("VALIDATION_ERROR", "A permanent request key is required");
    return { ...ctx, idempotencyKey: ctx.idempotencyKey };
  }
  private async ready(): Promise<void> {
    if (!await this.deps.store.storageReady()) throw new PersistenceError("SPEECH_BATCH_STORAGE_UNAVAILABLE", "Batch storage is not provisioned");
  }
  async inventory(projectId: string, episodeId: string) { await this.ready(); return this.deps.store.inventory(this.deps.workspaceId, projectId, episodeId); }
  async list(projectId: string, episodeId: string) { await this.ready(); return this.deps.store.list(this.deps.workspaceId, projectId, episodeId); }
  async read(batchId: string) { await this.ready(); return this.deps.store.read(this.deps.workspaceId, batchId); }
  async preflight(projectId: string, episodeId: string, raw: unknown, context: StudioContext): Promise<SpeechBatchView> {
    await this.ready();
    const parsed = speechBatchPreflightSchema.safeParse(raw), ctx = this.context(context);
    if (!parsed.success) throw new PersistenceError("VALIDATION_ERROR", "Choose between 1 and 100 distinct lines");
    const request = parsed.data;
    const prior = await this.deps.store.findPreflight(this.deps.workspaceId, projectId, episodeId, ctx.idempotencyKey, speechExactHash(request));
    if (prior) return prior;
    const inventory = await this.inventory(projectId, episodeId);
    if (inventory.sourceHash !== request.sourceHash) throw new PersistenceError("SPEECH_SOURCE_CHANGED", "Episode source changed");
    if (!this.deps.generation?.authorize || !(await this.deps.generation.capabilities(this.deps.workspaceId, projectId)).available) throw new PersistenceError("SPEECH_DISABLED", "New paid speech operations are disabled");
    const operations = [];
    for (const inputId of request.lineInputRevisionIds) {
      const line = inventory.lines.find((v) => v.lineInputRevisionId === inputId);
      if (!line || !["missing", "uncertain"].includes(line.status)) throw new PersistenceError("SPEECH_BATCH_LINE_AVAILABLE", "This line already has audio or an active job; listen to or inspect it first");
      const input = await this.deps.speech.generationInput(this.deps.workspaceId, line.planRevisionId, line.lineId);
      const quote = await this.deps.generation.quote(input);
      operations.push({ id: randomUUID(), input, quote, idempotencyKey: `speech-batch:${randomUUID()}` });
    }
    const frozen: SpeechBatchFrozen = { schema: SPEECH_BATCH_SCHEMA, projectId, episodeId, sourceHash: request.sourceHash, operations,
      budgets: speechBatchBudgets(operations), expiresAt: new Date(Math.min(...operations.map((v) => Date.parse(v.quote.expiresAt)))).toISOString() };
    if (Buffer.byteLength(JSON.stringify(frozen), "utf8") > SPEECH_BATCH_MAX_SNAPSHOT_BYTES) throw new PersistenceError("SPEECH_BATCH_LIMIT", "Frozen batch exceeds 2 MB; select fewer lines");
    return this.deps.store.create(this.deps.workspaceId, projectId, episodeId, request, frozen, ctx);
  }
  async confirm(batchId: string, raw: unknown, context: StudioContext): Promise<SpeechBatchView> {
    await this.ready();
    const parsed = speechBatchConfirmSchema.safeParse(raw), ctx = this.context(context);
    if (!parsed.success) throw new PersistenceError("VALIDATION_ERROR", "Confirm the exact frozen total, operation count and possible charges");
    const before = await this.read(batchId);
    const view = await this.deps.store.confirm(this.deps.workspaceId, batchId, parsed.data, ctx);
    // A repeated receipt lookup never silently restarts an interrupted sequence.
    return before.state === "quoted" && view.state === "dispatching" ? this.dispatch(batchId, false, ctx) : view;
  }
  async resume(batchId: string, raw: unknown, context: StudioContext): Promise<SpeechBatchView> {
    await this.ready(); this.empty(raw); const ctx = this.context(context);
    const before = await this.read(batchId);
    if (!before.confirmation) throw new PersistenceError("SPEECH_BATCH_CONFIRMATION_CHANGED", "Confirm this frozen batch first");
    if (before.cancelRequested) return before;
    return this.dispatch(batchId, true, ctx);
  }
  async cancel(batchId: string, raw: unknown, context: StudioContext): Promise<SpeechBatchView> {
    await this.ready(); this.empty(raw); return this.deps.store.cancel(this.deps.workspaceId, batchId, this.context(context));
  }
  private empty(raw: unknown): void {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length) throw new PersistenceError("VALIDATION_ERROR", "Expected an empty request");
  }
  private async dispatch(batchId: string, resume: boolean, ctx: Context): Promise<SpeechBatchView> {
    const generation = this.deps.generation;
    if (!generation?.authorize) throw new PersistenceError("SPEECH_DISABLED", "New paid speech operations are disabled");
    // At most 100 frozen operations; no refresh, provider retry or new operation is introduced here.
    for (let i = 0; i < 100; i++) {
      const claim = await this.deps.store.claim(this.deps.workspaceId, batchId, resume);
      if (!claim) break;
      try {
        const { input, quote, idempotencyKey } = claim.operation;
        let authorizationId = claim.authorizationId;
        if (!authorizationId) {
          const result = await generation.authorize({ workspaceId: this.deps.workspaceId, projectId: input.projectId, actorId: ctx.actorId,
            quoteId: quote.quoteId, maximumAmount: quote.maximumAmount, confirmedUncertainJobIds: quote.uncertainJobIds ?? [], idempotencyKey: `${idempotencyKey}:authorize` });
          authorizationId = result.budgetAuthorizationId;
          await this.deps.store.recordAuthorization(this.deps.workspaceId, claim.ref, authorizationId);
        }
        await generation.generate({ ...input, quoteId: quote.quoteId, budgetAuthorizationId: authorizationId, idempotencyKey,
          actorId: ctx.actorId, traceId: ctx.traceId, batchOperation: claim.ref });
      } catch (error) {
        const known = error instanceof PersistenceError || error instanceof DomainError;
        const unknown = !known || ["IDEMPOTENCY_IN_PROGRESS", "SPEECH_BATCH_REQUEST_UNKNOWN"].includes(error.code);
        await this.deps.store.failOperation(this.deps.workspaceId, claim.ref, known ? error.code : "SPEECH_BATCH_REQUEST_UNKNOWN", unknown);
        // Any ambiguous response or rejected operation stops subsequent submissions until explicit user review.
        break;
      }
    }
    return this.deps.store.finish(this.deps.workspaceId, batchId);
  }
}
