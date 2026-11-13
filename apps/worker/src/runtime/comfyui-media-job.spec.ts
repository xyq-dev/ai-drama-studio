import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { realMediaInputHash } from "@ai-drama/domain";
import { PersistenceError, type RealMediaExecution } from "@ai-drama/database";
import { MediaSubmissionUnknownError, type MediaProviderObservation, type MediaProviderOutput, type MediaSubmitResult } from "@ai-drama/providers";
import { RealMediaRecovery, runRealMediaJob, type RealMediaWorkerDependencies } from "./real-media-job";

const PROVIDER_ID = "comfyui-prompt-1";
const ORIGINAL_SHOT_PROMPT = "原镜头提示词";
const TEST_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aErUAAAAASUVORK5CYII=", "base64");
const REFERENCE_HASH = createHash("sha256").update(TEST_PNG).digest("hex");
const OUTPUT: MediaProviderOutput = {
  kind: "IMAGE", retrieval: { kind: "HANDLE", handle: "opaque-test-handle" },
  mimeTypeHint: "image/png", metadata: { comfyUiAttemptId: "attempt" },
};
const waiting: MediaSubmitResult = { kind: "waiting", providerRequestId: PROVIDER_ID, nextPollAt: "2026-11-13T10:00:00.000Z" };

function execution(state: "QUEUED" | "WAITING_EXTERNAL" = "QUEUED", useReference = false): RealMediaExecution {
  const snapshot: RealMediaExecution["inputSnapshot"] = {
    schema: "real-media.v1", capability: "image.generate", shotRevisionId: "shot",
    sourceText: "用户编辑后的图片提示词", sourceHash: "a".repeat(64),
    ...(useReference ? { sourceImage: { assetId: "reference", checksumSha256: REFERENCE_HASH, rowVersion: 3 } } : {}),
    comfyui: { workflowId: useReference ? "sd15-img2img" : "sd15-txt2img", workflowVersion: "v1", workflowHash: "b".repeat(64),
      width: 512, height: 512, seed: 42, sourceShotPromptHash: createHash("sha256").update(ORIGINAL_SHOT_PROMPT).digest("hex") },
    configuration: { id: "provider", version: "v1", providerKey: "comfyui", capability: "image.generate", model: "fixture.safetensors",
      region: "self-hosted", credentialRef: "env:comfyui", credentialVersion: "v1", enabled: true, queryAllowed: true,
      priceVersion: "v1", currency: "CNY", unitPrice: "0.1", unitType: "image", parameters: { targetedCancellation: true } },
    budget: { authorizationId: "authorization", quoteId: "quote", currency: "CNY", estimatedAmount: "0.1",
      maximumAmount: "0.1", priceVersion: "v1", authorizedBy: "test", authorizedAt: "2026-11-13T08:00:00.000Z", expiresAt: "2026-11-13T09:00:00.000Z" },
  };
  return { workspaceId: "workspace", projectId: "project", shotRevisionId: "shot", jobId: "job", dispatchSeq: 1,
    state, cancelRequested: false, inputHash: realMediaInputHash(snapshot), inputSnapshot: snapshot, outputs: null,
    attemptId: state === "QUEUED" ? null : "attempt", receiptState: state === "QUEUED" ? null : "ACKNOWLEDGED",
    providerRequestId: state === "QUEUED" ? null : PROVIDER_ID };
}

function fixture() {
  let claimed: RealMediaExecution | null = null;
  const query = vi.fn(async () => ({ rows: [{ id: "reference", row_version: 3, checksum_sha256: REFERENCE_HASH }] }));
  const client = { query };
  const submit = vi.fn(async (): Promise<MediaSubmitResult> => waiting);
  const inspect = vi.fn(async (): Promise<MediaProviderObservation> => ({
    state: "ACTIVE", metadata: { phase: "running" }, normalizedEventKey: "running", responseHash: "b".repeat(64), observedAt: new Date().toISOString(),
  }));
  const cancel = vi.fn(async () => undefined);
  const values = {
    jobs: { acquireQueuedJob: vi.fn(async () => ({ attemptId: "attempt", attemptNo: 1 })), renewRunningLease: vi.fn(async () => true),
      failJob: vi.fn(), recordProviderEvent: vi.fn(), confirmCancellation: vi.fn() },
    assets: { assertUsableShot: vi.fn(), prepareRealShotGenerationInTransaction: vi.fn(async () => ({ promptText: ORIGINAL_SHOT_PROMPT })),
      getWorkspaceAsset: vi.fn(async () => ({ kind: "IMAGE", projectId: "project", sourceShotRevisionId: "different-shot", status: "ACTIVE",
        storageProvider: "s3", mimeType: "image/png", checksumSha256: REFERENCE_HASH, rowVersion: 3 })),
      completeAttemptWithAsset: vi.fn(async () => ({ id: "candidate" })) },
    store: { receiptReady: () => true, configurationStillEnabled: async () => true,
      beginSubmission: vi.fn(async (input: { validateInTransaction: (tx: typeof client) => Promise<void> }) => {
        await input.validateInTransaction(client);
        return true;
      }),
      markUnknown: vi.fn(), rejectSubmission: vi.fn(), acknowledge: vi.fn(), releaseDeliveryLease: vi.fn(), assertDeliveryLeaseInTransaction: vi.fn(),
      recordComfyUiPhase: vi.fn(), declineComfyUiCancellation: vi.fn(), confirmComfyUiCancellationInTransaction: vi.fn(),
      hasComfyUiCancellationProof: vi.fn(async () => false), recordComfyUiCancellationProof: vi.fn(),
      claimRecovery: vi.fn(async (e: RealMediaExecution) => { claimed = e; return true; }),
      loadExecution: vi.fn(async () => claimed), renewDeliveryLease: vi.fn(async () => true) },
    adapterFor: vi.fn(async () => ({ submit, inspect, cancel })),
    objects: { readVerified: vi.fn(async () => TEST_PNG),
      putVerified: vi.fn(async () => ({ storageProvider: "s3", objectKey: "scoped-fixture-key", byteSize: TEST_PNG.length, checksumSha256: REFERENCE_HASH })) },
    materialize: vi.fn(async () => ({ bytes: TEST_PNG, mimeType: "image/png", width: 512, height: 512 })),
    preflightLocal: vi.fn(), preflightComfyUi: vi.fn(), validateComfyUiSourceImage: vi.fn(),
  };
  return { ...values, query, submit, inspect, cancel, deps: values as unknown as RealMediaWorkerDependencies };
}

describe("ComfyUI through the real media worker", () => {
  it("reuses scoped reference storage and binds the immutable version and original shot prompt before submit", async () => {
    const f = fixture();
    const e = execution("QUEUED", true);
    await runRealMediaJob(e, f.deps);
    expect(f.assets.getWorkspaceAsset).toHaveBeenCalledExactlyOnceWith("workspace", "reference");
    expect(f.objects.readVerified).toHaveBeenCalledWith(expect.anything(), { workspaceId: "workspace", projectId: "project", maxBytes: 8388608 });
    expect(f.validateComfyUiSourceImage).toHaveBeenCalledWith(TEST_PNG);
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining("FOR SHARE OF asset"), ["reference", "workspace", "project", 3]);
    expect(f.store.beginSubmission.mock.invocationCallOrder[0]).toBeLessThan(f.submit.mock.invocationCallOrder[0]!);
    expect(f.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ capability: "image.generate",
      resolvedSourceImage: { bytes: TEST_PNG, mimeType: "image/png", checksumSha256: REFERENCE_HASH }, inputSnapshot: e.inputSnapshot }));
    expect(f.store.acknowledge).toHaveBeenCalledWith(expect.objectContaining({ providerRequestId: PROVIDER_ID }));
    expect(f.store.recordComfyUiPhase).toHaveBeenCalledWith(expect.objectContaining({ providerRequestId: PROVIDER_ID }), expect.any(String), "COMFYUI_QUEUED", 1);
  });

  it.each(["wrong project", "changed version", "invalid bytes", "changed prompt", "missing model"] as const)("blocks %s before provider submission", async invalid => {
    const f = fixture();
    if (invalid === "wrong project" || invalid === "changed version") {
      const asset = await f.assets.getWorkspaceAsset();
      f.assets.getWorkspaceAsset.mockResolvedValue({ ...asset, ...(invalid === "wrong project" ? { projectId: "other-project" } : { rowVersion: 4 }) });
    }
    if (invalid === "invalid bytes") f.objects.readVerified.mockResolvedValue(Buffer.from("not an image"));
    if (invalid === "changed prompt") f.assets.prepareRealShotGenerationInTransaction.mockResolvedValue({ promptText: "新镜头提示词" });
    if (invalid === "missing model") f.preflightComfyUi.mockRejectedValue(new PersistenceError("COMFYUI_DEPENDENCIES_MISSING", "test"));
    await runRealMediaJob(execution("QUEUED", true), f.deps);
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.store.markUnknown).not.toHaveBeenCalled();
    expect(f.jobs.failJob).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: invalid === "changed prompt" ? "REAL_MEDIA_INPUT_CHANGED" : invalid === "missing model" ? "COMFYUI_DEPENDENCIES_MISSING" : "REAL_MEDIA_SOURCE_INVALID",
      retryable: false,
    }));
  });

  it("retains an uncertain submission without retrying and distinguishes unavailable progress from running", async () => {
    const f = fixture();
    f.submit.mockRejectedValueOnce(new MediaSubmissionUnknownError());
    await runRealMediaJob(execution(), f.deps);
    expect(f.store.markUnknown).toHaveBeenCalledOnce();
    const original = execution("WAITING_EXTERNAL");
    f.inspect.mockRejectedValueOnce(new Error("connection lost"));
    const recovery = new RealMediaRecovery(f.deps);
    await recovery.recover(original);
    expect(f.store.recordComfyUiPhase).toHaveBeenLastCalledWith(original, expect.any(String), "COMFYUI_PROGRESS_UNAVAILABLE", 60);
    await recovery.recover(original);
    expect(f.store.recordComfyUiPhase).toHaveBeenLastCalledWith(original, expect.any(String), "COMFYUI_RUNNING", 5);
    expect(f.inspect.mock.calls).toEqual([[PROVIDER_ID], [PROVIDER_ID]]);
    expect(f.submit).toHaveBeenCalledOnce();
  });

  it("stores only the acknowledged output on restart after object storage failure", async () => {
    const f = fixture();
    const original = execution("WAITING_EXTERNAL");
    f.inspect.mockResolvedValueOnce({ state: "SUCCEEDED", outputs: [OUTPUT], normalizedEventKey: "output",
      responseHash: "c".repeat(64), observedAt: new Date().toISOString() });
    f.objects.putVerified.mockRejectedValueOnce(new Error("fixture S3 failure"));
    await new RealMediaRecovery(f.deps).recover(original);
    expect(f.store.acknowledge).toHaveBeenCalledWith(expect.objectContaining({ outputs: [OUTPUT], providerRequestId: PROVIDER_ID }));
    expect(f.store.recordComfyUiPhase).toHaveBeenCalledWith(original, expect.any(String), "COMFYUI_RESULT_STORAGE_FAILED", 30);
    expect(f.assets.completeAttemptWithAsset).not.toHaveBeenCalled();
    await new RealMediaRecovery(f.deps).recover({ ...original, outputs: [OUTPUT] });
    expect(f.inspect).toHaveBeenCalledExactlyOnceWith(PROVIDER_ID);
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.objects.putVerified).toHaveBeenCalledTimes(2);
    expect(f.assets.completeAttemptWithAsset).toHaveBeenCalledExactlyOnceWith(f.jobs, expect.objectContaining({
      kind: "IMAGE", generationJobId: "job", providerRequestId: PROVIDER_ID, sourceJobAttemptId: "attempt", sourceShotRevisionId: "shot",
    }));
  });

  it("does not download or adopt another attempt's output handle", async () => {
    const f = fixture();
    await new RealMediaRecovery(f.deps).recover({
      ...execution("WAITING_EXTERNAL"), outputs: [{ ...OUTPUT, metadata: { comfyUiAttemptId: "other-attempt" } }],
    });
    expect(f.materialize).not.toHaveBeenCalled();
    expect(f.objects.putVerified).not.toHaveBeenCalled();
    expect(f.jobs.failJob).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "REAL_MEDIA_OUTPUT_INVALID", retryable: false }));
  });

  it("confirms only a verified cancellation for the exact ComfyUI prompt and denies ambiguous cancellation", async () => {
    const f = fixture();
    const original = { ...execution("WAITING_EXTERNAL"), cancelRequested: true };
    const recovery = new RealMediaRecovery(f.deps);
    f.cancel.mockRejectedValueOnce(new Error("COMFYUI_CANCEL_NOT_CONFIRMED"));
    await recovery.recover(original);
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(PROVIDER_ID);
    expect(f.jobs.confirmCancellation).not.toHaveBeenCalled();
    expect(f.store.declineComfyUiCancellation).toHaveBeenCalledWith(original, expect.any(String), "COMFYUI_CANCEL_NOT_CONFIRMED");
    await recovery.recover(original);
    expect(f.store.recordComfyUiCancellationProof).toHaveBeenCalledExactlyOnceWith(original);
    expect(f.store.recordComfyUiCancellationProof.mock.invocationCallOrder[0]).toBeLessThan(f.jobs.confirmCancellation.mock.invocationCallOrder[0]!);
    expect(f.jobs.confirmCancellation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ attemptId: "attempt", beforeCancellation: expect.any(Function) }));
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });
  it.each([true, false])("finishes persisted cancellation proof after restart (local intent %s)", async cancelRequested => {
    const f = fixture();
    f.store.hasComfyUiCancellationProof.mockResolvedValueOnce(true);
    const original = { ...execution("WAITING_EXTERNAL"), cancelRequested };
    await new RealMediaRecovery(f.deps).recover(original);
    expect(f.store.hasComfyUiCancellationProof).toHaveBeenCalledExactlyOnceWith(original);
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.jobs.confirmCancellation).toHaveBeenCalledOnce();
  });
});
