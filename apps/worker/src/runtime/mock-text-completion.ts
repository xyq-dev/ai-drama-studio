import { JobPersistenceService, MockTextService, PersistenceError, isMockMediaJobKind,
  type ExecutionContext, type MockSceneSnapshot, type MockShotSnapshot } from "@ai-drama/database";
import { MockTextAdapter, type TextGenerationAdapter } from "@ai-drama/providers";
import { textAdapterResultSchema, textProviderErrorSchema,
  type SceneBatchOutput, type ShotBatchOutput, type TextProviderError } from "@ai-drama/contracts";
import { retryAt } from "./retry";

export async function completeMockJob(
  jobs: JobPersistenceService, mockText: MockTextService | undefined,
  execution: ExecutionContext, attemptId: string, traceId: string, responseSnapshot: unknown,
  textAdapter: TextGenerationAdapter = new MockTextAdapter(),
): Promise<"completed" | "pending"> {
  if (isMockMediaJobKind(execution.kind)) {
    await jobs.failJob({ workspaceId: execution.workspaceId, jobId: execution.jobId, attemptId, traceId,
      errorCode: "MOCK_MEDIA_ROUTE_INVALID",
      errorMessage: "Media jobs cannot complete through the text consumer", retryable: false });
    return "completed";
  }
  if (execution.kind !== "MOCK_TEXT_SCENES" && execution.kind !== "MOCK_TEXT_SHOTS") {
    await jobs.succeedJob({ workspaceId: execution.workspaceId, jobId: execution.jobId,
      attemptId, traceId, responseSnapshot });
    return "completed";
  }
  if (!mockText) throw new Error("Mock text completion service unavailable");
  try {
    const snapshot = execution.inputSnapshot as MockSceneSnapshot | MockShotSnapshot;
    const request = await mockText.buildGenerationRequest(execution.workspaceId, snapshot);
    if (textAdapter.replayPolicy !== "REPLAY_SAFE_SYNC") {
      throw new PersistenceError("VALIDATION_ERROR", "Text Adapter is not replay-safe");
    }
    const requestId = execution.providerRequestId ??
      `mock|success|${execution.jobId}:${String(execution.attemptNo ?? 1)}`;
    let rawResult: unknown;
    try {
      rawResult = await textAdapter.generate(request, {
        requestId, idempotencyKey: execution.inputHash, providerKey: textAdapter.providerKey,
      });
    } catch (error) {
      const normalized = textProviderErrorSchema.safeParse(error);
      if (!normalized.success) return "pending";
      rawResult = { kind: normalized.data.code === "UNKNOWN" ? "unknown" : "failed",
        error: normalized.data };
    }
    const parsedResult = textAdapterResultSchema.safeParse(rawResult);
    if (!parsedResult.success) {
      if (rawResult && typeof rawResult === "object" && "kind" in rawResult &&
          (rawResult as { kind?: unknown }).kind === "succeeded") {
        throw new PersistenceError("VALIDATION_ERROR", "Invalid Text Adapter success output");
      }
      return "pending";
    }
    if (parsedResult.data.kind === "unknown" ||
        (parsedResult.data.kind === "failed" && parsedResult.data.error.code === "UNKNOWN")) {
      return "pending";
    }
    if (parsedResult.data.kind === "failed") {
      if (parsedResult.data.error.code === "CANCELED") {
        await jobs.confirmCancellation({ workspaceId: execution.workspaceId,
          jobId: execution.jobId, attemptId, traceId });
        return "completed";
      }
      await failFromAdapter(jobs, execution, attemptId, traceId, parsedResult.data.error);
      return "completed";
    }
    const output = parsedResult.data.output;
    await jobs.succeedJobWithArtifact<{
      id: string; shotRevisionIds?: string[]; sceneRevisionIds?: string[];
    }>({
      workspaceId: execution.workspaceId, jobId: execution.jobId, attemptId, traceId,
      persistArtifact: (client) => execution.kind === "MOCK_TEXT_SHOTS"
        ? mockText.persistShots(client, execution.workspaceId,
          execution.inputSnapshot as MockShotSnapshot, output as ShotBatchOutput, traceId)
        : mockText.persistScenes(client, execution.workspaceId,
          execution.inputSnapshot as MockSceneSnapshot, output as SceneBatchOutput, traceId),
      artifactResponse: (artifact) => artifact.shotRevisionIds
        ? { shotRevisionIds: artifact.shotRevisionIds }
        : { sceneRevisionIds: artifact.sceneRevisionIds },
    });
    return "completed";
  } catch (error) {
    if (!(error instanceof PersistenceError) ||
        !["REVISION_CONFLICT", "SCRIPT_REVIEW_REQUIRED", "EPISODE_SET_INVALID", "VALIDATION_ERROR",
          "MOCK_SCENE_SLOT_OCCUPIED", "MOCK_SHOT_SLOT_OCCUPIED", "REVIEW_REQUIRED", "SOURCE_STALE"].includes(error.code)) {
      throw error;
    }
    await jobs.failJob({ workspaceId: execution.workspaceId, jobId: execution.jobId,
      attemptId, traceId, errorCode: error.code, errorMessage: error.message, retryable: false });
    return "completed";
  }
}

async function failFromAdapter(jobs: JobPersistenceService, execution: ExecutionContext,
  attemptId: string, traceId: string, error: TextProviderError): Promise<void> {
  await jobs.failJob({ workspaceId: execution.workspaceId, jobId: execution.jobId,
    attemptId, traceId, errorCode: `TEXT_PROVIDER_${error.code}`, errorMessage: error.message,
    retryable: error.retryable,
    nextRunAt: error.retryable
      ? retryAt(execution.jobId, execution.attemptNo ?? 1, error.retryAfterMs) : undefined });
}
