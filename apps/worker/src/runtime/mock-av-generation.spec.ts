import { describe, expect, it, vi } from "vitest";
import { PersistenceError, type JobPersistenceService, type MediaAssetRecord, type MediaAssetStore } from "@ai-drama/database";
import { SAMPLE_VIDEO_DESCRIPTIONS, SAMPLE_VIDEO_SCHEMA } from "@ai-drama/contracts";
import { MockMediaAdapter, sampleVideoBytes } from "@ai-drama/providers";
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

describe("sample video execution", () => {
  const description = SAMPLE_VIDEO_DESCRIPTIONS["sample-15s-a-v1"];
  const sampleInput: MockAvJob = {
    ...input,
    inputSnapshot: {
      schema: SAMPLE_VIDEO_SCHEMA,
      ...description,
      shotRevisionId: input.shotRevisionId,
      seed: null,
      outcome: "success",
      executionMode: "sync",
      capability: "video.generate",
      sourceText: "技术验收样片",
      sourceHash: "cd".repeat(32),
    },
  };

  it("keeps the original attempt after an object-write failure and stores one actual cost on recovery", async () => {
    const attemptId = "66666666-6666-4666-8666-666666666666";
    const requestId = `mock-media|sample-sync-v1|video.generate|sample-15s-a-v1|${input.jobId}:1`;
    const jobs = {
      acquireQueuedJob: vi.fn(async () => ({ attemptId, attemptNo: 1 })),
      attachProviderRequest: vi.fn(async () => undefined),
      recordProviderEvent: vi.fn(async () => true),
      failJob: vi.fn(async () => undefined),
    } as unknown as JobPersistenceService;
    const asset = { id: "77777777-7777-4777-8777-777777777777" } as MediaAssetRecord;
    const completeAttemptWithAsset = vi.fn(async () => asset);
    const assets = {
      assertUsableShot: vi.fn(async () => undefined),
      completeAttemptWithAsset,
    } as unknown as MediaAssetStore;
    const put = vi.fn(async () => {
      throw new Error("disk unavailable");
    });
    await expect(runMockAvJob(sampleInput, { jobs, assets, adapter: new MockMediaAdapter(), objects: { put } })).rejects.toThrow(/disk unavailable/);
    expect(jobs.attachProviderRequest).toHaveBeenCalledWith(expect.objectContaining({ providerRequestId: requestId, attemptId }));
    expect(completeAttemptWithAsset).not.toHaveBeenCalled();
    const recovered = await recoverMockAvAttempt({
      ...sampleInput,
      attemptId,
      providerRequestId: requestId,
    }, { jobs, assets, adapter: new MockMediaAdapter(), objects: { put: vi.fn(async () => undefined) } });
    expect(recovered).toBe(asset);
    expect(completeAttemptWithAsset).toHaveBeenCalledTimes(1);
    expect(completeAttemptWithAsset).toHaveBeenCalledWith(jobs, expect.objectContaining({
      providerRequestId: requestId,
      sourceJobAttemptId: attemptId,
      byteSize: description.byteSize,
      checksumSha256: description.checksumSha256,
      durationMs: 15000,
      width: 180,
      height: 320,
      metadata: expect.objectContaining({ schema: SAMPLE_VIDEO_SCHEMA, fixtureId: "sample-15s-a-v1" }),
      actualCost: expect.objectContaining({ kind: "ACTUAL", currency: "USD", amountDecimal: "0.00000000", supersedesEstimateKey: undefined }),
    }));
    const stored = completeAttemptWithAsset.mock.calls[0]?.[1] as { checksumSha256: string };
    expect(stored.checksumSha256).toBe(description.checksumSha256);
    expect(sampleVideoBytes("sample-15s-a-v1").length).toBe(description.byteSize);
  });

  it("rejects a sample request whose frozen fixture does not match the resolved bytes", async () => {
    const jobs = {
      recordProviderEvent: vi.fn(async () => true),
    } as unknown as JobPersistenceService;
    const assets = { completeAttemptWithAsset: vi.fn() } as unknown as MediaAssetStore;
    const requestId = `mock-media|sample-sync-v1|video.generate|sample-15s-a-v1|${input.jobId}:1`;
    const adapter = new MockMediaAdapter();
    const inspected = await adapter.inspect(requestId);
    if (inspected.state !== "SUCCEEDED") throw new Error("expected sample inspection");
    const mismatched = {
      ...inspected.outputs[0],
      metadata: { providerRequestId: requestId, fixtureId: "sample-15s-b-v1" },
    };
    await expect(recoverMockAvAttempt({
      ...sampleInput,
      attemptId: "66666666-6666-4666-8666-666666666666",
      providerRequestId: requestId,
    }, {
      jobs,
      assets,
      adapter: { ...adapter, resolveOutput: async () => ({ uri: "data:video/mp4;base64," }) , inspect: async () => ({ ...inspected, outputs: [mismatched] }) },
      objects: { put: vi.fn() },
    })).rejects.toThrow(/canonical fixture/);
    expect(assets.completeAttemptWithAsset).not.toHaveBeenCalled();
  });

  it("ends the attempt once when a frozen character reference is no longer usable (review P1)", async () => {
    const failJob = vi.fn(async () => "failed" as const);
    const jobs = {
      acquireQueuedJob: vi.fn(async () => ({ attemptId: "66666666-6666-4666-8666-666666666666", attemptNo: 1 })),
      attachProviderRequest: vi.fn(async () => undefined),
      failJob,
    } as unknown as JobPersistenceService;
    const completeAttemptWithAsset = vi.fn(async () => {
      throw new PersistenceError("CHARACTER_REFERENCE_REQUIRED", "A frozen character reference is no longer usable");
    });
    const assets = { assertUsableShot: vi.fn(async () => undefined), completeAttemptWithAsset } as unknown as MediaAssetStore;
    const adapter = new MockMediaAdapter();
    const submit = vi.spyOn(adapter, "submit");
    await expect(runMockAvJob(input, { jobs, assets, adapter, objects: { put: async () => undefined } })).resolves.toBeNull();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(failJob).toHaveBeenCalledTimes(1);
    expect(failJob).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "CHARACTER_REFERENCE_REQUIRED", retryable: false, attemptId: "66666666-6666-4666-8666-666666666666",
    }));
  });

  it("still leaves a transient failure after the request was attached to lease recovery", async () => {
    const failJob = vi.fn();
    const jobs = {
      acquireQueuedJob: vi.fn(async () => ({ attemptId: "66666666-6666-4666-8666-666666666666", attemptNo: 1 })),
      attachProviderRequest: vi.fn(async () => undefined),
      failJob,
    } as unknown as JobPersistenceService;
    const assets = { assertUsableShot: vi.fn(async () => undefined),
      completeAttemptWithAsset: vi.fn(async () => { throw new Error("connection terminated unexpectedly"); }) } as unknown as MediaAssetStore;
    await expect(runMockAvJob(input, { jobs, assets, adapter: new MockMediaAdapter(), objects: { put: async () => undefined } }))
      .rejects.toThrow("connection terminated");
    expect(failJob).not.toHaveBeenCalled();
  });
});
