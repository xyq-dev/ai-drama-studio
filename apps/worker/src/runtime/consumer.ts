import { isMockMediaJobKind, type JobPersistenceService, type MockTextService, type RuntimeStore } from "@ai-drama/database";
import { MOCK_OUTCOMES, MockTextAdapter, type MockOutcome, type MockProvider,
  type TextGenerationAdapter } from "@ai-drama/providers";
import type { QueueMessage } from "./bullmq-queue";
import { completeMockJob } from "./mock-text-completion";
import { retryAt } from "./retry";

function readOutcome(snapshot: unknown): MockOutcome {
  if (snapshot && typeof snapshot === "object" && "outcome" in snapshot) {
    const outcome = (snapshot as { outcome?: unknown }).outcome;
    if (typeof outcome === "string" && MOCK_OUTCOMES.includes(outcome as MockOutcome)) {
      return outcome as MockOutcome;
    }
  }
  return "success";
}

export class MockJobConsumer {
  constructor(
    private readonly jobs: JobPersistenceService,
    private readonly store: RuntimeStore,
    private readonly provider: MockProvider,
    private readonly leaseOwner: string,
    private readonly leaseMs: number,
    private readonly mockText?: MockTextService,
    private readonly textAdapter: TextGenerationAdapter = new MockTextAdapter(),
  ) {}

  async handle(message: QueueMessage): Promise<"processed" | "ignored"> {
    const before = await this.store.loadExecution(message.workspaceId, message.jobId);
    if (before && isMockMediaJobKind(before.kind)) {
      throw new Error("Media jobs must not enter the text consumer");
    }
    if (!before?.providerConfigurationId) return "ignored";
    const acquired = await this.jobs.acquireQueuedJob({
      workspaceId: message.workspaceId,
      jobId: message.jobId,
      dispatchSeq: message.dispatchSeq,
      leaseOwner: this.leaseOwner,
      leaseMs: this.leaseMs,
      traceId: `worker:${message.jobId}:${String(message.dispatchSeq)}`,
      providerConfigurationId: before.providerConfigurationId,
    });
    if (!acquired) return "ignored";

    const current = await this.store.loadExecution(message.workspaceId, message.jobId);
    const outcome = readOutcome(current?.inputSnapshot);
    const result = this.provider.submit({
      clientRequestKey: `${message.jobId}:${String(acquired.attemptNo)}`,
      outcome,
      cancelRequested: current?.cancelRequested === true || outcome === "cancel",
    });
    const traceId = `worker:${acquired.attemptId}`;

    if (result.kind === "canceled") {
      await this.jobs.attachProviderRequest({
        workspaceId: message.workspaceId,
        attemptId: acquired.attemptId,
        providerConfigurationId: before.providerConfigurationId,
        providerRequestId: result.providerRequestId,
      });
      await this.jobs.confirmCancellation({
        workspaceId: message.workspaceId,
        jobId: message.jobId,
        attemptId: acquired.attemptId,
        traceId,
      });
      return "processed";
    }
    if (result.kind === "succeeded") {
      await this.jobs.attachProviderRequest({
        workspaceId: message.workspaceId,
        attemptId: acquired.attemptId,
        providerConfigurationId: before.providerConfigurationId,
        providerRequestId: result.providerRequestId,
      });
      const attached = await this.store.loadExecution(message.workspaceId, message.jobId);
      if (!attached) throw new Error("Acquired job execution context disappeared");
      await completeMockJob(this.jobs, this.mockText, attached, acquired.attemptId, traceId,
        result.output, this.textAdapter);
      return "processed";
    }
    if (result.kind === "failed") {
      await this.jobs.attachProviderRequest({
        workspaceId: message.workspaceId,
        attemptId: acquired.attemptId,
        providerConfigurationId: before.providerConfigurationId,
        providerRequestId: result.providerRequestId,
      });
      await this.jobs.failJob({
        workspaceId: message.workspaceId,
        jobId: message.jobId,
        attemptId: acquired.attemptId,
        traceId,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        retryable: result.retryable,
        nextRunAt: result.retryable ? retryAt(message.jobId, acquired.attemptNo) : undefined,
      });
      return "processed";
    }
    await this.jobs.markWaitingExternal({
      workspaceId: message.workspaceId,
      jobId: message.jobId,
      attemptId: acquired.attemptId,
      providerConfigurationId: before.providerConfigurationId,
      providerRequestId: result.providerRequestId,
      traceId,
      nextPollAt: result.nextPollAt,
    });
    return "processed";
  }
}
