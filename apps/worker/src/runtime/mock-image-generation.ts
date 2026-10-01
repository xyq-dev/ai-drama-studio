import { createHash } from "node:crypto";
import {
  assertFixedMockImageSnapshot,
  assertSyncActualCost,
  type JobPersistenceService,
  type MediaAssetStore,
  type MediaAssetRecord,
  type ProviderActualCostInput,
} from "@ai-drama/database";
import type {
  MediaAccountingEnvelope,
  MediaProviderAdapter,
  MediaGenerationRequest,
  MediaProviderOutput,
} from "@ai-drama/providers";
import { classifyMediaFailure } from "./mock-media-failure";

export interface MockImageObjectStore {
  put(input: {
    key: string;
    bytes: Buffer;
    mimeType: "image/png" | "video/mp4" | "audio/wav" | "text/vtt";
    checksumSha256: string;
  }): Promise<void>;
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

/** Synchronous MEDIA_IMAGE path used by the queue consumer.
 * The pixels are a fixed 1×1 PNG fixture. seed is stored in the snapshot and does not change the image.
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
  assertFixedMockImageSnapshot(input.inputSnapshot, input.shotRevisionId);

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
  const actualCost = imageCostFromReceipt(
    input, acquired.attemptId, result.providerRequestId, result.accounting, "submit",
  );
  return await persistMockImageOutput(input, acquired.attemptId, result.providerRequestId,
    result.outputs[0], actualCost, dependencies);
  } catch (error) {
    const disposition = classifyMediaFailure(error);
    if (disposition === "terminal-race") throw error;
    const retryable = disposition === "retryable";
    if (providerAttached && retryable) {
      // Preserve the attempt and request; lease recovery inspects it before any resubmit.
      throw error;
    }
    await dependencies.jobs.failJob({
      workspaceId: input.workspaceId, jobId: input.jobId, attemptId: acquired.attemptId,
      traceId: input.traceId,
      errorCode: retryable ? "MOCK_IMAGE_RUNTIME_FAILED" : "MOCK_IMAGE_OUTPUT_INVALID",
      errorMessage: error instanceof Error ? error.message : String(error), retryable,
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
  input: Omit<MockImageJob, "dispatchSeq" | "inputHash"> & {
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
  assertFixedMockImageSnapshot(input.inputSnapshot, input.shotRevisionId);
  const actualCost = imageCostFromReceipt(
    input, input.attemptId, input.providerRequestId, observation.accounting, "recover",
  );
  return persistMockImageOutput(input, input.attemptId, input.providerRequestId,
    observation.outputs[0], actualCost, dependencies);
}

function imageCostFromReceipt(
  input: Pick<MockImageJob, "workspaceId" | "projectId" | "jobId" | "providerConfigurationId">,
  attemptId: string,
  providerRequestId: string,
  accounting: MediaAccountingEnvelope | undefined,
  mode: "submit" | "recover",
): ProviderActualCostInput {
  const line = accounting?.costs.length === 1 ? accounting.costs[0] : undefined;
  if (!accounting || !line) throw new Error("Mock image accounting must contain one cost line");
  if (accounting.provider !== "mock-media" || accounting.model !== "mock-v1" || accounting.usage?.requests !== 1) {
    throw new Error("Mock image accounting provider, model, or request usage is wrong");
  }
  if (line.component !== "request" || line.kind !== "ACTUAL") {
    throw new Error("Mock image accounting cost line is not an actual request");
  }
  if (line.idempotencyKey !== `${providerRequestId}:request:actual`) {
    throw new Error("Mock image accounting idempotency key is wrong");
  }
  const expectedEstimate = `${providerRequestId}:request:estimated`;
  if (mode === "submit" ? line.supersedesEstimateKey !== undefined : line.supersedesEstimateKey !== expectedEstimate) {
    throw new Error("Mock image accounting estimate reference is wrong");
  }
  if (typeof line.currency !== "string" || typeof line.amountDecimal !== "string" || typeof line.basis !== "string"
    || typeof line.unitType !== "string" || typeof line.unitQuantity !== "string" || typeof line.unitPriceSnapshot !== "string") {
    throw new Error("Mock image accounting amounts are missing");
  }
  const cost: ProviderActualCostInput = {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    generationJobId: input.jobId,
    jobAttemptId: attemptId,
    providerConfigurationId: input.providerConfigurationId,
    providerRequestId,
    idempotencyKey: line.idempotencyKey,
    currency: line.currency,
    amountDecimal: line.amountDecimal,
    kind: line.kind,
    basis: line.basis,
    unitType: line.unitType,
    unitQuantity: line.unitQuantity,
    unitPriceSnapshot: line.unitPriceSnapshot,
    provider: accounting.provider,
    model: accounting.model,
  };
  assertSyncActualCost(cost);
  return cost;
}

async function persistMockImageOutput(
  input: Pick<MockImageJob, "workspaceId" | "projectId" | "shotRevisionId" | "jobId" | "traceId" | "providerConfigurationId">,
  attemptId: string,
  providerRequestId: string,
  output: MediaProviderOutput,
  actualCost: ProviderActualCostInput,
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
    actualCost,
  });
}
