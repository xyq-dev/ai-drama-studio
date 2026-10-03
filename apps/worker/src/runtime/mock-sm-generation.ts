import { createHash } from "node:crypto";
import type { JobPersistenceService, MediaAssetRecord, MediaAssetStore, ProviderActualCostInput } from "@ai-drama/database";
import { assertSyncActualCost } from "@ai-drama/database";
import {
  MOCK_AUDIO_FIXTURE,
  MOCK_SUBTITLE_FIXTURE,
  type MediaAccountingEnvelope,
  type MediaProviderAdapter,
  type MediaProviderOutput,
} from "@ai-drama/providers";
import type { MockImageObjectStore } from "./mock-image-generation";
import { classifyMediaFailure, mediaErrorMessage } from "./mock-media-failure";

export type MockSmCapability = "subtitle.generate" | "audio.music";

export interface MockSmJob {
  workspaceId: string;
  projectId: string;
  shotRevisionId: string;
  jobId: string;
  dispatchSeq: number;
  providerConfigurationId: string;
  inputHash: string;
  inputSnapshot: unknown;
  traceId: string;
  capability: MockSmCapability;
}

const FIXTURES = {
  "subtitle.generate": MOCK_SUBTITLE_FIXTURE,
  "audio.music": MOCK_AUDIO_FIXTURE,
} as const;

/** Synchronous MEDIA_SUBTITLE / MEDIA_MUSIC path. Bytes stay the fixed fixture. */
export async function runMockSmJob(
  input: MockSmJob,
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
    leaseOwner: `mock-sm:${input.jobId}`,
    leaseMs: 60_000,
    traceId: input.traceId,
    providerConfigurationId: input.providerConfigurationId,
  });
  if (!acquired) return null;

  let providerAttached = false;
  try {
    await dependencies.assets.assertUsableShot(input.workspaceId, input.projectId, input.shotRevisionId);
    assertSyncSnapshot(input.inputSnapshot, input.capability);
    const request = {
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
      capability: input.capability,
    };
    const expectedProviderRequestId = `mock-media|sync|${input.capability}|${request.clientRequestKey}`;
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
    if (result.kind !== "succeeded" || !result.accounting) {
      throw new Error(`Synchronous Mock subtitle or music job expected success, received ${result.kind}`);
    }
    return await persistMockSmOutput(input, acquired.attemptId, result.providerRequestId,
      result.outputs[0], result.accounting, dependencies);
  } catch (error) {
    await settleSmFailure(input, acquired.attemptId, providerAttached, error, dependencies.jobs);
    return null;
  }
}

export async function recoverMockSmAttempt(
  input: Omit<MockSmJob, "dispatchSeq" | "inputHash"> & { attemptId: string; providerRequestId: string },
  dependencies: {
    jobs: JobPersistenceService;
    assets: MediaAssetStore;
    adapter: MediaProviderAdapter;
    objects: MockImageObjectStore;
  },
): Promise<MediaAssetRecord | null | "ACTIVE" | "FAILED" | "CANCELED" | "UNKNOWN"> {
  assertSyncSnapshot(input.inputSnapshot, input.capability);
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
  if (!observation.accounting) return "FAILED";
  return persistMockSmOutput(input, input.attemptId, input.providerRequestId,
    observation.outputs[0], observation.accounting, dependencies);
}

async function persistMockSmOutput(
  input: Pick<MockSmJob, "workspaceId" | "projectId" | "shotRevisionId" | "jobId" | "traceId" | "providerConfigurationId" | "capability">,
  attemptId: string,
  providerRequestId: string,
  output: MediaProviderOutput | undefined,
  accounting: MediaAccountingEnvelope,
  dependencies: {
    jobs: JobPersistenceService;
    assets: MediaAssetStore;
    adapter: MediaProviderAdapter;
    objects: MockImageObjectStore;
  },
): Promise<MediaAssetRecord | null> {
  const fixture = FIXTURES[input.capability];
  const expectedKind = input.capability === "subtitle.generate" ? "SUBTITLE" : "MUSIC";
  if (!output || output.kind !== expectedKind || output.mimeTypeHint !== fixture.mimeType) {
    throw new Error("Mock subtitle or music job requires the canonical fixture output");
  }
  const resolved = await dependencies.adapter.resolveOutput(output);
  const prefix = `data:${fixture.mimeType};base64,`;
  if (!resolved.uri.startsWith(prefix)) throw new Error("Mock subtitle or music output must be inline fixture data");
  const bytes = Buffer.from(resolved.uri.slice(prefix.length), "base64");
  if (!bytes.equals(fixture.bytes)) throw new Error("Mock subtitle or music output is not the canonical fixture");
  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  if (checksumSha256 !== fixture.checksumSha256 || bytes.length !== fixture.byteLength) {
    throw new Error("Mock subtitle or music output is not the canonical fixture");
  }
  const extension = expectedKind === "SUBTITLE" ? "vtt" : "wav";
  const folder = expectedKind === "SUBTITLE" ? "mock-subtitles" : "mock-music";
  const key = `${folder}/${input.projectId}/${input.jobId}/${checksumSha256}.${extension}`;
  await dependencies.objects.put({ key, bytes, mimeType: fixture.mimeType, checksumSha256 });
  const actualCost = costFromAccounting(input, attemptId, providerRequestId, accounting);
  return dependencies.assets.completeAttemptWithAsset(dependencies.jobs, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    generationJobId: input.jobId,
    traceId: input.traceId,
    kind: expectedKind,
    storageProvider: "mock-object-store",
    objectKey: key,
    mimeType: fixture.mimeType,
    byteSize: bytes.length,
    checksumSha256,
    durationMs: fixture.durationMs,
    sourceJobAttemptId: attemptId,
    sourceShotRevisionId: input.shotRevisionId,
    providerConfigurationId: input.providerConfigurationId,
    providerRequestId,
    actualCost,
  });
}

function costFromAccounting(
  input: Pick<MockSmJob, "workspaceId" | "projectId" | "jobId" | "providerConfigurationId">,
  attemptId: string,
  providerRequestId: string,
  accounting: MediaAccountingEnvelope,
): ProviderActualCostInput {
  const line = accounting.costs.length === 1 ? accounting.costs[0] : undefined;
  if (!line) throw new Error("Mock subtitle or music accounting must contain one cost line");
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
    unitType: line.unitType ?? "",
    unitQuantity: line.unitQuantity ?? "",
    unitPriceSnapshot: line.unitPriceSnapshot ?? "",
    provider: accounting.provider,
    model: accounting.model,
    supersedesEstimateKey: line.supersedesEstimateKey,
  };
  assertSyncActualCost(cost);
  return cost;
}

function assertSyncSnapshot(snapshot: unknown, capability: MockSmCapability): void {
  const record = snapshot as { outcome?: unknown; executionMode?: unknown; capability?: unknown } | null;
  if (!record || record.executionMode !== "sync" || record.capability !== capability) {
    throw new Error("Mock subtitle or music job is not a synchronous fixed execution");
  }
  if (record.outcome !== undefined && record.outcome !== "success") {
    throw new Error("Synchronous Mock subtitle or music path only supports success outcome");
  }
}

async function settleSmFailure(
  input: MockSmJob,
  attemptId: string,
  providerAttached: boolean,
  error: unknown,
  jobs: JobPersistenceService,
): Promise<void> {
  const disposition = classifyMediaFailure(error);
  if (disposition === "terminal-race") throw error;
  const retryable = disposition === "retryable";
  if (providerAttached && retryable) throw error;
  await jobs.failJob({
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    attemptId,
    traceId: input.traceId,
    errorCode: retryable ? "MOCK_SM_RUNTIME_FAILED" : "MOCK_SM_OUTPUT_INVALID",
    errorMessage: mediaErrorMessage(error),
    retryable,
    nextRunAt: retryable ? new Date(Date.now() + 30_000) : undefined,
  });
}
