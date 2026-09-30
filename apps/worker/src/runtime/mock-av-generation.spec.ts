import { describe, expect, it, vi } from "vitest";
import type { JobPersistenceService, MediaAssetRecord, MediaAssetStore } from "@ai-drama/database";
import { MockMediaAdapter } from "@ai-drama/providers";
import { recoverMockAvAttempt, runMockAvJob, type MockAvJob } from "./mock-av-generation";

const input: MockAvJob = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  shotRevisionId: "33333333-3333-4333-8333-333333333333",
  jobId: "44444444-4444-4444-8444-444444444444",
  dispatchSeq: 1,
  providerConfigurationId: "55555555-5555-4555-8555-555555555555",
  inputHash: "ab".repeat(32),
  inputSnapshot: {
    schema: "m3.mock.video.v1",
    outcome: "success",
    executionMode: "sync",
    capability: "video.generate",
    sourceText: "已保存提示",
  },
  traceId: "mock-av",
  capability: "video.generate",
};

describe("synchronous mock video", () => {
  it("stores the canonical fixture and a zero actual cost without resubmitting on recovery", async () => {
    const jobs = {
      acquireQueuedJob: vi.fn(async () => ({ attemptId: "66666666-6666-4666-8666-666666666666", attemptNo: 1 })),
      attachProviderRequest: vi.fn(async () => undefined),
      recordProviderEvent: vi.fn(async () => true),
      failJob: vi.fn(async (failed: { errorMessage: string }) => {
        throw new Error(failed.errorMessage);
      }),
    } as unknown as JobPersistenceService;
    const asset = { id: "77777777-7777-4777-8777-777777777777" } as MediaAssetRecord;
    const completeAttemptWithAsset = vi.fn(async () => asset);
    const assets = {
      assertUsableShot: vi.fn(async () => undefined),
      completeAttemptWithAsset,
    } as unknown as MediaAssetStore;
    const put = vi.fn(async () => undefined);
    const adapter = new MockMediaAdapter();
    const created = await runMockAvJob(input, { jobs, assets, adapter, objects: { put } });
    expect(created).toBe(asset);
    expect(completeAttemptWithAsset).toHaveBeenCalledWith(jobs, expect.objectContaining({
      kind: "VIDEO",
      mimeType: "video/mp4",
      durationMs: 1000,
      width: 16,
      height: 16,
      byteSize: 1552,
      actualCost: expect.objectContaining({
        kind: "ACTUAL",
        currency: "USD",
        amountDecimal: "0.00000000",
        supersedesEstimateKey: undefined,
      }),
    }));
    const submit = vi.spyOn(adapter, "submit");
    const providerRequestId = `mock-media|sync|video.generate|${input.jobId}:1`;
    await recoverMockAvAttempt({
      ...input,
      attemptId: "66666666-6666-4666-8666-666666666666",
      providerRequestId,
    }, { jobs, assets, adapter: new MockMediaAdapter(), objects: { put } });
    expect(submit).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("does not create an asset when the queued attempt is already taken", async () => {
    const adapter = new MockMediaAdapter();
    const submit = vi.spyOn(adapter, "submit");
    const jobs = { acquireQueuedJob: vi.fn(async () => null) } as unknown as JobPersistenceService;
    const assets = { completeAttemptWithAsset: vi.fn() } as unknown as MediaAssetStore;
    expect(await runMockAvJob(input, { jobs, assets, adapter, objects: { put: async () => undefined } })).toBeNull();
    expect(submit).not.toHaveBeenCalled();
    expect(assets.completeAttemptWithAsset).not.toHaveBeenCalled();
  });
});
