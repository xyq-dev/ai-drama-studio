import { DomainError, parseVoiceComposeRenderRequest, speechExactHash,
  type VoiceComposeJobSnapshot, type VoiceComposeRenderRequest } from "@ai-drama/domain";
import { PersistenceError, type PostgresPool, type JobPersistenceService, type SpeechPersistence } from "@ai-drama/database";
import type { StudioContext } from "./studio.service";

export interface VoiceComposeSubmissionStore {
  freezeInTransaction(client: Awaited<ReturnType<PostgresPool["connect"]>>, workspaceId: string, shotRevisionId: string, request: VoiceComposeRenderRequest): Promise<{
    projectId: string; snapshot: VoiceComposeJobSnapshot; inputHash: string;
  }>;
}
export interface VoiceComposeServiceDependencies {
  workspaceId: string;
  enabled: boolean;
  jobs: Pick<JobPersistenceService, "createAndQueueWorkflowJob">;
  store: VoiceComposeSubmissionStore;
  speech: Pick<SpeechPersistence, "storageReady">;
}

/** Local encode submission only: every selected paid take already belongs to its existing succeeded job. */
export class VoiceComposeService {
  constructor(private readonly deps: VoiceComposeServiceDependencies) {}
  async render(shotRevisionId: string, body: unknown, context: StudioContext): Promise<{ status: number; body: unknown }> {
    if (!this.deps.enabled) throw new PersistenceError("CONFIGURATION_ERROR", "Voice composition is not enabled");
    if (!await this.deps.speech.storageReady()) throw new PersistenceError("SPEECH_STORAGE_UNAVAILABLE", "Speech storage is unavailable");
    let request: VoiceComposeRenderRequest;
    try {
      if (Buffer.byteLength(JSON.stringify(body) ?? "", "utf8") > 64 * 1024) throw new PersistenceError("VALIDATION_ERROR", "Voice compose request is too large");
      request = parseVoiceComposeRenderRequest(body);
    } catch (error) {
      if (error instanceof DomainError) throw new PersistenceError(error.code, error.message);
      throw error;
    }
    if (!context.idempotencyKey || !/^[\x21-\x7e]{1,200}$/.test(context.idempotencyKey)) throw new PersistenceError("VALIDATION_ERROR", "Idempotency-Key is required");
    return this.deps.jobs.createAndQueueWorkflowJob({
      workspaceId: this.deps.workspaceId, actorId: context.actorId, httpMethod: "POST",
      routeKey: `/shot-revisions/${shotRevisionId}/voice-compose`, key: context.idempotencyKey,
      requestHash: speechExactHash(request),expiresAt:new Date("9999-12-31T00:00:00Z"),
    }, async (client) => {
      const frozen = await this.deps.store.freezeInTransaction(client, this.deps.workspaceId, shotRevisionId, request);
      return { workspaceId: this.deps.workspaceId, projectId: frozen.projectId, sourceShotRevisionId: shotRevisionId,
        type: "MEDIA_COMPOSE", requestedBy: context.actorId, kind: "MEDIA_COMPOSE", inputHash: frozen.inputHash,
        inputSnapshot: frozen.snapshot, traceId: context.traceId };
    });
  }
}
