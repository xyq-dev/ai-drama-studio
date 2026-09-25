import type { ExpiredLeaseRow, JobPersistenceService, RuntimeStore } from "@ai-drama/database";
import type { MockProvider } from "@ai-drama/providers";
import type { OutboxDispatcher } from "./dispatcher";

export class RuntimeReconciler {
  constructor(
    private readonly jobs: JobPersistenceService,
    private readonly store: RuntimeStore,
    private readonly provider: MockProvider,
    private readonly dispatcher: OutboxDispatcher,
    private readonly orphanGraceMs: number,
  ) {}

  async reconcileOnce(): Promise<void> {
    await this.dispatcher.dispatchOnce();
    await this.redispatchQueuedOrphans();
    await this.dispatcher.dispatchOnce();
    await this.recoverExpiredLeases();
    await this.completeWaitingExternal();
  }

  private async redispatchQueuedOrphans(): Promise<void> {
    const rows = await this.store.listOrphanQueued(this.orphanGraceMs, 50);
    for (const row of rows) {
      if (await this.dispatcher.hasDispatch(row.jobId, row.dispatchSeq)) {
        continue;
      }
      await this.jobs.redispatchQueuedJob({
        workspaceId: row.workspaceId,
        jobId: row.jobId,
        dispatchSeq: row.dispatchSeq,
        traceId: `reconcile-orphan:${row.jobId}`,
      });
    }
  }

  private async recoverExpiredLeases(): Promise<void> {
    const rows = await this.store.listExpiredRunning(50);
    for (const row of rows) {
      if (row.cancelRequested) {
        await this.jobs.confirmCancellation({
          workspaceId: row.workspaceId,
          jobId: row.jobId,
          attemptId: row.attemptId,
          traceId: `reconcile-cancel:${row.jobId}`,
        });
        continue;
      }
      if (row.providerRequestId) {
        const inspected = await this.inspectAndRecord(row);
        if (inspected === "SUCCEEDED") {
          await this.jobs.succeedJob({
            workspaceId: row.workspaceId,
            jobId: row.jobId,
            attemptId: row.attemptId,
            traceId: `reconcile:${row.jobId}`,
            responseSnapshot: { recovered: true },
          });
          continue;
        }
        if (inspected === "CANCELED") {
          await this.jobs.confirmCancellation({
            workspaceId: row.workspaceId,
            jobId: row.jobId,
            attemptId: row.attemptId,
            traceId: `reconcile:${row.jobId}`,
          });
          continue;
        }
        if (inspected === "ACTIVE" || inspected === "UNKNOWN") {
          continue;
        }
      }
      await this.jobs.recoverExpiredLease({
        workspaceId: row.workspaceId,
        jobId: row.jobId,
        traceId: `reconcile:${row.jobId}`,
      });
    }
  }

  private async inspectAndRecord(row: ExpiredLeaseRow): Promise<ReturnType<MockProvider["inspect"]>> {
    if (!row.providerRequestId || !row.providerConfigurationId) {
      throw new Error("Persisted provider request is missing its provider configuration");
    }
    const inspected = this.provider.inspect(row.providerRequestId);
    await this.jobs.recordProviderEvent({
      workspaceId: row.workspaceId,
      providerConfigurationId: row.providerConfigurationId,
      jobAttemptId: row.attemptId,
      providerRequestId: row.providerRequestId,
      source: "POLL",
      normalizedEventKey: `poll:${inspected.toLowerCase()}`,
      externalStatus: inspected,
    });
    return inspected;
  }

  private async completeWaitingExternal(): Promise<void> {
    const rows = await this.store.listWaitingExternal(50);
    for (const row of rows) {
      if (row.cancelRequested) {
        await this.jobs.confirmCancellation({
          workspaceId: row.workspaceId,
          jobId: row.jobId,
          attemptId: row.attemptId,
          traceId: `reconcile-wait-cancel:${row.jobId}`,
        });
        continue;
      }
      if (!row.providerRequestId) continue;
      const inspected = await this.inspectAndRecord(row);
      if (inspected === "SUCCEEDED") {
        await this.jobs.succeedJob({
          workspaceId: row.workspaceId,
          jobId: row.jobId,
          attemptId: row.attemptId,
          traceId: `reconcile-wait:${row.jobId}`,
          responseSnapshot: { recovered: true },
        });
      } else if (inspected === "FAILED") {
        await this.jobs.failJob({
          workspaceId: row.workspaceId,
          jobId: row.jobId,
          attemptId: row.attemptId,
          traceId: `reconcile-wait:${row.jobId}`,
          errorCode: "MOCK_EXTERNAL_FAILED",
          errorMessage: "Inspected mock request failed",
          retryable: true,
        });
      } else if (inspected === "CANCELED") {
        await this.jobs.confirmCancellation({
          workspaceId: row.workspaceId,
          jobId: row.jobId,
          attemptId: row.attemptId,
          traceId: `reconcile-wait:${row.jobId}`,
        });
      }
    }
  }
}
