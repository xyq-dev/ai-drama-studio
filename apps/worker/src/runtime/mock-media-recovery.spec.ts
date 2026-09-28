import { expect, it, vi } from "vitest";
import type { JobPersistenceService, MediaAssetStore, RuntimeStore } from "@ai-drama/database";
import { MockMediaAdapter } from "@ai-drama/providers";
import { MockMediaRecovery } from "./mock-media-recovery";

it("continues recovering a sibling after an invalid media row", async () => {
  const rows = ["bad", "sibling"].map((jobId) => ({ workspaceId: "workspace",
    jobId, attemptId: `attempt-${jobId}`, providerConfigurationId: "provider",
    providerRequestId: jobId === "bad" ? "bad-request" : null, cancelRequested: false }));
  const store = {
    listExpiredMockImages: vi.fn(async () => rows),
    loadMockImageExecution: vi.fn(async (_workspace: string, jobId: string) => ({
      workspaceId: "workspace", jobId, projectId: "project", shotRevisionId: "shot",
      providerConfigurationId: jobId === "bad" ? "mismatch" : "provider",
      state: "RUNNING", cancelRequested: false,
    })),
  } as unknown as RuntimeStore;
  const recoverExpiredLease = vi.fn(async () => "requeued" as const);
  const failJob = vi.fn(async () => "failed" as const);
  const jobs = { recoverExpiredLease, failJob } as unknown as JobPersistenceService;
  const recovery = new MockMediaRecovery(jobs, {} as MediaAssetStore, store,
    new MockMediaAdapter(), { put: async () => undefined });
  await recovery.reconcileOnce();
  expect(failJob).toHaveBeenCalledWith(expect.objectContaining({
    jobId: "bad", errorCode: "MOCK_MEDIA_NOT_CONFIGURED", retryable: false,
  }));
  expect(recoverExpiredLease).toHaveBeenCalledWith(expect.objectContaining({ jobId: "sibling" }));
});
