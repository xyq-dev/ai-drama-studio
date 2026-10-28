import { createHash } from "node:crypto";
import {
  assertSyncActualCost,
  type CharacterReferenceAsset,
  type CharacterReferenceStore,
  type JobPersistenceService,
  type ProviderActualCostInput,
  type RuntimeStore,
} from "@ai-drama/database";
import { DomainError, parseCharacterReferenceSnapshot } from "@ai-drama/domain";
import type { MediaAccountingEnvelope, MediaProviderAdapter, MediaProviderOutput } from "@ai-drama/providers";
import type { MockImageObjectStore } from "./mock-image-generation";
import { classifyMediaFailure, mediaErrorCode, mediaErrorMessage } from "./mock-media-failure";

/** Gate and storage refusals are permanent: a fresh attempt on the same frozen input cannot change them. */
const PERMANENT_REFERENCE_CODES = new Set([
  "SOURCE_STALE", "SCRIPT_REVIEW_REQUIRED", "REVIEW_REQUIRED", "CHARACTER_REFERENCE_STORAGE_UNAVAILABLE",
  "ASSET_LINEAGE_INVALID", "ASSET_CONFLICT", "NOT_FOUND",
]);

function disposition(error: unknown): "permanent" | "retryable" | "terminal-race" {
  if (error instanceof DomainError || PERMANENT_REFERENCE_CODES.has(mediaErrorCode(error))) return "permanent";
  return classifyMediaFailure(error);
}

export interface MockCharacterReferenceJob {
  workspaceId: string;
  projectId: string;
  jobId: string;
  dispatchSeq: number;
  providerConfigurationId: string;
  inputHash: string;
  inputSnapshot: unknown;
  traceId: string;
}

interface Dependencies {
  jobs: JobPersistenceService;
  references: CharacterReferenceStore;
  adapter: MediaProviderAdapter;
  objects: MockImageObjectStore;
}

function costFromAccounting(
  input: Pick<MockCharacterReferenceJob, "workspaceId" | "projectId" | "jobId" | "providerConfigurationId">,
  attemptId: string,
  providerRequestId: string,
  accounting: MediaAccountingEnvelope | undefined,
): ProviderActualCostInput {
  const line = accounting?.costs.length === 1 ? accounting.costs[0] : undefined;
  if (!accounting || !line) throw new Error("Mock reference accounting must contain one cost line");
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

async function persist(
  input: Pick<MockCharacterReferenceJob, "workspaceId" | "projectId" | "jobId" | "providerConfigurationId" | "traceId">,
  characterRevisionId: string,
  attemptId: string,
  providerRequestId: string,
  output: MediaProviderOutput,
  actualCost: ProviderActualCostInput,
  dependencies: Dependencies,
): Promise<CharacterReferenceAsset | null> {
  if (output.kind !== "IMAGE") throw new Error("Mock reference job requires exactly one image output");
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
  // Same key shape as shot images, so the existing content route can read it back by job and checksum.
  const objectKey = `mock-images/${input.projectId}/${input.jobId}/${checksumSha256}.png`;
  await dependencies.objects.put({ key: objectKey, bytes, mimeType: "image/png", checksumSha256 });
  return dependencies.references.completeGeneration(dependencies.jobs, {
    workspaceId: input.workspaceId, projectId: input.projectId, jobId: input.jobId, attemptId,
    characterRevisionId, providerConfigurationId: input.providerConfigurationId, providerRequestId, objectKey,
    byteSize: bytes.length, checksumSha256, width, height, traceId: input.traceId, actualCost,
  });
}

/** Synchronous Mock reference image. The pixels are the fixed 1x1 PNG fixture, not a model result. */
export async function runMockCharacterReferenceJob(
  input: MockCharacterReferenceJob,
  dependencies: Dependencies,
): Promise<CharacterReferenceAsset | null> {
  const acquired = await dependencies.jobs.acquireQueuedJob({
    workspaceId: input.workspaceId, jobId: input.jobId, dispatchSeq: input.dispatchSeq,
    leaseOwner: `mock-reference:${input.jobId}`, leaseMs: 60_000, traceId: input.traceId,
    providerConfigurationId: input.providerConfigurationId,
  });
  if (!acquired) return null;
  let providerAttached = false;
  try {
    const snapshot = parseCharacterReferenceSnapshot(input.inputSnapshot);
    const clientRequestKey = `${input.jobId}:${acquired.attemptNo}`;
    const expectedProviderRequestId = `mock-media|sync|image.generate|${clientRequestKey}`;
    await dependencies.jobs.attachProviderRequest({
      workspaceId: input.workspaceId, attemptId: acquired.attemptId,
      providerConfigurationId: input.providerConfigurationId, providerRequestId: expectedProviderRequestId,
    });
    providerAttached = true;
    const result = await dependencies.adapter.submit({
      workspaceId: input.workspaceId, projectId: input.projectId, generationJobId: input.jobId,
      jobAttemptId: acquired.attemptId, providerConfigurationId: input.providerConfigurationId, clientRequestKey,
      inputHash: input.inputHash, inputSnapshot: input.inputSnapshot, traceId: input.traceId, capability: "image.generate",
    });
    if (result.providerRequestId !== expectedProviderRequestId) throw new Error("Mock provider request identity changed");
    if (result.kind !== "succeeded") throw new Error(`Synchronous Mock reference job expected success, received ${result.kind}`);
    if (result.outputs.length !== 1) throw new Error("Mock reference job requires exactly one image output");
    const cost = costFromAccounting(input, acquired.attemptId, result.providerRequestId, result.accounting);
    return await persist(input, snapshot.characterRevisionId, acquired.attemptId, result.providerRequestId,
      result.outputs[0]!, cost, dependencies);
  } catch (error) {
    const kind = disposition(error);
    if (kind === "terminal-race") throw error;
    if (providerAttached && kind === "retryable") throw error;
    await dependencies.jobs.failJob({
      workspaceId: input.workspaceId, jobId: input.jobId, attemptId: acquired.attemptId, traceId: input.traceId,
      errorCode: kind === "retryable" ? "MOCK_REFERENCE_RUNTIME_FAILED" : "MOCK_REFERENCE_REJECTED",
      errorMessage: mediaErrorMessage(error), retryable: kind === "retryable",
      nextRunAt: kind === "retryable" ? new Date(Date.now() + 30_000) : undefined,
    });
    return null;
  }
}

/**
 * Lease recovery for reference jobs. An unsent attempt is requeued; an attached request is re-inspected and its
 * deterministic output persisted, never resubmitted.
 */
export class CharacterReferenceRecovery {
  constructor(
    private readonly jobs: JobPersistenceService,
    private readonly store: RuntimeStore,
    private readonly dependencies: Omit<Dependencies, "objects" | "jobs"> & { objects: MockImageObjectStore | null },
    private readonly enabled: boolean,
  ) {}

  /**
   * Each row is isolated: a transient fault on one row (database, filesystem) leaves that attempt for the next pass
   * and is reported; a permanent refusal ends only that attempt. Faults are collected and thrown together after every
   * row was tried, never swallowed.
   */
  async reconcileOnce(now = new Date()): Promise<void> {
    const errors: unknown[] = [];
    const rows = await this.store.listExpiredMockMedia(50, now, ["MEDIA_CHARACTER_REFERENCE"]);
    for (const row of rows) {
      const traceId = `mock-reference:recover:${row.jobId}`;
      try {
        const execution = await this.store.loadCharacterReferenceExecution(row.workspaceId, row.jobId);
        if (!execution || execution.state !== "RUNNING") continue;
        if (row.cancelRequested) {
          await this.jobs.confirmCancellation({ workspaceId: row.workspaceId, jobId: row.jobId, attemptId: row.attemptId, traceId });
          continue;
        }
        if (!row.providerRequestId) {
          await this.jobs.recoverExpiredLease({ workspaceId: row.workspaceId, jobId: row.jobId, traceId });
          continue;
        }
        const objects = this.dependencies.objects;
        if (!this.enabled || !objects || !row.providerConfigurationId) {
          await this.jobs.failJob({ workspaceId: row.workspaceId, jobId: row.jobId, attemptId: row.attemptId, traceId,
            errorCode: "MOCK_MEDIA_NOT_CONFIGURED", errorMessage: "Mock reference recovery requires storage and configuration",
            retryable: false });
          continue;
        }
        // The request is already bound: inspect it and persist its deterministic output; never submit again.
        const observation = await this.dependencies.adapter.inspect(row.providerRequestId);
        await this.jobs.recordProviderEvent({ workspaceId: row.workspaceId, providerConfigurationId: row.providerConfigurationId,
          jobAttemptId: row.attemptId, providerRequestId: row.providerRequestId, source: "POLL",
          normalizedEventKey: observation.normalizedEventKey, externalStatus: observation.state });
        if (observation.state === "ACTIVE") continue;
        if (observation.state !== "SUCCEEDED" || observation.outputs?.length !== 1) {
          await this.jobs.failJob({ workspaceId: row.workspaceId, jobId: row.jobId, attemptId: row.attemptId, traceId,
            errorCode: observation.state === "UNKNOWN" ? "MOCK_REQUEST_UNKNOWN" : "MOCK_PROVIDER_FAILED",
            errorMessage: `Mock provider inspection returned ${observation.state}`, retryable: false });
          continue;
        }
        const snapshot = parseCharacterReferenceSnapshot(execution.inputSnapshot);
        const job = { workspaceId: row.workspaceId, projectId: execution.projectId, jobId: row.jobId,
          providerConfigurationId: row.providerConfigurationId, traceId };
        const cost = costFromAccounting(job, row.attemptId, row.providerRequestId, observation.accounting);
        await persist(job, snapshot.characterRevisionId, row.attemptId, row.providerRequestId, observation.outputs[0]!, cost,
          { ...this.dependencies, objects, jobs: this.jobs });
      } catch (error) {
        const kind = disposition(error);
        // A newer attempt or a terminal state already owns the job; nothing of ours to settle.
        if (kind === "terminal-race") continue;
        if (kind === "permanent") {
          try {
            await this.jobs.failJob({ workspaceId: row.workspaceId, jobId: row.jobId, attemptId: row.attemptId, traceId,
              errorCode: "MOCK_REFERENCE_REJECTED", errorMessage: mediaErrorMessage(error), retryable: false });
          } catch (failure) {
            if (classifyMediaFailure(failure) !== "terminal-race") errors.push(failure);
          }
          continue;
        }
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Mock reference recovery encountered errors");
  }
}
