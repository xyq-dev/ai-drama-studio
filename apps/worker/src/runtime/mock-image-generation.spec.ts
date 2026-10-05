import { describe, expect, it, vi } from "vitest";
import { PersistenceError, type JobPersistenceService, type MediaAssetStore, type MediaAssetRecord } from "@ai-drama/database";
import { MockMediaAdapter } from "@ai-drama/providers";
import { recoverMockImageAttempt, runMockImageJob, type MockImageJob } from "./mock-image-generation";

const attemptId = "66666666-6666-4666-8666-666666666666";
const input: MockImageJob = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  shotRevisionId: "33333333-3333-4333-8333-333333333333",
  jobId: "44444444-4444-4444-8444-444444444444",
  dispatchSeq: 1,
  providerConfigurationId: "55555555-5555-4555-8555-555555555555",
  inputHash: "ab".repeat(32),
  inputSnapshot: {
    schema: "m3.mock.image.v1",
    shotRevisionId: "33333333-3333-4333-8333-333333333333",
    seed: null,
    outcome: "success",
  },
  traceId: "mock-test",
};
const providerRequestId = `mock-media|image.generate|${input.jobId}:1`;
const snapshots = [
  ["original four-key v1", Object.freeze({ ...input.inputSnapshot as object })],
  ["extended v1", Object.freeze({ ...input.inputSnapshot as object, bypassCache: false })],
] as const;

describe("synchronous Mock image generation", () => {
  it.each(snapshots)("executes a queued %s snapshot without changing its request identity", async (_label, inputSnapshot) => {
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
    const adapter = new MockMediaAdapter();
    const submit = vi.spyOn(adapter, "submit");
    const persistedJson = JSON.stringify(inputSnapshot);
    const result = await runMockImageJob({ ...input, inputSnapshot }, {
      jobs, assets, adapter, objects: { put },
    });
    expect(result).toEqual(asset);
    expect(order).toEqual(["acquire", "gate", "attach", "put", "atomic-complete"]);
    expect(put.mock.calls).toHaveLength(1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      inputSnapshot, inputHash: input.inputHash, clientRequestKey: `${input.jobId}:1`,
    }));
    expect(JSON.stringify(inputSnapshot)).toBe(persistedJson);
    expect(jobs.attachProviderRequest).toHaveBeenCalledWith(expect.objectContaining({
      attemptId, providerRequestId,
    }));
    expect(vi.mocked(assets.completeAttemptWithAsset)).toHaveBeenCalledWith(jobs, expect.objectContaining({
      sourceShotRevisionId: input.shotRevisionId,
      width: 1,
      height: 1,
      sourceJobAttemptId: attemptId,
      kind: "IMAGE",
      actualCost: expect.objectContaining({
        provider: "mock-media",
        model: "mock-v1",
        kind: "ACTUAL",
        currency: "USD",
        amountDecimal: "0.00000000",
        unitType: "request",
        unitQuantity: "1.00000000",
        unitPriceSnapshot: "0.00000000",
        idempotencyKey: `${providerRequestId}:request:actual`,
        providerRequestId,
        jobAttemptId: attemptId,
      }),
    }));
    const cost = vi.mocked(assets.completeAttemptWithAsset).mock.calls[0]?.[1].actualCost;
    expect(cost?.supersedesEstimateKey).toBeUndefined();
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

  it.each(snapshots)("recovers a persisted %s request without resubmitting or rewriting its snapshot", async (_label, inputSnapshot) => {
    const persistedJson = JSON.stringify(inputSnapshot);
    const adapter = new MockMediaAdapter();
    const submit = vi.spyOn(adapter, "submit");
    const resultAsset = { id: "asset-id" } as MediaAssetRecord;
    const completeAttemptWithAsset = vi.fn(async () => resultAsset);
    const recordProviderEvent = vi.fn(async () => true);
    const put = vi.fn(async () => undefined);
    const result = await recoverMockImageAttempt({
      workspaceId: input.workspaceId, projectId: input.projectId,
      shotRevisionId: input.shotRevisionId, jobId: input.jobId,
      providerConfigurationId: input.providerConfigurationId,
      inputSnapshot,
      traceId: input.traceId, attemptId, providerRequestId,
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
      expect.objectContaining({ providerRequestId, sourceJobAttemptId: attemptId }));
    const cost = completeAttemptWithAsset.mock.calls[0]?.[1].actualCost;
    expect(cost?.idempotencyKey).toBe(`${providerRequestId}:request:actual`);
    expect(cost?.amountDecimal).toBe("0.00000000");
    expect(cost?.supersedesEstimateKey).toBeUndefined();
    expect(recordProviderEvent).toHaveBeenCalledWith(expect.objectContaining({
      normalizedEventKey: (await new MockMediaAdapter().inspect(providerRequestId)).normalizedEventKey,
    }));
    const recoveryAdapter = new MockMediaAdapter();
    const recoverySubmit = vi.spyOn(recoveryAdapter, "submit");
    await recoverMockImageAttempt({
      workspaceId: input.workspaceId, projectId: input.projectId,
      shotRevisionId: input.shotRevisionId, jobId: input.jobId,
      providerConfigurationId: input.providerConfigurationId,
      inputSnapshot,
      traceId: input.traceId, attemptId, providerRequestId,
    }, {
      jobs: { recordProviderEvent } as unknown as JobPersistenceService,
      assets: { completeAttemptWithAsset } as unknown as MediaAssetStore,
      adapter: recoveryAdapter, objects: { put },
    });
    expect(recoverySubmit).not.toHaveBeenCalled();
    expect(JSON.stringify(inputSnapshot)).toBe(persistedJson);
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

  it("fails the original attempt when the receipt or snapshot cannot be booked", async () => {
    const failJob = vi.fn(async () => "failed" as const);
    const completeAttemptWithAsset = vi.fn();
    const jobs = {
      acquireQueuedJob: vi.fn(async () => ({ attemptId, attemptNo: 1 })),
      attachProviderRequest: vi.fn(async () => undefined),
      failJob,
    } as unknown as JobPersistenceService;
    const assets = {
      assertUsableShot: vi.fn(async () => undefined),
      completeAttemptWithAsset,
    } as unknown as MediaAssetStore;
    const adapter = new MockMediaAdapter();
    vi.spyOn(adapter, "submit").mockResolvedValue({
      kind: "succeeded",
      providerRequestId,
      outputs: [{
        kind: "IMAGE",
        retrieval: { kind: "HANDLE", handle: "missing-cost" },
        mimeTypeHint: "image/png",
      }],
    });
    await expect(runMockImageJob(input, {
      jobs, assets, adapter, objects: { put: async () => undefined },
    })).resolves.toBeNull();
    expect(completeAttemptWithAsset).not.toHaveBeenCalled();
    expect(failJob).toHaveBeenCalledWith(expect.objectContaining({
      attemptId, retryable: false, errorCode: "MOCK_IMAGE_OUTPUT_INVALID",
    }));

    failJob.mockClear();
    await expect(runMockImageJob({
      ...input,
      inputSnapshot: { ...input.inputSnapshot as object, executionMode: "delayed" },
    }, {
      jobs, assets, adapter: new MockMediaAdapter(), objects: { put: async () => undefined },
    })).resolves.toBeNull();
    expect(failJob).toHaveBeenCalledWith(expect.objectContaining({
      retryable: false, errorCode: "MOCK_IMAGE_OUTPUT_INVALID",
    }));
  });

  it("keeps a terminal race unchanged and fails a conflicting actual permanently", async () => {
    const failJob = vi.fn(async () => "failed" as const);
    const jobs = {
      acquireQueuedJob: vi.fn(async () => ({ attemptId, attemptNo: 1 })),
      attachProviderRequest: vi.fn(async () => undefined),
      failJob,
    } as unknown as JobPersistenceService;
    const terminal = {
      assertUsableShot: vi.fn(async () => undefined),
      completeAttemptWithAsset: vi.fn(async () => {
        throw new PersistenceError("JOB_TERMINAL", "Terminal jobs cannot reopen");
      }),
    } as unknown as MediaAssetStore;
    await expect(runMockImageJob(input, {
      jobs, assets: terminal, adapter: new MockMediaAdapter(), objects: { put: async () => undefined },
    })).rejects.toMatchObject({ code: "JOB_TERMINAL" });
    expect(failJob).not.toHaveBeenCalled();

    const conflict = {
      assertUsableShot: vi.fn(async () => undefined),
      completeAttemptWithAsset: vi.fn(async () => {
        throw new PersistenceError("COST_CONFLICT", "Mock image accounting estimate already exists");
      }),
    } as unknown as MediaAssetStore;
    await expect(runMockImageJob(input, {
      jobs, assets: conflict, adapter: new MockMediaAdapter(), objects: { put: async () => undefined },
    })).resolves.toBeNull();
    expect(failJob).toHaveBeenCalledWith(expect.objectContaining({
      attemptId, retryable: false, errorCode: "MOCK_IMAGE_OUTPUT_INVALID",
    }));
  });

  it("rejects a recovery receipt that does not supersede the exact estimate key", async () => {
    const adapter = new MockMediaAdapter();
    const baseline = await adapter.inspect(providerRequestId);
    vi.spyOn(adapter, "inspect").mockImplementation(async () => {
      if (baseline.state !== "SUCCEEDED" || !baseline.accounting) return baseline;
      const line = baseline.accounting.costs[0];
      if (!line) return baseline;
      return {
        ...baseline,
        accounting: {
          ...baseline.accounting,
          costs: [{ ...line, supersedesEstimateKey: `${providerRequestId}:request:other` }],
        },
      };
    });
    const recordProviderEvent = vi.fn(async () => true);
    const completeAttemptWithAsset = vi.fn();
    const submit = vi.spyOn(adapter, "submit");
    await expect(recoverMockImageAttempt({
      ...input,
      attemptId,
      providerRequestId,
    }, {
      jobs: { recordProviderEvent } as unknown as JobPersistenceService,
      assets: { completeAttemptWithAsset } as unknown as MediaAssetStore,
      adapter,
      objects: { put: async () => undefined },
    })).rejects.toThrow(/estimate reference is wrong/);
    expect(submit).not.toHaveBeenCalled();
    expect(completeAttemptWithAsset).not.toHaveBeenCalled();
    expect(recordProviderEvent).toHaveBeenCalledWith(expect.objectContaining({
      normalizedEventKey: baseline.normalizedEventKey,
    }));
    expect(baseline.accounting?.costs[0]?.supersedesEstimateKey).toBe(`${providerRequestId}:request:estimated`);
  });
});
