import { describe, expect, it, vi } from "vitest";
import type { JobPersistenceService, MediaAssetStore, MediaAssetRecord } from "@ai-drama/database";
import { MockMediaAdapter } from "@ai-drama/providers";
import { recoverMockImageAttempt, runMockImageJob, type MockImageJob } from "./mock-image-generation";

const input: MockImageJob = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  shotRevisionId: "33333333-3333-4333-8333-333333333333",
  jobId: "44444444-4444-4444-8444-444444444444",
  dispatchSeq: 1,
  providerConfigurationId: "55555555-5555-4555-8555-555555555555",
  inputHash: "ab".repeat(32),
  inputSnapshot: { prompt: "test" },
  traceId: "mock-test",
};

describe("synchronous Mock image generation", () => {
  it("acquires attempt, persists validated output, then completes job", async () => {
    const order: string[] = [];
    const jobs = {
      acquireQueuedJob: vi.fn(async () => {
        order.push("acquire");
        return { attemptId: "66666666-6666-4666-8666-666666666666", attemptNo: 1 };
      }),
      attachProviderRequest: vi.fn(async () => { order.push("attach"); }),
    } as unknown as JobPersistenceService;
    const asset: MediaAssetRecord = {
      id: "77777777-7777-4777-8777-777777777777",
      projectId: input.projectId,
      kind: "IMAGE",
      objectKey: "mock",
      mimeType: "image/png",
      checksumSha256: "cd".repeat(32),
      sourceShotRevisionId: input.shotRevisionId,
      providerRequestId: "mock",
      createdAt: new Date().toISOString(),
    };
    const assets = {
      assertUsableShot: vi.fn(async () => { order.push("gate"); }),
      completeAttemptWithAsset: vi.fn(async () => { order.push("atomic-complete"); return asset; }),
    } as unknown as MediaAssetStore;
    const put = vi.fn(async () => { order.push("put"); });
    const result = await runMockImageJob(input, {
      jobs, assets, adapter: new MockMediaAdapter(), objects: { put },
    });
    expect(result).toEqual(asset);
    expect(order).toEqual(["acquire", "gate", "attach", "put", "atomic-complete"]);
    expect(put.mock.calls).toHaveLength(1);
    expect(vi.mocked(assets.completeAttemptWithAsset)).toHaveBeenCalledWith(jobs, expect.objectContaining({
      sourceShotRevisionId: input.shotRevisionId,
      width: 1,
      height: 1,
      sourceJobAttemptId: "66666666-6666-4666-8666-666666666666",
    }));
  });

  it("does not submit or persist when the queued job was already acquired", async () => {
    const adapter = new MockMediaAdapter();
    const submit = vi.spyOn(adapter, "submit");
    const jobs = { acquireQueuedJob: vi.fn(async () => null) } as unknown as JobPersistenceService;
    const assets = { assertUsableShot: vi.fn(async () => undefined) } as unknown as MediaAssetStore;
    const put = vi.fn(async () => undefined);
    expect(await runMockImageJob(input, { jobs, assets, adapter, objects: { put } })).toBeNull();
    expect(submit).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("preserves the attached attempt after object failure for lease recovery", async () => {
    const failJob = vi.fn(async () => "requeued" as const);
    const jobs = {
      acquireQueuedJob: vi.fn(async () => ({ attemptId: "attempt", attemptNo: 1 })),
      attachProviderRequest: vi.fn(async () => undefined),
      failJob,
    } as unknown as JobPersistenceService;
    const completeAttemptWithAsset = vi.fn();
    const assets = { assertUsableShot: vi.fn(async () => undefined), completeAttemptWithAsset } as unknown as MediaAssetStore;
    await expect(runMockImageJob(input, {
      jobs, assets, adapter: new MockMediaAdapter(),
      objects: { put: async () => { throw new Error("disk temporarily unavailable"); } },
    })).rejects.toThrow(/disk temporarily unavailable/);
    expect(completeAttemptWithAsset).not.toHaveBeenCalled();
    expect(failJob).not.toHaveBeenCalled();
  });

  it("resumes a persisted provider request without resubmitting on Redis redelivery", async () => {
    const adapter = new MockMediaAdapter();
    const submit = vi.spyOn(adapter, "submit");
    const resultAsset = { id: "asset-id" } as MediaAssetRecord;
    const completeAttemptWithAsset = vi.fn(async () => resultAsset);
    const recordProviderEvent = vi.fn(async () => true);
    const put = vi.fn(async () => undefined);
    const providerRequestId = `mock-media|image.generate|${input.jobId}:1`;
    const result = await recoverMockImageAttempt({
      workspaceId: input.workspaceId, projectId: input.projectId,
      shotRevisionId: input.shotRevisionId, jobId: input.jobId,
      providerConfigurationId: input.providerConfigurationId,
      traceId: input.traceId, attemptId: "attempt-1", providerRequestId,
    }, {
      jobs: { recordProviderEvent } as unknown as JobPersistenceService,
      assets: { completeAttemptWithAsset } as unknown as MediaAssetStore,
      adapter, objects: { put },
    });
    expect(result).toEqual(resultAsset);
    expect(submit).not.toHaveBeenCalled();
    expect(recordProviderEvent).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(completeAttemptWithAsset).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ providerRequestId, sourceJobAttemptId: "attempt-1" }));
  });

  it("persists deterministic Mock request before submit so a submit crash is recoverable", async () => {
    const order: string[] = [];
    const adapter = new MockMediaAdapter();
    vi.spyOn(adapter, "submit").mockImplementation(async () => {
      order.push("submit");
      throw new Error("worker crashed during submit");
    });
    const failJob = vi.fn();
    const jobs = {
      acquireQueuedJob: vi.fn(async () => ({ attemptId: "attempt", attemptNo: 1 })),
      attachProviderRequest: vi.fn(async () => { order.push("attach"); }),
      failJob,
    } as unknown as JobPersistenceService;
    const assets = { assertUsableShot: vi.fn(async () => undefined) } as unknown as MediaAssetStore;
    await expect(runMockImageJob(input, { jobs, assets, adapter,
      objects: { put: async () => undefined } })).rejects.toThrow(/crashed during submit/);
    expect(order).toEqual(["attach", "submit"]);
    expect(failJob).not.toHaveBeenCalled();
  });
});
