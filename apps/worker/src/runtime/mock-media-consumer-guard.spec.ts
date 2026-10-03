import { describe, expect, it, vi } from "vitest";
import type { JobPersistenceService, MockTextService, RuntimeStore } from "@ai-drama/database";
import type { MockProvider } from "@ai-drama/providers";
import { MockJobConsumer } from "./consumer";
import { completeMockJob } from "./mock-text-completion";

describe("media jobs stay off the text consumer", () => {
  it.each(["MEDIA_VIDEO", "MEDIA_SUBTITLE", "MEDIA_MUSIC"] as const)("refuses %s before mock.generate", async (kind) => {
    const store = {
      loadExecution: vi.fn(async () => ({ kind, providerConfigurationId: "provider" })),
    } as unknown as RuntimeStore;
    const jobs = { acquireQueuedJob: vi.fn(), failJob: vi.fn() } as unknown as JobPersistenceService;
    const provider = { submit: vi.fn() } as unknown as MockProvider;
    const consumer = new MockJobConsumer(jobs, store, provider, "worker", 1000);
    await expect(consumer.handle({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      jobId: "22222222-2222-4222-8222-222222222222",
      dispatchSeq: 1,
    })).rejects.toThrow(/text consumer/);
    expect(provider.submit).not.toHaveBeenCalled();
    expect(jobs.acquireQueuedJob).not.toHaveBeenCalled();
  });

  it("fails a media kind that reaches text completion", async () => {
    const failJob = vi.fn(async () => "failed" as const);
    const succeedJob = vi.fn();
    const jobs = { failJob, succeedJob } as unknown as JobPersistenceService;
    const result = await completeMockJob(jobs, {} as MockTextService, {
      jobId: "job", workspaceId: "workspace", workflowRunId: "run", state: "RUNNING",
      kind: "MEDIA_TTS", inputHash: "ab".repeat(32), inputSnapshot: {}, cancelRequested: false,
      providerConfigurationId: null, maxAttempts: 1, attemptNo: 1, providerRequestId: null,
    }, "attempt", "trace", {});
    expect(result).toBe("completed");
    expect(failJob).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "MOCK_MEDIA_ROUTE_INVALID", retryable: false }));
    expect(succeedJob).not.toHaveBeenCalled();
  });
});
