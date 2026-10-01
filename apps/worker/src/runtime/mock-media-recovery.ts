import type { JobPersistenceService, MediaAssetStore, RuntimeStore } from "@ai-drama/database";
import { isMockMediaJobKind } from "@ai-drama/database";
import type { MediaProviderAdapter } from "@ai-drama/providers";
import { recoverMockAvAttempt } from "./mock-av-generation";
import { recoverMockImageAttempt, type MockImageObjectStore } from "./mock-image-generation";
import { classifyMediaFailure, mediaErrorMessage } from "./mock-media-failure";

export interface MockMediaRecoveryFlags {
  mockImageEnabled: boolean;
  mockAvEnabled: boolean;
}

export class MockMediaRecovery {
  constructor(
    private readonly jobs: JobPersistenceService,
    private readonly assets: MediaAssetStore,
    private readonly store: RuntimeStore,
    private readonly adapter: MediaProviderAdapter,
    private readonly objects: MockImageObjectStore | null,
    private readonly flags: MockMediaRecoveryFlags,
  ) {}

  async reconcileOnce(): Promise<void> {
    const errors: unknown[] = [];
    for (const row of await this.store.listExpiredMockMedia(50)) {
      let kind = "";
      try {
      const execution = await this.store.loadMockMediaExecution(row.workspaceId, row.jobId);
      if (!execution || execution.state !== "RUNNING") continue;
      if (execution.cancelRequested) {
        await this.jobs.confirmCancellation({ workspaceId: row.workspaceId, jobId: row.jobId,
          attemptId: row.attemptId, traceId: `mock-media:cancel:${row.jobId}` });
        continue;
      }
      if (!row.providerRequestId) {
        await this.jobs.recoverExpiredLease({ workspaceId: row.workspaceId, jobId: row.jobId,
          traceId: `mock-media:unsubmitted:${row.jobId}` });
        continue;
      }
      if (!execution.shotRevisionId || !row.providerConfigurationId ||
          row.providerConfigurationId !== execution.providerConfigurationId) {
        await this.jobs.failJob({ workspaceId: row.workspaceId, jobId: row.jobId,
          attemptId: row.attemptId, traceId: `mock-media:invalid-config:${row.jobId}`,
          errorCode: "MOCK_MEDIA_NOT_CONFIGURED",
          errorMessage: "Mock media source or provider configuration is invalid", retryable: false });
        continue;
      }
      if (!isMockMediaJobKind(execution.kind)) {
        await this.jobs.failJob({ workspaceId: row.workspaceId, jobId: row.jobId,
          attemptId: row.attemptId, traceId: `mock-media:invalid-kind:${row.jobId}`,
          errorCode: "MOCK_MEDIA_ROUTE_INVALID",
          errorMessage: "Mock media kind is not on the fixed route list", retryable: false });
        continue;
      }
      kind = execution.kind;
      const objects = this.objects;
      if (!objects || !this.kindEnabled(execution.kind)) {
        await this.jobs.failJob({ workspaceId: row.workspaceId, jobId: row.jobId,
          attemptId: row.attemptId, traceId: `mock-media:missing-config:${row.jobId}`,
          errorCode: "MOCK_MEDIA_NOT_CONFIGURED",
          errorMessage: "Mock media requires local storage, shot and provider configuration",
          retryable: false });
        continue;
      }
      const shared = {
        workspaceId: row.workspaceId, projectId: execution.projectId,
        shotRevisionId: execution.shotRevisionId, jobId: row.jobId,
        providerConfigurationId: row.providerConfigurationId,
        traceId: `mock-media:recover:${row.jobId}`,
        attemptId: row.attemptId, providerRequestId: row.providerRequestId,
      };
      const outcome = execution.kind === "MEDIA_IMAGE"
        ? await recoverMockImageAttempt(shared, { jobs: this.jobs, assets: this.assets, adapter: this.adapter, objects })
        : await recoverMockAvAttempt({
          ...shared,
          capability: execution.kind === "MEDIA_VIDEO" ? "video.generate" : "audio.tts",
          inputSnapshot: execution.inputSnapshot,
        }, { jobs: this.jobs, assets: this.assets, adapter: this.adapter, objects });
      if (outcome === "ACTIVE") continue;
      if (outcome === "CANCELED") {
        await this.jobs.confirmCancellation({ workspaceId: row.workspaceId, jobId: row.jobId,
          attemptId: row.attemptId, traceId: `mock-media:provider-canceled:${row.jobId}` });
      } else if (outcome === "FAILED" || outcome === "UNKNOWN") {
        await this.jobs.failJob({ workspaceId: row.workspaceId, jobId: row.jobId,
          attemptId: row.attemptId, traceId: `mock-media:provider-failed:${row.jobId}`,
          errorCode: outcome === "UNKNOWN" ? "MOCK_REQUEST_UNKNOWN" : "MOCK_PROVIDER_FAILED",
          errorMessage: `Mock provider inspection returned ${outcome}`, retryable: false });
      }
      } catch (error) {
        const disposition = classifyMediaFailure(error);
        if (disposition === "terminal-race") continue;
        if (disposition === "permanent") {
          try {
            await this.jobs.failJob({ workspaceId: row.workspaceId, jobId: row.jobId,
              attemptId: row.attemptId, traceId: `mock-media:invalid-output:${row.jobId}`,
              errorCode: kind === "MEDIA_IMAGE" ? "MOCK_IMAGE_OUTPUT_INVALID" : "MOCK_AV_OUTPUT_INVALID",
              errorMessage: mediaErrorMessage(error), retryable: false });
          } catch (failure) {
            if (classifyMediaFailure(failure) !== "terminal-race") errors.push(failure);
          }
          continue;
        }
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Mock media recovery encountered errors");
  }

  private kindEnabled(kind: string): boolean {
    if (!this.objects) return false;
    if (kind === "MEDIA_IMAGE") return this.flags.mockImageEnabled;
    if (kind === "MEDIA_VIDEO" || kind === "MEDIA_TTS") return this.flags.mockAvEnabled;
    return false;
  }
}
