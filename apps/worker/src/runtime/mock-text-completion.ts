import { JobPersistenceService, MockTextService, PersistenceError, type ExecutionContext, type MockSceneSnapshot } from "@ai-drama/database";

export async function completeMockJob(
  jobs: JobPersistenceService, mockText: MockTextService | undefined,
  execution: ExecutionContext, attemptId: string, traceId: string, responseSnapshot: unknown,
): Promise<void> {
  if (execution.kind !== "MOCK_TEXT_SCENES") {
    await jobs.succeedJob({ workspaceId: execution.workspaceId, jobId: execution.jobId,
      attemptId, traceId, responseSnapshot });
    return;
  }
  if (!mockText) throw new Error("Mock text completion service unavailable");
  try {
    await jobs.succeedJobWithArtifact({
      workspaceId: execution.workspaceId, jobId: execution.jobId, attemptId, traceId,
      persistArtifact: (client) => mockText.persistScenes(
        client, execution.workspaceId, execution.inputSnapshot as MockSceneSnapshot, traceId,
      ),
      artifactResponse: (artifact) => ({ sceneRevisionIds: artifact.sceneRevisionIds }),
    });
  } catch (error) {
    if (!(error instanceof PersistenceError) ||
        !["REVISION_CONFLICT", "SCRIPT_REVIEW_REQUIRED", "EPISODE_SET_INVALID", "VALIDATION_ERROR", "MOCK_SCENE_SLOT_OCCUPIED"].includes(error.code)) {
      throw error;
    }
    await jobs.failJob({ workspaceId: execution.workspaceId, jobId: execution.jobId,
      attemptId, traceId, errorCode: error.code, errorMessage: error.message, retryable: false });
  }
}
