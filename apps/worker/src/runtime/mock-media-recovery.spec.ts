import { describe, expect, it, vi } from "vitest";
import { PersistenceError, type JobPersistenceService, type MediaAssetStore, type RuntimeStore } from "@ai-drama/database";
import { MockMediaAdapter } from "@ai-drama/providers";
import { MockMediaRecovery } from "./mock-media-recovery";

it("continues recovering a sibling after an invalid media row", async () => {
  const rows = ["bad", "sibling"].map((jobId) => ({ workspaceId: "workspace",
    jobId, attemptId: `attempt-${jobId}`, providerConfigurationId: "provider",
    providerRequestId: jobId === "bad" ? "bad-request" : null, cancelRequested: false }));
  const store = {
    listExpiredMockMedia: vi.fn(async () => rows),
    loadMockMediaExecution: vi.fn(async (_workspace: string, jobId: string) => ({
      workspaceId: "workspace", jobId, projectId: "project", kind: "MEDIA_IMAGE",
      shotRevisionId: "shot",
      providerConfigurationId: jobId === "bad" ? "mismatch" : "provider",
      inputSnapshot: { outcome: "success" },
      state: "RUNNING", cancelRequested: false,
    })),
  } as unknown as RuntimeStore;
  const recoverExpiredLease = vi.fn(async () => "requeued" as const);
  const failJob = vi.fn(async () => "failed" as const);
  const jobs = { recoverExpiredLease, failJob } as unknown as JobPersistenceService;
  const recovery = new MockMediaRecovery(jobs, {} as MediaAssetStore, store,
    new MockMediaAdapter(), { put: async () => undefined },
    { mockImageEnabled: true, mockAvEnabled: false });
  await recovery.reconcileOnce();
  expect(failJob).toHaveBeenCalledWith(expect.objectContaining({
    jobId: "bad", errorCode: "MOCK_MEDIA_NOT_CONFIGURED", retryable: false,
  }));
  expect(recoverExpiredLease).toHaveBeenCalledWith(expect.objectContaining({ jobId: "sibling" }));
});

describe("simulated AV recovery settles permanent failures", () => {
  const codes = ["REVIEW_REQUIRED", "NOT_FOUND", "COST_CONFLICT"] as const;

  it.each(codes.flatMap((code) => (["MEDIA_VIDEO", "MEDIA_TTS"] as const).map((kind) => [kind, code] as const)))(
    "fails the original %s attempt on %s once and does not inspect again",
    async (kind, code) => {
      const capability = kind === "MEDIA_VIDEO" ? "video.generate" : "audio.tts";
      const jobId = `${kind}-${code}`;
      const attemptId = `attempt-${jobId}`;
      const providerRequestId = `mock-media|sync|${capability}|${jobId}:1`;
      let listed = [{
        workspaceId: "workspace", jobId, attemptId, providerConfigurationId: "provider",
        providerRequestId, cancelRequested: false,
      }];
      const failJob = vi.fn(async () => {
        listed = [];
        return "failed" as const;
      });
      const completeAttemptWithAsset = vi.fn(async () => {
        throw new PersistenceError(code, `${code} from the stand-in ledger`);
      });
      const put = vi.fn(async () => undefined);
      const adapter = new MockMediaAdapter();
      const submit = vi.spyOn(adapter, "submit");
      const inspect = vi.spyOn(adapter, "inspect");
      const recovery = new MockMediaRecovery(
        { failJob, recordProviderEvent: vi.fn(async () => true), recoverExpiredLease: vi.fn() } as unknown as JobPersistenceService,
        { completeAttemptWithAsset } as unknown as MediaAssetStore,
        {
          listExpiredMockMedia: vi.fn(async () => listed),
          loadMockMediaExecution: vi.fn(async () => ({
            workspaceId: "workspace", jobId, projectId: "project", kind,
            shotRevisionId: "shot", providerConfigurationId: "provider",
            inputHash: "ab".repeat(32),
            inputSnapshot: { outcome: "success", executionMode: "sync", capability },
            state: "RUNNING", cancelRequested: false,
          })),
        } as unknown as RuntimeStore,
        adapter,
        { put },
        { mockImageEnabled: false, mockAvEnabled: true },
      );
      await recovery.reconcileOnce();
      await recovery.reconcileOnce();
      expect(failJob).toHaveBeenCalledTimes(1);
      expect(failJob).toHaveBeenCalledWith(expect.objectContaining({
        jobId, attemptId, retryable: false, errorCode: "MOCK_AV_OUTPUT_INVALID",
      }));
      expect(submit).not.toHaveBeenCalled();
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(put).toHaveBeenCalledTimes(1);
      expect(completeAttemptWithAsset).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a stale or disk failure recoverable, then commits once", async () => {
    const jobId = "video-transient";
    const attemptId = "attempt-transient";
    let disk = true;
    let stale = true;
    const failJob = vi.fn();
    const completeAttemptWithAsset = vi.fn(async () => {
      if (stale) {
        stale = false;
        throw new PersistenceError("STALE_RECALCULATION_PENDING", "recalculation still running");
      }
      return { id: "asset" };
    });
    const put = vi.fn(async () => {
      if (disk) {
        disk = false;
        throw new Error("EIO");
      }
    });
    const adapter = new MockMediaAdapter();
    const submit = vi.spyOn(adapter, "submit");
    const store = {
      listExpiredMockMedia: vi.fn(async () => [{
        workspaceId: "workspace", jobId, attemptId, providerConfigurationId: "provider",
        providerRequestId: `mock-media|sync|video.generate|${jobId}:1`, cancelRequested: false,
      }]),
      loadMockMediaExecution: vi.fn(async () => ({
        workspaceId: "workspace", jobId, projectId: "project", kind: "MEDIA_VIDEO",
        shotRevisionId: "shot", providerConfigurationId: "provider",
        inputHash: "ab".repeat(32),
        inputSnapshot: { outcome: "success", executionMode: "sync", capability: "video.generate" },
        state: "RUNNING", cancelRequested: false,
      })),
    } as unknown as RuntimeStore;
    const recovery = new MockMediaRecovery(
      { failJob, recordProviderEvent: vi.fn(async () => true) } as unknown as JobPersistenceService,
      { completeAttemptWithAsset } as unknown as MediaAssetStore,
      store, adapter, { put }, { mockImageEnabled: false, mockAvEnabled: true },
    );
    await expect(recovery.reconcileOnce()).rejects.toBeInstanceOf(AggregateError);
    expect(failJob).not.toHaveBeenCalled();
    expect(completeAttemptWithAsset).not.toHaveBeenCalled();
    await expect(recovery.reconcileOnce()).rejects.toBeInstanceOf(AggregateError);
    expect(failJob).not.toHaveBeenCalled();
    expect(completeAttemptWithAsset).toHaveBeenCalledTimes(1);
    await recovery.reconcileOnce();
    expect(failJob).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(completeAttemptWithAsset).toHaveBeenCalledTimes(2);
    expect(put.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not fail a newer attempt when completion reports a terminal race", async () => {
    const failJob = vi.fn();
    const confirmCancellation = vi.fn(async () => {
      throw new PersistenceError("JOB_TERMINAL", "Job is already terminal");
    });
    const adapter = new MockMediaAdapter();
    const inspect = vi.spyOn(adapter, "inspect");
    const recovery = new MockMediaRecovery(
      { failJob, confirmCancellation } as unknown as JobPersistenceService,
      { completeAttemptWithAsset: vi.fn() } as unknown as MediaAssetStore,
      {
        listExpiredMockMedia: vi.fn(async () => [{
          workspaceId: "workspace", jobId: "canceled", attemptId: "old-attempt",
          providerConfigurationId: "provider", providerRequestId: "mock-media|sync|video.generate|canceled:1",
          cancelRequested: true,
        }]),
        loadMockMediaExecution: vi.fn(async () => ({
          workspaceId: "workspace", jobId: "canceled", projectId: "project", kind: "MEDIA_VIDEO",
          shotRevisionId: "shot", providerConfigurationId: "provider",
          inputSnapshot: { executionMode: "sync", capability: "video.generate", outcome: "success" },
          state: "RUNNING", cancelRequested: true,
        })),
      } as unknown as RuntimeStore,
      adapter, { put: vi.fn() }, { mockImageEnabled: true, mockAvEnabled: true },
    );
    await recovery.reconcileOnce();
    expect(confirmCancellation).toHaveBeenCalledWith(expect.objectContaining({ attemptId: "old-attempt" }));
    expect(failJob).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("leaves an unknown runtime failure visible and does not treat the word REVIEW_REQUIRED as a code", async () => {
    const failJob = vi.fn();
    const completeAttemptWithAsset = vi.fn(async () => {
      throw new Error("REVIEW_REQUIRED");
    });
    const recovery = new MockMediaRecovery(
      { failJob, recordProviderEvent: vi.fn(async () => true) } as unknown as JobPersistenceService,
      { completeAttemptWithAsset } as unknown as MediaAssetStore,
      {
        listExpiredMockMedia: vi.fn(async () => [{
          workspaceId: "workspace", jobId: "word", attemptId: "attempt-word",
          providerConfigurationId: "provider",
          providerRequestId: "mock-media|sync|audio.tts|word:1", cancelRequested: false,
        }]),
        loadMockMediaExecution: vi.fn(async () => ({
          workspaceId: "workspace", jobId: "word", projectId: "project", kind: "MEDIA_TTS",
          shotRevisionId: "shot", providerConfigurationId: "provider",
          inputSnapshot: { executionMode: "sync", capability: "audio.tts", outcome: "success" },
          state: "RUNNING", cancelRequested: false,
        })),
      } as unknown as RuntimeStore,
      new MockMediaAdapter(), { put: vi.fn(async () => undefined) },
      { mockImageEnabled: false, mockAvEnabled: true },
    );
    await expect(recovery.reconcileOnce()).rejects.toBeInstanceOf(AggregateError);
    expect(failJob).not.toHaveBeenCalled();
    expect(completeAttemptWithAsset).toHaveBeenCalledTimes(1);
  });

  it("does not fail the current attempt when the stored attempt was superseded", async () => {
    const failJob = vi.fn();
    const put = vi.fn(async () => undefined);
    let listed = true;
    const recovery = new MockMediaRecovery(
      { failJob, recordProviderEvent: vi.fn(async () => true) } as unknown as JobPersistenceService,
      { completeAttemptWithAsset: vi.fn(async () => {
        listed = false;
        throw new PersistenceError("ATTEMPT_SUPERSEDED", "Attempt was superseded by a newer worker execution");
      }) } as unknown as MediaAssetStore,
      {
        listExpiredMockMedia: vi.fn(async () => listed ? [{
          workspaceId: "workspace", jobId: "old", attemptId: "old-attempt",
          providerConfigurationId: "provider",
          providerRequestId: "mock-media|sync|audio.tts|old:1", cancelRequested: false,
        }] : []),
        loadMockMediaExecution: vi.fn(async () => ({
          workspaceId: "workspace", jobId: "old", projectId: "project", kind: "MEDIA_TTS",
          shotRevisionId: "shot", providerConfigurationId: "provider",
          inputSnapshot: { executionMode: "sync", capability: "audio.tts", outcome: "success" },
          state: "RUNNING", cancelRequested: false,
        })),
      } as unknown as RuntimeStore,
      new MockMediaAdapter(), { put }, { mockImageEnabled: false, mockAvEnabled: true },
    );
    await recovery.reconcileOnce();
    await recovery.reconcileOnce();
    expect(failJob).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledTimes(1);
  });
});
