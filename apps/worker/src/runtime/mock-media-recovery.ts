import type { JobPersistenceService, MediaAssetStore, RuntimeStore } from "@ai-drama/database";
import type { MediaProviderAdapter } from "@ai-drama/providers";
import { recoverMockImageAttempt, type MockImageObjectStore } from "./mock-image-generation";

export class MockMediaRecovery {
  constructor(
    private readonly jobs: JobPersistenceService,
    private readonly assets: MediaAssetStore,
    private readonly store: RuntimeStore,
    private readonly adapter: MediaProviderAdapter,
    private readonly objects: MockImageObjectStore,
  ) {}

  async reconcileOnce(): Promise<void> {
    const errors: unknown[] = [];
    for (const row of await this.store.listExpiredMockImages(50)) {
      try {
      const execution = await this.store.loadMockImageExecution(row.workspaceId, row.jobId);
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
      const outcome = await recoverMockImageAttempt({
        workspaceId: row.workspaceId, projectId: execution.projectId,
        shotRevisionId: execution.shotRevisionId, jobId: row.jobId,
        providerConfigurationId: row.providerConfigurationId,
        traceId: `mock-media:recover:${row.jobId}`,
        attemptId: row.attemptId, providerRequestId: row.providerRequestId,
      }, { jobs: this.jobs, assets: this.assets, adapter: this.adapter, objects: this.objects });
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
        if (error instanceof Error && /requires exactly one image output|must be inline PNG|not a PNG|dimensions are invalid/.test(error.message)) {
          try {
            await this.jobs.failJob({ workspaceId: row.workspaceId, jobId: row.jobId,
              attemptId: row.attemptId, traceId: `mock-media:invalid-output:${row.jobId}`,
              errorCode: "MOCK_IMAGE_OUTPUT_INVALID", errorMessage: error.message, retryable: false });
          } catch (failure) { errors.push(failure); }
        } else {
          errors.push(error);
        }
      }
    }
    if (errors.length) throw new AggregateError(errors, "Mock media recovery encountered errors");
  }
}
