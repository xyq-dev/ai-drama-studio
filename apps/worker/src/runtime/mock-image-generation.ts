import { createHash } from "node:crypto";
import type { JobPersistenceService, MediaAssetStore, MediaAssetRecord } from "@ai-drama/database";
import type { MediaProviderAdapter, MediaGenerationRequest, MediaProviderOutput } from "@ai-drama/providers";

export interface MockImageObjectStore {
  put(input: { key: string; bytes: Buffer; mimeType: "image/png"; checksumSha256: string }): Promise<void>;
}

export interface MockImageJob {
  workspaceId: string;
  projectId: string;
  shotRevisionId: string;
  jobId: string;
  dispatchSeq: number;
  providerConfigurationId: string;
  inputHash: string;
  inputSnapshot: unknown;
  traceId: string;
}

/** Mock-only slice; intentionally not wired to queue delivery until expired-lease
 * routing and redelivery are tested with PostgreSQL and Redis.
 */
export async function runMockImageJob(
  input: MockImageJob,
  dependencies: {
    jobs: JobPersistenceService;
    assets: MediaAssetStore;
    adapter: MediaProviderAdapter;
    objects: MockImageObjectStore;
  },
): Promise<MediaAssetRecord | null> {
  const acquired = await dependencies.jobs.acquireQueuedJob({
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    dispatchSeq: input.dispatchSeq,
    leaseOwner: `mock-image:${input.jobId}`,
    leaseMs: 60_000,
    traceId: input.traceId,
    providerConfigurationId: input.providerConfigurationId,
  });
  if (!acquired) return null;

  let providerAttached = false;
  try {
  await dependencies.assets.assertUsableShot(input.workspaceId, input.projectId, input.shotRevisionId);
  const snapshot = input.inputSnapshot as { outcome?: unknown } | null;
  if (snapshot?.outcome !== undefined && snapshot.outcome !== "success") {
    throw new Error("Synchronous Mock image path only supports success outcome");
  }

  const request: MediaGenerationRequest = {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    shotRevisionId: input.shotRevisionId,
    generationJobId: input.jobId,
    jobAttemptId: acquired.attemptId,
    providerConfigurationId: input.providerConfigurationId,
    clientRequestKey: `${input.jobId}:${acquired.attemptNo}`,
    inputHash: input.inputHash,
    inputSnapshot: input.inputSnapshot,
    traceId: input.traceId,
    capability: "image.generate",
  };
  const expectedProviderRequestId = `mock-media|image.generate|${request.clientRequestKey}`;
  await dependencies.jobs.attachProviderRequest({
    workspaceId: input.workspaceId,
    attemptId: acquired.attemptId,
    providerConfigurationId: input.providerConfigurationId,
    providerRequestId: expectedProviderRequestId,
  });
  providerAttached = true;
  const result = await dependencies.adapter.submit(request);
  if (result.providerRequestId !== expectedProviderRequestId) {
    throw new Error("Mock provider request identity changed");
  }
  if (result.kind !== "succeeded") {
    throw new Error(`Synchronous Mock image job expected success, received ${result.kind}`);
  }
  if (result.outputs.length !== 1 || result.outputs[0]?.kind !== "IMAGE") {
    throw new Error("Mock image job requires exactly one image output");
  }
  return await persistMockImageOutput(input, acquired.attemptId, result.providerRequestId,
    result.outputs[0], dependencies);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    const retryable = code === "STALE_RECALCULATION_PENDING" ||
      (code !== "REVIEW_REQUIRED" && code !== "NOT_FOUND" &&
        !/only supports success|request identity changed|expected success|requires exactly one|must be inline PNG|not a PNG|dimensions are invalid/.test(message));
    if (code === "JOB_TERMINAL" || code === "ATTEMPT_SUPERSEDED") throw error;
    if (providerAttached && retryable) {
      // Preserve the attempt and request; lease recovery inspects it before any resubmit.
      throw error;
    }
    await dependencies.jobs.failJob({
      workspaceId: input.workspaceId, jobId: input.jobId, attemptId: acquired.attemptId,
      traceId: input.traceId,
      errorCode: retryable ? "MOCK_IMAGE_RUNTIME_FAILED" : "MOCK_IMAGE_OUTPUT_INVALID",
      errorMessage: message, retryable,
      nextRunAt: retryable ? new Date(Date.now() + 30_000) : undefined,
    });
    return null;
  }
}

type MockDependencies = {
  jobs: JobPersistenceService;
  assets: MediaAssetStore;
  adapter: MediaProviderAdapter;
  objects: MockImageObjectStore;
};

/** Reinspect a persisted provider request after a crashed worker's lease expires.
 * Redelivery must never resubmit a request with an existing providerRequestId.
 */
export async function recoverMockImageAttempt(
  input: Omit<MockImageJob, "dispatchSeq" | "inputHash" | "inputSnapshot"> & {
    attemptId: string;
    providerRequestId: string;
  },
  dependencies: MockDependencies,
): Promise<MediaAssetRecord | null | "ACTIVE" | "FAILED" | "CANCELED" | "UNKNOWN"> {
  const observation = await dependencies.adapter.inspect(input.providerRequestId);
  await dependencies.jobs.recordProviderEvent({
    workspaceId: input.workspaceId,
    providerConfigurationId: input.providerConfigurationId,
    jobAttemptId: input.attemptId,
    providerRequestId: input.providerRequestId,
    source: "POLL",
    normalizedEventKey: observation.normalizedEventKey,
    externalStatus: observation.state,
  });
  if (observation.state !== "SUCCEEDED") return observation.state;
  if (observation.outputs.length !== 1 || observation.outputs[0]?.kind !== "IMAGE") {
    throw new Error("Recovered Mock request requires exactly one image output");
  }
  return persistMockImageOutput(input, input.attemptId, input.providerRequestId,
    observation.outputs[0], dependencies);
}

async function persistMockImageOutput(
  input: Pick<MockImageJob, "workspaceId" | "projectId" | "shotRevisionId" | "jobId" | "traceId" | "providerConfigurationId">,
  attemptId: string,
  providerRequestId: string,
  output: MediaProviderOutput,
  dependencies: MockDependencies,
): Promise<MediaAssetRecord | null> {
  const resolved = await dependencies.adapter.resolveOutput(output);
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(resolved.uri);
  if (!match) throw new Error("Mock image output must be inline PNG data");
  const bytes = Buffer.from(match[1] ?? "", "base64");
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Mock image output is not a PNG");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width <= 0 || height <= 0) throw new Error("Mock image dimensions are invalid");
  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  const key = `mock-images/${input.projectId}/${input.jobId}/${checksumSha256}.png`;
  await dependencies.objects.put({ key, bytes, mimeType: "image/png", checksumSha256 });
  return await dependencies.assets.completeAttemptWithAsset(dependencies.jobs, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    generationJobId: input.jobId,
    traceId: input.traceId,
    kind: "IMAGE",
    storageProvider: "mock-object-store",
    objectKey: key,
    mimeType: "image/png",
    byteSize: bytes.length,
    checksumSha256,
    width,
    height,
    sourceJobAttemptId: attemptId,
    sourceShotRevisionId: input.shotRevisionId,
    providerConfigurationId: input.providerConfigurationId,
    providerRequestId,
  });
}
